import { NEWS_CACHE_ANALYSIS_VERSION, type AiStatus, type Company, type NewsAnalysis, type NewsArticle } from '../packages/core/src/index.js';
import { mergeArticles } from './aggregate.js';
import { carryAiState, type AiClassifier } from './llm.js';
import { ProviderError, type NewsProvider } from './provider.js';
import { createSnapshot, SNAPSHOT_POOL_LIMIT, type CompanySnapshot, type SnapshotStore } from './snapshot-store.js';
import { synthesizeFactors } from './synthesis.js';

/** One version string for server results and client caches. */
export const ANALYSIS_VERSION = NEWS_CACHE_ANALYSIS_VERSION;

/** Next calendar Monday–Friday in Seoul; exchange holidays need a market calendar. */
export function nextAnalysisWeek(now: Date): { start: string; end: string } {
  const seoul = new Date(now.getTime() + 9 * 3600000);
  const day = seoul.getUTCDay();
  const daysUntilMonday = day === 0 ? 1 : 8 - day;
  const monday = new Date(Date.UTC(seoul.getUTCFullYear(), seoul.getUTCMonth(), seoul.getUTCDate() + daysUntilMonday));
  const friday = new Date(monday.getTime() + 4 * 86400000);
  return { start: monday.toISOString().slice(0, 10), end: friday.toISOString().slice(0, 10) };
}

const RISKS = [
  '뉴스는 미래 주가 방향을 증명하지 않으며 이미 가격에 반영되었을 수 있습니다.',
  '공시·실적·금리·환율과 예상하지 못한 사건으로 뉴스 분위기와 주가가 다르게 움직일 수 있습니다.',
  '기사 분류는 제공자가 작성한 참고 정보이며 독립적인 사실 확인이나 예측 정확도 검증을 거치지 않았습니다.',
  '분석 기간은 서울 기준 다음 월~금입니다. 거래소별 휴장일과 시차는 별도 시장 달력이 필요합니다.',
];

/** Results missing a failed source are refreshed sooner than complete ones. */
export const PARTIAL_RESULT_TTL_MS = 30 * 60_000;
/** A successful result older than this is no longer offered when every source fails. */
export const STALE_RESULT_LIMIT_MS = 7 * 86_400_000;
/** An unchanged snapshot is rewritten at most this often; Blob writes are a monthly allotment. */
export const SNAPSHOT_REWRITE_MS = 6 * 3_600_000;
/** Clients give up after 20 seconds, so an on-demand refresh, models included, ends sooner. */
export const ON_DEMAND_BUDGET_MS = 18_000;
/** Scheduled collection may wait longer for the models; nobody is waiting on the response. */
export const SCHEDULED_BUDGET_MS = 60_000;
const AI_RISK = 'AI 요약·분류는 기사 제목과 매체 설명만 보고 생성했으며 틀릴 수 있습니다. 본문과 사실 여부는 확인하지 않았습니다.';

function snapshotDigest(analysis: NewsAnalysis, pool: NewsArticle[]): string {
  return JSON.stringify([analysis.status, analysis.sources?.map(source => [source.id, source.status]) ?? [],
    pool.map(article => [article.id, article.sentiment, article.classificationMethod ?? null,
      article.aiJudgements?.map(item => item.provider) ?? [], !!article.summary])]);
}

function isFresh(analysis: NewsAnalysis, now: number): boolean {
  return (analysis.status === 'ready' || analysis.status === 'insufficient') && analysis.servedFrom !== 'stale' &&
    !!analysis.cachedUntil && Date.parse(analysis.cachedUntil) > now && Date.parse(analysis.asOf) <= now + 60_000;
}

export interface NewsServiceOptions {
  /** Persistent snapshots: pre-collected results, a weekly article pool and a stale fallback. */
  store?: SnapshotStore | null;
  /** Two-model judgements for articles without a provider score, and Korean summaries. */
  classifier?: AiClassifier | null;
}

export function createNewsService(provider: NewsProvider, clock: () => Date = () => new Date(), options: NewsServiceOptions = {}) {
  const store = options.store ?? null;
  const classifier = options.classifier ?? null;
  const cache = new Map<string, { expiresAt: number; value: NewsAnalysis }>();
  const lastGood = new Map<string, NewsAnalysis>();
  const pending = new Map<string, Promise<NewsAnalysis>>();
  const configuredTtl = provider.cacheTtlMs;
  const cacheTtlMs = typeof configuredTtl === 'number' && Number.isFinite(configuredTtl) && configuredTtl > 0
    ? configuredTtl : 60000;

  async function readSnapshot(companyId: string): Promise<CompanySnapshot | null> {
    if (!store) return null;
    try {
      return await store.read(companyId);
    } catch {
      console.warn('News snapshot read failed');
      return null;
    }
  }

  /** Model judgements are an addition: any failure leaves the articles exactly as the sources sent them. */
  async function judge(company: Company, articles: NewsArticle[], deadline: number, eligible: (article: NewsArticle) => boolean):
    Promise<{ articles: NewsArticle[]; hidden: NewsArticle[]; status?: AiStatus }> {
    if (!classifier) return { articles, hidden: [] };
    try {
      return await classifier.apply(company, articles, { budgetMs: deadline - clock().getTime(), eligible });
    } catch {
      console.warn('News AI classification failed');
      return { articles, hidden: [] };
    }
  }

  async function analyze(company: Company, snapshot: CompanySnapshot | null, deadline: number): Promise<{ analysis: NewsAnalysis; pool: NewsArticle[] }> {
    const now = clock();
    const base: NewsAnalysis = {
      company, status: 'insufficient', articles: [], asOf: now.toISOString(), period: nextAnalysisWeek(now),
      evidence: 'none', summary: '근거 부족으로 다음 주 방향 판단을 유보합니다.',
      positiveFactors: [], negativeFactors: [], risks: [...RISKS], provider: provider.name?.trim() || null, analysisVersion: ANALYSIS_VERSION,
      newsWindow: { start: new Date(now.getTime() - 7 * 86400000).toISOString(), end: now.toISOString() },
    };
    try {
      const result = await provider.getArticles(company, now);
      const inWindow = (article: NewsArticle) => {
        const publishedAt = Date.parse(article.publishedAt);
        return publishedAt >= now.getTime() - 7 * 86400000 && publishedAt <= now.getTime();
      };
      // Earlier model answers follow the same article, so nothing is judged twice.
      const earlier = new Map([...(lastGood.get(company.id)?.articles ?? []), ...(snapshot?.pool ?? [])].map(article => [article.id, article]));
      const current = result.articles.map(article => carryAiState(article, earlier.get(article.id)));
      // Articles from earlier refreshes stay for the rest of their week; current copies win.
      const merged = snapshot ? mergeArticles([current, snapshot.pool.filter(inWindow)], SNAPSHOT_POOL_LIMIT) : current;
      const judged = await judge(company, merged, deadline, inWindow);
      const articles = judged.articles;
      const fresh = articles.filter(inWindow);
      const classified = fresh.filter(article => article.sentiment !== 'unclassified');
      const unclassifiedCount = fresh.length - classified.length;
      const positive = classified.filter(article => article.sentiment === 'positive');
      const negative = classified.filter(article => article.sentiment === 'negative');
      const conflicting = positive.length > 0 && negative.length > 0;
      const sufficient = classified.length >= 3 && !conflicting && (positive.length > 0 || negative.length > 0);
      let summary = base.summary;
      if (articles.length === 0) summary = '관련 기사가 없어 다음 주 방향 판단을 유보합니다.';
      else if (fresh.length === 0) summary = '최근 7일 이내 기사가 없어 다음 주 방향 판단을 유보합니다.';
      else if (conflicting) summary = '긍정·부정 근거가 상충하여 다음 주 방향 판단을 유보합니다.';
      else if (classified.length < 3 && unclassifiedCount > 0) summary = `최근 기사 ${fresh.length}건 중 ${unclassifiedCount}건은 분류 미확인입니다. 분류된 기사 ${classified.length}건만으로 다음 주 방향을 판단하기에 근거가 부족합니다.`;
      else if (fresh.length < 3) summary = '최근 기사가 3건 미만으로, 다음 주 방향을 판단하기에 근거가 부족합니다.';
      else if (positive.length === 0 && negative.length === 0) summary = '분류를 확인한 최근 기사가 모두 중립으로 분류되어 다음 주 방향 판단을 유보합니다.';
      else if (sufficient) summary = `${positive.length > 0 ? '긍정' : '부정'}적으로 분류된 뉴스 요인이 있습니다. 다음 주 주가 방향은 불확실하며, 이 요약은 상승·하락 예측이 아닙니다.`;
      const factors = synthesizeFactors(fresh, now, { ai: !!judged.status });
      const aiOutput = articles.some(article => article.summary || article.aiJudgements);
      // Hidden articles stay in the pool with their judgements so they are not judged again.
      const pool = [...fresh, ...judged.hidden.filter(inWindow)]
        .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, SNAPSHOT_POOL_LIMIT);
      return { pool, analysis: {
        ...base, provider: result.provider, articles, status: sufficient ? 'ready' : 'insufficient',
        evidence: sufficient ? 'moderate' : fresh.length > 0 ? 'low' : 'none', summary,
        positiveFactors: factors.positiveFactors, negativeFactors: factors.negativeFactors,
        factorSummary: factors.factorSummary,
        ...(result.sources ? { sources: result.sources } : {}),
        ...(judged.status ? { ai: judged.status } : {}),
        risks: [...new Set([
          ...base.risks, ...(aiOutput ? [AI_RISK] : []), ...(result.notes ?? []),
          ...(unclassifiedCount > 0 ? [`분류 미확인 기사 ${unclassifiedCount}건은 긍정·부정·중립 집계에 포함하지 않았습니다.`] : []),
        ])],
      } };
    } catch (error) {
      const code = error instanceof ProviderError ? error.code : 'error';
      const reason = error instanceof ProviderError ? error.reason : undefined;
      const requestedBackoff = error instanceof ProviderError ? error.retryAfterMs : undefined;
      const backoffMs = typeof requestedBackoff === 'number' && Number.isFinite(requestedBackoff) && requestedBackoff > 0
        ? requestedBackoff : 60000;
      return { pool: [], analysis: {
        ...base, status: code,
        ...(error instanceof ProviderError && error.sources ? { sources: error.sources } : {}),
        ...(code === 'rate_limited' ? { retryAt: new Date(clock().getTime() + backoffMs).toISOString() } : {}),
        message: code === 'not_configured'
          ? provider.setupMessage || '뉴스 제공자 연결을 기다리고 있습니다. 서버의 뉴스 제공자 환경변수를 설정해 주세요.'
          : code === 'rate_limited'
            ? '뉴스 제공자의 호출 한도에 도달했습니다. 표시된 재시도 시각 이후에 다시 확인해 주세요.'
            : reason === 'invalid_key'
              ? '뉴스 API 키가 유효하지 않거나 만료되었습니다. 서버의 API 키를 확인해 주세요.'
              : reason === 'access_denied'
                ? '현재 뉴스 API 키 또는 계정에서 이 요청을 사용할 수 없습니다. 제공자 계정의 접근 권한과 플랜을 확인해 주세요.'
                : reason === 'identity_unverified'
                  ? '선택한 회사의 종목·거래소를 뉴스 제공자에서 정확히 확인하지 못했습니다. 다른 회사를 선택하거나 제공자의 기업 식별 정보를 확인해 주세요.'
                  : '뉴스를 불러오지 못했습니다. 제공자 설정과 응답 형식을 확인한 뒤 다시 시도해 주세요.',
      } };
    }
  }

  function remember(company: Company, value: NewsAnalysis) {
    if (!lastGood.has(company.id) && lastGood.size >= 100) lastGood.delete(lastGood.keys().next().value!);
    lastGood.set(company.id, value);
  }

  /** Runs a provider refresh, caches it, saves the snapshot and falls back to the last good result. */
  async function complete(company: Company, snapshot: CompanySnapshot | null, forceWrite: boolean, deadline: number): Promise<NewsAnalysis> {
    const { analysis: value, pool } = await analyze(company, snapshot, deadline);
    if (cache.size >= 100 && !cache.has(company.id)) cache.delete(cache.keys().next().value!);
    const completedAt = clock().getTime();
    const succeeded = value.status === 'ready' || value.status === 'insufficient';
    const partial = succeeded && value.sources?.some(source => source.status === 'rate_limited' || source.status === 'error');
    const lifetime = succeeded ? partial ? Math.min(cacheTtlMs, PARTIAL_RESULT_TTL_MS) : cacheTtlMs
      : value.status === 'rate_limited' ? 60000 : 5000;
    const expiresAt = Math.max(completedAt + lifetime,
      value.status === 'rate_limited' && value.retryAt ? Date.parse(value.retryAt) : 0);
    let cached: NewsAnalysis = {
      ...value, cachedUntil: new Date(expiresAt).toISOString(),
      ...(value.status === 'rate_limited' ? { retryAt: new Date(expiresAt).toISOString() } : {}),
    };
    if (succeeded) {
      remember(company, cached);
      const changed = !snapshot || snapshotDigest(cached, pool) !== snapshotDigest(snapshot.analysis, snapshot.pool) ||
        completedAt - Date.parse(snapshot.updatedAt) >= SNAPSHOT_REWRITE_MS;
      if (store && (forceWrite || changed)) {
        try { await store.write(createSnapshot(cached, pool, new Date(completedAt))); } catch { console.warn('News snapshot write failed'); }
      }
    } else if (value.status === 'error' || value.status === 'rate_limited') {
      // Every source failed: show the newest successful result, labelled, and retry on the failure's schedule.
      const candidates = [lastGood.get(company.id), snapshot?.analysis].filter((item): item is NewsAnalysis => !!item);
      const previous = candidates.sort((a, b) => Date.parse(b.asOf) - Date.parse(a.asOf))[0];
      if (previous && completedAt - Date.parse(previous.asOf) <= STALE_RESULT_LIMIT_MS) {
        cached = {
          ...previous, servedFrom: 'stale', refreshAttemptedAt: value.asOf, cachedUntil: cached.cachedUntil,
          ...(cached.retryAt ? { retryAt: cached.retryAt } : {}),
          ...(value.sources ? { sources: value.sources } : {}),
          ...(value.message ? { message: value.message } : {}),
        };
      }
    }
    cache.set(company.id, { expiresAt, value: cached });
    return cached;
  }

  return {
    async getAnalysis(company: Company): Promise<NewsAnalysis> {
      const now = clock().getTime();
      const existing = cache.get(company.id);
      if (existing && existing.expiresAt > now) return existing.value;
      const inflight = pending.get(company.id);
      if (inflight) return inflight;
      const request = (async () => {
        const deadline = now + ON_DEMAND_BUDGET_MS;
        const snapshot = await readSnapshot(company.id);
        if (snapshot && isFresh(snapshot.analysis, clock().getTime())) {
          // A collected result is still fresh: serve it without calling any provider.
          cache.set(company.id, { expiresAt: Date.parse(snapshot.analysis.cachedUntil!), value: snapshot.analysis });
          remember(company, snapshot.analysis);
          return snapshot.analysis;
        }
        return complete(company, snapshot, false, deadline);
      })().finally(() => pending.delete(company.id));
      pending.set(company.id, request);
      return request;
    },
    /** Scheduled collection: always queries providers and always saves a successful snapshot. */
    async refresh(company: Company): Promise<NewsAnalysis> {
      const deadline = clock().getTime() + SCHEDULED_BUDGET_MS;
      return complete(company, await readSnapshot(company.id), true, deadline);
    },
  };
}
