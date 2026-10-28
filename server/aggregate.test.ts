import test from 'node:test';
import assert from 'node:assert/strict';
import { companies, isNewsArticle, matchesCompanyTitle, type NewsArticle } from '@moneycast/core';
import { createMultiSourceProvider, mergeArticles, titleKey, titleSimilarity, urlKey } from './aggregate.js';
import { ProviderError, type NewsProvider } from './provider.js';

const company = companies.find(item => item.id === 'krx:005930')!;
const now = new Date('2026-10-27T00:00:00Z');
function article(id: string, overrides: Partial<NewsArticle> = {}): NewsArticle {
  return { id, title: `테스트 기사 ${id}`, source: 'a.example', publishedAt: '2026-10-26T01:00:00Z',
    url: `https://a.example/${id}`, sentiment: 'unclassified', rationale: '테스트 근거', ...overrides };
}
function provider(result: () => Promise<{ provider: string; articles: NewsArticle[]; notes?: string[] }>, name = 'Test'): NewsProvider {
  return { name, cacheTtlMs: 21600000, getArticles: result };
}

test('URL keys ignore tracking, mobile hosts, fragments and trailing slashes but keep identifying parameters', () => {
  assert.equal(urlKey('https://www.Example.com/news/1/?utm_source=x&fbclid=y#top'), 'example.com/news/1');
  assert.equal(urlKey('https://m.example.com/news/1'), urlKey('https://example.com/news/1/'));
  assert.equal(urlKey('https://example.com/news/1/amp'), urlKey('https://example.com/news/1'));
  assert.equal(urlKey('https://example.com/view?b=2&id=7&utm_medium=z'), 'example.com/view?b=2&id=7');
  assert.notEqual(urlKey('https://example.com/view?id=7'), urlKey('https://example.com/view?id=8'));
});

test('title keys drop wire tags and trailing publishers so copies compare equal', () => {
  assert.equal(titleKey('[속보] 삼성전자, 3분기 영업이익 개선 - 연합뉴스'), titleKey('삼성전자 3분기 영업이익 개선'));
  assert.equal(titleKey('Samsung profit jumps | Reuters'), titleKey('Samsung profit jumps!'));
  assert.ok(titleSimilarity('삼성전자 3분기 영업이익 10조 돌파', '삼성전자, 3분기 영업이익 10조원 돌파') >= 0.8);
  // Near-identical wording about a different quarter or direction stays a separate story.
  assert.ok(titleSimilarity('삼성전자 3분기 영업이익 개선', '삼성전자 4분기 영업이익 개선') < 0.8);
  assert.ok(titleSimilarity('Samsung profit jumps', 'Samsung profit slumps') < 0.8);
  assert.ok(titleSimilarity('Samsung profit jumps', 'Hynix shares fall') < 0.3);
});

test('company title matching respects Korean particles, whole English words and other issuers', () => {
  assert.equal(matchesCompanyTitle('krx:005930', '삼성전자는 3분기에'), true);
  assert.equal(matchesCompanyTitle('krx:005930', '삼성전자우 급등'), false);
  assert.equal(matchesCompanyTitle('krx:005380', '현대차 신차 공개'), true);
  assert.equal(matchesCompanyTitle('krx:005380', '현대모비스·현대차 동반 강세'), false);
  assert.equal(matchesCompanyTitle('nasdaq:AAPL', 'Apple unveils new iPhone'), true);
  assert.equal(matchesCompanyTitle('nasdaq:AAPL', 'Pineapple prices climb'), false);
  assert.equal(matchesCompanyTitle('nasdaq:AAPL', 'Apple Hospitality REIT earnings'), false);
  assert.equal(matchesCompanyTitle('nasdaq:TSLA', 'Nikola Tesla museum reopens'), false);
  assert.equal(matchesCompanyTitle('unknown', 'Apple'), false);
});

test('stories are merged once across sources, keep a classified representative and list other publishers', () => {
  const marketaux = article('m1', { title: 'Samsung profit jumps', source: 'reuters.com', url: 'https://www.reuters.com/a?utm_source=x',
    sentiment: 'positive', sentimentScore: 0.4, classificationMethod: 'provider' });
  const gdeltCopy = article('g1', { title: 'Samsung profit jumps - Reuters', source: 'yahoo.com', url: 'https://yahoo.com/b' });
  const sameUrl = article('g2', { title: 'Different headline', source: 'reuters.com', url: 'https://reuters.com/a/' });
  const unrelated = article('g3', { title: '전혀 다른 기사', source: 'b.example', publishedAt: '2026-10-26T05:00:00Z' });
  const merged = mergeArticles([[marketaux], [gdeltCopy, sameUrl, unrelated]]);
  assert.deepEqual(merged.map(item => item.id), ['g3', 'm1']);
  assert.deepEqual(merged[1]!.alsoReportedBy, [{ source: 'yahoo.com', url: 'https://yahoo.com/b' }]);
  assert.equal(merged[1]!.sentiment, 'positive');
  // A classified copy found later still represents the story.
  const promoted = mergeArticles([[gdeltCopy], [marketaux]]);
  assert.equal(promoted.length, 1);
  assert.equal(promoted[0]!.id, 'm1');
  assert.deepEqual(promoted[0]!.alsoReportedBy?.map(item => item.source), ['yahoo.com']);
  for (const item of merged) assert.ok(isNewsArticle(item));
  // Similar titles far apart in time are separate stories.
  assert.equal(mergeArticles([[article('x', { title: '삼성전자 영업이익 개선' })],
    [article('y', { title: '삼성전자 영업이익 개선', source: 'c.example', url: 'https://c.example/y', publishedAt: '2026-10-20T01:00:00Z' })]]).length, 1);
  assert.equal(mergeArticles([[article('x', { title: '삼성전자 영업이익 개선 소식' })],
    [article('y', { title: '삼성전자 영업이익 개선 소식들', source: 'c.example', url: 'https://c.example/y', publishedAt: '2026-10-20T01:00:00Z' })]]).length, 2);
});

test('one failing or exhausted source never blocks results from the others and stays visible', async () => {
  const combined = createMultiSourceProvider([
    { id: 'marketaux', label: 'Marketaux', provider: provider(async () => { throw new ProviderError('rate_limited', undefined, 900000); }) },
    { id: 'gdelt', label: 'GDELT', provider: provider(async () => ({ provider: 'GDELT', articles: [article('g1')], notes: ['GDELT 안내'] })) },
  ]);
  assert.equal(combined.name, 'Marketaux · GDELT');
  const result = await combined.getArticles(company, now);
  assert.equal(result.provider, 'GDELT');
  assert.deepEqual(result.articles.map(item => item.id), ['g1']);
  assert.deepEqual(result.notes, ['GDELT 안내']);
  assert.deepEqual(result.sources, [
    { id: 'marketaux', label: 'Marketaux', status: 'rate_limited', articleCount: 0, retryAt: '2026-10-27T00:15:00.000Z' },
    { id: 'gdelt', label: 'GDELT', status: 'ok', articleCount: 1 },
  ]);
  const empty = await createMultiSourceProvider([
    { id: 'marketaux', label: 'Marketaux', provider: provider(async () => ({ provider: 'Marketaux', articles: [] })) },
    { id: 'gdelt', label: 'GDELT', provider: provider(async () => { throw new Error('network'); }) },
  ]).getArticles(company, now);
  assert.equal(empty.provider, 'Marketaux');
  assert.deepEqual(empty.sources?.map(source => source.status), ['empty', 'error']);
});

test('when every source fails the combined state keeps each outcome and never hides a transient error', async () => {
  const fail = (error: unknown) => provider(async () => { throw error; });
  const cases: Array<[unknown[], ProviderError['code'], number | undefined]> = [
    [[new ProviderError('not_configured'), new ProviderError('not_configured')], 'not_configured', undefined],
    [[new ProviderError('rate_limited', undefined, 900000), new ProviderError('rate_limited', undefined, 60000)], 'rate_limited', 60000],
    [[new ProviderError('not_configured'), new ProviderError('rate_limited', undefined, 60000)], 'rate_limited', 60000],
    [[new ProviderError('rate_limited', undefined, 86400000), new Error('secret detail')], 'error', undefined],
    [[new ProviderError('error', 'invalid_key'), new ProviderError('rate_limited')], 'error', undefined],
  ];
  for (const [errors, code, retry] of cases) {
    const combined = createMultiSourceProvider(errors.map((error, i) => ({ id: `s${i}`, label: `S${i}`, provider: fail(error) })));
    await assert.rejects(combined.getArticles(company, now), (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, code);
      assert.equal(error.retryAfterMs, retry);
      assert.equal(error.sources?.length, 2);
      assert.doesNotMatch(JSON.stringify(error.sources), /secret/);
      return true;
    });
  }
  const keyed = createMultiSourceProvider([
    { id: 'a', label: 'A', provider: fail(new ProviderError('error', 'invalid_key')) },
    { id: 'b', label: 'B', provider: fail(new Error('down')) },
  ]);
  await assert.rejects(keyed.getArticles(company, now), (error: unknown) => error instanceof ProviderError && error.reason === 'invalid_key');
});

test('a skipped source is reported but never counts as a success that would hide a failure', async () => {
  const skipped = provider(async () => ({ provider: 'GDELT', articles: [], skipped: true }) as never);
  const ok = await createMultiSourceProvider([
    { id: 'marketaux', label: 'Marketaux', provider: provider(async () => ({ provider: 'Marketaux', articles: [article('m1')] })) },
    { id: 'gdelt', label: 'GDELT', provider: skipped },
  ]).getArticles(company, now);
  assert.equal(ok.provider, 'Marketaux');
  assert.deepEqual(ok.sources?.map(source => [source.id, source.status]), [['marketaux', 'ok'], ['gdelt', 'skipped']]);
  // Marketaux out of quota and GDELT not asked: a failure, so the last good result can be shown instead.
  await assert.rejects(createMultiSourceProvider([
    { id: 'marketaux', label: 'Marketaux', provider: provider(async () => { throw new ProviderError('rate_limited', undefined, 60000); }) },
    { id: 'gdelt', label: 'GDELT', provider: skipped },
  ]).getArticles(company, now), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.code, 'rate_limited');
    assert.deepEqual(error.sources?.map(source => source.status), ['rate_limited', 'skipped']);
    return true;
  });
  const none = await createMultiSourceProvider([{ id: 'gdelt', label: 'GDELT', provider: skipped }]).getArticles(company, now);
  assert.deepEqual([none.articles, none.sources?.map(source => source.status)], [[], ['skipped']]);
});
