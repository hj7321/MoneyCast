// Daily-price layer for history insights (plan ch. 5 "가격 데이터 규칙", step 4).
// Holds the instrument identities, the fetch ranges, the knowledge-time rules
// and the pure merge of fetched bars into the stored series. Invariants:
// - raw (FSC) series merge incrementally and the first stored value of a
//   session wins: a later revision is counted, never applied, so a replay sees
//   the price that was knowable when it was first stored;
// - adjusted (Massive) series are replaced over the fetched window; retained
//   older bars are rescaled only by the overlap ratio that nearly every
//   overlapping bar shares (within the provider's rounding), so an isolated
//   revision is simply taken from the provider; without such a ratio the
//   stored series stays unchanged;
// - a bar counts as known at its B-20 publication time only when the series'
//   first real fetch stored it and it was published before that fetch,
//   otherwise at the time it was first stored (a gap the provider fills later
//   was not known before); a missing bar is known to be missing only once a
//   successful fetch happened after its publication time (until then it is pending);
// - every function is pure and takes its clock as an argument; the adapters
//   (price-fsc.ts, price-massive.ts) import this module type-only.

import {
  addDays, CALENDAR_UNVERIFIED, localDate, sessionsAfter, sessionsBefore, zonedTimeToUtc, type Exchange, type Session,
} from './market-calendar.js';
import type { DailyBar } from './history-outcomes.js';
import { createFscPriceProvider } from './price-fsc.js';
import { createMassivePriceProvider } from './price-massive.js';

export type { DailyBar } from './history-outcomes.js';   // single source of the calculation bar
export type PriceProviderId = 'fsc' | 'massive';
export type PriceBarFlag = 'zero_open' | 'zero_volume' | 'out_of_range' | 'halt' | 'missing_field';

/** One validated regular-session bar as fetched (no bookkeeping yet). */
export interface FetchedBar {
  date: string;         // exchange-local session date
  open: number;         // 0 when missing (flagged missing_field and zero_open)
  high: number;         // 0 when missing
  low: number;          // 0 when missing
  close: number;        // always > 0 (a row without a positive close is dropped)
  volume: number;       // 0 when missing
  adjClose?: number;    // Massive only: equals close (the series is split-adjusted)
  base?: number;        // FSC only: clpr − vs when vs is a number and the result is > 0
  indexClose?: number;  // FSC KODEX 200 only: bssIdxClpr when > 0 (B-18, data checks only)
  flags?: PriceBarFlag[]; // omitted when empty; informational, B's isUsableBar decides use
}
export interface PriceBar extends FetchedBar {
  baseFactor?: number;    // FSC only: base / previous-session close (calendar session), set by mergePriceSeries
  firstFetchedAt: string; // ISO; when this session's bar was first stored
}
export interface PriceSeries {
  key: string; provider: PriceProviderId; providerSymbol: string;
  exchange: Exchange;                       // calendar used: 'KRX' | 'NASDAQ'
  currency: 'KRW' | 'USD';
  basis: 'raw' | 'split_adjusted';
  priceBasis: string;                       // identity.priceBasis when last stored
  forwardSince: string;                     // ISO receivedAt of the first successful fetch of this series
  lastSuccessAt: string;                    // ISO receivedAt of the latest successful fetch
  lastAttempt: { at: string; code: string };
  rebasedAt: string | null;                 // latest Massive basis change applied to retained bars
  bars: PriceBar[];                         // ascending, unique dates
}
export interface PriceIdentity {
  key: string;                              // series key in prices.json
  role: 'stock' | 'benchmark' | 'comparison';
  companyId: string | null;                 // stocks only
  provider: PriceProviderId;
  providerSymbol: string;                   // FSC srtnCd / Massive ticker
  instrument: 'stock' | 'etf';              // FSC endpoint choice
  exchange: Exchange;                       // calendar
  timeZone: 'Asia/Seoul' | 'America/New_York';
  currency: 'KRW' | 'USD';
  listing: 'KOSPI' | 'KRX' | 'NASDAQ' | 'NYSE Arca';
  isin: string | null;                      // FSC: must equal isinCd
  marketCategory: 'KOSPI' | null;           // FSC stocks: must equal mrktCtg
  benchmarkKey: string | null;              // stocks only
  comparisonKeys: string[];
  priceBasis: string;                       // 'fsc-raw-v1' | 'massive-split-v1'
  adjustment: 'raw' | 'split';              // HistorySources.price.adjustment
  sourceLabel: string;                      // HistorySources.price.label, ≤ 80 chars
  validFrom: string;                        // inclusive
  validTo: string | null;                   // inclusive; null = open
}
export interface PriceFetchRequest { identity: PriceIdentity; from: string; to: string } // inclusive local dates
export type PriceFetchCode = 'ok' | 'not_configured' | 'unsafe_env' | 'stopped' | 'skipped_budget' | 'timeout' | 'network'
  | 'too_large' | 'echoed_secret' | 'bad_json' | 'provider_error' | 'truncated' | 'identity_mismatch' | 'calendar_mismatch'
  | 'duplicate_dates' | 'not_adjusted' | 'bad_timestamp' | `http_${number}`;
export interface PriceFetchResult {
  key: string;
  code: PriceFetchCode;
  providerCode: string | null;  // sanitized token only, e.g. 'resultCode:00', 'fsc_result:22', 'xml_error:…', 'status:OK'
  bars: FetchedBar[];           // ascending unique dates; [] unless code === 'ok'
  counts: { rows: number; kept: number; otherCodes: number; nonSession: number; unverifiedDate: number;
            notClosed: number; outsideValidity: number; malformed: number; duplicates: number; flagged: number };
  attemptedAt: string;          // ISO, when fetch() was called
  receivedAt: string | null;    // ISO, when the body was fully read (null without a response)
  ms: number;
}
export interface PriceProvider {
  readonly id: PriceProviderId;
  readonly configured: boolean;                      // key present and non-empty after trim
  fetch(request: PriceFetchRequest, deadlineMs: number): Promise<PriceFetchResult>; // never throws, no retries
}
export interface PriceProviderDeps { fetcher?: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void>; env?: never }
export interface PriceMergeResult {
  series: PriceSeries | null;  // null only when nothing was stored and the fetch failed
  changed: boolean;            // true for every successful fetch (lastSuccessAt moves), and for any bar change
  code: PriceFetchCode | 'inconsistent_adjustment';
  newBars: number; revisedIgnored: number; rebasedBy: number | null; droppedUnverifiable: number;
}

// PriceBar must stay usable wherever the calculation takes a DailyBar.
const _barIsDailyBar: DailyBar = {} as PriceBar; void _barIsDailyBar;

export const PRICE_KEY_ENV: Readonly<Record<PriceProviderId, string>> = { fsc: 'KR_PRICE_API_KEY', massive: 'US_PRICE_API_KEY' };
export const KRX_HISTORY_FROM = '2023-01-01';   // A-18, KRX calendar coverage start
export const MASSIVE_HISTORY_DAYS = 729;        // same window as the step-3 check
export const ADJUSTMENT_TOLERANCE = 1e-6;
/**
 * Share of overlapping bars that must agree on one stored-to-fetched ratio before retained adjusted bars are
 * linked to a fetch (one bar may always disagree). The rest are isolated provider revisions (a corrected
 * close), taken as fetched.
 */
export const LINK_SHARE = 0.95;
/** Relative tolerance of that agreement: the provider's rounding of adjusted prices after a split (3:1 at 4 decimals). */
export const LINK_TOLERANCE = 1e-4;
/** Days re-requested before the last stored FSC date, so the first new row finds its previous close. */
export const FSC_OVERLAP_DAYS = 7;

const KRX_LABEL = '금융위원회 주식시세정보·증권상품시세정보(공공데이터포털)';
const US_LABEL = 'Massive(구 Polygon) 일봉';
const VALID_FROM = '2020-01-02';

function krx(code: string, isin: string, role: 'stock' | 'benchmark'): PriceIdentity {
  const stock = role === 'stock';
  return {
    key: `krx:${code}`, role, companyId: stock ? `krx:${code}` : null, provider: 'fsc', providerSymbol: code,
    instrument: stock ? 'stock' : 'etf', exchange: 'KRX', timeZone: 'Asia/Seoul', currency: 'KRW', listing: stock ? 'KOSPI' : 'KRX',
    isin, marketCategory: stock ? 'KOSPI' : null, benchmarkKey: stock ? 'krx:069500' : null, comparisonKeys: [],
    priceBasis: 'fsc-raw-v1', adjustment: 'raw', sourceLabel: KRX_LABEL, validFrom: VALID_FROM, validTo: null,
  };
}
function us(key: string, symbol: string, role: PriceIdentity['role'], instrument: 'stock' | 'etf', listing: 'NASDAQ' | 'NYSE Arca'): PriceIdentity {
  const stock = role === 'stock';
  return {
    key, role, companyId: stock ? key : null, provider: 'massive', providerSymbol: symbol, instrument,
    // SPY trades on NYSE Arca, which keeps the Nasdaq holidays and regular hours (verified session for session in step 3).
    exchange: 'NASDAQ', timeZone: 'America/New_York', currency: 'USD', listing, isin: null, marketCategory: null,
    benchmarkKey: stock ? 'arca:SPY' : null, comparisonKeys: stock ? ['nasdaq:QQQ'] : [],
    priceBasis: 'massive-split-v1', adjustment: 'split', sourceLabel: US_LABEL, validFrom: VALID_FROM, validTo: null,
  };
}

/** Every priced instrument. Preferred shares and ADRs are never listed. */
export const PRICE_IDENTITY: readonly PriceIdentity[] = Object.freeze([
  krx('005930', 'KR7005930003', 'stock'),
  krx('000660', 'KR7000660001', 'stock'),
  krx('035420', 'KR7035420009', 'stock'),
  krx('005380', 'KR7005380001', 'stock'),
  krx('069500', 'KR7069500007', 'benchmark'),
  us('nasdaq:AAPL', 'AAPL', 'stock', 'stock', 'NASDAQ'),
  us('nasdaq:NVDA', 'NVDA', 'stock', 'stock', 'NASDAQ'),
  us('nasdaq:MSFT', 'MSFT', 'stock', 'stock', 'NASDAQ'),
  us('nasdaq:TSLA', 'TSLA', 'stock', 'stock', 'NASDAQ'),
  us('arca:SPY', 'SPY', 'benchmark', 'etf', 'NYSE Arca'),
  us('nasdaq:QQQ', 'QQQ', 'comparison', 'etf', 'NASDAQ'),
].map(identity => Object.freeze({ ...identity, comparisonKeys: Object.freeze([...identity.comparisonKeys]) as string[] })));

/** Benchmark first, comparison last: a budget cut drops the least important symbol. */
export const FETCH_ORDER: Readonly<Record<PriceProviderId, readonly string[]>> = Object.freeze({
  fsc: Object.freeze(['krx:069500', 'krx:005930', 'krx:000660', 'krx:035420', 'krx:005380']),
  massive: Object.freeze(['arca:SPY', 'nasdaq:AAPL', 'nasdaq:NVDA', 'nasdaq:MSFT', 'nasdaq:TSLA', 'nasdaq:QQQ']),
});

const BY_KEY = new Map(PRICE_IDENTITY.map(identity => [identity.key, identity]));

export function priceIdentity(key: string): PriceIdentity | undefined {
  return BY_KEY.get(key);
}

export function companyPriceIdentities(companyId: string): { stock: PriceIdentity; benchmark: PriceIdentity; comparisons: PriceIdentity[] } | null {
  const stock = PRICE_IDENTITY.find(identity => identity.role === 'stock' && identity.companyId === companyId);
  const benchmark = stock?.benchmarkKey ? BY_KEY.get(stock.benchmarkKey) : undefined;
  if (!stock || !benchmark) return null;
  return { stock, benchmark, comparisons: stock.comparisonKeys.flatMap(key => BY_KEY.get(key) ?? []) };
}

// ---------------------------------------------------------------- ranges and knowledge time

/** Inclusive exchange-local dates to request: FSC incrementally with a 7-day overlap, Massive its full adjusted window. */
export function fetchRange(identity: PriceIdentity, stored: PriceSeries | null, nowMs: number): { from: string; to: string } {
  if (identity.provider === 'fsc') {
    const to = localDate(identity.exchange, nowMs);
    const last = stored?.bars.length ? stored.bars[stored.bars.length - 1]!.date : null;
    const overlap = last ? addDays(last, -FSC_OVERLAP_DAYS) : KRX_HISTORY_FROM;
    return { from: overlap > KRX_HISTORY_FROM ? overlap : KRX_HISTORY_FROM, to };
  }
  const etToday = localDate(identity.exchange, nowMs);
  return { from: addDays(etToday, -MASSIVE_HISTORY_DAYS), to: addDays(etToday, -1) };
}

function publicationOfDate(identity: PriceIdentity, date: string): number | null {
  if (identity.provider === 'fsc') {
    const next = sessionsAfter(identity.exchange, date, 1);
    return next === CALENDAR_UNVERIFIED || !next.length ? null : zonedTimeToUtc(next[0]!.date, '13:00', 'Asia/Seoul');
  }
  return zonedTimeToUtc(addDays(date, 1), '00:00', 'America/New_York');
}

/**
 * B-20: an FSC bar is published at 13:00 KST on the next KRX session (null when that session lies outside the
 * calendar), a Massive bar at 00:00 ET on the next calendar day.
 */
export function publicationMs(identity: PriceIdentity, session: Session): number | null {
  return publicationOfDate(identity, session.date);
}

function barKnownAtMs(series: PriceSeries, identity: PriceIdentity, bar: PriceBar): number {
  const pub = publicationOfDate(identity, bar.date);
  const forwardSince = Date.parse(series.forwardSince);
  const first = Date.parse(bar.firstFetchedAt);
  // Stored by the series' first real fetch and published before it: a backfilled bar, known from its publication time.
  // A bar first stored by a later fetch (a gap the provider filled afterwards) was not known before it was stored,
  // whenever it was published: an earlier clock must not see it.
  if (pub !== null && pub < forwardSince && first <= forwardSince) return pub;
  return Number.isFinite(first) ? first : Number.POSITIVE_INFINITY;
}

/** When each session's bar became knowable (+∞ = still pending); see the header for the rules. */
export function barAvailability(series: PriceSeries | null, identity: PriceIdentity): (session: Session) => number {
  if (!series) return () => Number.POSITIVE_INFINITY;
  const bars = new Map(series.bars.map(bar => [bar.date, bar]));
  const lastSuccess = Date.parse(series.lastSuccessAt);
  return session => {
    const bar = bars.get(session.date);
    if (bar) return barKnownAtMs(series, identity, bar);
    const pub = publicationMs(identity, session);
    // Missing after a successful fetch that came after its publication: known to be missing (a price gap).
    return pub !== null && pub <= lastSuccess ? pub : Number.POSITIVE_INFINITY;
  };
}

/** The latest stored bar date knowable at `nowMs`. */
export function lastAvailableDate(series: PriceSeries | null, identity: PriceIdentity, nowMs: number): string | null {
  if (!series) return null;
  for (let index = series.bars.length - 1; index >= 0; index -= 1) {
    const bar = series.bars[index]!;
    if (barKnownAtMs(series, identity, bar) <= nowMs) return bar.date;
  }
  return null;
}

// ---------------------------------------------------------------- merge

const positive = (value: number | undefined): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

/** baseFactor = base / previous calendar session's close, recomputed for every bar (undefined without both). */
export function withBaseFactors(bars: readonly PriceBar[], exchange: Exchange): PriceBar[] {
  const byDate = new Map(bars.map(bar => [bar.date, bar]));
  return bars.map(bar => {
    const { baseFactor: _previous, ...rest } = bar;
    if (!positive(bar.base)) return rest;
    const before = sessionsBefore(exchange, bar.date, 1);
    const previous = before === CALENDAR_UNVERIFIED || !before.length ? undefined : byDate.get(before[0]!.date);
    if (!previous || !positive(previous.close)) return rest;
    const factor = bar.base / previous.close;
    return Number.isFinite(factor) && factor > 0 ? { ...rest, baseFactor: factor } : rest;
  });
}

const RAW_FIELDS = ['open', 'high', 'low', 'close', 'volume', 'base', 'indexClose'] as const;
const byDateAsc = (a: { date: string }, b: { date: string }) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0;

/**
 * The ratio linking stored adjusted closes to fetched ones: the median, when all but max(1, 5 %) of the ratios
 * lie within LINK_TOLERANCE of it (1 when it is within ADJUSTMENT_TOLERANCE of 1), else null. A new split moves
 * every ratio together; a corrected close moves one; anything else has no common ratio.
 */
export function linkRatio(ratios: readonly number[]): number | null {
  if (!ratios.length || !ratios.every(ratio => Number.isFinite(ratio) && ratio > 0)) return null;
  const sorted = [...ratios].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const k = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  const agreeing = ratios.filter(ratio => Math.abs(ratio / k - 1) <= LINK_TOLERANCE).length;
  const outliers = Math.max(1, Math.floor((1 - LINK_SHARE) * ratios.length));
  if (agreeing < ratios.length - outliers) return null;
  return Math.abs(k - 1) <= ADJUSTMENT_TOLERANCE ? 1 : k;
}

function stamp(bar: FetchedBar, firstFetchedAt: string): PriceBar {
  return { ...bar, ...(bar.flags ? { flags: [...bar.flags] } : {}), firstFetchedAt };
}

function rescale(bar: PriceBar, k: number): PriceBar {
  return {
    ...bar, open: bar.open * k, high: bar.high * k, low: bar.low * k, close: bar.close * k, volume: bar.volume / k,
    ...(bar.adjClose !== undefined ? { adjClose: bar.adjClose * k } : {}),
  };
}

/** Merges one fetch result into the stored series (pure; the stored series is never mutated). */
export function mergePriceSeries(stored: PriceSeries | null, identity: PriceIdentity, fetched: PriceFetchResult): PriceMergeResult {
  const none = { newBars: 0, revisedIgnored: 0, rebasedBy: null, droppedUnverifiable: 0 };
  if (fetched.code !== 'ok') {
    return { series: stored ? { ...stored, lastAttempt: { at: fetched.attemptedAt, code: fetched.code } } : null, changed: false,
      code: fetched.code, ...none };
  }
  const receivedAt = fetched.receivedAt ?? fetched.attemptedAt;
  const raw = identity.provider === 'fsc';
  const base: PriceSeries = stored ?? {
    key: identity.key, provider: identity.provider, providerSymbol: identity.providerSymbol, exchange: identity.exchange,
    currency: identity.currency, basis: raw ? 'raw' : 'split_adjusted', priceBasis: identity.priceBasis,
    forwardSince: receivedAt, lastSuccessAt: receivedAt, lastAttempt: { at: receivedAt, code: 'ok' }, rebasedAt: null, bars: [],
  };
  const storedByDate = new Map(base.bars.map(bar => [bar.date, bar]));
  let newBars = 0;
  let revisedIgnored = 0;
  let rebasedBy: number | null = null;
  let droppedUnverifiable = 0;
  let rebasedAt = base.rebasedAt;
  let bars: PriceBar[];
  if (raw) {
    // First value wins: a stored session keeps its stored values; a differing re-fetch is only counted.
    bars = [...base.bars];
    for (const bar of fetched.bars) {
      const old = storedByDate.get(bar.date);
      if (!old) { bars.push(stamp(bar, receivedAt)); newBars += 1; continue; }
      if (RAW_FIELDS.some(field => old[field] !== bar[field])) revisedIgnored += 1;
    }
  } else if (!fetched.bars.length) {
    bars = [...base.bars];
  } else {
    const overlap = fetched.bars.filter(bar => storedByDate.has(bar.date));
    // A single corrected close, or rounding after a 3:1 split, must not freeze the series for the two years
    // the corrected bar stays in the fetched window; only a fetch with no common ratio is refused.
    const k = overlap.length ? linkRatio(overlap.map(bar => bar.close / storedByDate.get(bar.date)!.close)) : 1;
    if (k === null) return { series: stored, changed: false, code: 'inconsistent_adjustment', ...none };
    const fetchedDates = new Set(fetched.bars.map(bar => bar.date));
    bars = fetched.bars.map(bar => {
      const old = storedByDate.get(bar.date);
      if (!old) newBars += 1;
      return stamp(bar, old?.firstFetchedAt ?? receivedAt);
    });
    const retained = base.bars.filter(bar => !fetchedDates.has(bar.date));
    if (!overlap.length) {
      // Nothing links the stored basis to the fetched one, so no retained bar can be verified.
      droppedUnverifiable = retained.length;
    } else if (k !== 1) {
      bars.push(...retained.map(bar => rescale(bar, k)));
      rebasedBy = k;
      rebasedAt = receivedAt;
    } else {
      bars.push(...retained);
    }
  }
  bars.sort(byDateAsc);
  if (raw) bars = withBaseFactors(bars, identity.exchange);
  const series: PriceSeries = {
    ...base, priceBasis: identity.priceBasis, lastSuccessAt: receivedAt, lastAttempt: { at: receivedAt, code: 'ok' }, rebasedAt, bars,
  };
  return { series, changed: true, code: 'ok', newBars, revisedIgnored, rebasedBy, droppedUnverifiable };
}

// ---------------------------------------------------------------- providers

/** Fresh provider instances (pacing, request caps and stop state live per instance, so build one set per run). */
export function createPriceProviders(env: Readonly<Record<string, string | undefined>>, deps: PriceProviderDeps = {}): Record<PriceProviderId, PriceProvider> {
  return { fsc: createFscPriceProvider(env, deps), massive: createMassivePriceProvider(env, deps) };
}
