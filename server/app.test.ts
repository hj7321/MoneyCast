import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { companies, isNewsAnalysis } from '@moneycast/core';
import { createApp, newsCdnCacheControl } from './app.js';
import { createApiHandler } from '../api/index.js';
import { createNewsService } from './service.js';
import { ProviderError } from './provider.js';
import { createNewsProvider } from './news-provider.js';

test('HTTP API provides health, bounded company search, typed empty news and input errors', async t => {
  const service = createNewsService({ getArticles: async () => { throw new ProviderError('not_configured'); } });
  const app = createApp(service, { staticDirectory: null });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => { app.closeAllConnections(); app.close(); });
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  const search = await (await fetch(`${base}/api/companies?q=005930`)).json();
  assert.ok(search.companies.some((company: { symbol: string }) => company.symbol === '005930'));
  const news = await (await fetch(`${base}/api/news?companyId=${encodeURIComponent(companies[0]!.id)}`)).json();
  assert.equal(news.status, 'not_configured');
  assert.deepEqual(news.articles, []);
  assert.equal((await fetch(`${base}/api/news?companyId=UNKNOWN`)).status, 400);
  assert.equal((await fetch(`${base}/api/companies?q=${'x'.repeat(101)}`)).status, 400);
  assert.equal((await fetch(`${base}/api/health`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${base}/missing`)).status, 404);
  assert.equal((await fetch(`${base}/api/missing`)).status, 404);
});

test('Marketaux metadata flows through the HTTP API with no token exposure and cached qualified evidence', async t => {
  const now = new Date('2026-10-27T00:00:00.000Z');
  const company = companies.find(item => item.id === 'nasdaq:AAPL')!;
  const token = 'only-a-fixture-token-never-real';
  let providerCalls = 0;
  const upstream = (async () => {
    providerCalls++;
    return new Response(JSON.stringify({ data: [0.4, -0.2, null].map((score, i) => ({
      uuid: `fixture-${i}`, title: `형식 검증용 테스트 기사 ${i}`, source: 'example.test',
      url: `https://example.test/fixture-${i}`, published_at: '2026-10-26T01:00:00.000000Z', language: 'en',
      entities: [{ symbol: 'AAPL', name: 'Apple Inc.', country: 'us', type: 'equity',
        exchange: null, exchange_long: null, sentiment_score: score }],
    })) }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const provider = createNewsProvider({ NEWS_PROVIDER: 'marketaux', NEWS_SOURCES: 'marketaux', MARKETAUX_API_TOKEN: token }, upstream);
  const app = createApp(createNewsService(provider, () => now), { staticDirectory: null });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => { app.closeAllConnections(); app.close(); });
  const endpoint = `http://127.0.0.1:${(app.address() as AddressInfo).port}/api/news?companyId=${encodeURIComponent(company.id)}`;
  const response = await fetch(endpoint);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const result: unknown = await response.json();
  assert.ok(isNewsAnalysis(result, company.id));
  assert.equal(result.provider, 'Marketaux');
  assert.equal(result.status, 'insufficient');
  assert.deepEqual(result.articles.map(article => article.sentiment), ['positive', 'negative', 'unclassified']);
  assert.equal(result.articles[2]!.sentimentScore, undefined);
  assert.equal(result.articles[0]!.providerEntity?.symbol, 'AAPL');
  assert.equal(result.articles[0]!.language, 'en');
  assert.equal(result.newsWindow?.start, '2026-10-20T00:00:00.000Z');
  assert.equal(result.cachedUntil, '2026-10-27T06:00:00.000Z');
  assert.ok(!JSON.stringify(result).includes(token));
  assert.equal((await (await fetch(endpoint)).json()).asOf, result.asOf);
  assert.equal(providerCalls, 1);
});

test('Marketaux HTTP authentication and quota failures return safe empty states', async t => {
  const now = new Date('2026-10-27T00:00:00.000Z');
  for (const [upstreamStatus, expected] of [[401, 'error'], [403, 'error'], [402, 'rate_limited'], [429, 'rate_limited']] as const) {
    const token = 'only-a-fixture-secret-never-real';
    const provider = createNewsProvider({ NEWS_PROVIDER: 'marketaux', NEWS_SOURCES: 'marketaux', MARKETAUX_API_TOKEN: token },
      (async () => new Response(`private error with ${token}`, { status: upstreamStatus, headers: { 'retry-after': '600' } })) as typeof fetch);
    const app = createApp(createNewsService(provider, () => now), { staticDirectory: null });
    app.listen(0, '127.0.0.1');
    await once(app, 'listening');
    t.after(() => { app.closeAllConnections(); app.close(); });
    const endpoint = `http://127.0.0.1:${(app.address() as AddressInfo).port}/api/news?companyId=nasdaq%3AAAPL`;
    const result: unknown = await (await fetch(endpoint)).json();
    assert.ok(isNewsAnalysis(result, 'nasdaq:AAPL'));
    assert.equal(result.status, expected);
    assert.deepEqual(result.articles, []);
    assert.ok(result.message);
    assert.ok(!JSON.stringify(result).includes(token));
    if (expected === 'rate_limited') assert.equal(result.retryAt, '2026-10-27T00:10:00.000Z');
    app.closeAllConnections();
    app.close();
  }
});

test('only successful news uses the remaining original six-hour CDN lifetime', async t => {
  let instant = new Date('2026-10-28T00:00:00.000Z');
  let requests = 0;
  const service = createNewsService({ name: 'Marketaux', cacheTtlMs: 21600000, getArticles: async () => {
    requests++;
    return { provider: 'Marketaux', articles: [] };
  } }, () => instant);
  const app = createApp(service, { staticDirectory: null, clock: () => instant.getTime() });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => { app.closeAllConnections(); app.close(); });
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  const first = await fetch(`${base}/api/news?companyId=nasdaq%3AAAPL`);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.equal(first.headers.get('vercel-cdn-cache-control'), 'public, s-maxage=21600');
  instant = new Date('2026-10-28T05:59:00.000Z');
  const cached = await fetch(`${base}/api/news?companyId=nasdaq%3AAAPL`);
  assert.equal(cached.headers.get('vercel-cdn-cache-control'), 'public, s-maxage=60');
  assert.equal(requests, 1);
  assert.equal((await cached.json()).asOf, '2026-10-28T00:00:00.000Z');
  for (const path of ['/api/health', '/api/companies?q=Apple', '/api/missing', '/api/news?companyId=UNKNOWN']) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.headers.get('vercel-cdn-cache-control'), 'no-store', path);
    assert.equal(response.headers.get('cache-control'), 'no-store', path);
  }
});

test('CDN never caches failures, expired data or a deadline beyond the original freshness window', async () => {
  const now = Date.parse('2026-10-28T00:00:00.000Z');
  const analysis = await createNewsService({ name: 'Test', cacheTtlMs: 21600000,
    getArticles: async () => ({ provider: 'Test', articles: [] }),
  }, () => new Date(now)).getAnalysis(companies[0]!);
  assert.equal(newsCdnCacheControl(analysis, now), 'public, s-maxage=21600');
  assert.equal(newsCdnCacheControl({ ...analysis, cachedUntil: '2026-10-30T00:00:00.000Z' }, now + 3600000), 'public, s-maxage=18000');
  assert.equal(newsCdnCacheControl(analysis, now + 21600000), 'no-store');
  assert.equal(newsCdnCacheControl({ ...analysis, cachedUntil: undefined }, now), 'no-store');
  assert.equal(newsCdnCacheControl({ ...analysis, asOf: '2026-10-29T00:00:00.000Z' }, now), 'no-store');
  for (const status of ['not_configured', 'error', 'rate_limited'] as const) {
    assert.equal(newsCdnCacheControl({ ...analysis, status }, now), 'no-store');
  }
});

test('serverless entry handles public and rewritten API URLs without a listening server or HTML fallback', async t => {
  const service = createNewsService({ getArticles: async () => { throw new ProviderError('not_configured'); } });
  const app = createServer(createApiHandler(service));
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => { app.closeAllConnections(); app.close(); });
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  for (const path of ['/api/health', '/api/index?__moneycast_route=health']) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).service, 'MoneyCast API');
  }
  const companiesResponse = await fetch(`${base}/api/index?__moneycast_route=companies&q=005930`);
  assert.ok((await companiesResponse.json()).companies.some((company: { id: string }) => company.id === 'krx:005930'));
  const news = await (await fetch(`${base}/api/index?__moneycast_route=news&companyId=nasdaq%3AAAPL`)).json();
  assert.ok(isNewsAnalysis(news, 'nasdaq:AAPL'));
  assert.equal(news.status, 'not_configured');
  // The public route wins over a caller-supplied reserved query parameter.
  const original = await fetch(`${base}/api/health?__moneycast_route=news`);
  assert.equal((await original.json()).service, 'MoneyCast API');
  for (const path of ['/api/missing', '/api/index', '/api/index?__moneycast_route=unknown',
    '/api/index?__moneycast_route=health&__moneycast_route=news', '/api/index?__moneycast_route=..%2Fhealth']) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 404, path);
    assert.match(response.headers.get('content-type')!, /application\/json/);
    assert.ok((await response.json()).error);
  }
  const method = await fetch(`${base}/api/index?__moneycast_route=health`, { method: 'POST' });
  assert.equal(method.status, 405);
});

test('default sources combine Marketaux and GDELT; an exhausted Marketaux quota still returns GDELT articles', async t => {
  const now = new Date('2026-10-27T00:00:00.000Z');
  const token = 'only-a-fixture-token-never-real';
  const hosts: string[] = [];
  const upstream = (async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input));
    hosts.push(url.host);
    if (url.host === 'api.marketaux.com') return new Response('quota', { status: 402 });
    return new Response(JSON.stringify({ articles: [{ url: 'https://news.example/apple-1', title: 'Apple 테스트 기사', seendate: '20261026T010000Z',
      domain: 'news.example', language: 'English' }] }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const app = createApp(createNewsService(createNewsProvider({ MARKETAUX_API_TOKEN: token }, upstream), () => now),
    { staticDirectory: null, clock: () => now.getTime() });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => { app.closeAllConnections(); app.close(); });
  const response = await fetch(`http://127.0.0.1:${(app.address() as AddressInfo).port}/api/news?companyId=nasdaq%3AAAPL`);
  const result: unknown = await response.json();
  assert.ok(isNewsAnalysis(result, 'nasdaq:AAPL'));
  assert.deepEqual(hosts.sort(), ['api.gdeltproject.org', 'api.marketaux.com']);
  assert.equal(result.status, 'insufficient');
  assert.equal(result.provider, 'GDELT');
  assert.deepEqual(result.articles.map(article => [article.sourceProvider, article.sentiment]), [['GDELT', 'unclassified']]);
  assert.deepEqual(result.sources?.map(source => [source.id, source.status]), [['marketaux', 'rate_limited'], ['gdelt', 'ok']]);
  assert.equal(result.cachedUntil, '2026-10-27T00:30:00.000Z');
  assert.equal(response.headers.get('vercel-cdn-cache-control'), 'public, s-maxage=1800');
  assert.ok(!JSON.stringify(result).includes(token));
});

test('stale fallbacks are never cached by the CDN', async () => {
  const now = Date.parse('2026-10-28T00:00:00.000Z');
  const analysis = await createNewsService({ name: 'Test', cacheTtlMs: 21600000,
    getArticles: async () => ({ provider: 'Test', articles: [] }),
  }, () => new Date(now)).getAnalysis(companies[0]!);
  assert.equal(newsCdnCacheControl({ ...analysis, servedFrom: 'stale' }, now), 'no-store');
});
