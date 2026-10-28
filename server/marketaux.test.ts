import test from 'node:test';
import assert from 'node:assert/strict';
import { companies, isNewsArticle } from '@moneycast/core';
import { createMarketauxProvider } from './marketaux.js';
import { createNewsProvider } from './news-provider.js';
import { ProviderError } from './provider.js';

const now = new Date('2026-10-27T00:00:00Z');
const apple = companies.find(company => company.id === 'nasdaq:AAPL')!;
const samsung = companies.find(company => company.id === 'krx:005930')!;
const env = { MARKETAUX_API_TOKEN: 'fake-test-token-never-real' };
const appleEntity = { symbol: 'AAPL', name: 'Apple Inc.', country: 'us', type: 'equity', exchange: null, exchange_long: null, sentiment_score: 0.45 };
const samsungEntity = { symbol: '005930.KS', name: 'Samsung Electronics Co., Ltd.', country: 'kr', type: 'equity', exchange: 'KSC', exchange_long: null, sentiment_score: -0.3 };
function article(id = 'article-1', entity: object = appleEntity, overrides: object = {}) {
  return { uuid: id, title: '명시적인 테스트 기사', source: 'example.test', url: `https://example.test/${id}`,
    published_at: '2026-10-26T01:00:00.000000Z', language: 'en', entities: [entity], ...overrides };
}
function json(value: unknown): Response { return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }); }
function mockedFetch(handler: (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>): typeof fetch { return handler as typeof fetch; }
function providerFor(rows: unknown[]) { return createMarketauxProvider(env, mockedFetch(async () => json({ data: rows })), () => now.getTime()); }
async function rejects(promise: Promise<unknown>, code: ProviderError['code'], reason?: ProviderError['reason']) {
  await assert.rejects(promise, (error: unknown) => error instanceof ProviderError && error.code === code &&
    (reason === undefined || error.reason === reason) && !JSON.stringify(error).includes(env.MARKETAUX_API_TOKEN));
}

test('Marketaux without a token never makes an external request', async () => {
  const provider = createMarketauxProvider({}, mockedFetch(async () => { throw new Error('must not call'); }));
  await rejects(provider.getArticles(apple, now), 'not_configured');
  assert.equal(provider.name, 'Marketaux');
  assert.equal(provider.cacheTtlMs, 21600000);
  assert.match(provider.setupMessage!, /MARKETAUX_API_TOKEN/);
});

test('Marketaux uses a fixed HTTPS host, server token and a bounded recent news query', async () => {
  let requests = 0;
  const provider = createMarketauxProvider(env, mockedFetch(async (input, init) => {
    requests++;
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://api.marketaux.com');
    assert.equal(url.pathname, '/v1/news/all');
    assert.equal(url.searchParams.get('api_token'), env.MARKETAUX_API_TOKEN);
    assert.equal(url.searchParams.get('symbols'), 'AAPL');
    assert.equal(url.searchParams.get('countries'), 'us');
    assert.equal(url.searchParams.get('entity_types'), 'equity');
    for (const key of ['filter_entities', 'must_have_entities', 'group_similar']) assert.equal(url.searchParams.get(key), 'true');
    assert.equal(url.searchParams.get('limit'), '3');
    assert.equal(url.searchParams.has('page'), false);
    assert.equal(url.searchParams.has('language'), false);
    assert.equal(url.searchParams.get('published_after'), '2026-10-20T00:00:00');
    assert.equal(url.searchParams.get('published_before'), '2026-10-27T00:00:00');
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.body, undefined);
    return json({ data: [article()] });
  }));
  const result = await provider.getArticles(apple, now);
  assert.equal(requests, 1);
  assert.equal(result.provider, 'Marketaux');
  assert.equal(result.articles[0]?.sentiment, 'positive');
  assert.equal(result.articles[0]?.classificationMethod, 'provider');
  assert.equal(result.articles[0]?.sentimentScore, 0.45);
  assert.equal(result.articles[0]?.language, 'en');
  assert.equal(result.articles[0]?.providerEntity?.exchange, null);
  assert.ok(isNewsArticle(result.articles[0]));
  assert.ok(result.notes?.some(note => /거래소 필드/.test(note)));
  assert.ok(!JSON.stringify(result).includes(env.MARKETAUX_API_TOKEN));
});

test('only the selected company entity supplies article sentiment; collisions are excluded', async () => {
  const other = { ...appleEntity, symbol: 'MSFT', name: 'Microsoft Corporation', sentiment_score: -0.9 };
  const result = await providerFor([
    article('mixed', other, { entities: [other, appleEntity] }),
    article('wrong-country', { ...appleEntity, country: 'ca' }),
    article('wrong-name', { ...appleEntity, name: 'Unrelated Apple Holdings' }),
  ]).getArticles(apple, now);
  assert.deepEqual(result.articles.map(item => item.id), ['mixed']);
  assert.equal(result.articles[0]?.sentimentScore, 0.45);
  assert.ok(result.notes?.some(note => /2건을 제외/.test(note)));
  const exchanged = await providerFor([article('wrong-exchange', { ...appleEntity, exchange: 'NYSE' })]).getArticles(apple, now);
  assert.deepEqual(exchanged.articles, []);
});

test('duplicate selected entities are not averaged and unrelated entities cannot donate sentiment', async () => {
  const duplicate = article('ambiguous', appleEntity, { entities: [appleEntity, { ...appleEntity, sentiment_score: -0.5 }] });
  const wrong = article('unrelated', { ...appleEntity, symbol: 'TSLA', name: 'Tesla Inc.' });
  assert.deepEqual((await providerFor([duplicate, wrong]).getArticles(apple, now)).articles, []);
});

test('missing sentiment is explicit unclassified and valid zero sentiment stays neutral', async () => {
  const result = await providerFor([
    article('missing', { ...appleEntity, sentiment_score: undefined }),
    article('null', { ...appleEntity, sentiment_score: null }),
    article('neutral', { ...appleEntity, sentiment_score: 0 }),
  ]).getArticles(apple, now);
  assert.deepEqual(result.articles.map(item => item.sentiment), ['unclassified', 'unclassified', 'neutral']);
  for (const item of result.articles.slice(0, 2)) {
    assert.equal(item.classificationMethod, 'unavailable');
    assert.equal(item.sentimentScore, undefined);
    assert.match(item.rationale, /미분류/);
  }
  assert.equal(result.articles[2]?.sentimentScore, 0);
});

test('invalid provider sentiment scores fail instead of becoming neutral', async () => {
  for (const sentiment_score of [1.01, -1.01, '0.8', true, {}]) {
    await rejects(providerFor([article('invalid-score', { ...appleEntity, sentiment_score })]).getArticles(apple, now), 'error');
  }
});

test('Korean ticker is resolved from the provider then revalidated on every article and cached', async () => {
  let lookups = 0;
  let news = 0;
  const provider = createMarketauxProvider(env, mockedFetch(async input => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/entity/search') {
      lookups++;
      assert.equal(url.searchParams.get('search'), '005930');
      assert.equal(url.searchParams.get('countries'), 'kr');
      assert.equal(url.searchParams.get('types'), 'equity');
      return json({ data: [samsungEntity, { ...samsungEntity, symbol: '005935.KS' }] });
    }
    news++;
    assert.equal(url.searchParams.get('symbols'), samsungEntity.symbol);
    return json({ data: [article('samsung', samsungEntity), article('different-listing', { ...samsungEntity, symbol: '005930.KRX' })] });
  }), () => now.getTime());
  const result = await provider.getArticles(samsung, now);
  assert.equal(result.articles[0]?.sentiment, 'negative');
  assert.equal(result.articles.length, 1);
  assert.equal(result.articles[0]?.providerEntity?.symbol, '005930.KS');
  await provider.getArticles(samsung, now);
  assert.equal(lookups, 1);
  assert.equal(news, 2);
});

test('Korean ambiguous, missing, wrong-market or wrong-name mappings stop before fetching news', async () => {
  for (const rows of [
    [], [samsungEntity, { ...samsungEntity, symbol: '005930.KRX' }],
    [samsungEntity, { ...samsungEntity, exchange: 'KOSPI' }],
    [{ ...samsungEntity, name: 'Samsung Securities Co Ltd' }],
    [{ ...samsungEntity, exchange: 'KOSDAQ' }], [{ ...samsungEntity, country: 'us' }],
    [{ ...samsungEntity, type: 'etf' }],
  ]) {
    let calls = 0;
    const provider = createMarketauxProvider(env, mockedFetch(async input => {
      calls++;
      assert.equal(new URL(String(input)).pathname, '/v1/entity/search');
      return json({ data: rows });
    }), () => now.getTime());
    await rejects(provider.getArticles(samsung, now), 'error', 'identity_unverified');
    await rejects(provider.getArticles(samsung, now), 'error', 'identity_unverified');
    assert.equal(calls, 1, 'failed identity resolution is cached instead of spending repeated requests');
  }
});

test('Korean mapping cache expires after six hours', async () => {
  let instant = now.getTime();
  let lookups = 0;
  const provider = createMarketauxProvider(env, mockedFetch(async input => {
    if (new URL(String(input)).pathname === '/v1/entity/search') { lookups++; return json({ data: [samsungEntity] }); }
    return json({ data: [] });
  }), () => instant);
  await provider.getArticles(samsung, now);
  instant += 6 * 3600000 + 1;
  await provider.getArticles(samsung, now);
  assert.equal(lookups, 2);
});

test('empty results, duplicate article identity, descending dates and stale evidence are handled', async () => {
  assert.deepEqual((await providerFor([]).getArticles(apple, now)).articles, []);
  const rows = [article('same'), article('same'), article('stale', appleEntity, { published_at: '2026-09-01T00:00:00Z' })];
  const result = await providerFor(rows).getArticles(apple, now);
  assert.deepEqual(result.articles.map(item => item.id), ['same']);
  const sorted = await providerFor([article('older'), article('newer', appleEntity, { published_at: '2026-10-26T20:00:00Z' })]).getArticles(apple, now);
  assert.deepEqual(sorted.articles.map(item => item.id), ['newer', 'older']);
});

test('returned articles stay within the exact reported seven-day window including both boundaries', async () => {
  const boundary = await providerFor([
    article('start', appleEntity, { published_at: '2026-10-20T00:00:00.000Z' }),
    article('end', appleEntity, { published_at: now.toISOString() }),
    article('future', appleEntity, { published_at: '2026-10-27T00:00:00.001Z' }),
  ]).getArticles(apple, now);
  assert.deepEqual(boundary.articles.map(item => item.id), ['end', 'start']);
  assert.ok(boundary.notes?.some(note => /조회 기간 밖인 기사 1건을 제외/.test(note)));

  const outside = await providerFor([
    article('before-start', appleEntity, { published_at: '2026-10-19T23:59:59.999Z' }),
    article('clock-skew-future', appleEntity, { published_at: '2026-10-27T00:05:00.000Z' }),
  ]).getArticles(apple, now);
  assert.deepEqual(outside.articles, []);
  assert.ok(outside.notes?.some(note => /조회 기간 밖인 기사 2건을 제외/.test(note)));
});

test('malformed article dates, metadata, unsafe links and excessive articles fail safely', async () => {
  for (const override of [
    { published_at: '2026-02-30T00:00:00Z' }, { published_at: '2026-10-28T00:00:00Z' },
    { published_at: '2026-10-26T01:00:00' }, { url: 'http://example.test/article' },
    { url: 'https://user:pass@example.test/article' }, { title: '' }, { language: { private: 'data' } }, { entities: {} },
  ]) await rejects(providerFor([article('bad', appleEntity, override)]).getArticles(apple, now), 'error');
  await rejects(providerFor([article('1'), article('2'), article('3'), article('4')]).getArticles(apple, now), 'error');
});

test('HTTP authentication and plan access failures expose safe reason codes without provider bodies', async () => {
  for (const [status, reason] of [[401, 'invalid_key'], [403, 'access_denied']] as const) {
    const provider = createMarketauxProvider(env, mockedFetch(async () => new Response(`private ${env.MARKETAUX_API_TOKEN}`, { status })));
    await rejects(provider.getArticles(apple, now), 'error', reason);
  }
});

test('quota and rate-limit responses honor Retry-After and share a cooldown across companies', async () => {
  for (const status of [402, 429]) {
    let instant = now.getTime();
    let calls = 0;
    const provider = createMarketauxProvider(env, mockedFetch(async () => {
      calls++;
      return calls === 1 ? new Response('private quota detail', { status, headers: { 'retry-after': '120' } }) : json({ data: [] });
    }), () => instant);
    await assert.rejects(provider.getArticles(apple, now), (error: unknown) => error instanceof ProviderError && error.code === 'rate_limited' && error.retryAfterMs === 120000);
    const nvidia = companies.find(company => company.id === 'nasdaq:NVDA')!;
    await rejects(provider.getArticles(nvidia, now), 'rate_limited');
    assert.equal(calls, 1);
    instant += 120001;
    assert.deepEqual((await provider.getArticles(nvidia, now)).articles, []);
    assert.equal(calls, 2);
  }
});

test('quota default cooldown is fifteen minutes and rate default is one minute', async () => {
  for (const [status, expected] of [[402, 900000], [429, 60000]]) {
    const provider = createMarketauxProvider(env, mockedFetch(async () => new Response('', { status })), () => now.getTime());
    await assert.rejects(provider.getArticles(apple, now), (error: unknown) => error instanceof ProviderError && error.retryAfterMs === expected);
  }
});

test('network failures, invalid JSON, missing JSON metadata and oversized responses never leak tokens', async () => {
  const responses = [
    () => new Response('not json', { headers: { 'content-type': 'application/json' } }),
    () => new Response('{}', { headers: { 'content-type': 'text/html' } }),
    () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '1048577' } }),
    () => json({ data: {}, error: { message: env.MARKETAUX_API_TOKEN } }),
    () => json({ data: [], error: { message: env.MARKETAUX_API_TOKEN } }),
    () => json({ data: [article('echo', appleEntity, { title: env.MARKETAUX_API_TOKEN })] }),
    () => new Response('', { status: 500 }),
  ];
  for (const response of responses) await rejects(createMarketauxProvider(env, mockedFetch(async () => response())).getArticles(apple, now), 'error');
  const failure = createMarketauxProvider(env, mockedFetch(async input => { throw new Error(`upstream ${String(input)}`); }));
  await rejects(failure.getArticles(apple, now), 'error');
});

test('entity lookup and article request share one total fifteen-second timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let newsSignal: AbortSignal | null = null;
  const provider = createMarketauxProvider(env, mockedFetch(async (input, init) => {
    if (new URL(String(input)).pathname === '/v1/entity/search') {
      t.mock.timers.tick(14000);
      return json({ data: [samsungEntity] });
    }
    newsSignal = init?.signal ?? null;
    return new Promise<Response>((_resolve, reject) => {
      newsSignal!.addEventListener('abort', () => reject(new Error(`private ${env.MARKETAUX_API_TOKEN}`)), { once: true });
    });
  }), () => now.getTime());
  const pending = provider.getArticles(samsung, now);
  const rejection = rejects(pending, 'error');
  // The bounded JSON read and entity resolution complete on microtasks.
  for (let count = 0; count < 30 && !newsSignal; count++) await Promise.resolve();
  assert.ok(newsSignal);
  t.mock.timers.tick(999);
  assert.equal((newsSignal as AbortSignal).aborted, false);
  t.mock.timers.tick(1);
  await rejection;
  assert.equal((newsSignal as AbortSignal).aborted, true);
});

test('provider factory honors explicit modes, supports old gateways and rejects unknown modes', async () => {
  const fetcher = mockedFetch(async () => { throw new Error('must not call'); });
  assert.equal(createNewsProvider({}, fetcher).name, 'Marketaux · GDELT');
  assert.equal(createNewsProvider({ NEWS_SOURCES: 'marketaux' }, fetcher).name, 'Marketaux');
  assert.equal(createNewsProvider({ NEWS_SOURCES: ' GDELT ' }, fetcher).name, 'GDELT');
  assert.equal(createNewsProvider({ NEWS_PROVIDER: 'marketaux', NEWS_PROVIDER_URL: 'https://example.test' }, fetcher).name, 'Marketaux · GDELT');
  assert.equal(createNewsProvider({ NEWS_PROVIDER_URL: 'https://example.test' }, fetcher).name, '사용자 뉴스 게이트웨이');
  assert.equal(createNewsProvider({ NEWS_PROVIDER: 'gateway' }, fetcher).name, '사용자 뉴스 게이트웨이');
  await rejects(createNewsProvider({ NEWS_PROVIDER: 'typo' }, fetcher).getArticles(apple, now), 'error');
  await rejects(createNewsProvider({ NEWS_SOURCES: 'marketaux,unknown' }, fetcher).getArticles(apple, now), 'error');
});

test('publisher descriptions become bounded plain text while body snippets and highlights are dropped', async () => {
  const result = await providerFor([
    article('described', appleEntity, {
      description: '  <b>Apple</b> &amp; partners  expand\nproduction  ', snippet: 'BODY TEXT MUST NOT BE KEPT',
      entities: [{ ...appleEntity, highlights: [{ highlight: 'HIGHLIGHT MUST NOT BE KEPT', sentiment: 0.4, highlighted_in: 'main_text' }] }],
    }),
    article('long', appleEntity, { description: 'x'.repeat(400) }),
    article('blank', appleEntity, { description: '   ' }),
  ]).getArticles(apple, now);
  const byId = new Map(result.articles.map(item => [item.id, item]));
  assert.equal(byId.get('described')?.description, 'Apple & partners expand production');
  assert.equal([...byId.get('long')!.description!].length, 300);
  assert.ok(byId.get('long')!.description!.endsWith('…'));
  assert.equal(byId.get('blank')?.description, undefined);
  assert.doesNotMatch(JSON.stringify(result), /MUST NOT BE KEPT/);
  for (const item of result.articles) assert.ok(isNewsArticle(item));
});

test('classified articles explain the provider score in at most five lines, separate from factor sentences', async () => {
  const result = await providerFor([
    article('scored', { ...appleEntity, sentiment_score: 0.45 }),
    article('missing', { ...appleEntity, sentiment_score: undefined }),
  ]).getArticles(apple, now);
  const [scored, missing] = result.articles;
  assert.deepEqual(scored?.rationaleLines, [
    "Marketaux가 이 기사에서 '애플' 언급 문맥에 매긴 감성 점수 +0.45 (−1~1, 0보다 크면 긍정·작으면 부정)",
    '제공자 기업 식별: Apple Inc. · AAPL · 거래소 정보 미제공 · US',
    '기사 분위기 지표이며 주가 방향이나 확률을 뜻하지 않습니다.',
  ]);
  assert.equal(scored?.rationale, scored?.rationaleLines?.join(' '));
  assert.deepEqual(missing?.rationaleLines, ['Marketaux가 이 기업의 감성 점수를 제공하지 않아 미분류로 표시합니다.', '긍정·부정 요인 집계에서 제외합니다.']);
  for (const item of result.articles) assert.ok(item.rationaleLines!.length <= 5);
});
