import test from 'node:test';
import assert from 'node:assert/strict';
import { companies } from '@moneycast/core';
import { sessionOn, type Session } from './market-calendar.js';
import {
  barAvailability, companyPriceIdentities, createPriceProviders, FETCH_ORDER, fetchRange, KRX_HISTORY_FROM, lastAvailableDate,
  LINK_SHARE, LINK_TOLERANCE, linkRatio, mergePriceSeries, PRICE_IDENTITY, PRICE_KEY_ENV, priceIdentity, publicationMs, withBaseFactors,
  type FetchedBar, type PriceBar, type PriceFetchResult, type PriceSeries,
} from './price-provider.js';

const SAMSUNG = priceIdentity('krx:005930')!;
const KODEX = priceIdentity('krx:069500')!;
const AAPL = priceIdentity('nasdaq:AAPL')!;
const iso = (ms: number) => new Date(ms).toISOString();
const T1 = '2026-11-10T07:00:00.000Z';
const T2 = '2026-11-11T07:00:00.000Z';

function session(exchange: 'KRX' | 'NASDAQ', date: string): Session {
  const found = sessionOn(exchange, date);
  assert.ok(found && typeof found === 'object', `${date} is a session`);
  return found;
}
function result(key: string, bars: FetchedBar[], receivedAt = T2, code: PriceFetchResult['code'] = 'ok'): PriceFetchResult {
  return {
    key, code, providerCode: null, bars, attemptedAt: receivedAt, receivedAt: code === 'ok' ? receivedAt : null, ms: 1,
    counts: { rows: bars.length, kept: bars.length, otherCodes: 0, nonSession: 0, unverifiedDate: 0, notClosed: 0, outsideValidity: 0, malformed: 0, duplicates: 0, flagged: 0 },
  };
}
const bar = (date: string, close: number, extra: Partial<PriceBar> = {}): FetchedBar =>
  ({ date, open: close, high: close + 5, low: close - 5, close, volume: 1000, ...extra });
const usBar = (date: string, close: number): FetchedBar => ({ ...bar(date, close), adjClose: close });

// ---------------------------------------------------------------- identities

test('the identity table has 11 unique keys, a benchmark for every stock and QQQ for US stocks', () => {
  assert.equal(PRICE_IDENTITY.length, 11);
  assert.equal(new Set(PRICE_IDENTITY.map(identity => identity.key)).size, 11);
  for (const identity of PRICE_IDENTITY) {
    assert.equal(identity.validFrom, '2020-01-02');
    assert.equal(identity.validTo, null);
    assert.ok(identity.sourceLabel.length <= 80);
    assert.equal(identity.timeZone, identity.exchange === 'KRX' ? 'Asia/Seoul' : 'America/New_York');
    if (identity.role !== 'stock') { assert.equal(identity.companyId, null); assert.equal(identity.benchmarkKey, null); continue; }
    assert.equal(identity.companyId, identity.key);
    assert.equal(priceIdentity(identity.benchmarkKey!)?.role, 'benchmark');
    assert.deepEqual(identity.comparisonKeys, identity.provider === 'massive' ? ['nasdaq:QQQ'] : []);
  }
  for (const company of companies) {
    const ids = companyPriceIdentities(company.id);
    assert.ok(ids, company.id);
    assert.equal(ids.stock.providerSymbol, company.symbol);
    assert.equal(ids.benchmark.key, company.region === 'KR' ? 'krx:069500' : 'arca:SPY');
    assert.deepEqual(ids.comparisons.map(identity => identity.key), company.region === 'KR' ? [] : ['nasdaq:QQQ']);
  }
  assert.equal(companyPriceIdentities('krx:069500'), null);
  assert.equal(companyPriceIdentities('nope'), null);
  assert.deepEqual(KODEX, { ...KODEX, instrument: 'etf', listing: 'KRX', isin: 'KR7069500007', marketCategory: null, priceBasis: 'fsc-raw-v1', adjustment: 'raw' });
  assert.equal(priceIdentity('arca:SPY')!.exchange, 'NASDAQ');
  assert.equal(priceIdentity('arca:SPY')!.listing, 'NYSE Arca');
  for (const provider of ['fsc', 'massive'] as const) {
    assert.deepEqual([...FETCH_ORDER[provider]].sort(), PRICE_IDENTITY.filter(identity => identity.provider === provider).map(identity => identity.key).sort());
    assert.equal(priceIdentity(FETCH_ORDER[provider][0]!)!.role, 'benchmark');
  }
  assert.equal(FETCH_ORDER.massive.at(-1), 'nasdaq:QQQ');
  assert.deepEqual(PRICE_KEY_ENV, { fsc: 'KR_PRICE_API_KEY', massive: 'US_PRICE_API_KEY' });
});

// ---------------------------------------------------------------- ranges and knowledge time

test('fetchRange: FSC from 2023 or a 7-day overlap, Massive the full 729-day window', () => {
  const now = Date.parse('2026-11-11T08:50:00Z');
  assert.deepEqual(fetchRange(SAMSUNG, null, now), { from: KRX_HISTORY_FROM, to: '2026-11-11' });
  const stored = (date: string): PriceSeries => mergePriceSeries(null, SAMSUNG, result(SAMSUNG.key, [bar(date, 1000)])).series!;
  assert.deepEqual(fetchRange(SAMSUNG, stored('2026-11-10'), now), { from: '2026-11-03', to: '2026-11-11' });
  assert.deepEqual(fetchRange(SAMSUNG, stored('2023-01-03'), now), { from: '2023-01-01', to: '2026-11-11' });
  assert.deepEqual(fetchRange(SAMSUNG, { ...stored('2026-11-10'), bars: [] }, now), { from: KRX_HISTORY_FROM, to: '2026-11-11' });
  // KST already on the 12th while it is still the 11th in New York.
  assert.deepEqual(fetchRange(SAMSUNG, null, Date.parse('2026-11-11T16:00:00Z')).to, '2026-11-12');
  assert.deepEqual(fetchRange(AAPL, null, now), { from: '2024-11-12', to: '2026-11-10' });
  assert.deepEqual(fetchRange(AAPL, stored('2026-11-10'), now), { from: '2024-11-12', to: '2026-11-10' });
});

test('publicationMs follows B-20 for both providers', () => {
  // Friday → Monday 13:00 KST.
  assert.equal(iso(publicationMs(SAMSUNG, session('KRX', '2026-11-06'))!), '2026-11-09T04:00:00.000Z');
  // Before the 2026-07-17 closure → the next session.
  assert.equal(iso(publicationMs(KODEX, session('KRX', '2026-07-16'))!), '2026-07-20T04:00:00.000Z');
  // The next session (2027) lies outside the KRX calendar.
  assert.equal(publicationMs(SAMSUNG, session('KRX', '2026-12-30')), null);
  // Massive: 00:00 ET the next calendar day, on both sides of both DST changes.
  assert.equal(iso(publicationMs(AAPL, session('NASDAQ', '2026-03-06'))!), '2026-03-07T05:00:00.000Z');
  assert.equal(iso(publicationMs(AAPL, session('NASDAQ', '2026-03-09'))!), '2026-03-10T04:00:00.000Z');
  assert.equal(iso(publicationMs(AAPL, session('NASDAQ', '2026-10-30'))!), '2026-10-31T04:00:00.000Z');
  assert.equal(iso(publicationMs(AAPL, session('NASDAQ', '2026-11-02'))!), '2026-11-03T05:00:00.000Z');
  assert.equal(iso(publicationMs(AAPL, session('NASDAQ', '2026-11-06'))!), '2026-11-07T05:00:00.000Z');
});

function koreanSeries(): PriceSeries {
  // First real fetch at T1 (2026-11-10 16:00 KST) stored the backfill; 2026-11-10's bar arrived with the T2 fetch.
  const first = mergePriceSeries(null, SAMSUNG, result(SAMSUNG.key, [bar('2026-11-05', 1000), bar('2026-11-06', 1010)], T1)).series!;
  return mergePriceSeries(first, SAMSUNG, result(SAMSUNG.key, [bar('2026-11-06', 1010), bar('2026-11-10', 1030)], T2)).series!;
}

test('barAvailability: backfill rule, forward rule, missing bars and a null series', () => {
  const series = koreanSeries();
  assert.equal(series.forwardSince, T1);
  assert.equal(series.lastSuccessAt, T2);
  const at = barAvailability(series, SAMSUNG);
  // Published 2026-11-06 13:00 KST, before the first fetch: the B-20 time.
  assert.equal(iso(at(session('KRX', '2026-11-05'))), '2026-11-06T04:00:00.000Z');
  // Published 2026-11-11 13:00 KST, after the first fetch: when it was first stored.
  assert.equal(iso(at(session('KRX', '2026-11-10'))), T2);
  // Missing, published (11-10 13:00 KST) before the last success: known to be missing.
  assert.equal(iso(at(session('KRX', '2026-11-09'))), '2026-11-10T04:00:00.000Z');
  // Missing, published after the last success: pending.
  assert.equal(at(session('KRX', '2026-11-11')), Number.POSITIVE_INFINITY);
  assert.equal(barAvailability(null, SAMSUNG)(session('KRX', '2026-11-05')), Number.POSITIVE_INFINITY);

  const us = mergePriceSeries(null, AAPL, result(AAPL.key, [usBar('2026-11-05', 100), usBar('2026-11-09', 101)], '2026-11-10T06:00:00.000Z')).series!;
  const usAt = barAvailability(us, AAPL);
  assert.equal(iso(usAt(session('NASDAQ', '2026-11-05'))), '2026-11-06T05:00:00.000Z');
  // 2026-11-09's bar was published at 2026-11-10 05:00Z, before the first fetch at 06:00Z.
  assert.equal(iso(usAt(session('NASDAQ', '2026-11-09'))), '2026-11-10T05:00:00.000Z');
  assert.equal(iso(usAt(session('NASDAQ', '2026-11-06'))), '2026-11-07T05:00:00.000Z');
  assert.equal(usAt(session('NASDAQ', '2026-11-10')), Number.POSITIVE_INFINITY);
});

test('a bar a later fetch fills in is known only from when it was stored, even when published before the first fetch', () => {
  // Regression: the publication rule (B-20) once applied to every bar published before forwardSince, so a gap
  // the provider filled a day later looked knowable to an earlier clock that had seen it missing.
  const sessions = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-09'];
  const closes = new Map(sessions.map((date, i) => [date, 100 + i]));
  const fetch = (dates: string[], at: string) => result(AAPL.key, dates.map(date => usBar(date, closes.get(date)!)), at);
  const first = mergePriceSeries(null, AAPL, fetch(sessions.filter(date => date !== '2026-11-04'), T1)).series!;
  const filled = mergePriceSeries(first, AAPL, fetch(sessions, T2));
  assert.equal(filled.code, 'ok');
  assert.equal(filled.newBars, 1);
  const series = filled.series!;
  assert.equal(series.bars.find(item => item.date === '2026-11-04')!.firstFetchedAt, T2);
  const at = barAvailability(series, AAPL);
  assert.equal(iso(at(session('NASDAQ', '2026-11-04'))), T2, 'not its publication, 2026-11-05 05:00Z');
  // Bars the first fetch stored keep the publication rule.
  assert.equal(iso(at(session('NASDAQ', '2026-11-03'))), '2026-11-04T05:00:00.000Z');
  // Before T2 the earlier store said "missing since publication"; the later store must not offer the price then.
  assert.equal(iso(barAvailability(first, AAPL)(session('NASDAQ', '2026-11-04'))), '2026-11-05T05:00:00.000Z');
});

test('lastAvailableDate is the latest bar knowable at the clock', () => {
  const series = koreanSeries();
  assert.equal(lastAvailableDate(series, SAMSUNG, Date.parse(T2) - 1), '2026-11-06');
  assert.equal(lastAvailableDate(series, SAMSUNG, Date.parse(T2)), '2026-11-10');
  assert.equal(lastAvailableDate(series, SAMSUNG, Date.parse('2026-11-06T03:59:59.999Z')), null);
  assert.equal(lastAvailableDate(null, SAMSUNG, Date.parse(T2)), null);
});

// ---------------------------------------------------------------- raw merge and base factors

test('raw merge: the first value wins, revisions are counted and new bars are stamped', () => {
  const first = mergePriceSeries(null, SAMSUNG, result(SAMSUNG.key, [bar('2026-11-05', 1000), bar('2026-11-06', 1010, { base: 1000 })], T1));
  assert.equal(first.code, 'ok');
  assert.equal(first.changed, true);
  assert.equal(first.newBars, 2);
  const stored = first.series!;
  assert.deepEqual({ ...stored, bars: [] }, {
    key: 'krx:005930', provider: 'fsc', providerSymbol: '005930', exchange: 'KRX', currency: 'KRW', basis: 'raw', priceBasis: 'fsc-raw-v1',
    forwardSince: T1, lastSuccessAt: T1, lastAttempt: { at: T1, code: 'ok' }, rebasedAt: null, bars: [],
  });
  const before = structuredClone(stored);
  const second = mergePriceSeries(stored, SAMSUNG, result(SAMSUNG.key, [
    bar('2026-11-09', 1020, { base: 1010 }), bar('2026-11-06', 1999, { base: 1000 }), bar('2026-11-05', 1000),
  ], T2));
  assert.deepEqual(stored, before, 'the stored series is not mutated');
  assert.equal(second.newBars, 1);
  assert.equal(second.revisedIgnored, 1);
  assert.equal(second.changed, true);
  const bars = second.series!.bars;
  assert.deepEqual(bars.map(item => [item.date, item.close, item.firstFetchedAt]), [
    ['2026-11-05', 1000, T1], ['2026-11-06', 1010, T1], ['2026-11-09', 1020, T2],
  ]);
  assert.equal(second.series!.forwardSince, T1);
  assert.equal(second.series!.lastSuccessAt, T2);
  assert.deepEqual(second.series!.lastAttempt, { at: T2, code: 'ok' });
  assert.equal(bars[1]!.baseFactor, 1);
  assert.equal(bars[2]!.baseFactor, 1);

  const unchanged = mergePriceSeries(second.series, SAMSUNG, result(SAMSUNG.key, [], '2026-11-12T07:00:00.000Z'));
  assert.equal(unchanged.changed, true, 'a successful fetch always moves lastSuccessAt');
  assert.equal(unchanged.series!.lastSuccessAt, '2026-11-12T07:00:00.000Z');
  assert.deepEqual(unchanged.series!.bars, bars);
});

test('withBaseFactors: exactly 1 on a normal day, the Kakao-like split factor, and a gap filled later', () => {
  const stamp = (fetched: FetchedBar): PriceBar => ({ ...fetched, firstFetchedAt: T1 });
  const normal = withBaseFactors([stamp(bar('2026-11-05', 1000)), stamp(bar('2026-11-06', 1010, { base: 1000 }))], 'KRX');
  assert.equal(normal[1]!.baseFactor, 1);
  assert.equal(normal[0]!.baseFactor, undefined, 'no base, no factor');
  const kakao = withBaseFactors([stamp(bar('2021-04-14', 112_000)), stamp(bar('2021-04-15', 24_100, { base: 22_480 }))], 'KRX');
  assert.equal(kakao[1]!.baseFactor, undefined, 'outside the calendar coverage no previous session is known');
  const split = withBaseFactors([stamp(bar('2026-11-05', 112_000)), stamp(bar('2026-11-06', 24_100, { base: 22_480 }))], 'KRX');
  assert.ok(Math.abs(split[1]!.baseFactor! - 0.2007) < 1e-4);
  // 2026-11-09's previous session (11-06) is missing: no factor, even though 11-05 exists.
  const gap = [stamp(bar('2026-11-05', 1000)), stamp(bar('2026-11-09', 1030, { base: 1020 }))];
  assert.equal(withBaseFactors(gap, 'KRX')[1]!.baseFactor, undefined);
  const filled = withBaseFactors([gap[0]!, stamp(bar('2026-11-06', 1020, { base: 1000 })), gap[1]!], 'KRX');
  assert.deepEqual(filled.map(item => item.baseFactor), [undefined, 1, 1]);
  // A stale factor is recomputed, never carried over.
  assert.equal(withBaseFactors([{ ...gap[1]!, baseFactor: 0.5 }], 'KRX')[0]!.baseFactor, undefined);
  // Previous session across the 2026-07-17 closure.
  const holiday = withBaseFactors([stamp(bar('2026-07-16', 1000)), stamp(bar('2026-07-20', 990, { base: 980 }))], 'KRX');
  assert.equal(holiday[1]!.baseFactor, 0.98);

  const merged = mergePriceSeries(
    mergePriceSeries(null, SAMSUNG, result(SAMSUNG.key, [bar('2026-11-05', 1000), bar('2026-11-09', 1030, { base: 1020 })], T1)).series,
    SAMSUNG, result(SAMSUNG.key, [bar('2026-11-06', 1020, { base: 1000 })], T2));
  assert.deepEqual(merged.series!.bars.map(item => item.baseFactor), [undefined, 1, 1], 'refilling the gap fixes its neighbour');
});

// ---------------------------------------------------------------- adjusted merge

function usSeries(): PriceSeries {
  return mergePriceSeries(null, AAPL, result(AAPL.key, [
    usBar('2026-11-03', 98), usBar('2026-11-04', 99), usBar('2026-11-05', 100), usBar('2026-11-06', 101),
  ], T1)).series!;
}

test('adjusted merge replaces the fetched window and keeps firstFetchedAt (k = 1)', () => {
  const stored = usSeries();
  assert.equal(stored.basis, 'split_adjusted');
  assert.equal(stored.priceBasis, 'massive-split-v1');
  const merged = mergePriceSeries(stored, AAPL, result(AAPL.key, [
    { ...usBar('2026-11-05', 100), volume: 2222 }, usBar('2026-11-06', 101), usBar('2026-11-09', 102),
  ], T2));
  assert.equal(merged.code, 'ok');
  assert.equal(merged.rebasedBy, null);
  assert.equal(merged.newBars, 1);
  const bars = merged.series!.bars;
  assert.deepEqual(bars.map(item => [item.date, item.close, item.volume, item.firstFetchedAt]), [
    ['2026-11-03', 98, 1000, T1], ['2026-11-04', 99, 1000, T1], ['2026-11-05', 100, 2222, T1], ['2026-11-06', 101, 1000, T1], ['2026-11-09', 102, 1000, T2],
  ]);
  assert.equal(merged.series!.rebasedAt, null);
  assert.ok(bars.every(item => item.baseFactor === undefined));
});

test('adjusted merge rescales retained bars by a common overlap ratio (k = 2)', () => {
  const stored = usSeries();
  const merged = mergePriceSeries(stored, AAPL, result(AAPL.key, [usBar('2026-11-05', 200), usBar('2026-11-06', 202), usBar('2026-11-09', 204)], T2));
  assert.equal(merged.code, 'ok');
  assert.equal(merged.rebasedBy, 2);
  assert.equal(merged.series!.rebasedAt, T2);
  const retained = merged.series!.bars[0]!;
  assert.deepEqual(retained, { ...stored.bars[0]!, open: 196, high: 206, low: 186, close: 196, adjClose: 196, volume: 500 });
  assert.deepEqual(merged.series!.bars.map(item => item.close), [196, 198, 200, 202, 204]);
});

test('adjusted merge rejects inconsistent ratios and keeps the stored series unchanged', () => {
  const stored = usSeries();
  const before = structuredClone(stored);
  const merged = mergePriceSeries(stored, AAPL, result(AAPL.key, [usBar('2026-11-05', 200), usBar('2026-11-06', 101)], T2));
  assert.equal(merged.code, 'inconsistent_adjustment');
  assert.equal(merged.changed, false);
  assert.deepEqual(merged.series, before);
  assert.deepEqual(stored, before);
});

test('adjusted merge takes an isolated corrected close and a rounded split instead of refusing every later fetch', () => {
  // Regression: any overlap ratio off by more than 1e-6 once kept the stored series unchanged, and the corrected
  // bar stays inside the 729-day window, so a one-cent correction stopped every new bar for two years.
  const dates = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-11-02', '2026-11-03', '2026-11-04',
    '2026-11-05', '2026-11-06'];
  const price = (date: string) => 100 + dates.indexOf(date) * 1.37;
  const stored = mergePriceSeries(null, AAPL, result(AAPL.key, dates.map(date => usBar(date, price(date))), T1)).series!;
  // The next fetch drops the oldest date out of its window, corrects one close by a cent and adds a session.
  const window = [...dates.slice(1), '2026-11-09'];
  const corrected = window.map(date => usBar(date, date === '2026-11-03' ? price(date) + 0.01 : date === '2026-11-09' ? 115 : price(date)));
  const merged = mergePriceSeries(stored, AAPL, result(AAPL.key, corrected, T2));
  assert.equal(merged.code, 'ok');
  assert.equal(merged.newBars, 1);
  assert.equal(merged.rebasedBy, null);
  const bars = merged.series!.bars;
  assert.equal(bars.length, 11);
  assert.equal(bars.find(item => item.date === '2026-11-03')!.close, price('2026-11-03') + 0.01, 'the provider’s correction is taken');
  assert.equal(bars.find(item => item.date === '2026-11-03')!.firstFetchedAt, T1, 'and keeps its first-fetch time');
  assert.deepEqual(bars[0], stored.bars[0], 'the retained bar is not rescaled');
  assert.equal(merged.series!.lastSuccessAt, T2);

  // A 3:1 split whose adjusted prices the provider rounds to four decimals: the ratios differ by about 1e-6.
  const split = window.map(date => usBar(date, date === '2026-11-09' ? 38.5 : Number((price(date) / 3).toFixed(4))));
  const rebased = mergePriceSeries(stored, AAPL, result(AAPL.key, split, T2));
  assert.equal(rebased.code, 'ok');
  assert.ok(Math.abs(rebased.rebasedBy! - 1 / 3) < 1e-5, String(rebased.rebasedBy));
  assert.ok(Math.abs(rebased.series!.bars[0]!.close - price(dates[0]!) / 3) < 1e-3);
  assert.equal(rebased.series!.bars.at(-1)!.close, 38.5);

  // No common ratio at all (every other close moved by half): still refused, stored series kept.
  const garbage = window.map((date, i) => usBar(date, price(date) * (i % 2 ? 1.5 : 1)));
  const refused = mergePriceSeries(stored, AAPL, result(AAPL.key, garbage, T2));
  assert.equal(refused.code, 'inconsistent_adjustment');
  assert.deepEqual(refused.series, stored);
});

test('linkRatio: the median when nearly every ratio shares it, else null', () => {
  assert.equal(LINK_SHARE, 0.95);
  assert.equal(LINK_TOLERANCE, 1e-4);
  assert.equal(linkRatio([1, 1, 1]), 1);
  assert.equal(linkRatio([1, 1 + 5e-7, 1 - 5e-7]), 1, 'within ADJUSTMENT_TOLERANCE of 1 is exactly 1');
  assert.equal(linkRatio([0.5, 0.5, 0.5]), 0.5);
  // One revision in twenty is tolerated, two are not.
  const twenty = Array.from({ length: 20 }, () => 1);
  assert.equal(linkRatio([...twenty.slice(1), 1.3]), 1);
  assert.equal(linkRatio([...twenty.slice(2), 1.3, 0.7]), null);
  // A split the provider has not yet applied to its two latest stored days: the old days decide.
  assert.equal(linkRatio([...Array.from({ length: 40 }, () => 0.25), 1, 1]), 0.25);
  assert.equal(linkRatio([2, 1]), null);
  assert.equal(linkRatio([]), null);
  assert.equal(linkRatio([1, Number.NaN]), null);
  assert.equal(linkRatio([1, 0]), null);
});

test('adjusted merge drops unverifiable retained bars without overlap and keeps bars on an empty fetch', () => {
  const stored = usSeries();
  const apart = mergePriceSeries(stored, AAPL, result(AAPL.key, [usBar('2026-11-10', 50)], T2));
  assert.equal(apart.code, 'ok');
  assert.equal(apart.droppedUnverifiable, 4);
  assert.deepEqual(apart.series!.bars.map(item => item.date), ['2026-11-10']);
  const empty = mergePriceSeries(stored, AAPL, result(AAPL.key, [], T2));
  assert.equal(empty.code, 'ok');
  assert.deepEqual(empty.series!.bars, stored.bars);
  assert.equal(empty.series!.lastSuccessAt, T2);
});

test('a failed fetch keeps the stored bars, records the attempt and reports no change', () => {
  const stored = usSeries();
  const failed = mergePriceSeries(stored, AAPL, { ...result(AAPL.key, [], T2, 'http_500'), attemptedAt: T2 });
  assert.equal(failed.changed, false);
  assert.equal(failed.code, 'http_500');
  assert.deepEqual(failed.series, { ...stored, lastAttempt: { at: T2, code: 'http_500' } });
  assert.equal(failed.series!.lastSuccessAt, T1);
  assert.deepEqual(mergePriceSeries(null, AAPL, result(AAPL.key, [], T2, 'timeout')),
    { series: null, changed: false, code: 'timeout', newBars: 0, revisedIgnored: 0, rebasedBy: null, droppedUnverifiable: 0 });
});

// ---------------------------------------------------------------- providers

test('createPriceProviders reports configured only for non-empty keys', () => {
  const none = createPriceProviders({ KR_PRICE_API_KEY: '  ', US_PRICE_API_KEY: '' });
  assert.equal(none.fsc.id, 'fsc');
  assert.equal(none.massive.id, 'massive');
  assert.equal(none.fsc.configured, false);
  assert.equal(none.massive.configured, false);
  const both = createPriceProviders({ KR_PRICE_API_KEY: 'kr-fake-key-123', US_PRICE_API_KEY: 'us-fake-key-123' });
  assert.equal(both.fsc.configured, true);
  assert.equal(both.massive.configured, true);
  assert.notEqual(createPriceProviders({}).fsc, createPriceProviders({}).fsc, 'fresh instances per call');
});

test('an FSC fetch through the real adapter merges into a series with base factors', async () => {
  const compact = (date: string) => date.replace(/-/g, '');
  const rows = [['2026-11-05', '1000', '0'], ['2026-11-06', '1010', '10'], ['2026-11-09', '1030', '20']].map(([date, close, vs]) => ({
    basDt: compact(date!), srtnCd: '005930', isinCd: 'KR7005930003', mrktCtg: 'KOSPI', mkp: close, hipr: close, lopr: close, clpr: close, vs, trqu: '5',
  }));
  const fetcher = (async () => new Response(JSON.stringify({ response: { header: { resultCode: '00' }, body: { totalCount: 3, items: { item: rows.reverse() } } } }),
    { status: 200 })) as unknown as typeof fetch;
  const now = Date.parse('2026-11-11T08:50:00Z');
  const providers = createPriceProviders({ KR_PRICE_API_KEY: 'kr-fake-key-123' }, { fetcher, now: () => now, sleep: async () => undefined });
  const fetched = await providers.fsc.fetch({ identity: SAMSUNG, ...fetchRange(SAMSUNG, null, now) }, now + 60_000);
  assert.equal(fetched.code, 'ok');
  const merged = mergePriceSeries(null, SAMSUNG, fetched);
  assert.deepEqual(merged.series!.bars.map(item => [item.date, item.base, item.baseFactor, item.firstFetchedAt]), [
    ['2026-11-05', 1000, undefined, iso(now)], ['2026-11-06', 1000, 1, iso(now)], ['2026-11-09', 1010, 1, iso(now)],
  ]);
});
