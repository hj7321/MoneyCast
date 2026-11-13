import test from 'node:test';
import assert from 'node:assert/strict';
import { zonedTimeToUtc } from './market-calendar.js';
import {
  createMassivePriceProvider, MASSIVE_MAX_BODY, MASSIVE_MIN_GAP_MS, MASSIVE_ORIGIN, MASSIVE_REQUEST_CAP, massiveRequestUrl,
} from './price-massive.js';
import { fetchRange, priceIdentity, type PriceFetchRequest, type PriceIdentity } from './price-provider.js';
import { secretForms } from './price-wire.js';

// 2026-11-11 03:50 ET.
const NOW = Date.parse('2026-11-11T08:50:00Z');
const KEY = 'massive-fake-key-0123456789';
const AAPL = priceIdentity('nasdaq:AAPL')!;
const SPY = priceIdentity('arca:SPY')!;
const FAR = NOW + 3_600_000;

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
}
function harness(handler: Handler, env: Record<string, string | undefined> = { US_PRICE_API_KEY: KEY }, sleepSkew = 0) {
  let clock = NOW;
  const requests: { raw: string; url: URL; init: RequestInit; at: number }[] = [];
  const sleeps: number[] = [];
  const fetcher = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const raw = String(input);
    requests.push({ raw, url: new URL(raw), init: init ?? {}, at: clock });
    return handler(new URL(raw), init ?? {});
  }) as typeof fetch;
  const provider = createMassivePriceProvider(env, {
    fetcher, now: () => clock, sleep: async ms => { sleeps.push(ms); clock += ms > sleepSkew ? ms - sleepSkew : ms; },
  });
  return { provider, requests, sleeps };
}

const etMidnight = (date: string) => zonedTimeToUtc(date, '00:00', 'America/New_York');
const DATES = ['2026-11-05', '2026-11-06', '2026-11-09', '2026-11-10'];
function results(dates: string[]) {
  return dates.map((date, index) => ({ o: 100 + index, h: 110 + index, l: 90 + index, c: 101 + index, v: 1000, vw: 100, n: 10, t: etMidnight(date) }));
}
function aggs(ticker: string, rows: unknown[], extra: Record<string, unknown> = {}): Response {
  return json({ ticker, adjusted: true, queryCount: rows.length, resultsCount: rows.length, status: 'OK', request_id: 'req-1', results: rows, ...extra });
}
const request = (identity: PriceIdentity = AAPL): PriceFetchRequest => ({ identity, ...fetchRange(identity, null, NOW) });

test('Massive sends the key only as a Bearer header to the exact aggregates path', async () => {
  const massive = harness(url => aggs(url.pathname.split('/')[4]!, results(DATES)));
  const result = await massive.provider.fetch(request(), FAR);
  assert.equal(result.code, 'ok');
  assert.equal(result.providerCode, 'status:OK');
  const [{ raw, url, init }] = massive.requests;
  assert.equal(raw, `${MASSIVE_ORIGIN}/v2/aggs/ticker/AAPL/range/1/day/2024-11-12/2026-11-10?adjusted=true&sort=asc&limit=50000`);
  assert.equal(raw, massiveRequestUrl(request()));
  assert.equal(url.origin, MASSIVE_ORIGIN);
  assert.equal(init.method, 'GET');
  assert.equal(init.redirect, 'error');
  assert.deepEqual(init.headers, { Accept: 'application/json', Authorization: `Bearer ${KEY}` });
  for (const form of secretForms([KEY])) {
    assert.ok(!raw.includes(form), 'the key never goes in the URL');
    assert.ok(!JSON.stringify(result).includes(form));
  }
  assert.deepEqual(result.bars.map(bar => bar.date), DATES);
  assert.ok(result.bars.every(bar => bar.adjClose === bar.close), 'adjClose equals close');
  assert.deepEqual(result.bars[0], { date: '2026-11-05', open: 100, high: 110, low: 90, close: 101, volume: 1000, adjClose: 101 });
});

test('Massive starts requests at least 13 s apart, even when a timer ends a millisecond early', async () => {
  const massive = harness(url => aggs(url.pathname.split('/')[4]!, []), undefined, 1);
  for (const key of ['arca:SPY', 'nasdaq:AAPL', 'nasdaq:NVDA']) {
    assert.equal((await massive.provider.fetch(request(priceIdentity(key)!), FAR)).code, 'ok');
  }
  assert.equal(massive.requests.length, 3);
  for (let index = 1; index < massive.requests.length; index += 1) {
    assert.ok(massive.requests[index]!.at - massive.requests[index - 1]!.at >= MASSIVE_MIN_GAP_MS);
  }
  assert.deepEqual(massive.sleeps, [MASSIVE_MIN_GAP_MS, 1, MASSIVE_MIN_GAP_MS, 1]);
});

test('Massive caps requests per instance and skips a request that cannot end by the deadline', async () => {
  const massive = harness(url => aggs(url.pathname.split('/')[4]!, []));
  const codes: string[] = [];
  for (let index = 0; index < MASSIVE_REQUEST_CAP + 1; index += 1) codes.push((await massive.provider.fetch(request(), FAR * 10)).code);
  assert.equal(massive.requests.length, MASSIVE_REQUEST_CAP);
  assert.equal(codes.at(-1), 'skipped_budget');
  const tight = harness(url => aggs(url.pathname.split('/')[4]!, []));
  assert.equal((await tight.provider.fetch(request(), NOW + 10_000)).code, 'skipped_budget');
  assert.equal(tight.requests.length, 0);
});

test('Massive reports next_url or a short result list as truncated and never follows it', async () => {
  const next = harness(() => aggs('AAPL', results(DATES), { next_url: 'https://api.massive.com/v2/aggs/ticker/AAPL/range/1/day/x?cursor=abc' }));
  const result = await next.provider.fetch(request(), FAR);
  assert.equal(result.code, 'truncated');
  assert.deepEqual(result.bars, []);
  assert.equal(next.requests.length, 1);
  const short = harness(() => aggs('AAPL', results(DATES), { resultsCount: 9 }));
  assert.equal((await short.provider.fetch(request(), FAR)).code, 'truncated');
});

test('Massive response checks: adjusted, ticker, midnight timestamps and the calendar', async () => {
  const cases: [string, Handler, string][] = [
    ['adjusted:false', () => aggs('AAPL', results(DATES), { adjusted: false }), 'not_adjusted'],
    ['ticker', () => aggs('AAPLX', results(DATES)), 'identity_mismatch'],
    ['non-midnight t', () => aggs('AAPL', [...results(DATES), { ...results(['2026-11-04'])[0], t: etMidnight('2026-11-04') + 3_600_000 }]), 'bad_timestamp'],
    ['nanosecond t', () => aggs('AAPL', [{ ...results(['2026-11-04'])[0], t: etMidnight('2026-11-04') * 1e6 }]), 'bad_timestamp'],
    ['holiday', () => aggs('AAPL', results([...DATES, '2026-11-26'])), 'calendar_mismatch'],
    ['weekend', () => aggs('AAPL', results(['2026-11-07'])), 'calendar_mismatch'],
    ['status', () => json({ status: 'ERROR', ticker: 'AAPL', adjusted: true, results: [] }), 'provider_error'],
    ['not json', () => new Response('<html>', { status: 200 }), 'bad_json'],
    ['array', () => json([1, 2]), 'bad_json'],
  ];
  for (const [name, handler, code] of cases) {
    const massive = harness(handler);
    const result = await massive.provider.fetch(request(), FAR);
    assert.equal(result.code, code, name);
    assert.deepEqual(result.bars, [], name);
  }
  const delayed = harness(() => aggs('AAPL', results(DATES), { status: 'DELAYED' }));
  assert.equal((await delayed.provider.fetch(request(), FAR)).code, 'ok');
  const failed = harness(() => json({ status: 'ERROR' }));
  assert.equal((await failed.provider.fetch(request(), FAR)).providerCode, 'status:ERROR');
});

test('Massive drops malformed, not-yet-closed and uncovered bars and flags odd ones', async () => {
  const today = results(['2026-11-11'])[0]!;
  const massive = harness(() => aggs('AAPL', [
    ...results(['2026-11-09']), { ...results(['2026-11-10'])[0], c: 0 }, { ...today, t: etMidnight('2026-11-11') },
    { ...results(['2019-12-31'])[0] }, { ...results(['2026-11-06'])[0], v: undefined, o: 0 }, 'junk',
  ]));
  const result = await massive.provider.fetch(request(), FAR);
  assert.equal(result.code, 'ok');
  assert.deepEqual(result.bars.map(bar => bar.date), ['2026-11-06', '2026-11-09']);
  assert.deepEqual(result.bars[0]!.flags, ['zero_open', 'zero_volume', 'out_of_range', 'missing_field']);
  assert.equal(result.counts.malformed, 2);
  assert.equal(result.counts.notClosed, 1);
  assert.equal(result.counts.outsideValidity, 1);
  assert.equal(result.counts.flagged, 1);
  assert.equal(result.counts.rows, 6);
});

test('Massive 401 and 429 stop the provider; 403 does not', async () => {
  for (const status of [401, 429]) {
    const massive = harness(() => json({ status: 'ERROR' }, status));
    assert.equal((await massive.provider.fetch(request(), FAR)).code, `http_${status}`);
    assert.equal((await massive.provider.fetch(request(SPY), FAR)).code, 'stopped');
    assert.equal(massive.requests.length, 1);
  }
  const forbidden = harness(() => json({ status: 'NOT_AUTHORIZED' }, 403));
  const first = await forbidden.provider.fetch(request(), FAR);
  assert.equal(first.code, 'http_403');
  assert.equal(first.providerCode, 'status:NOT_AUTHORIZED');
  assert.equal((await forbidden.provider.fetch(request(SPY), FAR)).code, 'http_403');
  assert.equal(forbidden.requests.length, 2);
});

test('Massive discards echoed keys and oversized bodies, and maps thrown fetches to network', async () => {
  const echo = harness(() => json({ status: 'ERROR', error: `Unknown API Key ${KEY}` }, 401));
  const echoed = await echo.provider.fetch(request(), FAR);
  assert.equal(echoed.code, 'echoed_secret');
  assert.equal(echoed.providerCode, null);
  const echoOk = harness(() => aggs('AAPL', results(DATES), { request_id: `Bearer ${KEY}` }));
  assert.equal((await echoOk.provider.fetch(request(), FAR)).code, 'echoed_secret');
  const big = harness(() => aggs('AAPL', [], { pad: 'x'.repeat(MASSIVE_MAX_BODY) }));
  assert.equal((await big.provider.fetch(request(), FAR)).code, 'too_large');
  const thrown = harness(() => { throw new Error(`connect failed Authorization: Bearer ${KEY}`); });
  const network = await thrown.provider.fetch(request(), FAR);
  assert.equal(network.code, 'network');
  for (const form of secretForms([KEY])) {
    assert.ok(!JSON.stringify([echoed, network]).includes(form));
  }
});

test('Massive refuses unsafe settings, a missing key and a foreign identity without a request', async () => {
  for (const [env, identity, code] of [
    [{ US_PRICE_API_KEY: KEY, NODE_DEBUG: 'net' }, AAPL, 'unsafe_env'],
    [{ US_PRICE_API_KEY: KEY, NODE_TLS_REJECT_UNAUTHORIZED: '0' }, AAPL, 'unsafe_env'],
    [{ US_PRICE_API_KEY: '' }, AAPL, 'not_configured'],
    [{ US_PRICE_API_KEY: KEY }, priceIdentity('krx:005930')!, 'identity_mismatch'],
  ] as const) {
    const massive = harness(() => aggs('AAPL', []), env);
    assert.equal((await massive.provider.fetch({ ...request(), identity }, FAR)).code, code);
    assert.equal(massive.requests.length, 0);
  }
});
