// US daily prices from Massive (formerly Polygon) aggregates, split-adjusted (B-17).
// Invariants:
// - the key travels only in the Authorization: Bearer header to the fixed
//   origin, never in the URL; it never appears in a result, and a response that
//   echoes it is discarded unread;
// - one GET per fetch(): no retry, next_url is never followed, no redirect; at
//   least 13 s between request starts (≤ 5 per minute), a 20 s timeout, a 4 MiB
//   body cap and at most 8 requests per provider instance; a request starts
//   only when it can end by the caller's deadline;
// - 401 and 429 stop the instance for the rest of the run (403 does not);
// - the response must name the requested ticker and be adjusted; every bar's t
//   must be exactly 00:00 ET of its session date, and a weekend or holiday bar
//   rejects the whole response;
// - adjClose = close: the series is the provider's split-adjusted one.

import { CALENDAR_UNVERIFIED, inCoverage, localDate, sessionOn, zonedTimeToUtc } from './market-calendar.js';
import type { FetchedBar, PriceBarFlag, PriceFetchCode, PriceFetchRequest, PriceFetchResult, PriceProvider, PriceProviderDeps } from './price-provider.js';
import { codeToken, createRedactor, createRequestGate, finite, instant, isRecord, keyedGet, unsafeNetworkEnv } from './price-wire.js';

export const MASSIVE_ORIGIN = 'https://api.massive.com';
export const MASSIVE_MIN_GAP_MS = 13_000;
export const MASSIVE_TIMEOUT_MS = 20_000;
export const MASSIVE_MAX_BODY = 4 * 1024 * 1024;
export const MASSIVE_REQUEST_CAP = 8;
const STOP_STATUSES = new Set([401, 429]);
const OK_STATUSES = new Set(['OK', 'DELAYED']);
const FLAG_ORDER: readonly PriceBarFlag[] = ['zero_open', 'zero_volume', 'out_of_range', 'halt', 'missing_field'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TICKER = /^[A-Z][A-Z0-9.]{0,9}$/;

type Counts = PriceFetchResult['counts'];
function emptyCounts(): Counts {
  return { rows: 0, kept: 0, otherCodes: 0, nonSession: 0, unverifiedDate: 0, notClosed: 0, outsideValidity: 0, malformed: 0, duplicates: 0, flagged: 0 };
}

/** The request URL (no key: the key goes only in the Authorization header). */
export function massiveRequestUrl(request: PriceFetchRequest): string {
  const { identity, from, to } = request;
  return `${MASSIVE_ORIGIN}/v2/aggs/ticker/${encodeURIComponent(identity.providerSymbol)}/range/1/day/${from}/${to}?adjusted=true&sort=asc&limit=50000`;
}

function massiveBar(date: string, row: Record<string, unknown>, close: number): FetchedBar {
  const [o, h, l, v] = [row.o, row.h, row.l, row.v].map(finite);
  const bar: FetchedBar = { date, open: o ?? 0, high: h ?? 0, low: l ?? 0, close, volume: v ?? 0, adjClose: close };
  const flags = new Set<PriceBarFlag>();
  if (o === null || h === null || l === null || v === null) flags.add('missing_field');
  if (bar.open <= 0) flags.add('zero_open');
  if (bar.volume <= 0) flags.add('zero_volume');
  if (bar.high > 0 && (bar.low > bar.high || bar.open < bar.low || bar.open > bar.high || close < bar.low || close > bar.high)) flags.add('out_of_range');
  if (flags.size) bar.flags = FLAG_ORDER.filter(flag => flags.has(flag));
  return bar;
}

export function createMassivePriceProvider(env: Readonly<Record<string, string | undefined>>, deps: PriceProviderDeps = {}): PriceProvider {
  const key = env.US_PRICE_API_KEY?.trim() ?? '';
  const fetcher = deps.fetcher ?? fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const redact = createRedactor([key]);
  const gate = createRequestGate({ minGapMs: MASSIVE_MIN_GAP_MS, timeoutMs: MASSIVE_TIMEOUT_MS, cap: MASSIVE_REQUEST_CAP, now, sleep });

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
    if (identity.provider !== 'massive' || !TICKER.test(identity.providerSymbol) || !DATE.test(request.from) || !DATE.test(request.to)) {
      return done('identity_mismatch');
    }
    if (gate.stopped) return done('stopped');
    if (await gate.admit(deadlineMs) !== 'ok') return done('skipped_budget');
    const started = now();
    const response = await keyedGet(fetcher, massiveRequestUrl(request), { Accept: 'application/json', Authorization: `Bearer ${key}` },
      { timeoutMs: MASSIVE_TIMEOUT_MS, maxBytes: MASSIVE_MAX_BODY, redact, now });
    ms = Math.max(0, now() - started);
    receivedAtMs = response.receivedAtMs;
    if (response.status !== null && STOP_STATUSES.has(response.status)) gate.stop();
    let json: unknown = null;
    if (response.text !== null) {
      try { json = JSON.parse(response.text); } catch { json = null; }
    }
    const status = isRecord(json) ? codeToken(json.status) : null;
    if (status) providerCode = `status:${status}`;
    if (response.code !== 'ok') return done(response.code);
    if (!isRecord(json)) return done('bad_json');
    if (!status || !OK_STATUSES.has(status)) return done('provider_error');
    if (json.ticker !== identity.providerSymbol) return done('identity_mismatch');
    if (json.adjusted !== true) return done('not_adjusted');
    if (json.results !== undefined && !Array.isArray(json.results)) return done('bad_json');
    const results: unknown[] = Array.isArray(json.results) ? json.results : [];
    const resultsCount = finite(json.resultsCount);
    counts.rows = results.length;
    if (typeof json.next_url === 'string' || (resultsCount !== null && resultsCount > results.length)) return done('truncated');
    const byDate = new Map<string, { bar: FetchedBar; json: string }>();
    for (const row of results) {
      if (!isRecord(row)) { counts.malformed += 1; continue; }
      const t = instant(row.t);
      if (t === null) return done('bad_timestamp');
      const date = localDate(identity.exchange, t);
      if (t !== zonedTimeToUtc(date, '00:00', 'America/New_York')) return done('bad_timestamp');
      const close = finite(row.c);
      if (close === null || close <= 0) { counts.malformed += 1; continue; }
      if (date < identity.validFrom || (identity.validTo !== null && date > identity.validTo)) { counts.outsideValidity += 1; continue; }
      if (!inCoverage(identity.exchange, date)) { counts.unverifiedDate += 1; continue; }
      const session = sessionOn(identity.exchange, date);
      if (session === CALENDAR_UNVERIFIED) { counts.unverifiedDate += 1; continue; }
      if (session === null) { counts.nonSession += 1; return done('calendar_mismatch'); }
      if (receivedAtMs === null || session.closeMs > receivedAtMs) { counts.notClosed += 1; continue; }
      const bar = massiveBar(date, row, close);
      const text = JSON.stringify(bar);
      const seen = byDate.get(date);
      if (seen) {
        if (seen.json !== text) return done('duplicate_dates');
        counts.duplicates += 1;
        continue;
      }
      byDate.set(date, { bar, json: text });
    }
    const bars = [...byDate.values()].map(item => item.bar).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    counts.flagged = bars.filter(bar => bar.flags).length;
    return done('ok', bars);
  }

  return {
    id: 'massive',
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
