import { isNewsTopicKey, type NewsTopicKey } from './news-topics.js';
import type { NewsAnalysis, NewsArticle } from './index.js';

/**
 * Contract and pure rules for historical news insights. No Node or DOM APIs and
 * no time zones: the mobile runtime loads this file too. Every function takes
 * its inputs (articles, window) as arguments, so nothing here reads a clock.
 */

export type Signal = 'positive' | 'negative' | 'withheld';
export type Verdict = 'supports' | 'contradicts' | 'weakens' | 'no_clear_difference' | 'insufficient';
/** day: next trading day. week: next five trading days. */
export type Horizon = 'day' | 'week';
export type ValidationStatus = 'not_evaluated' | 'no_evidence_of_improvement' | 'improvement_observed';
export type HistoryReadyStatus = 'ready' | 'no_history' | 'identity_unverified' | 'price_unavailable' | 'stats_not_public';

export interface ReturnSummary {
  median: number;
  q1: number;
  q3: number;
  min: number;
  max: number;
  /** Median market-relative return; null when the benchmark was missing. */
  relativeMedian: number | null;
}

/** Display-only statistics for one set of past cases. */
export interface CaseStats {
  cases: number;
  /** Non-overlapping windows among the cases. */
  nEff: number;
  up: number;
  neutral: number;
  down: number;
  /** Null below five cases: the cases are listed without statistics. */
  returns: ReturnSummary | null;
  period: { from: string; to: string } | null;
  entryType: 'open' | 'close' | 'mixed' | null;
  /** Up and down shares of all windows of the same stock in the same period; each within [0,1]. */
  allWindows: { up: number; down: number } | null;
}

/** One past article and what the price did afterwards. */
export interface CaseRef {
  date: string;
  source: string;
  url: string;
  title?: string;
  entryDate: string;
  exitDate: string;
  /** Own return; at least -1. */
  r: number;
  /** Market-relative return, null when the benchmark was missing. */
  relative: number | null;
}

/** The numbers behind a verdict. Up/down/neutral are market-relative outcomes. */
export interface SampleStats {
  unit: Horizon;
  eventUnits: number;
  otherUnits: number;
  eventUp: number;
  eventDown: number;
  eventNeutral: number;
  otherUp: number;
  otherDown: number;
  otherNeutral: number;
  /** Direction-signed difference of up shares, within [-1,1]. */
  difference: number;
  ci90: [number, number];
  from: string;
  to: string;
}

export interface DirectionStats {
  verdict: Verdict;
  reason?: string;
  sample: SampleStats | null;
  all: CaseStats;
  topics: Array<{ topic: NewsTopicKey; cases: CaseStats }>;
  examples: CaseRef[];
}

export interface HistoryValidation {
  status: ValidationStatus;
  directions: Array<'positive' | 'negative'>;
  markets: string[];
  evaluatedAt: string | null;
}

export interface HorizonHistory {
  validation: HistoryValidation;
  targetWindow: {
    start: string;
    end: string;
    basis: 'exchange_calendar' | 'weekdays_only';
    exchange: string;
    phase: 'before_open' | 'in_session' | 'after_close';
  };
  /** day only: the overnight news window. */
  newsWindow: { start: string; end: string } | null;
  /** Null when statistics for the market are not public: no numbers cross the wire. */
  directions: { positive: DirectionStats; negative: DirectionStats } | null;
}

export interface HistoryCoverage {
  articles: number;
  events: number;
  usable: number;
  excluded: Record<string, number>;
  observationGaps: number;
}

export interface HistoryDataAsOf {
  computedAt: string;
  lastPriceDate: string | null;
  ledgerFrom: string | null;
  ledgerTo: string | null;
}

export interface HistorySources {
  news: string[];
  price: { label: string; adjustment: 'raw' | 'split' | 'split_dividend' } | null;
}

export const NEWS_HISTORY_VERSION = 'news-history-v1';

/** Two members instead of one `'off' | 'unavailable'` member, so `status === 'off' || status === 'unavailable'` narrows the rest. */
export type CompanyHistory =
  | { version: typeof NEWS_HISTORY_VERSION; companyId: string; status: 'off' }
  | { version: typeof NEWS_HISTORY_VERSION; companyId: string; status: 'unavailable' }
  | {
      version: typeof NEWS_HISTORY_VERSION;
      companyId: string;
      status: HistoryReadyStatus;
      horizons: Record<Horizon, HorizonHistory>;
      coverage: HistoryCoverage;
      dataAsOf: HistoryDataAsOf;
      sources: HistorySources;
    };

// ---------------------------------------------------------------------------
// Strict parser. Rebuilds the value field by field, so unknown keys never pass through.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNumberIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function isText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!;
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  return match !== null && isCalendarDate(value.slice(0, 10)) &&
    Number(match[1]) < 24 && Number(match[2]) < 60 && Number(match[3]) < 60 &&
    Number.isFinite(Date.parse(value));
}

function isDateOrTimestamp(value: unknown): value is string {
  return isCalendarDate(value) || isTimestamp(value);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

function isHttpsUrl(value: unknown): value is string {
  if (!isText(value, 2000)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Date or timestamp pair in order; equal values are allowed. */
function isOrderedPair(start: unknown, end: unknown): start is string {
  return isDateOrTimestamp(start) && isDateOrTimestamp(end) && Date.parse(start) <= Date.parse(end);
}

const VERDICTS: readonly Verdict[] = ['supports', 'contradicts', 'weakens', 'no_clear_difference', 'insufficient'];
const READY_STATUSES: readonly HistoryReadyStatus[] = ['ready', 'no_history', 'identity_unverified', 'price_unavailable', 'stats_not_public'];
const VALIDATION_STATUSES: readonly ValidationStatus[] = ['not_evaluated', 'no_evidence_of_improvement', 'improvement_observed'];

function parseReturns(value: unknown): ReturnSummary | null {
  if (!isRecord(value)) return null;
  const { median, q1, q3, min, max, relativeMedian } = value;
  if (![median, q1, q3, min, max].every(item => isNumberIn(item, -1, 1000))) return null;
  const [a, b, c, d, e] = [min, q1, median, q3, max] as number[];
  if (!(a! <= b! && b! <= c! && c! <= d! && d! <= e!)) return null;
  if (!(relativeMedian === null || isNumberIn(relativeMedian, -1000, 1000))) return null;
  return { median: median as number, q1: q1 as number, q3: q3 as number, min: min as number, max: max as number, relativeMedian };
}

function parseCaseStats(value: unknown): CaseStats | null {
  if (!isRecord(value)) return null;
  const { cases, nEff, up, neutral, down, returns, period, entryType, allWindows } = value;
  if (!isCount(cases) || !isCount(nEff) || !isCount(up) || !isCount(neutral) || !isCount(down)) return null;
  if (nEff > cases || up + neutral + down > cases) return null;
  let parsedReturns: ReturnSummary | null = null;
  if (returns !== null) {
    parsedReturns = parseReturns(returns);
    if (parsedReturns === null) return null;
  }
  let parsedPeriod: CaseStats['period'] = null;
  if (period !== null) {
    if (!isRecord(period) || !isCalendarDate(period.from) || !isCalendarDate(period.to) || period.from > period.to) return null;
    parsedPeriod = { from: period.from, to: period.to };
  }
  if (!(entryType === null || oneOf(entryType, ['open', 'close', 'mixed'] as const))) return null;
  let parsedAll: CaseStats['allWindows'] = null;
  if (allWindows !== null) {
    if (!isRecord(allWindows) || !isNumberIn(allWindows.up, 0, 1) || !isNumberIn(allWindows.down, 0, 1) ||
        allWindows.up + allWindows.down > 1 + 1e-9) return null;
    parsedAll = { up: allWindows.up, down: allWindows.down };
  }
  return { cases, nEff, up, neutral, down, returns: parsedReturns, period: parsedPeriod, entryType, allWindows: parsedAll };
}

function parseCaseRef(value: unknown): CaseRef | null {
  if (!isRecord(value)) return null;
  if (!isCalendarDate(value.date) || !isText(value.source, 100) || !isHttpsUrl(value.url) ||
      !isCalendarDate(value.entryDate) || !isCalendarDate(value.exitDate) || value.entryDate > value.exitDate ||
      !isNumberIn(value.r, -1, 1000) || !(value.relative === null || isNumberIn(value.relative, -1000, 1000))) return null;
  if (value.title !== undefined && !isText(value.title, 300)) return null;
  const ref: CaseRef = {
    date: value.date, source: value.source, url: value.url, entryDate: value.entryDate, exitDate: value.exitDate,
    r: value.r, relative: value.relative,
  };
  if (value.title !== undefined) ref.title = value.title as string;
  return ref;
}

function parseSample(value: unknown): SampleStats | null {
  if (!isRecord(value)) return null;
  const counts = ['eventUnits', 'otherUnits', 'eventUp', 'eventDown', 'eventNeutral', 'otherUp', 'otherDown', 'otherNeutral'] as const;
  if (!oneOf(value.unit, ['day', 'week'] as const) || !counts.every(key => isCount(value[key]))) return null;
  const n = value as Record<(typeof counts)[number], number>;
  if (n.eventUp + n.eventDown + n.eventNeutral > n.eventUnits || n.otherUp + n.otherDown + n.otherNeutral > n.otherUnits) return null;
  const ci = value.ci90;
  if (!isNumberIn(value.difference, -1, 1) || !Array.isArray(ci) || ci.length !== 2 ||
      !isNumberIn(ci[0], -1, 1) || !isNumberIn(ci[1], -1, 1) || ci[0] > ci[1]) return null;
  if (!isCalendarDate(value.from) || !isCalendarDate(value.to) || value.from > value.to) return null;
  return {
    unit: value.unit, eventUnits: n.eventUnits, otherUnits: n.otherUnits, eventUp: n.eventUp, eventDown: n.eventDown,
    eventNeutral: n.eventNeutral, otherUp: n.otherUp, otherDown: n.otherDown, otherNeutral: n.otherNeutral,
    difference: value.difference, ci90: [ci[0], ci[1]], from: value.from, to: value.to,
  };
}

function parseDirectionStats(value: unknown): DirectionStats | null {
  if (!isRecord(value) || !oneOf(value.verdict, VERDICTS)) return null;
  if (value.reason !== undefined && !isText(value.reason, 300)) return null;
  let sample: SampleStats | null = null;
  if (value.sample !== null) {
    sample = parseSample(value.sample);
    if (sample === null) return null;
  }
  const all = parseCaseStats(value.all);
  if (all === null || !Array.isArray(value.topics) || value.topics.length > 10 ||
      !Array.isArray(value.examples) || value.examples.length > 5) return null;
  const topics: DirectionStats['topics'] = [];
  const seen = new Set<string>();
  for (const item of value.topics) {
    if (!isRecord(item) || !isNewsTopicKey(item.topic) || seen.has(item.topic)) return null;
    const cases = parseCaseStats(item.cases);
    if (cases === null) return null;
    seen.add(item.topic);
    topics.push({ topic: item.topic, cases });
  }
  const examples: CaseRef[] = [];
  for (const item of value.examples) {
    const ref = parseCaseRef(item);
    if (ref === null) return null;
    examples.push(ref);
  }
  const stats: DirectionStats = { verdict: value.verdict, sample, all, topics, examples };
  if (value.reason !== undefined) stats.reason = value.reason as string;
  return stats;
}

function parseValidation(value: unknown): HistoryValidation | null {
  if (!isRecord(value) || !oneOf(value.status, VALIDATION_STATUSES)) return null;
  const { directions, markets, evaluatedAt } = value;
  if (!Array.isArray(directions) || directions.length > 2 || new Set(directions).size !== directions.length ||
      !directions.every(item => item === 'positive' || item === 'negative')) return null;
  if (!Array.isArray(markets) || markets.length > 5 || !markets.every(item => isText(item, 10))) return null;
  if (!(evaluatedAt === null || isTimestamp(evaluatedAt))) return null;
  return {
    status: value.status, directions: [...directions] as HistoryValidation['directions'],
    markets: [...markets] as string[], evaluatedAt,
  };
}

function parseHorizon(value: unknown, horizon: Horizon, requireNoStats: boolean): HorizonHistory | null {
  if (!isRecord(value)) return null;
  const validation = parseValidation(value.validation);
  const target = value.targetWindow;
  if (validation === null || !isRecord(target) || !isOrderedPair(target.start, target.end) ||
      !oneOf(target.basis, ['exchange_calendar', 'weekdays_only'] as const) || !isText(target.exchange, 20) ||
      !oneOf(target.phase, ['before_open', 'in_session', 'after_close'] as const)) return null;
  let newsWindow: HorizonHistory['newsWindow'] = null;
  if (value.newsWindow !== null) {
    const window = value.newsWindow;
    if (horizon !== 'day' || !isRecord(window) || !isTimestamp(window.start) || !isTimestamp(window.end) ||
        !isOrderedPair(window.start, window.end)) return null;
    newsWindow = { start: window.start, end: window.end as string };
  }
  let directions: HorizonHistory['directions'] = null;
  if (value.directions !== null) {
    if (requireNoStats || !isRecord(value.directions)) return null;
    const positive = parseDirectionStats(value.directions.positive);
    const negative = parseDirectionStats(value.directions.negative);
    if (positive === null || negative === null) return null;
    directions = { positive, negative };
  }
  return {
    validation,
    targetWindow: {
      start: target.start as string, end: target.end as string, basis: target.basis, exchange: target.exchange, phase: target.phase,
    },
    newsWindow,
    directions,
  };
}

function parseCoverage(value: unknown): HistoryCoverage | null {
  if (!isRecord(value) || !isCount(value.articles) || !isCount(value.events) || !isCount(value.usable) ||
      !isCount(value.observationGaps) || !isRecord(value.excluded)) return null;
  const keys = Object.keys(value.excluded);
  if (keys.length > 30) return null;
  const excluded: Record<string, number> = {};
  for (const key of keys) {
    const count = value.excluded[key];
    if (key === '__proto__' || !isText(key, 60) || !isCount(count)) return null;
    excluded[key] = count;
  }
  return { articles: value.articles, events: value.events, usable: value.usable, excluded, observationGaps: value.observationGaps };
}

function parseDataAsOf(value: unknown): HistoryDataAsOf | null {
  if (!isRecord(value) || !isTimestamp(value.computedAt) ||
      !(value.lastPriceDate === null || isCalendarDate(value.lastPriceDate)) ||
      !(value.ledgerFrom === null || isDateOrTimestamp(value.ledgerFrom)) ||
      !(value.ledgerTo === null || isDateOrTimestamp(value.ledgerTo))) return null;
  return { computedAt: value.computedAt, lastPriceDate: value.lastPriceDate, ledgerFrom: value.ledgerFrom, ledgerTo: value.ledgerTo };
}

function parseSources(value: unknown): HistorySources | null {
  if (!isRecord(value) || !Array.isArray(value.news) || value.news.length > 8 || !value.news.every(item => isText(item, 60))) return null;
  let price: HistorySources['price'] = null;
  if (value.price !== null) {
    if (!isRecord(value.price) || !isText(value.price.label, 80) ||
        !oneOf(value.price.adjustment, ['raw', 'split', 'split_dividend'] as const)) return null;
    price = { label: value.price.label, adjustment: value.price.adjustment };
  }
  return { news: [...value.news] as string[], price };
}

/** Returns a rebuilt, fully validated copy, or null. Never throws. */
export function parseCompanyHistory(value: unknown): CompanyHistory | null {
  try {
    if (!isRecord(value) || value.version !== NEWS_HISTORY_VERSION || !isText(value.companyId, 40)) return null;
    const { version, companyId, status } = value as { version: typeof NEWS_HISTORY_VERSION; companyId: string; status: unknown };
    if (status === 'off' || status === 'unavailable') return { version, companyId, status };
    if (!oneOf(status, READY_STATUSES) || !isRecord(value.horizons)) return null;
    // stats_not_public must carry no statistics at all, even if a server sent them.
    const noStats = status === 'stats_not_public';
    const day = parseHorizon(value.horizons.day, 'day', noStats);
    const week = parseHorizon(value.horizons.week, 'week', noStats);
    const coverage = parseCoverage(value.coverage);
    const dataAsOf = parseDataAsOf(value.dataAsOf);
    const sources = parseSources(value.sources);
    if (day === null || week === null || coverage === null || dataAsOf === null || sources === null) return null;
    return { version, companyId, status, horizons: { day, week }, coverage, dataAsOf, sources };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

/** Week signal derived from the existing analysis; ambiguous input closes to withheld. */
export function deriveBaselineSignal(a: Pick<NewsAnalysis, 'status' | 'positiveFactors' | 'negativeFactors'>): Signal {
  if (a.status !== 'ready') return 'withheld';
  const positive = a.positiveFactors.length > 0;
  const negative = a.negativeFactors.length > 0;
  return positive === negative ? 'withheld' : positive ? 'positive' : 'negative';
}

/** Published time may precede real visibility; this margin is added before placing an article. */
export const ARTICLE_TIME_MARGIN_MS = 5 * 60 * 1000;

export type OvernightReason = 'conflicting' | 'one_direction' | 'no_overnight_news';
export type OvernightEvidence = 'none' | 'low' | 'moderate';
export interface OvernightSignal {
  signal: Signal;
  reason: OvernightReason;
  /** In-window articles by sentiment; `ignored` counts unrelated and unclassified ones. */
  counts: { positive: number; negative: number; neutral: number; ignored: number };
  evidence: OvernightEvidence;
}

/** Day-horizon signal from the articles published while the market was closed. */
export function deriveOvernightSignal(
  articles: ReadonlyArray<Pick<NewsArticle, 'publishedAt' | 'sentiment' | 'aiRelevance'>>,
  window: { start: string; end: string },
): OvernightSignal {
  const counts = { positive: 0, negative: 0, neutral: 0, ignored: 0 };
  const start = Date.parse(window.start);
  const end = Date.parse(window.end);
  if (Number.isFinite(start) && Number.isFinite(end)) {
    for (const article of articles) {
      const placed = Date.parse(article.publishedAt) + ARTICLE_TIME_MARGIN_MS;
      if (!(placed > start && placed <= end)) continue;
      if (article.aiRelevance === 'unrelated') counts.ignored += 1;
      else if (article.sentiment === 'positive') counts.positive += 1;
      else if (article.sentiment === 'negative') counts.negative += 1;
      else if (article.sentiment === 'neutral') counts.neutral += 1;
      else counts.ignored += 1;
    }
  }
  const directional = counts.positive + counts.negative;
  if (counts.positive > 0 && counts.negative > 0) {
    // Withheld on a conflict: evidence is never shown above low.
    return { signal: 'withheld', reason: 'conflicting', counts, evidence: 'low' };
  }
  if (directional === 0) return { signal: 'withheld', reason: 'no_overnight_news', counts, evidence: 'none' };
  return {
    signal: counts.positive > 0 ? 'positive' : 'negative',
    reason: 'one_direction',
    counts,
    evidence: directional >= 2 ? 'moderate' : 'low',
  };
}

export type IntegrationNote = 'supports' | 'no_clear_difference' | 'weakens' | 'contradicts' | 'insufficient' | 'baseline_withheld';
export interface IntegratedOutlook {
  signal: Signal;
  changed: boolean;
  note: IntegrationNote;
}

/** Past cases may lower a directional baseline to withheld, never raise anything. */
export function integrateOutlook(baseline: Signal, verdict: Verdict): IntegratedOutlook {
  if (baseline !== 'positive' && baseline !== 'negative') return { signal: 'withheld', changed: false, note: 'baseline_withheld' };
  switch (verdict) {
    case 'contradicts': return { signal: 'withheld', changed: true, note: 'contradicts' };
    case 'supports': return { signal: baseline, changed: false, note: 'supports' };
    case 'no_clear_difference': return { signal: baseline, changed: false, note: 'no_clear_difference' };
    case 'weakens': return { signal: baseline, changed: false, note: 'weakens' };
    default: return { signal: baseline, changed: false, note: 'insufficient' };
  }
}

// ---------------------------------------------------------------------------
// Display text. Never uses promise, guarantee, hit-rate or probability wording.
// ---------------------------------------------------------------------------

export const SIGNAL_LABELS: Record<Signal, string> = {
  positive: '상승 전망',
  negative: '하락 전망',
  withheld: '판단 유보',
};

export const HORIZON_LABELS: Record<Horizon, string> = {
  day: '다음 거래일',
  week: '다음 주',
};

export const VERDICT_LABELS: Record<Verdict, string> = {
  supports: '지지',
  contradicts: '상충',
  weakens: '약화',
  no_clear_difference: '뚜렷한 차이 없음',
  insufficient: '근거 부족',
};

export const VALIDATION_BADGES: Record<ValidationStatus, string> = {
  not_evaluated: '검증 전 · 참고 정보',
  no_evidence_of_improvement: '개선 근거 없음 · 참고 정보',
  improvement_observed: '범위·기간을 밝힌 개선 관찰 · 참고 정보',
};

/** The improvement badges apply only inside the evaluated directions and markets. */
export function validationBadge(validation: HistoryValidation, direction: Signal, market: string): string {
  const inScope = (direction === 'positive' || direction === 'negative') &&
    validation.directions.includes(direction) && validation.markets.includes(market);
  return VALIDATION_BADGES[inScope ? validation.status : 'not_evaluated'];
}

export const HISTORY_DISCLAIMER = '상승·하락 전망은 뉴스와 과거 사례로 만든 참고 의견이며 검증 전입니다. 다음 거래일 전망은 전일 종가 대비 등락 방향이며, 장이 열릴 때 이미 벌어지는 가격 차이가 포함됩니다. 뉴스를 본 뒤 그 가격에 살 수 있다는 뜻이 아닙니다. 과거 사례 통계는 미래 수익을 보장하지 않습니다. 비슷한 뉴스 뒤의 결과가 반복된다는 뜻이 아니며, 기사가 주가 변동의 원인이라는 뜻도 아닙니다. 매수·매도 권유가 아니고 거래비용·세금은 반영하지 않았습니다. 대상 종목은 현재 시점에 고른 8개 대형주여서 실제보다 좋게 보일 수 있습니다.';

export const HISTORY_SHARE_LABEL = '과거 상승 비중(미래 확률 아님)';
export const DIFFERENT_HORIZONS_NOTE = '두 전망은 보는 기간과 쓰는 뉴스가 달라 서로 다를 수 있습니다.';
export const STATS_NOT_PUBLIC_MESSAGE = '과거 사례 통계는 데이터 이용 허가 확인 뒤 공개';
export const NO_OVERNIGHT_NEWS_MESSAGE = '판단 유보 · 밤사이 새 뉴스 없음';
export const NO_HISTORY_MESSAGE = '과거 사례 데이터 없음 · 기존 판단 유지';
export const IDENTITY_UNVERIFIED_MESSAGE = '종목 식별을 확인하지 못해 과거 사례 통계가 없습니다 · 기존 판단 유지';
export const PRICE_UNAVAILABLE_MESSAGE = '가격 데이터를 받지 못해 과거 사례 통계가 없습니다 · 기존 판단 유지';
export const HISTORY_UNAVAILABLE_MESSAGE = '과거 사례를 불러오지 못했습니다';

/** Row text of the integration table; `day` speaks of days, `week` of weeks. */
export function integrationMessage(note: IntegrationNote, horizon: Horizon): string {
  const unit = horizon === 'week' ? '주' : '날';
  const span = horizon === 'week' ? '다음 5거래일' : '다음 거래일';
  switch (note) {
    case 'supports':
      return `같은 방향 뉴스가 있던 ${unit}의 ${span}도 시장 대비 같은 방향이었습니다. 근거 수준은 올리지 않습니다.`;
    case 'no_clear_difference':
      return `이 종목의 다른 ${unit}과 뚜렷한 차이가 없었습니다.`;
    case 'weakens':
      return `주의: 같은 방향 뉴스가 있던 ${unit}의 ${span}이 이 방향을 뒷받침하지 않았습니다.`;
    case 'contradicts':
      return `같은 방향 뉴스가 있던 ${unit}의 ${span}이 이 방향과 반대 쪽이어서 판단을 유보로 낮췄습니다.`;
    case 'insufficient':
      return '추가 근거 부족, 기존 판단 유지';
    case 'baseline_withheld':
      return '기존 판단 유보 유지. 사례는 참고로 표시합니다.';
  }
}

/** One line for the day card: "밤사이 긍정 기사 2건". */
export function overnightSummaryText(result: OvernightSignal): string {
  if (result.reason === 'no_overnight_news') return '밤사이 새 뉴스 없음';
  if (result.reason === 'conflicting') return '밤사이 긍정·부정 기사가 섞임';
  return `밤사이 ${result.signal === 'positive' ? '긍정' : '부정'} 기사 ${result.counts[result.signal === 'positive' ? 'positive' : 'negative']}건`;
}
