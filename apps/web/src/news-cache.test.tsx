import test from 'node:test';
import assert from 'node:assert/strict';
import { companies, createNewsCache, NEWS_CACHE_ANALYSIS_VERSION, NEWS_CACHE_TTL_MS, NEWS_LAST_GOOD_MAX_AGE_MS, type NewsAnalysis, type NewsCacheStorage } from '@moneycast/core';

const company = companies[0]!;
const beginning = Date.parse('2026-10-28T00:00:00.000Z');
function fixture(instant = beginning): NewsAnalysis {
  return {
    company, status: 'insufficient', articles: [], asOf: new Date(instant).toISOString(),
    period: { start: '2026-11-02', end: '2026-11-06' }, evidence: 'none',
    summary: '테스트 전용: 기사가 없어 판단을 유보합니다.', positiveFactors: [], negativeFactors: [], risks: [],
    provider: 'Marketaux', analysisVersion: NEWS_CACHE_ANALYSIS_VERSION,
    cachedUntil: new Date(instant + NEWS_CACHE_TTL_MS).toISOString(),
  };
}
function storage() {
  const entries = new Map<string, string>();
  const store: NewsCacheStorage = {
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => { entries.set(key, value); },
    removeItem: key => { entries.delete(key); },
  };
  return { store, entries };
}

test('successful news survives screen recreation and reload without extending its six-hour expiry', async () => {
  const { store } = storage();
  let instant = beginning;
  let requests = 0;
  const options = { storage: () => store, clock: () => instant, load: async () => { requests++; return fixture(instant); } };
  const firstCache = createNewsCache(options);
  const first = await firstCache.getAnalysis(company.id);
  await firstCache.getAnalysis(company.id);
  assert.equal(requests, 1);
  const reloadedCache = createNewsCache(options);
  instant += NEWS_CACHE_TTL_MS - 1;
  assert.deepEqual(await reloadedCache.getAnalysis(company.id), first);
  assert.equal(requests, 1);
  instant += 1;
  const fresh = await reloadedCache.getAnalysis(company.id);
  assert.equal(requests, 2);
  assert.equal(fresh.asOf, new Date(instant).toISOString());
});

test('shorter server deadlines are respected and results without deadlines expire from their original asOf', async () => {
  let instant = beginning;
  let requests = 0;
  const cache = createNewsCache({ clock: () => instant, load: async () => {
    requests++;
    return requests === 1 ? { ...fixture(), cachedUntil: new Date(beginning + 60_000).toISOString() }
      : { ...fixture(instant), cachedUntil: undefined };
  } });
  await cache.getAnalysis(company.id);
  instant += 59_999;
  await cache.getAnalysis(company.id);
  assert.equal(requests, 1);
  instant += 1;
  await cache.getAnalysis(company.id);
  assert.equal(requests, 2);
  instant += NEWS_CACHE_TTL_MS;
  await cache.getAnalysis(company.id);
  assert.equal(requests, 3);
});

test('tampered schema, company, metadata, version and extended expiry are discarded before rendering', async () => {
  const { store, entries } = storage();
  const initial = createNewsCache({ storage: () => store, clock: () => beginning, load: async () => fixture() });
  await initial.getAnalysis(company.id);
  const [key, raw] = [...entries][0]!;
  const changes = [
    (entry: any) => { entry.schema = 999; },
    (entry: any) => { entry.analysisVersion = 'old-analysis-version'; },
    (entry: any) => { entry.value.analysisVersion = 'old-analysis-version'; },
    (entry: any) => { entry.value.company.id = 'nasdaq:AAPL'; },
    (entry: any) => { entry.value.company.symbol = 'AAPL'; },
    (entry: any) => { entry.expiresAt = beginning + NEWS_CACHE_TTL_MS * 2; entry.value.cachedUntil = new Date(entry.expiresAt).toISOString(); },
    (entry: any) => { entry.value.asOf = new Date(beginning + 120_000).toISOString(); },
    (entry: any) => { entry.value.status = 'guaranteed_up'; },
    (entry: any) => { entry.value.articles = [{ sentimentScore: 5 }]; },
  ];
  for (const change of changes) {
    const entry = JSON.parse(raw);
    change(entry);
    entries.set(key, JSON.stringify(entry));
    let requests = 0;
    const cache = createNewsCache({ storage: () => store, clock: () => beginning, load: async () => { requests++; return fixture(); } });
    const result = await cache.getAnalysis(company.id);
    assert.equal(requests, 1);
    assert.deepEqual(result, fixture());
  }
  entries.set(key, 'not JSON');
  const cache = createNewsCache({ storage: () => store, clock: () => beginning, load: async () => fixture() });
  assert.equal(cache.peek(company.id), null);
  assert.equal(entries.has(key), false);
});

test('pending news requests are shared independently of a screen lifecycle', async () => {
  let resolve!: (value: NewsAnalysis) => void;
  let requests = 0;
  const cache = createNewsCache({ clock: () => beginning, load: async () => {
    requests++;
    return new Promise<NewsAnalysis>(done => { resolve = done; });
  } });
  const firstScreen = cache.getAnalysis(company.id);
  const remountedScreen = cache.getAnalysis(company.id);
  await Promise.resolve();
  assert.equal(requests, 1);
  resolve(fixture());
  const [first, second] = await Promise.all([firstScreen, remountedScreen]);
  assert.equal(first, second);
  assert.equal(await cache.getAnalysis(company.id), first);
  assert.equal(requests, 1);
});

test('configuration, authentication and quota failures are never persisted for six hours', async () => {
  for (const status of ['not_configured', 'error', 'rate_limited'] as const) {
    const { store, entries } = storage();
    let requests = 0;
    const cache = createNewsCache({ storage: () => store, clock: () => beginning, load: async () => {
      requests++;
      return { ...fixture(), status, cachedUntil: new Date(beginning + NEWS_CACHE_TTL_MS).toISOString() };
    } });
    await cache.getAnalysis(company.id);
    await cache.getAnalysis(company.id);
    assert.equal(requests, 2, status);
    assert.equal(entries.size, 0, status);
  }
});

test('network failures clear pending requests and blocked persistence still permits memory caching', async () => {
  let requests = 0;
  const cache = createNewsCache({ clock: () => beginning, storage: () => { throw new Error('blocked'); }, load: async () => {
    requests++;
    if (requests === 1) throw new Error('offline');
    return fixture();
  } });
  await assert.rejects(cache.getAnalysis(company.id), /offline/);
  await cache.getAnalysis(company.id);
  await cache.getAnalysis(company.id);
  assert.equal(requests, 2);
  let calls = 0;
  const failingStore = createNewsCache({ clock: () => beginning, storage: () => ({
    getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('full'); }, removeItem: () => { throw new Error('blocked'); },
  }), load: async () => { calls++; return fixture(); } });
  await failingStore.getAnalysis(company.id);
  await failingStore.getAnalysis(company.id);
  assert.equal(calls, 1);
});

test('unknown companies and malformed responses cannot become cached records', async () => {
  let requests = 0;
  const cache = createNewsCache({ clock: () => beginning, load: async () => { requests++; return { secret: 'bad response' }; } });
  await assert.rejects(cache.getAnalysis('unknown'), /회사와 거래소/);
  assert.equal(requests, 0);
  await assert.rejects(cache.getAnalysis(company.id), /응답 형식/);
  await assert.rejects(cache.getAnalysis(company.id), /응답 형식/);
  assert.equal(requests, 2);
});

test('the last successful result outlives its freshness for display only, never stale copies or old versions', async () => {
  const { store, entries } = storage();
  let instant = beginning;
  let next: unknown = fixture();
  const cache = createNewsCache({ storage: () => store, clock: () => instant, load: async () => next });
  await cache.getAnalysis(company.id);
  instant += NEWS_CACHE_TTL_MS + 1;
  assert.equal(cache.peek(company.id), null);
  assert.equal(cache.peekLastGood(company.id)?.asOf, fixture().asOf);
  // A reloaded page finds it in storage; a server-side stale copy does not replace it.
  next = { ...fixture(instant), servedFrom: 'stale', cachedUntil: new Date(instant + 5000).toISOString() };
  const reloaded = createNewsCache({ storage: () => store, clock: () => instant, load: async () => next });
  await reloaded.getAnalysis(company.id);
  assert.equal(reloaded.peekLastGood(company.id)?.asOf, fixture().asOf);
  next = { ...fixture(instant), status: 'error' };
  await reloaded.getAnalysis(company.id);
  assert.equal(reloaded.peekLastGood(company.id)?.asOf, fixture().asOf);
  instant = beginning + NEWS_LAST_GOOD_MAX_AGE_MS + 1;
  assert.equal(createNewsCache({ storage: () => store, clock: () => instant, load: async () => next }).peekLastGood(company.id), null);
  assert.equal([...entries.keys()].some(key => key.includes('.last.')), false);
  const memoryOnly = createNewsCache({ clock: () => beginning, load: async () => fixture() });
  await memoryOnly.getAnalysis(company.id);
  assert.equal(memoryOnly.peekLastGood(company.id)?.status, 'insufficient');
});
