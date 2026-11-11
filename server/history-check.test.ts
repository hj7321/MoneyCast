import test from 'node:test';
import assert from 'node:assert/strict';
import { companies } from '@moneycast/core';
import {
  buildPlan, CAPS, compareOpenClose, createBudget, createRedactor, crossCheckCalendar, deriveDates, etTime, extractArticles, extractXmlError,
  fscDate, fscItems, fscQuery, isKospi200Name, marketauxNewsParams, parseArgs, parseFscBody, parseNum, pickSplit, runHistoryCheck,
  secretForms, summarizeDividends, summarizeFscSeries, summarizeSplits, summarizeMarketaux, summarizeMassiveAggs, verifyKrEntity,
  type HistoryCheckDeps, type MarketauxQueryResult,
} from './history-check.js';
import { createMarketauxProvider } from './marketaux.js';
import { zonedTimeToUtc } from './market-calendar.js';

// 2026-11-11 03:00 KST = 2026-11-10 13:00 EST.
const NOW = Date.parse('2026-11-10T18:00:00Z');
const DECODED_KR = 'Kr+Fake/Key=Plus+Slash/Equals==';
const ENCODED_KR = encodeURIComponent(DECODED_KR);
const KEYS = {
  KR_PRICE_API_KEY: DECODED_KR,
  US_PRICE_API_KEY: 'massive-fake-key-0123456789',
  MARKETAUX_API_TOKEN: 'marketaux-fake-token-abcdef',
};
const HOSTS = { fsc: 'apis.data.go.kr', massive: 'api.massive.com', marketaux: 'api.marketaux.com' } as const;

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
function harness(handler: Handler, env: Record<string, string | undefined> = KEYS) {
  let clock = NOW;
  const lines: string[] = [];
  const requests: { url: URL; init: RequestInit; at: number }[] = [];
  const sleeps: number[] = [];
  const fetcher = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ url, init: init ?? {}, at: clock });
    return handler(url, init ?? {});
  }) as typeof fetch;
  const deps: HistoryCheckDeps = {
    env, fetcher, now: () => clock, sleep: async ms => { sleeps.push(ms); clock += ms; }, print: line => { lines.push(line); },
  };
  const count = (provider: keyof typeof HOSTS) => requests.filter(request => request.url.host === HOSTS[provider]).length;
  return { deps, lines, requests, sleeps, count };
}

// ---------------------------------------------------------------- fake providers

const compact = (date: string) => date.replace(/-/g, '');
function fscRows(code: string, dates: string[], extra: (close: number) => Record<string, string> = () => ({})) {
  let close = 1000;
  return dates.map((date, index) => {
    const previous = close;
    close = previous + 10;
    return { basDt: compact(date), srtnCd: code, isinCd: `KR7${code}003`, itmsNm: '테스트', mrktCtg: 'KOSPI', mkp: String(previous),
      hipr: String(close + 5), lopr: String(previous - 5), clpr: String(close), vs: index ? '10' : '0', fltRt: '1.00', trqu: '100', ...extra(close) };
  });
}
function fscEnvelope(items: unknown[], totalCount = items.length): Response {
  return json({ response: { header: { resultCode: '00', resultMsg: 'NORMAL SERVICE.' },
    body: { numOfRows: 2000, pageNo: 1, totalCount, items: { item: items } } } });
}
const RECENT = ['2026-11-05', '2026-11-06', '2026-11-09'];
function etMidnight(date: string) { return zonedTimeToUtc(date, '00:00', 'America/New_York'); }

interface FakeOptions { earlyRows?: string[]; splits?: unknown[]; entities?: unknown[] | null; huge?: boolean; articleExtra?: Record<string, unknown> }
function fakeProviders(options: FakeOptions = {}): Handler {
  const total = (rows: unknown[]) => options.huge ? 999_999 : rows.length;
  return url => {
    const p = url.searchParams;
    if (url.host === HOSTS.fsc) {
      const early = p.get('beginBasDt') === '19800101';
      if (url.pathname.endsWith('getStockPriceInfo_V2')) {
        const code = p.get('likeSrtnCd')!;
        const dates = code === '035720' ? ['2021-04-12', '2021-04-15', '2021-04-16'] : early ? options.earlyRows ?? ['2020-01-02', '2020-01-03'] : RECENT;
        // A different code containing the queried one must be dropped.
        const rows = [...fscRows(code, dates), ...fscRows(`9${code.slice(1)}`, dates.slice(0, 1))];
        return fscEnvelope(rows, total(rows));
      }
      if (url.pathname.endsWith('getETFPriceInfo_V2')) {
        const rows = fscRows('069500', early ? ['2020-01-02'] : RECENT, close => ({ bssIdxIdxNm: '코스피 200', bssIdxClpr: String(close) }));
        return fscEnvelope(rows, total(rows));
      }
      const rows = [
        ...fscRows('', early ? ['2020-01-02'] : RECENT, () => ({ idxNm: '코스피 200', idxCsf: 'KOSPI시리즈', epyItmsCnt: '200', basPntm: '19900103', basIdx: '100' })),
        ...fscRows('', early ? ['2020-01-02'] : RECENT, () => ({ idxNm: '코스피 200 TR', idxCsf: 'KOSPI시리즈', epyItmsCnt: '200', basPntm: '20000101', basIdx: '1000' })),
      ];
      return fscEnvelope(rows, total(rows));
    }
    if (url.host === HOSTS.massive) {
      if (url.pathname.startsWith('/v2/aggs/')) {
        const dates = [...RECENT, '2025-12-24', '2026-10-12', '2025-06-03', '2025-06-10'].sort();
        const results = dates.map((date, index) => ({ o: 100 + index, h: 110 + index, l: 90 + index, c: 101 + index, v: 1000, vw: 100, n: 10, t: etMidnight(date) }));
        return json({ ticker: 'X', adjusted: p.get('adjusted') === 'true', queryCount: results.length, resultsCount: results.length, status: 'OK', request_id: 'req-1', results });
      }
      if (url.pathname.startsWith('/v1/open-close/')) {
        return json({ status: 'OK', from: url.pathname.split('/').pop(), symbol: 'AAPL', open: 103, close: 105, preMarket: 102, afterHours: 105.5 });
      }
      if (url.pathname === '/stocks/v1/dividends') {
        return json({ status: 'OK', request_id: 1, results: [{ ticker: 'AAPL', ex_dividend_date: '2026-08-11', cash_amount: 0.26, distribution_type: 'recurring', historical_adjustment_factor: 0.998 }] });
      }
      if (url.pathname === '/stocks/v1/splits') {
        return json({ status: 'OK', results: options.splits ?? [
          { ticker: 'ORLY', execution_date: '2025-06-10', split_from: 1, split_to: 15, adjustment_type: 'forward_split', historical_adjustment_factor: 0.0667 },
          { ticker: 'ABCD', execution_date: '2025-07-10', split_from: 1, split_to: 20, adjustment_type: 'forward_split' },
        ] });
      }
    }
    if (url.host === HOSTS.marketaux) {
      if (url.pathname === '/v1/entity/search') {
        return json({ meta: { found: 4, returned: 4, limit: 50, page: 1 }, data: options.entities === null ? [] : options.entities ?? [
          { symbol: '005930.KS', name: 'Samsung Electronics Co., Ltd.', type: 'equity', exchange: 'KSC', country: 'kr' },
          { symbol: '000660.KS', name: 'SK Hynix Inc.', type: 'equity', exchange: 'KSC', country: 'kr' },
          { symbol: '035420.KS', name: 'NAVER Corp', type: 'equity', exchange: 'KSC', country: 'kr' },
          { symbol: '005380.KS', name: 'Hyundai Motor Company', type: 'equity', exchange: 'KSC', country: 'kr' },
        ] });
      }
      const symbol = p.get('symbols')!;
      const score = p.has('sentiment_gte') ? 0.5 : p.has('sentiment_lte') ? -0.5 : 0;
      const data = [1, 2, 3].map(index => ({ uuid: `${symbol}-${score}-${index}`, title: 'SECRET TITLE', url: 'https://example.test/a',
        description: 'DESCRIPTION', snippet: 'SNIPPET', published_at: '2026-01-05T01:00:00.000000Z', language: 'en', source: 'example.test',
        entities: [{ symbol, name: 'X', sentiment_score: score, match_score: 10 }, { symbol: 'OTHER', sentiment_score: -score }], ...options.articleExtra }));
      return json({ meta: { found: options.huge ? 1e9 : p.has('sentiment_gte') ? 60 : p.has('sentiment_lte') ? 20 : 100, returned: 3, limit: 3, page: 1 }, data });
    }
    return json({ error: 'unexpected' }, 404);
  };
}

const PLAN_IDS = [
  ...Array.from({ length: 10 }, (_, index) => `F${index + 1}`),
  ...Array.from({ length: 12 }, (_, index) => `M${index + 1}`),
  ...Array.from({ length: 20 }, (_, index) => `A${index + 1}`),
];

function assertNoSecret(text: string, env: Record<string, string | undefined> = KEYS) {
  for (const form of secretForms(Object.values(env))) assert.ok(!text.includes(form), `secret form leaked: ${form.length} chars`);
}

// ---------------------------------------------------------------- modes and budgets

test('dry run makes zero fetches, writes nothing and lists exactly the planned calls', async () => {
  for (const env of [KEYS, {}]) {
    const h = harness(() => { throw new Error('must not fetch'); }, env);
    const result = await runHistoryCheck(h.deps);
    assert.equal(h.requests.length, 0);
    assert.equal(result.mode, 'dry_run');
    assert.deepEqual(result.outputs, []);
    assert.equal(result.summary, null);
    assert.deepEqual(result.plan.map(call => call.id), PLAN_IDS);
    for (const id of PLAN_IDS) assert.ok(h.lines.some(line => line.startsWith(`${id} [`)), id);
    assert.ok(h.lines.some(line => line.includes('fsc: 10회')) && h.lines.some(line => line.includes('massive: 12회')) && h.lines.some(line => line.includes('marketaux: 20회')));
    assert.ok(h.lines.some(line => line.includes(`KR_PRICE_API_KEY=${env === KEYS}`)));
    assertNoSecret(h.lines.join('\n'));
    assert.deepEqual(h.sleeps, []);
  }
  const only = await runHistoryCheck(harness(() => { throw new Error('x'); }).deps, { only: ['massive'] });
  assert.deepEqual(only.plan.map(call => call.provider), Array(12).fill('massive'));
});

test('planned calls carry the specified paths, windows and conditions', () => {
  const dates = deriveDates(NOW);
  assert.deepEqual(dates, {
    nowIso: '2026-11-10T18:00:00.000Z', kstToday: '2026-11-11', fscEnd: '20261112', etToday: '2026-11-10',
    massiveFrom: '2024-11-11', massiveTo: '2026-11-09', w0: '2024-11-10T23:50:00', w1: '2026-11-08T23:50:00',
  });
  const plan = new Map(buildPlan(dates).map(call => [call.id, call]));
  assert.equal(plan.get('F1')!.path, '/1160100/GetStockSecuritiesInfoService_V2/getStockPriceInfo_V2');
  assert.deepEqual(plan.get('F1')!.params, { likeSrtnCd: '005930', beginBasDt: '20230101', endBasDt: '20261112', numOfRows: '2000', pageNo: '1', resultType: 'json' });
  assert.equal(plan.get('F5')!.path, '/1160100/GetSecuritiesProductInfoService_V2/getETFPriceInfo_V2');
  assert.equal(plan.get('F9')!.path, '/1160100/GetMarketIndexInfoService_V2/getStockMarketIndex_V2');
  assert.equal(plan.get('F7')!.params.endBasDt, '20230101');
  assert.ok(plan.get('F10')!.conditional && plan.get('M11')!.conditional && plan.get('M12')!.conditional);
  assert.equal(plan.get('M1')!.path, '/v2/aggs/ticker/AAPL/range/1/day/2024-11-11/2026-11-09');
  assert.equal(plan.get('M7')!.path, '/v1/open-close/AAPL/2025-12-24');
  assert.equal(plan.get('M8')!.path, '/v1/open-close/AAPL/2026-10-12');
  assert.equal(plan.get('M10')!.params['execution_date.lte'], '2026-10-26');
  // Newest first; 5000 (the /stocks/v1/splits maximum) keeps the older half of the window with ORLY / IBKR / FAST.
  assert.equal(plan.get('M10')!.params.limit, '5000');
  assert.equal(plan.get('A1')!.params.symbols, '005930.KS,000660.KS,035420.KS,005380.KS');
  assert.equal(plan.get('A2')!.params.sentiment_gte, '0.0001');
  assert.equal(plan.get('A3')!.params.sentiment_lte, '-0.0001');
  assert.deepEqual(['A18', 'A19', 'A20'].map(id => plan.get(id)!.companyId), ['krx:005930', 'krx:005380', 'nasdaq:AAPL']);
  for (const call of plan.values()) assert.ok(!('serviceKey' in call.params) && !('api_token' in call.params) && !('apiKey' in call.params));
});

test('budget throws at the cap and never lets a provider exceed it', () => {
  const budget = createBudget({ fsc: 2, massive: 1, marketaux: 0 });
  budget.take('fsc'); budget.take('fsc');
  assert.throws(() => budget.take('fsc'), /budget/);
  budget.take('massive');
  assert.throws(() => budget.take('massive'));
  assert.throws(() => budget.take('marketaux'));
  assert.deepEqual(budget.snapshot(), { fsc: { cap: 2, used: 2 }, massive: { cap: 1, used: 1 }, marketaux: { cap: 0, used: 0 } });
});

test('invocation counts never exceed 10 / 12 / 20 for succeeding, failing or huge responses', async () => {
  const handlers: [string, Handler][] = [
    ['success', fakeProviders()],
    ['huge totals', fakeProviders({ huge: true })],
    ['entity fallback', (url, init) => url.pathname === '/v1/entity/search' && url.searchParams.has('symbols')
      ? json({ meta: { found: 0 }, data: [] }) : fakeProviders({ entities: [
        { symbol: '005930.KS', name: 'Samsung Electronics', type: 'equity', country: 'kr' },
        { symbol: '000660.KS', name: 'SK Hynix', type: 'equity', country: 'kr' },
        { symbol: '035420.KS', name: 'NAVER', type: 'equity', country: 'kr' },
        { symbol: '005380.KS', name: 'Hyundai Motor', type: 'equity', country: 'kr' },
      ] })(url, init)],
    ['throws', url => { throw new Error(url.toString()); }],
    ['http 500', () => json({ status: 'ERROR' }, 500)],
    ['not json', () => new Response('oops', { status: 200 })],
  ];
  for (const [name, handler] of handlers) {
    const h = harness(handler);
    const result = await runHistoryCheck(h.deps, { live: true });
    assert.ok(h.count('fsc') <= CAPS.fsc, `${name} fsc ${h.count('fsc')}`);
    assert.ok(h.count('massive') <= CAPS.massive, `${name} massive ${h.count('massive')}`);
    assert.ok(h.count('marketaux') <= CAPS.marketaux, `${name} marketaux ${h.count('marketaux')}`);
    const budgets = result.summary!.budgets as Record<string, { used: number }>;
    for (const provider of ['fsc', 'massive', 'marketaux'] as const) assert.equal(budgets[provider]!.used, h.count(provider), `${name} ${provider} used`);
    if (name === 'success' || name === 'huge totals') {
      assert.deepEqual([h.count('fsc'), h.count('massive'), h.count('marketaux')], [10, 12, 20], name);
    }
    if (name === 'entity fallback') {
      // A1 + three per-code searches; the fourth company is left unverified so its news calls are saved.
      assert.equal(h.requests.filter(request => request.url.pathname === '/v1/entity/search').length, 4);
      assert.equal(h.count('marketaux'), 20);
    }
  }
});

test('missing keys skip that provider as not_configured with no calls', async () => {
  const h = harness(fakeProviders(), { MARKETAUX_API_TOKEN: KEYS.MARKETAUX_API_TOKEN });
  const result = await runHistoryCheck(h.deps, { live: true });
  assert.equal(h.count('fsc') + h.count('massive'), 0);
  const calls = result.summary!.calls as { provider: string; code: string }[];
  assert.ok(calls.filter(call => call.provider !== 'marketaux').every(call => call.code === 'not_configured'));
  assert.equal(h.count('marketaux'), 20);
});

test('F10 is skipped without a fetch when F7 has no row on or before 2021-04-01', async () => {
  const h = harness(fakeProviders({ earlyRows: ['2021-06-01', '2021-06-02'] }), { KR_PRICE_API_KEY: DECODED_KR });
  const result = await runHistoryCheck(h.deps, { live: true, only: ['fsc'] });
  assert.equal(h.count('fsc'), 9);
  assert.ok(!h.requests.some(request => request.url.searchParams.get('likeSrtnCd') === '035720'));
  assert.equal((result.summary!.calls as { id: string; code: string }[]).find(call => call.id === 'F10')!.code, 'skipped_condition');
  const ran = harness(fakeProviders(), { KR_PRICE_API_KEY: DECODED_KR });
  const full = await runHistoryCheck(ran.deps, { live: true, only: ['fsc'] });
  assert.equal(ran.count('fsc'), 10);
  const fsc = full.summary!.fsc as { adjustment: { skipped: boolean; rows: unknown[] }; series: { kept: number; returned: number }[]; earliest: Record<string, { firstDate: string }> };
  assert.equal(fsc.adjustment.skipped, false);
  assert.equal(fsc.adjustment.rows.length, 3);
  // Rows of a different code that merely contains the queried one are dropped.
  assert.deepEqual([fsc.series[0]!.returned, fsc.series[0]!.kept], [4, 3]);
  assert.equal(fsc.earliest.F7!.firstDate, '2020-01-02');
});

test('M11-M12 are skipped when M10 has no usable forward split', async () => {
  for (const splits of [[], [{ ticker: 'ABC', execution_date: '2025-06-10', split_from: 10, split_to: 1, adjustment_type: 'reverse_split' }],
    [{ ticker: 'ABC.WS', execution_date: '2025-06-10', split_from: 1, split_to: 4 }], [{ ticker: 'ABC', execution_date: '2024-11-15', split_from: 1, split_to: 4 }]]) {
    const h = harness(fakeProviders({ splits }), { US_PRICE_API_KEY: KEYS.US_PRICE_API_KEY });
    const result = await runHistoryCheck(h.deps, { live: true, only: ['massive'] });
    assert.equal(h.count('massive'), 10);
    const codes = (result.summary!.calls as { id: string; code: string }[]).filter(call => call.id === 'M11' || call.id === 'M12').map(call => call.code);
    assert.deepEqual(codes, ['skipped_condition', 'skipped_condition']);
  }
  const h = harness(fakeProviders(), { US_PRICE_API_KEY: KEYS.US_PRICE_API_KEY });
  await runHistoryCheck(h.deps, { live: true, only: ['massive'] });
  const windows = h.requests.slice(10).map(request => `${request.url.pathname}?${request.url.searchParams.get('adjusted')}`);
  assert.deepEqual(windows, ['/v2/aggs/ticker/ORLY/range/1/day/2025-05-31/2025-06-20?true', '/v2/aggs/ticker/ORLY/range/1/day/2025-05-31/2025-06-20?false']);
});

test('Marketaux stops after 429 or 402, and on a lookup 401', async () => {
  for (const status of [429, 402]) {
    const base = fakeProviders();
    const h = harness((url, init) => url.pathname === '/v1/news/all' ? json({ error: { code: 'rate_limit_reached', message: 'x' } }, status) : base(url, init),
      { MARKETAUX_API_TOKEN: KEYS.MARKETAUX_API_TOKEN });
    const result = await runHistoryCheck(h.deps, { live: true });
    assert.equal(h.count('marketaux'), 2, String(status));
    const calls = result.summary!.calls as { id: string; code: string; providerCode?: string }[];
    assert.equal(calls.find(call => call.id === 'A2')!.code, `http_${status}`);
    assert.equal(calls.find(call => call.id === 'A2')!.providerCode, 'rate_limit_reached');
    assert.ok(calls.filter(call => /^A(?:[3-9]|1\d)$/.test(call.id)).every(call => call.code === 'stopped'));
  }
  const h = harness(() => json({ error: { code: 'invalid_api_token' } }, 401), { MARKETAUX_API_TOKEN: KEYS.MARKETAUX_API_TOKEN });
  await runHistoryCheck(h.deps, { live: true });
  assert.equal(h.count('marketaux'), 1);
});

test('Massive stops after 429 but continues after a 403', async () => {
  const h = harness(() => json({ status: 'ERROR', error: 'too many', request_id: 'r1' }, 429), { US_PRICE_API_KEY: KEYS.US_PRICE_API_KEY });
  await runHistoryCheck(h.deps, { live: true });
  assert.equal(h.count('massive'), 1);
  const base = fakeProviders();
  const forbidden = harness((url, init) => url.pathname.includes('/AAPL/') ? json({ status: 'NOT_AUTHORIZED', request_id: 'r2' }, 403) : base(url, init),
    { US_PRICE_API_KEY: KEYS.US_PRICE_API_KEY });
  const result = await runHistoryCheck(forbidden.deps, { live: true });
  assert.equal(forbidden.count('massive'), 12);
  const m1 = (result.summary!.calls as { id: string; code: string; providerCode?: string; requestId?: string }[]).find(call => call.id === 'M1')!;
  assert.deepEqual([m1.code, m1.providerCode, m1.requestId], ['http_403', 'NOT_AUTHORIZED', 'r2']);
});

test('FSC stops on key and limit errors but continues on others', async () => {
  const xml = (name: string, code: string) => `<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>SERVICE ERROR</errMsg><returnAuthMsg>${name}</returnAuthMsg><returnReasonCode>${code}</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>`;
  for (const [name, code] of [['SERVICE_KEY_IS_NOT_REGISTERED_ERROR', '30'], ['LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR', '22'], ['SERVICE_ACCESS_DENIED_ERROR', '20']]) {
    const h = harness(() => new Response(xml(name!, code!), { status: 200, headers: { 'content-type': 'text/xml' } }), { KR_PRICE_API_KEY: DECODED_KR });
    const result = await runHistoryCheck(h.deps, { live: true });
    assert.equal(h.count('fsc'), 1, name);
    const calls = (result.summary!.calls as { id: string; provider: string; code: string }[]).filter(call => call.provider === 'fsc');
    assert.equal(calls.length, 10);
    assert.equal(calls[0]!.code, `xml_error:${name}`);
    assert.ok(calls.slice(1).every(call => call.code === 'stopped' || call.code === 'skipped_condition'));
  }
  const json22 = harness(() => json({ response: { header: { resultCode: '22', resultMsg: 'LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR' } } }), { KR_PRICE_API_KEY: DECODED_KR });
  await runHistoryCheck(json22.deps, { live: true });
  assert.equal(json22.count('fsc'), 1);
  const http401 = harness(() => new Response('Unauthorized', { status: 401 }), { KR_PRICE_API_KEY: DECODED_KR });
  await runHistoryCheck(http401.deps, { live: true });
  assert.equal(http401.count('fsc'), 1);
  const other = harness(() => new Response(xml('INVALID_REQUEST_PARAMETER_ERROR', '10'), { status: 200 }), { KR_PRICE_API_KEY: DECODED_KR });
  await runHistoryCheck(other.deps, { live: true });
  assert.equal(other.count('fsc'), 9);
});

test('Massive requests start at least 13000 ms apart through the injected sleep', async () => {
  const h = harness(fakeProviders(), { US_PRICE_API_KEY: KEYS.US_PRICE_API_KEY });
  await runHistoryCheck(h.deps, { live: true });
  const starts = h.requests.filter(request => request.url.host === HOSTS.massive).map(request => request.at);
  assert.equal(starts.length, 12);
  assert.equal(starts[0], NOW);
  for (let index = 1; index < starts.length; index += 1) assert.ok(starts[index]! - starts[index - 1]! >= 13_000);
  assert.ok(h.sleeps.every(ms => ms > 0 && ms <= 13_000));
});

test('keys travel only where each provider expects them', async () => {
  const h = harness(fakeProviders());
  await runHistoryCheck(h.deps, { live: true });
  for (const request of h.requests) {
    assert.equal(request.init.redirect, 'error');
    assert.equal(request.url.protocol, 'https:');
    const headers = request.init.headers as Record<string, string>;
    if (request.url.host === HOSTS.massive) {
      assert.equal(headers.Authorization, `Bearer ${KEYS.US_PRICE_API_KEY}`);
      assert.ok(!request.url.searchParams.has('apiKey') && !request.url.searchParams.has('apikey'));
      assert.ok(!request.url.toString().includes(KEYS.US_PRICE_API_KEY));
    } else {
      assert.equal(headers.Authorization, undefined);
      const param = request.url.host === HOSTS.fsc ? 'serviceKey' : 'api_token';
      assert.equal(request.url.searchParams.get(param), request.url.host === HOSTS.fsc ? DECODED_KR : KEYS.MARKETAUX_API_TOKEN);
    }
  }
});

test('a Decoding key and its Encoding form produce the identical wire query', async () => {
  const params = { likeSrtnCd: '005930', idxNm: '코스피 200', resultType: 'json' };
  const query = fscQuery(DECODED_KR, params);
  assert.equal(fscQuery(ENCODED_KR, params), query);
  assert.ok(query.startsWith(`serviceKey=${encodeURIComponent(DECODED_KR)}&`));
  assert.ok(query.includes('%2B') && query.includes('%2F') && query.includes('%3D') && !query.includes('%25'));
  assert.ok(query.includes('idxNm=%EC%BD%94%EC%8A%A4%ED%94%BC%20200'));
  const wire = async (key: string) => {
    const h = harness(fakeProviders(), { KR_PRICE_API_KEY: key });
    await runHistoryCheck(h.deps, { live: true, only: ['fsc'] });
    return h.requests.map(request => request.url.search);
  };
  const decoded = await wire(DECODED_KR);
  assert.deepEqual(await wire(ENCODED_KR), decoded);
  assert.equal(decoded.length, 10);
});

test('planted keys never reach the summary, printed output, files or thrown errors', async () => {
  const echo = Object.values(KEYS).join(' ');
  let index = 0;
  const handler: Handler = url => {
    index += 1;
    if (index % 4 === 0) throw new Error(`fetch failed ${url.toString()} ${echo}`);
    if (url.host === HOSTS.fsc) return new Response(`<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>${KEYS.KR_PRICE_API_KEY}</errMsg><returnAuthMsg>X ${ENCODED_KR}</returnAuthMsg><returnReasonCode>99</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>`);
    if (index % 4 === 1) return json({ status: 'OK', echoed: url.toString(), results: [], data: [], request_id: KEYS.US_PRICE_API_KEY });
    return json({ status: KEYS.MARKETAUX_API_TOKEN, error: { code: KEYS.MARKETAUX_API_TOKEN }, request_id: encodeURIComponent(KEYS.KR_PRICE_API_KEY) }, 400);
  };
  const h = harness(handler);
  const result = await runHistoryCheck(h.deps, { live: true });
  const text = [JSON.stringify(result), h.lines.join('\n'), ...result.outputs.map(output => output.content)].join('\n');
  assertNoSecret(text);
  const codes = new Set((result.summary!.calls as { code: string }[]).map(call => call.code));
  assert.ok(codes.has('network') && codes.has('echoed_secret'));
  const broken = harness(fakeProviders());
  broken.deps.sleep = async () => { throw new Error(`boom ${echo} ${ENCODED_KR}`); };
  await assert.rejects(runHistoryCheck(broken.deps, { live: true }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assertNoSecret(`${error.message} ${error.stack ?? ''} ${JSON.stringify(error)}`);
    return error.message === 'internal_error';
  });
  assertNoSecret(broken.lines.join('\n'));
});

test('redactor covers raw, encoded and decoded forms and ignores short keys', () => {
  const redact = createRedactor([ENCODED_KR, 'short', undefined]);
  const line = `a ${DECODED_KR} b ${ENCODED_KR} c ${ENCODED_KR.replace(/%[0-9A-F]{2}/g, hex => hex.toLowerCase())} d short`;
  assert.equal(redact(line), 'a [REDACTED] b [REDACTED] c [REDACTED] d short');
  assert.ok(redact(line).includes('short'));
  assert.ok(redact.contains(`x${DECODED_KR.replace(/\//g, '\\/')}x`));
  assert.ok(!secretForms(['abc']).length);
});

// ---------------------------------------------------------------- parsing

test('items.item normalizes arrays, single objects, empty strings and missing values', () => {
  assert.deepEqual(fscItems({ items: { item: [{ a: 1 }, { a: 2 }] } }), [{ a: 1 }, { a: 2 }]);
  assert.deepEqual(fscItems({ items: { item: { a: 1 } } }), [{ a: 1 }]);
  assert.deepEqual(fscItems({ items: { item: '' } }), []);
  assert.deepEqual(fscItems({ items: '' }), []);
  assert.deepEqual(fscItems({ items: {} }), []);
  assert.deepEqual(fscItems({}), []);
  assert.deepEqual(fscItems(null), []);
  assert.deepEqual(fscItems({ items: { item: [{ a: 1 }, 'x', null] } }), [{ a: 1 }]);
});

test('numeric strings parse with dropped leading zeros and commas; empty is missing', () => {
  assert.equal(parseNum('-.39'), -0.39);
  assert.equal(parseNum('.5'), 0.5);
  assert.equal(parseNum(' 1,234 '), 1234);
  assert.equal(parseNum('0'), 0);
  assert.equal(parseNum(12), 12);
  for (const value of ['', '  ', 'abc', null, undefined, Number.NaN, {}, '1e999']) assert.equal(parseNum(value), null);
});

test('FSC bodies: JSON envelope with or without wrapper, result codes and XML errors', () => {
  const ok = parseFscBody(JSON.stringify({ response: { header: { resultCode: '00' }, body: { totalCount: '2', numOfRows: 10, items: { item: [{ a: 1 }, { a: 2 }] } } } }));
  assert.ok(ok.ok && ok.items.length === 2 && ok.totalCount === 2);
  const bare = parseFscBody(JSON.stringify({ header: { resultCode: '00' }, body: { totalCount: 0, items: '' } }));
  assert.ok(bare.ok && bare.items.length === 0 && bare.totalCount === 0);
  assert.deepEqual(parseFscBody(JSON.stringify({ response: { header: { resultCode: '30', resultMsg: 'SERVICE KEY IS NOT REGISTERED ERROR.' } } })), { ok: false, code: 'fsc_result:30', stop: true });
  assert.deepEqual(parseFscBody(JSON.stringify({ response: { header: { resultCode: '10' } } })), { ok: false, code: 'fsc_result:10', stop: false });
  assert.deepEqual(parseFscBody('Unexpected errors'), { ok: false, code: 'bad_json', stop: false });
  assert.deepEqual(parseFscBody('{broken'), { ok: false, code: 'bad_json', stop: false });
  const xml = extractXmlError('<OpenAPI_ServiceResponse>\n<cmmMsgHeader>\n<errMsg>SERVICE ERROR</errMsg>\n<returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg>\n<returnReasonCode>30</returnReasonCode>\n</cmmMsgHeader>\n</OpenAPI_ServiceResponse>');
  assert.deepEqual(xml, { code: 'xml_error:SERVICE_KEY_IS_NOT_REGISTERED_ERROR', reasonCode: '30', authMsg: 'SERVICE_KEY_IS_NOT_REGISTERED_ERROR',
    errMsg: 'SERVICE_ERROR', resultCode: null, resultMsg: null, stop: true });
  assert.equal(extractXmlError('<response><header><resultCode>22</resultCode><resultMsg>limit</resultMsg></header></response>').code, 'xml_error:22');
  assert.equal(extractXmlError('<response><header><resultCode>22</resultCode></header></response>').stop, true);
  assert.deepEqual(parseFscBody('  <x><returnReasonCode>12</returnReasonCode><returnAuthMsg>NO_OPENAPI_SERVICE_ERROR</returnAuthMsg></x>'),
    { ok: false, code: 'xml_error:NO_OPENAPI_SERVICE_ERROR', stop: false });
  assert.equal(extractXmlError('<returnAuthMsg>has <b>markup</b></returnAuthMsg>').code, 'xml_error:unknown');
});

// ---------------------------------------------------------------- summaries

test('summarizeFscSeries finds weekends, duplicates, invalid bars, raw jumps and base-price breaks', () => {
  const row = (date: string, clpr: number, vs: number, extra: Record<string, string> = {}) => ({
    basDt: date, mkp: String(clpr), hipr: String(clpr + 10), lopr: String(clpr - 10), clpr: String(clpr), vs: String(vs), fltRt: '-.39', trqu: '5', ...extra });
  // Returned newest first, as observed.
  const rows = [
    row('20210416', 121_000, 500),
    row('20210415', 120_500, 8_500, { fltRt: '7.59' }), // 5:1 split: raw -78%, vs against the adjusted base 112,000
    row('20210414', 558_000, 1_000),
    row('20210414', 558_000, 1_000), // duplicate
    row('20210411', 557_000, 0), // Sunday
    row('20210409', 557_000, 2_000, { hipr: '1', lopr: '2' }), // invalid: high below low
    row('20210408', 555_000, 0, { mkp: '0', hipr: '0', lopr: '0', trqu: '0' }), // halt-like
    { basDt: 'bad', clpr: '1' },
  ];
  const summary = summarizeFscSeries(rows);
  assert.equal(summary.count, 7);
  assert.equal(summary.badDates, 1);
  assert.equal(summary.order, 'desc');
  assert.deepEqual([summary.firstDate, summary.lastDate], ['2021-04-08', '2021-04-16']);
  assert.deepEqual(summary.duplicateDates, { count: 1, items: ['2021-04-14'] });
  assert.deepEqual(summary.weekendDates, { count: 1, items: ['2021-04-11'] });
  assert.deepEqual(summary.invalid.items.sort(), ['2021-04-08', '2021-04-09']);
  assert.equal(summary.haltLike, 1);
  assert.equal(summary.fieldPresence.clpr, 7);
  assert.equal(summary.fieldPresence.fltRt, 7);
  assert.deepEqual(summary.extremeMoves, [{ date: '2021-04-15', r: -0.784, fltRt: 7.59 }]);
  // Pairs over unique dates: 04-09, 04-11, 04-14, 04-15, 04-16; only 04-15 breaks clpr_t - clpr_t-1 = vs_t.
  assert.equal(summary.basePrice.pairs, 5);
  assert.equal(summary.basePrice.equal, 4);
  // Ratios only: vs with impliedReturn and factor would give back the raw closes, which only F10, M7-M8 and M11-M12 may carry.
  assert.deepEqual(summary.basePrice.mismatches, [{ date: '2021-04-15', rawRatio: 0.215950, impliedReturn: round6(8500 / 112_000), factor: round6(112_000 / 558_000) }]);
  assert.equal(summarizeFscSeries([]).order, 'empty');
});
function round6(value: number) { return Math.round(value * 1e6) / 1e6; }

test('summarizeMassiveAggs reads ET dates and clock times from t', () => {
  const bar = (date: string, c: number, extra: Record<string, unknown> = {}) => ({ o: c, h: c + 1, l: c - 1, c, v: 100, vw: c, n: 5, t: etMidnight(date), ...extra });
  const summary = summarizeMassiveAggs([
    bar('2026-03-06', 100), bar('2026-03-09', 100), // across the DST change: still 00:00 ET
    bar('2026-03-10', 160), // +60%
    bar('2026-03-11', 160, { v: 0 }),
    bar('2026-03-12', 160, { h: 150 }), // close above high
    { ...bar('2026-03-13', 160), t: zonedTimeToUtc('2026-03-13', '16:00', 'America/New_York') },
    bar('2026-03-14', 160), // Saturday
    'junk',
  ]);
  assert.equal(summary.count, 7);
  assert.deepEqual([summary.firstDate, summary.lastDate, summary.order], ['2026-03-06', '2026-03-14', 'asc']);
  assert.deepEqual(summary.etClockTimes, { '00:00:00': 6, '16:00:00': 1 });
  assert.equal(etMidnight('2026-01-02'), Date.parse('2026-01-02T05:00:00Z'));
  assert.deepEqual(summary.extremeMoves, [{ date: '2026-03-10', r: 0.6 }]);
  assert.deepEqual(summary.zeroVolume.items, ['2026-03-11']);
  assert.deepEqual(summary.invalid.items, ['2026-03-12']);
  assert.deepEqual(summary.weekendDates.items, ['2026-03-14']);
  assert.equal(summary.fieldPresence.vw, 7);
});

test('crossCheckCalendar reports holidays with data, weekdays without data and dates outside coverage', () => {
  // 2025-10-03 is a KRX holiday (Friday); 2025-10-01 is a session with no data.
  const kr = crossCheckCalendar('KRX', ['2025-09-29', '2025-09-30', '2025-10-02', '2025-10-03', '2025-10-04'], '2025-09-29', '2025-10-05');
  assert.deepEqual([kr.expected, kr.observed], [4, 5]);
  assert.deepEqual(kr.missing.items, ['2025-10-01']);
  assert.deepEqual(kr.extra.items, ['2025-10-03', '2025-10-04']);
  const edge = crossCheckCalendar('KRX', ['2026-12-30', '2027-01-04'], '2026-12-29', '2027-01-05');
  assert.deepEqual(edge.unverified.items, ['2027-01-04']);
  assert.deepEqual(edge.missing.items, ['2026-12-29']);
  const us = crossCheckCalendar('NASDAQ', ['2026-11-25', '2026-11-26', '2026-11-27'], '2026-11-25', '2026-11-27');
  assert.deepEqual([us.missing.count, us.extra.items], [0, ['2026-11-26']]);
});

test('compareOpenClose, corporate-action summaries and split selection', () => {
  const comparison = compareOpenClose({ date: '2026-10-12', t: 0, o: 100, h: 0, l: 0, c: 102, v: 0 }, { from: '2026-10-12', open: 100, close: 101.5, preMarket: 99 });
  assert.deepEqual([comparison.openDiff, comparison.closeDiff, comparison.openEqualsOfficial, comparison.openEqualsPreMarket, comparison.closeEqualsOfficial], [0, 0.5, true, false, false]);
  assert.equal(compareOpenClose(null, null).openDiff, null);
  const dividends = summarizeDividends([{ ticker: 'AAPL', ex_dividend_date: '2026-05-11', historical_adjustment_factor: 0.99, distribution_type: 'recurring' },
    { ticker: 'AAPL', ex_dividend_date: '2025-11-10', historical_adjustment_factor: 0.98, distribution_type: 'recurring' }]);
  assert.deepEqual([dividends.count, dividends.factor, dividends.dateRange, dividends.types], [2, { field: 'historical_adjustment_factor', min: 0.98, max: 0.99 },
    { first: '2025-11-10', last: '2026-05-11' }, { recurring: 2 }]);
  assert.equal(summarizeDividends([{ ticker: 'AAPL', cash_amount: 1 }]).factor.field, null);
  const splits = [
    { ticker: 'ZZZ', execution_date: '2025-08-01', split_from: 1, split_to: 30 },
    { ticker: 'NVDA', execution_date: '2025-07-01', split_from: 1, split_to: 2 },
    { ticker: 'FAST', execution_date: '2025-05-22', split_from: 1, split_to: 2 },
    { ticker: 'BRK.B', execution_date: '2025-08-01', split_from: 1, split_to: 50 },
  ];
  assert.equal(pickSplit(splits, '2024-11-11', '2026-11-09')!.ticker, 'FAST');
  assert.equal(pickSplit(splits.slice(0, 1).concat([{ ticker: 'YY', execution_date: '2025-08-01', split_from: 2, split_to: 5 }]), '2024-11-11', '2026-11-09')!.ticker, 'ZZZ');
  assert.equal(pickSplit([{ ticker: 'ORLY', execution_date: '2026-11-05', split_from: 1, split_to: 15 }], '2024-11-11', '2026-11-09'), null);
  assert.deepEqual([summarizeSplits(splits).count, summarizeSplits(splits).forwardRatio2Plus, summarizeSplits(splits).factor.field], [4, 4, null]);
});

// ---------------------------------------------------------------- Marketaux

test('Marketaux news parameters match server/marketaux.ts for the shared keys', async () => {
  let production: URLSearchParams | null = null;
  const provider = createMarketauxProvider({ MARKETAUX_API_TOKEN: 'fake-test-token-never-real' }, (async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/news/all') production = url.searchParams;
    return json({ data: [] });
  }) as typeof fetch, () => NOW);
  const apple = companies.find(item => item.id === 'nasdaq:AAPL')!;
  await provider.getArticles(apple, new Date(NOW));
  assert.ok(production);
  const prod = production as URLSearchParams;
  const dates = deriveDates(NOW);
  for (const query of ['positive', 'negative', 'total'] as const) {
    const ours = marketauxNewsParams('AAPL', 'us', dates.w0, dates.w1, query);
    for (const [name, value] of prod) {
      if (name === 'api_token') continue;
      assert.ok(name in ours, name);
      if (name === 'published_after' || name === 'published_before') assert.match(ours[name]!, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
      else assert.equal(ours[name], value, name);
    }
    assert.deepEqual(Object.keys(ours).filter(name => !prod.has(name)), query === 'positive' ? ['sentiment_gte'] : query === 'negative' ? ['sentiment_lte'] : []);
  }
  assert.equal(prod.get('published_after')!.length, dates.w0.length);
});

test('Korean entities verify only with exactly one kr / equity / known-name match', () => {
  const samsung = { symbol: '005930.KS', name: 'Samsung Electronics Co., Ltd.', type: 'equity', country: 'kr', exchange: 'KSC' };
  assert.equal(verifyKrEntity([samsung], 'krx:005930', '005930', 'symbols').verified, true);
  assert.equal(verifyKrEntity([samsung, { ...samsung, name: 'Samsung Electronics Pref' }], 'krx:005930', '005930', 'symbols').verified, false);
  assert.equal(verifyKrEntity([{ ...samsung, country: 'us' }], 'krx:005930', '005930', 'symbols').verified, false);
  assert.equal(verifyKrEntity([{ ...samsung, type: 'etf' }], 'krx:005930', '005930', 'symbols').verified, false);
  assert.equal(verifyKrEntity([{ ...samsung, symbol: '005930.KQ' }], 'krx:005930', '005930', 'symbols').verified, false);
  const viaSearch = verifyKrEntity([{ ...samsung, symbol: '005930.KS' }, { ...samsung, symbol: '005935.KS', name: 'Samsung Electronics Pref' }], 'krx:005930', '005930', 'search');
  assert.deepEqual([viaSearch.verified, viaSearch.symbol], [true, '005930.KS']);
  assert.equal(isKospi200Name('코스피 200'), true);
  assert.equal(isKospi200Name('KOSPI 200'), true);
  assert.equal(isKospi200Name('코스피 200 TR'), false);
});

test('articles keep only uuid, published_at, language and the queried symbol score; violations are counted', () => {
  const article = (uuid: string, scores: [string, unknown][]) => ({ uuid, title: 'T', url: 'https://x.test', description: 'D', snippet: 'S', keywords: 'K',
    published_at: '2026-01-05T01:00:00.000000Z', language: 'en', source: 'x', entities: scores.map(([symbol, sentiment_score]) => ({ symbol, sentiment_score, name: 'N' })) });
  const data = [
    article('a', [['AAPL', 0.4], ['MSFT', -0.9]]),
    article('b', [['AAPL', -0.2]]), // breaks a positive filter
    article('c', [['MSFT', 0.5]]), // no AAPL entity
    article('d', [['AAPL', 0.00005]]), // below the 0.0001 threshold
    article('e', [['AAPL', 0.3], ['AAPL', 0.1]]), // ambiguous: two AAPL entities
    { title: 'no uuid' },
  ];
  const positive = extractArticles(data, 'nasdaq:AAPL', 'AAPL', 'positive');
  assert.deepEqual([positive.violations, positive.noScore], [2, 2]);
  assert.deepEqual(positive.articles.map(item => Object.keys(item).sort()), Array(5).fill(['companyId', 'language', 'published_at', 'query', 'score', 'uuid']));
  assert.deepEqual(positive.articles.map(item => item.score), [0.4, -0.2, null, 0.00005, null]);
  const negative = extractArticles(data, 'nasdaq:AAPL', 'AAPL', 'negative');
  assert.equal(negative.violations, 2);
  assert.equal(extractArticles(data, 'nasdaq:AAPL', 'AAPL', 'total').violations, 0);
});

test('summarizeMarketaux derives neutral-or-unscored, shares and weekly averages', () => {
  const result = (query: MarketauxQueryResult['query'], found: number | null, code = 'ok', violations = 0): MarketauxQueryResult =>
    ({ id: query, companyId: 'nasdaq:AAPL', query, code, found, returned: 3, violations, noScore: 0, articles: [] });
  const [apple] = summarizeMarketaux([result('positive', 520), result('negative', 208, 'ok', 1), result('total', 1040)]);
  assert.deepEqual(apple, {
    companyId: 'nasdaq:AAPL', positive: 520, negative: 208, total: 1040, neutralOrUnscored: 312,
    shares: { positive: 0.5, negative: 0.2, neutralOrUnscored: 0.3 }, perWeek: { positive: 5, negative: 2, total: 10 },
    violations: { positive: 0, negative: 1 }, noScore: 0,
  });
  const [partial] = summarizeMarketaux([result('positive', 10), result('negative', null, 'http_429')]);
  assert.deepEqual([partial!.negative, partial!.total, partial!.neutralOrUnscored, partial!.shares], [null, null, null, null]);
});

test('live run summary and article file hold aggregates only', async () => {
  const h = harness(fakeProviders());
  const result = await runHistoryCheck(h.deps, { live: true });
  assert.deepEqual(result.outputs.map(output => output.name), ['summary-20261110T1800Z.json', 'marketaux-articles-20261110.json']);
  const articles = JSON.parse(result.outputs[1]!.content) as Record<string, unknown>[];
  assert.equal(articles.length, 19 * 3);
  assert.ok(articles.every(item => Object.keys(item).sort().join() === 'companyId,language,published_at,query,score,uuid'));
  const all = result.outputs.map(output => output.content).join('\n') + h.lines.join('\n');
  for (const text of ['SECRET TITLE', 'DESCRIPTION', 'SNIPPET', 'example.test/a']) assert.ok(!all.includes(text), text);
  const summary = result.summary!;
  assert.deepEqual(Object.keys(summary).sort(), ['budgets', 'calendar', 'calls', 'dates', 'fsc', 'generatedAt', 'keysPresent', 'marketaux', 'massive', 'mode']);
  const marketaux = summary.marketaux as { symbolsList: string; companies: { companyId: string; total: number | null; positive: number | null }[] };
  assert.equal(marketaux.symbolsList, 'supported');
  assert.deepEqual(marketaux.companies.filter(item => item.total !== null).map(item => item.companyId), ['krx:005930', 'krx:005380', 'nasdaq:AAPL']);
  assert.ok(marketaux.companies.every(item => item.positive === 60));
  const massive = summary.massive as { openClose: { id: string; date: string; openDiff: number }[]; adjustment: { split: { ticker: string } } };
  assert.deepEqual(massive.openClose.map(item => [item.id, item.date]), [['M7', '2025-12-24'], ['M8', '2026-10-12']]);
  assert.equal(massive.adjustment.split.ticker, 'ORLY');
  const calendar = summary.calendar as { fsc: Record<string, unknown>; massive: Record<string, unknown> };
  assert.deepEqual(Object.keys(calendar.fsc), ['F1', 'F2', 'F3', 'F4', 'F5', 'F6']);
  assert.deepEqual(Object.keys(calendar.massive), ['M1', 'M2', 'M3', 'M4', 'M5', 'M6']);
  const fsc = summary.fsc as { indexNames: { key: unknown[] }[]; etfVsIndex: { matchedDates: number; equal: number } };
  assert.deepEqual(fsc.indexNames.map(item => item.key[0]).sort(), ['코스피 200', '코스피 200 TR']);
  assert.deepEqual(fsc.etfVsIndex, { matchedDates: 3, equal: 3, maxAbsRel: 0 });
  assert.ok(h.lines.some(line => line.startsWith('호출 사용량: fsc 10/10 · massive 12/12 · marketaux 20/20')));
});

test('parseArgs accepts --live and --only and rejects anything else', () => {
  assert.deepEqual(parseArgs([]), { live: false });
  assert.deepEqual(parseArgs(['--live', '--only', 'fsc,massive']), { live: true, only: ['fsc', 'massive'] });
  assert.deepEqual(parseArgs(['--only=marketaux']), { live: false, only: ['marketaux'] });
  assert.deepEqual(parseArgs(['--only', 'gemini']), { error: 'unknown_provider' });
  assert.deepEqual(parseArgs(['--only']), { error: 'unknown_argument' });
  assert.deepEqual(parseArgs(['--force']), { error: 'unknown_argument' });
});

// ---------------------------------------------------------------- pre-live review regressions

test('a live run refuses to start while NODE_DEBUG is set, because Node itself would print the keyed request paths', async () => {
  const h = harness(fakeProviders(), { ...KEYS, NODE_DEBUG: 'fetch' });
  await assert.rejects(runHistoryCheck(h.deps, { live: true }), (error: unknown) => error instanceof Error && error.message === 'node_debug_set');
  assert.equal(h.requests.length, 0);
  assert.ok(h.lines.some(line => line.includes('NODE_DEBUG')));
  assertNoSecret(h.lines.join('\n'));
  const dry = harness(() => { throw new Error('must not fetch'); }, { ...KEYS, NODE_DEBUG: 'undici' });
  assert.equal((await runHistoryCheck(dry.deps)).mode, 'dry_run');
  assert.ok(dry.lines.some(line => line.includes('NODE_DEBUG')));
  const blank = harness(fakeProviders(), { KR_PRICE_API_KEY: DECODED_KR, NODE_DEBUG: ' ', NODE_TLS_REJECT_UNAUTHORIZED: '1' });
  assert.equal((await runHistoryCheck(blank.deps, { live: true })).mode, 'live');
  assert.equal(blank.count('fsc'), 10);
  // Keys must not travel over TLS whose certificate is not verified.
  const tls = harness(fakeProviders(), { ...KEYS, NODE_TLS_REJECT_UNAUTHORIZED: '0' });
  await assert.rejects(runHistoryCheck(tls.deps, { live: true }), (error: unknown) => error instanceof Error && error.message === 'tls_unverified');
  assert.equal(tls.requests.length, 0);
});

test('impossible provider dates and timestamps count as bad rows instead of ending the run', async () => {
  for (const bad of ['20231301', '20230232', '00000000', '20230229', '20231131', 20231301]) assert.equal(fscDate(bad), null, String(bad));
  assert.equal(fscDate('20240229'), '2024-02-29');
  assert.equal(fscDate(20240105), '2024-01-05');
  assert.equal(summarizeFscSeries([{ basDt: '20231301', clpr: '1' }, { basDt: '20240105', mkp: '1', hipr: '1', lopr: '1', clpr: '1' }]).badDates, 1);
  const bar = { o: 1, h: 2, l: 1, c: 2, v: 5, vw: 1.5, n: 3 };
  const aggs = summarizeMassiveAggs([{ ...bar, t: etMidnight('2026-11-09') * 1e6 }, { ...bar, t: etMidnight('2026-11-06') }]);
  assert.deepEqual([aggs.count, aggs.badTimes, aggs.firstDate], [1, 1, '2026-11-06']);
  assert.equal(etTime(Number.NaN), 'invalid');
  assert.equal(etTime(1e17), 'invalid');
  // Live: one impossible basDt (FSC) and nanosecond t values (Massive) leave every other result in place.
  const base = fakeProviders();
  const h = harness((url, init) => {
    if (url.host === HOSTS.fsc && url.searchParams.get('likeSrtnCd') === '005930' && url.searchParams.get('beginBasDt') === '20230101') {
      return fscEnvelope([...fscRows('005930', RECENT), { ...fscRows('005930', ['2026-11-04'])[0]!, basDt: '20231301' }]);
    }
    if (url.host === HOSTS.massive && url.pathname.startsWith('/v2/aggs/ticker/AAPL/')) {
      return json({ status: 'OK', adjusted: { echoed: 'x'.repeat(40) }, resultsCount: 1, results: [{ ...bar, t: etMidnight('2026-11-09') * 1e6 }] });
    }
    return base(url, init);
  }, { KR_PRICE_API_KEY: DECODED_KR, US_PRICE_API_KEY: KEYS.US_PRICE_API_KEY });
  const result = await runHistoryCheck(h.deps, { live: true });
  assert.deepEqual([h.count('fsc'), h.count('massive')], [10, 12]);
  const f1 = (result.summary!.fsc as { series: { series: { count: number; badDates: number } }[] }).series[0]!.series;
  assert.deepEqual([f1.count, f1.badDates], [3, 1]);
  const series = (result.summary!.massive as { series: { adjusted: unknown; summary: { count: number; badTimes: number } }[] }).series;
  // A non-boolean `adjusted` is not copied into the summary.
  assert.deepEqual([series[0]!.adjusted, series[0]!.summary.count, series[0]!.summary.badTimes], [null, 0, 1]);
  assert.equal(series[1]!.adjusted, true);
});

test('FSC gateway errors sent as JSON keep their code and stop on key or limit errors', async () => {
  const wrapped = { OpenAPI_ServiceResponse: { cmmMsgHeader: { errMsg: 'SERVICE ERROR', returnAuthMsg: 'SERVICE_KEY_IS_NOT_REGISTERED_ERROR', returnReasonCode: '30' } } };
  assert.deepEqual(parseFscBody(JSON.stringify(wrapped)), { ok: false, code: 'fsc_result:SERVICE_KEY_IS_NOT_REGISTERED_ERROR', stop: true });
  assert.deepEqual(parseFscBody(JSON.stringify({ cmmMsgHeader: { returnReasonCode: '22' } })), { ok: false, code: 'fsc_result:22', stop: true });
  assert.deepEqual(parseFscBody(JSON.stringify({ resultCode: '30', resultMsg: 'SERVICE KEY IS NOT REGISTERED ERROR.' })), { ok: false, code: 'fsc_result:30', stop: true });
  assert.deepEqual(parseFscBody(JSON.stringify({ resultMsg: 'LIMITED NUMBER OF SERVICE REQUESTS EXCEEDS ERROR.' })),
    { ok: false, code: 'fsc_result:LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR', stop: true });
  // A message name with spaces or a trailing period still stops, whatever number comes with it.
  assert.deepEqual(parseFscBody(JSON.stringify({ response: { header: { resultCode: '99', resultMsg: 'SERVICE ACCESS DENIED ERROR.' } } })),
    { ok: false, code: 'fsc_result:99', stop: true });
  assert.equal(extractXmlError('<cmmMsgHeader><returnAuthMsg>SERVICE ACCESS DENIED ERROR.</returnAuthMsg><returnReasonCode>99</returnReasonCode></cmmMsgHeader>').stop, true);
  assert.deepEqual(parseFscBody(JSON.stringify({ response: { header: { resultCode: '03', resultMsg: 'NODATA ERROR' } } })), { ok: false, code: 'fsc_result:03', stop: false });
  const h = harness(() => json(wrapped), { KR_PRICE_API_KEY: DECODED_KR });
  const result = await runHistoryCheck(h.deps, { live: true });
  assert.equal(h.count('fsc'), 1);
  const calls = (result.summary!.calls as { provider: string; code: string }[]).filter(call => call.provider === 'fsc');
  assert.equal(calls[0]!.code, 'fsc_result:SERVICE_KEY_IS_NOT_REGISTERED_ERROR');
  assert.ok(calls.slice(1).every(call => call.code === 'stopped' || call.code === 'skipped_condition'));
});

test('a key in the URLSearchParams form sent to Marketaux is caught in echoes and redacted', async () => {
  const token = 'mx~token(abc)!xyz-123';
  const wire = new URLSearchParams([['api_token', token]]).toString().slice('api_token='.length);
  assert.notEqual(wire, encodeURIComponent(token));
  const lower = wire.replace(/%[0-9A-F]{2}/g, hex => hex.toLowerCase());
  assert.equal(createRedactor([token])(`a ${wire} b ${lower} c`), 'a [REDACTED] b [REDACTED] c');
  const base = fakeProviders();
  const h = harness((url, init) => {
    if (url.pathname !== '/v1/news/all') return base(url, init);
    const echoed = /(?:^|[?&])api_token=([^&]*)/.exec(url.search)![1]!;
    return json({ meta: { found: 1, returned: 1, limit: 3, page: 1 },
      data: [{ uuid: echoed, published_at: '2026-01-05T01:00:00.000000Z', language: 'en', entities: [] }] });
  }, { MARKETAUX_API_TOKEN: token });
  const result = await runHistoryCheck(h.deps, { live: true });
  const text = [JSON.stringify(result), h.lines.join('\n'), ...result.outputs.map(output => output.content)].join('\n');
  assert.ok(!text.includes(wire) && !text.includes(lower) && !text.includes(token));
  const news = (result.summary!.calls as { path: string; code: string }[]).filter(call => call.path === '/v1/news/all');
  assert.ok(news.length === 19 && news.every(call => call.code === 'echoed_secret'));
});

test('Massive pacing re-checks the gap when a timer ends a millisecond early', async () => {
  const h = harness(fakeProviders(), { US_PRICE_API_KEY: KEYS.US_PRICE_API_KEY });
  const sleep = h.deps.sleep;
  h.deps.sleep = ms => sleep(ms > 1 ? ms - 1 : ms);
  await runHistoryCheck(h.deps, { live: true });
  const starts = h.requests.filter(request => request.url.host === HOSTS.massive).map(request => request.at);
  assert.equal(starts.length, 12);
  for (let index = 1; index < starts.length; index += 1) assert.ok(starts[index]! - starts[index - 1]! >= 13_000, String(index));
});

test('the console marks a truncated earliest-date probe, since rows may come newest first', async () => {
  const earliestLine = (lines: string[]) => lines.find(line => line.startsWith('[금융위] 가장 이른 날짜'))!;
  const h = harness(fakeProviders({ huge: true }), { KR_PRICE_API_KEY: DECODED_KR });
  await runHistoryCheck(h.deps, { live: true, only: ['fsc'] });
  assert.equal(earliestLine(h.lines).split('잘림').length - 1, 3, earliestLine(h.lines));
  const plain = harness(fakeProviders(), { KR_PRICE_API_KEY: DECODED_KR });
  await runHistoryCheck(plain.deps, { live: true, only: ['fsc'] });
  assert.ok(!earliestLine(plain.lines).includes('잘림'));
});

test('rows the exact code filter drops stay visible, so an unexpected code format is not mistaken for missing data', async () => {
  const base = fakeProviders();
  const h = harness((url, init) => url.host === HOSTS.fsc && url.searchParams.get('likeSrtnCd') === '005930'
    ? fscEnvelope(fscRows('A005930', RECENT)) : base(url, init), { KR_PRICE_API_KEY: DECODED_KR });
  const result = await runHistoryCheck(h.deps, { live: true, only: ['fsc'] });
  const fsc = result.summary!.fsc as { series: { id: string; kept: number; returned: number; dropped: { key: unknown[]; count: number }[] }[];
    earliest: Record<string, { rows: number; returned: number }> };
  const f1 = fsc.series.find(item => item.id === 'F1')!;
  assert.deepEqual([f1.kept, f1.returned, f1.dropped[0]!.key[0], f1.dropped[0]!.count], [0, 3, 'A005930', 3]);
  assert.deepEqual([fsc.earliest.F7!.rows, fsc.earliest.F7!.returned], [0, 3]);
  assert.ok(h.lines.some(line => line.includes('코드·이름이 맞는 행이 없음') && line.includes('A005930')));
  // The usual case: only the different code that merely contains the queried one is listed as dropped.
  const plain = harness(fakeProviders(), { KR_PRICE_API_KEY: DECODED_KR });
  const normal = await runHistoryCheck(plain.deps, { live: true, only: ['fsc'] });
  const f1Normal = (normal.summary!.fsc as typeof fsc).series.find(item => item.id === 'F1')!;
  assert.deepEqual(f1Normal.dropped.map(item => item.key[0]), ['905930']);
});

test('provider text reaches the console without control or direction-override characters', async () => {
  const esc = String.fromCharCode(0x1b);
  const rlo = String.fromCharCode(0x202e);
  const base = fakeProviders();
  const h = harness(async (url, init) => {
    const response = await base(url, init);
    if (url.host !== HOSTS.fsc || !url.pathname.endsWith('getStockMarketIndex_V2')) return response;
    const body = await response.json() as { response: { body: { items: { item: Record<string, string>[] } } } };
    for (const item of body.response.body.items.item) item.idxCsf = `KOSPI${esc}[2J${rlo}시리즈`;
    return json(body);
  }, { KR_PRICE_API_KEY: DECODED_KR });
  await runHistoryCheck(h.deps, { live: true, only: ['fsc'] });
  assert.ok(h.lines.some(line => line.startsWith('[금융위] 지수 이름(F6)') && line.includes('KOSPI')));
  assert.ok(h.lines.every(line => !line.includes(esc) && !line.includes(rlo)));
});
