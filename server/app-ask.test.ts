import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { NEWS_ASK_VERSION, companies, parseAskAnswer, type Company, type NewsAnalysis } from '@moneycast/core';
import { createApiHandler } from '../api/index.js';
import { createApp, createRequestHandler } from './app.js';
import type { GoalClarifier } from './goal-clarify.js';
import type { HistoryServe } from './history-serve.js';
import type { LlmClient, LlmPrompt } from './llm.js';
import type { NewsAsk } from './news-ask.js';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-27T10:00:00Z');
const COMPANY = companies.find(item => item.id === 'krx:005930')!;
const QUESTION = '이 판단은 어떤 기사에서 나왔나요?';
const ON: NodeJS.ProcessEnv = { NEWS_ASK_PROVIDERS: 'gemini' };
type NewsService = Parameters<typeof createRequestHandler>[0];

async function listen(t: test.TestContext, server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function analysisOf(item: Company, extra: Partial<NewsAnalysis> = {}): NewsAnalysis {
  return {
    company: item, status: 'ready', articles: [], asOf: new Date(NOW - HOUR).toISOString(), period: { start: '2026-11-30', end: '2026-12-04' },
    evidence: 'low', summary: '요약', positiveFactors: ['실적 개선'], negativeFactors: [], risks: ['변동성'], provider: 'Marketaux',
    analysisVersion: 'news-evidence-v3', newsWindow: { start: new Date(NOW - 7 * 24 * HOUR).toISOString(), end: new Date(NOW - HOUR).toISOString() },
    cachedUntil: new Date(NOW + 5 * HOUR).toISOString(), servedFrom: 'live',
    sources: [{ id: 'marketaux', label: 'Marketaux', status: 'ok', articleCount: 0 }],
    ...extra,
  };
}

/** One shared fake news service: every handler serves the very same cached object per company. */
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

/** History is off here: the route never reads Blob. */
const historyServe: HistoryServe = {
  answer: async item => ({ body: { version: 'news-history-v1', companyId: item.id, status: 'off' }, cdnCacheControl: 'public, s-maxage=60' }),
};

const FIELDS = { tool: 'none', horizon: 'both', direction: 'all', topic: 'all', overnight: 'all', term: 'none', refusal: 'none', evidence: [] };

/** A fake model that always answers with one plain sentence and counts its calls. */
function fakeModel(text = '이 회사의 최근 기사를 바탕으로 한 설명입니다.') {
  const prompts: LlmPrompt[] = [];
  const client: LlmClient & { prompts: LlmPrompt[] } = {
    id: 'gemini', label: 'Gemini', model: 'gemini-test-model', prompts, unavailable: () => null,
    async generate(prompt) { prompts.push(prompt); return { ...FIELDS, action: 'answer', text }; },
  };
  return client;
}

const goals: GoalClarifier = {
  availability: () => ({ enabled: true, providers: [], promptVersion: 'goal-clarify-v1', maxLength: 200 }),
  clarify: async () => ({ status: 'not_configured', promptVersion: 'goal-clarify-v1' }),
};

/** The service's one line per question, kept out of the test output; one capture per test. */
const captured = new WeakMap<test.TestContext, string[]>();
function quiet(t: test.TestContext): string[] {
  let lines = captured.get(t);
  if (!lines) {
    const own: string[] = [];
    for (const stream of ['log', 'warn'] as const) t.mock.method(console, stream, (...parts: unknown[]) => { own.push(parts.map(String).join(' ')); });
    captured.set(t, own);
    lines = own;
  }
  return lines;
}

async function app(t: test.TestContext, options: { env?: NodeJS.ProcessEnv; model?: LlmClient | null; clock?: () => number; news?: ReturnType<typeof fakeNews> } = {}) {
  const logged = quiet(t);
  const news = options.news ?? fakeNews();
  const base = await listen(t, createApp(news.service, {
    staticDirectory: null, env: options.env ?? ON, clock: options.clock ?? (() => NOW), historyServe, goals,
    ...(options.model === null ? {} : { askClients: { gemini: options.model ?? fakeModel() } }),
  }));
  return { base, news, logged };
}

function post(base: string, body: string, headers: Record<string, string> = {}, path = '/api/news/ask') {
  return fetch(`${base}${path}`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.10', ...headers } });
}

const ask = (companyId = COMPANY.id, question = QUESTION) => JSON.stringify({ companyId, question });

/** Written in parts with no Content-Length, so only the running count can stop it. */
function chunked(base: string, parts: string[]): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(`${base}/api/news/ask`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.99' } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString('utf8') }));
    });
    outgoing.on('error', reject);
    for (const part of parts.slice(0, -1)) outgoing.write(part);
    outgoing.end(parts[parts.length - 1]);
  });
}

function assertHeaders(response: Response, label: string) {
  assert.equal(response.headers.get('cache-control'), 'no-store', label);
  assert.equal(response.headers.get('vercel-cdn-cache-control'), 'no-store', label);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff', label);
  assert.match(response.headers.get('content-type')!, /^application\/json/, label);
}

// --- GET and off --------------------------------------------------------------------------------------

test('GET /api/news/ask reports availability: off by default, on with gemini and a configured client', async t => {
  const variants: Array<[string, NodeJS.ProcessEnv, LlmClient | null, boolean]> = [
    ['unset', {}, fakeModel(), false],
    ['cloudflare', { NEWS_ASK_PROVIDERS: 'cloudflare' }, fakeModel(), false],
    ['gemini without its key (default client)', { NEWS_ASK_PROVIDERS: 'gemini', GEMINI_API_KEY: 'test-news-key' }, null, false],
    ['gemini with a client', ON, fakeModel(), true],
  ];
  for (const [name, env, model, enabled] of variants) {
    const { base } = await app(t, { env, model });
    const response = await fetch(`${base}/api/news/ask`);
    assert.equal(response.status, 200, name);
    assertHeaders(response, name);
    assert.deepEqual(await response.json(), {
      version: NEWS_ASK_VERSION, enabled, providers: enabled ? [{ id: 'gemini', label: 'Google Gemini' }] : [], maxLength: 300,
    }, name);
  }
});

test('POST while off answers 503 not_configured without reading the body or calling a model', async t => {
  const model = fakeModel();
  const { base, news } = await app(t, { env: {}, model });
  for (const [body, type] of [[ask(), 'application/json'], ['not json', 'text/plain'], ['x'.repeat(10_000), 'application/json']] as const) {
    const response = await post(base, body, { 'content-type': type });
    assert.equal(response.status, 503, type);
    assertHeaders(response, type);
    assert.deepEqual(await response.json(), { version: NEWS_ASK_VERSION, status: 'not_configured' });
  }
  assert.equal(model.prompts.length, 0);
  assert.deepEqual(news.calls, []);
});

// --- the body -----------------------------------------------------------------------------------------

test('POST takes a small JSON body with two strings: 415, 400 and 413 otherwise, each an AskAnswer', async t => {
  const model = fakeModel();
  const { base, news, logged } = await app(t, { model });
  const invalid = (reason: string) => ({ version: NEWS_ASK_VERSION, status: 'invalid_input', reason });
  const cases: Array<[string, string, Record<string, string>, number, string]> = [
    ['plain text', ask(), { 'content-type': 'text/plain' }, 415, 'bad_request'],
    ['no type', ask(), { 'content-type': '' }, 415, 'bad_request'],
    ['cut JSON', '{"companyId":', {}, 400, 'bad_request'],
    ['empty body', '', {}, 400, 'bad_request'],
    ['an array', JSON.stringify([COMPANY.id, QUESTION]), {}, 400, 'bad_request'],
    ['null', 'null', {}, 400, 'bad_request'],
    ['no question', JSON.stringify({ companyId: COMPANY.id }), {}, 400, 'bad_request'],
    ['no company', JSON.stringify({ question: QUESTION }), {}, 400, 'bad_request'],
    ['number question', JSON.stringify({ companyId: COMPANY.id, question: 42 }), {}, 400, 'bad_request'],
    ['number company', JSON.stringify({ companyId: 5930, question: QUESTION }), {}, 400, 'bad_request'],
    ['long company id', ask('x'.repeat(41)), {}, 400, 'bad_request'],
    ['unknown company', ask('krx:999999'), {}, 400, 'unknown_company'],
    ['over 4 KB', ask(COMPANY.id, '가'.repeat(1_400)), {}, 413, 'too_large'],
  ];
  for (const [name, body, headers, status, reason] of cases) {
    const response = await post(base, body, headers);
    assert.equal(response.status, status, name);
    assertHeaders(response, name);
    assert.deepEqual(await response.json(), invalid(reason), name);
  }
  // Without a Content-Length only the running count stops it; a body within 4 KB passes.
  const long = await chunked(base, ['{"companyId":"krx:005930","question":"', ...Array.from({ length: 5 }, () => 'x'.repeat(1_000)), '"}']);
  assert.deepEqual([long.status, JSON.parse(long.body)], [413, invalid('too_large')]);
  const short = await chunked(base, ['{"companyId":"krx:005930",', `"question":"${QUESTION}"}`]);
  assert.equal(short.status, 200);
  assert.equal(JSON.parse(short.body).status, 'answered');
  // Other keys are ignored; the question limit is the service's (200 with too_long).
  const extra = await post(base, JSON.stringify({ companyId: COMPANY.id, question: QUESTION, history: [{ role: 'user', text: '이전 질문' }] }));
  assert.equal((await extra.json()).status, 'answered');
  const tooLong = await post(base, ask(COMPANY.id, '가'.repeat(301)));
  assert.deepEqual([tooLong.status, await tooLong.json()], [200, invalid('too_long')]);
  assert.equal(model.prompts.length, 2, 'only the two valid questions reached the model');
  assert.ok(!model.prompts.some(prompt => prompt.user.includes('이전 질문')), 'earlier turns never reach the model');
  assert.deepEqual(news.calls, [COMPANY.id, COMPANY.id]);
  // One fixed line per question that reached the service, never its text.
  assert.equal(logged.length, 4);
  for (const line of logged) {
    assert.match(line, /^news_ask status=[a-z_]+ by=(ai|template|-) reason=([a-z_]+|-) calls=\d+ tools=\d+ note=([a-z_]+|-)$/);
    for (const fragment of [QUESTION, '이전 질문', '가가가']) assert.equal(line.includes(fragment), false, line);
  }
});

test('an answered question is 200 and no-store; a refusal too; every answer passes the client parser', async t => {
  const model = fakeModel();
  const { base } = await app(t, { model });
  const answered = await post(base, ask());
  assert.equal(answered.status, 200);
  assertHeaders(answered, 'answered');
  const body = await answered.json();
  assert.equal(body.status, 'answered');
  assert.equal(body.by, 'ai');
  assert.equal(body.text, '이 회사의 최근 기사를 바탕으로 한 설명입니다.');
  assert.deepEqual(parseAskAnswer(body, COMPANY.id), body);
  const refused = await post(base, ask(COMPANY.id, '지금 사도 될까요?'));
  assert.equal(refused.status, 200);
  assert.deepEqual(await refused.json(), { version: NEWS_ASK_VERSION, status: 'refused', companyId: COMPANY.id, reason: 'advice' });
  assert.equal(model.prompts.length, 1);
  // A model failure is a 503 the screen shows as unavailable.
  const failing = fakeModel();
  failing.generate = async () => { throw new Error('model down'); };
  const down = await app(t, { model: failing });
  const response = await post(down.base, ask());
  assert.equal(response.status, 503);
  assertHeaders(response, 'unavailable');
  assert.deepEqual(await response.json(), { version: NEWS_ASK_VERSION, status: 'unavailable', reason: 'error' });
});

// --- limits and methods -------------------------------------------------------------------------------

test('five questions per address in ten minutes, a budget of its own apart from goal clarification', async t => {
  let now = NOW;
  const model = fakeModel();
  const { base } = await app(t, { model, clock: () => now });
  const from = (address: string) => ({ 'x-real-ip': address });
  const goal = (address: string) => post(base, JSON.stringify({ text: '여행 자금 모으기' }), from(address), '/api/goals/clarify');
  // Requests the body check refuses use none of it.
  for (let index = 0; index < 6; index += 1) assert.equal((await post(base, '{"companyId":', from('203.0.113.1'))).status, 400);
  for (let index = 0; index < 5; index += 1) assert.equal((await post(base, ask(), from('203.0.113.1'))).status, 200, `ask ${index + 1}`);
  // Goal clarification still has its own five for the same address.
  assert.equal((await goal('203.0.113.1')).status, 200);
  const limited = await post(base, ask(), from('203.0.113.1'));
  assert.equal(limited.status, 429);
  assertHeaders(limited, 'limited');
  assert.deepEqual(await limited.json(), { version: NEWS_ASK_VERSION, status: 'rate_limited', scope: 'ip', retryAt: new Date(NOW + 10 * 60_000).toISOString() });
  assert.equal(model.prompts.length, 5);
  // Another address passes, and five goal requests leave a third address its five questions.
  assert.equal((await post(base, ask(), from('198.51.100.7'))).status, 200);
  for (let index = 0; index < 5; index += 1) assert.equal((await goal('192.0.2.30')).status, 200, `goal ${index + 1}`);
  assert.equal((await goal('192.0.2.30')).status, 429);
  for (let index = 0; index < 5; index += 1) assert.equal((await post(base, ask(), from('192.0.2.30'))).status, 200, `after goals ${index + 1}`);
  // Ten minutes after the first question the window has moved on.
  now = NOW + 10 * 60_000;
  assert.equal((await post(base, ask(), from('203.0.113.1'))).status, 200);
});

test('other methods are 405; the GET and POST routes are reached through the serverless entry point too', async t => {
  const { base } = await app(t);
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    const response = await fetch(`${base}/api/news/ask`, { method });
    assert.equal(response.status, 405, method);
    assert.deepEqual(await response.json(), { error: 'GET 또는 POST 요청만 지원합니다.' }, method);
  }
  // createApiHandler: the route list, and the ask and askClients options passed through.
  const model = fakeModel();
  const news = fakeNews();
  const handler = createApiHandler(news.service, ON, { historyServe, askClients: { gemini: model } });
  const { createServer } = await import('node:http');
  const entry = await listen(t, createServer(handler));
  const availability = await fetch(`${entry}/api/index?__moneycast_route=news/ask`);
  assert.equal(availability.status, 200);
  assert.equal((await availability.json()).enabled, true);
  const answered = await post(entry, ask(), {}, '/api/index?__moneycast_route=news/ask');
  assert.equal(answered.status, 200);
  assert.equal((await answered.json()).status, 'answered');
  assert.equal(model.prompts.length, 1);
  assert.equal((await post(entry, ask(), {}, '/api/news/ask')).status, 200);
  const calls: string[] = [];
  const fixed: NewsAsk = {
    availability: () => ({ version: NEWS_ASK_VERSION, enabled: true, providers: [{ id: 'gemini', label: 'Google Gemini' }], maxLength: 300 }),
    answer: async input => { calls.push(input.question); return { version: NEWS_ASK_VERSION, status: 'refused', companyId: input.companyId, reason: 'off_topic' }; },
  };
  const own = await listen(t, createServer(createApiHandler(news.service, {}, { historyServe, ask: fixed })));
  const refused = await post(own, ask(), {}, '/api/index?__moneycast_route=news/ask');
  assert.deepEqual(await refused.json(), { version: NEWS_ASK_VERSION, status: 'refused', companyId: COMPANY.id, reason: 'off_topic' });
  assert.deepEqual(calls, [QUESTION]);
  assert.equal((await fetch(`${own}/api/index?__moneycast_route=news/asks`)).status, 404);
});

// --- the /api/news hint ---------------------------------------------------------------------------------

async function snapshot(response: Response): Promise<string> {
  return JSON.stringify([response.status, response.headers.get('cache-control'), response.headers.get('vercel-cdn-cache-control'), await response.text()]);
}

test('/api/news is byte for byte unchanged while questions are off; on adds only askAvailable to a copy of a live answer', async t => {
  const news = fakeNews();
  const path = `/api/news?companyId=${encodeURIComponent(COMPANY.id)}`;
  const seen = new Set<string>();
  for (const [env, model] of [[{}, fakeModel()], [{ NEWS_ASK_PROVIDERS: 'cloudflare' }, fakeModel()], [ON, null], [{ NEWS_ASK_PROVIDERS: 'gemini', GEMINI_API_KEY: 'test-news-key' }, null]] as const) {
    const { base } = await app(t, { env, model, news });
    seen.add(await snapshot(await fetch(`${base}${path}`)));
  }
  assert.equal(seen.size, 1, 'every way of being off answers identically');
  const original = news.cached.get(COMPANY.id)!;
  const [status, cacheControl, cdn, text] = JSON.parse([...seen][0]!) as [number, string, string, string];
  assert.deepEqual([status, cacheControl, cdn], [200, 'no-store', 'public, s-maxage=18000']);
  assert.equal(text, JSON.stringify(original));
  assert.deepEqual(JSON.parse(text), original);
  assert.equal('askAvailable' in JSON.parse(text), false);
  // On: the same headers, and the original plus the hint.
  const model = fakeModel();
  const { base } = await app(t, { model, news });
  const response = await fetch(`${base}${path}`);
  assert.equal(response.headers.get('cache-control'), cacheControl);
  assert.equal(response.headers.get('vercel-cdn-cache-control'), cdn);
  assert.equal(await response.text(), JSON.stringify({ ...original, askAvailable: true }));
  assert.equal('askAvailable' in original, false, 'the cached analysis is never changed');
  assert.equal(model.prompts.length, 0, '/api/news calls no model');
  // With the outlook on as well, both hints.
  const both = await app(t, { model, news, env: { ...ON, HISTORY_INSIGHTS: 'on' } });
  assert.equal(await (await fetch(`${both.base}${path}`)).text(), JSON.stringify({ ...original, historyAvailable: true, askAvailable: true }));
});

test('/api/news gets no ask hint for a stale result, an error, a rate limit or missing setup; insufficient gets it', async t => {
  const cases: Array<[string, Partial<NewsAnalysis>, boolean]> = [
    ['krx:005930', { status: 'error', positiveFactors: [], cachedUntil: undefined }, false],
    ['krx:035420', { status: 'rate_limited', positiveFactors: [], cachedUntil: undefined, retryAt: new Date(NOW + HOUR).toISOString() }, false],
    ['krx:005380', { status: 'not_configured', positiveFactors: [], cachedUntil: undefined }, false],
    ['nasdaq:AAPL', { servedFrom: 'stale', refreshAttemptedAt: new Date(NOW).toISOString() }, false],
    ['nasdaq:NVDA', { status: 'insufficient', positiveFactors: [] }, true],
    ['nasdaq:MSFT', {}, true],
  ];
  const news = fakeNews(item => analysisOf(item, cases.find(([id]) => id === item.id)?.[1] ?? {}));
  const { base } = await app(t, { news });
  for (const [id, , hinted] of cases) {
    const text = await (await fetch(`${base}/api/news?companyId=${encodeURIComponent(id)}`)).text();
    const original = news.cached.get(id)!;
    assert.equal(text, JSON.stringify(hinted ? { ...original, askAvailable: true } : original), id);
    assert.equal('askAvailable' in original, false, `${id}: the cached object is unchanged`);
  }
});

test('the default ask client uses NEWS_ASK_GEMINI_API_KEY only, and nothing calls out until a question is asked', async t => {
  const realFetch = globalThis.fetch;
  const outside: Array<{ url: string; key: string | null }> = [];
  t.mock.method(globalThis, 'fetch', (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    outside.push({ url: input instanceof Request ? input.url : String(input), key: new Headers(init?.headers).get('x-goog-api-key') });
    throw new Error('no network in tests');
  }) as typeof fetch);
  t.mock.method(console, 'warn', () => undefined);
  const news = fakeNews();
  const env = { NEWS_ASK_PROVIDERS: 'gemini', NEWS_ASK_GEMINI_API_KEY: 'test-ask-key', GEMINI_API_KEY: 'test-news-key' };
  const base = await listen(t, createApp(news.service, { staticDirectory: null, env, clock: () => NOW, historyServe, goals }));
  const availability = await realFetch(`${base}/api/news/ask`);
  assert.equal((await availability.json()).enabled, true);
  const hinted = await (await realFetch(`${base}/api/news?companyId=${encodeURIComponent(COMPANY.id)}`)).json();
  assert.equal(hinted.askAvailable, true);
  assert.equal(outside.length, 0, 'availability and the hint call nothing');
  // A question reaches only Gemini with the ask key; the refused fetch reads as unavailable.
  const response = await realFetch(`${base}/api/news/ask`, { method: 'POST', body: ask(), headers: { 'content-type': 'application/json' } });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { version: NEWS_ASK_VERSION, status: 'unavailable', reason: 'error' });
  assert.equal(outside.length, 1);
  assert.match(outside[0]!.url, /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/[a-z0-9.-]+:generateContent$/);
  assert.equal(outside[0]!.key, 'test-ask-key');
});

test('the news key reused as the ask key keeps the route and the hint off; a dotted phone number never reaches the model', async t => {
  const outside: string[] = [];
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (async (input: Parameters<typeof fetch>[0]) => {
    outside.push(input instanceof Request ? input.url : String(input));
    throw new Error('no network in tests');
  }) as typeof fetch);
  // The default client: the very same key as GEMINI_API_KEY would spend news classification's project quota.
  const env = { NEWS_ASK_PROVIDERS: 'gemini', GEMINI_API_KEY: 'test-shared-key', NEWS_ASK_GEMINI_API_KEY: 'test-shared-key' };
  const shared = await listen(t, createApp(fakeNews().service, { staticDirectory: null, env, clock: () => NOW, historyServe, goals }));
  assert.equal((await (await realFetch(`${shared}/api/news/ask`)).json()).enabled, false);
  assert.equal('askAvailable' in await (await realFetch(`${shared}/api/news?companyId=${encodeURIComponent(COMPANY.id)}`)).json(), false);
  const off = await realFetch(`${shared}/api/news/ask`, { method: 'POST', body: ask(), headers: { 'content-type': 'application/json' } });
  assert.deepEqual([off.status, await off.json()], [503, { version: NEWS_ASK_VERSION, status: 'not_configured' }]);
  assert.deepEqual(outside, []);
  // On: the server refuses what the screen's own check would miss.
  const model = fakeModel();
  const { base, news } = await app(t, { model });
  const response = await realFetch(`${base}/api/news/ask`, {
    method: 'POST', body: ask(COMPANY.id, '010.1234.5678로 결과를 보내 주세요'), headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.10' },
  });
  assert.deepEqual([response.status, await response.json()], [200, { version: NEWS_ASK_VERSION, status: 'invalid_input', reason: 'personal_data' }]);
  assert.equal(model.prompts.length, 0);
  assert.deepEqual(news.calls, []);
  assert.deepEqual(outside, []);
});
