import {
  ARTICLE_TIME_MARGIN_MS, ASK_TERM_IDS, ASK_TERMS, BACKFILL_SAMPLE_NOTE, EXPIRED_STATS_MESSAGE, GDELT_CREDIT, HISTORY_DISCLAIMER,
  HORIZON_LABELS, MARKETAUX_TOP_NOTE, SIGNAL_LABELS, STATS_NOT_PUBLIC_MESSAGE, VERDICT_LABELS, WEEKDAYS_ONLY_NOTE,
  classifyNewsTopics, coverageLine, deriveHistoryView, evidenceHorizonLabel, formatKstTime, formatPoints, formatReturn, formatShare,
  isNewsTopicKey, newsTopicLabel, parseAskEvidence, sourcesLine, statsAge,
  type AskEvidence, type AskTermId, type CaseRef, type CaseStats, type Company, type CompanyHistory, type DirectionStats, type Horizon,
  type HistoryView, type HorizonHistory, type NewsAnalysis, type NewsArticle, type NewsTopicKey, type ReadyCompanyHistory,
} from '../packages/core/src/index.js';
import { plainText } from './provider.js';

// Read-only tools of the AI question feature (step 7, plan ch. 7). Invariants:
// - No I/O of their own: every tool reads the analysis and the history the question already fetched.
// - The model never sees a value. A fact reaches it as { id: 'F7', label }, with a digit-free label; the value
//   stays in the FactTable and the server fills it after checking the model's text. Apart from article and case
//   titles, source names and the ids themselves, no tool result holds a digit.
// - stats_not_public: get_history and get_cases answer exactly { tool, status: 'private' } and add no fact or link,
//   get_outlook names the verdict '공개 전', and get_data_status carries no statistics time, coverage or price fields.
// - runAskTool never throws; a fault is { tool, status: 'error' }.

export const ASK_TOOL_NAMES = ['get_outlook', 'get_articles', 'get_history', 'get_cases', 'explain_term', 'get_data_status'] as const;
export type AskToolName = typeof ASK_TOOL_NAMES[number];
export const ASK_HORIZON_ARGS = ['day', 'week', 'both'] as const;
export const ASK_DIRECTION_ARGS = ['positive', 'negative', 'neutral', 'all'] as const;
export const ASK_OVERNIGHT_ARGS = ['only', 'all'] as const;

export interface AskToolArgs {
  horizon: 'day' | 'week' | 'both';
  direction: 'positive' | 'negative' | 'neutral' | 'all';
  topic: NewsTopicKey | 'all';
  overnight: 'only' | 'all';
  term: AskTermId | 'none';
}

/** The arguments of the two results attached to every question before the first call. */
export const ASK_DEFAULT_TOOL_ARGS: Readonly<AskToolArgs> = Object.freeze({ horizon: 'both', direction: 'all', topic: 'all', overnight: 'all', term: 'none' });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

/**
 * A model's tool request: the name and every argument from its own list, also the ones the tool does not use.
 * 'neutral' is a direction only for get_articles, and explain_term needs a term.
 */
export function parseToolCall(raw: Record<string, unknown>): { tool: AskToolName; args: AskToolArgs } | null {
  if (!isRecord(raw)) return null;
  const { tool, horizon, direction, topic, overnight, term } = raw;
  if (!oneOf(tool, ASK_TOOL_NAMES) || !oneOf(horizon, ASK_HORIZON_ARGS) || !oneOf(direction, ASK_DIRECTION_ARGS) ||
      !(topic === 'all' || isNewsTopicKey(topic)) || !oneOf(overnight, ASK_OVERNIGHT_ARGS) ||
      !(term === 'none' || oneOf(term, ASK_TERM_IDS))) return null;
  if (direction === 'neutral' && tool !== 'get_articles') return null;
  if (tool === 'explain_term' && term === 'none') return null;
  return { tool, args: { horizon, direction, topic: topic as NewsTopicKey | 'all', overnight, term: term as AskTermId | 'none' } };
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

export interface FactTable {
  /** Returns 'F<n>'; the same key returns the same id. Beyond the table's size it returns '' and the caller omits that field. */
  add(key: string, label: string, value: string): string;
  get(id: string): { label: string; value: string } | undefined;
  readonly size: number;
}

export function createFactTable(max = 120): FactTable {
  const byKey = new Map<string, string>();
  const byId = new Map<string, { label: string; value: string }>();
  return {
    add(key, label, value) {
      const known = byKey.get(key);
      if (known !== undefined) return known;
      if (byId.size >= max) return '';
      const id = `F${byId.size + 1}`;
      byKey.set(key, id);
      byId.set(id, { label, value });
      return id;
    },
    get: id => byId.get(id),
    get size() { return byId.size; },
  };
}

export interface AskToolContext {
  company: Company;
  analysis: NewsAnalysis;
  history: CompanyHistory;
  nowMs: number;
  facts: FactTable;
  /** 'A3' / 'C1' ids the model has been shown, with the link each stands for. */
  refs: Map<string, AskEvidence>;
}

/** JSON-safe. */
export type AskToolResult = { tool: AskToolName; status: string } & Record<string, unknown>;

/** What the model sees of one fact. */
interface FactRef { id: string; label: string }

function fact(ctx: AskToolContext, key: string, label: string, value: string): FactRef | undefined {
  if (!value) return undefined;
  const id = ctx.facts.add(key, label, value);
  return id ? { id, label } : undefined;
}

const KST_OFFSET_MS = 9 * 3_600_000;
/** The context year formatKstTime leaves out: the Korean calendar year at nowMs. */
export function kstYear(nowMs: number): number {
  return new Date(nowMs + KST_OFFSET_MS).getUTCFullYear();
}

/**
 * off and unavailable carry nothing; every other status has horizons. A stats_not_public value is read without its
 * statistics whatever it holds (parseCompanyHistory already refuses them there), so no tool or template can show one.
 */
export function readyHistory(history: CompanyHistory): ReadyCompanyHistory | null {
  if (history.status === 'off' || history.status === 'unavailable') return null;
  if (history.status !== 'stats_not_public') return history;
  const bare = (h: HorizonHistory): HorizonHistory => ({ validation: h.validation, targetWindow: h.targetWindow, newsWindow: h.newsWindow, directions: null });
  return { ...history, horizons: { day: bare(history.horizons.day), week: bare(history.horizons.week) } };
}

/** Display text within String.length max: a link's title and source must pass parseAskEvidence. */
function bounded(value: string, max: number): string | undefined {
  const text = plainText(value, max);
  if (text === undefined || text.length <= max) return text;
  let out = '';
  for (const char of text) {
    if (out.length + char.length > max - 1) break;
    out += char;
  }
  return `${out}…`;
}

const horizonsOf = (horizon: AskToolArgs['horizon']): Horizon[] => horizon === 'both' ? ['day', 'week'] : [horizon];
const directionsOf = (direction: AskToolArgs['direction']): Array<'positive' | 'negative'> =>
  direction === 'positive' || direction === 'negative' ? [direction] : ['positive', 'negative'];
const DIRECTION_NAMES = { positive: '긍정', negative: '부정' } as const;

// ---------------------------------------------------------------------------
// get_outlook
// ---------------------------------------------------------------------------

/** The status badge and evidence level the analysis card shows. */
export function analysisStatusLabel(analysis: Pick<NewsAnalysis, 'status'>): string {
  return analysis.status === 'insufficient' ? '근거 부족 · 판단 유보' : '뉴스 참고 · 불확실성 존재';
}
export const ANALYSIS_EVIDENCE_LABELS: Record<NewsAnalysis['evidence'], string> = { moderate: '보통', low: '낮음', none: '없음' };

const relatedArticles = (analysis: NewsAnalysis) => analysis.articles.filter(article => article.aiRelevance !== 'unrelated');

function currentOutlook(ctx: AskToolContext) {
  const a = ctx.analysis;
  const factors = (direction: 'positive' | 'negative'): FactRef[] => {
    const lines = a.factorSummary ? a.factorSummary[direction].lines.map(line => line.text)
      : direction === 'positive' ? a.positiveFactors : a.negativeFactors;
    return lines.slice(0, 5).flatMap((text, index) =>
      fact(ctx, `outlook.current.${direction}.${index}`, direction === 'positive' ? '긍정 요인' : '부정 요인', text) ?? []);
  };
  return {
    status: fact(ctx, 'outlook.current.status', '현재 분석 상태', analysisStatusLabel(a)),
    statusCode: a.status,
    evidence: fact(ctx, 'outlook.current.evidence', '근거 수준', ANALYSIS_EVIDENCE_LABELS[a.evidence]),
    evidenceCode: a.evidence,
    summary: fact(ctx, 'outlook.current.summary', '현재 분석 요약', a.summary),
    relatedCount: fact(ctx, 'outlook.current.related', '관련 기사 수', `${relatedArticles(a).length}건`),
    positiveFactors: factors('positive'),
    negativeFactors: factors('negative'),
    hasPositive: a.positiveFactors.length > 0,
    hasNegative: a.negativeFactors.length > 0,
  };
}

function horizonOutlook(ctx: AskToolContext, history: ReadyCompanyHistory, view: HistoryView, horizon: Horizon) {
  const item = view[horizon];
  const target = history.horizons[horizon].targetWindow;
  // The card's own name for the horizon: '오늘 장' while the target session is open.
  const name = evidenceHorizonLabel(horizon, target);
  const add = (field: string, label: string, value: string) => fact(ctx, `outlook.${horizon}.${field}`, `${name} · ${label}`, value);
  const verdict = !view.statsPublic ? '공개 전' : item.verdict === null ? '해당 없음' : VERDICT_LABELS[item.verdict];
  return {
    title: add('title', '카드 제목', item.title),
    signal: add('signal', '통합 전망', item.signalLabel),
    baseline: add('baseline', '기준선', SIGNAL_LABELS[item.baseline]),
    verdict: add('verdict', '과거 사례 판정', verdict),
    validation: add('validation', '검증 표시', item.validationLabel),
    newsLine: add('news', '뉴스 근거', item.newsLine),
    ...(item.lastCheckLine !== null ? { lastCheckLine: add('last_check', '마지막 뉴스 확인', item.lastCheckLine) } : {}),
    pastLine: add('past', '과거 사례 요약', item.pastLine),
    // As the screen shows it: a market without permission names that instead of the integration rule.
    integrationLine: add('integration', '통합 이유', view.statsPublic ? item.integrationLine : STATS_NOT_PUBLIC_MESSAGE),
    ...(item.changeLine !== null ? { changeLine: add('change', '기준선 변경', item.changeLine) } : {}),
    phase: target.phase,
    signalCode: item.integrated.signal,
    baselineCode: item.baseline,
    verdictCode: view.statsPublic ? item.verdict : null,
    ...(horizon === 'day' ? { overnightReason: item.overnight?.reason ?? null } : {}),
    changed: item.integrated.changed,
  };
}

function getOutlook(_args: AskToolArgs, ctx: AskToolContext): AskToolResult {
  const current = currentOutlook(ctx);
  const history = readyHistory(ctx.history);
  if (!history) return { tool: 'get_outlook', status: 'not_shown', current };
  const view = deriveHistoryView(ctx.analysis, history, ctx.nowMs);
  return {
    tool: 'get_outlook', status: 'shown', current, statsPublic: view.statsPublic, statsAge: view.statsAge,
    day: horizonOutlook(ctx, history, view, 'day'), week: horizonOutlook(ctx, history, view, 'week'),
  };
}

// ---------------------------------------------------------------------------
// get_articles
// ---------------------------------------------------------------------------

/** The factor summary's own topic rule: the article's topics, else its keywords. */
function articleTopics(article: NewsArticle): NewsTopicKey[] {
  return article.topics?.length ? article.topics : classifyNewsTopics(`${article.title} ${article.description ?? ''}`);
}

function articleEvidence(article: NewsArticle): AskEvidence | null {
  return parseAskEvidence({
    title: bounded(article.title, 300), source: bounded(article.source, 100), url: article.url, publishedAt: article.publishedAt,
  });
}

function getArticles(args: AskToolArgs, ctx: AskToolContext): AskToolResult {
  const a = ctx.analysis;
  const window = readyHistory(ctx.history)?.horizons.day.newsWindow ?? null;
  if (args.overnight === 'only' && !window) return { tool: 'get_articles', status: 'no_window' };
  const start = window ? Date.parse(window.start) : Number.NaN;
  const end = window ? Date.parse(window.end) : Number.NaN;
  // As deriveOvernightSignal: news gathered before the window opened has not checked it (the card says so).
  const checked = window !== null && !(Date.parse(a.asOf) < start);
  if (args.overnight === 'only' && !checked) return { tool: 'get_articles', status: 'not_checked' };
  const overnight = (article: NewsArticle) => {
    const placed = Date.parse(article.publishedAt) + ARTICLE_TIME_MARGIN_MS;
    return checked && placed > start && placed <= end;
  };
  const matched = a.articles.map((article, index) => ({ article, index })).filter(({ article }) => {
    if (article.aiRelevance === 'unrelated') return false;
    if (args.direction === 'positive' && article.sentiment !== 'positive') return false;
    if (args.direction === 'negative' && article.sentiment !== 'negative') return false;
    if (args.direction === 'neutral' && article.sentiment !== 'neutral' && article.sentiment !== 'unclassified') return false;
    if (args.topic !== 'all' && !articleTopics(article).includes(args.topic)) return false;
    return args.overnight !== 'only' || overnight(article);
  });
  const year = kstYear(ctx.nowMs);
  const articles = matched.slice(0, 8).map(({ article, index }) => {
    const id = `A${index + 1}`;
    const evidence = articleEvidence(article);
    if (evidence) ctx.refs.set(id, evidence);
    return {
      id, title: plainText(article.title, 160), source: article.source, sentiment: article.sentiment, topics: articleTopics(article),
      ...(window ? { overnight: overnight(article) } : {}),
      time: fact(ctx, `article.${id}.time`, article.timeKind === 'seen' ? '처음 확인한 시각' : '게시 시각', formatKstTime(article.publishedAt, year)),
    };
  });
  return {
    tool: 'get_articles', status: 'ok',
    matched: fact(ctx, `articles.matched.${args.direction}.${args.topic}.${args.overnight}`, '조건에 맞는 기사 수', `${matched.length}건`),
    articles,
  };
}

// ---------------------------------------------------------------------------
// get_history and get_cases
// ---------------------------------------------------------------------------

/** What both statistics tools answer before any number: private, off, unavailable, a status without statistics, or expired. */
function statsGate(tool: 'get_history' | 'get_cases', ctx: AskToolContext): AskToolResult | ReadyCompanyHistory {
  const history = ctx.history;
  // Exactly this and nothing else: no fact, no link, no date.
  if (history.status === 'stats_not_public') return { tool, status: 'private' };
  if (history.status === 'off' || history.status === 'unavailable') return { tool, status: history.status };
  if (history.status !== 'ready') return { tool, status: history.status };
  if (statsAge(history.dataAsOf.computedAt, ctx.nowMs) === 'expired') {
    const text = fact(ctx, 'stats.expired', '통계 상태', EXPIRED_STATS_MESSAGE);
    return { tool, status: 'expired', ...(text ? { text } : {}) };
  }
  return history;
}

const isResult = (value: AskToolResult | ReadyCompanyHistory): value is AskToolResult => 'tool' in value;

function caseStatsFacts(ctx: AskToolContext, key: string, label: (field: string) => string, c: CaseStats) {
  const add = (field: string, name: string, value: string) => fact(ctx, `${key}.${field}`, label(name), value);
  const r = c.returns;
  const labelled = c.up + c.neutral + c.down;
  return {
    count: add('count', '과거 사례 수', `${c.cases}건`),
    independent: add('independent', '겹치지 않는 구간 수', `${c.nEff}개`),
    up: add('up', '상승 사례 수', `${c.up}건`),
    neutral: add('neutral', '중립 사례 수', `${c.neutral}건`),
    down: add('down', '하락 사례 수', `${c.down}건`),
    hasStats: r !== null,
    // Below five cases there are no statistics, and a share needs ten non-overlapping windows (caseStatsLines).
    ...(r !== null ? {
      median: add('median', '수익률 중앙값', formatReturn(r.median)),
      middle: add('middle', '수익률 가운데 절반 범위', `${formatReturn(r.q1)} ~ ${formatReturn(r.q3)}`),
      ...(r.relativeMedian !== null ? { relativeMedian: add('relative_median', '시장 대비 수익률 중앙값', formatReturn(r.relativeMedian)) } : {}),
      ...(c.period !== null ? { period: add('period', '사례 기간', `${c.period.from} ~ ${c.period.to}`) } : {}),
      ...(c.allWindows !== null ? {
        allWindowsUp: add('all_up', '같은 기간 전체 구간의 과거 상승 비중', formatShare(c.allWindows.up)),
        allWindowsDown: add('all_down', '같은 기간 전체 구간의 과거 하락 비중', formatShare(c.allWindows.down)),
      } : {}),
      // The value carries the screen's qualifier, so a filled answer can never show the share as a bare figure.
      ...(c.nEff >= 10 && labelled > 0 ? { share: add('share', '과거 상승 비중', `${formatShare(c.up / labelled)}(미래 확률 아님)`) } : {}),
    } : {}),
  };
}

function directionHistory(ctx: AskToolContext, history: ReadyCompanyHistory, horizon: Horizon, direction: 'positive' | 'negative',
  stats: DirectionStats) {
  const base = `${HORIZON_LABELS[horizon]} · ${DIRECTION_NAMES[direction]} 방향`;
  const key = `history.${horizon}.${direction}`;
  const label = (field: string) => `${base} · ${field}`;
  const add = (field: string, name: string, value: string) => fact(ctx, `${key}.${field}`, label(name), value);
  const sample = stats.sample;
  const origin = history.horizons[horizon].sampleOrigin;
  return {
    verdictCode: stats.verdict,
    verdict: add('verdict', '과거 사례 판정', VERDICT_LABELS[stats.verdict]),
    // Unknown origin reads as backfill, as the screen shows BACKFILL_SAMPLE_NOTE then.
    includesBackfill: origin ? origin.includesBackfill : true,
    sample: sample === null ? null : {
      eventUnits: add('sample.event', '사건 기간 수', `${sample.eventUnits}개`),
      otherUnits: add('sample.other', '비교 기간 수', `${sample.otherUnits}개`),
      difference: add('sample.difference', '시장 대비 상승 비중 차이', formatPoints(sample.difference)),
      interval: add('sample.interval', '차이의 불확실성 범위', `${formatPoints(sample.ci90[0])} ~ ${formatPoints(sample.ci90[1])}`),
      period: add('sample.period', '판정 표본 기간', `${sample.from} ~ ${sample.to}`),
    },
    cases: caseStatsFacts(ctx, `${key}.cases`, label, stats.all),
    topics: stats.topics.map(item => ({
      topic: item.topic,
      count: add(`topic.${item.topic}`, `${newsTopicLabel(item.topic)} 주제 사례 수`, `${item.cases.cases}건`),
    })),
  };
}

function getHistory(args: AskToolArgs, ctx: AskToolContext): AskToolResult {
  const gate = statsGate('get_history', ctx);
  if (isResult(gate)) return gate;
  const horizons: Record<string, unknown> = {};
  for (const horizon of horizonsOf(args.horizon)) {
    const directions = gate.horizons[horizon].directions;
    horizons[horizon] = directions === null ? null : Object.fromEntries(directionsOf(args.direction).map(direction =>
      [direction, directionHistory(ctx, gate, horizon, direction, directions[direction])]));
  }
  return { tool: 'get_history', status: 'ok', statsAge: statsAge(gate.dataAsOf.computedAt, ctx.nowMs), horizons };
}

/** C1.. per question, in the order shown; the same link keeps its id. */
const caseIds = new WeakMap<AskToolContext, Map<string, string>>();
function caseId(ctx: AskToolContext, ref: CaseRef): string {
  let ids = caseIds.get(ctx);
  if (!ids) { ids = new Map(); caseIds.set(ctx, ids); }
  const key = JSON.stringify([ref.url, ref.date, ref.source, ref.title ?? null]);
  let id = ids.get(key);
  if (id === undefined) { id = `C${ids.size + 1}`; ids.set(key, id); }
  return id;
}

function getCases(args: AskToolArgs, ctx: AskToolContext): AskToolResult {
  const gate = statsGate('get_cases', ctx);
  if (isResult(gate)) return gate;
  const horizons: Record<string, unknown> = {};
  for (const horizon of horizonsOf(args.horizon)) {
    const directions = gate.horizons[horizon].directions;
    horizons[horizon] = directions === null ? null : Object.fromEntries(directionsOf(args.direction).map(direction => {
      const label = (field: string) => `${HORIZON_LABELS[horizon]} · ${DIRECTION_NAMES[direction]} 방향 · ${field}`;
      return [direction, directions[direction].examples.slice(0, 5).map((ref, index) => {
        const id = caseId(ctx, ref);
        const evidence = parseAskEvidence({
          title: bounded(ref.title ?? `${ref.source} 기사`, 300), source: bounded(ref.source, 100), url: ref.url, publishedAt: ref.date,
        });
        if (evidence) ctx.refs.set(id, evidence);
        const add = (field: string, name: string, value: string) => fact(ctx, `cases.${horizon}.${direction}.${index}.${field}`, label(name), value);
        return {
          id, source: ref.source, ...(ref.title ? { title: plainText(ref.title, 160) } : {}),
          date: add('date', '사례 기사 날짜', ref.date),
          period: add('period', '사례 진입·종료 기간', `${ref.entryDate} ~ ${ref.exitDate}`),
          return: add('return', '사례 수익률', formatReturn(ref.r)),
          ...(ref.relative !== null ? { relative: add('relative', '사례 시장 대비 수익률', formatReturn(ref.relative)) } : {}),
        };
      })];
    }));
  }
  return { tool: 'get_cases', status: 'ok', statsAge: statsAge(gate.dataAsOf.computedAt, ctx.nowMs), horizons };
}

// ---------------------------------------------------------------------------
// explain_term and get_data_status
// ---------------------------------------------------------------------------

function explainTerm(args: AskToolArgs, ctx: AskToolContext): AskToolResult {
  if (!oneOf(args.term, ASK_TERM_IDS)) return { tool: 'explain_term', status: 'error' };
  const { label, text } = ASK_TERMS[args.term];
  return {
    tool: 'explain_term', status: 'ok', term: args.term, label, text,
    definition: fact(ctx, `term.${args.term}`, '용어 풀이', `${label}: ${text}`),
  };
}

function getDataStatus(_args: AskToolArgs, ctx: AskToolContext): AskToolResult {
  const a = ctx.analysis;
  const history = readyHistory(ctx.history);
  const year = kstYear(ctx.nowMs);
  const statsPublic = history !== null && history.status !== 'stats_not_public';
  const notes: Array<{ code: string; text?: FactRef }> = [];
  const note = (code: string, text: string) => {
    const ref = fact(ctx, `status.note.${code}`, '데이터 안내', text);
    notes.push({ code, ...(ref ? { text: ref } : {}) });
  };
  const sources = a.sources ?? [];
  const statsNews = statsPublic && history ? history.sources.news : [];
  if ([...sources.map(source => `${source.id} ${source.label}`), a.provider ?? '', ...statsNews].some(name => /marketaux/i.test(name))) {
    note('marketaux_top', MARKETAUX_TOP_NOTE);
  }
  if (sources.some(source => /gdelt/i.test(`${source.id} ${source.label}`) && source.articleCount > 0) ||
      a.articles.some(article => /gdelt/i.test(article.sourceProvider ?? '')) || statsNews.some(name => /gdelt/i.test(name))) {
    note('gdelt', GDELT_CREDIT);
  }
  if (history && (['day', 'week'] as const).some(horizon => history.horizons[horizon].targetWindow.basis === 'weekdays_only')) {
    note('weekdays_only', WEEKDAYS_ONLY_NOTE);
  }
  if (statsPublic && history && (['day', 'week'] as const).some(horizon => {
    const h = history.horizons[horizon];
    return h.directions !== null && (!h.sampleOrigin || h.sampleOrigin.includesBackfill);
  })) note('backfill', BACKFILL_SAMPLE_NOTE);
  if (ctx.history.status === 'stats_not_public') note('stats_not_public', STATS_NOT_PUBLIC_MESSAGE);
  return {
    tool: 'get_data_status', status: 'ok',
    asOf: fact(ctx, 'status.as_of', '뉴스 기준 시각', formatKstTime(a.asOf, year)),
    newsWindow: a.newsWindow ? {
      start: fact(ctx, 'status.window.start', '최근 기사 구간 시작', formatKstTime(a.newsWindow.start, year)),
      end: fact(ctx, 'status.window.end', '최근 기사 구간 끝', formatKstTime(a.newsWindow.end, year)),
    } : null,
    provider: fact(ctx, 'status.provider', '뉴스 제공자', a.provider ?? '미연결'),
    // The current news sources by name and outcome code; the statistics' own sources line comes below, public only.
    sources: sources.map(source => ({ label: source.label, status: source.status })),
    history: ctx.history.status,
    statsPublic,
    // A market without permission gets no statistics time, coverage, sources or price date at all.
    ...(statsPublic && history ? {
      statsAge: statsAge(history.dataAsOf.computedAt, ctx.nowMs),
      computedAt: fact(ctx, 'status.computed_at', '통계 계산 시각', formatKstTime(history.dataAsOf.computedAt, year)),
      lastPriceDate: fact(ctx, 'status.last_price_date', '가격 기준일', history.dataAsOf.lastPriceDate ?? '없음'),
      sourcesLine: fact(ctx, 'status.sources_line', '통계 출처', sourcesLine(history.sources)),
      coverage: fact(ctx, 'status.coverage', '통계 범위', coverageLine(history.coverage)),
    } : {}),
    notes,
    ...(history ? { disclaimer: fact(ctx, 'status.disclaimer', '전망 고지', HISTORY_DISCLAIMER) } : {}),
  };
}

const TOOLS: Readonly<Record<AskToolName, (args: AskToolArgs, ctx: AskToolContext) => AskToolResult>> = {
  get_outlook: getOutlook,
  get_articles: getArticles,
  get_history: getHistory,
  get_cases: getCases,
  explain_term: explainTerm,
  get_data_status: getDataStatus,
};

/** Never throws; the result is plain JSON (no undefined fields). */
export function runAskTool(tool: AskToolName, args: AskToolArgs, ctx: AskToolContext): AskToolResult {
  try {
    if (!oneOf(tool, ASK_TOOL_NAMES)) return { tool, status: 'error' };
    return JSON.parse(JSON.stringify(TOOLS[tool](args, ctx))) as AskToolResult;
  } catch {
    return { tool, status: 'error' };
  }
}
