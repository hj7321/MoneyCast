// Korean daily prices from data.go.kr (금융위원회 주식시세정보 / 증권상품시세정보).
// Invariants:
// - the key travels only as the serviceKey query parameter (encoded exactly
//   once) to the fixed origin; it never appears in a result, and a response
//   that echoes it is discarded unread;
// - one GET per fetch(): no retry, no second page, no redirect; at least 1 s
//   between request starts, a 20 s timeout, an 8 MiB body cap and at most 10
//   requests per provider instance; a request starts only when it can end by
//   the caller's deadline;
// - 401/403/429 and the gateway's key or limit codes stop the instance for the
//   rest of the run;
// - only rows of the exact code survive, and their ISIN, market and (KODEX 200)
//   underlying index must match the identity; a weekend or holiday row rejects
//   the whole response, because a misdated row makes every date suspect;
// - prices are raw (unadjusted); base = clpr − vs is kept for the base-price
//   factor (B-16, A-17) and bssIdxClpr only for data checks (B-18).

import { addDays, CALENDAR_UNVERIFIED, inCoverage, sessionOn } from './market-calendar.js';
import type { FetchedBar, PriceBarFlag, PriceFetchCode, PriceFetchRequest, PriceFetchResult, PriceProvider, PriceProviderDeps } from './price-provider.js';
import {
  createRedactor, createRequestGate, fscDate, fscQuery, isKospi200Name, keyedGet, parseFscBody, parseNum, unsafeNetworkEnv,
} from './price-wire.js';

export const FSC_ORIGIN = 'https://apis.data.go.kr';
export const FSC_PATHS = {
  stock: '/1160100/GetStockSecuritiesInfoService_V2/getStockPriceInfo_V2',
  etf: '/1160100/GetSecuritiesProductInfoService_V2/getETFPriceInfo_V2',
} as const;
export const FSC_ROWS = 3000;
export const FSC_MIN_GAP_MS = 1000;
export const FSC_TIMEOUT_MS = 20_000;
export const FSC_MAX_BODY = 8 * 1024 * 1024;
export const FSC_REQUEST_CAP = 10;
const STOP_STATUSES = new Set([401, 403, 429]);
const FLAG_ORDER: readonly PriceBarFlag[] = ['zero_open', 'zero_volume', 'out_of_range', 'halt', 'missing_field'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

type Row = Record<string, unknown>;
type Counts = PriceFetchResult['counts'];

const compact = (date: string) => date.replace(/-/g, '');
const text = (value: unknown) => typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';

function emptyCounts(): Counts {
  return { rows: 0, kept: 0, otherCodes: 0, nonSession: 0, unverifiedDate: 0, notClosed: 0, outsideValidity: 0, malformed: 0, duplicates: 0, flagged: 0 };
}

/** The request URL, key included; it is passed to the fetcher and nowhere else. */
export function fscRequestUrl(key: string, request: PriceFetchRequest): string {
  const { identity, from, to } = request;
  return `${FSC_ORIGIN}${FSC_PATHS[identity.instrument]}?${fscQuery(key, {
    likeSrtnCd: identity.providerSymbol, beginBasDt: compact(from), endBasDt: compact(addDays(to, 1)),
    numOfRows: String(FSC_ROWS), pageNo: '1', resultType: 'json',
  })}`;
}

/** Bar fields and informational flags of one FSC row with a positive close. */
function fscBar(date: string, row: Row, close: number, etf: boolean): FetchedBar {
  const [mkp, hipr, lopr, vs, trqu, index] = ['mkp', 'hipr', 'lopr', 'vs', 'trqu', 'bssIdxClpr'].map(field => parseNum(row[field]));
  const bar: FetchedBar = { date, open: mkp ?? 0, high: hipr ?? 0, low: lopr ?? 0, close, volume: trqu ?? 0 };
  const flags = new Set<PriceBarFlag>();
  if (mkp === null || hipr === null || lopr === null || trqu === null) flags.add('missing_field');
  if (mkp === 0 && hipr === 0 && lopr === 0) flags.add('halt');
  if (bar.open <= 0) flags.add('zero_open');
  if (bar.volume <= 0) flags.add('zero_volume');
  if (bar.high > 0 && (bar.low > bar.high || bar.open < bar.low || bar.open > bar.high || close < bar.low || close > bar.high)) flags.add('out_of_range');
  if (vs !== null) {
    const base = close - vs;
    if (Number.isFinite(base) && base > 0) bar.base = base;
  }
  if (etf && index !== null && index > 0) bar.indexClose = index;
  if (flags.size) bar.flags = FLAG_ORDER.filter(flag => flags.has(flag));
  return bar;
}

export function createFscPriceProvider(env: Readonly<Record<string, string | undefined>>, deps: PriceProviderDeps = {}): PriceProvider {
  const key = env.KR_PRICE_API_KEY?.trim() ?? '';
  const fetcher = deps.fetcher ?? fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const redact = createRedactor([key]);
  const gate = createRequestGate({ minGapMs: FSC_MIN_GAP_MS, timeoutMs: FSC_TIMEOUT_MS, cap: FSC_REQUEST_CAP, now, sleep });

  async function run(request: PriceFetchRequest, deadlineMs: number, attemptedAtMs: number): Promise<PriceFetchResult> {
    const { identity } = request;
    const counts = emptyCounts();
    let providerCode: string | null = null;
    let receivedAtMs: number | null = null;
    let ms = 0;
    const done = (code: PriceFetchCode, bars: FetchedBar[] = []): PriceFetchResult => ({
      key: identity.key, code, providerCode, bars: code === 'ok' ? bars : [], counts: { ...counts, kept: code === 'ok' ? bars.length : 0 },
      attemptedAt: new Date(attemptedAtMs).toISOString(), receivedAt: receivedAtMs === null ? null : new Date(receivedAtMs).toISOString(), ms,
    });
    if (!key) return done('not_configured');
    if (unsafeNetworkEnv(env)) return done('unsafe_env');
    if (identity.provider !== 'fsc' || !DATE.test(request.from) || !DATE.test(request.to)) return done('identity_mismatch');
    if (gate.stopped) return done('stopped');
    if (await gate.admit(deadlineMs) !== 'ok') return done('skipped_budget');
    const started = now();
    const response = await keyedGet(fetcher, fscRequestUrl(key, request), { Accept: 'application/json' },
      { timeoutMs: FSC_TIMEOUT_MS, maxBytes: FSC_MAX_BODY, redact, now });
    ms = Math.max(0, now() - started);
    receivedAtMs = response.receivedAtMs;
    if (response.status !== null && STOP_STATUSES.has(response.status)) gate.stop();
    if (response.code !== 'ok') {
      // An error body can still carry the gateway code (and a stop code); only its token is kept.
      if (response.text !== null) {
        const parsed = parseFscBody(response.text);
        if (!parsed.ok) { providerCode = parsed.code; if (parsed.stop) gate.stop(); }
      }
      return done(response.code);
    }
    const parsed = parseFscBody(response.text ?? '');
    if (!parsed.ok) {
      providerCode = parsed.code;
      if (parsed.stop) gate.stop();
      return done('provider_error');
    }
    providerCode = `resultCode:${parsed.resultCode}`;
    counts.rows = parsed.items.length;
    if (parsed.totalCount !== null && parsed.totalCount > parsed.items.length) return done('truncated');
    const symbol = identity.providerSymbol;
    const mine = parsed.items.filter(row => text(row.srtnCd) === symbol);
    counts.otherCodes = parsed.items.length - mine.length;
    for (const row of mine) {
      if (text(row.isinCd) !== identity.isin) return done('identity_mismatch');
      if (identity.instrument === 'stock' && text(row.mrktCtg) !== identity.marketCategory) return done('identity_mismatch');
      if (identity.instrument === 'etf') {
        const name = row.bssIdxIdxNm;
        if (name !== undefined && name !== null && name !== '' && !isKospi200Name(name)) return done('identity_mismatch');
      }
    }
    const byDate = new Map<string, { bar: FetchedBar; json: string }>();
    for (const row of mine) {
      const date = fscDate(row.basDt);
      const close = parseNum(row.clpr);
      if (!date || close === null || close <= 0) { counts.malformed += 1; continue; }
      if (date < identity.validFrom || (identity.validTo !== null && date > identity.validTo)) { counts.outsideValidity += 1; continue; }
      if (!inCoverage(identity.exchange, date)) { counts.unverifiedDate += 1; continue; }
      const session = sessionOn(identity.exchange, date);
      if (session === CALENDAR_UNVERIFIED) { counts.unverifiedDate += 1; continue; }
      if (session === null) { counts.nonSession += 1; return done('calendar_mismatch'); }
      if (receivedAtMs === null || session.closeMs > receivedAtMs) { counts.notClosed += 1; continue; }
      const bar = fscBar(date, row, close, identity.instrument === 'etf');
      const json = JSON.stringify(bar);
      const seen = byDate.get(date);
      if (seen) {
        if (seen.json !== json) return done('duplicate_dates');
        counts.duplicates += 1;
        continue;
      }
      byDate.set(date, { bar, json });
    }
    const bars = [...byDate.values()].map(item => item.bar).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    counts.flagged = bars.filter(bar => bar.flags).length;
    return done('ok', bars);
  }

  return {
    id: 'fsc',
    configured: key !== '',
    fetch(request, deadlineMs) {
      const attemptedAtMs = now();
      return gate.serialize(() => run(request, deadlineMs, attemptedAtMs)).catch(() => ({
        // Unreachable by design; a fixed code keeps the never-throws contract without reading the error.
        key: request.identity.key, code: 'provider_error' as const, providerCode: 'internal_error', bars: [], counts: emptyCounts(),
        attemptedAt: new Date(attemptedAtMs).toISOString(), receivedAt: null, ms: 0,
      }));
    },
  };
}
