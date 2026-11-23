import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as view from './news-history-view.ts';
import {
  caseListSummary, caseRefLine, caseStatsLines, coverageLine, dayNewsLine, deriveHistoryView, excludedLines, formatPoints, formatReturn,
  formatSessionDate, formatShare, horizonTitle, insufficientReasonLine, outlookSectionTitle, outlookSummaryLine, overnightEvidenceLine,
  pastCasesLine, sampleLine, sourcesLine, statsAge, targetLine, topicCaseLines, weekNewsLine,
  IN_SESSION_DAY_TITLE, STATS_EXPIRED_AFTER_MS, STATS_OLD_AFTER_MS,
  type HistoryView, type HorizonView, type ReadyCompanyHistory,
} from './news-history-view.ts';
import {
  deriveOvernightSignal, integrationMessage, parseCompanyHistory, HISTORY_SHARE_LABEL, IDENTITY_UNVERIFIED_MESSAGE, NEUTRAL_OVERNIGHT_NEWS_MESSAGE,
  NO_HISTORY_MESSAGE, NO_OVERNIGHT_NEWS_MESSAGE, PRICE_UNAVAILABLE_MESSAGE, STATS_NOT_PUBLIC_MESSAGE, VALIDATION_BADGES,
  type CaseStats, type DirectionStats, type Horizon, type HorizonHistory, type Verdict,
} from './news-history.ts';
import * as core from './index.ts';
import { COMPANIES, type CompanyHistory, type NewsAnalysis, type NewsArticle, type NewsTopicKey } from './index.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-11-23T14:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const COMPANY = COMPANIES.find(item => item.id === 'krx:000660')!;
/** Inside the day window below (06:30Z to the next 00:00Z) and the analysis's seven-day window. */
const OVERNIGHT = '2026-11-23T12:00:00.000Z';

let articleCount = 0;
function article(publishedAt: string, sentiment: NewsArticle['sentiment'], extra: Partial<NewsArticle> = {}): NewsArticle {
  articleCount += 1;
  return {
    id: `a${articleCount}`, title: `테스트 기사 ${articleCount}`, source: 'example.com', publishedAt, url: `https://example.com/${articleCount}`,
    sentiment, rationale: '테스트 근거', ...extra,
  };
}

function analysis(overrides: Partial<NewsAnalysis> = {}): NewsAnalysis {
  return {
    company: COMPANY, status: 'ready', articles: [], asOf: '2026-11-23T13:00:00.000Z', period: { start: '2026-11-16', end: '2026-11-23' },
    evidence: 'low', summary: '요약', positiveFactors: [], negativeFactors: [], risks: [], provider: 'Marketaux', analysisVersion: 'test',
    newsWindow: { start: '2026-11-16T13:00:00.000Z', end: '2026-11-23T13:00:00.000Z' },
    ...overrides,
  };
}

const caseStats = (overrides: Partial<CaseStats> = {}): CaseStats => ({
  cases: 12, nEff: 10, up: 6, neutral: 2, down: 4,
  returns: { median: 0.012, q1: -0.01, q3: 0.03, min: -0.05, max: 0.08, relativeMedian: 0.004 },
  period: { from: '2025-01-02', to: '2026-11-20' }, entryType: 'close', allWindows: { up: 0.48, down: 0.42 },
  ...overrides,
});

function directionStats(verdict: Verdict, unit: Horizon): DirectionStats {
  return {
    verdict,
    ...(verdict === 'insufficient' ? { reason: 'few_event_units' } : {}),
    sample: {
      unit, eventUnits: 24, otherUnits: 180, eventUp: 14, eventDown: 8, eventNeutral: 2, otherUp: 80, otherDown: 85, otherNeutral: 15,
      difference: 0.14, ci90: [0.02, 0.26], from: '2025-01-02', to: '2026-11-20',
    },
    all: caseStats(),
    topics: [{ topic: 'earnings', cases: caseStats() }],
    examples: [{
      date: '2026-10-01', source: 'Example News', url: 'https://example.com/a', title: 'Example', entryDate: '2026-10-01', exitDate: '2026-10-02',
      r: 0.021, relative: 0.008,
    }],
  };
}

interface Fixture {
  status?: ReadyCompanyHistory['status'];
  verdict?: Verdict;
  computedAt?: string;
  phase?: HorizonHistory['targetWindow']['phase'];
  dayNewsWindow?: HorizonHistory['newsWindow'];
  validation?: HorizonHistory['validation'];
}

/** A /api/news/history value as the server sends it, through the contract parser. */
function history(f: Fixture = {}): ReadyCompanyHistory {
  const status = f.status ?? 'ready';
  const withStats = status === 'ready';
  const horizon = (h: Horizon) => ({
    validation: f.validation ?? { status: 'not_evaluated', directions: [], markets: [], evaluatedAt: null },
    targetWindow: {
      start: '2026-11-24', end: h === 'day' ? '2026-11-24' : '2026-11-30', basis: 'exchange_calendar', exchange: 'KRX',
      phase: f.phase ?? 'after_close',
    },
    newsWindow: h === 'day' ? (f.dayNewsWindow === undefined ? { start: '2026-11-23T06:30:00.000Z', end: '2026-11-24T00:00:00.000Z' } : f.dayNewsWindow) : null,
    directions: withStats ? { positive: directionStats(f.verdict ?? 'supports', h), negative: directionStats(f.verdict ?? 'supports', h) } : null,
    ...(withStats ? { sampleOrigin: { backfillUnits: 0, includesBackfill: false, pointInTimeGuaranteed: true } } : {}),
  });
  const parsed = parseCompanyHistory({
    version: 'news-history-v1', companyId: COMPANY.id, status,
    horizons: { day: horizon('day'), week: horizon('week') },
    coverage: withStats
      ? { articles: 120, events: 40, usable: 90, excluded: { week_overlap: 2, case_recent: 3, day_price_gap: 1 }, observationGaps: 1 }
      : { articles: 0, events: 0, usable: 0, excluded: {}, observationGaps: 0 },
    dataAsOf: {
      computedAt: f.computedAt ?? iso(NOW - HOUR), lastPriceDate: '2026-11-20', ledgerFrom: '2025-01-02T00:00:00.000Z', ledgerTo: '2026-11-23T00:00:00.000Z',
    },
    sources: { news: ['Marketaux', 'GDELT'], price: { label: '금융위원회 주식시세', adjustment: 'raw' } },
  });
  if (!parsed || parsed.status === 'off' || parsed.status === 'unavailable') throw new Error('fixture does not parse');
  return parsed;
}

const twoPositive = () => [article(OVERNIGHT, 'positive'), article('2026-11-23T12:30:00.000Z', 'positive')];

// --- dates, titles and ages ---------------------------------------------------

test('session dates show month/day and the weekday without leading zeros; anything else comes back unchanged', () => {
  assert.equal(formatSessionDate('2026-11-24'), '11/24(화)');
  assert.equal(formatSessionDate('2026-11-30'), '11/30(월)');
  assert.equal(formatSessionDate('2026-01-04'), '1/4(일)');
  assert.equal(formatSessionDate('2027-01-02'), '1/2(토)');
  for (const bad of ['', 'tomorrow', '2026/11/24', '2026-11-24T00:00:00Z', '2026-1-4', '2026-02-30', '2026-13-01', ' 2026-11-24']) {
    assert.equal(formatSessionDate(bad), bad, JSON.stringify(bad));
  }
});

test('horizon titles: the next trading day, the five-session week, and the in-session day title', () => {
  const day = history().horizons.day.targetWindow;
  const week = history().horizons.week.targetWindow;
  assert.equal(horizonTitle('day', day), '다음 거래일 · 11/24(화)');
  assert.equal(horizonTitle('week', week), '다음 주 · 11/24(화)~11/30(월)');
  assert.equal(horizonTitle('day', { ...day, phase: 'before_open' }), '다음 거래일 · 11/24(화)');
  assert.equal(horizonTitle('day', { ...day, phase: 'in_session' }), IN_SESSION_DAY_TITLE);
  assert.equal(IN_SESSION_DAY_TITLE, '오늘 장 전망 · 장 시작 전 기준');
  // The week keeps its dates during the session.
  assert.equal(horizonTitle('week', { ...week, phase: 'in_session' }), '다음 주 · 11/24(화)~11/30(월)');
});

test('stats age: 72 h is still fresh, 72 h + 1 ms is old, 14 days + 1 ms is expired, and garbage is expired', () => {
  const computed = '2026-11-20T00:00:00.000Z';
  const base = Date.parse(computed);
  assert.equal(statsAge(computed, base), 'fresh');
  assert.equal(statsAge(computed, base - DAY), 'fresh', 'a clock behind the server');
  assert.equal(statsAge(computed, base + STATS_OLD_AFTER_MS), 'fresh');
  assert.equal(statsAge(computed, base + STATS_OLD_AFTER_MS + 1), 'old');
  assert.equal(statsAge(computed, base + STATS_EXPIRED_AFTER_MS), 'old');
  assert.equal(statsAge(computed, base + STATS_EXPIRED_AFTER_MS + 1), 'expired');
  assert.equal(STATS_OLD_AFTER_MS, 72 * HOUR);
  assert.equal(STATS_EXPIRED_AFTER_MS, 14 * DAY);
  for (const bad of ['', 'yesterday', '2026-13-40T00:00:00Z']) assert.equal(statsAge(bad, base), 'expired', bad);
  assert.equal(statsAge(computed, Number.NaN), 'expired');
});

// --- card lines -----------------------------------------------------------------

test('day news line: no overnight news and all-neutral news say why the day is withheld; others count articles', () => {
  const window = history().horizons.day.newsWindow!;
  const none = deriveOvernightSignal([], window);
  const neutral = deriveOvernightSignal([article(OVERNIGHT, 'neutral'), article(OVERNIGHT, 'neutral')], window);
  assert.equal(dayNewsLine(none), NO_OVERNIGHT_NEWS_MESSAGE);
  assert.equal(dayNewsLine(none), '판단 유보 · 밤사이 새 뉴스 없음');
  assert.equal(dayNewsLine(neutral), NEUTRAL_OVERNIGHT_NEWS_MESSAGE);
  assert.equal(dayNewsLine(neutral), '판단 유보 · 밤사이 뉴스는 방향이 뚜렷하지 않음');
  assert.equal(dayNewsLine(deriveOvernightSignal(twoPositive(), window)), '밤사이 긍정 기사 2건');
  assert.equal(dayNewsLine(deriveOvernightSignal([article(OVERNIGHT, 'negative')], window)), '밤사이 부정 기사 1건');
  assert.equal(dayNewsLine(deriveOvernightSignal([article(OVERNIGHT, 'negative'), article(OVERNIGHT, 'positive')], window)), '밤사이 긍정·부정 기사가 섞임');
  // An unclassified article could have had a direction: it stays "no news", as the step-2 rule pins.
  assert.equal(dayNewsLine(deriveOvernightSignal([article(OVERNIGHT, 'neutral'), article(OVERNIGHT, 'unclassified')], window)), NO_OVERNIGHT_NEWS_MESSAGE);
});

test('week news line: every branch, counting related articles inside the analysis window only', () => {
  const inside = '2026-11-20T00:00:00.000Z';
  const outside = '2026-11-10T00:00:00.000Z';
  const unrelated = { aiRelevance: 'unrelated' as const };
  const positive = analysis({
    positiveFactors: ['실적'],
    articles: [article(inside, 'positive'), article(inside, 'positive'), article(outside, 'positive'), article(inside, 'positive', unrelated), article(inside, 'neutral')],
  });
  assert.equal(weekNewsLine(positive), '최근 7일 긍정 기사 2건');
  assert.equal(weekNewsLine(analysis({ negativeFactors: ['규제'], articles: [article(inside, 'negative'), article(inside, 'positive', unrelated)] })), '최근 7일 부정 기사 1건');
  assert.equal(weekNewsLine(analysis({
    positiveFactors: ['실적'], negativeFactors: ['규제'], articles: [article(inside, 'positive'), article(inside, 'negative')],
  })), '최근 7일 긍정·부정 기사가 섞임');
  assert.equal(weekNewsLine(analysis()), '최근 7일 분류된 기사 없음');
  assert.equal(weekNewsLine(analysis({ articles: [article(inside, 'unclassified'), article(outside, 'neutral'), article(inside, 'neutral', unrelated)] })), '최근 7일 분류된 기사 없음');
  assert.equal(weekNewsLine(analysis({ articles: [article(inside, 'neutral'), article(inside, 'neutral')] })), '최근 7일 뉴스는 방향이 뚜렷하지 않음');
  assert.equal(weekNewsLine(analysis({ status: 'insufficient', articles: [article(inside, 'positive'), article(inside, 'neutral')] })), '최근 7일 분류된 기사 2건 · 판단하기에 적음');
  // Without a window every article counts.
  assert.equal(weekNewsLine(analysis({ newsWindow: undefined, positiveFactors: ['실적'], articles: [article(inside, 'positive'), article(outside, 'positive')] })), '최근 7일 긍정 기사 2건');
  // The window edges are inclusive.
  const edges = analysis({ negativeFactors: ['규제'], articles: [article('2026-11-16T13:00:00.000Z', 'negative'), article('2026-11-23T13:00:00.000Z', 'negative')] });
  assert.equal(weekNewsLine(edges), '최근 7일 부정 기사 2건');
});

test('past-cases line: one message per status, the expired case, a withheld baseline and the verdict', () => {
  assert.equal(pastCasesLine(history({ status: 'stats_not_public' }), 'day', 'positive', NOW), STATS_NOT_PUBLIC_MESSAGE);
  assert.equal(pastCasesLine(history({ status: 'no_history' }), 'week', 'positive', NOW), NO_HISTORY_MESSAGE);
  assert.equal(pastCasesLine(history({ status: 'identity_unverified' }), 'day', 'negative', NOW), IDENTITY_UNVERIFIED_MESSAGE);
  assert.equal(pastCasesLine(history({ status: 'price_unavailable' }), 'week', 'withheld', NOW), PRICE_UNAVAILABLE_MESSAGE);
  assert.equal(pastCasesLine(history(), 'day', 'withheld', NOW), '과거 비슷한 날: 현재 방향이 없어 비교하지 않음');
  assert.equal(pastCasesLine(history(), 'week', 'withheld', NOW), '과거 비슷한 주: 현재 방향이 없어 비교하지 않음');
  assert.equal(pastCasesLine(history(), 'day', 'positive', NOW), '과거 비슷한 날: 지지');
  assert.equal(pastCasesLine(history({ verdict: 'contradicts' }), 'week', 'negative', NOW), '과거 비슷한 주: 상충');
  assert.equal(pastCasesLine(history({ verdict: 'no_clear_difference' }), 'week', 'positive', NOW), '과거 비슷한 주: 뚜렷한 차이 없음');
  const expired = history({ computedAt: iso(NOW - STATS_EXPIRED_AFTER_MS - 1) });
  assert.equal(pastCasesLine(expired, 'day', 'positive', NOW), '과거 비슷한 날: 근거 부족');
  assert.equal(pastCasesLine(history({ computedAt: iso(NOW - 4 * DAY) }), 'day', 'positive', NOW), '과거 비슷한 날: 지지', 'old statistics are still used');
});

// --- the view -------------------------------------------------------------------

test('history view: both horizons from the analysis on screen, verdicts that support keep the baseline', () => {
  const a = analysis({ positiveFactors: ['실적 개선'], articles: twoPositive() });
  const h = history();
  const v: HistoryView = deriveHistoryView(a, h, NOW);
  assert.equal(v.statsPublic, true);
  assert.equal(v.statsAge, 'fresh');
  assert.equal(v.partialNews, false);
  const day: HorizonView = v.day;
  assert.equal(day.horizon, 'day');
  assert.equal(day.title, '다음 거래일 · 11/24(화)');
  assert.equal(day.baseline, 'positive');
  assert.deepEqual(day.overnight, { signal: 'positive', reason: 'one_direction', evidence: 'moderate', counts: { positive: 2, negative: 0, neutral: 0, ignored: 0 } });
  assert.equal(day.direction, h.horizons.day.directions!.positive);
  assert.equal(day.verdict, 'supports');
  assert.deepEqual(day.integrated, { signal: 'positive', changed: false, note: 'supports' });
  assert.equal(day.signalLabel, '상승 전망');
  assert.equal(day.validationLabel, '검증 전 · 참고 정보');
  assert.equal(day.newsLine, '밤사이 긍정 기사 2건');
  assert.equal(day.pastLine, '과거 비슷한 날: 지지');
  assert.equal(day.integrationLine, integrationMessage('supports', 'day'));
  assert.equal(day.changeLine, null);
  assert.equal(v.week.title, '다음 주 · 11/24(화)~11/30(월)');
  assert.equal(v.week.overnight, null);
  assert.equal(v.week.baseline, 'positive');
  assert.equal(v.week.direction, h.horizons.week.directions!.positive);
  assert.equal(v.week.newsLine, '최근 7일 긍정 기사 2건');
  assert.equal(v.week.pastLine, '과거 비슷한 주: 지지');
  assert.equal(v.week.integrationLine, integrationMessage('supports', 'week'));
  assert.equal(outlookSummaryLine(day, v.statsPublic), '기준선 상승 전망 · 통합 상승 전망 · 판정 지지');
});

test('history view: contradicts lowers the baseline to withheld and says so; the change line names the baseline', () => {
  const v = deriveHistoryView(analysis({ negativeFactors: ['규제'], articles: twoPositive() }), history({ verdict: 'contradicts' }), NOW);
  assert.deepEqual(v.day.integrated, { signal: 'withheld', changed: true, note: 'contradicts' });
  assert.equal(v.day.signalLabel, '판단 유보');
  assert.equal(v.day.changeLine, '기준선 상승 전망에서 판단 유보로 낮췄습니다.');
  assert.equal(v.day.integrationLine, integrationMessage('contradicts', 'day'));
  assert.equal(v.day.pastLine, '과거 비슷한 날: 상충');
  assert.equal(v.week.baseline, 'negative');
  assert.equal(v.week.changeLine, '기준선 하락 전망에서 판단 유보로 낮췄습니다.');
  assert.equal(outlookSummaryLine(v.week, true), '기준선 하락 전망 · 통합 판단 유보 · 판정 상충');
  // Weakens and no clear difference keep the baseline; only the text differs.
  for (const verdict of ['weakens', 'no_clear_difference', 'insufficient'] as const) {
    const kept = deriveHistoryView(analysis({ articles: twoPositive() }), history({ verdict }), NOW).day;
    assert.deepEqual([kept.integrated.signal, kept.changeLine], ['positive', null], verdict);
  }
});

test('history view: a market whose statistics are not public keeps the news signal and shows no verdict', () => {
  const v = deriveHistoryView(analysis({ positiveFactors: ['실적'], articles: twoPositive() }), history({ status: 'stats_not_public' }), NOW);
  assert.equal(v.statsPublic, false);
  for (const h of [v.day, v.week]) {
    assert.equal(h.verdict, null);
    assert.equal(h.direction, null);
    assert.equal(h.integrated.signal, h.baseline);
    assert.equal(h.integrated.signal, 'positive');
    assert.equal(h.validationLabel, '검증 전 · 참고 정보');
    assert.equal(h.pastLine, STATS_NOT_PUBLIC_MESSAGE);
    assert.equal(h.changeLine, null);
  }
  assert.equal(outlookSummaryLine(v.day, v.statsPublic), '기준선 상승 전망 · 통합 상승 전망 · 판정 공개 전');
  // The other statuses without statistics: no verdict, the baseline stays.
  for (const status of ['no_history', 'identity_unverified', 'price_unavailable'] as const) {
    const other = deriveHistoryView(analysis({ articles: twoPositive() }), history({ status }), NOW);
    assert.deepEqual([other.statsPublic, other.day.verdict, other.day.integrated.signal], [true, null, 'positive'], status);
    assert.equal(outlookSummaryLine(other.day, other.statsPublic), '기준선 상승 전망 · 통합 상승 전망 · 판정 해당 없음', status);
  }
});

test('history view: expired statistics are not used, old ones are; a withheld baseline compares nothing', () => {
  const a = analysis({ articles: twoPositive() });
  const expired = deriveHistoryView(a, history({ verdict: 'contradicts', computedAt: iso(NOW - STATS_EXPIRED_AFTER_MS - 1) }), NOW);
  assert.equal(expired.statsAge, 'expired');
  assert.equal(expired.day.verdict, 'insufficient');
  assert.equal(expired.day.direction, null);
  assert.deepEqual(expired.day.integrated, { signal: 'positive', changed: false, note: 'insufficient' });
  assert.equal(expired.day.pastLine, '과거 비슷한 날: 근거 부족');
  const old = deriveHistoryView(a, history({ verdict: 'contradicts', computedAt: iso(NOW - 4 * DAY) }), NOW);
  assert.equal(old.statsAge, 'old');
  assert.equal(old.day.verdict, 'contradicts');
  const withheld = deriveHistoryView(analysis(), history(), NOW);
  assert.equal(withheld.day.baseline, 'withheld');
  assert.equal(withheld.day.overnight!.reason, 'no_overnight_news');
  assert.equal(withheld.day.newsLine, NO_OVERNIGHT_NEWS_MESSAGE);
  assert.equal(withheld.day.verdict, null);
  assert.equal(withheld.day.direction, null);
  assert.deepEqual(withheld.day.integrated, { signal: 'withheld', changed: false, note: 'baseline_withheld' });
  assert.equal(withheld.day.pastLine, '과거 비슷한 날: 현재 방향이 없어 비교하지 않음');
  assert.equal(outlookSummaryLine(withheld.day, true), '기준선 판단 유보 · 통합 판단 유보 · 판정 해당 없음');
  assert.equal(withheld.week.newsLine, '최근 7일 분류된 기사 없음');
});

test('history view: neutral-only overnight news, a missing day window and the in-session title', () => {
  const neutral = deriveHistoryView(analysis({ articles: [article(OVERNIGHT, 'neutral'), article(OVERNIGHT, 'neutral')] }), history(), NOW);
  assert.equal(neutral.day.overnight!.reason, 'all_neutral');
  assert.equal(neutral.day.newsLine, '판단 유보 · 밤사이 뉴스는 방향이 뚜렷하지 않음');
  assert.equal(neutral.day.signalLabel, '판단 유보');
  const noWindow = deriveHistoryView(analysis({ articles: twoPositive() }), history({ dayNewsWindow: null }), NOW);
  assert.deepEqual([noWindow.day.baseline, noWindow.day.overnight!.reason], ['withheld', 'no_overnight_news']);
  const inSession = deriveHistoryView(analysis(), history({ phase: 'in_session' }), NOW);
  assert.equal(inSession.day.title, '오늘 장 전망 · 장 시작 전 기준');
});

test('history view: partial news is a rate-limited or failed source, never a skipped one', () => {
  const source = (status: NonNullable<NewsAnalysis['sources']>[number]['status']) => [
    { id: 'marketaux', label: 'Marketaux', status: 'ok' as const, articleCount: 3 }, { id: 'gdelt', label: 'GDELT', status, articleCount: 0 },
  ];
  const partial = (sources: NewsAnalysis['sources']) => deriveHistoryView(analysis({ sources }), history(), NOW).partialNews;
  assert.equal(partial(source('rate_limited')), true);
  assert.equal(partial(source('error')), true);
  assert.equal(partial(source('skipped')), false);
  assert.equal(partial(source('empty')), false);
  assert.equal(partial(source('not_configured')), false);
  assert.equal(partial(undefined), false);
});

test('history view: the badge reads the integrated signal and the company market', () => {
  const validation = { status: 'improvement_observed' as const, directions: ['positive' as const], markets: ['KR'], evaluatedAt: '2026-11-01T00:00:00Z' };
  const supported = deriveHistoryView(analysis({ articles: twoPositive() }), history({ validation }), NOW);
  assert.equal(supported.day.validationLabel, VALIDATION_BADGES.improvement_observed);
  const lowered = deriveHistoryView(analysis({ articles: twoPositive() }), history({ validation, verdict: 'contradicts' }), NOW);
  assert.equal(lowered.day.validationLabel, VALIDATION_BADGES.not_evaluated, 'withheld is outside every evaluated direction');
  const us = deriveHistoryView(analysis({ company: COMPANIES.find(item => item.region === 'US')!, articles: twoPositive() }), history({ validation }), NOW);
  assert.equal(us.day.validationLabel, VALIDATION_BADGES.not_evaluated);
});

// --- evidence lines ---------------------------------------------------------------

test('number formats: one decimal, a plus sign only above zero, -0 without a sign', () => {
  assert.equal(formatReturn(0.012), '+1.2%');
  assert.equal(formatReturn(-0.012), '-1.2%');
  assert.equal(formatReturn(0), '0.0%');
  assert.equal(formatReturn(-0), '0.0%');
  assert.equal(formatReturn(-0.0004), '0.0%');
  assert.equal(formatReturn(0.0004), '0.0%');
  assert.equal(formatReturn(0.021), '+2.1%');
  assert.equal(formatReturn(1.5), '+150.0%');
  assert.equal(formatReturn(-1), '-100.0%');
  assert.equal(formatPoints(0.14), '+14.0%p');
  assert.equal(formatPoints(-0.02), '-2.0%p');
  assert.equal(formatPoints(0), '0.0%p');
  assert.equal(formatPoints(-0.0001), '0.0%p');
  assert.equal(formatShare(0.48), '48%');
  assert.equal(formatShare(0), '0%');
  assert.equal(formatShare(1), '100%');
});

test('case statistics: below five cases only the count, a share from ten non-overlapping windows', () => {
  assert.deepEqual(caseStatsLines(caseStats({ cases: 3, nEff: 3, up: 2, neutral: 0, down: 1, returns: null, allWindows: null })),
    ['사례 3건 · 5건 미만이라 통계 없이 사례만 표시']);
  assert.deepEqual(caseStatsLines(caseStats()), [
    `사례 12건(겹치지 않는 구간 10개) · 상승 6건 · 중립 2건 · 하락 4건 · ${HISTORY_SHARE_LABEL} 50%`,
    '수익률 중앙값 +1.2% · 가운데 50% -1.0% ~ +3.0% · 최소 -5.0% · 최대 +8.0%',
    '시장 대비 중앙값 +0.4%',
    '분석 기간 2025-01-02 ~ 2026-11-20',
    '같은 기간 이 종목 전체 구간의 과거 상승 비중 48% · 하락 비중 42%',
  ]);
  assert.equal(caseStatsLines(caseStats({ nEff: 9 }))[0], '사례 12건(겹치지 않는 구간 9개) · 상승 6건 · 중립 2건 · 하락 4건');
  assert.equal(caseStatsLines(caseStats({ nEff: 10, up: 0, neutral: 0, down: 0 }))[0], '사례 12건(겹치지 않는 구간 10개) · 상승 0건 · 중립 0건 · 하락 0건');
  const bare = caseStats({ returns: { median: 0, q1: 0, q3: 0, min: 0, max: 0, relativeMedian: null }, period: null, allWindows: null });
  assert.deepEqual(caseStatsLines(bare).slice(1), ['수익률 중앙값 0.0% · 가운데 50% 0.0% ~ 0.0% · 최소 0.0% · 최대 0.0%']);
});

test('topic lines: factor topics in order, unique, without other, three at most', () => {
  const d = directionStats('supports', 'week');
  const first = `실적·가이던스 · ${caseStatsLines(caseStats())[0]}`;
  assert.deepEqual(topicCaseLines(d, ['earnings', 'other', 'earnings', 'analyst']), [first, '증권가 평가 · 같은 주제 사례 없음']);
  assert.deepEqual(topicCaseLines(d, ['analyst', 'regulation', 'earnings', 'product', 'demand']),
    ['증권가 평가 · 같은 주제 사례 없음', '규제·법률 · 같은 주제 사례 없음', first, '그 밖의 주제는 비교 제외']);
  assert.deepEqual(topicCaseLines(d, ['analyst', 'regulation', 'earnings', 'other']).length, 3);
  assert.deepEqual(topicCaseLines(d, []), []);
  assert.deepEqual(topicCaseLines(d, ['other']), []);
  assert.deepEqual(topicCaseLines(d, ['weather' as NewsTopicKey, 'earnings']), [first], 'a key outside the fixed list is skipped, never thrown on');
});

test('case, sample, target, evidence and coverage lines', () => {
  const ref = directionStats('supports', 'day').examples[0]!;
  assert.equal(caseListSummary(5), '대표 사례 5건');
  assert.equal(caseRefLine(ref), '2026-10-01 · Example News · 2026-10-01 ~ 2026-10-02 · 수익률 +2.1% · 시장 대비 +0.8%');
  assert.equal(caseRefLine({ ...ref, relative: null }), '2026-10-01 · Example News · 2026-10-01 ~ 2026-10-02 · 수익률 +2.1%');
  assert.equal(sampleLine(directionStats('supports', 'day').sample!),
    '사건 일 24개 · 나머지 일 180개 · 시장 대비 상승 비중 차이 +14.0%p · 90% 구간 +2.0%p ~ +26.0%p · 기간 2025-01-02 ~ 2026-11-20');
  assert.match(sampleLine(directionStats('supports', 'week').sample!), /^사건 주 24개 · 나머지 주 180개 · /);
  const h = history();
  assert.equal(targetLine('day', h.horizons.day.targetWindow), '대상: 11/24(화) 한국거래소 종가(전일 종가 대비)');
  assert.equal(targetLine('week', h.horizons.week.targetWindow), "대상: 11/24(화)~11/30(월) 한국거래소 5거래일 · 화면 아래 '다음 주 참고 기간'과 다름");
  assert.equal(targetLine('day', { ...h.horizons.day.targetWindow, exchange: 'NASDAQ', basis: 'weekdays_only' }),
    '대상: 11/24(화) 나스닥 종가(전일 종가 대비) · 휴장일 미반영(평일 기준)');
  assert.equal(targetLine('day', { ...h.horizons.day.targetWindow, exchange: 'NYSE' }), '대상: 11/24(화) NYSE 종가(전일 종가 대비)');
  assert.equal(targetLine('day', { ...h.horizons.day.targetWindow, exchange: 'constructor' }), '대상: 11/24(화) constructor 종가(전일 종가 대비)');
  const window = h.horizons.day.newsWindow!;
  assert.equal(overnightEvidenceLine(deriveOvernightSignal([], window)), '밤사이 기사 근거 수준: 없음');
  assert.equal(overnightEvidenceLine(deriveOvernightSignal([article(OVERNIGHT, 'positive')], window)), '밤사이 기사 근거 수준: 낮음');
  assert.equal(overnightEvidenceLine(deriveOvernightSignal(twoPositive(), window)), '밤사이 기사 근거 수준: 보통');
  assert.equal(coverageLine(h.coverage), '기사 120건 · 사건 40개 · 판정 표본 90개 · 관측 공백 1개');
  assert.equal(outlookSectionTitle('day'), '③ 다음 거래일 참고 전망(통합)');
  assert.equal(outlookSectionTitle('week'), '③ 다음 주 참고 전망(통합)');
  assert.equal(insufficientReasonLine('few_event_units'), '근거 부족 이유: 사건 표본 20개 미만');
  assert.equal(insufficientReasonLine('stats_stale'), '근거 부족 이유: 통계가 오래됨');
  assert.equal(insufficientReasonLine('a_new_reason'), '근거 부족 이유: a_new_reason');
  assert.equal(insufficientReasonLine('constructor'), '근거 부족 이유: constructor');
});

test('exclusion and source lines: labels by prefix and reason, raw keys otherwise, zero counts left out', () => {
  assert.deepEqual(excludedLines({
    week_overlap: 2, case_recent: 3, day_price_gap: 1, day_pending: 0, week_mystery: 4, other_key: 5, day_constructor: 1, case_not_overnight: 2,
  }), [
    '다음 주 제외 · 겹치는 구간 2건', '사례 제외 · 현재 기사 기간과 겹침 3건', '다음 거래일 제외 · 가격 공백 1건', 'week_mystery 4건', 'other_key 5건',
    'day_constructor 1건', '사례 제외 · 밤사이 기사 아님 2건',
  ]);
  assert.deepEqual(excludedLines({}), []);
  assert.equal(sourcesLine({ news: ['Marketaux', 'GDELT'], price: { label: '금융위원회 주식시세', adjustment: 'raw' } }),
    '출처: 뉴스 Marketaux, GDELT · 가격 금융위원회 주식시세(미조정 가격)');
  assert.equal(sourcesLine({ news: ['Marketaux'], price: { label: 'Massive(구 Polygon) 일봉', adjustment: 'split' } }),
    '출처: 뉴스 Marketaux · 가격 Massive(구 Polygon) 일봉(분할 반영)');
  assert.equal(sourcesLine({ news: [], price: null }), '출처: 뉴스 없음 · 가격 없음');
});

// --- the public surface and wording -------------------------------------------------

test('the core entry re-exports every name the web screen imports', () => {
  const names = [
    'parseCompanyHistory', 'deriveHistoryView', 'HISTORY_SECTION_TITLE', 'EVIDENCE_TITLE', 'CASES_SECTION_TITLE', 'BASIS_SECTION_TITLE',
    'outlookSectionTitle', 'HISTORY_LOADING_MESSAGE', 'HISTORY_UNAVAILABLE_MESSAGE', 'HISTORY_RETRY_LABEL', 'DIFFERENT_HORIZONS_NOTE',
    'HISTORY_DISCLAIMER', 'STATS_NOT_PUBLIC_MESSAGE', 'NO_HISTORY_MESSAGE', 'IDENTITY_UNVERIFIED_MESSAGE', 'PRICE_UNAVAILABLE_MESSAGE',
    'EXPIRED_STATS_MESSAGE', 'STALE_STATS_LABEL', 'PARTIAL_NEWS_NOTE', 'BACKFILL_SAMPLE_NOTE', 'CASE_DIRECTION_TITLES', 'CASE_WINDOW_NOTES',
    'CASE_BASIS_NOTE', 'RESULT_DEFINITIONS', 'MARKETAUX_TOP_NOTE', 'GDELT_CREDIT', 'NEWS_WINDOW_LABEL', 'HORIZON_LABELS', 'caseStatsLines',
    'topicCaseLines', 'caseListSummary', 'caseRefLine', 'sampleLine', 'targetLine', 'overnightEvidenceLine', 'outlookSummaryLine',
    'insufficientReasonLine', 'coverageLine', 'excludedLines', 'sourcesLine', 'NEUTRAL_OVERNIGHT_NEWS_MESSAGE', 'NO_OVERNIGHT_NEWS_MESSAGE',
  ];
  const entry = core as unknown as Record<string, unknown>;
  for (const name of names) assert.notEqual(entry[name], undefined, name);
  for (const [name, value] of Object.entries(view)) assert.equal(entry[name], value, `${name} is re-exported unchanged`);
  // Type-level: the names the screen uses compile against the entry.
  const parsed: CompanyHistory | null = core.parseCompanyHistory(null);
  const typed: core.ReadyCompanyHistory | null = parsed && parsed.status !== 'off' && parsed.status !== 'unavailable' ? parsed : null;
  const views: Array<core.HistoryView | core.HorizonView | core.Horizon> = [];
  assert.equal(typed, null);
  assert.deepEqual(views, []);
  assert.equal(view.HISTORY_SECTION_TITLE, '전망 한눈에 보기');
  assert.equal(view.HISTORY_LOADING_MESSAGE, '두 기간 전망을 준비하고 있습니다');
  assert.equal(view.HISTORY_RETRY_LABEL, '과거 사례 다시 불러오기');
  assert.equal(view.EXPIRED_STATS_MESSAGE, '오래된 통계 · 계산한 지 14일이 지나 쓰지 않습니다');
});

// The same lists as news-history.test.ts: certainty, hit rate or probability, and trade advice never appear.
const FORBIDDEN = ['오릅니다', '내립니다', '반드시', '확정', '적중', '승률', '정확도', '확률', '우세', '매수 기회', '매도 기회', '매수·매도 기회', '추천', '권유합니다'];
// The plan's own wording names these ideas only to deny them.
const NEGATED = ['보장하지 않습니다', '권유가 아니고', '미래 확률 아님'];
const ARROWS = ['↑', '↓', '→'];

function collectText(value: unknown, out: string[]): void {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(item => collectText(item, out));
  else if (typeof value === 'object' && value !== null) Object.values(value).forEach(item => collectText(item, out));
}

test('no exported string and no function output contains a forbidden word or an arrow', () => {
  const texts: string[] = [];
  let constants = 0;
  for (const value of Object.values(view)) {
    if (typeof value === 'function') continue;
    const before = texts.length;
    collectText(value, texts);
    constants += texts.length - before;
  }
  assert.ok(constants >= 50, `exported strings: ${constants}`);
  const articleSets = [
    [], twoPositive(), [article(OVERNIGHT, 'negative')], [article(OVERNIGHT, 'positive'), article(OVERNIGHT, 'negative')],
    [article(OVERNIGHT, 'neutral')], [article(OVERNIGHT, 'unclassified')],
  ];
  const factorSets: Array<Partial<NewsAnalysis>> = [{}, { positiveFactors: ['a'] }, { negativeFactors: ['b'] }, { positiveFactors: ['a'], negativeFactors: ['b'] }];
  const statuses: ReadyCompanyHistory['status'][] = ['ready', 'no_history', 'identity_unverified', 'price_unavailable', 'stats_not_public'];
  const verdicts: Verdict[] = ['supports', 'contradicts', 'weakens', 'no_clear_difference', 'insufficient'];
  const ages = [iso(NOW - HOUR), iso(NOW - 4 * DAY), iso(NOW - 15 * DAY)];
  for (const status of statuses) {
    for (const verdict of verdicts) {
      for (const computedAt of ages) {
        const h = history({ status, verdict, computedAt });
        for (const articles of articleSets) {
          for (const factors of factorSets) {
            const v = deriveHistoryView(analysis({ articles, ...factors }), h, NOW);
            for (const item of [v.day, v.week]) {
              texts.push(item.title, item.signalLabel, item.validationLabel, item.newsLine, item.pastLine, item.integrationLine, outlookSummaryLine(item, v.statsPublic));
              if (item.changeLine) texts.push(item.changeLine);
              if (item.overnight) texts.push(overnightEvidenceLine(item.overnight));
            }
          }
        }
      }
    }
  }
  const h = history();
  for (const horizon of ['day', 'week'] as const) {
    const target = h.horizons[horizon].targetWindow;
    texts.push(outlookSectionTitle(horizon), targetLine(horizon, target), targetLine(horizon, { ...target, basis: 'weekdays_only', exchange: 'NASDAQ' }));
    texts.push(horizonTitle(horizon, { ...target, phase: 'in_session' }));
    const d = h.horizons[horizon].directions!.positive;
    texts.push(...caseStatsLines(d.all), ...topicCaseLines(d, ['earnings', 'analyst', 'regulation', 'product']), caseListSummary(d.examples.length));
    texts.push(...d.examples.map(caseRefLine), sampleLine(d.sample!));
  }
  texts.push(...caseStatsLines(caseStats({ returns: null })), ...caseStatsLines(caseStats({ nEff: 9 })));
  for (const reason of [...Object.keys(view.INSUFFICIENT_REASON_LABELS), 'unknown_reason']) texts.push(insufficientReasonLine(reason));
  texts.push(coverageLine(h.coverage), ...excludedLines({ ...Object.fromEntries(Object.keys(view.EXCLUSION_LABELS).map(key => [`day_${key}`, 1])), case_recent: 2, bogus: 1 }));
  for (const adjustment of ['raw', 'split', 'split_dividend'] as const) texts.push(sourcesLine({ news: ['Marketaux', 'GDELT'], price: { label: '가격', adjustment } }));
  texts.push(sourcesLine({ news: [], price: null }), formatSessionDate('2026-11-24'), formatReturn(-0.5), formatPoints(0.3), formatShare(0.5));
  texts.push(weekNewsLine(analysis()), statsAge('x', NOW));
  assert.ok(texts.length > 5000);
  for (const text of new Set(texts)) {
    assert.ok(text.trim().length > 0, 'no empty text');
    for (const arrow of ARROWS) assert.ok(!text.includes(arrow), `"${arrow}" in "${text}"`);
    let cleaned = text;
    for (const phrase of NEGATED) cleaned = cleaned.split(phrase).join('');
    for (const word of [...FORBIDDEN, '보장', '권유']) assert.ok(!cleaned.includes(word), `"${word}" in "${text}"`);
  }
});
