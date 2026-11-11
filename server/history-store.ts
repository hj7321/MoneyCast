import { BlobError, BlobNotFoundError, BlobPreconditionFailedError, BlobRequestAbortedError, get, put } from '@vercel/blob';
import {
  NEWS_HISTORY_VERSION, integrateOutlook, isNewsTopicKey, parseCompanyHistory,
  type HistoryReadyStatus, type Horizon, type IntegrationNote, type NewsAnalysis, type OvernightEvidence, type OvernightReason,
  type Signal, type Verdict,
} from '../packages/core/src/index.js';
import type { LedgerEntry } from './history-ledger.js';
import type { NextDayOutcome, WeeklyOutcome } from './history-outcomes.js';
import type { CompanyStats } from './history-stats.js';
import type { CalendarBasis, Exchange, SessionPhase } from './market-calendar.js';

// Private storage for historical news insights (step 4, spec ch. 4).
// Invariants:
// - Everything lives under news-history/v1/, private, never with a random suffix.
// - Construction does no I/O. Every Blob call carries a 20 s abort signal.
// - Reads are bounded at 5 MiB while streaming; writes are checked before put,
//   and a too_large or invalid value never reaches put.
// - A file that fails its version or shape check is rejected as a whole. A ledger
//   segment with one bad entry is invalid: dropping it silently would delete it
//   for good on the next rewrite.
// - Errors carry a fixed code and the file name only, never provider text.
// - Parsers take `unknown` and cast at the end, so this file compiles against the
//   calculation types before and after their step-4 changes.

export const HISTORY_PREFIX = 'news-history/v1/';
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const STORE_TIMEOUT_MS = 20_000;
export const HISTORY_VERSIONS = {
  stats: 'news-history-stats-v1', prices: 'news-history-prices-v1', ledger: 'news-history-ledger-v1',
  outcomes: 'news-history-outcomes-v1', shadow: 'news-history-shadow-v1',
} as const;
/** Reserved for step 8 (backfill): no read or write method in step 4. */
export const LEDGER_BACKFILL_FILE = 'ledger-backfill.json';
export const STATS_FILE = 'stats.json';
export const PRICES_FILE = 'prices.json';

export const MAX_LEDGER_ENTRIES = 50_000;
export const MAX_RECORDS = 20_000;
export const MAX_GAPS_PER_COMPANY = 500;
export const MAX_DIRECTORY = 2_000;
export const MAX_BARS_PER_SERIES = 20_000;
const MAX_SHARDS_PER_MONTH = 999;
const MAX_MAP_KEYS = 200;
const MAX_LABELS = 100;

// ---------------------------------------------------------------------------
// File formats
// ---------------------------------------------------------------------------

export interface StatsFile {
  version: typeof HISTORY_VERSIONS.stats;
  computedAt: string;
  runId: string;
  /** key === CompanyStats.companyId */
  companies: Record<string, CompanyStats>;
  /** Companies copied unchanged from the previous file. */
  carriedOver: string[];
}

export type PriceBarFlagName = 'zero_open' | 'zero_volume' | 'out_of_range' | 'halt' | 'missing_field';
export interface StoredPriceBar {
  date: string; open: number; high: number; low: number; close: number; volume: number;
  adjClose?: number; base?: number; baseFactor?: number; indexClose?: number; flags?: PriceBarFlagName[]; firstFetchedAt: string;
}
/** Field for field equal to price-provider's PriceSeries. */
export interface StoredPriceSeries {
  key: string; provider: 'fsc' | 'massive'; providerSymbol: string; exchange: 'KRX' | 'NASDAQ';
  currency: 'KRW' | 'USD'; basis: 'raw' | 'split_adjusted'; priceBasis: string; forwardSince: string; lastSuccessAt: string;
  lastAttempt: { at: string; code: string }; rebasedAt: string | null; bars: StoredPriceBar[];
}
export interface PricesFile { version: typeof HISTORY_VERSIONS.prices; writtenAt: string; series: Record<string, StoredPriceSeries> }

export interface FrozenWeeklyRecord { companyId: string; weekAsOf: string; frozenAt: string; priceBasisVersion: string; outcome: WeeklyOutcome }
export interface FrozenDailyRecord { companyId: string; sessionDate: string; frozenAt: string; priceBasisVersion: string; outcome: NextDayOutcome }
/** year = KST year in which the records were frozen (the run's year), not the session's year. */
export interface WeeklyOutcomesFile { version: typeof HISTORY_VERSIONS.outcomes; kind: 'weekly'; year: number; writtenAt: string; records: FrozenWeeklyRecord[] }
export interface DailyOutcomesFile { version: typeof HISTORY_VERSIONS.outcomes; kind: 'daily'; year: number; writtenAt: string; records: FrozenDailyRecord[] }

export interface ShadowRecord {
  /** KST date of recordedAt; (recordDate, companyId, horizon) is unique, first record wins. */
  recordDate: string;
  recordedAt: string; companyId: string; horizon: Horizon; exchange: Exchange;
  target: { start: string; end: string; basis: CalendarBasis; phase: SessionPhase };
  /** day only */
  newsWindow: { start: string; end: string } | null;
  snapshot: { asOf: string; knownAt: string; analysisVersion: string; status: NewsAnalysis['status']; partial: boolean } | null;
  /** snapshot.updatedAt equals the previous record's knownAt (same company, horizon). */
  stale: boolean;
  /** withheld when snapshot is null */
  baseline: Signal;
  /** day only */
  overnight: { reason: OvernightReason; evidence: OvernightEvidence; counts: { positive: number; negative: number; neutral: number; ignored: number } } | null;
  statsStatus: HistoryReadyStatus | 'missing'; statsComputedAt: string | null;
  /** null when the baseline is withheld or directions are null */
  verdict: Verdict | null;
  integrated: Signal; changed: boolean; note: IntegrationNote;
}
export interface ShadowFile { version: typeof HISTORY_VERSIONS.shadow; year: number; writtenAt: string; records: ShadowRecord[] }

/** [start, end), unobserved. */
export interface ObservationGap { start: string; end: string; detectedAt: string }
export interface ObservationRecord { observedFrom: string; lastSnapshotAt: string; gaps: ObservationGap[] }
export interface WriteJournal { kstDate: string; writes: number; fullDone: boolean }
export interface LedgerState {
  /** First ledger write ever; first year of the outcome files. */
  createdAt: string;
  /** Every segment id in fold order; the last one is this file's own segment. */
  directory: string[];
  observations: Record<string, ObservationRecord>;
  /** Daily write cap; authoritative only in the head. */
  journal: WriteJournal;
  /** runId of the run that wrote this file. */
  writeToken: string;
}
export interface LedgerSegmentFile { version: typeof HISTORY_VERSIONS.ledger; segment: string; writtenAt: string; state: LedgerState; entries: LedgerEntry[] }

// ---------------------------------------------------------------------------
// Names and helpers
// ---------------------------------------------------------------------------

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

function checkMonth(month: string): [number, number] {
  const match = MONTH.exec(month);
  if (!match) throw new RangeError(`invalid month ${month}`);
  return [Number(match[1]), Number(match[2])];
}

/** Shard 0 → 'YYYY-MM', else 'YYYY-MM.N'. */
export function ledgerSegmentId(month: string, shard: number): string {
  checkMonth(month);
  if (!Number.isSafeInteger(shard) || shard < 0 || shard > MAX_SHARDS_PER_MONTH) throw new RangeError(`invalid shard ${shard}`);
  return shard === 0 ? month : `${month}.${shard}`;
}

/** Canonical ids only: no 'YYYY-MM.0', no leading zeros. */
export function parseLedgerSegmentId(id: string): { month: string; shard: number } | null {
  if (typeof id !== 'string') return null;
  const match = /^(\d{4}-(?:0[1-9]|1[0-2]))(?:\.([1-9]\d{0,2}))?$/.exec(id);
  if (!match) return null;
  return { month: match[1]!, shard: match[2] === undefined ? 0 : Number(match[2]) };
}

/** Month, then shard. Throws RangeError on a non-canonical id. */
export function compareLedgerSegmentIds(a: string, b: string): number {
  const left = parseLedgerSegmentId(a);
  const right = parseLedgerSegmentId(b);
  if (!left || !right) throw new RangeError('invalid ledger segment id');
  return left.month < right.month ? -1 : left.month > right.month ? 1 : left.shard - right.shard;
}

export function addMonths(month: string, n: number): string {
  const [year, value] = checkMonth(month);
  if (!Number.isSafeInteger(n)) throw new RangeError(`invalid month offset ${n}`);
  const index = year * 12 + (value - 1) + n;
  const nextYear = Math.floor(index / 12);
  if (nextYear < 0 || nextYear > 9999) throw new RangeError('month out of range');
  return `${String(nextYear).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/** UTF-8 bytes of JSON.stringify(value); 0 when nothing serializes. */
export function jsonByteLength(value: unknown): number {
  const json = JSON.stringify(value) as string | undefined;
  return json === undefined ? 0 : Buffer.byteLength(json, 'utf8');
}

const ledgerFile = (id: string) => `ledger/${id}.json`;
const yearFile = (kind: 'weekly' | 'daily' | 'shadow', year: number) => `${kind}/${year}.json`;
const isYear = (year: unknown): year is number => typeof year === 'number' && Number.isSafeInteger(year) && year >= 2000 && year <= 9999;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type HistoryStoreErrorCode = 'unreadable' | 'timeout' | 'too_large' | 'invalid' | 'unsupported_version' | 'conflict' | 'write_failed';

/** message = code; provider text never passes through. */
export class HistoryStoreError extends Error {
  readonly code: HistoryStoreErrorCode;
  readonly file: string;

  constructor(code: HistoryStoreErrorCode, file: string) {
    super(code);
    this.name = 'HistoryStoreError';
    this.code = code;
    this.file = file;
  }
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; code: 'invalid' | 'unsupported_version' };

/** Thrown inside a parser to reject the whole file; caught at the parser boundary. */
class Reject extends Error {}
const fail = (): never => { throw new Reject('invalid'); };
function check(condition: boolean): asserts condition { if (!condition) fail(); }

function boundary<T>(value: unknown, version: string, build: (record: Record<string, unknown>) => T): ParseResult<T> {
  if (!isRecord(value)) return { ok: false, code: 'invalid' };
  if (value.version !== version) return { ok: false, code: typeof value.version === 'string' ? 'unsupported_version' : 'invalid' };
  try {
    return { ok: true, value: build(value) };
  } catch (error) {
    if (error instanceof Reject || error instanceof RangeError) return { ok: false, code: 'invalid' };
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Shape checks
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isBool = (value: unknown): value is boolean => typeof value === 'boolean';

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!;
}

/** Stored instants are written as toISOString(); anything else is rejected. */
function isInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function text(value: unknown, max: number, min = 1): string {
  check(typeof value === 'string' && value.length >= min && value.length <= max);
  return value as string;
}
function textOrNull(value: unknown, max: number): string | null {
  return value === null ? null : text(value, max);
}
function instant(value: unknown): string { check(isInstant(value)); return value as string; }
function instantOrNull(value: unknown): string | null { return value === null ? null : instant(value); }
function date(value: unknown): string { check(isCalendarDate(value)); return value as string; }
function count(value: unknown): number { check(isCount(value)); return value as number; }
function bool(value: unknown): boolean { check(isBool(value)); return value as boolean; }
function finite(value: unknown, min = -Infinity): number { check(isFiniteNumber(value) && value >= min); return value as number; }
function finiteOrNull(value: unknown, min = -Infinity): number | null { return value === null ? null : finite(value, min); }
function record(value: unknown): Record<string, unknown> { check(isRecord(value)); return value as Record<string, unknown>; }
function list(value: unknown, max: number): unknown[] { check(Array.isArray(value) && value.length <= max); return value as unknown[]; }
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  check(typeof value === 'string' && (allowed as readonly string[]).includes(value));
  return value as T;
}
function oneOfOrNull<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return value === null ? null : oneOf(value, allowed);
}
function texts(value: unknown, maxItems: number, maxLength: number): string[] {
  return list(value, maxItems).map(item => text(item, maxLength));
}

const HOSTILE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** A prototype-free map; hostile or malformed keys reject the file. */
function map<T>(value: unknown, maxKeys: number, parseEntry: (key: string, item: unknown) => T): Record<string, T> {
  const source = record(value);
  const keys = Object.keys(source);
  check(keys.length <= maxKeys);
  const result = Object.create(null) as Record<string, T>;
  for (const key of keys) {
    check(!HOSTILE_KEYS.has(key) && key.length >= 1 && key.length <= 40);
    result[key] = parseEntry(key, source[key]);
  }
  return result;
}

function ascendingDates(dates: readonly string[]): boolean {
  for (let i = 1; i < dates.length; i += 1) if (!(dates[i - 1]! < dates[i]!)) return false;
  return true;
}

/** KST has had no daylight saving time since 1988: a fixed +09:00 offset. */
const kstDateOf = (instantText: string): string => new Date(Date.parse(instantText) + 9 * 3_600_000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// stats.json
// ---------------------------------------------------------------------------

const EXCHANGES = ['KRX', 'NASDAQ'] as const;
const PROBE_VALIDATION = { status: 'not_evaluated', directions: [], markets: [], evaluatedAt: null } as const;
const PROBE_DAY_TARGET = { start: '2026-01-05', end: '2026-01-05', basis: 'exchange_calendar', exchange: 'KRX', phase: 'before_open' } as const;
const PROBE_DAY_NEWS = { start: '2026-01-04T06:30:00.000Z', end: '2026-01-05T00:00:00.000Z' } as const;
const PROBE_WEEK_TARGET = { start: '2026-01-05', end: '2026-01-09', basis: 'exchange_calendar', exchange: 'KRX', phase: 'before_open' } as const;

/** One company's statistics, validated by the contract parser on a fixed probe so no number escapes its checks. */
function parseCompanyStats(key: string, value: unknown): CompanyStats {
  const source = record(value);
  check(source.companyId === key);
  const exchange = oneOf(source.exchange, EXCHANGES);
  const horizons = record(source.horizons);
  const day = record(horizons.day);
  const week = record(horizons.week);
  const dayUnits = count(day.timeUnverifiedUnits);
  const weekUnits = count(week.timeUnverifiedUnits);
  const parsed = parseCompanyHistory({
    version: source.version, companyId: source.companyId, status: source.status,
    horizons: {
      day: { validation: PROBE_VALIDATION, targetWindow: PROBE_DAY_TARGET, newsWindow: PROBE_DAY_NEWS, directions: day.directions },
      week: { validation: PROBE_VALIDATION, targetWindow: PROBE_WEEK_TARGET, newsWindow: null, directions: week.directions },
    },
    coverage: source.coverage, dataAsOf: source.dataAsOf, sources: source.sources,
  });
  if (parsed === null || parsed.version !== NEWS_HISTORY_VERSION || parsed.status === 'off' || parsed.status === 'unavailable') return fail();
  for (const excludedKey of Object.keys(parsed.coverage.excluded)) check(!HOSTILE_KEYS.has(excludedKey));
  const stats = {
    version: parsed.version, companyId: parsed.companyId, exchange, status: parsed.status,
    horizons: {
      day: { directions: parsed.horizons.day.directions, timeUnverifiedUnits: dayUnits },
      week: { directions: parsed.horizons.week.directions, timeUnverifiedUnits: weekUnits },
    },
    coverage: parsed.coverage, dataAsOf: parsed.dataAsOf, sources: parsed.sources,
  };
  return stats as unknown as CompanyStats;
}

export function parseStatsFile(value: unknown): ParseResult<StatsFile> {
  return boundary(value, HISTORY_VERSIONS.stats, source => {
    const companies = map(source.companies, MAX_MAP_KEYS, parseCompanyStats);
    const carriedOver = texts(source.carriedOver, MAX_MAP_KEYS, 40);
    check(new Set(carriedOver).size === carriedOver.length && carriedOver.every(id => Object.hasOwn(companies, id)));
    return { version: HISTORY_VERSIONS.stats, computedAt: instant(source.computedAt), runId: text(source.runId, 200), companies, carriedOver };
  });
}

// ---------------------------------------------------------------------------
// prices.json
// ---------------------------------------------------------------------------

const BAR_FLAGS: readonly PriceBarFlagName[] = ['zero_open', 'zero_volume', 'out_of_range', 'halt', 'missing_field'];

function parseBar(value: unknown): StoredPriceBar {
  const source = record(value);
  const bar: StoredPriceBar = {
    date: date(source.date), open: finite(source.open, 0), high: finite(source.high, 0), low: finite(source.low, 0),
    close: finite(source.close, 0), volume: finite(source.volume, 0), firstFetchedAt: instant(source.firstFetchedAt),
  };
  check(bar.close > 0);
  const positive = (field: unknown) => { const n = finite(field, 0); check(n > 0); return n; };
  if (source.adjClose !== undefined) bar.adjClose = positive(source.adjClose);
  if (source.base !== undefined) bar.base = finite(source.base, 0);
  if (source.baseFactor !== undefined) bar.baseFactor = positive(source.baseFactor);
  if (source.indexClose !== undefined) bar.indexClose = positive(source.indexClose);
  if (source.flags !== undefined) bar.flags = list(source.flags, BAR_FLAGS.length).map(flag => oneOf(flag, BAR_FLAGS));
  return bar;
}

function parseSeries(key: string, value: unknown): StoredPriceSeries {
  const source = record(value);
  check(source.key === key);
  const attempt = record(source.lastAttempt);
  check(typeof attempt.code === 'string' && /^[a-z0-9_]{1,40}$/.test(attempt.code));
  const bars = list(source.bars, MAX_BARS_PER_SERIES).map(parseBar);
  check(ascendingDates(bars.map(bar => bar.date)));
  return {
    key, provider: oneOf(source.provider, ['fsc', 'massive'] as const), providerSymbol: text(source.providerSymbol, 40),
    exchange: oneOf(source.exchange, EXCHANGES), currency: oneOf(source.currency, ['KRW', 'USD'] as const),
    basis: oneOf(source.basis, ['raw', 'split_adjusted'] as const), priceBasis: text(source.priceBasis, 80),
    forwardSince: instant(source.forwardSince), lastSuccessAt: instant(source.lastSuccessAt),
    lastAttempt: { at: instant(attempt.at), code: attempt.code as string }, rebasedAt: instantOrNull(source.rebasedAt), bars,
  };
}

export function parsePricesFile(value: unknown): ParseResult<PricesFile> {
  return boundary(value, HISTORY_VERSIONS.prices, source => ({
    version: HISTORY_VERSIONS.prices, writtenAt: instant(source.writtenAt), series: map(source.series, MAX_MAP_KEYS, parseSeries),
  }));
}

// ---------------------------------------------------------------------------
// weekly/ and daily/ (frozen complete outcomes)
// ---------------------------------------------------------------------------

const ENTRY_TYPES = ['open', 'close', 'close_no_open'] as const;
const PRICE_BASES = ['raw', 'adjusted'] as const;
const OUTCOME_LABELS = ['up', 'neutral', 'down'] as const;
const OUTCOME_FLAGS = ['benchmark_gap', 'no_open', 'unadjusted', 'insufficient_volatility_history', 'benchmark_chained'] as const;

function parseFlags(value: unknown): string[] {
  return list(value, OUTCOME_FLAGS.length).map(flag => oneOf(flag, OUTCOME_FLAGS));
}

function parseSessions(value: unknown, entryDate: string, exitDate: string): string[] {
  const sessions = list(value, 10).map(date);
  check(sessions.length >= 1 && ascendingDates(sessions) && sessions[0] === entryDate && sessions[sessions.length - 1] === exitDate);
  return sessions;
}

/** The OutcomeBase fields of a complete outcome. */
function parseCompleteOutcome(source: Record<string, unknown>): Record<string, unknown> {
  check(source.status === 'complete' && source.reason === null);
  const entryDate = date(source.entryDate);
  const exitDate = date(source.exitDate);
  const entryAtMs = finite(source.entryAtMs);
  const exitAtMs = finite(source.exitAtMs);
  check(entryAtMs <= exitAtMs);
  return {
    status: 'complete', reason: null, entryType: oneOf(source.entryType, ENTRY_TYPES), entryDate, exitDate, entryAtMs, exitAtMs,
    sessions: parseSessions(source.sessions, entryDate, exitDate), basis: oneOf(source.basis, PRICE_BASES),
    r: finite(source.r, -1), benchmarkR: finiteOrNull(source.benchmarkR, -1), relative: finiteOrNull(source.relative),
    sigma: finiteOrNull(source.sigma, 0), band: finiteOrNull(source.band, 0), label: oneOfOrNull(source.label, OUTCOME_LABELS),
    flags: parseFlags(source.flags),
  };
}

function parseWeeklyRecord(value: unknown): FrozenWeeklyRecord {
  const source = record(value);
  const outcome = record(source.outcome);
  const weekAsOfMs = finite(outcome.weekAsOfMs);
  const weekAsOf = instant(source.weekAsOf);
  check(new Date(weekAsOfMs).toISOString() === weekAsOf);
  return {
    companyId: text(source.companyId, 40), weekAsOf, frozenAt: instant(source.frozenAt), priceBasisVersion: text(source.priceBasisVersion, 100),
    outcome: { ...parseCompleteOutcome(outcome), weekAsOfMs } as unknown as WeeklyOutcome,
  };
}

function parseDailyRecord(value: unknown): FrozenDailyRecord {
  const source = record(value);
  const outcome = record(source.outcome);
  const base = parseCompleteOutcome(outcome);
  const sessionDate = date(source.sessionDate);
  check(base.exitDate === sessionDate);
  return {
    companyId: text(source.companyId, 40), sessionDate, frozenAt: instant(source.frozenAt), priceBasisVersion: text(source.priceBasisVersion, 100),
    outcome: {
      ...base, intraday: finiteOrNull(outcome.intraday, -1), benchmarkIntraday: finiteOrNull(outcome.benchmarkIntraday, -1),
      relativeIntraday: finiteOrNull(outcome.relativeIntraday),
    } as unknown as NextDayOutcome,
  };
}

function parseOutcomesFile<K extends 'weekly' | 'daily', R>(value: unknown, kind: K, parseRecord: (item: unknown) => R, expectedYear?: number) {
  return boundary(value, HISTORY_VERSIONS.outcomes, source => {
    check(source.kind === kind && isYear(source.year) && (expectedYear === undefined || source.year === expectedYear));
    return {
      version: HISTORY_VERSIONS.outcomes, kind, year: source.year as number, writtenAt: instant(source.writtenAt),
      records: list(source.records, MAX_RECORDS).map(parseRecord),
    };
  });
}

export function parseWeeklyOutcomesFile(value: unknown, expectedYear?: number): ParseResult<WeeklyOutcomesFile> {
  return parseOutcomesFile(value, 'weekly', parseWeeklyRecord, expectedYear);
}

export function parseDailyOutcomesFile(value: unknown, expectedYear?: number): ParseResult<DailyOutcomesFile> {
  return parseOutcomesFile(value, 'daily', parseDailyRecord, expectedYear);
}

// ---------------------------------------------------------------------------
// shadow/
// ---------------------------------------------------------------------------

const SIGNALS: readonly Signal[] = ['positive', 'negative', 'withheld'];
const VERDICTS: readonly Verdict[] = ['supports', 'contradicts', 'weakens', 'no_clear_difference', 'insufficient'];
const READY_STATUSES: readonly HistoryReadyStatus[] = ['ready', 'no_history', 'identity_unverified', 'price_unavailable', 'stats_not_public'];
const ANALYSIS_STATUSES: ReadonlyArray<NewsAnalysis['status']> = ['not_configured', 'insufficient', 'ready', 'error', 'rate_limited'];
const NOTES: readonly IntegrationNote[] = ['supports', 'no_clear_difference', 'weakens', 'contradicts', 'insufficient', 'baseline_withheld'];

function orderedInstants(value: unknown): { start: string; end: string } {
  const source = record(value);
  const start = instant(source.start);
  const end = instant(source.end);
  check(Date.parse(start) <= Date.parse(end));
  return { start, end };
}

function parseShadowRecord(value: unknown): ShadowRecord {
  const source = record(value);
  const recordedAt = instant(source.recordedAt);
  const recordDate = date(source.recordDate);
  check(recordDate === kstDateOf(recordedAt));
  const horizon = oneOf(source.horizon, ['day', 'week'] as const);
  const targetSource = record(source.target);
  const target = {
    start: date(targetSource.start), end: date(targetSource.end),
    basis: oneOf(targetSource.basis, ['exchange_calendar', 'weekdays_only'] as const),
    phase: oneOf(targetSource.phase, ['before_open', 'in_session', 'after_close'] as const),
  };
  check(target.start <= target.end);
  const newsWindow = source.newsWindow === null ? null : orderedInstants(source.newsWindow);
  check(newsWindow === null || horizon === 'day');
  let snapshot: ShadowRecord['snapshot'] = null;
  if (source.snapshot !== null) {
    const item = record(source.snapshot);
    snapshot = {
      asOf: instant(item.asOf), knownAt: instant(item.knownAt), analysisVersion: text(item.analysisVersion, 100),
      status: oneOf(item.status, ANALYSIS_STATUSES), partial: bool(item.partial),
    };
  }
  const baseline = oneOf(source.baseline, SIGNALS);
  check(snapshot !== null || baseline === 'withheld');
  let overnight: ShadowRecord['overnight'] = null;
  if (source.overnight !== null) {
    check(horizon === 'day');
    const item = record(source.overnight);
    const counts = record(item.counts);
    overnight = {
      reason: oneOf(item.reason, ['conflicting', 'one_direction', 'no_overnight_news'] as const),
      evidence: oneOf(item.evidence, ['none', 'low', 'moderate'] as const),
      counts: { positive: count(counts.positive), negative: count(counts.negative), neutral: count(counts.neutral), ignored: count(counts.ignored) },
    };
  }
  const verdict = oneOfOrNull(source.verdict, VERDICTS);
  check(baseline !== 'withheld' || verdict === null);
  const integrated = oneOf(source.integrated, SIGNALS);
  const changed = bool(source.changed);
  const note = oneOf(source.note, NOTES);
  const expected = integrateOutlook(baseline, verdict ?? 'insufficient');
  check(expected.signal === integrated && expected.changed === changed && expected.note === note);
  return {
    recordDate, recordedAt, companyId: text(source.companyId, 40), horizon, exchange: oneOf(source.exchange, EXCHANGES), target, newsWindow,
    snapshot, stale: bool(source.stale), baseline, overnight,
    statsStatus: oneOf(source.statsStatus, [...READY_STATUSES, 'missing'] as const), statsComputedAt: instantOrNull(source.statsComputedAt),
    verdict, integrated, changed, note,
  };
}

export function parseShadowFile(value: unknown, expectedYear?: number): ParseResult<ShadowFile> {
  return boundary(value, HISTORY_VERSIONS.shadow, source => {
    check(isYear(source.year) && (expectedYear === undefined || source.year === expectedYear));
    return {
      version: HISTORY_VERSIONS.shadow, year: source.year as number, writtenAt: instant(source.writtenAt),
      records: list(source.records, MAX_RECORDS).map(parseShadowRecord),
    };
  });
}

// ---------------------------------------------------------------------------
// ledger/
// ---------------------------------------------------------------------------

const SENTIMENTS = ['positive', 'negative', 'neutral', 'unclassified'] as const;
const METHODS = ['provider', 'unavailable', 'llm'] as const;
const RELEVANCE = ['unrelated', 'related'] as const;
const CONSENSUS = ['confirmed', 'provisional', 'withheld', 'pending'] as const;

function parseLabel(value: unknown): Record<string, unknown> {
  const source = record(value);
  return {
    at: instant(source.at), sentiment: oneOf(source.sentiment, SENTIMENTS), score: finiteOrNull(source.score),
    method: oneOfOrNull(source.method, METHODS), relevance: oneOfOrNull(source.relevance, RELEVANCE),
    consensus: oneOfOrNull(source.consensus, CONSENSUS), promptVersion: textOrNull(source.promptVersion, 100),
    models: texts(source.models, 20, 200),
  };
}

/** The frozen five-session case outcome (spec 3.1). */
function parseLedgerOutcome(value: unknown): Record<string, unknown> {
  const source = record(value);
  const entryDate = date(source.entryDate);
  const exitDate = date(source.exitDate);
  const entryAt = instant(source.entryAt);
  const exitAt = instant(source.exitAt);
  check(Date.parse(entryAt) <= Date.parse(exitAt));
  return {
    entryType: oneOf(source.entryType, ENTRY_TYPES), entryDate, exitDate, entryAt, exitAt,
    sessions: parseSessions(source.sessions, entryDate, exitDate), basis: oneOf(source.basis, PRICE_BASES),
    r: finite(source.r, -1), benchmarkR: finiteOrNull(source.benchmarkR, -1), relative: finiteOrNull(source.relative),
    sigma: finiteOrNull(source.sigma, 0), band: finiteOrNull(source.band, 0), label: oneOfOrNull(source.label, OUTCOME_LABELS),
    flags: parseFlags(source.flags), priceBasisVersion: text(source.priceBasisVersion, 100), frozenAt: instant(source.frozenAt),
  };
}

function parseEntry(value: unknown): LedgerEntry {
  const source = record(value);
  const collection = record(source.collection);
  check(isNewsTopicKey(source.topic));
  const entry: Record<string, unknown> = {
    id: text(source.id, 300), storyId: text(source.storyId, 300), companyId: text(source.companyId, 40),
    publishedAt: instant(source.publishedAt), timeKind: oneOf(source.timeKind, ['published', 'seen'] as const),
    timePrecision: oneOf(source.timePrecision, ['second', 'day'] as const), firstSeenAt: instantOrNull(source.firstSeenAt),
    source: text(source.source, 300, 0), sourceProvider: textOrNull(source.sourceProvider, 60), url: text(source.url, 2000, 0),
    title: text(source.title, 1000, 0), language: textOrNull(source.language, 40),
    topic: source.topic,
    identity: oneOf(source.identity, ['entity_verified', 'name_match'] as const), origin: oneOf(source.origin, ['forward', 'backfill'] as const),
    collection: {
      sort: text(collection.sort, 100, 0), limit: count(collection.limit), languages: texts(collection.languages, 20, 20),
      fetch: text(collection.fetch, 200, 0),
    },
    labels: list(source.labels, MAX_LABELS).map(parseLabel),
  };
  if (source.outcome !== undefined) entry.outcome = parseLedgerOutcome(source.outcome);
  return entry as unknown as LedgerEntry;
}

function parseGap(value: unknown): ObservationGap {
  const source = record(value);
  const gap = { start: instant(source.start), end: instant(source.end), detectedAt: instant(source.detectedAt) };
  check(Date.parse(gap.start) < Date.parse(gap.end));
  return gap;
}

function parseObservation(_key: string, value: unknown): ObservationRecord {
  const source = record(value);
  return {
    observedFrom: instant(source.observedFrom), lastSnapshotAt: instant(source.lastSnapshotAt),
    gaps: list(source.gaps, MAX_GAPS_PER_COMPANY).map(parseGap),
  };
}

function parseState(value: unknown, segment: string): LedgerState {
  const source = record(value);
  const directory = texts(source.directory, MAX_DIRECTORY, 20);
  check(directory.length >= 1 && directory[directory.length - 1] === segment && directory.every(id => parseLedgerSegmentId(id) !== null));
  for (let i = 1; i < directory.length; i += 1) check(compareLedgerSegmentIds(directory[i - 1]!, directory[i]!) < 0);
  const journal = record(source.journal);
  return {
    createdAt: instant(source.createdAt), directory, observations: map(source.observations, MAX_MAP_KEYS, parseObservation),
    journal: { kstDate: date(journal.kstDate), writes: count(journal.writes), fullDone: bool(journal.fullDone) },
    writeToken: text(source.writeToken, 200),
  };
}

/** Segment ids must match the file name when `expectedSegment` is given. */
export function parseLedgerSegmentFile(value: unknown, expectedSegment?: string): ParseResult<LedgerSegmentFile> {
  return boundary(value, HISTORY_VERSIONS.ledger, source => {
    const segment = text(source.segment, 20);
    check(parseLedgerSegmentId(segment) !== null && (expectedSegment === undefined || segment === expectedSegment));
    const entries = list(source.entries, MAX_LEDGER_ENTRIES).map(parseEntry);
    const keys = new Set<string>();
    for (const entry of entries) {
      const key = `${entry.companyId}\u0000${entry.id}`;
      check(!keys.has(key));
      keys.add(key);
    }
    return { version: HISTORY_VERSIONS.ledger, segment, writtenAt: instant(source.writtenAt), state: parseState(source.state, segment), entries };
  });
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface StoredFile<T> { value: T; etag: string }
/** fresh → useCache:false */
export interface ReadOptions { fresh?: boolean }
export type LedgerWriteCondition = { kind: 'ifMatch'; etag: string } | { kind: 'createOnly' };
export interface WriteResult { etag: string; bytes: number }

export interface HistoryStore {
  /** Successful puts made through this instance. */
  readonly writes: number;
  /** Put calls made (success + failure); too_large and invalid rejections are not attempts. */
  readonly attempts: number;
  readStats(o?: ReadOptions): Promise<StoredFile<StatsFile> | null>;
  writeStats(v: StatsFile): Promise<WriteResult>;
  readPrices(o?: ReadOptions): Promise<StoredFile<PricesFile> | null>;
  writePrices(v: PricesFile): Promise<WriteResult>;
  readWeekly(year: number, o?: ReadOptions): Promise<StoredFile<WeeklyOutcomesFile> | null>;
  writeWeekly(v: WeeklyOutcomesFile): Promise<WriteResult>;
  readDaily(year: number, o?: ReadOptions): Promise<StoredFile<DailyOutcomesFile> | null>;
  writeDaily(v: DailyOutcomesFile): Promise<WriteResult>;
  readShadow(year: number, o?: ReadOptions): Promise<StoredFile<ShadowFile> | null>;
  writeShadow(v: ShadowFile): Promise<WriteResult>;
  readLedgerSegment(id: string, o?: ReadOptions): Promise<StoredFile<LedgerSegmentFile> | null>;
  writeLedgerSegment(v: LedgerSegmentFile, condition: LedgerWriteCondition): Promise<WriteResult>;
  /** Latest segment, by fresh reads: from kstMonth back up to maxMonthsBack (default 36) months; within a month, probe shards upward. */
  findLedgerHead(kstMonth: string, maxMonthsBack?: number): Promise<StoredFile<LedgerSegmentFile> | null>;
}

type PutCondition = { kind: 'overwrite' } | LedgerWriteCondition;

/** Raw file access; the shared layer above does sizes, parsing, counters and retry detection. */
interface Backend {
  /** null = not found. Throws HistoryStoreError. */
  read(file: string, fresh: boolean): Promise<{ text: string; etag: string } | null>;
  /** Returns the new etag. Throws HistoryStoreError. */
  write(file: string, text: string, condition: PutCondition): Promise<string>;
}

type Parser<T> = (value: unknown) => ParseResult<T>;

function decode<T>(file: string, raw: string, parse: Parser<T>): T {
  if (Buffer.byteLength(raw, 'utf8') > MAX_FILE_BYTES) throw new HistoryStoreError('too_large', file);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new HistoryStoreError('invalid', file);
  }
  const parsed = parse(value);
  if (!parsed.ok) throw new HistoryStoreError(parsed.code, file);
  return parsed.value;
}

function storeOn(backend: Backend): HistoryStore {
  let writes = 0;
  let attempts = 0;

  async function read<T>(file: string, parse: Parser<T>, options: ReadOptions = {}): Promise<StoredFile<T> | null> {
    const raw = await backend.read(file, options.fresh === true);
    return raw === null ? null : { value: decode(file, raw.text, parse), etag: raw.etag };
  }

  async function write<T>(file: string, value: T, parse: Parser<T>, condition: PutCondition): Promise<WriteResult> {
    const json = JSON.stringify(value) as string | undefined;
    if (json === undefined) throw new HistoryStoreError('invalid', file);
    const bytes = Buffer.byteLength(json, 'utf8');
    if (bytes > MAX_FILE_BYTES) throw new HistoryStoreError('too_large', file);
    // A file this store would reject on read is never written: an unreadable ledger head stops every later run.
    if (!parse(JSON.parse(json)).ok) throw new HistoryStoreError('invalid', file);
    attempts += 1;
    const etag = await backend.write(file, json, condition);
    writes += 1;
    return { etag, bytes };
  }

  const ledgerParser = (id: string): Parser<LedgerSegmentFile> => value => parseLedgerSegmentFile(value, id);

  function segmentFile(id: string): string {
    if (parseLedgerSegmentId(id) === null) throw new HistoryStoreError('invalid', ledgerFile(String(id)));
    return ledgerFile(id);
  }
  function yearPath(kind: 'weekly' | 'daily' | 'shadow', year: number): string {
    if (!isYear(year)) throw new HistoryStoreError('invalid', `${kind}/${String(year)}.json`);
    return yearFile(kind, year);
  }

  const store: HistoryStore = {
    get writes() { return writes; },
    get attempts() { return attempts; },
    readStats: o => read(STATS_FILE, parseStatsFile, o),
    writeStats: v => write(STATS_FILE, v, parseStatsFile, { kind: 'overwrite' }),
    readPrices: o => read(PRICES_FILE, parsePricesFile, o),
    writePrices: v => write(PRICES_FILE, v, parsePricesFile, { kind: 'overwrite' }),
    readWeekly: async (year, o) => read(yearPath('weekly', year), value => parseWeeklyOutcomesFile(value, year), o),
    writeWeekly: async v => write(yearPath('weekly', v.year), v, value => parseWeeklyOutcomesFile(value, v.year), { kind: 'overwrite' }),
    readDaily: async (year, o) => read(yearPath('daily', year), value => parseDailyOutcomesFile(value, year), o),
    writeDaily: async v => write(yearPath('daily', v.year), v, value => parseDailyOutcomesFile(value, v.year), { kind: 'overwrite' }),
    readShadow: async (year, o) => read(yearPath('shadow', year), value => parseShadowFile(value, year), o),
    writeShadow: async v => write(yearPath('shadow', v.year), v, value => parseShadowFile(value, v.year), { kind: 'overwrite' }),
    readLedgerSegment: async (id, o) => read(segmentFile(id), ledgerParser(id), o),

    async writeLedgerSegment(v, condition) {
      const file = segmentFile(v.segment);
      try {
        return await write(file, v, ledgerParser(v.segment), condition);
      } catch (error) {
        if (!(error instanceof HistoryStoreError) || error.code !== 'conflict') throw error;
        // The SDK retries 5xx and network errors itself, so a write that landed can come back as a conflict.
        let stored: StoredFile<LedgerSegmentFile> | null = null;
        try {
          stored = await read(file, ledgerParser(v.segment), { fresh: true });
        } catch {
          throw error;
        }
        if (stored === null || stored.value.state.writeToken !== v.state.writeToken) throw error;
        writes += 1;
        return { etag: stored.etag, bytes: jsonByteLength(v) };
      }
    },

    async findLedgerHead(kstMonth, maxMonthsBack = 36) {
      checkMonth(kstMonth);
      if (!Number.isSafeInteger(maxMonthsBack) || maxMonthsBack < 1) throw new RangeError('invalid probe range');
      // Read errors propagate: a transient failure must never look like an empty ledger.
      for (let back = 0; back < maxMonthsBack; back += 1) {
        const month = addMonths(kstMonth, -back);
        let found: StoredFile<LedgerSegmentFile> | null = null;
        for (let shard = 0; shard <= MAX_SHARDS_PER_MONTH; shard += 1) {
          const id = ledgerSegmentId(month, shard);
          const segment = await store.readLedgerSegment(id, { fresh: true });
          if (segment === null) break;
          found = segment;
        }
        if (found) return found;
      }
      return null;
    },
  };
  return store;
}

// ---------------------------------------------------------------------------
// Blob backend
// ---------------------------------------------------------------------------

function isAbort(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted || error instanceof BlobRequestAbortedError) return true;
  const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined;
  return name === 'AbortError' || name === 'TimeoutError';
}

/** Reads at most `max` bytes; one byte more cancels the stream before anything else is buffered. */
async function readBoundedText(stream: ReadableStream<Uint8Array>, max: number, file: string, signal: AbortSignal): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      let part: ReadableStreamReadResult<Uint8Array>;
      try {
        part = await reader.read();
      } catch (error) {
        throw new HistoryStoreError(isAbort(error, signal) ? 'timeout' : 'unreadable', file);
      }
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > max) throw new HistoryStoreError('too_large', file);
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const data = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    throw new HistoryStoreError('invalid', file);
  }
}

function putErrorCode(error: unknown, signal: AbortSignal): HistoryStoreErrorCode {
  if (error instanceof BlobPreconditionFailedError) return 'conflict';
  if (error instanceof BlobError && error.message.includes('already exists')) return 'conflict';
  if (isAbort(error, signal)) return 'timeout';
  return 'write_failed';
}

/**
 * Private Vercel Blob storage, or null when no store is connected. Same auth as
 * snapshot-store: OIDC on Vercel (BLOB_STORE_ID), else BLOB_READ_WRITE_TOKEN.
 */
export function createBlobHistoryStore(
  env: NodeJS.ProcessEnv = process.env,
  blob: { get: typeof get; put: typeof put } = { get, put },
): HistoryStore | null {
  if (!env.BLOB_READ_WRITE_TOKEN?.trim() && !env.BLOB_STORE_ID?.trim()) return null;
  return storeOn({
    async read(file, fresh) {
      const signal = AbortSignal.timeout(STORE_TIMEOUT_MS);
      let result: Awaited<ReturnType<typeof get>>;
      try {
        result = await blob.get(HISTORY_PREFIX + file, { access: 'private', useCache: !fresh, abortSignal: signal });
      } catch (error) {
        if (error instanceof BlobNotFoundError) return null;
        throw new HistoryStoreError(isAbort(error, signal) ? 'timeout' : 'unreadable', file);
      }
      if (!result || result.statusCode !== 200 || !result.stream) return null;
      const etag = typeof result.blob?.etag === 'string' ? result.blob.etag : '';
      return { text: await readBoundedText(result.stream, MAX_FILE_BYTES, file, signal), etag };
    },
    async write(file, body, condition) {
      const signal = AbortSignal.timeout(STORE_TIMEOUT_MS);
      const last = condition.kind === 'overwrite' ? { allowOverwrite: true }
        : condition.kind === 'ifMatch' ? { ifMatch: condition.etag } : { allowOverwrite: false };
      try {
        const result = await blob.put(HISTORY_PREFIX + file, body, {
          access: 'private', addRandomSuffix: false, contentType: 'application/json', cacheControlMaxAge: 60, abortSignal: signal, ...last,
        });
        return typeof result?.etag === 'string' ? result.etag : '';
      } catch (error) {
        throw new HistoryStoreError(putErrorCode(error, signal), file);
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Memory backend (tests and local development)
// ---------------------------------------------------------------------------

export interface MemoryStoreOptions {
  now?: () => number;
  /** A code fails that read before it reaches the stored files. */
  failRead?: (file: string) => HistoryStoreErrorCode | null;
  /** A code fails that put after it counted as an attempt; nothing is stored. The hook may change `files` first. */
  failWrite?: (file: string) => HistoryStoreErrorCode | null;
}

export type MemoryHistoryStore = HistoryStore & {
  /** Keyed by the file name relative to HISTORY_PREFIX, e.g. 'stats.json', 'ledger/2026-11.json'. */
  files: Map<string, { text: string; etag: string }>;
  writeLog: Array<{ file: string; at: number; ok: boolean }>;
  reads: Array<{ file: string; fresh: boolean }>;
};

/** Same parsers, size limits, conditions and counters as the Blob store. */
export function createMemoryHistoryStore(o: MemoryStoreOptions = {}): MemoryHistoryStore {
  const now = o.now ?? Date.now;
  const files = new Map<string, { text: string; etag: string }>();
  const writeLog: MemoryHistoryStore['writeLog'] = [];
  const reads: MemoryHistoryStore['reads'] = [];
  let version = 0;
  const store = storeOn({
    async read(file, fresh) {
      reads.push({ file, fresh });
      const code = o.failRead?.(file) ?? null;
      if (code) throw new HistoryStoreError(code, file);
      const stored = files.get(file);
      return stored ? { text: stored.text, etag: stored.etag } : null;
    },
    async write(file, body, condition) {
      const at = now();
      const injected = o.failWrite?.(file) ?? null;
      const existing = files.get(file);
      const code: HistoryStoreErrorCode | null = injected ??
        (condition.kind === 'ifMatch' && existing?.etag !== condition.etag ? 'conflict'
          : condition.kind === 'createOnly' && existing !== undefined ? 'conflict' : null);
      writeLog.push({ file, at, ok: code === null });
      if (code) throw new HistoryStoreError(code, file);
      version += 1;
      const etag = `"mem-${version}"`;
      files.set(file, { text: body, etag });
      return etag;
    },
  });
  return Object.defineProperties(store, {
    files: { value: files, enumerable: true },
    writeLog: { value: writeLog, enumerable: true },
    reads: { value: reads, enumerable: true },
  }) as MemoryHistoryStore;
}
