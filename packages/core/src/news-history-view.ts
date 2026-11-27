import { isNewsTopicKey, newsTopicLabel, type NewsTopicKey } from './news-topics.js';
import type { NewsAnalysis } from './index.js';
import {
  deriveBaselineSignal, deriveOvernightSignal, integrateOutlook, integrationMessage, overnightSummaryText, validationBadge,
  HISTORY_SHARE_LABEL, HORIZON_LABELS, IDENTITY_UNVERIFIED_MESSAGE, NEUTRAL_OVERNIGHT_NEWS_MESSAGE, NO_HISTORY_MESSAGE,
  NO_OVERNIGHT_NEWS_MESSAGE, NOT_CHECKED_OVERNIGHT_MESSAGE, PRICE_UNAVAILABLE_MESSAGE, SIGNAL_LABELS, STATS_NOT_PUBLIC_MESSAGE,
  VERDICT_LABELS,
  type CaseRef, type CaseStats, type CompanyHistory, type DirectionStats, type HistoryCoverage, type HistorySources, type Horizon,
  type HorizonHistory, type IntegratedOutlook, type OvernightEvidence, type OvernightSignal, type SampleStats, type Signal, type Verdict,
} from './news-history.js';

/**
 * What the two-horizon outlook shows, as pure functions of the analysis on screen and one
 * /api/news/history value. Like news-history.ts: no Node or DOM APIs, no time zones and no
 * clock reads (`nowMs` is always an argument), because the mobile runtime loads this file too.
 * Instants are shown in KST as UTC + 9 h (formatKstTime), never through an Intl time zone.
 * Every sentence the screen shows comes from here; no text promises a direction, names a
 * hit rate or a probability, or uses an arrow.
 */

export type ReadyCompanyHistory = Extract<CompanyHistory, { horizons: Record<Horizon, HorizonHistory> }>;
/** fresh: computed within 72 h. old: shown with a label. expired: older than 14 days, never used for a verdict. */
export type StatsAge = 'fresh' | 'old' | 'expired';

export interface HorizonView {
  horizon: Horizon;
  title: string;
  /** day: the overnight signal; week: the existing seven-day rule. */
  baseline: Signal;
  /** day only */
  overnight: OvernightSignal | null;
  /** Statistics of the baseline's direction; null when the baseline is withheld, there are none, or they expired. */
  direction: DirectionStats | null;
  /** null when the baseline is withheld or there are no statistics; insufficient when they expired. */
  verdict: Verdict | null;
  integrated: IntegratedOutlook;
  signalLabel: string;
  validationLabel: string;
  newsLine: string;
  /** day only, while the overnight news is not checked yet (not_checked): when the news on screen was gathered. */
  lastCheckLine: string | null;
  pastLine: string;
  integrationLine: string;
  /** Only when past cases lowered the baseline. */
  changeLine: string | null;
}

export interface HistoryView {
  day: HorizonView;
  week: HorizonView;
  /** False for stats_not_public: no statistic, coverage, date or source may be shown. */
  statsPublic: boolean;
  statsAge: StatsAge;
  /** A news source was rate limited or failed in this analysis (skipped sources do not count). */
  partialNews: boolean;
}

// ---------------------------------------------------------------------------
// Fixed text
// ---------------------------------------------------------------------------

export const STATS_OLD_AFTER_MS = 72 * 3_600_000;
export const STATS_EXPIRED_AFTER_MS = 14 * 86_400_000;

export const HISTORY_SECTION_TITLE = '전망 한눈에 보기';
export const IN_SESSION_DAY_TITLE = '오늘 장 전망 · 장 시작 전 기준';
/** The in-session day horizon's name in the evidence, matching IN_SESSION_DAY_TITLE. */
export const IN_SESSION_DAY_LABEL = '오늘 장';
export const EVIDENCE_TITLE = '근거 보기';
export const LAST_NEWS_CHECK_LABEL = '마지막 뉴스 확인';
export const CASES_SECTION_TITLE = '② 과거 유사 기사와 이후 실제 주가';
export const BASIS_SECTION_TITLE = '④ 표본·불확실성·데이터 기준';
export const HISTORY_LOADING_MESSAGE = '두 기간 전망을 준비하고 있습니다';
export const HISTORY_RETRY_LABEL = '과거 사례 다시 불러오기';
export const PARTIAL_NEWS_NOTE = '현재 기사 일부 누락';
export const STALE_STATS_LABEL = '오래된 통계';
export const EXPIRED_STATS_MESSAGE = '오래된 통계 · 계산한 지 14일이 지나 쓰지 않습니다';
export const CASE_BASIS_NOTE = '사례는 이 종목 수익률, 판정은 시장 대비 결과라 기준이 다릅니다.';
export const WEEKDAYS_ONLY_NOTE = '휴장일 미반영(평일 기준)';
export const MARKETAUX_TOP_NOTE = 'Marketaux가 고른 상위 기사 기준';
export const GDELT_CREDIT = 'GDELT Project 검색 결과 포함';
export const NEWS_WINDOW_LABEL = '밤사이 뉴스 기준';

export const CASE_DIRECTION_TITLES: Record<'positive' | 'negative', string> = {
  positive: '긍정 뉴스 뒤 과거 사례',
  negative: '부정 뉴스 뒤 과거 사례',
};

export const CASE_WINDOW_NOTES: Record<Horizon, string> = {
  day: '사례: 밤사이 기사 뒤 다음 거래일 종가까지(전일 종가 대비)',
  week: '사례: 기사 뒤 첫 가격부터 5거래일 뒤 종가까지',
};

export const RESULT_DEFINITIONS: Record<Horizon, string> = {
  day: '결과 정의: 다음 거래일 종가를 전일 종가와 비교한 시장 대비 등락(제자리 범위 제외)',
  week: '결과 정의: 기준 시각 뒤 다음 5거래일(첫날 시가 ~ 다섯째 날 종가)의 시장 대비 등락(제자리 범위 제외)',
};

export const EXCHANGE_LABELS: Record<string, string> = { KRX: '한국거래소', NASDAQ: '나스닥' };

export const ADJUSTMENT_LABELS: Record<NonNullable<HistorySources['price']>['adjustment'], string> = {
  raw: '미조정 가격',
  split: '분할 반영',
  split_dividend: '분할·배당 반영',
};

export const OVERNIGHT_EVIDENCE_LABELS: Record<OvernightEvidence, string> = { none: '없음', low: '낮음', moderate: '보통' };

export const INSUFFICIENT_REASON_LABELS: Record<string, string> = {
  invalid_sample: '표본 형식 오류',
  few_event_units: '사건 표본 20개 미만',
  few_other_units: '나머지 표본 20개 미만',
  quarter_concentration: '사건이 한 분기에 몰림',
  benchmark_gaps: '시장 기준 가격 결측이 많음',
  price_failed: '가격 받기 실패',
  identity_failed: '종목 식별 실패',
  price_stale: '가격이 오래됨',
  stats_stale: '통계가 오래됨',
};

export const EXCLUSION_LABELS: Record<string, string> = {
  overlap: '겹치는 구간',
  observation_gap: '관측 공백',
  pending: '아직 끝나지 않은 구간',
  no_label: '결과 없음',
  calendar_unverified: '달력 미확인',
  price_gap: '가격 공백',
  invalid_bar: '잘못된 가격',
  suspect_corporate_action: '기업행동 의심',
  benchmark_gap: '시장 기준 가격 공백',
  recent: '현재 기사 기간과 겹침',
  not_overnight: '밤사이 기사 아님',
};

export const EXCLUSION_PREFIX_LABELS: Record<'day_' | 'week_' | 'case_', string> = { day_: '다음 거래일', week_: '다음 주', case_: '사례' };

/** Own keys only: a server-sent key such as 'constructor' never reaches Object.prototype. */
function ownLabel(labels: Readonly<Record<string, string>>, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(labels, key) ? labels[key] : undefined;
}

// ---------------------------------------------------------------------------
// Dates and ages
// ---------------------------------------------------------------------------

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'] as const;

/** '2026-11-24' gives '11/24(화)'; anything that is not a calendar date in that form comes back unchanged. */
export function formatSessionDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) return date;
  return `${month}/${day}(${WEEKDAYS[utc.getUTCDay()]})`;
}

const KST_OFFSET_MS = 9 * 3_600_000;
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** A timestamp with a zone whose fields are all in range, else NaN: Date.parse alone rolls '02-30' over and reads '24:00'. */
function instantMs(value: string): number {
  const match = INSTANT.exec(value);
  if (!match) return Number.NaN;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(part => Number(part ?? 0)) as [number, number, number, number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) return Number.NaN;
  return Date.parse(value);
}

/**
 * An instant as Korean wall-clock time, '2026-11-20T21:00:00.000Z' giving '11/21(토) 06:00 KST'. KST is UTC + 9 h all
 * year (no daylight saving time), so no Intl time zone is needed. The year is added, '2025/12/31(수) 18:00 KST', only
 * when it differs from `contextYear` (the target window's year). Text that is not such an instant comes back unchanged.
 */
export function formatKstTime(value: string, contextYear: number): string {
  const ms = instantMs(value);
  if (!Number.isFinite(ms)) return value;
  const kst = new Date(ms + KST_OFFSET_MS);
  const year = kst.getUTCFullYear();
  const two = (n: number) => String(n).padStart(2, '0');
  const date = `${kst.getUTCMonth() + 1}/${kst.getUTCDate()}(${WEEKDAYS[kst.getUTCDay()]})`;
  return `${year === contextYear ? '' : `${year}/`}${date} ${two(kst.getUTCHours())}:${two(kst.getUTCMinutes())} KST`;
}

/** The year a target window starts in, the context formatKstTime leaves out: '2026-11-24' gives 2026. */
export function targetYear(target: Pick<HorizonHistory['targetWindow'], 'start'>): number {
  return Number(target.start.slice(0, 4));
}

/** '마지막 뉴스 확인 11/23(월) 14:00 KST': the day card's line while the overnight news is not checked yet. */
export function lastNewsCheckLine(checkedAt: string, contextYear: number): string {
  return `${LAST_NEWS_CHECK_LABEL} ${formatKstTime(checkedAt, contextYear)}`;
}

export function horizonTitle(horizon: Horizon, target: HorizonHistory['targetWindow']): string {
  if (horizon === 'day') return target.phase === 'in_session' ? IN_SESSION_DAY_TITLE : `${HORIZON_LABELS.day} · ${formatSessionDate(target.start)}`;
  return `${HORIZON_LABELS.week} · ${formatSessionDate(target.start)}~${formatSessionDate(target.end)}`;
}

/** Age of stats.json's computation; a value that does not parse counts as expired. */
export function statsAge(computedAt: string, nowMs: number): StatsAge {
  const age = nowMs - Date.parse(computedAt);
  if (!Number.isFinite(age) || age > STATS_EXPIRED_AFTER_MS) return 'expired';
  return age > STATS_OLD_AFTER_MS ? 'old' : 'fresh';
}

// ---------------------------------------------------------------------------
// Card lines
// ---------------------------------------------------------------------------

/**
 * Day card news line: the withheld cases name why, anything else counts the articles. A case per reason and no
 * default, so a new reason does not compile until its card line is chosen.
 */
export function dayNewsLine(signal: OvernightSignal): string {
  switch (signal.reason) {
    case 'not_checked': return NOT_CHECKED_OVERNIGHT_MESSAGE;
    case 'no_overnight_news': return NO_OVERNIGHT_NEWS_MESSAGE;
    case 'all_neutral': return NEUTRAL_OVERNIGHT_NEWS_MESSAGE;
    case 'conflicting':
    case 'one_direction':
      return overnightSummaryText(signal);
  }
}

/** Week card news line over the related articles of the analysis's seven-day window. */
export function weekNewsLine(a: Pick<NewsAnalysis, 'status' | 'positiveFactors' | 'negativeFactors' | 'articles' | 'newsWindow'>): string {
  const start = a.newsWindow ? Date.parse(a.newsWindow.start) : Number.NaN;
  const end = a.newsWindow ? Date.parse(a.newsWindow.end) : Number.NaN;
  let positive = 0;
  let negative = 0;
  let neutral = 0;
  for (const article of a.articles) {
    if (article.aiRelevance === 'unrelated') continue;
    if (a.newsWindow) {
      const published = Date.parse(article.publishedAt);
      if (!(start <= published && published <= end)) continue;
    }
    if (article.sentiment === 'positive') positive += 1;
    else if (article.sentiment === 'negative') negative += 1;
    else if (article.sentiment === 'neutral') neutral += 1;
  }
  const baseline = deriveBaselineSignal(a);
  if (baseline === 'positive') return `최근 7일 긍정 기사 ${positive}건`;
  if (baseline === 'negative') return `최근 7일 부정 기사 ${negative}건`;
  if (positive > 0 && negative > 0) return '최근 7일 긍정·부정 기사가 섞임';
  const classified = positive + negative + neutral;
  if (classified === 0) return '최근 7일 분류된 기사 없음';
  if (positive + negative === 0) return '최근 7일 뉴스는 방향이 뚜렷하지 않음';
  return `최근 7일 분류된 기사 ${classified}건 · 판단하기에 적음`;
}

/** Card line about past cases: why there are none, or the verdict for the baseline's direction. */
export function pastCasesLine(history: ReadyCompanyHistory, horizon: Horizon, baseline: Signal, nowMs: number): string {
  if (history.status === 'stats_not_public') return STATS_NOT_PUBLIC_MESSAGE;
  if (history.status === 'no_history') return NO_HISTORY_MESSAGE;
  if (history.status === 'identity_unverified') return IDENTITY_UNVERIFIED_MESSAGE;
  if (history.status === 'price_unavailable') return PRICE_UNAVAILABLE_MESSAGE;
  const unit = horizon === 'day' ? '날' : '주';
  if (baseline !== 'positive' && baseline !== 'negative') return `과거 비슷한 ${unit}: 현재 방향이 없어 비교하지 않음`;
  const directions = history.horizons[horizon].directions;
  const verdict: Verdict = directions === null || statsAge(history.dataAsOf.computedAt, nowMs) === 'expired'
    ? 'insufficient' : directions[baseline].verdict;
  return `과거 비슷한 ${unit}: ${VERDICT_LABELS[verdict]}`;
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

/**
 * Both horizons from the analysis being shown: the day baseline is its overnight signal, the
 * week baseline the existing rule. Past cases may only lower a baseline (integrateOutlook).
 * The analysis asOf is when its articles were gathered: one made before the overnight window
 * opened (a browser reuses news for up to six hours) has not checked that window yet.
 */
export function deriveHistoryView(analysis: NewsAnalysis, history: ReadyCompanyHistory, nowMs: number): HistoryView {
  const age = statsAge(history.dataAsOf.computedAt, nowMs);
  const overnight = deriveOvernightSignal(analysis.articles, history.horizons.day.newsWindow ?? { start: 'x', end: 'y' }, analysis.asOf);
  const build = (horizon: Horizon, baseline: Signal, overnightSignal: OvernightSignal | null): HorizonView => {
    const h = history.horizons[horizon];
    const directional = baseline === 'positive' || baseline === 'negative';
    const direction = directional && h.directions !== null && age !== 'expired' ? h.directions[baseline] : null;
    const verdict: Verdict | null = !directional || h.directions === null ? null
      : age === 'expired' ? 'insufficient' : h.directions[baseline].verdict;
    const integrated = integrateOutlook(baseline, verdict ?? 'insufficient');
    return {
      horizon,
      title: horizonTitle(horizon, h.targetWindow),
      baseline,
      overnight: overnightSignal,
      direction,
      verdict,
      integrated,
      signalLabel: SIGNAL_LABELS[integrated.signal],
      validationLabel: validationBadge(h.validation, integrated.signal, analysis.company.region),
      newsLine: overnightSignal ? dayNewsLine(overnightSignal) : weekNewsLine(analysis),
      lastCheckLine: overnightSignal?.reason === 'not_checked' ? lastNewsCheckLine(analysis.asOf, targetYear(h.targetWindow)) : null,
      pastLine: pastCasesLine(history, horizon, baseline, nowMs),
      integrationLine: integrationMessage(integrated.note, horizon),
      changeLine: integrated.changed ? `기준선 ${SIGNAL_LABELS[baseline]}에서 판단 유보로 낮췄습니다.` : null,
    };
  };
  return {
    day: build('day', overnight.signal, overnight),
    week: build('week', deriveBaselineSignal(analysis), null),
    statsPublic: history.status !== 'stats_not_public',
    statsAge: age,
    partialNews: (analysis.sources ?? []).some(source => source.status === 'rate_limited' || source.status === 'error'),
  };
}

// ---------------------------------------------------------------------------
// Evidence lines (② ③ ④)
// ---------------------------------------------------------------------------

/**
 * The horizon's name in the evidence. While the target session is open the day card reads IN_SESSION_DAY_TITLE, so
 * its evidence speaks of today's session too; any other phase, or no target, keeps the horizon label.
 */
export function evidenceHorizonLabel(horizon: Horizon, target?: Pick<HorizonHistory['targetWindow'], 'phase'>): string {
  return horizon === 'day' && target?.phase === 'in_session' ? IN_SESSION_DAY_LABEL : HORIZON_LABELS[horizon];
}

/** '근거 보기 · 다음 거래일', '근거 보기 · 다음 주', or '근거 보기 · 오늘 장' during the session. */
export function evidenceTitle(horizon: Horizon, target?: Pick<HorizonHistory['targetWindow'], 'phase'>): string {
  return `${EVIDENCE_TITLE} · ${evidenceHorizonLabel(horizon, target)}`;
}

export function outlookSectionTitle(horizon: Horizon, target?: Pick<HorizonHistory['targetWindow'], 'phase'>): string {
  return `③ ${evidenceHorizonLabel(horizon, target)} 참고 전망(통합)`;
}

export function outlookSummaryLine(view: HorizonView, statsPublic: boolean): string {
  const verdict = !statsPublic ? '공개 전' : view.verdict === null ? '해당 없음' : VERDICT_LABELS[view.verdict];
  return `기준선 ${SIGNAL_LABELS[view.baseline]} · 통합 ${view.signalLabel} · 판정 ${verdict}`;
}

export function insufficientReasonLine(reason: string): string {
  return `근거 부족 이유: ${ownLabel(INSUFFICIENT_REASON_LABELS, reason) ?? reason}`;
}

/** 0.012 gives '+1.2%'; zero, -0 included, has no sign. */
export function formatReturn(r: number): string {
  const value = Math.round(r * 1000) / 10;
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
}

/** Same rule in percentage points: 0.14 gives '+14.0%p'. */
export function formatPoints(d: number): string {
  const value = Math.round(d * 1000) / 10;
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}%p`;
}

/** 0.48 gives '48%' */
export function formatShare(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** Below five cases only the count; a share needs ten non-overlapping windows (B-5). */
export function caseStatsLines(s: CaseStats): string[] {
  if (s.returns === null) return [`사례 ${s.cases}건 · 5건 미만이라 통계 없이 사례만 표시`];
  const labelled = s.up + s.neutral + s.down;
  let counts = `사례 ${s.cases}건(겹치지 않는 구간 ${s.nEff}개) · 상승 ${s.up}건 · 중립 ${s.neutral}건 · 하락 ${s.down}건`;
  if (s.nEff >= 10 && labelled > 0) counts += ` · ${HISTORY_SHARE_LABEL} ${formatShare(s.up / labelled)}`;
  const r = s.returns;
  const lines = [
    counts,
    `수익률 중앙값 ${formatReturn(r.median)} · 가운데 50% ${formatReturn(r.q1)} ~ ${formatReturn(r.q3)} · 최소 ${formatReturn(r.min)} · 최대 ${formatReturn(r.max)}`,
  ];
  if (r.relativeMedian !== null) lines.push(`시장 대비 중앙값 ${formatReturn(r.relativeMedian)}`);
  if (s.period !== null) lines.push(`분석 기간 ${s.period.from} ~ ${s.period.to}`);
  if (s.allWindows !== null) {
    lines.push(`같은 기간 이 종목 전체 구간의 과거 상승 비중 ${formatShare(s.allWindows.up)} · 하락 비중 ${formatShare(s.allWindows.down)}`);
  }
  return lines;
}

/** One line per factor topic (first three, 'other' skipped), then a note when more were left out. */
export function topicCaseLines(d: DirectionStats, factorTopics: readonly NewsTopicKey[]): string[] {
  const topics = [...new Set(factorTopics)].filter(topic => topic !== 'other' && isNewsTopicKey(topic));
  const lines = topics.slice(0, 3).map(topic => {
    const found = d.topics.find(item => item.topic === topic);
    return found ? `${newsTopicLabel(topic)} · ${caseStatsLines(found.cases)[0]}` : `${newsTopicLabel(topic)} · 같은 주제 사례 없음`;
  });
  if (topics.length > 3) lines.push('그 밖의 주제는 비교 제외');
  return lines;
}

export function caseListSummary(n: number): string {
  return `대표 사례 ${n}건`;
}

export function caseRefLine(ref: CaseRef): string {
  const line = `${ref.date} · ${ref.source} · ${ref.entryDate} ~ ${ref.exitDate} · 수익률 ${formatReturn(ref.r)}`;
  return ref.relative === null ? line : `${line} · 시장 대비 ${formatReturn(ref.relative)}`;
}

export function sampleLine(s: SampleStats): string {
  const unit = s.unit === 'week' ? '주' : '일';
  return `사건 ${unit} ${s.eventUnits}개 · 나머지 ${unit} ${s.otherUnits}개 · 시장 대비 상승 비중 차이 ${formatPoints(s.difference)}` +
    ` · 90% 구간 ${formatPoints(s.ci90[0])} ~ ${formatPoints(s.ci90[1])} · 기간 ${s.from} ~ ${s.to}`;
}

/** The sessions the horizon's outlook is about, by exchange-local dates. */
export function targetLine(horizon: Horizon, target: HorizonHistory['targetWindow']): string {
  const exchange = ownLabel(EXCHANGE_LABELS, target.exchange) ?? target.exchange;
  const line = horizon === 'day'
    ? `대상: ${formatSessionDate(target.start)} ${exchange} 종가(전일 종가 대비)`
    : `대상: ${formatSessionDate(target.start)}~${formatSessionDate(target.end)} ${exchange} 5거래일 · 화면 아래 '다음 주 참고 기간'과 다름`;
  return target.basis === 'weekdays_only' ? `${line} · ${WEEKDAYS_ONLY_NOTE}` : line;
}

export function overnightEvidenceLine(s: OvernightSignal): string {
  return `밤사이 기사 근거 수준: ${OVERNIGHT_EVIDENCE_LABELS[s.evidence]}`;
}

export function coverageLine(c: HistoryCoverage): string {
  return `기사 ${c.articles}건 · 사건 ${c.events}개 · 판정 표본 ${c.usable}개 · 관측 공백 ${c.observationGaps}개`;
}

/** One line per positive count, in the record's key order; an unknown prefix or reason prints the raw key. */
export function excludedLines(excluded: Record<string, number>): string[] {
  const prefixes = Object.keys(EXCLUSION_PREFIX_LABELS) as Array<keyof typeof EXCLUSION_PREFIX_LABELS>;
  const lines: string[] = [];
  for (const [key, n] of Object.entries(excluded)) {
    if (!(n > 0)) continue;
    const prefix = prefixes.find(item => key.startsWith(item));
    const label = prefix ? ownLabel(EXCLUSION_LABELS, key.slice(prefix.length)) : undefined;
    lines.push(prefix && label ? `${EXCLUSION_PREFIX_LABELS[prefix]} 제외 · ${label} ${n}건` : `${key} ${n}건`);
  }
  return lines;
}

export function sourcesLine(s: HistorySources): string {
  const price = s.price ? `${s.price.label}(${ADJUSTMENT_LABELS[s.price.adjustment]})` : '없음';
  return `출처: 뉴스 ${s.news.join(', ') || '없음'} · 가격 ${price}`;
}
