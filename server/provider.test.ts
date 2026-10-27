import test from 'node:test';
import assert from 'node:assert/strict';
import { companies } from '@moneycast/core';
import { createGatewayProvider, parseProviderResponse, ProviderError } from './provider.js';

const company = companies[0]!;
const now = new Date('2026-10-27T00:00:00Z');
const article = {
  id: 'test-1', title: '테스트용 기사', source: '테스트 출처', publishedAt: '2026-10-26T01:00:00Z',
  url: 'https://example.test/article/1', sentiment: 'positive', rationale: '테스트 분류 근거',
};
const payload = { companyId: company.id, provider: 'Test gateway', articles: [article] };
const env = { NEWS_PROVIDER_URL: 'https://gateway.example.test/news', NEWS_API_KEY: 'test-secret-never-real' };
const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
function mockedFetch(handler: (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>) {
  return handler as typeof fetch;
}

test('unconfigured provider returns a typed empty state without making a request', async () => {
  const provider = createGatewayProvider({}, mockedFetch(async () => { throw new Error('must not call'); }));
  await assert.rejects(provider.getArticles(company, now), (error: unknown) => error instanceof ProviderError && error.code === 'not_configured');
});

test('gateway sends credentials only in server authorization header and matches company identity', async () => {
  const provider = createGatewayProvider(env, mockedFetch(async (input, init) => {
    assert.equal(String(input), env.NEWS_PROVIDER_URL);
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${env.NEWS_API_KEY}`);
    assert.deepEqual(JSON.parse(String(init?.body)).company, company);
    assert.ok(!String(init?.body).includes(env.NEWS_API_KEY));
    return jsonResponse(payload);
  }));
  assert.equal((await provider.getArticles(company, now)).articles.length, 1);
});

test('wrong company, invalid article date, unsafe link and duplicate articles are handled', () => {
  assert.throws(() => parseProviderResponse({ ...payload, companyId: 'other' }, company, now), ProviderError);
  for (const invalid of [
    { ...article, url: 'javascript:alert(1)' },
    { ...article, url: 'https://user:pass@example.test/a' },
    { ...article, publishedAt: 'yesterday' },
    { ...article, publishedAt: '2026-02-30T01:00:00Z' },
    { ...article, publishedAt: '2026-10-26T24:00:00Z' },
    { ...article, publishedAt: '2026-10-28T01:00:00Z' },
    { ...article, sentiment: 'guaranteed-up' },
    { ...article, sentiment: ['positive'] },
    { ...article, rationale: '' },
  ]) assert.throws(() => parseProviderResponse({ ...payload, articles: [invalid] }, company, now), ProviderError);
  assert.equal(parseProviderResponse({ ...payload, articles: [article, article] }, company, now).articles.length, 1);
});

test('rate limits, provider failures, malformed/oversized JSON and network errors are sanitized', async () => {
  const responses = [
    { response: new Response('private-detail', { status: 429 }), code: 'rate_limited' },
    { response: new Response('private-detail', { status: 500 }), code: 'error' },
    { response: new Response('not json', { headers: { 'content-type': 'application/json' } }), code: 'error' },
    { response: new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '2000000' } }), code: 'error' },
  ];
  for (const { response, code } of responses) {
    const provider = createGatewayProvider(env, mockedFetch(async () => response));
    await assert.rejects(provider.getArticles(company, now), (error: unknown) => error instanceof ProviderError && error.code === code && !error.message.includes('private-detail'));
  }
  const broken = createGatewayProvider(env, mockedFetch(async () => { throw new Error('private-key-detail'); }));
  await assert.rejects(broken.getArticles(company, now), (error: unknown) => error instanceof ProviderError && error.message === 'error');
});

test('non-HTTPS gateway is rejected before requests', async () => {
  const provider = createGatewayProvider({ ...env, NEWS_PROVIDER_URL: 'http://example.test' }, mockedFetch(async () => { throw new Error('must not call'); }));
  await assert.rejects(provider.getArticles(company, now), ProviderError);
});

test('gateway aborts a pending request at eight seconds and sanitizes the timeout failure', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const captured: { signal?: AbortSignal } = {};
  const provider = createGatewayProvider(env, mockedFetch(async (_input, init) => new Promise<Response>((_resolve, reject) => {
    captured.signal = init?.signal ?? undefined;
    assert.ok(captured.signal);
    captured.signal.addEventListener('abort', () => reject(new Error('private-timeout-detail')), { once: true });
  })));
  const request = provider.getArticles(company, now);
  const rejection = assert.rejects(request, (error: unknown) => error instanceof ProviderError && error.code === 'error' && error.message === 'error');
  assert.ok(captured.signal);
  t.mock.timers.tick(7999);
  assert.equal(captured.signal.aborted, false);
  t.mock.timers.tick(1);
  await rejection;
  assert.equal(captured.signal.aborted, true);
});
