import { randomUUID } from 'node:crypto';
import {
  companies as coreCompanies, deriveBaselineSignal, deriveOvernightSignal, integrateOutlook,
  type Company, type HistoryReadyStatus, type Signal, type Verdict,
} from '../packages/core/src/index.js';
import {
  foldLedger, isKnownAt, ledgerKey, mergeLedger, entriesFromSnapshot,
  type LedgerCollection, type LedgerEntry,
} from './history-ledger.js';
import { OUTCOME_RULES_VERSION } from './history-outcomes.js';
import {
  companyStats, outcomesFromPrices, withFrozenOutcomes,
  type CompanyStats, type CompanyStatsInput, type FreezeSink, type FrozenLookup, type Observation,
} from './history-stats.js';
import {
  HISTORY_VERSIONS, HistoryStoreError, PRICES_FILE, STATS_FILE, addMonths, createBlobHistoryStore, jsonByteLength,
  ledgerSegmentId, parseDailyOutcomesFile, parseLedgerSegmentFile, parseLedgerSegmentId, parseShadowFile, parseStatsFile,
  parseWeeklyOutcomesFile,
  type FrozenDailyRecord, type FrozenWeeklyRecord, type HistoryStore, type LedgerSegmentFile, type LedgerState, type LedgerWriteCondition,
  type ObservationGap, type ObservationRecord, type ShadowRecord, type StatsFile, type StoredFile, type WriteResult,
} from './history-store.js';
import { dayTargetWindow, localDate, weekTargetWindow, type Exchange } from './market-calendar.js';
import {
  FETCH_ORDER, barAvailability, companyPriceIdentities, createPriceProviders, fetchRange, lastAvailableDate, mergePriceSeries,
  priceIdentity,
  type PriceFetchResult, type PriceProvider, type PriceProviderId, type PriceSeries,
} from './price-provider.js';
import { createRedactor, type Redactor } from './price-wire.js';
import { SNAPSHOT_POOL_LIMIT, createBlobSnapshotStore, type CompanySnapshot, type SnapshotStore } from './snapshot-store.js';

// Daily job for historical news insights (step 4, spec ch. 5). Invariants:
// - HISTORY_INSIGHTS is enforced by the route; this module never reads it at run time.
// - runHistoryJob never throws, never logs, and returns a summary whose strings have
//   every price-key and cron-secret form redacted.
// - At most DAILY_WRITE_CAP Blob writes per KST day. The count lives in the ledger
//   head's journal, and every writing run first makes one conditional write on the
//   head it read (ifMatch; createOnly only when there is none or a new month starts;
//   a new shard in the head's month first seals the old head under ifMatch), so two
//   concurrent runs that started on the same KST day can never both pass the reservation.
// - A ledger that cannot be read completely is never written over: any head or
//   segment failure stops the run before any fetch or write.
// - Computation uses one clock (computeAt, taken after prices); replaying the
//   stored files at that clock gives the same statistics (observation gaps carry
//   detectedAt, bars firstFetchedAt, frozen outcomes frozenAt).
// - stats.json is written last, so a stats.json dated today means every other
//   file of that run was attempted, and a rerun the same day stops at once.

export type HistoryMode = 'off' | 'collect' | 'on';

/** trim + lowercase; anything but off/collect/on is off. 'on' runs exactly like 'collect' in step 4. */
export function parseHistoryMode(value: string | undefined): HistoryMode {
  const mode = (value ?? '').trim().toLowerCase();
  return mode === 'collect' || mode === 'on' ? mode : 'off';
}

export type HistoryJobMode = 'full' | 'ledger';
export interface HistoryJobLimits { rolloverBytes?: number; patchBytes?: number }

export interface HistoryJobDeps {
  store: HistoryStore | null;
  snapshots: Pick<SnapshotStore, 'read'> | null;
  /** Fresh instances per run: pacing, request caps and stop state live per instance. */
  priceProviders: () => Record<PriceProviderId, PriceProvider>;
  companies: readonly Company[];
  now: () => number;
  randomId: () => string;
  redactKeys: readonly (string | undefined)[];
  limits?: HistoryJobLimits;
}

export type HistoryJobStatus = 'done' | 'partial' | 'already_done' | 'failed' | 'not_configured';
export type HistoryJobError = 'store_not_configured' | 'stats_unreadable' | 'ledger_unreadable' | 'ledger_invalid' | 'ledger_unsupported'
  | 'ledger_load_timeout' | 'snapshots_not_configured' | 'snapshot_unreadable' | 'prices_unreadable' | 'prices_invalid'
  | 'outcomes_unreadable' | 'outcomes_invalid' | 'shadow_unreadable' | 'shadow_invalid' | 'price_fetch_failed' | 'price_not_configured'
  | 'compute_budget' | 'stats_failed' | 'write_cap' | 'write_deadline' | 'ledger_conflict' | 'write_failed' | 'too_large'
  | 'internal_error';

export interface HistoryJobSummary {
  status: HistoryJobStatus; mode: HistoryJobMode; runId: string; startedAt: string; finishedAt: string; elapsedMs: number;
  /** Unique, sorted. */
  errors: HistoryJobError[];
  ledger: {
    head: string | null; segmentsRead: number; entries: number; newEntries: number; changedEntries: number; outcomePatches: number;
    /** Snapshot articles left out because they would not pass the ledger file check. */
    rejectedEntries: number;
    snapshots: { read: string[]; missing: string[]; unreadable: string[] }; gapsAdded: string[]; rolledOver: boolean;
  };
  prices: Record<string, { code: string; providerCode: string | null; newBars: number; lastDate: string | null; ms: number }> | null;
  stats: { computed: string[]; carriedOver: string[]; failed: string[]; statuses: Record<string, HistoryReadyStatus>; ms: Record<string, number> } | null;
  /** casesDeferred: completed cases left for a later run by the per-run patch budget. */
  frozen: { weekly: number; daily: number; cases: number; casesDeferred: number } | null;
  shadow: { recorded: number; kept: number } | null;
  writes: { cap: number; usedBefore: number; allowance: number; done: string[]; deferred: string[]; failed: Array<{ file: string; code: string }> };
}

export interface HistoryService { run(mode: HistoryJobMode): Promise<HistoryJobSummary> }

export const DAILY_WRITE_CAP = 8;
/** The full job leaves one write for the evening ledger run. */
export const FULL_RESERVE_FOR_LEDGER = 1;
/** Ledger runs before the day's full job leave it at least the head and stats.json. */
export const FULL_MIN_WRITES = 2;
export const LEDGER_ROLLOVER_BYTES = 4 * 1024 * 1024;
/**
 * Case-outcome patches one full run adds to the ledger, in JSON bytes. A backlog (prices back after an outage)
 * is frozen over several runs, oldest first: unbounded, its patches alone could pass the 5 MiB file limit and
 * no later full run could write the head again.
 */
export const MAX_PATCH_BYTES_PER_RUN = 2 * 1024 * 1024;
export const LEDGER_PROBE_MONTHS = 36;
export const READ_CONCURRENCY = 4;
/** Checkpoints from the run start (spec 5.7); Vercel stops the function at 300 s. */
export const FULL_BUDGET_MS = {
  load: 45_000, pricesAfterLoad: 110_000, pricesEnd: 160_000, compute: 60_000, computeEnd: 220_000, headStart: 240_000, lastWriteStart: 270_000,
} as const;
export const LEDGER_BUDGET_MS = { load: 30_000, headStart: 35_000 } as const;
export const SNAPSHOT_READ_TIMEOUT_MS = 20_000;

export const MARKETAUX_COLLECTION: LedgerCollection = { sort: 'entity_match_score', limit: 3, languages: ['en', 'ko'], fetch: 'marketaux:/v1/news/all' };
export const GDELT_COLLECTION: LedgerCollection = { sort: 'datedesc', limit: 15, languages: [], fetch: 'gdelt:doc/artlist' };

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const iso = (ms: number): string => new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function kstDate(ms: number): string { return localDate('KRX', ms); }
export function kstMonth(ms: number): string { return kstDate(ms).slice(0, 7); }
export function kstYear(ms: number): number { return Number(kstDate(ms).slice(0, 4)); }

/**
 * Earliest instant the snapshot's pool still covers: the oldest pool article when
 * the pool is full (older ones were pushed out), otherwise the analysis window start.
 */
export function coverageStartMs(snapshot: CompanySnapshot): number {
  if (snapshot.pool.length >= SNAPSHOT_POOL_LIMIT) {
    const times = snapshot.pool.map(article => Date.parse(article.publishedAt)).filter(Number.isFinite);
    if (times.length) return Math.min(...times);
  }
  const start = Date.parse(snapshot.analysis.newsWindow?.start ?? '');
  return Number.isFinite(start) ? start : Date.parse(snapshot.analysis.asOf) - WEEK_MS;
}

const MAX_GAPS = 500;

function mergeGaps(gaps: readonly ObservationGap[]): ObservationGap[] {
  const sorted = [...gaps].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const merged: ObservationGap[] = [];
  for (const gap of sorted) {
    const last = merged[merged.length - 1];
    if (last && Date.parse(gap.start) <= Date.parse(last.end)) {
      // Overlapping or adjacent: one gap, known once both were.
      merged[merged.length - 1] = {
        start: last.start, end: Date.parse(gap.end) > Date.parse(last.end) ? gap.end : last.end,
        detectedAt: Date.parse(gap.detectedAt) > Date.parse(last.detectedAt) ? gap.detectedAt : last.detectedAt,
      };
    } else merged.push(gap);
  }
  while (merged.length > MAX_GAPS) {
    const [a, b] = merged.splice(0, 2) as [ObservationGap, ObservationGap];
    merged.unshift({ start: a.start, end: Date.parse(b.end) > Date.parse(a.end) ? b.end : a.end,
      detectedAt: Date.parse(b.detectedAt) > Date.parse(a.detectedAt) ? b.detectedAt : a.detectedAt });
  }
  return merged;
}

/**
 * The observation record after seeing a snapshot. Knowledge counts from the first
 * sighting only; a later snapshot whose coverage starts after the last one seen
 * leaves an unobserved gap [lastSnapshotAt, coverage start), dated detectedAtMs.
 * Returns `record` itself when the snapshot is not newer.
 */
export function observeSnapshot(record: ObservationRecord | null, snapshot: CompanySnapshot, detectedAtMs: number): ObservationRecord {
  const updated = Date.parse(snapshot.updatedAt);
  const updatedAt = iso(updated);
  if (record && updated <= Date.parse(record.lastSnapshotAt)) return record;
  if (!record) return { observedFrom: updatedAt, lastSnapshotAt: updatedAt, gaps: [] };
  const coverage = coverageStartMs(snapshot);
  let gaps = record.gaps;
  if (Number.isFinite(coverage) && coverage > Date.parse(record.lastSnapshotAt)) {
    gaps = mergeGaps([...record.gaps, { start: record.lastSnapshotAt, end: iso(coverage), detectedAt: iso(detectedAtMs) }]);
  }
  return { observedFrom: record.observedFrom, lastSnapshotAt: updatedAt, gaps };
}

/** The observation a computation at nowMs may use: gaps detected later are not known yet. */
export function observationAt(state: Pick<LedgerState, 'observations'>, companyId: string, nowMs: number): Observation {
  const record = Object.hasOwn(state.observations, companyId) ? state.observations[companyId] : undefined;
  if (!record) return { fromMs: nowMs, gaps: [] };
  return {
    fromMs: Date.parse(record.observedFrom),
    gaps: record.gaps.filter(gap => Date.parse(gap.detectedAt) <= nowMs).map(gap => ({ startMs: Date.parse(gap.start), endMs: Date.parse(gap.end) })),
  };
}

export interface WriteJournalView { kstDate: string; writes: number; fullDone: boolean }

/** Writes already used on the KST day `kst`; a journal from a later day blocks writing (clock skew). */
export function usedWrites(journal: WriteJournalView, kst: string): number {
  return journal.kstDate === kst ? journal.writes : journal.kstDate > kst ? DAILY_WRITE_CAP : 0;
}

/** How many files this run may write (spec 5.6). */
export function allowedWrites(journal: WriteJournalView, kst: string, mode: HistoryJobMode): number {
  const used = usedWrites(journal, kst);
  const fullDoneToday = journal.kstDate === kst && journal.fullDone;
  // Before the day's full job, ledger runs leave it the head and stats.json on top of the write it keeps for
  // the evening ledger run; leaving only FULL_MIN_WRITES would let the full job write nothing but the head.
  return mode === 'ledger'
    ? DAILY_WRITE_CAP - used - (fullDoneToday ? 0 : FULL_MIN_WRITES + FULL_RESERVE_FOR_LEDGER)
    : DAILY_WRITE_CAP - used - FULL_RESERVE_FOR_LEDGER;
}

export type HistoryFileKind = 'head' | 'stats' | 'shadow' | 'prices' | 'daily' | 'weekly';
/** Selection priority. */
export const WRITE_PRIORITY: readonly HistoryFileKind[] = ['head', 'stats', 'shadow', 'prices', 'daily', 'weekly'];
/** Execution order: the head first (the reservation), stats.json last. */
export const WRITE_ORDER: readonly HistoryFileKind[] = ['head', 'shadow', 'prices', 'daily', 'weekly', 'stats'];

/** Which changed files to write under the allowance; the head always comes with anything else. */
export function selectWrites(changed: ReadonlySet<HistoryFileKind>, allowance: number): { selected: HistoryFileKind[]; deferred: HistoryFileKind[] } {
  const candidates = WRITE_PRIORITY.filter(kind => kind === 'head' ? changed.size > 0 : changed.has(kind));
  if (allowance < 1) return { selected: [], deferred: candidates };
  const chosen = new Set(candidates.slice(0, allowance));
  return { selected: WRITE_ORDER.filter(kind => chosen.has(kind)), deferred: candidates.filter(kind => !chosen.has(kind)) };
}

/** First frozen record per (company, price-basis version, key). */
export interface FrozenIndex { weekly: Map<string, FrozenWeeklyRecord>; daily: Map<string, FrozenDailyRecord> }

const frozenKey = (companyId: string, version: string, key: string) => `${companyId}|${version}|${key}`;

export function frozenIndex(weekly: Iterable<FrozenWeeklyRecord>, daily: Iterable<FrozenDailyRecord>): FrozenIndex {
  const index: FrozenIndex = { weekly: new Map(), daily: new Map() };
  for (const record of weekly) {
    const key = frozenKey(record.companyId, record.priceBasisVersion, record.weekAsOf);
    if (!index.weekly.has(key)) index.weekly.set(key, record);
  }
  for (const record of daily) {
    const key = frozenKey(record.companyId, record.priceBasisVersion, record.sessionDate);
    if (!index.daily.has(key)) index.daily.set(key, record);
  }
  return index;
}

export function frozenLookup(index: FrozenIndex, companyId: string, priceBasisVersion: string): FrozenLookup {
  return {
    week: asOfMs => index.weekly.get(frozenKey(companyId, priceBasisVersion, iso(asOfMs))) ?? null,
    day: date => index.daily.get(frozenKey(companyId, priceBasisVersion, date)) ?? null,
  };
}

/** `${identity.priceBasis}/${OUTCOME_RULES_VERSION}` of a company's own series; null for an unpriced company. */
export function priceBasisVersionOf(companyId: string): string | null {
  const ids = companyPriceIdentities(companyId);
  return ids ? `${ids.stock.priceBasis}/${OUTCOME_RULES_VERSION}` : null;
}

export interface CompanyStatsContext {
  companyId: string;
  /** The whole folded ledger; companyStats keeps this company's entries. */
  entries: readonly LedgerEntry[];
  observations: Readonly<Record<string, ObservationRecord>>;
  series: Readonly<Record<string, PriceSeries | undefined>>;
  frozen: FrozenIndex;
  nowMs: number;
  sink?: FreezeSink | null;
}

/**
 * The one builder of a company's statistics input, shared by the job and the
 * replay check: computing it from a later store at an earlier nowMs must give
 * what that earlier run stored. Throws for a company without price identities.
 */
export function companyStatsInput(context: CompanyStatsContext): CompanyStatsInput {
  const { companyId, nowMs } = context;
  const ids = companyPriceIdentities(companyId);
  if (!ids) throw new RangeError('company without price identity');
  const own = context.series[ids.stock.key] ?? null;
  const bench = context.series[ids.benchmark.key] ?? null;
  const ownAvailable = barAvailability(own, ids.stock);
  const benchAvailable = barAvailability(bench, ids.benchmark);
  const availableAtMs = bench ? (session: Parameters<typeof ownAvailable>[0]) => Math.max(ownAvailable(session), benchAvailable(session)) : ownAvailable;
  const version = `${ids.stock.priceBasis}/${OUTCOME_RULES_VERSION}`;
  const computed = outcomesFromPrices({
    exchange: ids.stock.exchange, bars: own?.bars ?? [], benchmarkBars: bench?.bars ?? null, availableAtMs, openAvailable: true,
  }, nowMs);
  const outcomes = withFrozenOutcomes({ computed, frozen: frozenLookup(context.frozen, companyId, version), sink: context.sink ?? null, nowMs, priceBasisVersion: version });
  const ownLast = lastAvailableDate(own, ids.stock, nowMs);
  let lastPriceDate = ownLast;
  if (bench) {
    const benchLast = lastAvailableDate(bench, ids.benchmark, nowMs);
    lastPriceDate = ownLast === null || benchLast === null ? null : ownLast < benchLast ? ownLast : benchLast;
  }
  const news = new Set<string>();
  for (const entry of context.entries) {
    if (entry.companyId !== companyId || !entry.sourceProvider || entry.sourceProvider.length > 60 || !isKnownAt(entry, nowMs)) continue;
    news.add(entry.sourceProvider);
  }
  return {
    companyId, exchange: ids.stock.exchange, entries: context.entries, nowMs,
    observation: observationAt({ observations: context.observations }, companyId, nowMs),
    outcomes, lastPriceDate,
    // HISTORY_PUBLIC_MARKETS gates serving (step 6); stats.json itself is private.
    statsPublic: true,
    // Only a provider answer naming another instrument is an identity failure; a series that was never
    // fetched (no key, provider down since the start) is price_unavailable.
    identityVerified: own === null || own.lastAttempt.code !== 'identity_mismatch',
    priceAvailable: (own?.bars.length ?? 0) > 0,
    sources: { news: [...news].sort().slice(0, 8), price: { label: ids.stock.sourceLabel, adjustment: ids.stock.adjustment } },
  };
}

export interface ShadowInput {
  companyId: string;
  exchange: Exchange;
  snapshot: CompanySnapshot | null;
  stats: CompanyStats | null;
  computeAtMs: number;
  /** Earlier records of the current file, for `stale`. */
  previous: readonly ShadowRecord[];
}

/** toISOString text of an instant; text that does not parse is kept (the store check then rejects it). */
const canonical = (text: string): string => { const ms = Date.parse(text); return Number.isFinite(ms) ? iso(ms) : text; };

/** One record per horizon (day, then week) of what the screen would have shown at computeAt. */
export function shadowRecordsFor(input: ShadowInput): ShadowRecord[] {
  const { snapshot, stats, computeAtMs } = input;
  const recordedAt = iso(computeAtMs);
  const day = dayTargetWindow(input.exchange, computeAtMs);
  const week = weekTargetWindow(input.exchange, computeAtMs);
  const analysis = snapshot?.analysis ?? null;
  const partial = (analysis?.sources ?? []).some(source => source.status === 'rate_limited' || source.status === 'error');
  return (['day', 'week'] as const).map(horizon => {
    const window = horizon === 'day' ? day.targetWindow : week;
    let baseline: Signal = 'withheld';
    let overnight: ShadowRecord['overnight'] = null;
    if (analysis && horizon === 'day') {
      const signal = deriveOvernightSignal(analysis.articles, day.newsWindow);
      baseline = signal.signal;
      overnight = { reason: signal.reason, evidence: signal.evidence, counts: { ...signal.counts } };
    } else if (analysis) baseline = deriveBaselineSignal(analysis);
    const directions = stats?.horizons[horizon].directions ?? null;
    const verdict: Verdict | null = (baseline === 'positive' || baseline === 'negative') && directions ? directions[baseline].verdict : null;
    const integrated = integrateOutlook(baseline, verdict ?? 'insufficient');
    const previous = input.previous
      .filter(record => record.companyId === input.companyId && record.horizon === horizon)
      .sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt));
    const last = previous[previous.length - 1];
    return {
      recordDate: kstDate(computeAtMs), recordedAt, companyId: input.companyId, horizon, exchange: input.exchange,
      target: { start: window.start, end: window.end, basis: window.basis, phase: window.phase },
      newsWindow: horizon === 'day' ? { ...day.newsWindow } : null,
      snapshot: snapshot && analysis ? {
        asOf: canonical(analysis.asOf), knownAt: canonical(snapshot.updatedAt), analysisVersion: snapshot.analysisVersion,
        status: analysis.status, partial,
      } : null,
      stale: Boolean(snapshot && last?.snapshot && last.snapshot.knownAt === canonical(snapshot.updatedAt)),
      baseline, overnight,
      statsStatus: stats?.status ?? 'missing', statsComputedAt: stats?.dataAsOf.computedAt ?? null,
      verdict, integrated: integrated.signal, changed: integrated.changed, note: integrated.note,
    } satisfies ShadowRecord;
  });
}

// ---------------------------------------------------------------------------
// Probes: a value the store would reject is never offered to it
// ---------------------------------------------------------------------------

const PROBE_INSTANT = '2000-01-01T00:00:00.000Z';
const roundTrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

function validEntry(entry: LedgerEntry): boolean {
  return parseLedgerSegmentFile({
    version: HISTORY_VERSIONS.ledger, segment: '2000-01', writtenAt: PROBE_INSTANT,
    state: { createdAt: PROBE_INSTANT, directory: ['2000-01'], observations: {}, journal: { kstDate: '2000-01-01', writes: 0, fullDone: false }, writeToken: 'probe' },
    entries: [roundTrip(entry)],
  }).ok;
}
const validWeekly = (record: FrozenWeeklyRecord) =>
  parseWeeklyOutcomesFile({ version: HISTORY_VERSIONS.outcomes, kind: 'weekly', year: 2000, writtenAt: PROBE_INSTANT, records: [roundTrip(record)] }).ok;
const validDaily = (record: FrozenDailyRecord) =>
  parseDailyOutcomesFile({ version: HISTORY_VERSIONS.outcomes, kind: 'daily', year: 2000, writtenAt: PROBE_INSTANT, records: [roundTrip(record)] }).ok;
const validShadow = (record: ShadowRecord) =>
  parseShadowFile({ version: HISTORY_VERSIONS.shadow, year: 2000, writtenAt: PROBE_INSTANT, records: [roundTrip(record)] }).ok;
const validStats = (stats: CompanyStats) =>
  parseStatsFile({ version: HISTORY_VERSIONS.stats, computedAt: PROBE_INSTANT, runId: 'probe', companies: { [stats.companyId]: roundTrip(stats) }, carriedOver: [] }).ok;

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

/** Stops the run; `fatal` means nothing may be written. */
class JobStop extends Error {
  constructor(readonly code: HistoryJobError) { super(code); }
}

const storeCode = (error: unknown) => error instanceof HistoryStoreError ? error.code : null;

function ledgerError(error: unknown): HistoryJobError {
  const code = storeCode(error);
  return code === 'invalid' ? 'ledger_invalid' : code === 'unsupported_version' ? 'ledger_unsupported' : 'ledger_unreadable';
}

function writeError(code: string | null): HistoryJobError {
  return code === 'conflict' ? 'ledger_conflict' : code === 'too_large' ? 'too_large' : 'write_failed';
}

/** Runs `task` over items with at most `limit` in flight; stops starting new ones after the first failure. */
async function mapLimit<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        results[i] = await task(items[i]!);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Snapshot reads carry no timeout of their own; a hung read counts as unreadable. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function redactDeep<T>(value: T, redact: Redactor): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map(item => redactDeep(item, redact)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[redact(key)] = redactDeep(item, redact);
    return out as T;
  }
  return value;
}

function failedFetch(key: string, attemptedAtMs: number): PriceFetchResult {
  return {
    key, code: 'network', providerCode: null, bars: [], attemptedAt: iso(attemptedAtMs), receivedAt: null, ms: 0,
    counts: { rows: 0, kept: 0, otherCodes: 0, nonSession: 0, unverifiedDate: 0, notClosed: 0, outsideValidity: 0, malformed: 0, duplicates: 0, flagged: 0 },
  };
}

/** Never throws; see the header for the invariants. */
export async function runHistoryJob(deps: HistoryJobDeps, mode: HistoryJobMode): Promise<HistoryJobSummary> {
  const start = deps.now();
  let runId = 'unknown';
  try { runId = String(deps.randomId()); } catch { /* keep the placeholder */ }
  const errors = new Set<HistoryJobError>();
  const summary: HistoryJobSummary = {
    status: 'done', mode, runId, startedAt: iso(start), finishedAt: iso(start), elapsedMs: 0, errors: [],
    ledger: { head: null, segmentsRead: 0, entries: 0, newEntries: 0, changedEntries: 0, outcomePatches: 0, rejectedEntries: 0,
      snapshots: { read: [], missing: [], unreadable: [] }, gapsAdded: [], rolledOver: false },
    prices: null, stats: null, frozen: null, shadow: null,
    writes: { cap: DAILY_WRITE_CAP, usedBefore: 0, allowance: 0, done: [], deferred: [], failed: [] },
  };
  let fatal = false;
  try {
    const outcome = await runStages(deps, mode, start, runId, summary, errors);
    if (outcome === 'already_done' || outcome === 'not_configured') summary.status = outcome;
    else if (outcome === 'failed') fatal = true;
  } catch (error) {
    fatal = true;
    errors.add(error instanceof JobStop ? error.code : 'internal_error');
  }
  const end = deps.now();
  summary.finishedAt = iso(end);
  summary.elapsedMs = end - start;
  summary.errors = [...errors].sort();
  if (summary.status !== 'already_done' && summary.status !== 'not_configured') {
    summary.status = fatal ? 'failed' : errors.size ? 'partial' : 'done';
  }
  let redact: Redactor;
  try { redact = createRedactor(deps.redactKeys); } catch { redact = Object.assign((text: string) => text, { contains: () => false }); }
  return redactDeep(summary, redact);
}

type StageResult = 'ran' | 'already_done' | 'not_configured' | 'failed';

async function runStages(deps: HistoryJobDeps, mode: HistoryJobMode, start: number, runId: string,
  summary: HistoryJobSummary, errors: Set<HistoryJobError>): Promise<StageResult> {
  const { store, now } = deps;
  if (!store) { errors.add('store_not_configured'); return 'not_configured'; }
  const full = mode === 'full';
  const kst = kstDate(start);
  const month = kst.slice(0, 7);
  const year = Number(kst.slice(0, 4));
  const loadDeadline = start + (full ? FULL_BUDGET_MS.load : LEDGER_BUDGET_MS.load);
  const headDeadline = start + (full ? FULL_BUDGET_MS.headStart : LEDGER_BUDGET_MS.headStart);
  const lastWriteStart = start + (full ? FULL_BUDGET_MS.lastWriteStart : LEDGER_BUDGET_MS.headStart);
  const checkLoad = () => { if (now() > loadDeadline) throw new JobStop('ledger_load_timeout'); };

  // 1. Idempotency (full mode): today's stats.json means the day's job is done.
  let previousStats: StatsFile | null = null;
  if (full) {
    try {
      const stored = await store.readStats({ fresh: true });
      if (stored && kstDate(Date.parse(stored.value.computedAt)) === kst) return 'already_done';
      previousStats = stored?.value ?? null;
    } catch {
      errors.add('stats_unreadable');
    }
  }

  // 2. Ledger: head, other segments, fold.
  let head: StoredFile<LedgerSegmentFile> | null;
  try {
    checkLoad();
    head = await store.findLedgerHead(month, LEDGER_PROBE_MONTHS);
  } catch (error) {
    errors.add(error instanceof JobStop ? error.code : ledgerError(error));
    return 'failed';
  }
  summary.ledger.head = head?.value.segment ?? null;
  const state: LedgerState = head ? head.value.state : {
    createdAt: iso(start), directory: [], observations: {}, journal: { kstDate: kst, writes: 0, fullDone: false }, writeToken: runId,
  };
  const recentFrom = addMonths(month, -1);
  const otherIds = state.directory.slice(0, -1).filter(id => full || (parseLedgerSegmentId(id)?.month ?? '') >= recentFrom);
  let segments: LedgerSegmentFile[];
  try {
    segments = await mapLimit(otherIds, READ_CONCURRENCY, async id => {
      checkLoad();
      const segment = await store.readLedgerSegment(id);
      if (!segment) throw new HistoryStoreError('unreadable', `ledger/${id}.json`);
      return segment.value;
    });
  } catch (error) {
    errors.add(error instanceof JobStop ? error.code : ledgerError(error));
    return 'failed';
  }
  summary.ledger.segmentsRead = segments.length + (head ? 1 : 0);
  const headEntries = head?.value.entries ?? [];
  const folded = foldLedger([...segments.map(segment => segment.entries), headEntries]);

  // 3. Snapshots.
  const snapshots = new Map<string, CompanySnapshot>();
  if (!deps.snapshots) errors.add('snapshots_not_configured');
  else {
    try { checkLoad(); } catch (error) { errors.add((error as JobStop).code); return 'failed'; }
    const reader = deps.snapshots;
    await Promise.all(deps.companies.map(async company => {
      try {
        const snapshot = await withTimeout(Promise.resolve().then(() => reader.read(company.id)), SNAPSHOT_READ_TIMEOUT_MS);
        if (snapshot) snapshots.set(company.id, snapshot);
        else summary.ledger.snapshots.missing.push(company.id);
      } catch {
        summary.ledger.snapshots.unreadable.push(company.id);
      }
    }));
    const order = (ids: string[]) => deps.companies.map(company => company.id).filter(id => ids.includes(id));
    summary.ledger.snapshots.read = order([...snapshots.keys()]);
    summary.ledger.snapshots.missing = order(summary.ledger.snapshots.missing);
    summary.ledger.snapshots.unreadable = order(summary.ledger.snapshots.unreadable);
    if (summary.ledger.snapshots.unreadable.length) errors.add('snapshot_unreadable');
  }

  // 4. Merge the pools into the ledger.
  const incoming: LedgerEntry[] = [];
  for (const company of deps.companies) {
    const snapshot = snapshots.get(company.id);
    if (!snapshot) continue;
    const parts = new Map<string, CompanySnapshot['pool']>();
    for (const article of snapshot.pool) {
      const part = article.sourceProvider === 'Marketaux' || article.sourceProvider === 'GDELT' ? article.sourceProvider : 'other';
      parts.set(part, [...(parts.get(part) ?? []), article]);
    }
    for (const [part, pool] of parts) {
      const collection = part === 'Marketaux' ? MARKETAUX_COLLECTION : part === 'GDELT' ? GDELT_COLLECTION : undefined;
      for (const entry of entriesFromSnapshot(company.id, { ...snapshot, pool }, collection ? { collection } : {})) {
        // Stored instants are toISOString text; a provider's own format (e.g. microseconds) is the same instant.
        const normalized = { ...entry, publishedAt: canonical(entry.publishedAt) };
        if (validEntry(normalized)) incoming.push(normalized);
        else summary.ledger.rejectedEntries += 1;
      }
    }
  }
  const current = mergeLedger(folded, incoming);
  const changedKeys = new Set<string>();
  const indexOf = new Map<string, number>();
  for (let i = 0; i < current.length; i += 1) {
    const key = ledgerKey(current[i]!);
    indexOf.set(key, i);
    if (i >= folded.length) { changedKeys.add(key); summary.ledger.newEntries += 1; continue; }
    if (current[i] === folded[i]) continue;
    if (validEntry(current[i]!)) { changedKeys.add(key); summary.ledger.changedEntries += 1; }
    else { current[i] = folded[i]!; summary.ledger.rejectedEntries += 1; }
  }

  // 5. Observations.
  const observations: Record<string, ObservationRecord> = { ...state.observations };
  for (const [companyId, snapshot] of snapshots) {
    const previous = Object.hasOwn(observations, companyId) ? observations[companyId]! : null;
    const next = observeSnapshot(previous, snapshot, start);
    if (next === previous) continue;
    if (previous && next.gaps.length && next.gaps !== previous.gaps) summary.ledger.gapsAdded.push(companyId);
    observations[companyId] = next;
  }

  if (!full) {
    summary.ledger.entries = current.length;
    // Observation-only changes ride along with the next write ("새 기사가 있을 때만").
    if (!changedKeys.size) return 'ran';
    return writeStage({ deps, store, mode, kst, month, start, runId, head, state, observations, current, changedKeys, indexOf,
      headDeadline, lastWriteStart, summary, errors, files: new Map() });
  }

  // 6. Prices.
  let stored: Record<string, PriceSeries> = {};
  let pricesWritable = true;
  try {
    const file = await store.readPrices({ fresh: true });
    if (file) stored = { ...file.value.series } as Record<string, PriceSeries>;
  } catch (error) {
    const code = storeCode(error);
    errors.add(code === 'invalid' || code === 'unsupported_version' ? 'prices_invalid' : 'prices_unreadable');
    pricesWritable = false;
  }
  const series: Record<string, PriceSeries> = { ...stored };
  let pricesChanged = false;
  summary.prices = {};
  const priceStart = now();
  const laneDeadline = Math.min(priceStart + FULL_BUDGET_MS.pricesAfterLoad, start + FULL_BUDGET_MS.pricesEnd);
  let providers: Record<PriceProviderId, PriceProvider> | null = null;
  try { providers = deps.priceProviders(); } catch { errors.add('price_fetch_failed'); }
  if (providers) {
    const lanes = (Object.keys(FETCH_ORDER) as PriceProviderId[]).map(async providerId => {
      const provider = providers![providerId];
      for (const key of FETCH_ORDER[providerId]) {
        const identity = priceIdentity(key);
        if (!identity) continue;
        const before = series[key] ?? null;
        let result: PriceFetchResult;
        try {
          const range = fetchRange(identity, before, now());
          result = await provider.fetch({ identity, ...range }, laneDeadline);
        } catch {
          result = failedFetch(key, now());
        }
        const merged = mergePriceSeries(before, identity, result);
        if (merged.series && merged.series !== before) { series[key] = merged.series; pricesChanged = true; }
        if (merged.code !== 'ok') errors.add(merged.code === 'not_configured' ? 'price_not_configured' : 'price_fetch_failed');
        const bars = merged.series?.bars ?? [];
        summary.prices![key] = {
          code: merged.code, providerCode: result.providerCode, newBars: merged.newBars,
          lastDate: bars.length ? bars[bars.length - 1]!.date : null, ms: result.ms,
        };
      }
    });
    await Promise.all(lanes);
  }

  // 7. Frozen outcomes, statistics and case freezing at one clock.
  const computeAt = now();
  const computeDeadline = Math.min(computeAt + FULL_BUDGET_MS.compute, start + FULL_BUDGET_MS.computeEnd);
  const firstYear = Math.min(kstYear(Date.parse(state.createdAt)), year);
  const weeklyRecords: FrozenWeeklyRecord[] = [];
  const dailyRecords: FrozenDailyRecord[] = [];
  let weeklyCurrent: FrozenWeeklyRecord[] = [];
  let dailyCurrent: FrozenDailyRecord[] = [];
  let weeklyWritable = true;
  let dailyWritable = true;
  for (let y = firstYear; y <= year; y += 1) {
    const fresh = y === year;
    for (const kind of ['weekly', 'daily'] as const) {
      try {
        const file = kind === 'weekly' ? await store.readWeekly(y, { fresh }) : await store.readDaily(y, { fresh });
        const records = file?.value.records ?? [];
        if (kind === 'weekly') {
          weeklyRecords.push(...(records as FrozenWeeklyRecord[]));
          if (fresh) weeklyCurrent = [...(records as FrozenWeeklyRecord[])];
        } else {
          dailyRecords.push(...(records as FrozenDailyRecord[]));
          if (fresh) dailyCurrent = [...(records as FrozenDailyRecord[])];
        }
      } catch (error) {
        const code = storeCode(error);
        errors.add(code === 'invalid' || code === 'unsupported_version' ? 'outcomes_invalid' : 'outcomes_unreadable');
        // Any year: with its records unknown, a "new" freeze could duplicate one of them under a later clock and
        // other values, and the current-year file would carry that copy for good. Nothing of the kind is frozen.
        if (kind === 'weekly') weeklyWritable = false;
        else dailyWritable = false;
      }
    }
  }
  const frozen = frozenIndex(weeklyRecords, dailyRecords);
  let shadowCurrent: ShadowRecord[] = [];
  let shadowWritable = true;
  try {
    shadowCurrent = [...((await store.readShadow(year, { fresh: true }))?.value.records ?? [])];
  } catch (error) {
    const code = storeCode(error);
    errors.add(code === 'invalid' || code === 'unsupported_version' ? 'shadow_invalid' : 'shadow_unreadable');
    shadowWritable = false;
  }

  const frozenAt = iso(computeAt);
  const newWeekly: FrozenWeeklyRecord[] = [];
  const newDaily: FrozenDailyRecord[] = [];
  const patches = new Map<string, LedgerEntry>();
  const statsOut: Record<string, CompanyStats> = Object.create(null);
  const carriedOver: string[] = [];
  summary.stats = { computed: [], carriedOver: [], failed: [], statuses: {}, ms: {} };
  const carry = (companyId: string) => {
    const previous = previousStats && Object.hasOwn(previousStats.companies, companyId) ? previousStats.companies[companyId] : undefined;
    if (previous) { statsOut[companyId] = previous; carriedOver.push(companyId); }
  };
  for (const company of deps.companies) {
    const id = company.id;
    if (now() > computeDeadline) { errors.add('compute_budget'); carry(id); continue; }
    const began = now();
    try {
      const version = priceBasisVersionOf(id);
      if (version === null) throw new RangeError('unpriced company');
      const weekSeen = new Set(newWeekly.filter(record => record.companyId === id).map(record => record.weekAsOf));
      const daySeen = new Set(newDaily.filter(record => record.companyId === id).map(record => record.sessionDate));
      const sink: FreezeSink = {
        week(outcome) {
          const weekAsOf = iso(outcome.weekAsOfMs);
          if (weekSeen.has(weekAsOf) || frozen.weekly.has(frozenKey(id, version, weekAsOf))) return;
          const record: FrozenWeeklyRecord = { companyId: id, weekAsOf, frozenAt, priceBasisVersion: version, outcome };
          if (!validWeekly(record)) return;
          weekSeen.add(weekAsOf);
          newWeekly.push(record);
        },
        day(sessionDate, outcome) {
          if (daySeen.has(sessionDate) || frozen.daily.has(frozenKey(id, version, sessionDate))) return;
          const record: FrozenDailyRecord = { companyId: id, sessionDate, frozenAt, priceBasisVersion: version, outcome };
          if (!validDaily(record)) return;
          daySeen.add(sessionDate);
          newDaily.push(record);
        },
        case(entry, outcome) {
          const patched: LedgerEntry = { ...entry, outcome };
          if (validEntry(patched)) patches.set(ledgerKey(entry), patched);
        },
      };
      const input = companyStatsInput({ companyId: id, entries: current, observations, series, frozen, nowMs: computeAt, sink });
      const stats = companyStats(input);
      if (!validStats(stats)) throw new RangeError('stats rejected');
      // Freeze every known entry's case, not only the ones the display cases touched.
      for (const entry of current) if (entry.companyId === id && isKnownAt(entry, computeAt)) input.outcomes.case(entry);
      statsOut[id] = stats;
      summary.stats.computed.push(id);
      summary.stats.statuses[id] = stats.status;
    } catch {
      errors.add('stats_failed');
      summary.stats.failed.push(id);
      carry(id);
    }
    summary.stats.ms[id] = now() - began;
  }
  for (const id of carriedOver) summary.stats.statuses[id] = statsOut[id]!.status;
  summary.stats.carriedOver = carriedOver;
  // Oldest first within the byte budget; an entry left out keeps no outcome, so the next run's sink offers it again.
  const patchBudget = deps.limits?.patchBytes ?? MAX_PATCH_BYTES_PER_RUN;
  const byAge = [...patches].sort(([keyA, a], [keyB, b]) =>
    Date.parse(a.publishedAt) - Date.parse(b.publishedAt) || (keyA < keyB ? -1 : keyA > keyB ? 1 : 0));
  let patchBytes = 0;
  let applied = 0;
  for (const [key, patched] of byAge) {
    const i = indexOf.get(key);
    if (i === undefined) continue;
    patchBytes += jsonByteLength(patched);
    if (patchBytes > patchBudget) break;
    current[i] = patched;
    changedKeys.add(key);
    applied += 1;
  }
  summary.ledger.outcomePatches = applied;
  summary.ledger.entries = current.length;
  summary.frozen = { weekly: newWeekly.length, daily: newDaily.length, cases: applied, casesDeferred: patches.size - applied };

  // 8. Shadow records.
  const keptKeys = new Set(shadowCurrent.map(record => `${record.recordDate}|${record.companyId}|${record.horizon}`));
  const newShadow: ShadowRecord[] = [];
  summary.shadow = { recorded: 0, kept: 0 };
  for (const company of deps.companies) {
    const ids = companyPriceIdentities(company.id);
    if (!ids) continue;
    const companyStatsRecord = Object.hasOwn(statsOut, company.id) ? statsOut[company.id]! : null;
    for (const record of shadowRecordsFor({ companyId: company.id, exchange: ids.stock.exchange, snapshot: snapshots.get(company.id) ?? null,
      stats: companyStatsRecord, computeAtMs: computeAt, previous: shadowCurrent })) {
      const key = `${record.recordDate}|${record.companyId}|${record.horizon}`;
      if (keptKeys.has(key)) { summary.shadow.kept += 1; continue; }
      if (!validShadow(record)) continue;
      keptKeys.add(key);
      newShadow.push(record);
    }
  }
  summary.shadow.recorded = newShadow.length;

  // 9. Writes.
  const writtenAt = () => iso(now());
  const files = new Map<HistoryFileKind, () => Promise<WriteResult>>();
  if (summary.stats.computed.length) {
    files.set('stats', () => store.writeStats({ version: HISTORY_VERSIONS.stats, computedAt: frozenAt, runId, companies: statsOut, carriedOver }));
  }
  if (newShadow.length && shadowWritable) {
    files.set('shadow', () => store.writeShadow({ version: HISTORY_VERSIONS.shadow, year, writtenAt: writtenAt(), records: [...shadowCurrent, ...newShadow] }));
  }
  if (pricesChanged && pricesWritable) {
    files.set('prices', () => store.writePrices({ version: HISTORY_VERSIONS.prices, writtenAt: writtenAt(), series }));
  }
  if (newDaily.length && dailyWritable) {
    files.set('daily', () => store.writeDaily({ version: HISTORY_VERSIONS.outcomes, kind: 'daily', year, writtenAt: writtenAt(), records: [...dailyCurrent, ...newDaily] }));
  }
  if (newWeekly.length && weeklyWritable) {
    files.set('weekly', () => store.writeWeekly({ version: HISTORY_VERSIONS.outcomes, kind: 'weekly', year, writtenAt: writtenAt(), records: [...weeklyCurrent, ...newWeekly] }));
  }
  return writeStage({ deps, store, mode, kst, month, start, runId, head, state, observations, current, changedKeys, indexOf,
    headDeadline, lastWriteStart, summary, errors, files, year });
}

interface WriteStageInput {
  deps: HistoryJobDeps; store: HistoryStore; mode: HistoryJobMode; kst: string; month: string; start: number; runId: string;
  head: StoredFile<LedgerSegmentFile> | null; state: LedgerState; observations: Record<string, ObservationRecord>;
  current: LedgerEntry[]; changedKeys: Set<string>; indexOf: Map<string, number>;
  headDeadline: number; lastWriteStart: number; summary: HistoryJobSummary; errors: Set<HistoryJobError>;
  files: Map<HistoryFileKind, () => Promise<WriteResult>>; year?: number;
}

const fileName = (kind: HistoryFileKind, year: number | undefined, headId: string): string =>
  kind === 'head' ? `ledger/${headId}.json` : kind === 'stats' ? STATS_FILE : kind === 'prices' ? PRICES_FILE : `${kind}/${year}.json`;

async function writeStage(input: WriteStageInput): Promise<StageResult> {
  const { deps, store, mode, kst, month, runId, head, state, summary, errors, files, year } = input;
  const now = deps.now;
  const used = usedWrites(state.journal, kst);
  const fullDoneToday = state.journal.kstDate === kst && state.journal.fullDone;
  const allowance = allowedWrites(state.journal, kst, mode);
  summary.writes.usedBefore = used;
  summary.writes.allowance = Math.max(0, allowance);
  const changed = new Set<HistoryFileKind>(['head', ...files.keys()]);

  // Head content and target segment.
  const headEntries = (): LedgerEntry[] => {
    const entries = head?.value.entries ?? [];
    const inHead = new Set<string>();
    const result = entries.map(entry => {
      const key = ledgerKey(entry);
      inHead.add(key);
      return input.changedKeys.has(key) ? input.current[input.indexOf.get(key)!]! : entry;
    });
    for (const entry of input.current) if (input.changedKeys.has(ledgerKey(entry)) && !inHead.has(ledgerKey(entry))) result.push(entry);
    return result;
  };
  // writes is set once the selection is known; it is one digit either way, so the size decision below holds.
  const journal = { kstDate: kst, writes: used, fullDone: fullDoneToday || mode === 'full' };
  const stateFor = (directory: string[]): LedgerState => ({
    createdAt: state.createdAt, directory, observations: input.observations, journal: { ...journal }, writeToken: runId,
  });
  const headMonth = head ? parseLedgerSegmentId(head.value.segment) : null;
  const rollover = deps.limits?.rolloverBytes ?? LEDGER_ROLLOVER_BYTES;
  const sameMonth = head !== null && headMonth !== null && headMonth.month === month;
  const inPlace = (): LedgerSegmentFile => ({
    version: HISTORY_VERSIONS.ledger, segment: head!.value.segment, writtenAt: iso(now()), state: stateFor([...state.directory]), entries: headEntries(),
  });
  const rewriteInPlace = sameMonth && jsonByteLength(inPlace()) <= rollover;
  const targetId = rewriteInPlace ? head!.value.segment : sameMonth ? ledgerSegmentId(month, headMonth!.shard + 1) : ledgerSegmentId(month, 0);
  // The reservation must be one conditional write on the head this run read. A new shard in that head's own month
  // is createOnly on another file, and a duplicate run whose content still fits would rewrite the old head (ifMatch)
  // beside it: both would pass and the new head's journal would miss the other run's writes. So the old head is
  // sealed first under the same ifMatch (journal and token only, entries unchanged). A new month's first segment
  // needs no seal: runs that start on the same KST day pick the same id, and createOnly lets one of them through.
  const seal = sameMonth && !rewriteInPlace;
  const { selected, deferred } = selectWrites(changed, allowance - (seal ? 1 : 0));
  journal.writes = used + selected.length + (seal ? 1 : 0);

  const headFileName = fileName('head', year, targetId);
  if (!selected.length) {
    errors.add('write_cap');
    summary.writes.deferred = deferred.map(kind => kind === 'head' ? headFileName : fileName(kind, year, ''));
    return 'ran';
  }
  if (deferred.length) errors.add('write_cap');
  let segment: LedgerSegmentFile;
  let condition: LedgerWriteCondition;
  if (rewriteInPlace) {
    segment = inPlace();
    condition = { kind: 'ifMatch', etag: head!.etag };
  } else {
    summary.ledger.rolledOver = head !== null;
    segment = {
      version: HISTORY_VERSIONS.ledger, segment: targetId, writtenAt: iso(now()), state: stateFor([...state.directory, targetId]),
      entries: input.current.filter(entry => input.changedKeys.has(ledgerKey(entry))),
    };
    condition = { kind: 'createOnly' };
  }
  const deferredNames = deferred.map(kind => fileName(kind, year, ''));
  const othersAfterHead = () => selected.filter(kind => kind !== 'head').map(kind => fileName(kind, year, ''));
  if (now() > input.headDeadline) {
    errors.add('write_deadline');
    summary.writes.deferred = [headFileName, ...othersAfterHead(), ...deferredNames];
    return 'failed';
  }
  const headWrites: Array<{ file: string; value: LedgerSegmentFile; condition: LedgerWriteCondition }> = [];
  if (seal) {
    const sealed: LedgerSegmentFile = {
      ...head!.value, writtenAt: iso(now()), state: { ...head!.value.state, journal: { ...journal }, writeToken: runId },
    };
    headWrites.push({ file: fileName('head', year, head!.value.segment), value: sealed, condition: { kind: 'ifMatch', etag: head!.etag } });
  }
  headWrites.push({ file: headFileName, value: segment, condition });
  for (const write of headWrites) {
    try {
      await store.writeLedgerSegment(write.value, write.condition);
      summary.writes.done.push(write.file);
    } catch (error) {
      const code = storeCode(error) ?? 'write_failed';
      errors.add(writeError(code));
      summary.writes.failed.push({ file: write.file, code });
      summary.writes.deferred = [...(write.file === headFileName ? [] : [headFileName]), ...othersAfterHead(), ...deferredNames];
      summary.ledger.rolledOver = false;
      return 'failed';
    }
  }
  summary.ledger.head = targetId;
  for (const kind of selected) {
    if (kind === 'head') continue;
    const name = fileName(kind, year, '');
    if (now() > input.lastWriteStart) { errors.add('write_deadline'); summary.writes.deferred.push(name); continue; }
    try {
      await files.get(kind)!();
      summary.writes.done.push(name);
    } catch (error) {
      const code = storeCode(error) ?? 'write_failed';
      errors.add(code === 'too_large' ? 'too_large' : 'write_failed');
      summary.writes.failed.push({ file: name, code });
    }
  }
  summary.writes.deferred.push(...deferredNames);
  return 'ran';
}

/** No I/O, timers or throws at creation; everything is built inside run(). */
export function createHistoryService(env: NodeJS.ProcessEnv = process.env, overrides: Partial<HistoryJobDeps> = {}): HistoryService {
  return {
    run(mode) {
      let deps: HistoryJobDeps;
      try {
        deps = {
          store: 'store' in overrides ? overrides.store ?? null : createBlobHistoryStore(env),
          snapshots: 'snapshots' in overrides ? overrides.snapshots ?? null : createBlobSnapshotStore(env),
          priceProviders: overrides.priceProviders ?? (() => createPriceProviders(env)),
          companies: overrides.companies ?? coreCompanies,
          now: overrides.now ?? Date.now,
          randomId: overrides.randomId ?? randomUUID,
          redactKeys: overrides.redactKeys ?? [env.KR_PRICE_API_KEY, env.US_PRICE_API_KEY, env.CRON_SECRET],
          ...(overrides.limits ? { limits: overrides.limits } : {}),
        };
      } catch {
        deps = { store: null, snapshots: null, priceProviders: () => createPriceProviders({}), companies: [], now: Date.now, randomId: randomUUID, redactKeys: [] };
      }
      return runHistoryJob(deps, mode);
    },
  };
}
