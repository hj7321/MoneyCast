import type { Company, NewsAnalysis } from '../packages/core/src/index.js';
import { ProviderError, type NewsProvider } from './provider.js';

export const ANALYSIS_VERSION = 'news-evidence-v2';

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

export function createNewsService(provider: NewsProvider, clock: () => Date = () => new Date()) {
  const cache = new Map<string, { expiresAt: number; value: NewsAnalysis }>();
  const pending = new Map<string, Promise<NewsAnalysis>>();
  const configuredTtl = provider.cacheTtlMs;
  const cacheTtlMs = typeof configuredTtl === 'number' && Number.isFinite(configuredTtl) && configuredTtl > 0
    ? configuredTtl : 60000;

  async function analyze(company: Company): Promise<NewsAnalysis> {
    const now = clock();
    const base: NewsAnalysis = {
      company, status: 'insufficient', articles: [], asOf: now.toISOString(), period: nextAnalysisWeek(now),
      evidence: 'none', summary: '근거 부족으로 다음 주 방향 판단을 유보합니다.',
      positiveFactors: [], negativeFactors: [], risks: [...RISKS], provider: provider.name?.trim() || null, analysisVersion: ANALYSIS_VERSION,
      newsWindow: { start: new Date(now.getTime() - 7 * 86400000).toISOString(), end: now.toISOString() },
    };
    try {
      const result = await provider.getArticles(company, now);
      const articles = result.articles;
      const fresh = articles.filter(article => {
        const publishedAt = Date.parse(article.publishedAt);
        return publishedAt >= now.getTime() - 7 * 86400000 && publishedAt <= now.getTime();
      });
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
      return {
        ...base, provider: result.provider, articles, status: sufficient ? 'ready' : 'insufficient',
        evidence: sufficient ? 'moderate' : fresh.length > 0 ? 'low' : 'none', summary,
        positiveFactors: [...new Set(positive.map(article => article.rationale))].slice(0, 4),
        negativeFactors: [...new Set(negative.map(article => article.rationale))].slice(0, 4),
        risks: [...new Set([
          ...base.risks, ...(result.notes ?? []),
          ...(unclassifiedCount > 0 ? [`분류 미확인 기사 ${unclassifiedCount}건은 긍정·부정·중립 집계에 포함하지 않았습니다.`] : []),
        ])],
      };
    } catch (error) {
      const code = error instanceof ProviderError ? error.code : 'error';
      const reason = error instanceof ProviderError ? error.reason : undefined;
      const requestedBackoff = error instanceof ProviderError ? error.retryAfterMs : undefined;
      const backoffMs = typeof requestedBackoff === 'number' && Number.isFinite(requestedBackoff) && requestedBackoff > 0
        ? requestedBackoff : 60000;
      return {
        ...base, status: code,
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
      };
    }
  }

  return {
    async getAnalysis(company: Company): Promise<NewsAnalysis> {
      const now = clock().getTime();
      const existing = cache.get(company.id);
      if (existing && existing.expiresAt > now) return existing.value;
      const inflight = pending.get(company.id);
      if (inflight) return inflight;
      const request = analyze(company).then(value => {
        if (cache.size >= 100) cache.delete(cache.keys().next().value!);
        const completedAt = clock().getTime();
        const lifetime = value.status === 'ready' || value.status === 'insufficient' ? cacheTtlMs
          : value.status === 'rate_limited' ? 60000 : 5000;
        const expiresAt = Math.max(completedAt + lifetime,
          value.status === 'rate_limited' && value.retryAt ? Date.parse(value.retryAt) : 0);
        const cached = {
          ...value, cachedUntil: new Date(expiresAt).toISOString(),
          ...(value.status === 'rate_limited' ? { retryAt: new Date(expiresAt).toISOString() } : {}),
        };
        cache.set(company.id, { expiresAt, value: cached });
        return cached;
      }).finally(() => pending.delete(company.id));
      pending.set(company.id, request);
      return request;
    },
  };
}
