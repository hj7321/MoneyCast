import test from 'node:test';
import assert from 'node:assert/strict';
import type { get, put } from '@vercel/blob';
import { companies, NEWS_CACHE_ANALYSIS_VERSION, type NewsAnalysis, type NewsArticle } from '@moneycast/core';
import { collectNews } from './collect.js';
import { createNewsService, SNAPSHOT_REWRITE_MS } from './service.js';
import { createBlobSnapshotStore, createMemorySnapshotStore, createSnapshot, isCompanySnapshot } from './snapshot-store.js';
import { ProviderError, type NewsProvider } from './provider.js';

const company = companies[0]!;
const now = new Date('2026-10-27T00:00:00Z');
function article(id: string, publishedAt = '2026-10-26T01:00:00Z', sentiment: NewsArticle['sentiment'] = 'positive'): NewsArticle {
  return { id, title: `서로 다른 테스트 기사 ${id}`, source: `${id}.example`, publishedAt, url: `https://${id}.example/a`, sentiment, rationale: `테스트 근거 ${id}` };
}
function analysis(asOf: Date, articles: NewsArticle[] = [article('old')], cachedUntil = new Date(asOf.getTime() + 21600000)): NewsAnalysis {
  return { company, status: 'insufficient', articles, asOf: asOf.toISOString(), period: { start: '2026-11-02', end: '2026-11-06' },
    evidence: 'low', summary: '테스트 전용 스냅샷 요약', positiveFactors: [], negativeFactors: [], risks: [], provider: 'Test',
    analysisVersion: NEWS_CACHE_ANALYSIS_VERSION, cachedUntil: cachedUntil.toISOString() };
}
function counting(articles: () => NewsArticle[] | Promise<NewsArticle[]>): NewsProvider & { calls: number } {
  const provider = { name: 'Test', cacheTtlMs: 21600000, calls: 0, async getArticles() {
    provider.calls += 1;
    return { provider: 'Test', articles: await articles() };
  } };
  return provider;
}

test('Blob snapshots are private, overwritten in place, bounded and validated on read', async () => {
  assert.equal(createBlobSnapshotStore({}), null);
  const uploads: Array<{ pathname: string; body: unknown; options: Record<string, unknown> }> = [];
  let stored: string | null = null;
  const blob = {
    put: (async (pathname: string, body: unknown, options: Record<string, unknown>) => {
      uploads.push({ pathname, body, options });
      stored = String(body);
      return {};
    }) as unknown as typeof put,
    get: (async (pathname: string, options: Record<string, unknown>) => {
      assert.equal(options.access, 'private');
      assert.match(pathname, /^news\/news-evidence-v3\/krx-005930\.json$/);
      return stored === null ? null : { statusCode: 200, stream: new Response(stored).body };
    }) as unknown as typeof get,
  };
  const store = createBlobSnapshotStore({ BLOB_STORE_ID: 'store_test' }, blob)!;
  assert.equal(await store.read(company.id), null);
  const snapshot = createSnapshot(analysis(now), [article('old')], now);
  await store.write(snapshot);
  assert.deepEqual(uploads[0]!.options, { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json', cacheControlMaxAge: 60 });
  assert.deepEqual(await store.read(company.id), snapshot);
  stored = JSON.stringify({ ...snapshot, analysisVersion: 'old-version' });
  assert.equal(await store.read(company.id), null);
  stored = JSON.stringify({ ...snapshot, analysis: { ...snapshot.analysis, servedFrom: 'stale' } });
  assert.equal(await store.read(company.id), null);
  stored = 'x'.repeat(1_048_577);
  await assert.rejects(store.read(company.id));
  assert.equal(isCompanySnapshot(snapshot, 'nasdaq:AAPL'), false);
  assert.equal(isCompanySnapshot({ ...snapshot, pool: Array.from({ length: 31 }, (_, i) => article(`p${i}`)) }, company.id), false);
});

test('a fresh collected snapshot is served without calling any provider', async () => {
  const store = createMemorySnapshotStore();
  await store.write(createSnapshot(analysis(now), [article('old')], now));
  const provider = counting(() => [article('new')]);
  const service = createNewsService(provider, () => new Date(now.getTime() + 60_000), { store });
  const result = await service.getAnalysis(company);
  assert.equal(provider.calls, 0);
  assert.equal(result.asOf, now.toISOString());
  assert.deepEqual(result.articles.map(item => item.id), ['old']);
  await service.getAnalysis(company);
  assert.equal(provider.calls, 0);
});

test('expired snapshots are refreshed and the weekly pool keeps earlier articles inside the window', async () => {
  const store = createMemorySnapshotStore();
  const earlier = new Date(now.getTime() - 7 * 3_600_000);
  await store.write(createSnapshot(analysis(earlier), [article('kept', '2026-10-24T00:00:00Z'), article('expired', '2026-10-19T00:00:00Z')], earlier));
  const provider = counting(() => [article('new')]);
  const result = await createNewsService(provider, () => now, { store }).getAnalysis(company);
  assert.equal(provider.calls, 1);
  assert.deepEqual(result.articles.map(item => item.id), ['new', 'kept']);
  assert.equal(result.factorSummary?.positive.lines.flatMap(line => line.articleIds).length, 2);
  const saved = await store.read(company.id);
  assert.deepEqual(saved?.pool.map(item => item.id), ['new', 'kept']);
  assert.equal(saved?.updatedAt, now.toISOString());
});

test('unchanged refreshes skip snapshot writes until the rewrite interval, while scheduled refreshes always write', async () => {
  const store = createMemorySnapshotStore();
  let instant = now;
  const provider = { name: 'Test', cacheTtlMs: 60_000, async getArticles() { return { provider: 'Test', articles: [article('same')] }; } };
  const service = createNewsService(provider, () => instant, { store });
  await service.getAnalysis(company);
  assert.equal(store.writes, 1);
  instant = new Date(now.getTime() + 61_000);
  await service.getAnalysis(company);
  assert.equal(store.writes, 1);
  await service.refresh(company);
  assert.equal(store.writes, 2);
  instant = new Date(instant.getTime() + SNAPSHOT_REWRITE_MS + 61_000);
  await service.getAnalysis(company);
  assert.equal(store.writes, 3);
});

test('a snapshot covers a cold instance whose sources all fail, and storage failures never break responses', async () => {
  const store = createMemorySnapshotStore();
  const earlier = new Date(now.getTime() - 7 * 3_600_000);
  await store.write(createSnapshot(analysis(earlier), [article('old')], earlier));
  const failing = { name: 'Test', async getArticles(): Promise<never> { throw new ProviderError('error'); } };
  const stale = await createNewsService(failing, () => now, { store }).getAnalysis(company);
  assert.equal(stale.servedFrom, 'stale');
  assert.equal(stale.asOf, earlier.toISOString());
  assert.deepEqual(stale.articles.map(item => item.id), ['old']);
  const broken = { async read(): Promise<never> { throw new Error('blob unavailable'); }, async write(): Promise<never> { throw new Error('limit reached'); } };
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    const result = await createNewsService(counting(() => [article('new')]), () => now, { store: broken }).getAnalysis(company);
    assert.equal(result.status, 'insufficient');
    assert.deepEqual(result.articles.map(item => item.id), ['new']);
  } finally {
    console.warn = warn;
  }
});

test('scheduled collection runs companies one at a time, reports outcomes and stops at its budget', async () => {
  let instant = 0;
  const order: string[] = [];
  const service = { async refresh(target: typeof company): Promise<NewsAnalysis> {
    order.push(target.id);
    instant += 40_000;
    if (target.id === companies[1]!.id) throw new Error('unexpected');
    return target.id === companies[2]!.id ? { ...analysis(now), company: target, status: 'error' } : { ...analysis(now), company: target };
  } };
  const summary = await collectNews(service, companies.slice(0, 4), () => instant, 90_000);
  assert.deepEqual(order, companies.slice(0, 3).map(item => item.id));
  assert.deepEqual(summary, { refreshed: [companies[0]!.id], failed: [companies[1]!.id, companies[2]!.id], skipped: [companies[3]!.id] });
});
