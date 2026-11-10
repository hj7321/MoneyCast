import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DAY_BAND_FLOOR, SIGMA_MIN_VALID, WEEK_BAND_FLOOR, caseOutcome, dailySigma, isUsableBar, labelFor, neutralBand, nextDayOutcome,
  weeklyOutcome, type CaseOutcomeInput, type DailyBar,
} from './history-outcomes.js';
import {
  ARTICLE_DELAY_MS, CALENDAR_UNVERIFIED, addDays, classifyArticleTime, lastClosedSession, sessionOn, sessionsBefore,
  type ArticleTiming, type Exchange, type Session,
} from './market-calendar.js';

const at = (iso: string) => Date.parse(iso);
const LATE = at('2027-06-30T00:00:00Z');

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** One bar per calendar session with about 1% daily noise; deterministic per seed. */
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
const US = bars('NASDAQ', '2026-01-02', '2026-12-31', 1);
const SPY = bars('NASDAQ', '2026-01-02', '2026-12-31', 2, 0.01);
const KR = bars('KRX', '2026-01-02', '2026-12-30', 3);
const KODEX = bars('KRX', '2026-01-02', '2026-12-30', 4, 0.01);
const bar = (series: DailyBar[], date: string) => series.find(item => item.date === date)!;
const edit = (series: DailyBar[], date: string, change: Partial<DailyBar>) => series.map(item => item.date === date ? { ...item, ...change } : item);
const without = (series: DailyBar[], date: string) => series.filter(item => item.date !== date);

function usCase(published: string, overrides: Partial<CaseOutcomeInput> = {}) {
  return caseOutcome({ exchange: 'NASDAQ', publishedAtMs: at(published), bars: US, benchmarkBars: SPY, nowMs: LATE, ...overrides });
}

test('worked examples: entry, exit and session count follow the plan table', () => {
  const cases: Array<[string, string, string, string, number]> = [
    ['2026-11-07T15:00:00Z', 'open', '2026-11-09', '2026-11-13', 5],
    ['2026-11-09T17:00:00Z', 'close', '2026-11-09', '2026-11-16', 6],
    ['2026-11-27T19:00:00Z', 'open', '2026-11-30', '2026-12-04', 5],
    ['2026-11-25T17:00:00Z', 'close', '2026-11-25', '2026-12-03', 6],
    ['2026-11-21T15:00:00Z', 'open', '2026-11-23', '2026-11-30', 5],
  ];
  for (const [published, entryType, entryDate, exitDate, sessions] of cases) {
    const outcome = usCase(published);
    assert.equal(outcome.status, 'complete', published);
    assert.deepEqual([outcome.entryType, outcome.entryDate, outcome.exitDate, outcome.sessions.length],
      [entryType, entryDate, exitDate, sessions], published);
    const entry = bar(US, entryDate);
    const start = entryType === 'open' ? entry.open : entry.close;
    assert.equal(outcome.r, bar(US, exitDate).close / start - 1);
    const benchmarkStart = entryType === 'open' ? bar(SPY, entryDate).open : bar(SPY, entryDate).close;
    assert.equal(outcome.benchmarkR, bar(SPY, exitDate).close / benchmarkStart - 1);
    assert.equal(outcome.relative, outcome.r! - outcome.benchmarkR!);
    assert.ok(outcome.entryAtMs! >= at(published) + ARTICLE_DELAY_MS);
  }
  // The in-session window spans D close to D+5 close: D plus five measured sessions.
  assert.deepEqual(usCase('2026-11-25T17:00:00Z').sessions,
    ['2026-11-25', '2026-11-27', '2026-11-30', '2026-12-01', '2026-12-02', '2026-12-03']);
});

test('a raw case is labelled on its own return with band max(0.5%, 0.25 × σ × √5) from the prior returns', () => {
  const outcome = usCase('2026-11-09T17:00:00Z');
  const last = lastClosedSession('NASDAQ', at('2026-11-09T17:00:00Z')) as Session;
  assert.equal(last.date, '2026-11-06');
  const sigma = dailySigma('NASDAQ', last, US)!;
  assert.equal(outcome.sigma, sigma);
  assert.equal(outcome.band, Math.max(WEEK_BAND_FLOOR, 0.25 * sigma * Math.sqrt(5)));
  assert.equal(outcome.label, labelFor(outcome.r!, outcome.band!));
  assert.deepEqual(outcome.flags, ['unadjusted']);
  assert.equal(outcome.basis, 'raw');
});

test('the band floor, the scaled band and neutral boundaries', () => {
  assert.equal(neutralBand(0.001, 5, WEEK_BAND_FLOOR), 0.005);
  assert.equal(neutralBand(0.02, 5, WEEK_BAND_FLOOR), 0.25 * 0.02 * Math.sqrt(5));
  assert.equal(neutralBand(0.001, 1, DAY_BAND_FLOOR), 0.002);
  assert.equal(neutralBand(0.02, 1, DAY_BAND_FLOOR), 0.005);
  assert.equal(labelFor(0.0051, 0.005), 'up');
  assert.equal(labelFor(0.005, 0.005), 'neutral');
  assert.equal(labelFor(-0.005, 0.005), 'neutral');
  assert.equal(labelFor(-0.0051, 0.005), 'down');
});

test('a window ending after the clock is pending, and a bar is not used before it is available', () => {
  const published = '2026-11-09T17:00:00Z';
  assert.equal(usCase(published, { nowMs: at('2026-11-16T20:59:00Z') }).status, 'pending');
  assert.equal(usCase(published, { nowMs: at('2026-11-16T21:00:00Z') }).status, 'complete');
  // Provider publishes the next day: the bar for the exit exists in the input but is not yet knowable.
  const delayed = { availableAtMs: (session: Session) => session.closeMs + 86_400_000 };
  const pending = usCase(published, { nowMs: at('2026-11-17T12:00:00Z'), ...delayed });
  assert.deepEqual([pending.status, pending.r, pending.exitDate], ['pending', null, '2026-11-16']);
  assert.equal(usCase(published, { nowMs: at('2026-11-17T21:00:00Z'), ...delayed }).status, 'complete');
});

test('a bar fetched after the clock inside the window keeps the result pending, even when the exit is known', () => {
  // 2026-11-11's bar arrived late (a gap filled by a later fetch); the 11-16 exit was fetched on time.
  const lateMiddle = { availableAtMs: (session: Session) => session.date === '2026-11-11' ? at('2026-11-20T00:00:00Z') : session.closeMs };
  const nowMs = at('2026-11-17T00:00:00Z');
  assert.equal(usCase('2026-11-09T17:00:00Z', { nowMs, ...lateMiddle }).status, 'pending');
  assert.equal(usCase('2026-11-09T17:00:00Z', { nowMs: at('2026-11-20T00:00:00Z'), ...lateMiddle }).status, 'complete');
  // A missing middle bar is not yet a price_gap either: whether it exists is unknown at the clock.
  assert.equal(usCase('2026-11-09T17:00:00Z', { nowMs, ...lateMiddle, bars: without(US, '2026-11-11') }).status, 'pending');
  const weekly = weeklyOutcome({ exchange: 'NASDAQ', weekAsOfMs: at('2026-11-08T23:50:00Z'), bars: US, benchmarkBars: SPY, nowMs, ...lateMiddle });
  assert.equal(weekly.status, 'pending');
  // Next day: the base close N−1 must be knowable too.
  const lateBase = { availableAtMs: (session: Session) => session.date === '2026-11-10' ? at('2026-11-20T00:00:00Z') : session.closeMs };
  assert.equal(nextDayOutcome({ exchange: 'NASDAQ', sessionDate: '2026-11-11', bars: US, benchmarkBars: SPY, nowMs, ...lateBase }).status, 'pending');
  assert.equal(nextDayOutcome({ exchange: 'NASDAQ', sessionDate: '2026-11-11', bars: US, benchmarkBars: SPY, nowMs: at('2026-11-20T00:00:00Z'), ...lateBase }).status, 'complete');
});

test('without opens an out-of-session case enters at E close and exits at E+5 close', () => {
  const outcome = usCase('2026-11-07T15:00:00Z', { openAvailable: false });
  assert.deepEqual([outcome.entryType, outcome.entryDate, outcome.exitDate, outcome.sessions.length],
    ['close_no_open', '2026-11-09', '2026-11-16', 6]);
  assert.equal(outcome.r, bar(US, '2026-11-16').close / bar(US, '2026-11-09').close - 1);
  assert.ok(outcome.flags.includes('no_open'));
  // A zero open is then not a defect.
  const noOpens = US.map(item => ({ ...item, open: 0 }));
  assert.equal(caseOutcome({ exchange: 'NASDAQ', publishedAtMs: at('2026-11-07T15:00:00Z'), bars: noOpens, benchmarkBars: null,
    nowMs: LATE, openAvailable: false }).status, 'complete');
});

test('property: the entry price time is never earlier than the article time plus five minutes', () => {
  const next = random(42);
  const ranges: Array<[Exchange, number, number]> = [
    ['NASDAQ', at('2023-01-01T00:00:00Z'), at('2027-12-31T00:00:00Z')],
    ['KRX', at('2023-01-01T00:00:00Z'), at('2026-12-31T00:00:00Z')],
  ];
  let checked = 0;
  for (const [exchange, from, to] of ranges) {
    for (let i = 0; i < 4_000; i += 1) {
      const published = Math.floor(from + next() * (to - from));
      const precision = i % 10 === 0 ? 'day' : 'exact';
      const timing = classifyArticleTime(exchange, published, { precision });
      if (timing === CALENDAR_UNVERIFIED) continue;
      const entryAt = timing.kind === 'in_session' ? timing.session.closeMs : timing.session.openMs;
      assert.ok(entryAt >= published + ARTICLE_DELAY_MS, `${exchange} ${new Date(published).toISOString()}`);
      assert.ok(entryAt >= timing.tPrimeMs);
      if (precision === 'exact') assertEarliestPrice(exchange, timing);
      checked += 1;
    }
  }
  assert.ok(checked > 7_000);
  // The same holds for the outcome a case records.
  for (let ms = at('2026-11-06T12:00:00Z'); ms < at('2026-11-10T00:00:00Z'); ms += 7 * 60_000) {
    const outcome = caseOutcome({ exchange: 'NASDAQ', publishedAtMs: ms, bars: US, benchmarkBars: SPY, nowMs: LATE });
    assert.equal(outcome.status, 'complete');
    assert.ok(outcome.entryAtMs! >= ms + ARTICLE_DELAY_MS);
  }
});
/** No daily price observable at or after t′ comes before the chosen entry. */
function assertEarliestPrice(exchange: Exchange, timing: ArticleTiming) {
  if (timing.kind === 'in_session') { assert.ok(timing.session.openMs < timing.tPrimeMs); return; }
  const previous = sessionsBefore(exchange, timing.session.date, 1);
  if (previous === CALENDAR_UNVERIFIED) return;
  assert.ok(previous[0]!.closeMs < timing.tPrimeMs);
}

test('adjusted series use open × adjClose / close for the entry', () => {
  const adjusted = US.map(item => ({ ...item, adjClose: item.close / 2 }));
  const changed = edit(adjusted, '2026-11-09', { open: 100, close: 110, high: 111, low: 99, adjClose: 55 });
  const final = edit(changed, '2026-11-13', { close: 120, high: 121, low: 100, open: 101, adjClose: 60 });
  const outcome = usCase('2026-11-07T15:00:00Z', { bars: final, benchmarkBars: SPY });
  assert.equal(outcome.basis, 'adjusted');
  assert.equal(outcome.r, 60 / 50 - 1);
  assert.ok(!outcome.flags.includes('unadjusted'));
  // A raw benchmark is a different price kind: no market-relative value.
  assert.equal(outcome.relative, null);
  assert.ok(outcome.flags.includes('benchmark_gap'));
});

test('a split-like jump on unadjusted data excludes the case; the same jump in an adjusted series does not', () => {
  const split = (series: DailyBar[], date: string, factor: number) => series.map(item => item.date >= date
    ? { ...item, open: item.open * factor, high: item.high * factor, low: item.low * factor, close: item.close * factor } : item);
  const kr = (series: DailyBar[]) => caseOutcome({ exchange: 'KRX', publishedAtMs: at('2026-11-07T03:00:00Z'), bars: series,
    benchmarkBars: KODEX, nowMs: LATE });
  assert.equal(kr(KR).status, 'complete');
  assert.equal(kr(split(KR, '2026-11-11', 0.5)).reason, 'suspect_corporate_action');
  assert.equal(kr(split(KR, '2026-11-11', 0.8)).status, 'complete');
  // Nasdaq tolerates up to ±50%.
  assert.equal(usCase('2026-11-07T15:00:00Z', { bars: split(US, '2026-11-11', 0.6) }).status, 'complete');
  assert.equal(usCase('2026-11-07T15:00:00Z', { bars: split(US, '2026-11-11', 0.4) }).reason, 'suspect_corporate_action');
  const adjustedSplit = split(US, '2026-11-11', 0.4).map(item => ({ ...item, adjClose: item.date >= '2026-11-11' ? item.close / 0.4 : item.close }));
  assert.equal(usCase('2026-11-07T15:00:00Z', { bars: adjustedSplit, benchmarkBars: null }).status, 'complete');
});

test('missing bars: a gap in the stock excludes, a gap in the benchmark keeps r without a relative value', () => {
  assert.equal(usCase('2026-11-07T15:00:00Z', { bars: without(US, '2026-11-11') }).reason, 'price_gap');
  assert.equal(usCase('2026-11-07T15:00:00Z', { bars: without(US, '2026-11-13') }).reason, 'price_gap');
  const gap = usCase('2026-11-07T15:00:00Z', { benchmarkBars: without(SPY, '2026-11-13') });
  assert.equal(gap.status, 'complete');
  assert.equal(gap.relative, null);
  assert.ok(gap.r !== null && gap.label !== null);
  assert.ok(gap.flags.includes('benchmark_gap'));
  assert.ok(usCase('2026-11-07T15:00:00Z', { benchmarkBars: null }).flags.includes('benchmark_gap'));
  // The exit is never moved past a missing session.
  assert.equal(usCase('2026-11-07T15:00:00Z', { bars: without(US, '2026-11-13') }).exitDate, '2026-11-13');
});

test('zero volume, zero open or a price outside high-low on the entry or exit bar excludes the case', () => {
  assert.equal(usCase('2026-11-07T15:00:00Z', { bars: edit(US, '2026-11-09', { volume: 0 }) }).reason, 'invalid_bar');
  assert.equal(usCase('2026-11-07T15:00:00Z', { bars: edit(US, '2026-11-09', { open: 0 }) }).reason, 'invalid_bar');
  assert.equal(usCase('2026-11-07T15:00:00Z', { bars: edit(US, '2026-11-13', { close: bar(US, '2026-11-13').high * 1.1 }) }).reason, 'invalid_bar');
  // A quiet day in between is not an entry or exit.
  assert.equal(usCase('2026-11-07T15:00:00Z', { bars: edit(US, '2026-11-11', { volume: 0 }) }).status, 'complete');
  assert.equal(isUsableBar({ date: '2026-11-09', open: 10, high: 11, low: 9, close: 10.5, volume: 1 }), true);
  assert.equal(isUsableBar({ date: '2026-11-09', open: 12, high: 11, low: 9, close: 10.5, volume: 1 }), false);
});

test('fewer than fifty valid prior returns gives no direction label', () => {
  const short = US.filter(item => item.date >= '2026-09-15');
  const outcome = usCase('2026-11-09T17:00:00Z', { bars: short });
  assert.equal(outcome.status, 'complete');
  assert.deepEqual([outcome.sigma, outcome.band, outcome.label], [null, null, null]);
  assert.ok(outcome.flags.includes('insufficient_volatility_history'));
  // Each missing bar drops the two returns that would cross it: 5 gaps leave 50, 6 leave 48.
  const last = lastClosedSession('NASDAQ', at('2026-11-07T00:00:00Z')) as Session;
  const window = (sessionsBefore('NASDAQ', last.date, 60) as Session[]).map(item => item.date);
  const gaps = (count: number) => US.filter(item => !window.slice(5, 5 + count * 3).filter((_, i) => i % 3 === 0).includes(item.date));
  assert.ok(dailySigma('NASDAQ', last, gaps(5)) !== null);
  assert.equal(SIGMA_MIN_VALID, 50);
  assert.equal(dailySigma('NASDAQ', last, gaps(6)), null);
});

test('articles outside calendar coverage are excluded as calendar_unverified', () => {
  assert.equal(usCase('2022-12-30T17:00:00Z').reason, 'calendar_unverified');
  const kr = caseOutcome({ exchange: 'KRX', publishedAtMs: at('2026-12-28T02:00:00Z'), bars: KR, benchmarkBars: KODEX, nowMs: LATE });
  assert.deepEqual([kr.status, kr.reason, kr.entryAtMs], ['excluded', 'calendar_unverified', null]);
});

test('a day-precision stamp enters at the first open after its day ends', () => {
  const outcome = caseOutcome({ exchange: 'KRX', publishedAtMs: at('2026-11-10T00:00:00Z'), timePrecision: 'day', bars: KR,
    benchmarkBars: KODEX, nowMs: LATE });
  assert.deepEqual([outcome.entryType, outcome.entryDate, outcome.exitDate], ['open', '2026-11-12', '2026-11-18']);
});

test('later prices do not change a completed outcome', () => {
  const before = usCase('2026-11-09T17:00:00Z');
  const rewritten = US.map(item => item.date > '2026-11-16' ? { ...item, close: item.close * 3, high: item.high * 3 } : item);
  assert.deepEqual(usCase('2026-11-09T17:00:00Z', { bars: rewritten }), before);
});

test('weekly sample: Monday open to Friday close after Sunday 23:50 UTC, labelled market-relative', () => {
  const asOf = at('2026-11-08T23:50:00Z');
  for (const [exchange, own, market] of [['KRX', KR, KODEX], ['NASDAQ', US, SPY]] as const) {
    const outcome = weeklyOutcome({ exchange, weekAsOfMs: asOf, bars: own, benchmarkBars: market, nowMs: LATE });
    assert.deepEqual([outcome.status, outcome.entryType, outcome.entryDate, outcome.exitDate], ['complete', 'open', '2026-11-09', '2026-11-13']);
    assert.ok(outcome.entryAtMs! >= asOf + ARTICLE_DELAY_MS);
    assert.equal(outcome.r, bar(own, '2026-11-13').close / bar(own, '2026-11-09').open - 1);
    assert.equal(outcome.relative, outcome.r! - (bar(market, '2026-11-13').close / bar(market, '2026-11-09').open - 1));
    const last = lastClosedSession(exchange, asOf) as Session;
    assert.equal(last.date, '2026-11-06');
    const sigma = dailySigma(exchange, last, own, market)!;
    assert.equal(outcome.sigma, sigma);
    assert.notEqual(sigma, dailySigma(exchange, last, own));
    assert.equal(outcome.band, Math.max(WEEK_BAND_FLOOR, 0.25 * sigma * Math.sqrt(5)));
    assert.equal(outcome.label, labelFor(outcome.relative!, outcome.band!));
  }
  const gap = weeklyOutcome({ exchange: 'NASDAQ', weekAsOfMs: asOf, bars: US, benchmarkBars: without(SPY, '2026-11-09'), nowMs: LATE });
  assert.deepEqual([gap.status, gap.reason, gap.label], ['excluded', 'benchmark_gap', null]);
  assert.ok(gap.r !== null);
  assert.equal(weeklyOutcome({ exchange: 'NASDAQ', weekAsOfMs: asOf, bars: US, benchmarkBars: SPY, nowMs: at('2026-11-12T00:00:00Z') }).status, 'pending');
  assert.equal(weeklyOutcome({ exchange: 'KRX', weekAsOfMs: at('2026-12-27T23:50:00Z'), bars: KR, benchmarkBars: KODEX, nowMs: LATE }).reason,
    'calendar_unverified');
});

test('next trading day: close over previous close, market-relative, with the open-to-close move alongside', () => {
  const outcome = nextDayOutcome({ exchange: 'NASDAQ', sessionDate: '2026-11-10', bars: US, benchmarkBars: SPY, nowMs: LATE });
  const r = bar(US, '2026-11-10').close / bar(US, '2026-11-09').close - 1;
  const benchmarkR = bar(SPY, '2026-11-10').close / bar(SPY, '2026-11-09').close - 1;
  assert.deepEqual([outcome.status, outcome.entryDate, outcome.exitDate], ['complete', '2026-11-09', '2026-11-10']);
  assert.equal(outcome.r, r);
  assert.equal(outcome.benchmarkR, benchmarkR);
  assert.equal(outcome.relative, r - benchmarkR);
  const intraday = bar(US, '2026-11-10').close / bar(US, '2026-11-10').open - 1;
  const benchmarkIntraday = bar(SPY, '2026-11-10').close / bar(SPY, '2026-11-10').open - 1;
  assert.equal(outcome.intraday, intraday);
  assert.equal(outcome.relativeIntraday, intraday - benchmarkIntraday);
  const sigma = dailySigma('NASDAQ', { date: '2026-11-09' } as Session, US, SPY)!;
  assert.equal(outcome.sigma, sigma);
  assert.equal(outcome.band, Math.max(DAY_BAND_FLOOR, 0.25 * sigma));
  assert.equal(outcome.label, labelFor(r - benchmarkR, outcome.band!));
});

test('next trading day skips holidays for the base close and excludes gaps, jumps and unfinished sessions', () => {
  const afterHoliday = nextDayOutcome({ exchange: 'NASDAQ', sessionDate: '2026-11-27', bars: US, benchmarkBars: SPY, nowMs: LATE });
  assert.deepEqual([afterHoliday.entryDate, afterHoliday.exitDate], ['2026-11-25', '2026-11-27']);
  const input = { exchange: 'NASDAQ' as const, sessionDate: '2026-11-10', bars: US, benchmarkBars: SPY, nowMs: LATE };
  assert.equal(nextDayOutcome({ ...input, nowMs: at('2026-11-10T20:59:00Z') }).status, 'pending');
  assert.equal(nextDayOutcome({ ...input, bars: without(US, '2026-11-09') }).reason, 'price_gap');
  assert.equal(nextDayOutcome({ ...input, bars: edit(US, '2026-11-10', { volume: 0 }) }).reason, 'invalid_bar');
  const jumped = edit(US, '2026-11-10', { open: 300, high: 400, low: 290, close: 390 });
  assert.equal(nextDayOutcome({ ...input, bars: jumped }).reason, 'suspect_corporate_action');
  const gap = nextDayOutcome({ ...input, benchmarkBars: without(SPY, '2026-11-10') });
  assert.deepEqual([gap.status, gap.reason, gap.relative], ['excluded', 'benchmark_gap', null]);
  assert.ok(gap.r !== null);
  const noOpen = nextDayOutcome({ ...input, openAvailable: false });
  assert.deepEqual([noOpen.status, noOpen.intraday], ['complete', null]);
  assert.equal(nextDayOutcome({ ...input, sessionDate: '2027-01-04', exchange: 'KRX', bars: KR, benchmarkBars: KODEX }).reason,
    'calendar_unverified');
  assert.throws(() => nextDayOutcome({ ...input, sessionDate: '2026-11-26' }), RangeError);
});
