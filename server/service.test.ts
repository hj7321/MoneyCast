import test from 'node:test';
import assert from 'node:assert/strict';
import { companies, isNewsAnalysis, NEWS_CACHE_TTL_MS, type NewsArticle } from '@moneycast/core';
import { createNewsService, nextAnalysisWeek } from './service.js';
import { ProviderError, type NewsProvider } from './provider.js';

const company = companies[0]!;
const now = new Date('2026-10-27T00:00:00Z');
function article(id: string, sentiment: NewsArticle['sentiment'] = 'positive', publishedAt = '2026-10-26T01:00:00Z'): NewsArticle {
  return { id, title: '테스트용 기사', source: 'Test', publishedAt, url: `https://example.test/${id}`, sentiment, rationale: `테스트 근거 ${id}` };
}
function serviceWith(articles: NewsArticle[]) {
  return createNewsService({ getArticles: async () => ({ provider: 'Test', articles }) }, () => now);
}

test('next Monday-Friday uses Seoul local day, including Sunday UTC rollover and year boundary', () => {
  assert.deepEqual(nextAnalysisWeek(now), { start: '2026-11-02', end: '2026-11-06' });
  assert.deepEqual(nextAnalysisWeek(new Date('2026-10-25T16:00:00Z')), { start: '2026-11-02', end: '2026-11-06' });
  assert.deepEqual(nextAnalysisWeek(new Date('2026-10-25T01:00:00Z')), { start: '2026-10-26', end: '2026-10-30' });
  assert.deepEqual(nextAnalysisWeek(new Date('2026-12-31T20:00:00Z')), { start: '2027-01-04', end: '2027-01-08' });
});

test('no articles, too few, stale, neutral and conflicting evidence all withhold direction', async () => {
  for (const articles of [
    [], [article('1')], [article('1', 'positive', '2026-10-01T00:00:00Z')],
    [article('1', 'neutral'), article('2', 'neutral'), article('3', 'neutral')],
    [article('1'), article('2'), article('3', 'negative')],
  ]) {
    const result = await serviceWith(articles).getAnalysis(company);
    assert.equal(result.status, 'insufficient');
    assert.notEqual(result.evidence, 'moderate');
    assert.match(result.summary, /不足|부족|유보/);
  }
});

test('sufficient fresh news yields a qualified summary and traceable source/time/version', async () => {
  const result = await serviceWith([article('1'), article('2'), article('3')]).getAnalysis(company);
  assert.equal(result.status, 'ready');
  assert.equal(result.evidence, 'moderate');
  assert.match(result.summary, /불확실/);
  assert.equal(result.asOf, now.toISOString());
  assert.equal(result.analysisVersion, 'news-evidence-v2');
  assert.equal(result.provider, 'Test');
  assert.equal(result.positiveFactors.length, 3);
  assert.ok(result.risks.length >= 3);
});

test('configuration, rate-limit and unexpected failures return no invented articles or secrets', async () => {
  for (const code of ['not_configured', 'rate_limited', 'error'] as const) {
    const service = createNewsService({ getArticles: async () => { throw new ProviderError(code); } }, () => now);
    const result = await service.getAnalysis(company);
    assert.equal(result.status, code);
    assert.deepEqual(result.articles, []);
    assert.equal(result.evidence, 'none');
    assert.ok(result.message);
  }
  const service = createNewsService({ getArticles: async () => { throw new Error('secret'); } }, () => now);
  assert.ok(!JSON.stringify(await service.getAnalysis(company)).includes('secret'));
});

test('parallel reads deduplicate and cache successful gateway calls for a minute', async () => {
  let requests = 0;
  let instant = now;
  const provider: NewsProvider = { getArticles: async () => { requests++; return { provider: 'Test', articles: [] }; } };
  const service = createNewsService(provider, () => instant);
  await Promise.all([service.getAnalysis(company), service.getAnalysis(company)]);
  await service.getAnalysis(company);
  assert.equal(requests, 1);
  instant = new Date(now.getTime() + 61000);
  await service.getAnalysis(company);
  assert.equal(requests, 2);
});

test('unclassified articles remain visible but do not satisfy the classified evidence threshold', async () => {
  const result = await serviceWith([article('1'), article('2'), article('3', 'unclassified')]).getAnalysis(company);
  assert.equal(result.status, 'insufficient');
  assert.equal(result.evidence, 'low');
  assert.equal(result.articles.length, 3);
  assert.equal(result.positiveFactors.length, 2);
  assert.match(result.summary, /분류 미확인/);
  assert.match(result.summary, /분류된 기사 2건/);
  assert.ok(result.risks.some(risk => /분류 미확인 기사 1건.*포함하지/.test(risk)));
  assert.equal(isNewsAnalysis(result, company.id), true);
  const sufficient = await serviceWith([article('1'), article('2'), article('3', 'neutral'), article('4', 'unclassified')]).getAnalysis(company);
  assert.equal(sufficient.status, 'ready');
  assert.equal(sufficient.positiveFactors.length, 2);
});

test('evidence uses the exact reported news window rather than counting future or older articles', async () => {
  const result = await serviceWith([
    article('start', 'positive', '2026-10-20T00:00:00Z'),
    article('end', 'positive', '2026-10-27T00:00:00Z'),
    article('older', 'positive', '2026-10-19T23:59:59.999Z'),
    article('future', 'negative', '2026-10-27T00:00:00.001Z'),
  ]).getAnalysis(company);
  assert.equal(result.status, 'insufficient');
  assert.equal(result.positiveFactors.length, 2);
  assert.equal(result.negativeFactors.length, 0);
  assert.match(result.summary, /3건 미만/);
});

test('missing classification does not imply neutral, and actual neutral evidence is explained', async () => {
  const missing = await serviceWith([article('1', 'unclassified'), article('2', 'unclassified'), article('3', 'unclassified')]).getAnalysis(company);
  assert.equal(missing.status, 'insufficient');
  assert.deepEqual(missing.positiveFactors, []);
  assert.deepEqual(missing.negativeFactors, []);
  assert.match(missing.summary, /분류 미확인/);
  assert.doesNotMatch(missing.summary, /중립/);
  const neutral = await serviceWith([article('1', 'neutral'), article('2', 'neutral'), article('3', 'neutral'), article('4', 'unclassified')]).getAnalysis(company);
  assert.equal(neutral.status, 'insufficient');
  assert.match(neutral.summary, /분류를 확인한.*중립/);
});

test('service exposes provider-specific setup and safe error reasons without raw upstream details', async () => {
  const setup = await createNewsService({
    name: 'Marketaux', setupMessage: '서버에 MARKETAUX_API_TOKEN을 설정해 주세요.', cacheTtlMs: 300000,
    getArticles: async () => { throw new ProviderError('not_configured'); },
  }, () => now).getAnalysis(company);
  assert.equal(setup.provider, 'Marketaux');
  assert.match(setup.message!, /MARKETAUX_API_TOKEN/);
  assert.equal(setup.cachedUntil, '2026-10-27T00:00:05.000Z');
  for (const [reason, expected] of [
    ['invalid_key', /API 키가 유효하지/],
    ['access_denied', /접근 권한과 플랜/],
    ['identity_unverified', /정확히 확인하지/],
  ] as const) {
    const service = createNewsService({ name: 'Marketaux', getArticles: async () => {
      const error = new ProviderError('error', reason);
      error.message = 'private-provider-response-and-secret';
      throw error;
    } }, () => now);
    const result = await service.getAnalysis(company);
    assert.equal(result.status, 'error');
    assert.equal(result.provider, 'Marketaux');
    assert.match(result.message!, expected);
    assert.equal(result.cachedUntil, '2026-10-27T00:00:05.000Z');
    assert.doesNotMatch(JSON.stringify(result), /private-provider-response-and-secret/);
  }
});

test('provider notes and a precise seven-day news window are preserved with all cache states', async () => {
  const service = createNewsService({
    name: 'Marketaux', getArticles: async () => ({ provider: 'Marketaux', articles: [], notes: ['영어 원문이 포함될 수 있습니다.', '거래소 식별 정보가 일부 누락되었습니다.'] }),
  }, () => now);
  const result = await service.getAnalysis(company);
  assert.deepEqual(result.newsWindow, { start: '2026-10-20T00:00:00.000Z', end: '2026-10-27T00:00:00.000Z' });
  assert.equal(result.cachedUntil, '2026-10-27T00:01:00.000Z');
  assert.ok(result.risks.includes('영어 원문이 포함될 수 있습니다.'));
  assert.ok(result.risks.includes('거래소 식별 정보가 일부 누락되었습니다.'));
  assert.equal(isNewsAnalysis(result), true);
  for (const code of ['not_configured', 'rate_limited', 'error'] as const) {
    const failure = await createNewsService({ getArticles: async () => { throw new ProviderError(code); } }, () => now).getAnalysis(company);
    assert.deepEqual(failure.newsWindow, result.newsWindow);
    assert.ok(failure.cachedUntil);
    assert.equal(isNewsAnalysis(failure), true);
  }
});

test('provider cache TTL starts when the request finishes and changes neither cutoff nor cached identity', async () => {
  let instant = now;
  let requests = 0;
  const service = createNewsService({ name: 'Marketaux', cacheTtlMs: 300000, getArticles: async () => {
    requests += 1;
    instant = new Date(instant.getTime() + 8000);
    return { provider: 'Marketaux', articles: [] };
  } }, () => instant);
  const first = await service.getAnalysis(company);
  assert.equal(first.asOf, now.toISOString());
  assert.equal(first.newsWindow!.end, now.toISOString());
  assert.equal(first.cachedUntil, '2026-10-27T00:05:08.000Z');
  instant = new Date('2026-10-27T00:05:07.999Z');
  assert.equal(await service.getAnalysis(company), first);
  assert.equal(requests, 1);
  instant = new Date('2026-10-27T00:05:08.000Z');
  await service.getAnalysis(company);
  assert.equal(requests, 2);
});

test('rate-limit retry time extends cache expiry and prevents early provider retries', async () => {
  let instant = now;
  let requests = 0;
  const service = createNewsService({ name: 'Marketaux', cacheTtlMs: 300000, getArticles: async () => {
    requests += 1;
    if (requests === 1) throw new ProviderError('rate_limited', undefined, 3600000);
    return { provider: 'Marketaux', articles: [] };
  } }, () => instant);
  const limited = await service.getAnalysis(company);
  assert.equal(limited.retryAt, '2026-10-27T01:00:00.000Z');
  assert.equal(limited.cachedUntil, limited.retryAt);
  instant = new Date('2026-10-27T00:06:00Z');
  assert.equal(await service.getAnalysis(company), limited);
  instant = new Date('2026-10-27T00:59:59.999Z');
  await service.getAnalysis(company);
  assert.equal(requests, 1);
  instant = new Date('2026-10-27T01:00:00Z');
  const recovered = await service.getAnalysis(company);
  assert.equal(requests, 2);
  assert.equal(recovered.status, 'insufficient');
  assert.equal(recovered.retryAt, undefined);
  assert.equal(recovered.cachedUntil, '2026-10-27T01:05:00.000Z');
});

test('a short rate limit uses a one-minute cooldown instead of the successful news TTL', async () => {
  const result = await createNewsService({ name: 'Marketaux', cacheTtlMs: 300000,
    getArticles: async () => { throw new ProviderError('rate_limited', undefined, 1000); },
  }, () => now).getAnalysis(company);
  assert.equal(result.retryAt, '2026-10-27T00:01:00.000Z');
  assert.equal(result.cachedUntil, result.retryAt);
});

test('six-hour news cache reuses the original snapshot until the exact expiry', async () => {
  let instant = now;
  let requests = 0;
  const service = createNewsService({ name: 'Marketaux', cacheTtlMs: NEWS_CACHE_TTL_MS, getArticles: async () => {
    requests++;
    return { provider: 'Marketaux', articles: [] };
  } }, () => instant);
  const first = await service.getAnalysis(company);
  assert.equal(first.cachedUntil, '2026-10-27T06:00:00.000Z');
  instant = new Date(now.getTime() + NEWS_CACHE_TTL_MS - 1);
  assert.equal(await service.getAnalysis(company), first);
  assert.equal(requests, 1);
  instant = new Date(now.getTime() + NEWS_CACHE_TTL_MS);
  const next = await service.getAnalysis(company);
  assert.equal(requests, 2);
  assert.equal(next.asOf, instant.toISOString());
  assert.equal(next.cachedUntil, '2026-10-27T12:00:00.000Z');
});

test('a six-hour provider TTL does not trap missing keys or rate limits for six hours', async () => {
  let instant = now;
  let requests = 0;
  const missing = createNewsService({ name: 'Marketaux', cacheTtlMs: NEWS_CACHE_TTL_MS, getArticles: async () => {
    requests++;
    if (requests === 1) throw new ProviderError('not_configured');
    return { provider: 'Marketaux', articles: [] };
  } }, () => instant);
  const first = await missing.getAnalysis(company);
  assert.equal(first.cachedUntil, '2026-10-27T00:00:05.000Z');
  instant = new Date(now.getTime() + 5000);
  assert.equal((await missing.getAnalysis(company)).status, 'insufficient');
  assert.equal(requests, 2);
  const limited = await createNewsService({ name: 'Marketaux', cacheTtlMs: NEWS_CACHE_TTL_MS, getArticles: async () => {
    throw new ProviderError('rate_limited', undefined, 900000);
  } }, () => now).getAnalysis(company);
  assert.equal(limited.retryAt, '2026-10-27T00:15:00.000Z');
  assert.equal(limited.cachedUntil, limited.retryAt);
});
