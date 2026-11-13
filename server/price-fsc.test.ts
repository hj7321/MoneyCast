import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  createFscPriceProvider, FSC_MAX_BODY, FSC_MIN_GAP_MS, FSC_ORIGIN, FSC_PATHS, FSC_REQUEST_CAP, FSC_TIMEOUT_MS, fscRequestUrl,
} from './price-fsc.js';
import { priceIdentity, type PriceFetchRequest, type PriceIdentity } from './price-provider.js';
import { secretForms } from './price-wire.js';

// 2026-11-11 17:50 KST: the 2026-11-11 session (closing 15:30 KST) is over.
const NOW = Date.parse('2026-11-11T08:50:00Z');
const DECODED = 'Kr+Fake/Key=Plus+Slash/Equals==';
const ENCODED = encodeURIComponent(DECODED);
const SAMSUNG = priceIdentity('krx:005930')!;
const KODEX = priceIdentity('krx:069500')!;
const FAR = NOW + 3_600_000;

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
function harness(handler: Handler, env: Record<string, string | undefined> = { KR_PRICE_API_KEY: DECODED }, sleepSkew = 0) {
  let clock = NOW;
  const requests: { raw: string; url: URL; init: RequestInit; at: number }[] = [];
  const sleeps: number[] = [];
  const fetcher = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const raw = String(input);
    requests.push({ raw, url: new URL(raw), init: init ?? {}, at: clock });
    return handler(new URL(raw), init ?? {});
  }) as typeof fetch;
  const provider = createFscPriceProvider(env, {
    fetcher, now: () => clock, sleep: async ms => { sleeps.push(ms); clock += ms > sleepSkew ? ms - sleepSkew : ms; },
  });
  return { provider, requests, sleeps, setClock: (ms: number) => { clock = ms; }, now: () => clock };
}

const compact = (date: string) => date.replace(/-/g, '');
interface RowOptions { code?: string; isin?: string; market?: string; extra?: Record<string, string> }
function rows(identity: PriceIdentity, dates: string[], options: RowOptions = {}): Record<string, string>[] {
  let close = 1000;
  return dates.map(date => {
    const previous = close;
    close = previous + 10;
    return {
      basDt: compact(date), srtnCd: options.code ?? identity.providerSymbol, isinCd: options.isin ?? identity.isin!, itmsNm: '테스트',
      ...(identity.instrument === 'stock' ? { mrktCtg: options.market ?? 'KOSPI' } : { bssIdxIdxNm: '코스피 200', bssIdxClpr: String(close * 2) }),
      mkp: String(previous), hipr: String(close + 5), lopr: String(previous - 5), clpr: String(close), vs: '10', fltRt: '1.00', trqu: '100',
      ...options.extra,
    };
  });
}
function envelope(items: unknown[], totalCount = items.length): Response {
  return json({ response: { header: { resultCode: '00', resultMsg: 'NORMAL SERVICE.' }, body: { numOfRows: 3000, pageNo: 1, totalCount, items: { item: items } } } });
}
const request = (identity: PriceIdentity, from = '2026-11-01', to = '2026-11-11'): PriceFetchRequest => ({ identity, from, to });
const DATES = ['2026-11-05', '2026-11-06', '2026-11-09'];

test('FSC sends one exact GET per request with the key only in serviceKey, decoded once', async () => {
  const fsc = harness(() => envelope(rows(SAMSUNG, DATES)), { KR_PRICE_API_KEY: ENCODED });
  const result = await fsc.provider.fetch(request(SAMSUNG), FAR);
  assert.equal(result.code, 'ok');
  assert.equal(result.providerCode, 'resultCode:00');
  assert.equal(fsc.requests.length, 1);
  const [{ raw, url, init }] = fsc.requests;
  assert.equal(url.origin, FSC_ORIGIN);
  assert.equal(url.pathname, FSC_PATHS.stock);
  assert.deepEqual([...url.searchParams.keys()], ['serviceKey', 'likeSrtnCd', 'beginBasDt', 'endBasDt', 'numOfRows', 'pageNo', 'resultType']);
  assert.equal(url.searchParams.get('serviceKey'), DECODED);
  assert.ok(raw.includes(`serviceKey=${ENCODED}&`), 'the Encoding key is decoded once and encoded once');
  assert.equal(url.searchParams.get('likeSrtnCd'), '005930');
  assert.equal(url.searchParams.get('beginBasDt'), '20261101');
  assert.equal(url.searchParams.get('endBasDt'), '20261112', 'endBasDt is exclusive');
  assert.equal(url.searchParams.get('numOfRows'), '3000');
  assert.equal(url.searchParams.get('pageNo'), '1');
  assert.equal(url.searchParams.get('resultType'), 'json');
  assert.equal(init.method, 'GET');
  assert.equal(init.redirect, 'error');
  assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual(init.headers, { Accept: 'application/json' });
  const withoutKey = raw.replace(`serviceKey=${ENCODED}`, '');
  for (const form of secretForms([DECODED])) {
    assert.ok(!withoutKey.includes(form), 'the key appears only in serviceKey');
    assert.ok(!JSON.stringify(init.headers).includes(form));
    assert.ok(!JSON.stringify(result).includes(form));
  }

  const etf = harness(() => envelope(rows(KODEX, DATES)));
  assert.equal((await etf.provider.fetch(request(KODEX), FAR)).code, 'ok');
  assert.equal(etf.requests[0]!.url.pathname, FSC_PATHS.etf);
  assert.equal(etf.requests[0]!.url.searchParams.get('likeSrtnCd'), '069500');
  assert.equal(fscRequestUrl(DECODED, request(SAMSUNG)), fsc.requests[0]!.raw);
});

test('FSC Encoding and Decoding keys give an identical wire query', async () => {
  const encoded = harness(() => envelope([]), { KR_PRICE_API_KEY: ` ${ENCODED} ` });
  const decoded = harness(() => envelope([]), { KR_PRICE_API_KEY: DECODED });
  await encoded.provider.fetch(request(SAMSUNG), FAR);
  await decoded.provider.fetch(request(SAMSUNG), FAR);
  assert.equal(encoded.requests[0]!.raw, decoded.requests[0]!.raw);
});

test('FSC rows newest first come out ascending with raw prices, base and counts', async () => {
  const fsc = harness(() => envelope(rows(SAMSUNG, DATES).reverse()));
  const result = await fsc.provider.fetch(request(SAMSUNG), FAR);
  assert.equal(result.code, 'ok');
  assert.deepEqual(result.bars.map(bar => bar.date), DATES);
  assert.deepEqual(result.bars[0], { date: '2026-11-05', open: 1000, high: 1015, low: 995, close: 1010, volume: 100, base: 1000 });
  assert.equal(result.counts.rows, 3);
  assert.equal(result.counts.kept, 3);
  assert.equal(result.attemptedAt, new Date(NOW).toISOString());
  assert.equal(result.receivedAt, new Date(NOW).toISOString());
});

test('FSC drops other codes and rejects an ISIN, market or index-name mismatch', async () => {
  const mixed = harness(() => envelope([...rows(SAMSUNG, DATES), ...rows(SAMSUNG, DATES.slice(0, 1), { code: '905930', isin: 'KR7905930000' })]));
  const result = await mixed.provider.fetch(request(SAMSUNG), FAR);
  assert.equal(result.code, 'ok');
  assert.equal(result.counts.otherCodes, 1);
  assert.equal(result.bars.length, 3);

  for (const [identity, options] of [
    [SAMSUNG, { isin: 'KR7005935002' }], [SAMSUNG, { market: 'KOSDAQ' }], [KODEX, { isin: 'KR7000000000' }],
    [KODEX, { extra: { bssIdxIdxNm: '코스피 200 TR' } }],
  ] as const) {
    const bad = harness(() => envelope(rows(identity, DATES, options)));
    const outcome = await bad.provider.fetch(request(identity), FAR);
    assert.equal(outcome.code, 'identity_mismatch', JSON.stringify(options));
    assert.deepEqual(outcome.bars, []);
  }
  const noName = harness(() => envelope(rows(KODEX, DATES, { extra: { bssIdxIdxNm: '' } })));
  assert.equal((await noName.provider.fetch(request(KODEX), FAR)).code, 'ok', 'a missing index name is accepted');
  const spaced = harness(() => envelope(rows(KODEX, DATES, { extra: { bssIdxIdxNm: 'KOSPI 200' } })));
  assert.equal((await spaced.provider.fetch(request(KODEX), FAR)).code, 'ok');
});

test('FSC rejects the whole response on a weekend or holiday row', async () => {
  for (const date of ['2026-11-07', '2026-07-17']) {
    const fsc = harness(() => envelope(rows(SAMSUNG, [...DATES, date])));
    const result = await fsc.provider.fetch(request(SAMSUNG, '2026-07-01'), FAR);
    assert.equal(result.code, 'calendar_mismatch', date);
    assert.deepEqual(result.bars, []);
    assert.equal(result.counts.nonSession, 1);
  }
});

test('FSC drops rows outside calendar coverage, not yet closed or outside validity', async () => {
  const fsc = harness(() => envelope(rows(SAMSUNG, ['2019-12-30', '2026-11-09', '2026-11-11', '2027-01-04'])));
  fsc.setClock(Date.parse('2026-11-11T05:00:00Z')); // 14:00 KST: today's session is still open
  const result = await fsc.provider.fetch(request(SAMSUNG, '2019-12-01', '2027-01-10'), FAR);
  assert.equal(result.code, 'ok');
  assert.deepEqual(result.bars.map(bar => bar.date), ['2026-11-09']);
  assert.equal(result.counts.outsideValidity, 1);
  assert.equal(result.counts.unverifiedDate, 1);
  assert.equal(result.counts.notClosed, 1);

  const later = harness(() => envelope(rows(SAMSUNG, ['2026-11-11'])));
  later.setClock(Date.parse('2026-11-11T06:30:00Z')); // 15:30 KST exactly
  assert.deepEqual((await later.provider.fetch(request(SAMSUNG), FAR)).bars.map(bar => bar.date), ['2026-11-11']);
});

test('FSC keeps halt-day zeros flagged, omits base without vs and keeps bssIdxClpr only on the ETF', async () => {
  const halt = { mkp: '0', hipr: '0', lopr: '0', trqu: '0' };
  const fsc = harness(() => envelope([
    ...rows(SAMSUNG, ['2026-11-05'], { extra: { ...halt, bssIdxClpr: '400' } }),
    ...rows(SAMSUNG, ['2026-11-06'], { extra: { vs: '' } }),
    ...rows(SAMSUNG, ['2026-11-09'], { extra: { mkp: '', lopr: '2000' } }),
  ]));
  const result = await fsc.provider.fetch(request(SAMSUNG), FAR);
  assert.equal(result.code, 'ok');
  const [haltDay, noVs, odd] = result.bars;
  assert.deepEqual(haltDay, { date: '2026-11-05', open: 0, high: 0, low: 0, close: 1010, volume: 0, base: 1000, flags: ['zero_open', 'zero_volume', 'halt'] });
  assert.equal(noVs!.base, undefined);
  assert.equal(noVs!.flags, undefined);
  assert.deepEqual(odd!.flags, ['zero_open', 'out_of_range', 'missing_field']);
  assert.equal(result.counts.flagged, 2);
  assert.ok(result.bars.every(bar => bar.indexClose === undefined), 'a stock never carries indexClose');

  const etf = harness(() => envelope(rows(KODEX, ['2026-11-05', '2026-11-06'], { extra: { bssIdxClpr: '' } })
    .concat(rows(KODEX, ['2026-11-09']))));
  const etfResult = await etf.provider.fetch(request(KODEX), FAR);
  assert.deepEqual(etfResult.bars.map(bar => bar.indexClose), [undefined, undefined, 2020]);
});

test('FSC: a negative or zero base is omitted, a non-positive close is malformed', async () => {
  const fsc = harness(() => envelope([
    ...rows(SAMSUNG, ['2026-11-05'], { extra: { vs: '1010' } }),
    ...rows(SAMSUNG, ['2026-11-06'], { extra: { clpr: '0' } }),
    ...rows(SAMSUNG, ['2026-11-09'], { extra: { basDt: '20261332' } }),
  ]));
  const result = await fsc.provider.fetch(request(SAMSUNG), FAR);
  assert.equal(result.code, 'ok');
  assert.deepEqual(result.bars.map(bar => [bar.date, bar.base]), [['2026-11-05', undefined]]);
  assert.equal(result.counts.malformed, 2);
});

test('FSC collapses identical duplicate rows and rejects differing ones', async () => {
  const same = harness(() => envelope([...rows(SAMSUNG, DATES), ...rows(SAMSUNG, DATES.slice(0, 1))]));
  const ok = await same.provider.fetch(request(SAMSUNG), FAR);
  assert.equal(ok.code, 'ok');
  assert.equal(ok.counts.duplicates, 1);
  assert.equal(ok.bars.length, 3);
  const differing = harness(() => envelope([...rows(SAMSUNG, DATES), ...rows(SAMSUNG, DATES.slice(0, 1), { extra: { clpr: '999' } })]));
  assert.equal((await differing.provider.fetch(request(SAMSUNG), FAR)).code, 'duplicate_dates');
});

test('FSC reports truncated when totalCount exceeds the rows and never asks for a next page', async () => {
  const fsc = harness(() => envelope(rows(SAMSUNG, DATES), 5000));
  const result = await fsc.provider.fetch(request(SAMSUNG), FAR);
  assert.equal(result.code, 'truncated');
  assert.deepEqual(result.bars, []);
  assert.equal(fsc.requests.length, 1);
});

test('FSC gateway errors give provider_error and stop on key or limit codes', async () => {
  const xml = '<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>SERVICE ERROR</errMsg><returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg>' +
    '<returnReasonCode>30</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>';
  const cases: [string, () => Response, string, boolean][] = [
    ['xml', () => new Response(xml, { status: 200 }), 'xml_error:SERVICE_KEY_IS_NOT_REGISTERED_ERROR', true],
    ['json22', () => json({ response: { header: { resultCode: '22', resultMsg: 'LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR' } } }), 'fsc_result:22', true],
    ['nodata', () => json({ response: { header: { resultCode: '03', resultMsg: 'NODATA ERROR' } } }), 'fsc_result:03', false],
    ['garbage', () => new Response('not json', { status: 200 }), 'bad_json', false],
  ];
  for (const [name, response, providerCode, stops] of cases) {
    const fsc = harness(response);
    const first = await fsc.provider.fetch(request(SAMSUNG), FAR);
    assert.equal(first.code, 'provider_error', name);
    assert.equal(first.providerCode, providerCode, name);
    const second = await fsc.provider.fetch(request(SAMSUNG), FAR);
    assert.equal(second.code, stops ? 'stopped' : 'provider_error', name);
    assert.equal(fsc.requests.length, stops ? 1 : 2, name);
  }
});

test('FSC 401/403/429 stop the provider; other HTTP errors do not; one fetch per request', async () => {
  for (const status of [401, 403, 429]) {
    const fsc = harness(() => new Response('<x/>', { status }));
    assert.equal((await fsc.provider.fetch(request(SAMSUNG), FAR)).code, `http_${status}`);
    const later = await fsc.provider.fetch(request(KODEX), FAR);
    assert.equal(later.code, 'stopped');
    assert.equal(later.receivedAt, null);
    assert.equal(fsc.requests.length, 1, `exactly one fetch for ${status}`);
  }
  const server = harness(() => json({ response: { header: { resultCode: '22' } } }, 500));
  const failed = await server.provider.fetch(request(SAMSUNG), FAR);
  assert.equal(failed.code, 'http_500');
  assert.equal(failed.providerCode, 'fsc_result:22', 'an error body still yields its gateway code');
  assert.equal((await server.provider.fetch(request(SAMSUNG), FAR)).code, 'stopped', 'and its stop code');
  const plain = harness(() => new Response('oops', { status: 502 }));
  assert.equal((await plain.provider.fetch(request(SAMSUNG), FAR)).code, 'http_502');
  assert.equal((await plain.provider.fetch(request(SAMSUNG), FAR)).code, 'http_502');
  assert.equal(plain.requests.length, 2, 'no retry, no stop');
});

test('FSC paces starts at least 1 s apart, honours the deadline and caps requests', async () => {
  const fsc = harness(() => envelope([]), undefined, 1);
  for (let index = 0; index < FSC_REQUEST_CAP + 1; index += 1) {
    const result = await fsc.provider.fetch(request(SAMSUNG), FAR);
    assert.equal(result.code, index < FSC_REQUEST_CAP ? 'ok' : 'skipped_budget');
  }
  assert.equal(fsc.requests.length, FSC_REQUEST_CAP);
  for (let index = 1; index < fsc.requests.length; index += 1) {
    assert.ok(fsc.requests[index]!.at - fsc.requests[index - 1]!.at >= FSC_MIN_GAP_MS);
  }

  const tight = harness(() => envelope([]));
  const skipped = await tight.provider.fetch(request(SAMSUNG), NOW + FSC_TIMEOUT_MS - 1);
  assert.equal(skipped.code, 'skipped_budget');
  assert.equal(tight.requests.length, 0);
  assert.equal((await tight.provider.fetch(request(SAMSUNG), NOW + FSC_TIMEOUT_MS)).code, 'ok');
  const paced = await tight.provider.fetch(request(SAMSUNG), NOW + FSC_TIMEOUT_MS + 500);
  assert.equal(paced.code, 'skipped_budget', 'the pacing wait counts against the deadline');
  assert.equal(tight.requests.length, 1);
  assert.deepEqual(tight.sleeps, []);
});

test('FSC concurrent fetches are serialized and still paced', async () => {
  const fsc = harness(() => envelope([]));
  const results = await Promise.all([fsc.provider.fetch(request(SAMSUNG), FAR), fsc.provider.fetch(request(KODEX), FAR)]);
  assert.deepEqual(results.map(result => result.code), ['ok', 'ok']);
  assert.ok(fsc.requests[1]!.at - fsc.requests[0]!.at >= FSC_MIN_GAP_MS);
});

test('FSC discards a body that echoes the key and one over the size cap', async () => {
  const echo = harness(() => json({ response: { header: { resultCode: '00', resultMsg: `bad key ${encodeURIComponent(DECODED)}` } } }));
  const echoed = await echo.provider.fetch(request(SAMSUNG), FAR);
  assert.equal(echoed.code, 'echoed_secret');
  assert.equal(echoed.providerCode, null);
  const big = harness(() => new Response('{}', { status: 200, headers: { 'content-length': String(FSC_MAX_BODY + 1) } }));
  assert.equal((await big.provider.fetch(request(SAMSUNG), FAR)).code, 'too_large');
});

test('FSC maps a thrown fetch to network without exposing the key anywhere', async () => {
  const printed: string[] = [];
  const restore = ['log', 'error', 'warn', 'info', 'debug'].map(name => {
    const method = mock.method(console, name as 'log', (...args: unknown[]) => { printed.push(args.map(String).join(' ')); });
    return method;
  });
  try {
    const fsc = harness((url) => { throw new TypeError(`fetch failed for ${url.toString()}`); });
    const result = await fsc.provider.fetch(request(SAMSUNG), FAR);
    assert.equal(result.code, 'network');
    assert.equal(result.receivedAt, null);
    const text = JSON.stringify(result) + printed.join('\n');
    for (const form of secretForms([DECODED])) assert.ok(!text.includes(form));
  } finally {
    for (const method of restore) method.mock.restore();
  }
  assert.deepEqual(printed, []);
});

test('FSC maps an abort after the 20 s timeout to timeout', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let called!: () => void;
    const started = new Promise<void>(resolve => { called = resolve; });
    const fsc = harness((url, init) => new Promise<Response>((_, reject) => {
      init.signal!.addEventListener('abort', () => reject(new DOMException(`aborted ${url.toString()}`, 'AbortError')));
      called();
    }));
    const pending = fsc.provider.fetch(request(SAMSUNG), FAR);
    await started;
    mock.timers.tick(FSC_TIMEOUT_MS);
    const result = await pending;
    assert.equal(result.code, 'timeout');
    for (const form of secretForms([DECODED])) assert.ok(!JSON.stringify(result).includes(form));
  } finally {
    mock.timers.reset();
  }
});

test('FSC refuses to call with NODE_DEBUG set, TLS verification off or no key', async () => {
  for (const [env, code] of [
    [{ KR_PRICE_API_KEY: DECODED, NODE_DEBUG: 'fetch' }, 'unsafe_env'],
    [{ KR_PRICE_API_KEY: DECODED, NODE_TLS_REJECT_UNAUTHORIZED: '0' }, 'unsafe_env'],
    [{ KR_PRICE_API_KEY: '   ' }, 'not_configured'],
  ] as const) {
    const fsc = harness(() => envelope([]), env);
    assert.equal((await fsc.provider.fetch(request(SAMSUNG), FAR)).code, code);
    assert.equal(fsc.requests.length, 0);
  }
  assert.equal(createFscPriceProvider({ KR_PRICE_API_KEY: ' ' }).configured, false);
  assert.equal(createFscPriceProvider({ KR_PRICE_API_KEY: DECODED }).configured, true);
});

test('FSC refuses an identity of another provider without a request', async () => {
  const fsc = harness(() => envelope([]));
  assert.equal((await fsc.provider.fetch(request(priceIdentity('nasdaq:AAPL')!), FAR)).code, 'identity_mismatch');
  assert.equal(fsc.requests.length, 0);
});
