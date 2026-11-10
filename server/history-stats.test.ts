import test from 'node:test';
import assert from 'node:assert/strict';
import { NEWS_HISTORY_VERSION, parseCompanyHistory, type CompanyHistory, type NewsTopicKey } from '@moneycast/core';
import type { LedgerEntry, LedgerLabel } from './history-ledger.js';
import type { DailyBar, OutcomeLabel, WeeklyOutcome } from './history-outcomes.js';
import {
  CALENDAR_UNVERIFIED, addDays, dayTargetWindow, sessionOn, weekSessions, weekTargetWindow, weeklyAsOfsBetween,
  type Exchange, type Session,
} from './market-calendar.js';
import {
  MIN_EVENT_UNITS, Z75, Z90, buildCaseStats, buildDaySample, buildWeekSample, caseDisplayLevel, companyStats, decideVerdict,
  directionStats, newcombe, outcomesFromPrices, priceLagSessions, summarizeSample, wilson,
  type CompanyStats, type Observation, type OutcomeSource, type PriceInput, type SampleSummary, type SampleUnit, type UnitSample,
} from './history-stats.js';
import { groupEvents } from './history-ledger.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (value: string) => Date.parse(value);
const iso = (value: number) => new Date(value).toISOString();
const CO = 'acme';
const NOW = at('2026-11-02T00:00:00Z');
const OBSERVATION: Observation = { fromMs: at('2025-09-01T00:00:00Z') };

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function bars(exchange: Exchange, from: string, to: string, seed: number, volatility = 0.02): DailyBar[] {
  const next = random(seed);
  const result: DailyBar[] = [];
  let previous = 100;
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const session = sessionOn(exchange, date);
    if (!session || session === CALENDAR_UNVERIFIED) continue;
    const open = previous * (1 + (next() - 0.5) * volatility / 2);
    const close = open * (1 + (next() - 0.5) * volatility);
    result.push({ date, open, high: Math.max(open, close) * 1.01, low: Math.min(open, close) * 0.99, close, volume: 1_000 });
    previous = close;
  }
  return result;
}
const US = bars('NASDAQ', '2025-06-02', '2026-10-30', 11);
const SPY = bars('NASDAQ', '2025-06-02', '2026-10-30', 12, 0.01);
const PRICES = { exchange: 'NASDAQ' as const, bars: US, benchmarkBars: SPY };

// Sources memoise outcomes and are pure, so tests share one per price set and clock to stay fast.
const sources = new WeakMap<object, Map<number, OutcomeSource>>();
function sourceFor(prices: PriceInput, nowMs: number): OutcomeSource {
  const byClock = sources.get(prices) ?? new Map<number, OutcomeSource>();
  sources.set(prices, byClock);
  if (!byClock.has(nowMs)) byClock.set(nowMs, outcomesFromPrices(prices, nowMs));
  return byClock.get(nowMs)!;
}

function label(atMs: number, sentiment: LedgerLabel['sentiment']): LedgerLabel {
  return { at: iso(atMs), sentiment, score: 0.4, method: 'provider', relevance: null, consensus: null, promptVersion: null, models: [] };
}

/** A forward entry seen two hours after publication unless overridden. */
function entry(id: string, publishedMs: number, sentiment: LedgerLabel['sentiment'], overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  const seen = publishedMs + 2 * HOUR;
  return {
    id, storyId: id, companyId: CO, publishedAt: iso(publishedMs), timeKind: 'published', timePrecision: 'second', firstSeenAt: iso(seen),
    source: `${id}.example`, sourceProvider: 'marketaux', url: `https://${id}.example/a`, title: `${id}#`.repeat(12), language: 'en',
    topic: 'earnings', identity: 'entity_verified', origin: 'forward',
    collection: { sort: 'published', limit: 3, languages: ['en'], fetch: 'cron' }, labels: [label(seen, sentiment)], ...overrides,
  };
}

const ANCHORS = weeklyAsOfsBetween(OBSERVATION.fromMs + 7 * DAY, NOW);
type WeekKind = 'positive' | 'negative' | 'mixed' | 'neutral' | 'none';
const KINDS: WeekKind[] = ['positive', 'negative', 'mixed', 'neutral', 'none', 'positive'];
const kindOf = (index: number) => KINDS[index % KINDS.length]!;

/** One article on the Wednesday evening (UTC) before each anchor, by the KINDS cycle. */
function weeklyLedger(kind: (index: number) => WeekKind = kindOf): LedgerEntry[] {
  return ANCHORS.flatMap((asOf, index) => {
    const published = asOf - 4 * DAY;
    switch (kind(index)) {
      case 'positive': return [entry(`p${index}`, published, 'positive')];
      case 'negative': return [entry(`n${index}`, published, 'negative')];
      case 'mixed': return [entry(`mp${index}`, published, 'positive'), entry(`mn${index}`, published + HOUR, 'negative', { topic: 'regulation' })];
      case 'neutral': return [entry(`z${index}`, published, 'neutral')];
      default: return [];
    }
  });
}

function weekSample(entries: LedgerEntry[], direction: 'positive' | 'negative', nowMs = NOW, prices = PRICES, observation = OBSERVATION) {
  const outcomes = sourceFor(prices, nowMs);
  return buildWeekSample({ exchange: 'NASDAQ', companyId: CO, direction, entries, nowMs, observation, outcome: asOf => outcomes.week(asOf) });
}

const groups = (sample: UnitSample) => new Map(sample.units.map(unit => [unit.key, unit.group]));

function summary(overrides: Partial<SampleSummary>): SampleSummary {
  return {
    unit: 'week', eventUp: 0, eventDown: 0, eventNeutral: 0, otherUp: 0, otherDown: 0, otherNeutral: 0,
    eventQuarterMax: 5, measured: 100, benchmarkGaps: 0, from: '2025-01-06', to: '2026-10-30', ...overrides,
  };
}
/** Event x of n up, other y of m up; the rest down. */
const counts = (x: number, n: number, y: number, m: number, extra: Partial<SampleSummary> = {}) =>
  summary({ eventUp: x, eventDown: n - x, otherUp: y, otherDown: m - y, ...extra });

function close(actual: number, expected: number, tolerance: number, message?: string) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message ?? ''} ${actual} vs ${expected}`);
}

// ---------------------------------------------------------------------------
// Intervals
// ---------------------------------------------------------------------------

test('Newcombe hybrid score intervals match the reference values', () => {
  assert.ok(Math.abs(Z90 - 1.6448536) < 1e-7 && Math.abs(Z75 - 1.1503494) < 1e-7);
  const cases: Array<[number, number, number, number, number, number]> = [
    [14, 20, 18, 40, 0.026, 0.433],
    [14, 20, 20, 40, -0.023, 0.385],
    [10, 20, 28, 40, -0.401, 0.015],
    [9, 20, 28, 40, -0.445, -0.031],
  ];
  for (const [x1, n1, x2, n2, lo, hi] of cases) {
    const [l, u] = newcombe(x1, n1, x2, n2, Z90);
    close(l, lo, 0.002, `${x1}/${n1} vs ${x2}/${n2} lower`);
    close(u, hi, 0.002, `${x1}/${n1} vs ${x2}/${n2} upper`);
  }
  close(newcombe(10, 20, 28, 40, Z75)[1], -0.047, 0.002, '75% upper');
});

test('Wilson intervals stay in [0, 1], mirror under x → n − x, and are uninformative for n = 0', () => {
  assert.deepEqual(wilson(0, 0, Z90), [0, 1]);
  assert.deepEqual(newcombe(3, 0, 4, 10, Z90), [-1, 1]);
  for (let x = 0; x <= 20; x += 1) {
    const [lo, hi] = wilson(x, 20, Z90);
    const [mlo, mhi] = wilson(20 - x, 20, Z90);
    assert.ok(lo >= 0 && hi <= 1 && lo <= x / 20 && x / 20 <= hi);
    close(lo, 1 - mhi, 1e-12);
    close(hi, 1 - mlo, 1e-12);
  }
  const [lo, hi] = newcombe(20, 20, 0, 40, Z90);
  assert.ok(lo >= -1 && hi <= 1);
});

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

test('verdicts follow the table on the reference samples, first match wins', () => {
  assert.equal(decideVerdict(counts(14, 20, 18, 40), 'positive').verdict, 'supports');
  assert.equal(decideVerdict(counts(14, 20, 20, 40), 'positive').verdict, 'no_clear_difference');
  const weak = decideVerdict(counts(10, 20, 28, 40), 'positive');
  assert.equal(weak.verdict, 'weakens');
  close(weak.ci75[1], -0.047, 0.002);
  // 9/20 vs 28/40 also has a 75% upper bound below zero; contradicts comes first.
  const contra = decideVerdict(counts(9, 20, 28, 40), 'positive');
  assert.equal(contra.verdict, 'contradicts');
  assert.ok(contra.ci75[1] < 0);
  close(contra.difference, 9 / 20 - 28 / 40, 1e-12);
  // Insufficient comes before everything, even a clear difference.
  assert.equal(decideVerdict(counts(19, 19, 0, 40), 'positive').verdict, 'insufficient');
});

test('insufficient: unit thresholds count decisive units only, then quarter, benchmark and data flags in order', () => {
  const ok = counts(14, 20, 18, 40);
  assert.equal(decideVerdict(ok, 'positive').reason, null);
  assert.equal(MIN_EVENT_UNITS, 20);
  // 19 decisive plus neutrals is still too few; neutrals never fill the threshold.
  assert.equal(decideVerdict(counts(14, 19, 18, 40, { eventNeutral: 10 }), 'positive').reason, 'few_event_units');
  assert.equal(decideVerdict(counts(14, 20, 10, 19, { otherNeutral: 30 }), 'positive').reason, 'few_other_units');
  assert.equal(decideVerdict(counts(14, 19, 10, 19), 'positive').reason, 'few_event_units');
  assert.equal(decideVerdict(counts(14, 20, 10, 20), 'positive').reason, null);
  // Quarter: exactly half is allowed, more than half is not.
  assert.equal(decideVerdict({ ...ok, eventQuarterMax: 10 }, 'positive').reason, null);
  assert.equal(decideVerdict({ ...ok, eventQuarterMax: 11 }, 'positive').reason, 'quarter_concentration');
  // Benchmark gaps: 20% is allowed, above is not.
  assert.equal(decideVerdict({ ...ok, measured: 100, benchmarkGaps: 20 }, 'positive').reason, null);
  assert.equal(decideVerdict({ ...ok, measured: 100, benchmarkGaps: 21 }, 'positive').reason, 'benchmark_gaps');
  for (const [flag, reason] of [['priceFailed', 'price_failed'], ['identityFailed', 'identity_failed'], ['priceStale', 'price_stale'],
    ['statsStale', 'stats_stale']] as const) {
    const result = decideVerdict(ok, 'positive', { [flag]: true });
    assert.deepEqual([result.verdict, result.reason], ['insufficient', reason]);
  }
  // Order: an earlier rule names the reason when several hold.
  assert.equal(decideVerdict({ ...counts(14, 19, 10, 19), eventQuarterMax: 19, benchmarkGaps: 90 }, 'positive', { priceFailed: true }).reason,
    'few_event_units');
  assert.equal(decideVerdict({ ...ok, eventQuarterMax: 11, benchmarkGaps: 90 }, 'positive', { priceFailed: true }).reason, 'quarter_concentration');
  assert.equal(decideVerdict({ ...ok, benchmarkGaps: 90 }, 'positive', { priceFailed: true }).reason, 'benchmark_gaps');
  assert.equal(decideVerdict({ ...ok, eventUp: Number.NaN }, 'positive').reason, 'invalid_sample');
});

test('neutral units are excluded from the shares', () => {
  const plain = decideVerdict(counts(14, 20, 18, 40), 'positive');
  const padded = decideVerdict(counts(14, 20, 18, 40, { eventNeutral: 7, otherNeutral: 13 }), 'positive');
  assert.deepEqual(padded, plain);
  close(plain.difference, 14 / 20 - 18 / 40, 1e-12);
});

test('d = ±1 symmetry: mirrored counts give the mirrored verdict, difference and interval', () => {
  for (let x = 0; x <= 24; x += 3) {
    for (let y = 0; y <= 40; y += 5) {
      const n = 24;
      const m = 40;
      const positive = decideVerdict(counts(x, n, y, m), 'positive');
      // A negative baseline reads "down" where the positive one reads "up".
      const negative = decideVerdict(summary({ eventUp: n - x, eventDown: x, otherUp: m - y, otherDown: y }), 'negative');
      assert.equal(negative.verdict, positive.verdict, `${x}/${n} vs ${y}/${m}`);
      close(negative.difference, positive.difference, 1e-12);
      close(negative.ci90[0], positive.ci90[0], 1e-9);
      close(negative.ci90[1], positive.ci90[1], 1e-9);
      close(negative.ci75[1], positive.ci75[1], 1e-9);
      // The same counts read with the other direction flip the sign and swap the bounds.
      const flipped = decideVerdict(counts(x, n, y, m), 'negative');
      close(flipped.difference, -positive.difference, 1e-12);
      close(flipped.ci90[0], -positive.ci90[1], 1e-12);
      close(flipped.ci90[1], -positive.ci90[0], 1e-12);
    }
  }
  assert.equal(decideVerdict(counts(14, 20, 18, 40), 'negative').verdict, 'contradicts');
});

// ---------------------------------------------------------------------------
// Week samples
// ---------------------------------------------------------------------------

test('week samples: every kept week is in exactly one group, and the two directions never share an event week', () => {
  const entries = weeklyLedger();
  const positive = weekSample(entries, 'positive');
  const negative = weekSample(entries, 'negative');
  assert.ok(positive.units.length > 30, `${positive.units.length} weeks`);
  const pos = groups(positive);
  const neg = groups(negative);
  assert.equal(pos.size, positive.units.length, 'a week appears once');
  assert.deepEqual([...pos.keys()], [...neg.keys()], 'the kept weeks do not depend on the direction');
  const posEvents = [...pos].filter(([, group]) => group === 'event').map(([key]) => key);
  const posOther = [...pos].filter(([, group]) => group === 'other').map(([key]) => key);
  assert.equal(posEvents.length + posOther.length, pos.size);
  assert.equal(posEvents.filter(key => posOther.includes(key)).length, 0);
  for (const key of posEvents) assert.notEqual(neg.get(key), 'event', `${key} is an event week for both directions`);
  for (const [key] of pos) {
    const kind = kindOf(ANCHORS.indexOf(at(key)));
    assert.equal(pos.get(key), kind === 'positive' ? 'event' : 'other', `${key} ${kind}`);
    assert.equal(neg.get(key), kind === 'negative' ? 'event' : 'other', `${key} ${kind}`);
  }
  assert.ok(posEvents.length > 5 && [...neg.values()].filter(group => group === 'event').length > 3);
  // Units are labelled market-relative outcomes over Monday open → Friday close.
  for (const unit of positive.units) assert.ok(unit.entryDate <= unit.exitDate && Number.isFinite(unit.relative));
});

test('week samples skip holiday overlaps, observation gaps and incomplete weeks', () => {
  const entries = weeklyLedger();
  const sample = weekSample(entries, 'positive', NOW, PRICES, {
    fromMs: OBSERVATION.fromMs, gaps: [{ startMs: at('2026-03-02T00:00:00Z'), endMs: at('2026-03-05T00:00:00Z') }],
  });
  const keys = new Set(sample.units.map(unit => unit.key));
  // MLK day 2026-01-19: the week of 01-18 runs to Monday 01-26, so the next anchor would enter inside it.
  assert.ok(!keys.has(iso(at('2026-01-25T23:50:00Z'))));
  assert.ok(keys.has(iso(at('2026-01-18T23:50:00Z'))));
  assert.ok((sample.excluded.overlap ?? 0) >= 1);
  // The gap lies inside the window (03-01 23:50, 03-08 23:50] only.
  assert.ok(!keys.has(iso(at('2026-03-08T23:50:00Z'))));
  assert.ok(keys.has(iso(at('2026-03-01T23:50:00Z'))));
  assert.ok(keys.has(iso(at('2026-03-15T23:50:00Z'))));
  assert.equal(sample.excluded.observation_gap, 1);
  // The last anchor (11-01) has no completed outcome at NOW.
  assert.ok(!keys.has(iso(at('2026-11-01T23:50:00Z'))));
  assert.ok(keys.has(iso(at('2026-10-25T23:50:00Z'))), 'the week closing 10-30 is complete at NOW');
  assert.equal(sample.excluded.pending, 1);
  // Nothing before the observation start: the first window must start inside it.
  assert.ok(sample.units.every(unit => at(unit.key) - 7 * DAY >= OBSERVATION.fromMs));
});

test('leak: changing prices after the clock never changes an earlier sample, case table or verdict', () => {
  const entries = weeklyLedger();
  const clock = at('2026-06-01T00:00:00Z');
  const bumped = (series: DailyBar[]) => series.map(bar => bar.date > '2026-05-29'
    ? { ...bar, open: bar.open * 1.7, high: bar.high * 1.9, low: bar.low * 1.5, close: bar.close * 1.8 } : bar);
  const changed = { exchange: 'NASDAQ' as const, bars: bumped(US), benchmarkBars: SPY.map(bar => bar.date > '2026-05-29' ? { ...bar, close: bar.close * 0.7, low: bar.low * 0.6 } : bar) };
  for (const horizon of ['week', 'day'] as const) {
    for (const direction of ['positive', 'negative'] as const) {
      const make = (prices: typeof PRICES) => directionStats({
        horizon, exchange: 'NASDAQ', companyId: CO, direction, entries, nowMs: clock, observation: OBSERVATION,
        outcomes: sourceFor(prices, clock),
      });
      assert.deepEqual(make(changed), make(PRICES), `${horizon} ${direction}`);
    }
  }
  // And the change does reach a later clock, so the test above is not vacuous.
  assert.notDeepEqual(weekSample(entries, 'positive', NOW, changed).units, weekSample(entries, 'positive', NOW).units);
});

test('leak: an earlier article collected late never changes the weeks before it was seen', () => {
  const entries = weeklyLedger();
  const kept = weekSample(entries, 'positive').units.find(unit => unit.group === 'event' && at(unit.key) > at('2026-02-01T00:00:00Z'))!;
  const asOf = at(kept.key);
  const late = entry('late-negative', asOf - 3 * DAY, 'negative', { firstSeenAt: iso(asOf + 3 * DAY), labels: [label(asOf + 3 * DAY, 'negative')] });
  const before = groups(weekSample(entries, 'positive'));
  const after = groups(weekSample([...entries, late], 'positive'));
  assert.equal(before.get(iso(asOf)), 'event');
  assert.deepEqual(after, before, 'the late copy was not known at that asOf');
  // Control: the same article seen before the asOf does turn the week into an other week.
  const timely = { ...late, firstSeenAt: iso(asOf - HOUR), labels: [label(asOf - HOUR, 'negative')] };
  assert.equal(groups(weekSample([...entries, timely], 'positive')).get(iso(asOf)), 'other');
  // An earlier clock is unaffected by an entry first seen after it.
  const earlier = asOf + 2 * DAY;
  assert.deepEqual(weekSample([...entries, late], 'positive', earlier).units, weekSample(entries, 'positive', earlier).units);
});

test('leak: a label changed later is restored by time', () => {
  const entries = weeklyLedger(() => 'none');
  const asOf = ANCHORS[30]!;
  const published = asOf - 4 * DAY;
  const relabelled = entry('flip', published, 'positive', { labels: [label(published + 2 * HOUR, 'positive'), label(asOf + DAY, 'negative')] });
  assert.equal(groups(weekSample([...entries, relabelled], 'positive')).get(iso(asOf)), 'event');
  assert.equal(groups(weekSample([...entries, relabelled], 'negative')).get(iso(asOf)), 'other');
  // Relabelled before the asOf, the week reads negative.
  const early = { ...relabelled, labels: [label(published + 2 * HOUR, 'positive'), label(asOf - HOUR, 'negative')] };
  assert.equal(groups(weekSample([...entries, early], 'negative')).get(iso(asOf)), 'event');
  assert.equal(groups(weekSample([...entries, early], 'positive')).get(iso(asOf)), 'other');
  // Found unrelated only after the asOf: still counted at that asOf.
  const unrelatedLater = { ...relabelled, labels: [label(published + 2 * HOUR, 'positive'), { ...label(asOf + DAY, 'positive'), relevance: 'unrelated' as const }] };
  assert.equal(groups(weekSample([...entries, unrelatedLater], 'positive')).get(iso(asOf)), 'event');
});

function fakeWeek(asOfMs: number, value: OutcomeLabel): WeeklyOutcome {
  const sessions = weekSessions('NASDAQ', asOfMs) as Session[];
  const first = sessions[0]!;
  const last = sessions[sessions.length - 1]!;
  const relative = value === 'up' ? 0.02 : value === 'down' ? -0.02 : 0;
  return {
    status: 'complete', reason: null, entryType: 'open', entryDate: first.date, exitDate: last.date, entryAtMs: first.openMs,
    exitAtMs: last.closeMs, sessions: sessions.map(session => session.date), basis: 'adjusted', r: relative, benchmarkR: 0, relative,
    sigma: 0.01, band: 0.005, label: value, flags: [], weekAsOfMs: asOfMs,
  };
}

test('week sample end to end: event weeks that beat the other weeks support, mirrored data supports the negative side', () => {
  const alternate = (index: number): WeekKind => index % 2 === 0 ? 'positive' : 'none';
  const entries = weeklyLedger(alternate);
  const eventIndex = new Map(ANCHORS.map((asOf, index) => [asOf, index]));
  const outcome = (good: OutcomeLabel, bad: OutcomeLabel) => (asOfMs: number) => {
    const index = eventIndex.get(asOfMs)!;
    const event = alternate(index) === 'positive';
    // Event weeks: 9 of 10 good; other weeks: 3 of 10 good.
    return fakeWeek(asOfMs, (event ? index % 20 !== 0 : index % 10 < 3) ? good : bad);
  };
  const build = (direction: 'positive' | 'negative', list: LedgerEntry[], up: OutcomeLabel, down: OutcomeLabel) => buildWeekSample({
    exchange: 'NASDAQ', companyId: CO, direction, entries: list, nowMs: NOW, observation: OBSERVATION, outcome: outcome(up, down),
  });
  const positive = build('positive', entries, 'up', 'down');
  const result = decideVerdict(summarizeSample(positive), 'positive');
  assert.equal(result.verdict, 'supports', JSON.stringify(summarizeSample(positive)));
  const mirrored = entries.map(item => ({ ...item, labels: item.labels.map(value => ({ ...value, sentiment: 'negative' as const })) }));
  const negative = build('negative', mirrored, 'down', 'up');
  const mirror = decideVerdict(summarizeSample(negative), 'negative');
  assert.equal(mirror.verdict, 'supports');
  close(mirror.difference, result.difference, 1e-12);
  // Read against the positive baseline, the same outcomes contradict.
  assert.equal(decideVerdict(summarizeSample(build('positive', entries, 'down', 'up')), 'positive').verdict, 'contradicts');
});

test('quarter concentration is counted on decisive event units', () => {
  const unit = (date: string, group: 'event' | 'other', value: OutcomeLabel): SampleUnit =>
    ({ key: date, group, date, entryDate: date, exitDate: date, label: value, relative: 0, timeUnverified: false });
  const units = [
    ...['2026-01-05', '2026-02-02', '2026-03-30'].map(date => unit(date, 'event', 'up')),
    unit('2026-03-02', 'event', 'neutral'),
    unit('2026-04-06', 'event', 'down'),
    unit('2026-01-12', 'other', 'up'), unit('2026-01-19', 'other', 'down'),
  ];
  const result = summarizeSample({ unit: 'week', direction: 'positive', units, excluded: {}, measured: 7, benchmarkGaps: 0 });
  assert.deepEqual([result.eventUp, result.eventDown, result.eventNeutral, result.otherUp, result.otherDown], [3, 1, 1, 1, 1]);
  assert.equal(result.eventQuarterMax, 3);
  assert.deepEqual([result.from, result.to], ['2026-01-05', '2026-04-06']);
  // 11 of 20 decisive event weeks in one quarter.
  const concentrated = counts(14, 20, 18, 40, { eventQuarterMax: 11 });
  assert.equal(decideVerdict(concentrated, 'positive').verdict, 'insufficient');
});

// ---------------------------------------------------------------------------
// Day samples
// ---------------------------------------------------------------------------

test('day samples: only overnight articles seen before the open make an event day; in-session articles belong to no day', () => {
  const backfill = entry('bf', at('2026-03-12T02:00:00Z'), 'positive', {
    origin: 'backfill', firstSeenAt: null, labels: [label(at('2026-03-13T02:00:00Z'), 'positive')],
  });
  const entries = [
    // Monday night → Tuesday 03-10 (open 13:30Z after the DST change).
    entry('overnight', at('2026-03-10T02:00:00Z'), 'positive'),
    // In session on 03-10: neither 03-10 nor 03-11.
    entry('intraday', at('2026-03-10T15:00:00Z'), 'positive'),
    // Overnight before 03-11, but first seen after the open.
    entry('seen-late', at('2026-03-11T02:00:00Z'), 'positive', { firstSeenAt: '2026-03-11T14:00:00.000Z', labels: [label(at('2026-03-11T14:00:00Z'), 'positive')] }),
    // Backfill: judged by publication time and flagged.
    backfill,
    // Three minutes before the 03-13 open: t′ falls in the session.
    entry('pre-open-3', at('2026-03-13T13:27:00Z'), 'positive', { firstSeenAt: '2026-03-13T13:28:00.000Z', labels: [label(at('2026-03-13T13:28:00Z'), 'positive')] }),
    // Six minutes before the 03-16 open, seen before it: in the window.
    entry('pre-open-6', at('2026-03-16T13:24:00Z'), 'positive', { firstSeenAt: '2026-03-16T13:25:00.000Z', labels: [label(at('2026-03-16T13:25:00Z'), 'positive')] }),
    // A negative overnight article on 03-17 and a positive one: conflict.
    entry('conflict-p', at('2026-03-17T03:00:00Z'), 'positive'),
    entry('conflict-n', at('2026-03-17T04:00:00Z'), 'negative', { topic: 'regulation' }),
  ];
  const outcomes = sourceFor(PRICES, NOW);
  const make = (direction: 'positive' | 'negative') => buildDaySample({
    exchange: 'NASDAQ', companyId: CO, direction, entries, nowMs: NOW, observation: OBSERVATION, outcome: date => outcomes.day(date),
  });
  const positive = make('positive');
  const byDate = new Map(positive.units.map(unit => [unit.key, unit]));
  const group = (date: string) => byDate.get(date)?.group;
  assert.equal(group('2026-03-10'), 'event');
  assert.equal(group('2026-03-11'), 'other');
  assert.equal(group('2026-03-12'), 'event');
  assert.equal(byDate.get('2026-03-12')!.timeUnverified, true);
  assert.equal(byDate.get('2026-03-10')!.timeUnverified, false);
  assert.equal(group('2026-03-13'), 'other');
  assert.equal(group('2026-03-16'), 'event');
  assert.equal(group('2026-03-17'), 'other');
  assert.equal(make('negative').units.find(unit => unit.key === '2026-03-17')!.group, 'other');
  const events = positive.units.filter(unit => unit.group === 'event').map(unit => unit.key);
  assert.deepEqual(events, ['2026-03-10', '2026-03-12', '2026-03-16']);
  // Disjoint and one unit per session; weekends and holidays are no units.
  assert.equal(new Set(positive.units.map(unit => unit.key)).size, positive.units.length);
  assert.ok(positive.units.every(unit => { const day = new Date(`${unit.key}T00:00:00Z`).getUTCDay(); return day > 0 && day < 6; }));
  assert.ok(!byDate.has('2026-01-19'));
  // Each unit is N−1 close → N close.
  assert.equal(byDate.get('2026-03-10')!.entryDate, '2026-03-09');
});

// ---------------------------------------------------------------------------
// Case statistics
// ---------------------------------------------------------------------------

/** Biweekly positive events on Tuesdays at 15:00Z (in session), so windows never overlap. */
function biweekly(count: number, start = at('2026-01-06T15:00:00Z'), topic: NewsTopicKey = 'earnings'): LedgerEntry[] {
  return Array.from({ length: count }, (_, i) => entry(`c${topic}${i}`, start + i * 14 * DAY, 'positive', { topic }));
}

function cases(entries: LedgerEntry[], horizon: 'week' | 'day' = 'week', nowMs = NOW, prices = PRICES) {
  return buildCaseStats({
    horizon, exchange: 'NASDAQ', direction: 'positive', events: groupEvents(entries, nowMs), nowMs, outcomes: sourceFor(prices, nowMs),
  });
}

test('case display thresholds: under 5 events list only, n_eff under 10 counts only, then shares', () => {
  const four = cases(biweekly(4)).all;
  assert.equal(four.cases, 4);
  assert.equal(four.returns, null);
  assert.equal(four.allWindows, null);
  assert.equal(caseDisplayLevel(four), 'list');
  assert.equal(four.up + four.neutral + four.down, 4);

  const five = cases(biweekly(5)).all;
  assert.deepEqual([five.cases, five.nEff], [5, 5]);
  assert.notEqual(five.returns, null);
  assert.equal(five.allWindows, null);
  assert.equal(caseDisplayLevel(five), 'counts');
  assert.equal(caseDisplayLevel({ cases: 9, nEff: 9 }), 'counts');

  const twelve = cases(biweekly(12)).all;
  assert.deepEqual([twelve.cases, twelve.nEff], [12, 12]);
  assert.equal(caseDisplayLevel(twelve), 'shares');
  assert.ok(twelve.allWindows !== null && twelve.allWindows.up + twelve.allWindows.down <= 1);
  const { returns } = twelve;
  assert.ok(returns && returns.min <= returns.q1 && returns.q1 <= returns.median && returns.median <= returns.q3 && returns.q3 <= returns.max);
  assert.notEqual(returns!.relativeMedian, null);
  assert.equal(twelve.entryType, 'close');
  assert.deepEqual(twelve.period, { from: '2026-01-06', to: twelve.period!.to });
  // Ten events, but overlapping windows: n_eff stays below ten, so no shares.
  const daily = Array.from({ length: 10 }, (_, i) => entry(`d${i}`, at('2026-02-03T15:00:00Z') + i * 4 * DAY, 'positive'));
  const crowded = cases(daily).all;
  assert.equal(crowded.cases, 10);
  assert.ok(crowded.nEff < 10);
  assert.equal(crowded.allWindows, null);
});

test('case exclusions: the current window, incomplete windows and price gaps; other is never a topic row', () => {
  const recent = entry('recent', NOW - 5 * DAY, 'positive');
  const gapCase = entry('gap', at('2026-04-07T15:00:00Z'), 'positive', { topic: 'regulation' });
  const other = entry('misc', at('2026-05-05T15:00:00Z'), 'positive', { topic: 'other' });
  const negative = entry('neg', at('2026-05-19T15:00:00Z'), 'negative');
  const http = entry('plain', at('2026-06-02T15:00:00Z'), 'positive', { url: 'http://plain.example/a', topic: 'analyst' });
  const prices = { ...PRICES, bars: US.filter(bar => bar.date !== '2026-04-09') };
  const result = cases([...biweekly(6), recent, gapCase, other, negative, http], 'week', NOW, prices);
  assert.equal(result.excluded.recent, 1);
  assert.equal(result.excluded.price_gap, 1);
  assert.equal(result.all.cases, 8, '6 earnings + other + analyst');
  assert.deepEqual(result.topics.map(row => row.topic), ['earnings', 'analyst']);
  assert.equal(result.topics.find(row => row.topic === 'earnings')!.cases.cases, 6);
  assert.ok(result.examples.length <= 5);
  assert.ok(result.examples.every(ref => ref.url.startsWith('https://')));
  assert.ok(!result.examples.some(ref => ref.url.includes('plain')));
  const dates = result.examples.map(ref => ref.date);
  assert.deepEqual(dates, [...dates].sort().reverse(), 'most recent first');
  // A window whose exit price is not yet available at the clock is left out (prices published two weeks late here).
  const delayed = { ...PRICES, availableAtMs: (session: Session) => session.closeMs + 14 * DAY };
  const pending = cases(biweekly(3, at('2026-09-29T15:00:00Z')), 'week', NOW, delayed);
  assert.deepEqual([pending.all.cases, pending.excluded.pending, pending.excluded.recent], [1, 1, 1]);
});

test('day cases are overnight articles measured by the next-day outcome', () => {
  const overnight = Array.from({ length: 6 }, (_, i) => entry(`o${i}`, at('2026-02-03T02:00:00Z') + i * 7 * DAY, 'positive'));
  const intraday = entry('i', at('2026-04-07T15:00:00Z'), 'positive', { topic: 'analyst' });
  const result = cases([...overnight, intraday], 'day');
  assert.equal(result.all.cases, 6);
  assert.equal(result.excluded.not_overnight, 1);
  assert.equal(result.all.entryType, 'close');
  // Five most recent of six; the oldest shown was published Monday night ET, so N is Tuesday 02-10.
  assert.equal(result.examples.length, 5);
  const oldest = result.examples[result.examples.length - 1]!;
  assert.deepEqual([oldest.entryDate, oldest.exitDate], ['2026-02-09', '2026-02-10']);
  const outcome = sourceFor(PRICES, NOW).day('2026-02-10');
  assert.deepEqual([oldest.r, oldest.relative], [outcome.r, outcome.relative]);
});

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function companyInput(overrides: Partial<Parameters<typeof companyStats>[0]> = {}) {
  return {
    companyId: CO, exchange: 'NASDAQ' as const, entries: weeklyLedger(), nowMs: NOW, observation: OBSERVATION,
    outcomes: sourceFor(PRICES, NOW), lastPriceDate: '2026-10-30', statsPublic: true, identityVerified: true, priceAvailable: true,
    sources: { news: ['Marketaux'], price: { label: 'Test prices', adjustment: 'split' as const } }, ...overrides,
  };
}

function asHistory(stats: CompanyStats): CompanyHistory {
  const day = dayTargetWindow('NASDAQ', NOW);
  const validation = { status: 'not_evaluated' as const, directions: [], markets: [], evaluatedAt: null };
  return {
    version: stats.version, companyId: stats.companyId, status: stats.status, coverage: stats.coverage, dataAsOf: stats.dataAsOf,
    sources: stats.sources,
    horizons: {
      day: { validation, targetWindow: day.targetWindow, newsWindow: day.newsWindow, directions: stats.horizons.day.directions },
      week: { validation, targetWindow: weekTargetWindow('NASDAQ', NOW), newsWindow: null, directions: stats.horizons.week.directions },
    },
  };
}

test('company stats parse under the strict contract parser', () => {
  const stats = companyStats(companyInput());
  assert.equal(stats.status, 'ready');
  assert.equal(stats.version, NEWS_HISTORY_VERSION);
  const history = asHistory(stats);
  const parsed = parseCompanyHistory(JSON.parse(JSON.stringify(history)));
  assert.notEqual(parsed, null);
  assert.deepEqual(parsed, JSON.parse(JSON.stringify(history)));
  const week = stats.horizons.week.directions!;
  assert.ok(week.positive.sample !== null && week.positive.sample.eventUnits > 0);
  assert.equal(week.positive.sample!.unit, 'week');
  assert.equal(stats.horizons.day.directions!.positive.sample!.unit, 'day');
  // This fixture has too few event weeks for a verdict.
  assert.equal(week.positive.verdict, 'insufficient');
  assert.equal(week.positive.reason, 'few_event_units');
  assert.ok(stats.coverage.usable > 0 && stats.coverage.articles === weeklyLedger().length);
  assert.ok(Object.keys(stats.coverage.excluded).length <= 30);
  assert.equal(stats.dataAsOf.computedAt, iso(NOW));
  // An entry the ledger first saw after the clock is not counted or dated, even if it was published before.
  const unseen = entry('unseen', NOW - 20 * DAY, 'positive', { firstSeenAt: iso(NOW + HOUR), labels: [label(NOW + HOUR, 'positive')] });
  assert.deepEqual(companyStats(companyInput({ entries: [...weeklyLedger(), unseen] })), stats);
});

test('gated statuses carry no statistics, and stale prices close the verdict', () => {
  const hidden = companyStats(companyInput({ statsPublic: false }));
  assert.equal(hidden.status, 'stats_not_public');
  assert.equal(hidden.horizons.week.directions, null);
  assert.equal(hidden.horizons.day.directions, null);
  assert.equal(hidden.coverage.usable, 0);
  assert.notEqual(parseCompanyHistory(JSON.parse(JSON.stringify(asHistory(hidden)))), null);
  assert.equal(companyStats(companyInput({ identityVerified: false })).status, 'identity_unverified');
  assert.equal(companyStats(companyInput({ priceAvailable: false })).status, 'price_unavailable');
  assert.equal(companyStats(companyInput({ entries: [] })).status, 'no_history');

  assert.equal(priceLagSessions('NASDAQ', '2026-10-30', NOW), 0);
  assert.equal(priceLagSessions('NASDAQ', '2026-10-15', NOW), 11);
  assert.equal(priceLagSessions('NASDAQ', '2026-10-27', NOW), 3);
  // Weekly outcomes that clearly support the positive side, so only staleness can close the verdict.
  const alternate = (index: number): WeekKind => index % 2 === 0 ? 'positive' : 'none';
  const real = sourceFor(PRICES, NOW);
  const index = new Map(ANCHORS.map((asOf, i) => [asOf, i]));
  const outcomes = { ...real, week: (asOf: number) => fakeWeek(asOf, alternate(index.get(asOf)!) === 'positive' ? 'up' : 'down') };
  const fresh = companyStats(companyInput({ entries: weeklyLedger(alternate), outcomes }));
  assert.equal(fresh.horizons.week.directions!.positive.verdict, 'supports');
  const stale = companyStats(companyInput({ entries: weeklyLedger(alternate), outcomes, lastPriceDate: '2026-10-15' }));
  assert.equal(stale.horizons.week.directions!.positive.verdict, 'insufficient');
  assert.equal(stale.horizons.week.directions!.positive.reason, 'price_stale');
  for (const horizon of ['week', 'day'] as const) {
    for (const direction of ['positive', 'negative'] as const) assert.equal(stale.horizons[horizon].directions![direction].verdict, 'insufficient');
  }
});
