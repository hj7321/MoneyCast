import test from 'node:test';
import assert from 'node:assert/strict';
import {
  companies, parseCompanyHistory,
  type CaseStats, type Company, type CompanyHistory, type DirectionStats, type Horizon, type NewsAnalysis,
} from '@moneycast/core';
import type { CompanyStats } from './history-stats.js';
import {
  HISTORY_VERSIONS, createMemoryHistoryStore, parseStatsFile,
  type HistoryStore, type MemoryHistoryStore, type MemoryStoreOptions, type StatsFile,
} from './history-store.js';
import {
  HISTORY_CDN_MAX_SECONDS, HISTORY_CDN_MIN_SECONDS, HISTORY_FAILURE_CDN, HISTORY_STATS_RETRY_MS, HISTORY_STATS_TTL_MS, HISTORY_VALIDATION,
  buildCompanyHistory, createHistoryServe, createStatsReader, historyCdnCacheControl, parsePublicMarkets, withHistoryHint,
} from './history-serve.js';
import {
  CALENDAR_UNVERIFIED, EXCHANGE_CALENDARS, addDays, dayTargetWindow, sessionOn, weekTargetWindow, zonedTimeToUtc, type Exchange,
} from './market-calendar.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse('2026-11-23T10:00:00Z');
const company = (id: string): Company => companies.find(item => item.id === id)!;
const KR = companies.filter(item => item.region === 'KR');
const US = companies.filter(item => item.region === 'US');

type Ready = Extract<CompanyHistory, { horizons: unknown }>;
function ready(body: CompanyHistory): Ready {
  if (body.status === 'off' || body.status === 'unavailable') throw new Error(`expected a ready-type answer, got ${body.status}`);
  return body;
}

// Numbers that occur nowhere else: a not-public answer must carry none of them.
const SENTINELS = ['0.123456', '0.654321', '0.0777777', '4321', '8765', '2025-01-02', 'Example News', 'example.com', 'Marketaux', '금융위원회', 'Massive'];

function caseStats(): CaseStats {
  return {
    cases: 12, nEff: 10, up: 6, neutral: 2, down: 4,
    returns: { median: 0.0777777, q1: 0.01, q3: 0.09, min: -0.05, max: 0.2, relativeMedian: 0.004 },
    period: { from: '2025-01-02', to: '2026-11-20' }, entryType: 'close', allWindows: { up: 0.48, down: 0.42 },
  };
}

function direction(unit: Horizon): DirectionStats {
  return {
    verdict: 'supports',
    sample: {
      unit, eventUnits: 24, otherUnits: 180, eventUp: 14, eventDown: 8, eventNeutral: 2, otherUp: 80, otherDown: 85, otherNeutral: 15,
      difference: 0.3888, ci90: [0.123456, 0.654321], from: '2025-01-02', to: '2026-11-20',
    },
    all: caseStats(),
    topics: [{ topic: 'earnings', cases: caseStats() }],
    examples: [{
      date: '2026-10-01', source: 'Example News', url: 'https://example.com/a', title: 'Example', entryDate: '2026-10-01', exitDate: '2026-10-02',
      r: 0.021, relative: 0.008,
    }],
  };
}

function companyStats(item: Company): CompanyStats {
  const kr = item.region === 'KR';
  return {
    version: 'news-history-v1', companyId: item.id, exchange: kr ? 'KRX' : 'NASDAQ', status: 'ready',
    horizons: {
      day: { directions: { positive: direction('day'), negative: direction('day') }, timeUnverifiedUnits: 0 },
      week: { directions: { positive: direction('week'), negative: direction('week') }, timeUnverifiedUnits: 3 },
    },
    coverage: { articles: 4321, events: 8765, usable: 98, excluded: { week_overlap: 7, case_recent: 5 }, observationGaps: 2 },
    dataAsOf: { computedAt: '2026-11-23T06:31:00.000Z', lastPriceDate: '2026-11-20', ledgerFrom: '2026-11-14T00:35:00.000Z', ledgerTo: '2026-11-23T05:00:00.000Z' },
    sources: {
      news: ['Marketaux', 'GDELT'],
      price: kr ? { label: '금융위원회 주식시세', adjustment: 'raw' } : { label: 'Massive(구 Polygon) 일봉', adjustment: 'split' },
    },
  };
}

function statsFile(list: readonly Company[] = companies, runId = 'run-1'): StatsFile {
  return {
    version: HISTORY_VERSIONS.stats, computedAt: '2026-11-23T06:31:00.000Z', runId,
    companies: Object.fromEntries(list.map(item => [item.id, companyStats(item)])), carriedOver: [],
  };
}

function storeWith(file: StatsFile | null, options: MemoryStoreOptions = {}): MemoryHistoryStore {
  const store = createMemoryHistoryStore(options);
  if (file) {
    assert.ok(parseStatsFile(JSON.parse(JSON.stringify(file))).ok, 'the fixture passes the store check');
    store.files.set('stats.json', { text: JSON.stringify(file), etag: '"stats-1"' });
  }
  return store;
}

function setup(markets: string | undefined, file: StatsFile | null = statsFile(), options: MemoryStoreOptions = {}) {
  const clock = { now: T0 };
  const store = storeWith(file, options);
  const env: NodeJS.ProcessEnv = { HISTORY_INSIGHTS: 'on', ...(markets === undefined ? {} : { HISTORY_PUBLIC_MARKETS: markets }) };
  const serve = createHistoryServe(env, { store, clock: () => clock.now });
  return { clock, store, env, serve };
}

// --- switches ---------------------------------------------------------------------

test('HISTORY_PUBLIC_MARKETS: comma separated, trimmed, any case; anything else is ignored and unset means none', () => {
  const list = (value: string | undefined) => [...parsePublicMarkets(value)].sort();
  assert.deepEqual(list(undefined), []);
  assert.deepEqual(list(''), []);
  assert.deepEqual(list(' , ,'), []);
  assert.deepEqual(list('KR'), ['KR']);
  assert.deepEqual(list('us'), ['US']);
  assert.deepEqual(list('kr, us ,XX'), ['KR', 'US']);
  assert.deepEqual(list('KR,KR'), ['KR']);
  assert.deepEqual(list('KRX;US'), []);
  assert.deepEqual(list('KOREA, U S'), []);
});

function analysisOf(status: NewsAnalysis['status'], extra: Partial<NewsAnalysis> = {}): NewsAnalysis {
  return {
    company: company('krx:000660'), status, articles: [], asOf: '2026-11-23T09:00:00.000Z', period: { start: '2026-11-16', end: '2026-11-23' },
    evidence: 'none', summary: '요약', positiveFactors: [], negativeFactors: [], risks: [], provider: 'Marketaux', analysisVersion: 'test',
    ...extra,
  };
}

test('the hint: a copy with historyAvailable only when on, for a ready or insufficient live result; the input never changes', () => {
  for (const status of ['ready', 'insufficient'] as const) {
    for (const servedFrom of [undefined, 'live'] as const) {
      const input = analysisOf(status, servedFrom ? { servedFrom } : {});
      const before = JSON.stringify(input);
      const out = withHistoryHint(input, 'on');
      assert.notEqual(out, input);
      assert.deepEqual(out, { ...input, historyAvailable: true });
      assert.equal(JSON.stringify(out), JSON.stringify({ ...input, historyAvailable: true }));
      assert.equal(JSON.stringify(input), before, 'the cached analysis is not changed');
      assert.equal('historyAvailable' in input, false);
    }
  }
  for (const status of ['error', 'rate_limited', 'not_configured'] as const) assert.equal(withHistoryHint(analysisOf(status), 'on').historyAvailable, undefined);
  const stale = analysisOf('ready', { servedFrom: 'stale' });
  assert.equal(withHistoryHint(stale, 'on'), stale, 'a stale result keeps its exact object');
  for (const mode of ['off', 'collect'] as const) {
    const input = analysisOf('ready');
    assert.equal(withHistoryHint(input, mode), input, mode);
  }
  const error = analysisOf('error');
  assert.equal(withHistoryHint(error, 'on'), error);
});

test('mode gate: anything but on answers off with the failure CDN and reads nothing; " ON " is on', async () => {
  for (const value of [undefined, '', 'off', 'collect', 'maybe', 'OFF', 'onn']) {
    const store = storeWith(statsFile());
    const env: NodeJS.ProcessEnv = { HISTORY_PUBLIC_MARKETS: 'KR,US', ...(value === undefined ? {} : { HISTORY_INSIGHTS: value }) };
    const serve = createHistoryServe(env, { store, clock: () => T0 });
    for (const item of companies) {
      const answer = await serve.answer(item);
      assert.deepEqual(answer, { body: { version: 'news-history-v1', companyId: item.id, status: 'off' }, cdnCacheControl: 'public, s-maxage=60' }, String(value));
    }
    assert.equal(store.reads.length, 0, String(value));
  }
  assert.equal(HISTORY_FAILURE_CDN, 'public, s-maxage=60');
  const on = createHistoryServe({ HISTORY_INSIGHTS: ' ON ' }, { store: storeWith(statsFile()), clock: () => T0 });
  assert.equal((await on.answer(company('krx:000660'))).body.status, 'stats_not_public');
});

// --- gating ---------------------------------------------------------------------------

test('no public market: every company, Hyundai included, answers stats_not_public with no number and no stats.json read', async () => {
  for (const markets of [undefined, '', ' ', 'XX, KOSPI']) {
    const { serve, store } = setup(markets);
    for (const item of companies) {
      const answer = await serve.answer(item);
      const body = ready(answer.body);
      assert.equal(body.status, 'stats_not_public', item.id);
      assert.equal(body.companyId, item.id);
      for (const h of ['day', 'week'] as const) {
        assert.equal(body.horizons[h].directions, null);
        assert.equal('sampleOrigin' in body.horizons[h], false);
      }
      assert.deepEqual(body.coverage, { articles: 0, events: 0, usable: 0, excluded: {}, observationGaps: 0 });
      assert.deepEqual(body.dataAsOf, { computedAt: new Date(T0).toISOString(), lastPriceDate: null, ledgerFrom: null, ledgerTo: null });
      assert.deepEqual(body.sources, { news: [], price: null });
      const text = JSON.stringify(body);
      for (const sentinel of SENTINELS) assert.ok(!text.includes(sentinel), `${item.id}: ${sentinel}`);
      assert.ok(parseCompanyHistory(JSON.parse(text)), 'the answer passes the contract parser');
      assert.match(answer.cdnCacheControl, /^public, s-maxage=\d+$/);
    }
    assert.equal(store.reads.length, 0, `markets ${JSON.stringify(markets)}`);
  }
  assert.ok(companies.some(item => item.id === 'krx:005380'), 'Hyundai is in the catalog and answered like the rest');
});

test('KR public: Korean companies get their statistics with sampleOrigin, US companies stay not public, one read', async () => {
  const { serve, store } = setup('KR');
  for (const item of KR) {
    const body = ready((await serve.answer(item)).body);
    const stats = companyStats(item);
    assert.equal(body.status, 'ready', item.id);
    assert.deepEqual(body.horizons.day.directions, stats.horizons.day.directions);
    assert.deepEqual(body.horizons.week.directions, stats.horizons.week.directions);
    assert.deepEqual(body.horizons.day.sampleOrigin, { backfillUnits: 0, includesBackfill: false, pointInTimeGuaranteed: true });
    assert.deepEqual(body.horizons.week.sampleOrigin, { backfillUnits: 3, includesBackfill: true, pointInTimeGuaranteed: false });
    assert.deepEqual(body.coverage, stats.coverage);
    assert.deepEqual(body.dataAsOf, stats.dataAsOf);
    assert.deepEqual(body.sources, stats.sources);
    const text = JSON.stringify(body);
    for (const sentinel of ['0.123456', '0.654321', '0.0777777', '4321', '8765']) assert.ok(text.includes(sentinel), `${item.id}: ${sentinel}`);
  }
  assert.ok(KR.some(item => item.id === 'krx:005380'));
  for (const item of US) {
    const body = ready((await serve.answer(item)).body);
    assert.equal(body.status, 'stats_not_public', item.id);
    for (const sentinel of SENTINELS) assert.ok(!JSON.stringify(body).includes(sentinel), `${item.id}: ${sentinel}`);
  }
  assert.deepEqual(store.reads, [{ file: 'stats.json', fresh: false }], 'one cached read for every company');
});

test('"kr, us ,XX" makes both markets public', async () => {
  const { serve, store } = setup('kr, us ,XX');
  for (const item of companies) assert.equal((await serve.answer(item)).body.status, 'ready', item.id);
  assert.equal(store.reads.length, 1);
});

test('statistics keep their own status: a public company without history or prices says so', async () => {
  const file = statsFile();
  for (const [id, status] of [['krx:005930', 'no_history'], ['nasdaq:AAPL', 'price_unavailable'], ['krx:035420', 'identity_unverified']] as const) {
    const stats = file.companies[id]!;
    stats.status = status;
    stats.horizons = { day: { directions: null, timeUnverifiedUnits: 0 }, week: { directions: null, timeUnverifiedUnits: 0 } };
  }
  const { serve } = setup('KR,US', file);
  for (const [id, status] of [['krx:005930', 'no_history'], ['nasdaq:AAPL', 'price_unavailable'], ['krx:035420', 'identity_unverified']] as const) {
    const answer = await serve.answer(company(id));
    const body = ready(answer.body);
    assert.equal(body.status, status, id);
    assert.equal(body.horizons.day.directions, null);
    assert.equal('sampleOrigin' in body.horizons.week, false);
    assert.match(answer.cdnCacheControl, /^public, s-maxage=\d+$/, 'every ready-type status uses the session-bound lifetime');
  }
});

test('validation is the fixed not_evaluated constant for both horizons, sent as fresh copies', async () => {
  assert.deepEqual(HISTORY_VALIDATION, {
    day: { status: 'not_evaluated', directions: [], markets: [], evaluatedAt: null },
    week: { status: 'not_evaluated', directions: [], markets: [], evaluatedAt: null },
  });
  for (const markets of ['', 'KR']) {
    const { serve } = setup(markets);
    const first = ready((await serve.answer(company('krx:000660'))).body);
    const second = ready((await serve.answer(company('krx:000660'))).body);
    for (const h of ['day', 'week'] as const) {
      assert.deepEqual(first.horizons[h].validation, HISTORY_VALIDATION[h]);
      assert.notEqual(first.horizons[h].validation, HISTORY_VALIDATION[h]);
      assert.notEqual(first.horizons[h].validation.directions, HISTORY_VALIDATION[h].directions);
      assert.notEqual(first.horizons[h].validation.markets, second.horizons[h].validation.markets);
    }
    first.horizons.day.validation.markets.push('KR');
    assert.deepEqual(HISTORY_VALIDATION.day.markets, [], 'changing an answer never changes the constant');
  }
});

// --- windows and CDN ----------------------------------------------------------------------

test('target and news windows are computed at request time and match the market calendar', async () => {
  const { serve, clock } = setup('');
  const windows = async (id: string) => {
    const body = ready((await serve.answer(company(id))).body);
    return { day: body.horizons.day.targetWindow, news: body.horizons.day.newsWindow, week: body.horizons.week.targetWindow, weekNews: body.horizons.week.newsWindow };
  };
  clock.now = T0;
  assert.deepEqual(await windows('krx:000660'), {
    day: { start: '2026-11-24', end: '2026-11-24', basis: 'exchange_calendar', exchange: 'KRX', phase: 'after_close' },
    news: { start: '2026-11-23T06:30:00.000Z', end: '2026-11-24T00:00:00.000Z' },
    week: { start: '2026-11-24', end: '2026-11-30', basis: 'exchange_calendar', exchange: 'KRX', phase: 'after_close' },
    weekNews: null,
  });
  assert.deepEqual(await windows('nasdaq:MSFT'), {
    day: { start: '2026-11-23', end: '2026-11-23', basis: 'exchange_calendar', exchange: 'NASDAQ', phase: 'before_open' },
    news: { start: '2026-11-20T21:00:00.000Z', end: '2026-11-23T14:30:00.000Z' },
    week: { start: '2026-11-23', end: '2026-11-30', basis: 'exchange_calendar', exchange: 'NASDAQ', phase: 'before_open' },
    weekNews: null,
  });
  clock.now = Date.parse('2026-11-24T00:30:00Z');
  const session = await windows('krx:005380');
  assert.deepEqual([session.day.start, session.day.end, session.day.phase], ['2026-11-24', '2026-11-24', 'in_session']);
  assert.deepEqual([session.week.start, session.week.end, session.week.phase], ['2026-11-25', '2026-12-01', 'in_session']);
  clock.now = Date.parse('2026-12-30T07:00:00Z');
  const yearEnd = await windows('krx:005930');
  assert.equal(yearEnd.day.basis, 'weekdays_only');
  assert.equal(yearEnd.week.basis, 'weekdays_only');
  // Every company at several clocks: exactly what the calendar computes for that instant.
  for (const at of ['2026-11-23T10:00:00Z', '2026-11-24T00:30:00Z', '2026-11-27T19:00:00Z', '2026-12-30T07:00:00Z', '2026-11-22T03:00:00Z']) {
    clock.now = Date.parse(at);
    for (const item of companies) {
      const exchange = item.region === 'KR' ? 'KRX' : 'NASDAQ';
      const got = await windows(item.id);
      const day = dayTargetWindow(exchange, clock.now);
      assert.deepEqual(got.day, day.targetWindow, `${at} ${item.id}`);
      assert.deepEqual(got.news, day.newsWindow, `${at} ${item.id}`);
      assert.deepEqual(got.week, weekTargetWindow(exchange, clock.now), `${at} ${item.id}`);
    }
  }
});

test('the CDN lifetime ends at the next open or close, between 30 s and an hour', async () => {
  assert.equal(historyCdnCacheControl('KRX', Date.parse('2026-11-23T10:00:00Z')), 'public, s-maxage=3600');
  assert.equal(historyCdnCacheControl('KRX', Date.parse('2026-11-23T23:50:00Z')), 'public, s-maxage=600');
  assert.equal(historyCdnCacheControl('KRX', Date.parse('2026-11-24T06:00:00Z')), 'public, s-maxage=1800');
  assert.equal(historyCdnCacheControl('KRX', Date.parse('2026-11-24T00:00:00Z') - 20_000), 'public, s-maxage=30');
  assert.equal(historyCdnCacheControl('KRX', Date.parse('2026-11-24T06:30:00Z') - 1), `public, s-maxage=${HISTORY_CDN_MIN_SECONDS}`);
  assert.equal(historyCdnCacheControl('NASDAQ', Date.parse('2026-11-23T14:00:00Z')), 'public, s-maxage=1800');
  assert.equal(historyCdnCacheControl('NASDAQ', Date.parse('2026-11-23T20:30:00Z')), 'public, s-maxage=1800', 'half an hour before the close');
  assert.equal(historyCdnCacheControl('KRX', Date.parse('2026-12-30T07:00:00Z')), `public, s-maxage=${HISTORY_CDN_MAX_SECONDS}`, 'weekdays_only basis');
  // After a close the lifetime runs to the next open: the local midnight on the way only turns after_close into
  // before_open, which the screen does not tell apart (same dates, same news window, not in session).
  const lateKrx = Date.parse('2026-11-23T14:30:00Z');
  assert.equal(historyCdnCacheControl('KRX', lateKrx), 'public, s-maxage=3600', 'KST 23:30');
  assert.deepEqual([dayTargetWindow('KRX', lateKrx).targetWindow.phase, dayTargetWindow('KRX', lateKrx + HOUR - 1).targetWindow.phase],
    ['after_close', 'before_open']);
  assert.equal(historyCdnCacheControl('NASDAQ', Date.parse('2026-11-24T04:30:00Z')), 'public, s-maxage=3600', 'EST 23:30');
  // The open instant: the phase already reads in_session while the week still starts with today, so it gets the minimum.
  const open = Date.parse('2026-11-24T00:00:00Z');
  assert.equal(historyCdnCacheControl('KRX', open), `public, s-maxage=${HISTORY_CDN_MIN_SECONDS}`, 'the open instant');
  assert.deepEqual([weekTargetWindow('KRX', open).start, weekTargetWindow('KRX', open + 1).start], ['2026-11-24', '2026-11-25']);
  assert.equal(historyCdnCacheControl('KRX', open + 1), 'public, s-maxage=3600');
  // Never past an open or a close: what the screen reads from the windows (dates, basis, the news window and whether
  // the session is open) holds for the whole lifetime unless it is the minimum.
  const shown = (exchange: Exchange, at: number) => {
    const { targetWindow: { phase: dayPhase, ...day }, newsWindow } = dayTargetWindow(exchange, at);
    const { phase: weekPhase, ...week } = weekTargetWindow(exchange, at);
    return { day, newsWindow, week, inSession: [dayPhase === 'in_session', weekPhase === 'in_session'] };
  };
  const holds = (exchange: Exchange, at: number) => {
    const seconds = Number(/s-maxage=(\d+)$/.exec(historyCdnCacheControl(exchange, at))![1]);
    assert.ok(seconds >= HISTORY_CDN_MIN_SECONDS && seconds <= HISTORY_CDN_MAX_SECONDS);
    if (seconds === HISTORY_CDN_MIN_SECONDS) return;
    assert.deepEqual(shown(exchange, at + seconds * 1000 - 1), shown(exchange, at), `${exchange} ${new Date(at).toISOString()}`);
  };
  // A weekend, the US Thanksgiving holiday and its early close included.
  for (let at = Date.parse('2026-11-20T00:00:00Z'); at < Date.parse('2026-11-28T00:00:00Z'); at += 13 * MIN) {
    for (const exchange of ['KRX', 'NASDAQ'] as const) holds(exchange, at);
  }
  for (const exchange of ['KRX', 'NASDAQ'] as const) {
    for (let date = '2026-11-20'; date <= '2026-11-30'; date = addDays(date, 1)) {
      const midnight = zonedTimeToUtc(date, '00:00', EXCHANGE_CALENDARS[exchange].timeZone);
      const session = sessionOn(exchange, date);
      const edges = [midnight - 1, midnight, midnight + 1];
      if (session && session !== CALENDAR_UNVERIFIED) {
        for (const edge of [session.openMs, session.closeMs]) edges.push(edge - 1_001, edge - 1, edge, edge + 1, edge + 1_001);
      }
      for (const at of edges) holds(exchange, at);
    }
  }
  // Through the serve: ready-type answers use it, off and unavailable the failure value.
  const { serve, clock, env } = setup('');
  clock.now = Date.parse('2026-11-24T06:00:00Z');
  assert.equal((await serve.answer(company('krx:000660'))).cdnCacheControl, 'public, s-maxage=1800');
  assert.equal((await serve.answer(company('nasdaq:MSFT'))).cdnCacheControl, 'public, s-maxage=3600');
  const unknown: Company = { id: 'nasdaq:ZZZZ', name: '테스트', symbol: 'ZZZZ', exchange: 'NASDAQ', region: 'US' };
  assert.equal((await serve.answer(unknown)).cdnCacheControl, HISTORY_FAILURE_CDN);
  env.HISTORY_INSIGHTS = 'collect';
  assert.equal((await serve.answer(company('krx:000660'))).cdnCacheControl, HISTORY_FAILURE_CDN, 'the switch is read per request');
});

// --- the stats reader -----------------------------------------------------------------------

test('stats reader: one read serves for an hour, the next happens at +1 h, and concurrent answers share one read', async () => {
  const { serve, store, clock } = setup('KR');
  const id = company('krx:000660');
  assert.equal((await serve.answer(id)).body.status, 'ready');
  clock.now = T0 + HISTORY_STATS_TTL_MS - 1;
  assert.equal((await serve.answer(id)).body.status, 'ready');
  assert.equal(store.reads.length, 1);
  clock.now = T0 + HISTORY_STATS_TTL_MS;
  assert.equal((await serve.answer(id)).body.status, 'ready');
  assert.equal(store.reads.length, 2);
  assert.equal(HISTORY_STATS_TTL_MS, HOUR);
  const fresh = setup('KR,US');
  const answers = await Promise.all(companies.map(item => fresh.serve.answer(item)));
  assert.deepEqual(answers.map(answer => answer.body.status), companies.map(() => 'ready'));
  assert.equal(fresh.store.reads.length, 1, 'eight concurrent answers, one read');
  assert.ok(fresh.store.reads.every(read => read.fresh === false), 'a cached read, never a fresh one');
});

test('stats reader: a missing file is unavailable, not read again for 60 s, then read again', async () => {
  const { serve, store, clock } = setup('KR', null);
  const id = company('krx:000660');
  assert.deepEqual(await serve.answer(id), { body: { version: 'news-history-v1', companyId: id.id, status: 'unavailable' }, cdnCacheControl: 'public, s-maxage=60' });
  clock.now = T0 + HISTORY_STATS_RETRY_MS - 1;
  assert.equal((await serve.answer(id)).body.status, 'unavailable');
  assert.equal(store.reads.length, 1);
  store.files.set('stats.json', { text: JSON.stringify(statsFile()), etag: '"stats-2"' });
  clock.now = T0 + HISTORY_STATS_RETRY_MS;
  assert.equal((await serve.answer(id)).body.status, 'ready');
  assert.equal(store.reads.length, 2);
  assert.equal(HISTORY_STATS_RETRY_MS, MIN);
});

test('stats reader: a failed read is unavailable for 60 s, then retried', async () => {
  let failing = true;
  const { serve, store, clock } = setup('US', statsFile(), { failRead: () => (failing ? 'timeout' : null) });
  const id = company('nasdaq:NVDA');
  const answer = await serve.answer(id);
  assert.deepEqual(answer, { body: { version: 'news-history-v1', companyId: id.id, status: 'unavailable' }, cdnCacheControl: HISTORY_FAILURE_CDN });
  clock.now = T0 + 30_000;
  assert.equal((await serve.answer(id)).body.status, 'unavailable');
  assert.equal(store.reads.length, 1);
  failing = false;
  clock.now = T0 + HISTORY_STATS_RETRY_MS;
  assert.equal((await serve.answer(id)).body.status, 'ready');
  assert.equal(store.reads.length, 2);
});

test('stats reader: after a good read, a failed or missing refresh keeps the last good file and retries 60 s later', async () => {
  let failing = false;
  const { serve, store, clock } = setup('KR', statsFile(KR, 'run-good'), { failRead: () => (failing ? 'unreadable' : null) });
  const id = company('krx:005380');
  assert.equal((await serve.answer(id)).body.status, 'ready');
  failing = true;
  clock.now = T0 + HISTORY_STATS_TTL_MS;
  const kept = await serve.answer(id);
  assert.equal(kept.body.status, 'ready', 'the old file is still served');
  assert.equal(store.reads.length, 2);
  clock.now = T0 + HISTORY_STATS_TTL_MS + HISTORY_STATS_RETRY_MS - 1;
  assert.equal((await serve.answer(id)).body.status, 'ready');
  assert.equal(store.reads.length, 2, 'no retry within 60 s');
  // The file is now missing: still the old file, and again 60 s before the next try.
  failing = false;
  store.files.delete('stats.json');
  clock.now = T0 + HISTORY_STATS_TTL_MS + HISTORY_STATS_RETRY_MS;
  assert.equal((await serve.answer(id)).body.status, 'ready');
  assert.equal(store.reads.length, 3);
  // A new file replaces the old one once read.
  const next = statsFile(KR, 'run-next');
  next.companies[id.id]!.coverage.articles = 5555;
  store.files.set('stats.json', { text: JSON.stringify(next), etag: '"stats-3"' });
  clock.now = T0 + HISTORY_STATS_TTL_MS + 2 * HISTORY_STATS_RETRY_MS;
  assert.equal(ready((await serve.answer(id)).body).coverage.articles, 5555);
  assert.equal(store.reads.length, 4);
});

test('stats reader on its own: null store counts as failed; refreshes after the retry window', async () => {
  let now = T0;
  let calls = 0;
  const reader = createStatsReader(() => { calls += 1; return null; }, () => now);
  assert.equal(await reader.read(), null);
  assert.equal(await reader.read(), null);
  assert.equal(calls, 1);
  now += HISTORY_STATS_RETRY_MS;
  assert.equal(await reader.read(), null);
  assert.equal(calls, 2);
  // A store whose read throws synchronously is a failure too, never a thrown answer.
  const throwing = { readStats() { throw new Error('boom'); } } as unknown as HistoryStore;
  const second = createStatsReader(() => throwing, () => now);
  assert.equal(await second.read(), null);
});

// --- unavailable ------------------------------------------------------------------------------

test('unavailable: a null store, a company missing from stats.json, a broken stats value, a company without prices', async () => {
  const unavailable = (id: string) => ({ body: { version: 'news-history-v1', companyId: id, status: 'unavailable' }, cdnCacheControl: 'public, s-maxage=60' });
  const none = createHistoryServe({ HISTORY_INSIGHTS: 'on', HISTORY_PUBLIC_MARKETS: 'KR' }, { store: null, clock: () => T0 });
  assert.deepEqual(await none.answer(company('krx:000660')), unavailable('krx:000660'));
  assert.equal((await none.answer(company('nasdaq:AAPL'))).body.status, 'stats_not_public', 'a not-public market needs no store');
  const partial = setup('KR,US', statsFile(US));
  assert.deepEqual(await partial.serve.answer(company('krx:000660')), unavailable('krx:000660'));
  assert.equal((await partial.serve.answer(company('nasdaq:AAPL'))).body.status, 'ready');
  // Values that never passed the store check: the self-check or the builder stops them.
  const broken = (mutate: (stats: Record<string, any>) => void): HistoryStore => {
    const file = statsFile() as unknown as Record<string, any>;
    mutate(file.companies['krx:000660']);
    return { readStats: async () => ({ value: file, etag: '"x"' }) } as unknown as HistoryStore;
  };
  for (const mutate of [
    (stats: Record<string, any>) => { stats.coverage.articles = -1; },
    (stats: Record<string, any>) => { stats.horizons.day.directions.positive.sample.ci90 = [0.9, 0.1]; },
    (stats: Record<string, any>) => { delete stats.horizons; },
    (stats: Record<string, any>) => { stats.dataAsOf = null; },
    (stats: Record<string, any>) => { stats.status = 'off'; },
  ]) {
    const serve = createHistoryServe({ HISTORY_INSIGHTS: 'on', HISTORY_PUBLIC_MARKETS: 'KR' }, { store: broken(mutate), clock: () => T0 });
    assert.deepEqual(await serve.answer(company('krx:000660')), unavailable('krx:000660'));
  }
  // A company outside the price catalogue has no exchange to compute windows for.
  const { serve } = setup('KR,US');
  const unknown: Company = { id: 'krx:999999', name: '테스트', symbol: '999999', exchange: 'KOSPI', region: 'KR' };
  assert.deepEqual(await serve.answer(unknown), unavailable('krx:999999'));
  // The clock throwing is a failure too, never a thrown answer.
  const badClock = createHistoryServe({ HISTORY_INSIGHTS: 'on' }, { store: null, clock: () => { throw new Error('clock'); } });
  assert.deepEqual(await badClock.answer(company('krx:000660')), unavailable('krx:000660'));
});

test('creation does no I/O; the Blob store is built on the first read only, inside try/catch, once', async () => {
  let touched = 0;
  const env = {
    HISTORY_INSIGHTS: 'on', HISTORY_PUBLIC_MARKETS: 'KR',
    get BLOB_READ_WRITE_TOKEN(): string { touched += 1; throw new Error('boom'); },
  } as NodeJS.ProcessEnv;
  let now = T0;
  const serve = createHistoryServe(env, { clock: () => now });
  assert.equal(touched, 0, 'nothing is read at creation');
  assert.equal((await serve.answer(company('nasdaq:AAPL'))).body.status, 'stats_not_public');
  assert.equal(touched, 0, 'a not-public market builds no store');
  assert.equal((await serve.answer(company('krx:000660'))).body.status, 'unavailable');
  assert.equal(touched, 1);
  now += HISTORY_STATS_RETRY_MS;
  assert.equal((await serve.answer(company('krx:000660'))).body.status, 'unavailable');
  assert.equal(touched, 1, 'memoised');
  // Without Blob credentials the default store is null: unavailable, no throw.
  const plain = createHistoryServe({ HISTORY_INSIGHTS: 'on', HISTORY_PUBLIC_MARKETS: 'KR' }, { clock: () => T0 });
  assert.equal((await plain.answer(company('krx:000660'))).body.status, 'unavailable');
});

test('buildCompanyHistory: windows from nowMs, statistics only for a public market, copies of the stats', () => {
  const item = company('krx:000660');
  const stats = companyStats(item);
  const nowMs = Date.parse('2026-11-24T00:30:00Z');
  const hidden = ready(buildCompanyHistory({ company: item, exchange: 'KRX', nowMs, publicMarkets: parsePublicMarkets(''), stats }));
  assert.equal(hidden.status, 'stats_not_public');
  assert.equal(hidden.horizons.day.directions, null);
  assert.equal(hidden.horizons.day.targetWindow.phase, 'in_session');
  assert.equal(hidden.dataAsOf.computedAt, '2026-11-24T00:30:00.000Z');
  const shown = ready(buildCompanyHistory({ company: item, exchange: 'KRX', nowMs, publicMarkets: parsePublicMarkets('KR'), stats }));
  assert.equal(shown.status, 'ready');
  assert.notEqual(shown.coverage, stats.coverage);
  assert.notEqual(shown.sources.news, stats.sources.news);
  assert.deepEqual(shown.horizons.week.targetWindow, weekTargetWindow('KRX', nowMs));
  assert.ok(parseCompanyHistory(JSON.parse(JSON.stringify(shown))));
  assert.deepEqual(buildCompanyHistory({ company: item, exchange: 'KRX', nowMs, publicMarkets: parsePublicMarkets('KR'), stats: null }),
    { version: 'news-history-v1', companyId: item.id, status: 'unavailable' });
});

// --- review: a week window on its own basis --------------------------------------------------------

test('CDN lifetime when the week falls back to weekdays_only while the day keeps the table: the earlier boundary ends it', async () => {
  // KRX 2026-12-24 after the close: the day target is 12-28 (12-25 is a holiday), but five sessions from 12-28 run past
  // the table's end (2026-12-31), so the week counts weekdays only, where 12-25 opens at 09:00 KST and moves the week.
  const morning = Date.parse('2026-12-24T23:15:00Z');
  assert.equal(dayTargetWindow('KRX', morning).targetWindow.basis, 'exchange_calendar');
  assert.equal(weekTargetWindow('KRX', morning).basis, 'weekdays_only');
  const weekdayOpen = Date.parse('2026-12-25T00:00:00Z');
  assert.deepEqual([weekTargetWindow('KRX', weekdayOpen).start, weekTargetWindow('KRX', weekdayOpen + 1).start], ['2026-12-25', '2026-12-28']);
  assert.equal(historyCdnCacheControl('KRX', morning), 'public, s-maxage=2700', 'until the weekday open, not the 12-28 one');
  assert.equal(historyCdnCacheControl('KRX', weekdayOpen - 20_000), `public, s-maxage=${HISTORY_CDN_MIN_SECONDS}`);
  assert.equal(historyCdnCacheControl('KRX', weekdayOpen), `public, s-maxage=${HISTORY_CDN_MIN_SECONDS}`);
  assert.equal(historyCdnCacheControl('KRX', weekdayOpen + 1), `public, s-maxage=${HISTORY_CDN_MAX_SECONDS}`);
  const { serve, clock } = setup('');
  clock.now = morning;
  assert.equal((await serve.answer(company('krx:000660'))).cdnCacheControl, 'public, s-maxage=2700', 'through the serve too');
  // Around the year end on both exchanges, at sweep steps and at every open and close of either basis: what the screen
  // reads (dates, bases, the news window, whether a session is open) holds for every lifetime above the minimum.
  const shown = (exchange: Exchange, at: number) => {
    const { targetWindow: { phase: dayPhase, ...day }, newsWindow } = dayTargetWindow(exchange, at);
    const { phase: weekPhase, ...week } = weekTargetWindow(exchange, at);
    return { day, newsWindow, week, inSession: [dayPhase === 'in_session', weekPhase === 'in_session'] };
  };
  const holds = (exchange: Exchange, at: number) => {
    const seconds = Number(/s-maxage=(\d+)$/.exec(historyCdnCacheControl(exchange, at))![1]);
    assert.ok(seconds >= HISTORY_CDN_MIN_SECONDS && seconds <= HISTORY_CDN_MAX_SECONDS);
    if (seconds === HISTORY_CDN_MIN_SECONDS) return;
    assert.deepEqual(shown(exchange, at + seconds * 1000 - 1), shown(exchange, at), `${exchange} ${new Date(at).toISOString()}`);
  };
  for (let at = Date.parse('2026-12-18T00:00:00Z'); at < Date.parse('2027-01-08T00:00:00Z'); at += 17 * MIN) {
    for (const exchange of ['KRX', 'NASDAQ'] as const) holds(exchange, at);
  }
  for (const exchange of ['KRX', 'NASDAQ'] as const) {
    for (let date = '2026-12-18'; date <= '2027-01-08'; date = addDays(date, 1)) {
      for (const basis of ['exchange_calendar', 'weekdays_only'] as const) {
        const session = sessionOn(exchange, date, basis);
        if (!session || session === CALENDAR_UNVERIFIED) continue;
        for (const edge of [session.openMs, session.closeMs]) {
          for (const at of [edge - HOUR, edge - 1_001, edge - 1, edge, edge + 1]) holds(exchange, at);
        }
      }
    }
  }
});
