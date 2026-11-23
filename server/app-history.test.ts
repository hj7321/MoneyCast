import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { format } from 'node:util';
import { BlobError, BlobNotFoundError, type get as blobGet, type head as blobHead, type put as blobPut } from '@vercel/blob';
import { companies, isNewsAnalysis } from '@moneycast/core';
import { createApiHandler } from '../api/index.js';
import { createApp, HISTORY_LEDGER_SCHEDULES } from './app.js';
import {
  createHistoryService, HISTORY_RUN_LOG_MAX_CHARS, type HistoryJobMode, type HistoryJobStatus, type HistoryJobSummary, type HistoryService,
} from './history-job.js';
import { createBlobHistoryStore, createMemoryHistoryStore } from './history-store.js';
import { FETCH_ORDER, createPriceProviders } from './price-provider.js';
import { createRedactor } from './price-wire.js';
import { ProviderError } from './provider.js';
import { createNewsService } from './service.js';

const SECRET = 'fixture-cron-secret-never-real';
const FSC_KEY = 'fixture-kr-price-key-never-real';
const US_KEY = 'fixture-us-price-key-never-real';
const AUTH = { authorization: `Bearer ${SECRET}` };

function summaryOf(mode: HistoryJobMode, status: HistoryJobStatus): HistoryJobSummary {
  return {
    status, mode, runId: 'run-1', startedAt: '2026-11-11T06:20:00.000Z', finishedAt: '2026-11-11T06:21:00.000Z', elapsedMs: 60_000, errors: [],
    ledger: { head: null, segmentsRead: 0, entries: 0, newEntries: 0, changedEntries: 0, outcomePatches: 0, rejectedEntries: 0,
      snapshots: { read: [], missing: [], unreadable: [] }, gapsAdded: [], rolledOver: false },
    prices: null, stats: null, frozen: null, shadow: null,
    writes: { cap: 8, usedBefore: 0, allowance: 0, done: [], deferred: [], failed: [] },
  };
}

function spy(status: HistoryJobStatus = 'done') {
  const runs: HistoryJobMode[] = [];
  const service: HistoryService & { status: HistoryJobStatus } = {
    status,
    async run(mode) { runs.push(mode); return summaryOf(mode, service.status); },
  };
  return { service, runs };
}

const newsService = () => createNewsService({ getArticles: async () => { throw new ProviderError('not_configured'); } });

async function listen(t: test.TestContext, server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const CONSOLE_METHODS = ['log', 'error', 'warn', 'info', 'debug', 'trace'] as const;
type LogLine = { stream: typeof CONSOLE_METHODS[number]; text: string };
/**
 * The history route logs one line per run. Everything written through the console is captured as it would print
 * (and kept out of the test output) until the test ends.
 */
function captureLogs(t: test.TestContext): LogLine[] {
  const lines: LogLine[] = [];
  for (const stream of CONSOLE_METHODS) {
    t.mock.method(console, stream, (...args: unknown[]) => { lines.push({ stream, text: format(...(args as [unknown, ...unknown[]])) }); });
  }
  return lines;
}

test('/api/cron/history needs the cron secret and GET, like the collect route', async t => {
  const history = spy();
  const unconfigured = await listen(t, createApp(newsService(), { staticDirectory: null, env: { HISTORY_INSIGHTS: 'collect' }, history: history.service }));
  const response = await fetch(`${unconfigured}/api/cron/history`, { headers: AUTH });
  assert.equal(response.status, 503);
  assert.ok((await response.json()).error);
  const base = await listen(t, createApp(newsService(), { staticDirectory: null, env: { CRON_SECRET: SECRET, HISTORY_INSIGHTS: 'collect' }, history: history.service }));
  for (const authorization of [undefined, 'Bearer wrong', `Bearer ${SECRET.replace(/.$/, 'x')}`, SECRET, `bearer ${SECRET}`]) {
    const denied = await fetch(`${base}/api/cron/history`, authorization ? { headers: { authorization } } : {});
    assert.equal(denied.status, 401, authorization ?? 'missing');
    assert.ok(!JSON.stringify(await denied.json()).includes(SECRET));
  }
  for (const method of ['POST', 'PUT', 'DELETE']) {
    assert.equal((await fetch(`${base}/api/cron/history`, { method, headers: AUTH })).status, 405, method);
  }
  assert.deepEqual(history.runs, []);
});

test('HISTORY_INSIGHTS off (unset, empty or unknown) answers {status:off} without running or reading anything', async t => {
  for (const value of [undefined, '', 'maybe', 'OFF', ' off ']) {
    const history = spy();
    const store = createMemoryHistoryStore();
    const real = createHistoryService({}, { store, snapshots: { read: async () => { throw new Error('must not read'); } },
      priceProviders: () => { throw new Error('must not build providers'); } });
    const env: NodeJS.ProcessEnv = { CRON_SECRET: SECRET, ...(value === undefined ? {} : { HISTORY_INSIGHTS: value }) };
    for (const service of [history.service, real]) {
      const base = await listen(t, createApp(newsService(), { staticDirectory: null, env, history: service }));
      for (const path of ['/api/cron/history', '/api/cron/history?step=ledger', '/api/cron/history?step=bogus']) {
        const response = await fetch(`${base}${path}`, { headers: AUTH });
        assert.equal(response.status, 200, `${String(value)} ${path}`);
        assert.deepEqual(await response.json(), { status: 'off' });
        assert.equal(response.headers.get('cache-control'), 'no-store');
      }
    }
    assert.deepEqual(history.runs, []);
    assert.equal(store.reads.length, 0);
    assert.equal(store.writeLog.length, 0);
  }
});

test('collect and on run the full job; step=ledger runs the ledger step; other steps are refused', async t => {
  captureLogs(t);
  for (const mode of ['collect', 'on', ' Collect ']) {
    const history = spy();
    const base = await listen(t, createApp(newsService(), { staticDirectory: null, env: { CRON_SECRET: SECRET, HISTORY_INSIGHTS: mode }, history: history.service }));
    const full = await fetch(`${base}/api/cron/history`, { headers: AUTH });
    assert.equal(full.status, 200);
    assert.equal((await full.json()).mode, 'full');
    assert.equal((await fetch(`${base}/api/cron/history?step=ledger`, { headers: AUTH })).status, 200);
    for (const path of ['?step=full', '?step=', '?step=ledger&step=ledger', '?step=LEDGER']) {
      const refused = await fetch(`${base}/api/cron/history${path}`, { headers: AUTH });
      assert.equal(refused.status, 400, path);
      assert.ok((await refused.json()).error);
    }
    assert.deepEqual(history.runs, ['full', 'ledger']);
  }
  // A handler built with a news service and no history service has nothing to run.
  const none = await listen(t, createApp(newsService(), { staticDirectory: null, env: { CRON_SECRET: SECRET, HISTORY_INSIGHTS: 'collect' } }));
  assert.equal((await fetch(`${none}/api/cron/history`, { headers: AUTH })).status, 503);
});

test('the job status maps to 200, 500 or 503, and the response is never cached and carries no secret', async t => {
  captureLogs(t);
  const history = spy();
  const env = { CRON_SECRET: SECRET, HISTORY_INSIGHTS: 'collect', KR_PRICE_API_KEY: FSC_KEY, US_PRICE_API_KEY: US_KEY };
  const base = await listen(t, createApp(newsService(), { staticDirectory: null, env, history: history.service }));
  for (const [status, code] of [['done', 200], ['partial', 200], ['already_done', 200], ['failed', 500], ['not_configured', 503]] as const) {
    history.service.status = status;
    const response = await fetch(`${base}/api/cron/history`, { headers: AUTH });
    assert.equal(response.status, code, status);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('vercel-cdn-cache-control'), 'no-store');
    const text = await response.text();
    assert.equal(JSON.parse(text).status, status);
    for (const secret of [SECRET, FSC_KEY, US_KEY]) assert.ok(!text.includes(secret));
  }
  // The real service without Blob credentials: 503, nothing exposed.
  const real = await listen(t, createApp(newsService(), { staticDirectory: null, env, history: createHistoryService(env) }));
  const response = await fetch(`${real}/api/cron/history`, { headers: AUTH });
  assert.equal(response.status, 503);
  const text = await response.text();
  assert.equal(JSON.parse(text).status, 'not_configured');
  for (const secret of [SECRET, FSC_KEY, US_KEY]) assert.ok(!text.includes(secret));
});

test('vercel.json schedules five crons, every one resolves through the serverless entry, and maxDuration stays 300', async t => {
  captureLogs(t);
  const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as {
    crons: Array<{ path: string; schedule: string }>; functions: Record<string, { maxDuration: number }>;
  };
  assert.deepEqual(config.crons, [
    { path: '/api/cron/collect', schedule: '0 21 * * *' },
    { path: '/api/cron/collect', schedule: '0 11 * * *' },
    { path: '/api/cron/history?step=ledger', schedule: '0 23 * * *' },
    { path: '/api/cron/history', schedule: '0 6 * * *' },
    { path: '/api/cron/history?step=ledger', schedule: '0 12 * * *' },
  ]);
  assert.equal(config.functions['api/index.ts']!.maxDuration, 300);
  const history = spy();
  const calls: string[] = [];
  const service = createNewsService({ name: 'Test', cacheTtlMs: 21_600_000, async getArticles(company) { calls.push(company.id); return { provider: 'Test', articles: [] }; } });
  const base = await listen(t, createServer(createApiHandler(service, { CRON_SECRET: SECRET, HISTORY_INSIGHTS: 'collect' }, { history: history.service })));
  for (const cron of config.crons) {
    const [path, query] = cron.path.split('?') as [string, string | undefined];
    // The public URL and the rewritten function URL (the rewrite keeps the cron's own query).
    for (const url of [cron.path, `/api/index?__moneycast_route=${path.slice('/api/'.length)}${query ? `&${query}` : ''}`]) {
      const response = await fetch(`${base}${url}`, { headers: AUTH });
      assert.equal(response.status, 200, url);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
  }
  assert.deepEqual(history.runs, ['ledger', 'ledger', 'full', 'full', 'ledger', 'ledger']);
  assert.equal(calls.length, companies.length * 4, 'both collect crons refresh every company');
  // The existing two-argument call still works and keeps news and collect unchanged.
  const legacy = await listen(t, createServer(createApiHandler(newsService(), { CRON_SECRET: SECRET })));
  const news = await (await fetch(`${legacy}/api/index?__moneycast_route=news&companyId=nasdaq%3AAAPL`)).json();
  assert.ok(isNewsAnalysis(news, 'nasdaq:AAPL'));
  assert.deepEqual(await (await fetch(`${legacy}/api/index?__moneycast_route=cron/history`, { headers: AUTH })).json(), { status: 'off' });
  assert.equal((await fetch(`${legacy}/api/index?__moneycast_route=cron/history`, { method: 'POST', headers: AUTH })).status, 405);
});

test('a ledger cron still runs the ledger step when its query does not arrive: x-vercel-cron-schedule names it', async t => {
  captureLogs(t);
  // Regression: the step came only from the cron path's query string, which Vercel does not document as preserved.
  // Without it the 08 and 21 KST crons would run the full job (before the KRX prices of 13:00 KST), the 15 KST run
  // would then stop as already_done, and the evening ledger merge would never run. Vercel documents the schedule
  // header for telling apart cron jobs that share a path.
  const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as { crons: Array<{ path: string; schedule: string }> };
  const ledger = config.crons.filter(cron => cron.path === '/api/cron/history?step=ledger').map(cron => cron.schedule);
  const full = config.crons.filter(cron => cron.path === '/api/cron/history').map(cron => cron.schedule);
  assert.deepEqual([...HISTORY_LEDGER_SCHEDULES].sort(), [...ledger].sort(), 'the route knows every ledger schedule in vercel.json');
  const history = spy();
  const env = { CRON_SECRET: SECRET, HISTORY_INSIGHTS: 'collect' };
  const direct = await listen(t, createApp(newsService(), { staticDirectory: null, env, history: history.service }));
  const rewritten = await listen(t, createServer(createApiHandler(newsService(), env, { history: history.service })));
  const expected: string[] = [];
  for (const schedule of [...ledger, ...full]) {
    for (const url of [`${direct}/api/cron/history`, `${rewritten}/api/index?__moneycast_route=cron/history`]) {
      const response = await fetch(url, { headers: { ...AUTH, 'x-vercel-cron-schedule': schedule } });
      assert.equal(response.status, 200, `${url} ${schedule}`);
      expected.push(ledger.includes(schedule) ? 'ledger' : 'full');
    }
  }
  assert.deepEqual(history.runs, expected);
  // An explicit step still wins, a bad step is still refused, and the header changes nothing without the secret.
  history.runs.length = 0;
  assert.equal((await fetch(`${direct}/api/cron/history?step=ledger`, { headers: { ...AUTH, 'x-vercel-cron-schedule': full[0]! } })).status, 200);
  assert.equal((await fetch(`${direct}/api/cron/history?step=full`, { headers: { ...AUTH, 'x-vercel-cron-schedule': ledger[0]! } })).status, 400);
  assert.equal((await fetch(`${direct}/api/cron/history`, { headers: { 'x-vercel-cron-schedule': ledger[0]! } })).status, 401);
  assert.equal((await fetch(`${direct}/api/cron/history`, { headers: { ...AUTH, 'x-vercel-cron-schedule': 'not a schedule' } })).status, 200);
  assert.deepEqual(history.runs, ['ledger', 'full']);
});

test('HISTORY_INSIGHTS changes neither /api/news nor /api/cron/collect: the evening collect runs in every mode', async t => {
  const calls: string[] = [];
  const service = createNewsService({ name: 'Test', cacheTtlMs: 21_600_000, async getArticles(company) { calls.push(company.id); return { provider: 'Test', articles: [] }; } });
  const clock = () => Date.parse('2026-11-12T11:30:00Z');
  const handlers: Array<{ value: string | undefined; base: string; history: ReturnType<typeof spy> }> = [];
  for (const value of [undefined, 'off', 'collect', 'maybe']) {
    const history = spy();
    const env: NodeJS.ProcessEnv = { CRON_SECRET: SECRET, ...(value === undefined ? {} : { HISTORY_INSIGHTS: value }) };
    handlers.push({ value, history, base: await listen(t, createApp(service, { staticDirectory: null, env, history: history.service, clock })) });
  }
  // One shared news service: after the first request every handler serves the same cached analysis.
  await fetch(`${handlers[0]!.base}/api/news?companyId=nasdaq%3AAAPL`);
  const seen = new Set<string>();
  for (const { base } of handlers) {
    const response = await fetch(`${base}/api/news?companyId=nasdaq%3AAAPL`);
    seen.add(JSON.stringify([response.status, response.headers.get('cache-control'), response.headers.get('vercel-cdn-cache-control'), await response.text()]));
  }
  assert.equal(seen.size, 1, 'the flag never reaches the news response');
  for (const { value, base, history } of handlers) {
    const before = calls.length;
    const response = await fetch(`${base}/api/cron/collect`, { headers: AUTH });
    assert.equal(response.status, 200, String(value));
    assert.equal((await response.json()).refreshed.length, companies.length, String(value));
    assert.equal(calls.length - before, companies.length, `${String(value)}: every company is collected`);
    assert.deepEqual(history.runs, []);
  }
});

test('both READMEs name every scheduled time and no longer say collection runs once a day', () => {
  const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as { crons: Array<{ path: string; schedule: string }> };
  for (const file of ['../README.md', './README.md']) {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8');
    for (const cron of config.crons) assert.ok(text.includes(`\`${cron.schedule}\``), `${file}: ${cron.path} ${cron.schedule}`);
    // The evening /api/cron/collect (A-11) makes scheduled collection (and GDELT) twice a day in every HISTORY_INSIGHTS mode.
    assert.doesNotMatch(text, /하루 한 번의? 예약 수집(?:뿐|에서만| 때만)/, file);
  }
  const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  assert.doesNotMatch(example, /the daily scheduled collection\b/);
  assert.match(example, /\/api\/cron\/collect runs happen in every mode/);
});

test('.env.example lists the three history variables with empty values', () => {
  const lines = readFileSync(new URL('../.env.example', import.meta.url), 'utf8').split(/\r?\n/);
  for (const name of ['HISTORY_INSIGHTS', 'KR_PRICE_API_KEY', 'US_PRICE_API_KEY']) {
    assert.deepEqual(lines.filter(line => line.startsWith(`${name}=`)), [`${name}=`], name);
  }
});

test('each history run logs one history_run line, on console.error for failed and not_configured; nothing is logged without a run', async t => {
  const logs = captureLogs(t);
  const history = spy();
  const env = { CRON_SECRET: SECRET, HISTORY_INSIGHTS: 'collect' };
  const base = await listen(t, createApp(newsService(), { staticDirectory: null, env, history: history.service }));
  for (const [status, stream] of [['done', 'log'], ['partial', 'log'], ['already_done', 'log'], ['failed', 'error'], ['not_configured', 'error']] as const) {
    history.service.status = status;
    for (const [path, mode] of [['/api/cron/history', 'full'], ['/api/cron/history?step=ledger', 'ledger']] as const) {
      const before = logs.length;
      await (await fetch(`${base}${path}`, { headers: AUTH })).text();
      const added = logs.slice(before);
      assert.equal(added.length, 1, `${status} ${path}`);
      assert.equal(added[0]!.stream, stream, `${status} ${path}`);
      assert.ok(added[0]!.text.startsWith('history_run {') && added[0]!.text.length <= HISTORY_RUN_LOG_MAX_CHARS, added[0]!.text);
      const fields = JSON.parse(added[0]!.text.slice('history_run '.length)) as { mode: string; status: string };
      assert.deepEqual([fields.mode, fields.status], [mode, status]);
    }
  }
  assert.equal(history.runs.length, 10);
  // No run, no line: the off answer, a missing or wrong secret, another method, an unknown step, no secret set, no service.
  const before = logs.length;
  const off = await listen(t, createApp(newsService(), { staticDirectory: null, env: { CRON_SECRET: SECRET }, history: history.service }));
  assert.deepEqual(await (await fetch(`${off}/api/cron/history`, { headers: AUTH })).json(), { status: 'off' });
  const refused: Array<[string, RequestInit, number]> = [
    ['/api/cron/history', {}, 401], ['/api/cron/history', { headers: { authorization: 'Bearer wrong' } }, 401],
    ['/api/cron/history', { method: 'POST', headers: AUTH }, 405], ['/api/cron/history?step=full', { headers: AUTH }, 400],
  ];
  for (const [path, init, code] of refused) assert.equal((await fetch(`${base}${path}`, init)).status, code, path);
  const unconfigured = await listen(t, createApp(newsService(), { staticDirectory: null, env: { HISTORY_INSIGHTS: 'collect' }, history: history.service }));
  assert.equal((await fetch(`${unconfigured}/api/cron/history`, { headers: AUTH })).status, 503);
  const none = await listen(t, createApp(newsService(), { staticDirectory: null, env }));
  assert.equal((await fetch(`${none}/api/cron/history`, { headers: AUTH })).status, 503);
  assert.deepEqual(logs.slice(before), []);
  assert.equal(history.runs.length, 10);
});

/**
 * The price APIs of a bad day, quoting the secrets back in every answer: error bodies with them alone, together,
 * URL-encoded or as the status code, and dropped connections whose error message carries them. Never the network;
 * `hosts` records each request's host.
 */
function quotingPriceApi(secrets: { cron: string; fsc: string; us: string; blob: string }, hosts: string[]): typeof fetch {
  const { cron, fsc, us, blob } = secrets;
  const all = `${cron} ${fsc} ${encodeURIComponent(fsc)} ${us} ${blob}`;
  const answers: Record<string, Array<() => Response>> = {
    'apis.data.go.kr': [
      () => new Response(JSON.stringify({ response: { header: { resultCode: blob, resultMsg: `${cron} ${us}` } } })),
      () => new Response(`<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>${all}</errMsg><returnAuthMsg>${us}</returnAuthMsg>` +
        `<returnReasonCode>${cron}</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>`, { status: 500 }),
      () => new Response(JSON.stringify({ response: { header: { resultCode: us, resultMsg: blob } } }), { status: 502 }),
      () => new Response(JSON.stringify({ response: { header: { resultCode: cron } } })),
      () => { throw new Error(`connect ECONNREFUSED ${all}`); },
    ],
    'api.massive.com': [
      () => new Response(JSON.stringify({ status: blob, error: `${cron} ${fsc}` })),
      () => new Response(JSON.stringify({ status: 'ERROR', error: all, request_id: cron }), { status: 500 }),
      () => new Response(JSON.stringify({ status: cron, message: blob }), { status: 404 }),
      () => new Response(JSON.stringify({ status: us })),
      () => { throw new Error(`socket hang up ${all}`); },
      () => new Response(JSON.stringify({ status: encodeURIComponent(fsc), request_id: blob })),
    ],
  };
  return (async (input: Parameters<typeof fetch>[0]) => {
    const { host } = new URL(String(input));
    hosts.push(host);
    const list = answers[host];
    if (!list) throw new Error(`unexpected host ${host}`);
    return list[(hosts.filter(item => item === host).length - 1) % list.length]!();
  }) as typeof fetch;
}

/** @vercel/blob calls whose failures quote the secrets: every call fails ('down'), or no file exists and every put fails. */
function failingBlobApi(quoted: string, mode: 'down' | 'refuses_writes') {
  return {
    get: (async () => { if (mode === 'down') throw new BlobError(`get failed: ${quoted}`); return null; }) as unknown as typeof blobGet,
    head: (async () => { throw mode === 'down' ? new BlobError(`head failed: ${quoted}`) : new BlobNotFoundError(); }) as unknown as typeof blobHead,
    put: (async () => { throw new BlobError(`put refused: ${quoted}`); }) as unknown as typeof blobPut,
  };
}

test('history_run lines carry no secret, even when price error bodies, Blob errors and a snapshot error quote every one', async t => {
  const logs = captureLogs(t);
  // The test's own requests go to the loopback server; any other fetch would be the network.
  const loopbackFetch = globalThis.fetch;
  const outside: string[] = [];
  t.mock.method(globalThis, 'fetch', (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const { hostname } = new URL(input instanceof Request ? input.url : String(input));
    if (hostname !== '127.0.0.1') { outside.push(hostname); throw new Error('no network in tests'); }
    return loopbackFetch(input, init);
  }) as typeof fetch);
  // A data.go.kr key needs encoding on the wire; the others are identifier-shaped, so a provider can return them as a code.
  const fsc = 'Fixture+KR/price=Key+never+real==';
  const us = 'fixtureUsPriceKeyNeverReal0123';
  const blob = 'vercel_blob_rw_fixturestore_FixtureBlobTokenNeverReal';
  const secrets = [SECRET, fsc, us, blob];
  const quoted = `${secrets.join(' ')} ${secrets.map(encodeURIComponent).join(' ')}`;
  const env = { CRON_SECRET: SECRET, HISTORY_INSIGHTS: 'collect', KR_PRICE_API_KEY: fsc, US_PRICE_API_KEY: us, BLOB_READ_WRITE_TOKEN: blob };
  // One clock for the job and the adapters' pacing, so the 13 s Massive gaps take no real time.
  let clockMs = Date.parse('2026-11-24T06:20:00Z');
  const now = () => clockMs;
  const hosts: string[] = [];
  const priceProviders = () => createPriceProviders(env, {
    fetcher: quotingPriceApi({ cron: SECRET, fsc, us, blob }, hosts), now, sleep: async ms => { clockMs += ms; },
  });
  const services = [
    // The real adapters on the quoting APIs; every snapshot read throws the secrets.
    createHistoryService(env, { store: createMemoryHistoryStore(), snapshots: { read: async () => { throw new Error(quoted); } }, priceProviders, now }),
    // A Blob store whose every call fails quoting them.
    createHistoryService(env, { store: createBlobHistoryStore(env, failingBlobApi(quoted, 'down')), snapshots: { read: async () => null }, priceProviders, now }),
    // A Blob store with no files whose every put fails quoting them.
    createHistoryService(env, {
      store: createBlobHistoryStore(env, failingBlobApi(quoted, 'refuses_writes')), snapshots: { read: async () => null }, priceProviders, now,
    }),
  ];
  const bodies: string[] = [];
  for (const history of services) {
    const base = await listen(t, createApp(newsService(), { staticDirectory: null, env, history }));
    for (const path of ['/api/cron/history', '/api/cron/history?step=ledger']) bodies.push(await (await fetch(`${base}${path}`, { headers: AUTH })).text());
  }
  const summaries = bodies.map(body => JSON.parse(body) as HistoryJobSummary);
  assert.deepEqual(summaries.map(summary => summary.status), ['partial', 'partial', 'failed', 'failed', 'failed', 'done']);
  // One line per run, the failed ones on the error stream, and nothing else on the console.
  assert.deepEqual(logs.map(line => line.stream), ['log', 'log', 'error', 'error', 'error', 'log']);
  const fields = logs.map(line => {
    assert.ok(line.text.startsWith('history_run {') && line.text.length <= HISTORY_RUN_LOG_MAX_CHARS, line.text);
    return JSON.parse(line.text.slice('history_run '.length)) as {
      mode: string; status: string; errors: string[]; prices: { ok: number; failed: Record<string, string> } | null;
      writes: { failed: Array<{ file: string; code: string }> };
    };
  });
  assert.deepEqual(fields.map(item => [item.mode, item.status]), summaries.map(summary => [summary.mode, summary.status]));
  const printed = logs.map(line => line.text).join('\n');
  for (const secret of secrets) assert.ok(!printed.includes(secret), 'a secret reached the console');
  assert.equal(createRedactor(secrets).contains(printed), false, 'an encoded secret reached the console');
  assert.equal(createRedactor(secrets).contains(bodies.join('\n')), false, 'a secret reached an answer');
  // Not vacuous: both price APIs answered for every key, and what they quoted reached the answers only redacted.
  assert.deepEqual(outside, []);
  assert.deepEqual([...new Set(hosts)].sort(), ['api.massive.com', 'apis.data.go.kr']);
  const keys = [...FETCH_ORDER.fsc, ...FETCH_ORDER.massive].sort();
  const results = summaries.flatMap(summary => Object.values(summary.prices ?? {}));
  assert.ok(results.some(item => item.code === 'echoed_secret') && results.some(item => item.providerCode?.includes('[REDACTED]')), JSON.stringify(results));
  // The lines name each failed price key with its fixed code, and the store failures by code only.
  for (const index of [0, 4]) {
    assert.deepEqual(Object.keys(summaries[index]!.prices!).sort(), keys);
    assert.equal(fields[index]!.prices!.ok, 0);
    assert.deepEqual(Object.keys(fields[index]!.prices!.failed).sort(), keys);
    assert.ok(Object.values(fields[index]!.prices!.failed).every(code => /^(echoed_secret|provider_error|network|http_\d{3})$/.test(code)), logs[index]!.text);
  }
  assert.deepEqual(fields[2]!.errors, ['ledger_unreadable', 'stats_unreadable']);
  assert.deepEqual(fields[4]!.writes.failed, [{ file: 'ledger/2026-11.json', code: 'write_failed' }]);
});
