import test from 'node:test';
import assert from 'node:assert/strict';
import { companies, isNewsArticle } from '@moneycast/core';
import { createGdeltProvider, GDELT_NOTES, parseSeenDate } from './gdelt.js';
import { ProviderError } from './provider.js';

const now = new Date('2026-10-27T00:00:00Z');
const samsung = companies.find(company => company.id === 'krx:005930')!;
const apple = companies.find(company => company.id === 'nasdaq:AAPL')!;
function row(overrides: Record<string, unknown> = {}) {
  return { url: 'https://news.example/samsung-1', url_mobile: '', title: '삼성전자, 테스트용 기사 제목', seendate: '20261026T013000Z',
    socialimage: 'https://news.example/image.jpg', domain: 'news.example', language: 'Korean', sourcecountry: 'South Korea', ...overrides };
}
function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), { ...init, headers: { 'content-type': 'application/json; charset=utf-8', ...init.headers } });
}
function gdelt(handler: (url: URL, init?: RequestInit) => Promise<Response>, clock: () => number = () => now.getTime(), sleep = async (_ms: number) => {}) {
  return createGdeltProvider((async (input: Parameters<typeof fetch>[0], init?: RequestInit) => handler(new URL(String(input)), init)) as typeof fetch, clock, sleep);
}
async function rejects(promise: Promise<unknown>, code: ProviderError['code']) {
  await assert.rejects(promise, (error: unknown) => error instanceof ProviderError && error.code === code);
}

test('GDELT seen dates convert to ISO time and malformed values are rejected', () => {
  assert.equal(parseSeenDate('20261026T013000Z'), '2026-10-26T01:30:00Z');
  for (const value of ['2026-10-26', '20261326T013000Z', '20260230T000000Z', '20261026T250000Z', 20261026, null]) {
    assert.equal(parseSeenDate(value), null, String(value));
  }
});

test('GDELT uses a fixed host, an English company query and the exact seven-day window without any key', async () => {
  let calls = 0;
  const result = await gdelt(async (url, init) => {
    calls++;
    assert.equal(url.origin + url.pathname, 'https://api.gdeltproject.org/api/v2/doc/doc');
    assert.equal(url.searchParams.get('query'), '"Samsung Electronics"');
    assert.equal(url.searchParams.get('mode'), 'artlist');
    assert.equal(url.searchParams.get('format'), 'json');
    assert.equal(url.searchParams.get('sort'), 'datedesc');
    assert.equal(url.searchParams.get('maxrecords'), '50');
    assert.equal(url.searchParams.get('startdatetime'), '20261020000000');
    assert.equal(url.searchParams.get('enddatetime'), '20261027000000');
    assert.equal([...url.searchParams.keys()].some(key => /key|token/i.test(key)), false);
    assert.equal(init?.redirect, 'error');
    return json({ articles: [row()] });
  }).getArticles(samsung, now);
  assert.equal(calls, 1);
  const [article] = result.articles;
  assert.equal(result.provider, 'GDELT');
  assert.equal(article?.publishedAt, '2026-10-26T01:30:00Z');
  assert.equal(article?.timeKind, 'seen');
  assert.equal(article?.identity, 'name_match');
  assert.equal(article?.sourceProvider, 'GDELT');
  assert.equal(article?.sentiment, 'unclassified');
  assert.equal(article?.classificationMethod, 'unavailable');
  assert.equal(article?.language, 'ko');
  assert.equal(article?.source, 'news.example');
  assert.match(article!.id, /^gdelt-[0-9a-f]{24}$/);
  assert.ok(article!.rationaleLines!.some(line => /종목·거래소는 확인되지 않았습니다/.test(line)));
  assert.ok(isNewsArticle(article));
  for (const note of GDELT_NOTES) assert.ok(result.notes?.includes(note));
});

test('GDELT keeps only https articles that name the company and stay inside the window', async () => {
  const result = await gdelt(async () => json({ articles: [
    row(),
    row({ url: 'http://news.example/insecure', title: '삼성전자 보안 연결 아님' }),
    row({ url: 'https://user:pw@news.example/credentials' }),
    row({ url: 'https://news.example/other', title: 'SK하이닉스 기사' }),
    row({ url: 'https://news.example/preferred', title: '삼성전자우 급등' }),
    row({ url: 'https://news.example/old', seendate: '20261019T235959Z' }),
    row({ url: 'https://news.example/future', seendate: '20261027T000001Z' }),
    row({ url: 'https://news.example/bad-date', seendate: 'yesterday' }),
    row({ url: 'https://news.example/no-title', title: '' }),
    { not: 'an article' },
  ] })).getArticles(samsung, now);
  assert.deepEqual(result.articles.map(item => item.url), ['https://news.example/samsung-1']);
  assert.ok(result.notes?.some(note => /https\)이 아닌 GDELT 기사 2건/.test(note)));
  assert.ok(result.notes?.some(note => /다른 회사로 보이는 GDELT 기사 2건/.test(note)));
});

test('GDELT empty results, bounded rows, plain-text throttling and HTTP 429 are handled distinctly', async () => {
  assert.deepEqual((await gdelt(async () => json({})).getArticles(apple, now)).articles, []);
  await rejects(gdelt(async () => json({ articles: 'not a list' })).getArticles(apple, now), 'error');
  await rejects(gdelt(async () => json({ articles: Array.from({ length: 251 }, () => row()) })).getArticles(apple, now), 'error');
  await rejects(gdelt(async () => new Response('Please limit requests to one every 5 seconds.', { headers: { 'content-type': 'text/plain' } })).getArticles(apple, now), 'rate_limited');
  await rejects(gdelt(async () => new Response('Your query was too short.', { headers: { 'content-type': 'text/html' } })).getArticles(apple, now), 'error');
  await rejects(gdelt(async () => new Response('{"broken', { headers: { 'content-type': 'application/json' } })).getArticles(apple, now), 'error');
  await rejects(gdelt(async () => new Response('server', { status: 500 })).getArticles(apple, now), 'error');
  await rejects(gdelt(async () => { throw new TypeError('network'); }).getArticles(apple, now), 'error');
  let instant = now.getTime();
  let calls = 0;
  const limited = gdelt(async () => { calls++; return new Response('slow down', { status: 429 }); }, () => instant);
  await rejects(limited.getArticles(apple, now), 'rate_limited');
  instant += 30_000;
  await rejects(limited.getArticles(apple, now), 'rate_limited');
  assert.equal(calls, 1);
});

test('GDELT requests from one process are spaced five seconds apart and a long queue skips the source', async () => {
  let instant = now.getTime();
  const waits: number[] = [];
  const provider = gdelt(async () => json({ articles: [] }), () => instant, async ms => { waits.push(ms); });
  await provider.getArticles(samsung, now);
  instant += 1_000;
  await provider.getArticles(apple, now);
  assert.deepEqual(waits, [4_000]);
  // The next free slot is now nine seconds away: too long to hold this refresh.
  await rejects(provider.getArticles(samsung, now), 'rate_limited');
  instant += 9_000;
  await provider.getArticles(apple, now);
  assert.deepEqual(waits, [4_000]);
});
