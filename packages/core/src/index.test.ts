import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  calculateProjection, calculateScenarios, validateCalculatorInput,
  CalculatorValidationError, DEFAULT_CALCULATOR_INPUT, COMPANIES,
  searchCompanies, formatKRW, formatCompactKRW, formatDurationMonths,
  isNewsAnalysis, type NewsAnalysis,
} from './index.ts';

const base = { ...DEFAULT_CALCULATOR_INPUT };

test('whole-month duration labels show months and years without fractional years', () => {
  for (const [months, expected] of [[0, '0개월'], [1, '1개월'], [11, '11개월'], [12, '1년'], [13, '1년 1개월'], [60, '5년'], [600, '50년']] as const) {
    assert.equal(formatDurationMonths(months), expected);
  }
  for (const invalid of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.equal(formatDurationMonths(invalid), '—');
});

test('zero rate is exactly seed plus all monthly deposits', () => {
  const result = calculateProjection({ ...base, annualRate: 0 });
  assert.equal(result.finalBalance, 40_000_000);
  assert.equal(result.totalPrincipal, 40_000_000);
  assert.equal(result.totalProfit, 0);
  assert.equal(result.gap, -10_000_000);
  assert.equal(result.achieved, false);
  assert.equal(result.months, 60);
  assert.equal(result.points.length, 61);
});

test('all-zero inputs produce zero without NaN', () => {
  const result = calculateProjection({ initial: 0, monthly: 0, annualRate: 0, years: 5, target: 0 });
  assert.equal(result.finalBalance, 0);
  assert.equal(result.totalProfit, 0);
  assert.equal(result.achieved, true);
});

test('effective monthly conversion reproduces annual compounding', () => {
  const result = calculateProjection({ initial: 100_000, monthly: 0, annualRate: 12, years: 1, target: 0 });
  assert.equal(result.finalBalance, 112_000);
});

test('contributions are made at month end; final deposit earns no interest', () => {
  const rate = (1.12 ** (1 / 12)) - 1;
  const result = calculateProjection({ initial: 0, monthly: 1_000_000, annualRate: 12, years: 2 / 12, target: 0 });
  assert.equal(result.points[1]?.balance, 1_000_000);
  assert.equal(result.finalBalance, Math.round(1_000_000 * (1 + rate) + 1_000_000));
});

test('one-month duration includes initial point and month-end payment', () => {
  const result = calculateProjection({ ...base, annualRate: 0, years: 1 / 12 });
  assert.equal(result.points.length, 2);
  assert.equal(result.finalBalance, 10_500_000);
});

test('negative returns are allowed and show a loss', () => {
  const result = calculateProjection({ initial: 100_000, monthly: 0, annualRate: -50, years: 1, target: 75_000 });
  assert.equal(result.finalBalance, 50_000);
  assert.equal(result.totalProfit, -50_000);
  assert.equal(result.gap, -25_000);
});

test('equal goal is achieved', () => {
  const result = calculateProjection({ ...base, annualRate: 0, target: 40_000_000 });
  assert.equal(result.gap, 0);
  assert.equal(result.achieved, true);
});

test('rounding occurs on returned values and displayed components add up', () => {
  const result = calculateProjection({ initial: 0.4, monthly: 0.4, annualRate: 10, years: 1, target: 0 });
  let raw = 0.4;
  const rate = Math.expm1(Math.log1p(0.1) / 12);
  for (let i = 0; i < 12; i++) raw = raw * (1 + rate) + 0.4;
  assert.equal(result.finalBalance, Math.round(raw));
  for (const point of result.points) assert.equal(point.balance, point.principal + point.profit);
});

test('negative amounts, missing fields, strings, NaN and infinity are rejected', () => {
  for (const field of ['initial', 'monthly', 'target'] as const) {
    for (const value of [-1, undefined, '100', NaN, Infinity]) {
      assert.ok(validateCalculatorInput({ ...base, [field]: value })[field]);
    }
  }
  assert.equal(Object.keys(validateCalculatorInput(null)).length, 5);
  assert.equal(Object.keys(validateCalculatorInput({})).length, 5);
  assert.ok(validateCalculatorInput({ ...base, annualRate: NaN }).annualRate);
  assert.ok(validateCalculatorInput({ ...base, years: Infinity }).years);
});

test('annual rate bounds exclude -100 and allow 100', () => {
  assert.ok(validateCalculatorInput({ ...base, annualRate: -100 }).annualRate);
  assert.ok(validateCalculatorInput({ ...base, annualRate: 100.1 }).annualRate);
  assert.deepEqual(validateCalculatorInput({ ...base, annualRate: 100 }), {});
  assert.deepEqual(validateCalculatorInput({ ...base, annualRate: -99.99 }), {});
});

test('duration bounds allow 1 month and 50 years; reject fractional months', () => {
  for (const years of [0, -1, 50.1, 0.1]) assert.ok(validateCalculatorInput({ ...base, years }).years);
  assert.deepEqual(validateCalculatorInput({ ...base, years: 1 / 12 }), {});
  assert.deepEqual(validateCalculatorInput({ ...base, years: 50 }), {});
  assert.equal(calculateProjection({ ...base, years: 50 }).months, 600);
});

test('large amounts within safe precision work, excess input and result are rejected', () => {
  const result = calculateProjection({ initial: 1e12, monthly: 1e12, target: 1e12, annualRate: 0, years: 50 });
  assert.equal(result.finalBalance, 601e12);
  assert.ok(validateCalculatorInput({ ...base, initial: 1e12 + 1 }).initial);
  const errors = validateCalculatorInput({ ...base, initial: 1e12, annualRate: 100, years: 50 });
  assert.ok(errors.projection);
});

test('invalid calculations throw typed validation errors', () => {
  assert.throws(() => calculateProjection({ ...base, monthly: -1 }), CalculatorValidationError);
});

test('scenario projections use explicit hypothetical rate differences', () => {
  const results = calculateScenarios(base);
  assert.deepEqual(results.map((item) => item.annualRate), [3, 5, 7]);
  assert.ok(results[0]!.projection.finalBalance < results[1]!.projection.finalBalance);
  assert.ok(results[1]!.projection.finalBalance < results[2]!.projection.finalBalance);
  assert.throws(() => calculateScenarios(base, -1), RangeError);
});

test('scenario rates stay within supported rate boundaries', () => {
  assert.equal(calculateScenarios({ ...base, annualRate: 100 })[2]?.annualRate, 100);
  assert.equal(calculateScenarios({ ...base, annualRate: -99.9 })[0]?.annualRate, -99.99);
  const extremeLoss = calculateScenarios({ ...base, annualRate: -99.999 });
  assert.ok(extremeLoss[0]!.annualRate <= extremeLoss[1]!.annualRate);
  assert.ok(extremeLoss[0]!.projection.finalBalance <= extremeLoss[1]!.projection.finalBalance);
});

test('company search matches Korean, aliases and symbols without ambiguity', () => {
  assert.equal(searchCompanies('005930')[0]?.id, 'krx:005930');
  assert.equal(searchCompanies('samsung')[0]?.name, '삼성전자');
  assert.equal(searchCompanies('SK 하이닉스')[0]?.symbol, '000660');
  assert.equal(searchCompanies('nvda')[0]?.exchange, 'NASDAQ');
  assert.equal(searchCompanies('ＮＶＤＡ')[0]?.id, 'nasdaq:NVDA');
  assert.deepEqual(searchCompanies('없는회사'), []);
  assert.equal(searchCompanies('').length, COMPANIES.length);
  assert.equal(new Set(COMPANIES.map((company) => company.id)).size, COMPANIES.length);
});

test('currency helpers format Korean won and safe empty values', () => {
  assert.equal(formatKRW(12_345.6), '12,346원');
  assert.equal(formatKRW(-100), '-100원');
  assert.equal(formatKRW(NaN), '—');
  assert.equal(formatCompactKRW(50_000_000), '5,000만 원');
  assert.equal(formatCompactKRW(100_000_000), '1억 원');
});

function validAnalysis(): NewsAnalysis {
  return {
    company: { ...COMPANIES[0]! }, status: 'insufficient',
    asOf: '2026-10-27T09:00:00+09:00', period: { start: '2026-11-02', end: '2026-11-06' },
    evidence: 'low', summary: '테스트 전용: 기사가 부족하여 판단을 유보합니다.',
    positiveFactors: [], negativeFactors: [], risks: ['테스트 전용 위험 요인'],
    provider: '테스트 전용 제공자', analysisVersion: 'test-v1',
    articles: [{
      id: 'test-only', title: '테스트 전용 기사', source: '테스트 전용 출처',
      publishedAt: '2026-10-26T01:00:00.000Z', url: 'https://example.test/test-only',
      sentiment: 'neutral', rationale: '테스트 전용 분류 근거',
    }],
  };
}

test('runtime news validator accepts valid complete and unconfigured envelopes', () => {
  assert.equal(isNewsAnalysis(validAnalysis()), true);
  assert.equal(isNewsAnalysis(validAnalysis(), COMPANIES[0]!.id), true);
  const disconnected = { ...validAnalysis(), status: 'not_configured', evidence: 'none', provider: null, articles: [] };
  assert.equal(isNewsAnalysis(disconnected), true);
  assert.equal(isNewsAnalysis({ ...validAnalysis(), message: '테스트 메시지' }), true);
});

test('runtime news validator rejects missing rendering fields and malformed factor arrays', () => {
  for (const field of [
    'company', 'status', 'articles', 'asOf', 'period', 'evidence', 'summary',
    'positiveFactors', 'negativeFactors', 'risks', 'provider', 'analysisVersion',
  ]) {
    const malformed: Record<string, unknown> = { ...validAnalysis() };
    delete malformed[field];
    assert.equal(isNewsAnalysis(malformed), false, `missing ${field}`);
  }
  for (const field of ['positiveFactors', 'negativeFactors', 'risks']) {
    for (const invalid of [null, {}, 'string instead of array', [null], [42]]) {
      assert.equal(isNewsAnalysis({ ...validAnalysis(), [field]: invalid }), false, field);
    }
  }
  for (const invalid of [null, [], 'not an object', 42]) assert.equal(isNewsAnalysis(invalid), false);
});

test('runtime news validator enforces company identity and actual string enums', () => {
  const valid = validAnalysis();
  assert.equal(isNewsAnalysis(valid, 'nasdaq:NVDA'), false);
  for (const field of ['id', 'name', 'symbol', 'exchange', 'region']) {
    assert.equal(isNewsAnalysis({ ...valid, company: { ...valid.company, [field]: undefined } }), false, field);
    assert.equal(isNewsAnalysis({ ...valid, company: { ...valid.company, [field]: 123 } }), false, field);
  }
  for (const status of ['guaranteed_up', ['ready'], null, 1]) {
    assert.equal(isNewsAnalysis({ ...valid, status }), false);
  }
  for (const evidence of ['high', ['low'], null, 1]) {
    assert.equal(isNewsAnalysis({ ...valid, evidence }), false);
  }
  for (const sentiment of ['guaranteed_up', ['neutral'], null, 1]) {
    assert.equal(isNewsAnalysis({ ...valid, articles: [{ ...valid.articles[0]!, sentiment }] }), false);
  }
});

test('runtime news validator rejects malformed article fields, unsafe links and nonstring metadata', () => {
  const valid = validAnalysis();
  for (const field of ['id', 'title', 'source', 'rationale']) {
    for (const invalid of [undefined, null, '', 123, ['array']]) {
      assert.equal(isNewsAnalysis({ ...valid, articles: [{ ...valid.articles[0]!, [field]: invalid }] }), false, field);
    }
  }
  for (const url of ['javascript:alert(1)', 'http://example.test/a', 'https://user:pass@example.test/a', 'not a url', null]) {
    assert.equal(isNewsAnalysis({ ...valid, articles: [{ ...valid.articles[0]!, url }] }), false);
  }
  assert.equal(isNewsAnalysis({ ...valid, articles: [null] }), false);
  assert.equal(isNewsAnalysis({ ...valid, articles: {} }), false);
  assert.equal(isNewsAnalysis({ ...valid, summary: 1 }), false);
  assert.equal(isNewsAnalysis({ ...valid, provider: 1 }), false);
  assert.equal(isNewsAnalysis({ ...valid, analysisVersion: 1 }), false);
  assert.equal(isNewsAnalysis({ ...valid, message: 1 }), false);
});

test('runtime news validator checks real calendar dates, timezone timestamps and ordered periods', () => {
  const valid = validAnalysis();
  for (const asOf of [
    'not a date', '2026-10-27', '2026-10-27T09:00:00',
    '2026-02-30T00:00:00Z', '2025-02-29T00:00:00Z',
    '2026-10-27T24:00:00Z', '2026-10-27T09:60:00Z', '2026-10-27T09:00:60Z',
  ]) assert.equal(isNewsAnalysis({ ...valid, asOf }), false, asOf);
  assert.equal(isNewsAnalysis({ ...valid, asOf: '2024-02-29T09:00:00Z' }), true);
  assert.equal(isNewsAnalysis({ ...valid, period: { start: '2026-02-30', end: '2026-03-06' } }), false);
  assert.equal(isNewsAnalysis({ ...valid, period: { start: '2026-11-06', end: '2026-11-02' } }), false);
  assert.equal(isNewsAnalysis({ ...valid, period: { start: '2026-11-02T00:00:00Z', end: '2026-11-06' } }), false);
  assert.equal(isNewsAnalysis({ ...valid, articles: [{ ...valid.articles[0]!, publishedAt: '2026-02-30T00:00:00Z' }] }), false);
});

test('runtime news validator accepts provider sentiment metadata and explicit unclassified articles', () => {
  const valid = validAnalysis();
  for (const [sentimentScore, sentiment] of [[-1, 'negative'], [-0.01, 'negative'], [0, 'neutral'], [0.01, 'positive'], [1, 'positive']] as const) {
    assert.equal(isNewsAnalysis({ ...valid, articles: [{
      ...valid.articles[0]!, sentiment, sentimentScore, classificationMethod: 'provider', language: 'en',
      providerEntity: { symbol: '005930.KS', name: 'Test entity', exchange: null, country: 'kr' },
    }] }), true);
  }
  assert.equal(isNewsAnalysis({ ...valid, articles: [{
    ...valid.articles[0]!, sentiment: 'unclassified', classificationMethod: 'unavailable',
  }] }), true);
  assert.equal(isNewsAnalysis({ ...valid, articles: [{ ...valid.articles[0]!, sentiment: 'unclassified' }] }), true);
  assert.equal(isNewsAnalysis({ ...valid, articles: [{
    ...valid.articles[0]!, classificationMethod: 'provider',
    providerEntity: { symbol: '005930.KS', name: 'Test entity', exchange: 'KSC', country: 'kr' },
  }] }), true);
});

test('runtime news validator rejects invalid scores and classifications instead of implying neutral', () => {
  const valid = validAnalysis();
  const article = { ...valid.articles[0]!, sentiment: 'neutral', classificationMethod: 'provider' };
  for (const sentimentScore of [null, '0', NaN, Infinity, -Infinity, -1.001, 1.001]) {
    assert.equal(isNewsAnalysis({ ...valid, articles: [{ ...article, sentimentScore }] }), false);
  }
  for (const inconsistent of [
    { sentiment: 'positive', sentimentScore: 0 },
    { sentiment: 'negative', sentimentScore: 0.2 },
    { sentiment: 'neutral', sentimentScore: -0.2 },
    { sentiment: 'unclassified', sentimentScore: 0 },
    { sentiment: 'positive', classificationMethod: 'unavailable' },
    { sentiment: 'unclassified', classificationMethod: 'provider' },
    { sentiment: 'unclassified', classificationMethod: 'unavailable', sentimentScore: 0 },
    { sentiment: undefined, sentimentScore: 0 },
    { sentiment: null, sentimentScore: 0 },
    { classificationMethod: ['provider'] },
    { classificationMethod: 'automatic_forecast' },
    { classificationMethod: null },
  ]) assert.equal(isNewsAnalysis({ ...valid, articles: [{ ...article, ...inconsistent }] }), false);
});

test('runtime news validator checks optional article language and provider entity metadata', () => {
  const valid = validAnalysis();
  const article = valid.articles[0]!;
  for (const language of ['', ' ', null, 123, ['en']]) {
    assert.equal(isNewsAnalysis({ ...valid, articles: [{ ...article, language }] }), false);
  }
  const entity = { symbol: 'AAPL', name: 'Test Apple', exchange: 'NASDAQ', country: 'us' };
  for (const field of ['symbol', 'name', 'exchange', 'country']) {
    for (const invalid of [undefined, '', ' ', 123, ['value']]) {
      assert.equal(isNewsAnalysis({ ...valid, articles: [{ ...article, providerEntity: { ...entity, [field]: invalid } }] }), false, field);
    }
  }
  for (const providerEntity of [null, [], 'AAPL', 123]) {
    assert.equal(isNewsAnalysis({ ...valid, articles: [{ ...article, providerEntity }] }), false);
  }
});

test('runtime news validator validates news window and cache/retry timestamps independently of timezone spelling', () => {
  const valid = validAnalysis();
  assert.equal(isNewsAnalysis({
    ...valid, newsWindow: { start: '2026-10-20T09:00:00+09:00', end: '2026-10-27T00:00:00Z' },
    cachedUntil: '2026-10-27T00:05:00Z', retryAt: '2026-10-27T00:10:00Z',
  }), true);
  // Lexical order differs from chronological order across offsets.
  assert.equal(isNewsAnalysis({ ...valid, newsWindow: {
    start: '2026-10-27T08:00:00+09:00', end: '2026-10-27T00:00:00Z',
  } }), true);
  for (const newsWindow of [
    null, [], 'last week', {},
    { start: '2026-10-20', end: '2026-10-27T00:00:00Z' },
    { start: '2026-02-30T00:00:00Z', end: '2026-10-27T00:00:00Z' },
    { start: '2026-10-27T00:00:01Z', end: '2026-10-27T00:00:00Z' },
    { start: '2026-10-27T00:00:00Z', end: '2026-10-27T08:00:00+09:00' },
  ]) assert.equal(isNewsAnalysis({ ...valid, newsWindow }), false);
  for (const field of ['cachedUntil', 'retryAt']) {
    for (const invalid of [null, 123, '2026-10-27', '2026-02-30T00:00:00Z']) {
      assert.equal(isNewsAnalysis({ ...valid, [field]: invalid }), false, field);
    }
  }
});

test('runtime news validator accepts bounded descriptions, rationale lines and known topics only', () => {
  const valid = validAnalysis();
  const article = valid.articles[0]!;
  assert.equal(isNewsAnalysis({ ...valid, articles: [{
    ...article, description: '매체가 제공한 짧은 설명', rationaleLines: ['한 줄', '두 줄'], topics: ['earnings', 'product'],
  }] }), true);
  assert.equal(isNewsAnalysis({ ...valid, articles: [{ ...article, rationaleLines: ['1', '2', '3', '4', '5'] }] }), true);
  for (const invalid of [
    { description: '' }, { description: 'x'.repeat(301) }, { description: 1 },
    { rationaleLines: [] }, { rationaleLines: ['1', '2', '3', '4', '5', '6'] }, { rationaleLines: [''] },
    { rationaleLines: ['x'.repeat(301)] }, { rationaleLines: 'one line' },
    { topics: [] }, { topics: ['price_up'] }, { topics: ['earnings', 'product', 'deal', 'macro'] },
  ]) assert.equal(isNewsAnalysis({ ...valid, articles: [{ ...article, ...invalid }] }), false, JSON.stringify(invalid));
});

test('runtime news validator requires factor sentences to cite rendered articles and empty boxes to be explicit', () => {
  const valid = validAnalysis();
  const box = { state: 'single', lines: [{ text: '테스트 전용 종합 문장', topic: 'other', articleIds: ['test-only'] }], chips: ['단일 근거'] };
  const none = { state: 'none', lines: [], chips: [] };
  const summary = { positive: box, negative: none, chips: [], note: '테스트 전용 안내' };
  assert.equal(isNewsAnalysis({ ...valid, factorSummary: summary }), true);
  for (const invalid of [
    { ...summary, positive: { ...box, lines: [{ ...box.lines[0], articleIds: ['missing-article'] }] } },
    { ...summary, positive: { ...box, lines: [{ ...box.lines[0], articleIds: [] }] } },
    { ...summary, positive: { ...box, lines: [{ ...box.lines[0], topic: 'guaranteed_up' }] } },
    { ...summary, positive: { ...box, state: 'none' } },
    { ...summary, negative: { ...none, state: 'single' } },
    { ...summary, positive: { ...box, state: 'certain' } },
    { ...summary, positive: { ...box, lines: [box.lines[0], box.lines[0], box.lines[0], box.lines[0]] } },
    { ...summary, note: '' },
    { ...summary, chips: [1] },
    { positive: box, negative: none, chips: [] },
    null, [],
  ]) assert.equal(isNewsAnalysis({ ...valid, factorSummary: invalid }), false, JSON.stringify(invalid));
});

test('runtime news validator checks source labels, time kinds, identity, mirrors and per-source states', () => {
  const valid = validAnalysis();
  const article = valid.articles[0]!;
  assert.equal(isNewsAnalysis({
    ...valid, servedFrom: 'stale', refreshAttemptedAt: '2026-10-27T00:00:00Z',
    sources: [{ id: 'marketaux', label: 'Marketaux', status: 'rate_limited', articleCount: 0, retryAt: '2026-10-27T00:15:00Z' },
      { id: 'gdelt', label: 'GDELT', status: 'ok', articleCount: 3 }, { id: 'later', label: 'Later', status: 'skipped', articleCount: 0 }],
    articles: [{ ...article, sourceProvider: 'GDELT', timeKind: 'seen', identity: 'name_match',
      alsoReportedBy: [{ source: 'b.example', url: 'https://b.example/a' }] }],
  }), true);
  for (const invalid of [
    { sourceProvider: '' }, { sourceProvider: 'x'.repeat(41) }, { timeKind: 'guessed' }, { identity: 'probably' },
    { alsoReportedBy: [{ source: 'b.example', url: 'http://b.example/a' }] }, { alsoReportedBy: [{ source: '', url: 'https://b.example/a' }] },
    { alsoReportedBy: Array.from({ length: 11 }, (_, i) => ({ source: 's', url: `https://b.example/${i}` })) }, { alsoReportedBy: {} },
  ]) assert.equal(isNewsAnalysis({ ...valid, articles: [{ ...article, ...invalid }] }), false, JSON.stringify(invalid));
  for (const invalid of [
    { servedFrom: 'cache' }, { refreshAttemptedAt: 'yesterday' }, { sources: {} },
    { sources: [{ id: 'x', label: 'X', status: 'great', articleCount: 0 }] },
    { sources: [{ id: 'x', label: 'X', status: 'ok', articleCount: -1 }] },
    { sources: [{ id: 'x', label: 'X', status: 'ok', articleCount: 1.5 }] },
    { sources: [{ id: 'x', label: 'X', status: 'rate_limited', articleCount: 0, retryAt: 'soon' }] },
  ]) assert.equal(isNewsAnalysis({ ...valid, ...invalid }), false, JSON.stringify(invalid));
});

test('runtime news validator lets only two-model agreement carry an AI direction and bounds AI fields', () => {
  const valid = validAnalysis();
  const { sentimentScore: _score, ...article } = { ...valid.articles[0]!, sentimentScore: undefined };
  const judgedAt = '2026-10-27T00:00:00Z';
  const gemini = { provider: 'gemini', model: 'gemini-test', relevant: true, sentiment: 'positive', evidence: '근거 구절', reason: '이유', topic: 'earnings', judgedAt };
  const cloudflare = { ...gemini, provider: 'cloudflare', model: '@cf/test/model' };
  const confirmed = { ...article, sentiment: 'positive', classificationMethod: 'llm', aiConsensus: 'confirmed', aiJudgements: [gemini, cloudflare],
    summary: { text: '테스트 전용 요약', basis: 'title_only', generatedBy: 'Gemini' } };
  const ai = { promptVersion: 'news-judge-v1', unrelatedCount: 1, providers: [
    { id: 'gemini', label: 'Gemini', model: 'gemini-test', status: 'ok', judgedCount: 2 },
    { id: 'cloudflare', label: 'Cloudflare', model: '@cf/test/model', status: 'rate_limited', judgedCount: 0, retryAt: judgedAt },
  ] };
  assert.equal(isNewsAnalysis({ ...valid, ai, articles: [confirmed] }), true);
  for (const consensus of ['provisional', 'withheld', 'pending']) {
    assert.equal(isNewsAnalysis({ ...valid, articles: [{ ...article, sentiment: 'unclassified', classificationMethod: 'unavailable',
      aiConsensus: consensus, aiJudgements: [gemini] }] }), true, consensus);
  }
  for (const invalid of [
    { classificationMethod: 'llm', aiConsensus: 'provisional' }, { aiConsensus: undefined },
    { sentiment: 'unclassified' }, { sentimentScore: 0.4 }, { aiConsensus: 'certain' },
    { aiConsensus: 'provisional', classificationMethod: 'unavailable' },
    { aiJudgements: [] }, { aiJudgements: [gemini, gemini] }, { aiJudgements: [gemini, cloudflare, gemini] },
    { aiJudgements: [{ ...gemini, provider: 'other' }] }, { aiJudgements: [{ ...gemini, sentiment: 'up' }] },
    { aiJudgements: [{ ...gemini, evidence: 'x'.repeat(121) }] }, { aiJudgements: [{ ...gemini, relevant: 'yes' }] },
    { aiJudgements: [{ ...gemini, topic: 'price_up' }] }, { aiJudgements: [{ ...gemini, judgedAt: 'now' }] },
    { summary: { text: '', basis: 'title_only', generatedBy: 'Gemini' } },
    { summary: { text: 'x'.repeat(201), basis: 'title_only', generatedBy: 'Gemini' } },
    { summary: { text: '요약', basis: 'article_body', generatedBy: 'Gemini' } },
  ]) assert.equal(isNewsAnalysis({ ...valid, articles: [{ ...confirmed, ...invalid }] }), false, JSON.stringify(invalid));
  for (const invalid of [
    { ...ai, providers: [] }, { ...ai, providers: [...ai.providers, ai.providers[0]] }, { ...ai, unrelatedCount: -1 },
    { ...ai, promptVersion: '' }, { ...ai, providers: [{ ...ai.providers[0], status: 'great' }] },
    { ...ai, providers: [{ ...ai.providers[0], judgedCount: 0.5 }] }, { ...ai, providers: [{ ...ai.providers[0], id: 'openai' }] },
  ]) assert.equal(isNewsAnalysis({ ...valid, ai: invalid, articles: [confirmed] }), false, JSON.stringify(invalid));
});

test('runtime news validator sets an article apart only when both models judged it unrelated', () => {
  const valid = validAnalysis();
  const article = { ...valid.articles[0]!, sentiment: 'positive', classificationMethod: 'provider', sentimentScore: 0.4 };
  const judgedAt = '2026-10-27T00:00:00Z';
  const unrelated = (provider: string) => ({ provider, model: 'm', relevant: false, sentiment: 'neutral', judgedAt });
  const set = { ...article, aiRelevance: 'unrelated', aiJudgements: [unrelated('gemini'), unrelated('cloudflare')] };
  assert.equal(isNewsAnalysis({ ...valid, articles: [set] }), true);
  const cited = { state: 'single', lines: [{ text: '테스트 전용 종합 문장', topic: 'other', articleIds: [set.id] }], chips: [] };
  const none = { state: 'none', lines: [], chips: [] };
  assert.equal(isNewsAnalysis({ ...valid, articles: [set], factorSummary: { positive: cited, negative: none, chips: [], note: '테스트 전용 안내' } }), false);
  for (const invalid of [
    { aiRelevance: 'maybe' }, { aiJudgements: [unrelated('gemini')] },
    { aiJudgements: [unrelated('gemini'), { ...unrelated('cloudflare'), relevant: true }] },
    { sentiment: 'positive', classificationMethod: 'llm', aiConsensus: 'confirmed', sentimentScore: undefined },
  ]) assert.equal(isNewsAnalysis({ ...valid, articles: [{ ...set, ...invalid }] }), false, JSON.stringify(invalid));
});
