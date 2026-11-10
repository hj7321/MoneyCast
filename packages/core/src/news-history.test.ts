import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as history from './news-history.ts';
import {
  deriveBaselineSignal, deriveOvernightSignal, integrateOutlook, integrationMessage, overnightSummaryText, parseCompanyHistory,
  validationBadge, SIGNAL_LABELS, VERDICT_LABELS, VALIDATION_BADGES, HORIZON_LABELS,
  type CompanyHistory, type DirectionStats, type Horizon, type HorizonHistory, type IntegrationNote, type Signal, type Verdict,
} from './news-history.ts';

// --- integrateOutlook -------------------------------------------------------

test('integration table: only contradicts lowers a directional baseline, and it lowers it to withheld', () => {
  const rows: Array<[Signal, Verdict, Signal, boolean, IntegrationNote]> = [
    ['positive', 'supports', 'positive', false, 'supports'],
    ['negative', 'supports', 'negative', false, 'supports'],
    ['positive', 'no_clear_difference', 'positive', false, 'no_clear_difference'],
    ['negative', 'no_clear_difference', 'negative', false, 'no_clear_difference'],
    ['positive', 'weakens', 'positive', false, 'weakens'],
    ['negative', 'weakens', 'negative', false, 'weakens'],
    ['positive', 'contradicts', 'withheld', true, 'contradicts'],
    ['negative', 'contradicts', 'withheld', true, 'contradicts'],
    ['positive', 'insufficient', 'positive', false, 'insufficient'],
    ['negative', 'insufficient', 'negative', false, 'insufficient'],
  ];
  for (const [baseline, verdict, signal, changed, note] of rows) {
    assert.deepEqual(integrateOutlook(baseline, verdict), { signal, changed, note }, `${baseline} + ${verdict}`);
  }
});

test('integration table: a withheld baseline stays withheld for every verdict', () => {
  for (const verdict of ['supports', 'contradicts', 'weakens', 'no_clear_difference', 'insufficient'] as const) {
    assert.deepEqual(integrateOutlook('withheld', verdict), { signal: 'withheld', changed: false, note: 'baseline_withheld' }, verdict);
  }
});

test('integration never raises: output is the baseline or withheld, for any input including malformed ones', () => {
  const baselines = ['positive', 'negative', 'withheld'] as const;
  const verdicts = ['supports', 'contradicts', 'weakens', 'no_clear_difference', 'insufficient'] as const;
  for (const baseline of baselines) {
    for (const verdict of verdicts) {
      const out = integrateOutlook(baseline, verdict);
      assert.ok(out.signal === baseline || out.signal === 'withheld');
      assert.equal(out.changed, out.signal !== baseline);
    }
  }
  assert.deepEqual(integrateOutlook('positive', 'bogus' as Verdict), { signal: 'positive', changed: false, note: 'insufficient' });
  assert.deepEqual(integrateOutlook('bogus' as Signal, 'supports'), { signal: 'withheld', changed: false, note: 'baseline_withheld' });
});

// --- deriveBaselineSignal ---------------------------------------------------

test('baseline signal: ready with one-sided factors is directional, anything ambiguous is withheld', () => {
  const base = { status: 'ready' as const, positiveFactors: [] as string[], negativeFactors: [] as string[] };
  assert.equal(deriveBaselineSignal({ ...base, positiveFactors: ['a'] }), 'positive');
  assert.equal(deriveBaselineSignal({ ...base, negativeFactors: ['a', 'b'] }), 'negative');
  assert.equal(deriveBaselineSignal({ ...base, positiveFactors: ['a'], negativeFactors: ['b'] }), 'withheld');
  assert.equal(deriveBaselineSignal(base), 'withheld');
  for (const status of ['not_configured', 'insufficient', 'error', 'rate_limited'] as const) {
    assert.equal(deriveBaselineSignal({ ...base, status, positiveFactors: ['a'] }), 'withheld', status);
  }
});

// --- deriveOvernightSignal --------------------------------------------------

const window = { start: '2026-11-09T07:00:00.000Z', end: '2026-11-10T00:00:00.000Z' };
const at = (publishedAt: string, sentiment: 'positive' | 'negative' | 'neutral' | 'unclassified', aiRelevance?: 'unrelated') =>
  ({ publishedAt, sentiment, ...(aiRelevance ? { aiRelevance } : {}) });

test('overnight signal: the five-minute margin decides both window edges', () => {
  // Visible at start exactly: placed == start is outside (exclusive).
  assert.equal(deriveOvernightSignal([at('2026-11-09T06:55:00.000Z', 'positive')], window).signal, 'withheld');
  assert.equal(deriveOvernightSignal([at('2026-11-09T06:55:01.000Z', 'positive')], window).signal, 'positive');
  // Placed == end is inside (inclusive); one second later is outside.
  assert.equal(deriveOvernightSignal([at('2026-11-09T23:55:00.000Z', 'negative')], window).signal, 'negative');
  assert.equal(deriveOvernightSignal([at('2026-11-09T23:55:01.000Z', 'negative')], window).signal, 'withheld');
  // Published before start but placed after it counts; published before the margin does not.
  const early = deriveOvernightSignal([at('2026-11-09T06:58:00.000Z', 'positive')], window);
  assert.equal(early.counts.positive, 1);
  const late = deriveOvernightSignal([at('2026-11-09T23:58:00.000Z', 'positive')], window);
  assert.equal(late.counts.positive, 0);
});

test('overnight signal: unrelated, unclassified and neutral articles never give a direction', () => {
  const out = deriveOvernightSignal([
    at('2026-11-09T12:00:00.000Z', 'positive', 'unrelated'),
    at('2026-11-09T12:00:00.000Z', 'negative', 'unrelated'),
    at('2026-11-09T12:00:00.000Z', 'unclassified'),
    at('2026-11-09T12:00:00.000Z', 'neutral'),
  ], window);
  assert.deepEqual(out, {
    signal: 'withheld', reason: 'no_overnight_news', evidence: 'none',
    counts: { positive: 0, negative: 0, neutral: 1, ignored: 3 },
  });
});

test('overnight signal: an unrelated article does not create a conflict', () => {
  const out = deriveOvernightSignal([
    at('2026-11-09T12:00:00.000Z', 'positive'),
    at('2026-11-09T13:00:00.000Z', 'negative', 'unrelated'),
  ], window);
  assert.equal(out.signal, 'positive');
  assert.equal(out.reason, 'one_direction');
});

test('overnight signal: conflict withholds even at nine to one, with evidence capped at low', () => {
  const articles = [
    ...Array.from({ length: 9 }, () => at('2026-11-09T12:00:00.000Z', 'positive' as const)),
    at('2026-11-09T12:30:00.000Z', 'negative'),
  ];
  assert.deepEqual(deriveOvernightSignal(articles, window), {
    signal: 'withheld', reason: 'conflicting', evidence: 'low',
    counts: { positive: 9, negative: 1, neutral: 0, ignored: 0 },
  });
});

test('overnight signal: one directional article is low evidence, two or more is moderate', () => {
  const one = deriveOvernightSignal([at('2026-11-09T12:00:00.000Z', 'negative'), at('2026-11-09T12:00:00.000Z', 'neutral')], window);
  assert.deepEqual([one.signal, one.evidence], ['negative', 'low']);
  const two = deriveOvernightSignal([at('2026-11-09T12:00:00.000Z', 'positive'), at('2026-11-09T14:00:00.000Z', 'positive')], window);
  assert.deepEqual([two.signal, two.evidence, two.counts.positive], ['positive', 'moderate', 2]);
});

test('overnight signal: empty input, bad timestamps and a bad window all withhold without throwing', () => {
  assert.equal(deriveOvernightSignal([], window).reason, 'no_overnight_news');
  assert.equal(deriveOvernightSignal([at('not a date', 'positive')], window).signal, 'withheld');
  assert.equal(deriveOvernightSignal([at('2026-11-09T12:00:00.000Z', 'positive')], { start: 'x', end: 'y' }).signal, 'withheld');
  assert.equal(deriveOvernightSignal([at('2026-11-09T12:00:00.000Z', 'positive')], { start: window.end, end: window.start }).signal, 'withheld');
});

test('overnight summary text names direction and count, and the empty and conflict cases', () => {
  const day = (s: string) => at(`2026-11-09T${s}.000Z`, 'positive');
  assert.equal(overnightSummaryText(deriveOvernightSignal([day('12:00:00'), day('13:00:00')], window)), '밤사이 긍정 기사 2건');
  assert.equal(overnightSummaryText(deriveOvernightSignal([at('2026-11-09T12:00:00.000Z', 'negative')], window)), '밤사이 부정 기사 1건');
  assert.equal(overnightSummaryText(deriveOvernightSignal([], window)), '밤사이 새 뉴스 없음');
  assert.equal(
    overnightSummaryText(deriveOvernightSignal([day('12:00:00'), at('2026-11-09T12:00:00.000Z', 'negative')], window)),
    '밤사이 긍정·부정 기사가 섞임',
  );
});

// --- parseCompanyHistory ----------------------------------------------------

const caseStats = () => ({
  cases: 12, nEff: 10, up: 6, neutral: 2, down: 4,
  returns: { median: 0.01, q1: -0.02, q3: 0.03, min: -0.08, max: 0.1, relativeMedian: 0.004 },
  period: { from: '2025-01-02', to: '2026-10-30' }, entryType: 'open', allWindows: { up: 0.5, down: 0.4 },
});
const direction = (verdict: Verdict = 'supports') => ({
  verdict,
  sample: {
    unit: 'week', eventUnits: 24, otherUnits: 60, eventUp: 14, eventDown: 8, eventNeutral: 2, otherUp: 28, otherDown: 28, otherNeutral: 4,
    difference: 0.1, ci90: [0.01, 0.2], from: '2024-01-01', to: '2026-11-01',
  },
  all: caseStats(),
  topics: [{ topic: 'earnings', cases: caseStats() }],
  examples: [{
    date: '2026-05-04', source: 'Reuters', url: 'https://example.com/a', title: 'Example', entryDate: '2026-05-05', exitDate: '2026-05-11',
    r: 0.02, relative: null,
  }],
});
const horizon = (h: Horizon, withStats = true) => ({
  validation: { status: 'not_evaluated', directions: [], markets: [], evaluatedAt: null },
  targetWindow: {
    start: '2026-11-10', end: h === 'day' ? '2026-11-10' : '2026-11-16', basis: 'exchange_calendar', exchange: 'KRX', phase: 'before_open',
  },
  newsWindow: h === 'day' ? { start: '2026-11-09T06:30:00Z', end: '2026-11-10T00:00:00Z' } : null,
  directions: withStats ? { positive: direction(), negative: direction('insufficient') } : null,
});
const ready = (status = 'ready', withStats = true) => ({
  version: 'news-history-v1', companyId: 'samsung', status,
  horizons: { day: horizon('day', withStats), week: horizon('week', withStats) },
  coverage: { articles: 100, events: 40, usable: 30, excluded: { price_gap: 3, calendar_unverified: 1 }, observationGaps: 2 },
  dataAsOf: { computedAt: '2026-11-10T01:00:00Z', lastPriceDate: '2026-11-09', ledgerFrom: '2025-01-01', ledgerTo: '2026-11-09' },
  sources: { news: ['Marketaux', 'GDELT'], price: { label: 'Example prices', adjustment: 'split' } },
});
const clone = (value: unknown): Record<string, any> => JSON.parse(JSON.stringify(value));

test('parser accepts off and unavailable with the minimal shape and drops extra keys', () => {
  assert.deepEqual(parseCompanyHistory({ version: 'news-history-v1', companyId: 'x', status: 'off' }), { version: 'news-history-v1', companyId: 'x', status: 'off' });
  assert.deepEqual(
    parseCompanyHistory({ version: 'news-history-v1', companyId: 'x', status: 'unavailable', extra: 1 }),
    { version: 'news-history-v1', companyId: 'x', status: 'unavailable' },
  );
});

test('parser accepts a full ready value and returns an equal, separate copy', () => {
  const input = ready();
  const out = parseCompanyHistory(input) as Extract<CompanyHistory, { horizons: unknown }>;
  assert.ok(out);
  assert.deepEqual(out, input);
  assert.notEqual(out.horizons, input.horizons as unknown);
  assert.equal(out.horizons.day.directions?.positive.verdict, 'supports');
  assert.equal(out.horizons.week.newsWindow, null);
});

test('parser accepts every ready-type status', () => {
  for (const status of ['ready', 'no_history', 'identity_unverified', 'price_unavailable']) {
    assert.ok(parseCompanyHistory(ready(status)), status);
    assert.ok(parseCompanyHistory(ready(status, false)), `${status} without stats`);
  }
});

test('parser accepts stats_not_public only when directions are null in both horizons', () => {
  const out = parseCompanyHistory(ready('stats_not_public', false)) as Extract<CompanyHistory, { horizons: unknown }>;
  assert.ok(out);
  assert.equal(out.horizons.day.directions, null);
  assert.equal(out.horizons.week.directions, null);
  assert.equal(parseCompanyHistory(ready('stats_not_public', true)), null);
  const oneSided = ready('stats_not_public', false);
  (oneSided.horizons.week as { directions: unknown }).directions = { positive: direction(), negative: direction() };
  assert.equal(parseCompanyHistory(oneSided), null);
});

test('parser accepts a sample of null (insufficient verdict) and all verdicts', () => {
  const value = clone(ready());
  value.horizons.day.directions.positive.sample = null;
  assert.ok(parseCompanyHistory(value));
  for (const verdict of ['supports', 'contradicts', 'weakens', 'no_clear_difference', 'insufficient']) {
    const v = clone(ready());
    v.horizons.week.directions.negative.verdict = verdict;
    assert.ok(parseCompanyHistory(v), verdict);
  }
});

test('parser rejects non-objects, bad version, unknown status and bad ids without throwing', () => {
  for (const value of [null, undefined, 0, 'x', [], true, () => 1, Symbol('s')]) assert.equal(parseCompanyHistory(value), null);
  const mutate = (fn: (v: Record<string, any>) => void) => { const v = clone(ready()); fn(v); return parseCompanyHistory(v); };
  assert.equal(mutate(v => { v.version = 'news-history-v2'; }), null);
  assert.equal(mutate(v => { delete v.version; }), null);
  assert.equal(mutate(v => { v.status = 'done'; }), null);
  assert.equal(mutate(v => { v.status = 'OFF'; }), null);
  assert.equal(mutate(v => { v.companyId = ''; }), null);
  assert.equal(mutate(v => { v.companyId = 5; }), null);
  assert.equal(parseCompanyHistory({ version: 'news-history-v1', companyId: 'x', status: 'garbage' }), null);
});

test('parser rejects wrong types, NaN, Infinity and negative counts', () => {
  const mutate = (fn: (v: Record<string, any>) => void) => { const v = clone(ready()); fn(v); return parseCompanyHistory(v); };
  assert.equal(mutate(v => { v.coverage.articles = '100'; }), null);
  assert.equal(mutate(v => { v.coverage.events = -1; }), null);
  assert.equal(mutate(v => { v.coverage.usable = 1.5; }), null);
  assert.equal(mutate(v => { v.coverage.excluded.price_gap = -2; }), null);
  assert.equal(mutate(v => { v.horizons.day.directions.positive.all.cases = Number.NaN; }), null);
  assert.equal(mutate(v => { v.horizons.day.directions.positive.sample.difference = Number.POSITIVE_INFINITY; }), null);
  assert.equal(mutate(v => { v.horizons.day.directions.positive.sample.difference = 1.2; }), null);
  assert.equal(mutate(v => { v.horizons.day.directions.positive.sample.ci90 = [0.3, 0.1]; }), null);
  assert.equal(mutate(v => { v.horizons.day.directions.positive.sample.ci90 = [0.1]; }), null);
  assert.equal(mutate(v => { v.horizons.day.directions.positive.sample.unit = 'month'; }), null);
  assert.equal(mutate(v => { v.horizons.day.directions.positive.sample.eventUp = 25; }), null);
  assert.equal(mutate(v => { v.horizons.day.directions.positive.verdict = 'maybe'; }), null);
  assert.equal(mutate(v => { v.horizons.day.directions.positive.topics[0].topic = 'weather'; }), null);
  assert.equal(mutate(v => { v.horizons.day.directions.positive.topics.push(clone(v.horizons.day.directions.positive.topics[0])); }), null);
  assert.equal(mutate(v => { delete v.horizons.week; }), null);
  assert.equal(mutate(v => { v.horizons = null; }), null);
});

test('parser rejects shares outside [0,1] and inconsistent case statistics', () => {
  const mutate = (fn: (v: Record<string, any>) => void) => { const v = clone(ready()); fn(v); return parseCompanyHistory(v); };
  assert.equal(mutate(v => { v.horizons.day.directions.positive.all.allWindows.up = 1.01; }), null);
  assert.equal(mutate(v => { v.horizons.day.directions.positive.all.allWindows.down = -0.01; }), null);
  assert.equal(mutate(v => { v.horizons.day.directions.positive.all.allWindows = { up: 0.7, down: 0.6 }; }), null);
  assert.equal(mutate(v => { v.horizons.day.directions.positive.all.allWindows.up = Number.NaN; }), null);
  assert.equal(mutate(v => { v.horizons.day.directions.positive.all.nEff = 13; }), null);
  assert.equal(mutate(v => { v.horizons.day.directions.positive.all.up = 20; }), null);
  assert.equal(mutate(v => { v.horizons.day.directions.positive.all.returns.q1 = 0.5; }), null);
  assert.equal(mutate(v => { v.horizons.day.directions.positive.all.entryType = 'later'; }), null);
  assert.ok(mutate(v => { v.horizons.day.directions.positive.all.returns = null; v.horizons.day.directions.positive.all.allWindows = null; }));
});

test('parser rejects malformed dates and timestamps', () => {
  const mutate = (fn: (v: Record<string, any>) => void) => { const v = clone(ready()); fn(v); return parseCompanyHistory(v); };
  assert.equal(mutate(v => { v.dataAsOf.computedAt = '2026-11-10'; }), null);
  assert.equal(mutate(v => { v.dataAsOf.computedAt = '2026-13-10T00:00:00Z'; }), null);
  assert.equal(mutate(v => { v.dataAsOf.computedAt = '2026-11-10T25:00:00Z'; }), null);
  assert.equal(mutate(v => { v.dataAsOf.computedAt = '2026-11-10T01:00:00'; }), null);
  assert.equal(mutate(v => { v.dataAsOf.lastPriceDate = '2026-02-30'; }), null);
  assert.equal(mutate(v => { v.dataAsOf.lastPriceDate = '2026/11/09'; }), null);
  assert.equal(mutate(v => { v.dataAsOf.ledgerFrom = 'yesterday'; }), null);
  assert.equal(mutate(v => { v.horizons.week.targetWindow.start = '2026-11-20'; }), null);
  assert.equal(mutate(v => { v.horizons.week.targetWindow.end = 'soon'; }), null);
  assert.equal(mutate(v => { v.horizons.day.newsWindow = { start: '2026-11-10T00:00:00Z', end: '2026-11-09T06:30:00Z' }; }), null);
  assert.equal(mutate(v => { v.horizons.day.newsWindow.start = '2026-11-09'; }), null);
  assert.equal(mutate(v => { v.horizons.day.directions.positive.sample.from = '2026-99-01'; }), null);
  assert.equal(mutate(v => { v.horizons.day.directions.positive.examples[0].date = '2026-5-4'; }), null);
  assert.ok(mutate(v => { v.dataAsOf.lastPriceDate = null; v.dataAsOf.ledgerFrom = null; v.dataAsOf.ledgerTo = null; }));
});

test('parser rejects a week newsWindow, bad targets, bad validation, sources and examples', () => {
  const mutate = (fn: (v: Record<string, any>) => void) => { const v = clone(ready()); fn(v); return parseCompanyHistory(v); };
  assert.equal(mutate(v => { v.horizons.week.newsWindow = { start: '2026-11-09T06:30:00Z', end: '2026-11-10T00:00:00Z' }; }), null);
  assert.equal(mutate(v => { v.horizons.day.newsWindow = undefined; }), null);
  assert.equal(mutate(v => { v.horizons.day.targetWindow.basis = 'guess'; }), null);
  assert.equal(mutate(v => { v.horizons.day.targetWindow.phase = 'lunch'; }), null);
  assert.equal(mutate(v => { v.horizons.day.targetWindow.exchange = ''; }), null);
  assert.equal(mutate(v => { v.horizons.day.validation.status = 'proven'; }), null);
  assert.equal(mutate(v => { v.horizons.day.validation.directions = ['positive', 'positive']; }), null);
  assert.equal(mutate(v => { v.horizons.day.validation.directions = ['sideways']; }), null);
  assert.equal(mutate(v => { v.horizons.day.validation.evaluatedAt = '2026-11-10'; }), null);
  assert.equal(mutate(v => { v.sources.price.adjustment = 'full'; }), null);
  assert.equal(mutate(v => { v.sources.news = 'Marketaux'; }), null);
  assert.equal(mutate(v => { v.horizons.day.directions.positive.examples[0].url = 'http://example.com/a'; }), null);
  assert.equal(mutate(v => { v.horizons.day.directions.positive.examples[0].url = 'javascript:alert(1)'; }), null);
  assert.equal(mutate(v => { v.horizons.day.directions.positive.examples[0].exitDate = '2026-05-01'; }), null);
  assert.equal(mutate(v => {
    const list = v.horizons.day.directions.positive.examples;
    v.horizons.day.directions.positive.examples = Array.from({ length: 6 }, () => clone(list[0]));
  }), null);
  assert.ok(mutate(v => { v.sources.price = null; v.horizons.day.validation = { status: 'improvement_observed', directions: ['positive'], markets: ['KR'], evaluatedAt: '2026-11-01T00:00:00Z' }; }));
});

test('parser tolerates hostile keys and strips unknown fields', () => {
  const value = clone(ready());
  value.extra = { nested: true };
  value.horizons.day.extra = 1;
  const out = parseCompanyHistory(value) as unknown as Record<string, unknown>;
  assert.ok(out);
  assert.equal('extra' in out, false);
  assert.equal('extra' in (out.horizons as Record<string, Record<string, unknown>>).day!, false);
  const polluted = JSON.parse(JSON.stringify(ready()).replace('"price_gap"', '"__proto__"'));
  assert.equal(parseCompanyHistory(polluted), null);
  const getter = ready();
  Object.defineProperty(getter, 'companyId', { get() { throw new Error('boom'); }, enumerable: true });
  assert.equal(parseCompanyHistory(getter), null);
});

// --- display text -----------------------------------------------------------

test('labels use the plan wording', () => {
  assert.deepEqual(SIGNAL_LABELS, { positive: '상승 전망', negative: '하락 전망', withheld: '판단 유보' });
  assert.deepEqual(HORIZON_LABELS, { day: '다음 거래일', week: '다음 주' });
  assert.equal(VERDICT_LABELS.insufficient, '근거 부족');
  assert.equal(history.NO_OVERNIGHT_NEWS_MESSAGE, '판단 유보 · 밤사이 새 뉴스 없음');
  assert.equal(history.STATS_NOT_PUBLIC_MESSAGE, '과거 사례 통계는 데이터 이용 허가 확인 뒤 공개');
});

test('validation badge falls back to the pre-validation badge outside the evaluated scope', () => {
  const validation = { status: 'improvement_observed' as const, directions: ['positive' as const], markets: ['KR'], evaluatedAt: '2026-11-01T00:00:00Z' };
  assert.equal(validationBadge(validation, 'positive', 'KR'), VALIDATION_BADGES.improvement_observed);
  assert.equal(validationBadge(validation, 'negative', 'KR'), VALIDATION_BADGES.not_evaluated);
  assert.equal(validationBadge(validation, 'positive', 'US'), VALIDATION_BADGES.not_evaluated);
  assert.equal(validationBadge(validation, 'withheld', 'KR'), VALIDATION_BADGES.not_evaluated);
  assert.equal(validationBadge({ ...validation, status: 'no_evidence_of_improvement' }, 'positive', 'KR'), VALIDATION_BADGES.no_evidence_of_improvement);
});

// Claims of certainty, hit rate or probability, and trade advice, must not appear anywhere.
const FORBIDDEN = ['오릅니다', '내립니다', '반드시', '확정', '적중', '승률', '정확도', '확률', '우세', '매수 기회', '매도 기회', '매수·매도 기회', '추천', '권유합니다'];
// The plan's own wording names these ideas only to deny them.
const NEGATED = ['보장하지 않습니다', '권유가 아니고', '미래 확률 아님'];

function collectText(value: unknown, out: string[]): void {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(item => collectText(item, out));
  else if (typeof value === 'object' && value !== null) Object.values(value).forEach(item => collectText(item, out));
}

test('no exported display string contains a forbidden word', () => {
  const texts: string[] = [];
  const notes: IntegrationNote[] = ['supports', 'no_clear_difference', 'weakens', 'contradicts', 'insufficient', 'baseline_withheld'];
  for (const [name, value] of Object.entries(history)) {
    if (name === 'NEWS_HISTORY_VERSION') continue;
    if (typeof value !== 'function') collectText(value, texts);
  }
  for (const note of notes) for (const horizon of ['day', 'week'] as const) texts.push(integrationMessage(note, horizon));
  const sample = [at('2026-11-09T12:00:00.000Z', 'positive'), at('2026-11-09T13:00:00.000Z', 'negative'), at('2026-11-09T14:00:00.000Z', 'positive')];
  texts.push(overnightSummaryText(deriveOvernightSignal(sample, window)), overnightSummaryText(deriveOvernightSignal(sample.slice(0, 1), window)));
  texts.push(overnightSummaryText(deriveOvernightSignal(sample.slice(1, 2), window)), overnightSummaryText(deriveOvernightSignal([], window)));
  assert.ok(texts.length > 25);
  for (const text of texts) {
    assert.ok(text.trim().length > 0);
    let cleaned = text;
    for (const phrase of NEGATED) cleaned = cleaned.split(phrase).join('');
    for (const word of [...FORBIDDEN, '보장', '권유']) assert.ok(!cleaned.includes(word), `"${word}" in "${text}"`);
  }
});

test('the share label says it is not a probability of the future', () => {
  assert.equal(history.HISTORY_SHARE_LABEL, '과거 상승 비중(미래 확률 아님)');
});

test('the disclaimer keeps its required statements', () => {
  for (const part of ['검증 전', '전일 종가 대비', '미래 수익을 보장하지 않습니다', '매수·매도 권유가 아니고', '8개 대형주']) {
    assert.ok(history.HISTORY_DISCLAIMER.includes(part), part);
  }
});

test('integration messages differ by horizon unit but keep the same meaning per row', () => {
  assert.match(integrationMessage('supports', 'week'), /주의 다음 5거래일/);
  assert.match(integrationMessage('supports', 'day'), /날의 다음 거래일/);
  assert.equal(integrationMessage('insufficient', 'day'), '추가 근거 부족, 기존 판단 유지');
  assert.match(integrationMessage('contradicts', 'week'), /유보로 낮췄습니다/);
  assert.match(integrationMessage('weakens', 'week'), /^주의/);
});

// Type-level check that the discriminated union narrows as the contract says.
test('CompanyHistory narrows on status', () => {
  const parsed = parseCompanyHistory(ready()) as CompanyHistory;
  if (parsed.status === 'off' || parsed.status === 'unavailable') throw new Error('expected a ready-type value');
  const week: HorizonHistory = parsed.horizons.week;
  const stats: DirectionStats | undefined = week.directions?.positive;
  assert.equal(stats?.verdict, 'supports');
});
