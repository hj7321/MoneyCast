import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  companies, parseCompanyHistory,
  type CaseStats, type Company, type CompanyHistory, type DirectionStats, type Horizon, type NewsAnalysis,
} from '@moneycast/core';
import { createApiHandler } from '../api/index.js';
import { createApp, createRequestHandler } from './app.js';
import { createHistoryServe, type HistoryAnswer, type HistoryServe } from './history-serve.js';
import type { CompanyStats } from './history-stats.js';
import { HISTORY_VERSIONS, createMemoryHistoryStore, type MemoryHistoryStore, type StatsFile } from './history-store.js';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-23T10:00:00Z');
const clock = () => NOW;
const ERROR_TEXT = '검색 결과에서 회사와 거래소를 선택해 주세요.';
const company = (id: string): Company => companies.find(item => item.id === id)!;
type NewsService = Parameters<typeof createRequestHandler>[0];

async function listen(t: test.TestContext, server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function analysisOf(item: Company, extra: Partial<NewsAnalysis> = {}): NewsAnalysis {
  return {
    company: item, status: 'ready', articles: [], asOf: new Date(NOW - HOUR).toISOString(), period: { start: '2026-11-16', end: '2026-11-23' },
    evidence: 'low', summary: '요약', positiveFactors: ['실적 개선'], negativeFactors: [], risks: ['변동성'], provider: 'Marketaux',
    analysisVersion: 'news-evidence-v3', newsWindow: { start: new Date(NOW - 7 * 24 * HOUR).toISOString(), end: new Date(NOW - HOUR).toISOString() },
    cachedUntil: new Date(NOW + 5 * HOUR).toISOString(), servedFrom: 'live',
    sources: [{ id: 'marketaux', label: 'Marketaux', status: 'ok', articleCount: 0 }],
    ...extra,
  };
}

/** One shared fake news service: every handler serves the very same cached object. */
function fakeNews(make: (item: Company) => NewsAnalysis = item => analysisOf(item)) {
  const cached = new Map<string, NewsAnalysis>();
  const calls: string[] = [];
  const service = {
    getAnalysis: async (item: Company) => {
      calls.push(item.id);
      if (!cached.has(item.id)) cached.set(item.id, make(item));
      return cached.get(item.id)!;
    },
  } as unknown as NewsService;
  return { service, cached, calls };
}

/** A history serve that must never be asked. */
function spyServe(answer?: (item: Company) => HistoryAnswer) {
  const calls: string[] = [];
  const serve: HistoryServe = {
    async answer(item) {
      calls.push(item.id);
      if (!answer) throw new Error('must not be asked');
      return answer(item);
    },
  };
  return { serve, calls };
}

// Numbers and names that occur only in stats.json.
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
    examples: [{ date: '2026-10-01', source: 'Example News', url: 'https://example.com/a', entryDate: '2026-10-01', exitDate: '2026-10-02', r: 0.021, relative: 0.008 }],
  };
}

function statsFile(): StatsFile {
  const entry = (item: Company): CompanyStats => ({
    version: 'news-history-v1', companyId: item.id, exchange: item.region === 'KR' ? 'KRX' : 'NASDAQ', status: 'ready',
    horizons: {
      day: { directions: { positive: direction('day'), negative: direction('day') }, timeUnverifiedUnits: 0 },
      week: { directions: { positive: direction('week'), negative: direction('week') }, timeUnverifiedUnits: 2 },
    },
    coverage: { articles: 4321, events: 8765, usable: 98, excluded: { week_overlap: 7 }, observationGaps: 2 },
    dataAsOf: { computedAt: '2026-11-23T06:31:00.000Z', lastPriceDate: '2026-11-20', ledgerFrom: '2026-11-14T00:35:00.000Z', ledgerTo: '2026-11-23T05:00:00.000Z' },
    sources: {
      news: ['Marketaux', 'GDELT'],
      price: item.region === 'KR' ? { label: '금융위원회 주식시세', adjustment: 'raw' } : { label: 'Massive(구 Polygon) 일봉', adjustment: 'split' },
    },
  });
  return {
    version: HISTORY_VERSIONS.stats, computedAt: '2026-11-23T06:31:00.000Z', runId: 'run-1',
    companies: Object.fromEntries(companies.map(item => [item.id, entry(item)])), carriedOver: [],
  };
}

function statsStore(): MemoryHistoryStore {
  const store = createMemoryHistoryStore();
  store.files.set('stats.json', { text: JSON.stringify(statsFile()), etag: '"stats-1"' });
  return store;
}

const newsPath = (id: string) => `/api/news?companyId=${encodeURIComponent(id)}`;
const historyPath = (id: string) => `/api/news/history?companyId=${encodeURIComponent(id)}`;

async function snapshot(response: Response): Promise<string> {
  return JSON.stringify([response.status, response.headers.get('cache-control'), response.headers.get('vercel-cdn-cache-control'), await response.text()]);
}

// --- /api/news: the hint ------------------------------------------------------------------

test('/api/news is byte for byte unchanged unless HISTORY_INSIGHTS is on; on adds only historyAvailable to a copy', async t => {
  const news = fakeNews();
  const spy = spyServe();
  const store = statsStore();
  const seen = new Set<string>();
  for (const value of [undefined, 'off', 'collect', 'maybe']) {
    const env: NodeJS.ProcessEnv = { HISTORY_PUBLIC_MARKETS: 'KR,US', ...(value === undefined ? {} : { HISTORY_INSIGHTS: value }) };
    const base = await listen(t, createApp(news.service, { staticDirectory: null, env, clock, historyServe: spy.serve }));
    seen.add(await snapshot(await fetch(`${base}${newsPath('krx:000660')}`)));
  }
  assert.equal(seen.size, 1, 'off, collect, unset and unknown values answer identically');
  const original = news.cached.get('krx:000660')!;
  const [status, cacheControl, cdn, text] = JSON.parse([...seen][0]!) as [number, string, string, string];
  assert.deepEqual([status, cacheControl, cdn], [200, 'no-store', 'public, s-maxage=18000']);
  assert.equal(text, JSON.stringify(original));
  // On: the same headers, and the body is the original plus the hint, nothing else.
  const onServe = createHistoryServe({ HISTORY_INSIGHTS: 'on', HISTORY_PUBLIC_MARKETS: 'KR,US' }, { store, clock });
  const on = await listen(t, createApp(news.service, {
    staticDirectory: null, env: { HISTORY_INSIGHTS: 'on', HISTORY_PUBLIC_MARKETS: 'KR,US' }, clock, historyServe: onServe,
  }));
  const response = await fetch(`${on}${newsPath('krx:000660')}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), cacheControl);
  assert.equal(response.headers.get('vercel-cdn-cache-control'), cdn);
  const hinted = await response.text();
  assert.deepEqual(JSON.parse(hinted), { ...original, historyAvailable: true });
  assert.equal(hinted, JSON.stringify({ ...original, historyAvailable: true }));
  // The cached analysis was never changed, nothing read stats.json and the history serve was never asked.
  assert.equal('historyAvailable' in original, false);
  assert.equal(store.reads.length, 0);
  assert.deepEqual(spy.calls, []);
  assert.deepEqual(news.calls, Array.from({ length: 5 }, () => 'krx:000660'));
});

test('/api/news gets no hint when on for an error, rate limit, missing setup or a stale result; insufficient gets it', async t => {
  const cases: Array<[string, Partial<NewsAnalysis>, boolean]> = [
    ['krx:005930', { status: 'error', positiveFactors: [], cachedUntil: undefined }, false],
    ['krx:035420', { status: 'rate_limited', positiveFactors: [], cachedUntil: undefined, retryAt: new Date(NOW + HOUR).toISOString() }, false],
    ['krx:005380', { status: 'not_configured', positiveFactors: [], cachedUntil: undefined }, false],
    ['nasdaq:AAPL', { servedFrom: 'stale', refreshAttemptedAt: new Date(NOW).toISOString() }, false],
    ['nasdaq:NVDA', { status: 'insufficient', positiveFactors: [] }, true],
    ['nasdaq:MSFT', {}, true],
  ];
  const news = fakeNews(item => analysisOf(item, cases.find(([id]) => id === item.id)?.[1] ?? {}));
  const store = statsStore();
  const env = { HISTORY_INSIGHTS: 'on', HISTORY_PUBLIC_MARKETS: 'KR,US' };
  const base = await listen(t, createApp(news.service, { staticDirectory: null, env, clock, historyServe: createHistoryServe(env, { store, clock }) }));
  for (const [id, , hinted] of cases) {
    const text = await (await fetch(`${base}${newsPath(id)}`)).text();
    const original = news.cached.get(id)!;
    assert.equal(text, JSON.stringify(hinted ? { ...original, historyAvailable: true } : original), id);
    assert.equal('historyAvailable' in original, false, `${id}: the cached object is unchanged`);
  }
  assert.equal(store.reads.length, 0, '/api/news never reads stats.json');
});

// --- /api/news/history ------------------------------------------------------------------------

test('/api/news/history: off unless on, 400 like /api/news for an unknown or missing company, 405 for other methods', async t => {
  const news = fakeNews();
  for (const value of [undefined, 'off', 'collect', 'maybe']) {
    const store = statsStore();
    const env: NodeJS.ProcessEnv = { HISTORY_PUBLIC_MARKETS: 'KR,US', ...(value === undefined ? {} : { HISTORY_INSIGHTS: value }) };
    const base = await listen(t, createApp(news.service, { staticDirectory: null, env, clock, historyServe: createHistoryServe(env, { store, clock }) }));
    for (const item of companies) {
      const response = await fetch(`${base}${historyPath(item.id)}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('vercel-cdn-cache-control'), 'public, s-maxage=60');
      assert.deepEqual(await response.json(), { version: 'news-history-v1', companyId: item.id, status: 'off' }, `${String(value)} ${item.id}`);
    }
    assert.equal(store.reads.length, 0, String(value));
  }
  const base = await listen(t, createApp(news.service, { staticDirectory: null, env: { HISTORY_INSIGHTS: 'on' }, clock }));
  for (const path of ['/api/news/history?companyId=UNKNOWN', '/api/news/history', '/api/news/history?companyId=', '/api/news/history?companyId=krx%3A000660x']) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 400, path);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('vercel-cdn-cache-control'), 'no-store');
    assert.match(response.headers.get('content-type')!, /application\/json/);
    assert.deepEqual(await response.json(), { error: ERROR_TEXT }, path);
  }
  // The news route answers the same way.
  assert.deepEqual(await (await fetch(`${base}/api/news?companyId=UNKNOWN`)).json(), { error: ERROR_TEXT });
  for (const method of ['POST', 'PUT', 'DELETE']) {
    assert.equal((await fetch(`${base}${historyPath('krx:000660')}`, { method })).status, 405, method);
  }
  assert.deepEqual(news.calls, [], 'the history route never asks the news service');
});

test('/api/news/history with no public market: every company is stats_not_public, carries no statistic and reads nothing', async t => {
  const store = statsStore();
  const env = { HISTORY_INSIGHTS: 'on' };
  const base = await listen(t, createApp(fakeNews().service, { staticDirectory: null, env, clock, historyServe: createHistoryServe(env, { store, clock }) }));
  for (const item of companies) {
    const response = await fetch(`${base}${historyPath(item.id)}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('vercel-cdn-cache-control')!, /^public, s-maxage=\d+$/);
    const text = await response.text();
    for (const sentinel of SENTINELS) assert.ok(!text.includes(sentinel), `${item.id}: ${sentinel}`);
    const body = parseCompanyHistory(JSON.parse(text)) as Extract<CompanyHistory, { horizons: unknown }>;
    assert.ok(body, item.id);
    assert.equal(body.status, 'stats_not_public', item.id);
    assert.equal(body.horizons.day.directions, null);
    assert.equal(body.horizons.week.directions, null);
    assert.equal('sampleOrigin' in body.horizons.day || 'sampleOrigin' in body.horizons.week, false);
    assert.deepEqual(body.coverage, { articles: 0, events: 0, usable: 0, excluded: {}, observationGaps: 0 });
    assert.deepEqual(body.dataAsOf, { computedAt: new Date(NOW).toISOString(), lastPriceDate: null, ledgerFrom: null, ledgerTo: null });
    assert.deepEqual(body.sources, { news: [], price: null });
  }
  assert.equal(store.reads.length, 0);
  // At 10:00Z KRX has closed (next open 00:00Z) and NASDAQ opens at 14:30Z: both an hour.
  for (const id of ['krx:005380', 'nasdaq:TSLA']) {
    assert.equal((await fetch(`${base}${historyPath(id)}`)).headers.get('vercel-cdn-cache-control'), 'public, s-maxage=3600', id);
  }
});

test('/api/news/history with KR public: Korean statistics, US still not public, one stats.json read', async t => {
  const store = statsStore();
  const env = { HISTORY_INSIGHTS: 'on', HISTORY_PUBLIC_MARKETS: 'KR' };
  const base = await listen(t, createApp(fakeNews().service, { staticDirectory: null, env, clock, historyServe: createHistoryServe(env, { store, clock }) }));
  for (const item of companies) {
    const text = await (await fetch(`${base}${historyPath(item.id)}`)).text();
    const body = parseCompanyHistory(JSON.parse(text)) as Extract<CompanyHistory, { horizons: unknown }>;
    if (item.region === 'KR') {
      assert.equal(body.status, 'ready', item.id);
      assert.ok(text.includes('0.123456') && text.includes('4321'), item.id);
      assert.deepEqual(body.horizons.week.sampleOrigin, { backfillUnits: 2, includesBackfill: true, pointInTimeGuaranteed: false });
    } else {
      assert.equal(body.status, 'stats_not_public', item.id);
      for (const sentinel of SENTINELS) assert.ok(!text.includes(sentinel), `${item.id}: ${sentinel}`);
    }
  }
  assert.deepEqual(store.reads, [{ file: 'stats.json', fresh: false }]);
});

test('/api/news/history failures: unavailable with the 60 s CDN and the no-store browser header', async t => {
  // A public market without a store (no Blob credentials): unavailable, never a 500.
  const env = { HISTORY_INSIGHTS: 'on', HISTORY_PUBLIC_MARKETS: 'KR,US' };
  const base = await listen(t, createApp(fakeNews().service, { staticDirectory: null, env, clock }));
  for (const item of companies) {
    const response = await fetch(`${base}${historyPath(item.id)}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('vercel-cdn-cache-control'), 'public, s-maxage=60');
    assert.deepEqual(await response.json(), { version: 'news-history-v1', companyId: item.id, status: 'unavailable' });
  }
  // A store that fails: unavailable too.
  const failing = createMemoryHistoryStore({ failRead: () => 'unreadable' });
  const failed = await listen(t, createApp(fakeNews().service, { staticDirectory: null, env, clock, historyServe: createHistoryServe(env, { store: failing, clock }) }));
  const response = await fetch(`${failed}${historyPath('nasdaq:AAPL')}`);
  assert.equal(response.headers.get('vercel-cdn-cache-control'), 'public, s-maxage=60');
  assert.equal((await response.json()).status, 'unavailable');
});

test('no /api/news/history request makes an outside call', async t => {
  const realFetch = globalThis.fetch;
  const outside: string[] = [];
  t.mock.method(globalThis, 'fetch', (async (input: Parameters<typeof fetch>[0]) => {
    outside.push(input instanceof Request ? input.url : String(input));
    throw new Error('no network in tests');
  }) as typeof fetch);
  const envs: NodeJS.ProcessEnv[] = [
    {}, { HISTORY_INSIGHTS: 'collect' }, { HISTORY_INSIGHTS: 'on' }, { HISTORY_INSIGHTS: 'on', HISTORY_PUBLIC_MARKETS: 'KR' },
    { HISTORY_INSIGHTS: 'on', HISTORY_PUBLIC_MARKETS: 'KR,US' },
  ];
  const statuses = new Set<string>();
  for (const env of envs) {
    for (const historyServe of [undefined, createHistoryServe(env, { store: statsStore(), clock })]) {
      const base = await listen(t, createApp(fakeNews().service, { staticDirectory: null, env, clock, ...(historyServe ? { historyServe } : {}) }));
      for (const item of companies) {
        const response = await realFetch(`${base}${historyPath(item.id)}`);
        assert.equal(response.status, 200);
        statuses.add((await response.json()).status);
      }
      assert.equal((await realFetch(`${base}/api/news/history?companyId=UNKNOWN`)).status, 400);
    }
  }
  assert.deepEqual([...statuses].sort(), ['off', 'ready', 'stats_not_public', 'unavailable']);
  assert.deepEqual(outside, []);
});

// --- the serverless entry ----------------------------------------------------------------------

test('the serverless entry routes news/history, on the public and the rewritten URL, with an injected serve too', async t => {
  const news = fakeNews();
  const plain = await listen(t, createServer(createApiHandler(news.service, { HISTORY_INSIGHTS: 'on' })));
  for (const path of [`/api/index?__moneycast_route=news/history&companyId=krx%3A000660`, historyPath('krx:000660')]) {
    const response = await fetch(`${plain}${path}`);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.deepEqual([body.companyId, body.status], ['krx:000660', 'stats_not_public'], path);
  }
  assert.equal((await fetch(`${plain}/api/index?__moneycast_route=news/history`)).status, 400);
  assert.equal((await fetch(`${plain}/api/index?__moneycast_route=news/history&companyId=krx%3A000660`, { method: 'POST' })).status, 405);
  // The hint through the entry, and the news route there is unchanged otherwise.
  const hinted = await (await fetch(`${plain}/api/index?__moneycast_route=news&companyId=krx%3A000660`)).json();
  assert.equal(hinted.historyAvailable, true);
  const off = await listen(t, createServer(createApiHandler(news.service, {})));
  assert.deepEqual(await (await fetch(`${off}/api/index?__moneycast_route=news/history&companyId=krx%3A000660`)).json(),
    { version: 'news-history-v1', companyId: 'krx:000660', status: 'off' });
  assert.equal('historyAvailable' in (await (await fetch(`${off}/api/index?__moneycast_route=news&companyId=krx%3A000660`)).json()), false);
  // An injected serve is the one asked, and its CDN value is sent as given.
  const spy = spyServe(item => ({ body: { version: 'news-history-v1', companyId: item.id, status: 'unavailable' }, cdnCacheControl: 'public, s-maxage=45' }));
  const injected = await listen(t, createServer(createApiHandler(news.service, { HISTORY_INSIGHTS: 'on' }, { historyServe: spy.serve })));
  const response = await fetch(`${injected}/api/index?__moneycast_route=news/history&companyId=nasdaq%3AMSFT`);
  assert.equal(response.headers.get('vercel-cdn-cache-control'), 'public, s-maxage=45');
  assert.deepEqual(await response.json(), { version: 'news-history-v1', companyId: 'nasdaq:MSFT', status: 'unavailable' });
  assert.deepEqual(spy.calls, ['nasdaq:MSFT']);
  // A route that is not on the list is still a 404.
  assert.equal((await fetch(`${injected}/api/index?__moneycast_route=news/historyx&companyId=nasdaq%3AMSFT`)).status, 404);
});
