import type { get as blobGet, put as blobPut } from '@vercel/blob';
import {
  companies as coreCompanies, type HistoryReadyStatus, type Horizon, type Signal, type Verdict,
} from '../packages/core/src/index.js';
import { DAILY_WRITE_CAP, LEDGER_PROBE_MONTHS, LEDGER_ROLLOVER_BYTES, kstDate, kstMonth, kstYear } from './history-job.js';
import type { LedgerEntry } from './history-ledger.js';
import {
  HistoryStoreError, MAX_FILE_BYTES, PRICES_FILE, STATS_FILE, createBlobHistoryStore, jsonByteLength,
  type DailyOutcomesFile, type HistoryStore, type HistoryStoreErrorCode, type LedgerSegmentFile, type ObservationGap,
  type PricesFile, type ReadOptions, type ShadowFile, type StatsFile, type StoredFile, type WeeklyOutcomesFile, type WriteJournal,
} from './history-store.js';
import { PRICE_IDENTITY, PRICE_KEY_ENV, companyPriceIdentities, type PriceIdentity, type PriceProviderId } from './price-provider.js';

// Read-only status of the historical-news-insights files (plan step 5, appendix E-2 and E-3),
// for `npm run history:status`. Invariants:
// - Reads only. Every read goes through readOnlyHistoryStore, which has no write method, and the
//   Blob variant is built on a put that always throws, so nothing here can change a stored file.
// - Every file may be missing or unreadable: each is reported with its state and the rest continue.
//   readHistoryStatus never throws for a store failure.
// - Nothing stored as free text reaches the summary: names come from the core company list and the
//   price identities, codes from fixed tables (anything else becomes unknown_code), and everything
//   else is a validated instant, date, count or segment id. Titles, URLs and run ids are never read out.
// - No process.env access and no clock: the token and nowMs come in as arguments.
// - Sizes are JSON byte lengths of the parsed files, the measure the job's own ledger rollover uses.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const KST_OFFSET_MS = 9 * HOUR;
const FRESH: ReadOptions = { fresh: true };

/** The only variable the status command reads its Blob token from (never BLOB_READ_WRITE_TOKEN). */
export const STATUS_TOKEN_ENV = 'HISTORY_STATUS_BLOB_TOKEN';
/** Ledger segments read for the totals besides the head, newest first. */
export const MAX_STATUS_SEGMENTS = 60;
const SEGMENT_READ_CONCURRENCY = 4;
/** stats.json older than this: the 15 KST full job may not have run. */
export const STATS_STALE_MS = 26 * HOUR;
/** 4 of the 5 MiB a file may hold. */
export const NEAR_CAP_BYTES = 4 * 1024 * 1024;
const RECENT_GAP_MS = 7 * DAY;
const SNAPSHOT_STALE_MS = 48 * HOUR;
/** A cron run starts anywhere in its hour; computedAt and writes follow within its 300 s. */
const RUN_SLACK_MINUTES = 5;
/** A full run fetches every series before computedAt: a last success further back is from an earlier run. */
const PRICE_REFRESH_SLACK_MS = 10 * 60_000;
/** By 16:10 KST a 15-hour full run has ended (Vercel stops functions at 300 s). */
const FULL_DUE_MINUTES = 16 * 60 + 10;
const EVENING_LEDGER_MINUTES = 21 * 60;

// ---------------------------------------------------------------------------
// Read-only access
// ---------------------------------------------------------------------------

export type ReadOnlyHistoryStore = Pick<HistoryStore,
  'readStats' | 'readPrices' | 'readShadow' | 'readWeekly' | 'readDaily' | 'readLedgerSegment' | 'findLedgerHead'>;

/** The read methods of `source` and nothing else: no write method, no counters. */
export function readOnlyHistoryStore(source: ReadOnlyHistoryStore): ReadOnlyHistoryStore {
  return Object.freeze({
    readStats: (o?: ReadOptions) => source.readStats(o),
    readPrices: (o?: ReadOptions) => source.readPrices(o),
    readShadow: (year: number, o?: ReadOptions) => source.readShadow(year, o),
    readWeekly: (year: number, o?: ReadOptions) => source.readWeekly(year, o),
    readDaily: (year: number, o?: ReadOptions) => source.readDaily(year, o),
    readLedgerSegment: (id: string, o?: ReadOptions) => source.readLedgerSegment(id, o),
    findLedgerHead: (kstMonthText: string, maxMonthsBack?: number) => source.findLedgerHead(kstMonthText, maxMonthsBack),
  });
}

type BlobGet = typeof blobGet;
type BlobPut = typeof blobPut;

/** What the read-only Blob store is built on: every get carries the token, and put always throws. */
export function readOnlyBlobFunctions(token: string, get: BlobGet): { get: BlobGet; put: BlobPut } {
  return {
    get: (pathname, options) => get(pathname, { ...options, token }),
    put: () => { throw new Error('read_only'); },
  };
}

/**
 * The Blob history store of the status command, from a read-write token passed in explicitly. The store sees
 * { BLOB_READ_WRITE_TOKEN: token } only; process.env is neither read nor set.
 */
export function createReadOnlyBlobHistoryStore(token: string, blob: { get: BlobGet }): ReadOnlyHistoryStore {
  const store = createBlobHistoryStore({ BLOB_READ_WRITE_TOKEN: token }, readOnlyBlobFunctions(token, blob.get));
  if (!store) throw new RangeError('missing_token');
  return readOnlyHistoryStore(store);
}

/** A Vercel Blob read-write token is vercel_blob_rw_<store id>_<secret>; the SDK takes the store id from the fourth part. */
export function blobTokenProblem(value: string | undefined): 'missing' | 'format' | null {
  const token = value?.trim() ?? '';
  if (!token) return 'missing';
  return /^vercel_blob_rw_[^_\s]+_\S+$/.test(token) ? null : 'format';
}

/** One line: where the token is (current Vercel docs: the read-write token exists only when the store connection adds it). */
export const MISSING_TOKEN_LINE = `history:status 중단: D:\\moneycast\\.env에 ${STATUS_TOKEN_ENV}이 없습니다. `
  + 'Vercel → Storage → 이 프로젝트의 Blob 스토어에서 읽기·쓰기 토큰(vercel_blob_rw_로 시작하는 BLOB_READ_WRITE_TOKEN 값, '
  + '스토어 화면의 .env.local 부분이나 프로젝트 환경변수에 있음)을 복사해 '
  + `${STATUS_TOKEN_ENV}=토큰 한 줄로 넣고 다시 실행하세요. 토큰이 없으면 스토어의 Projects 탭 → 프로젝트 옆 ⋯ → Update Project Connection에서 `
  + '"Add a read-write token env var to this connection"을 켜면 생깁니다. BLOB_READ_WRITE_TOKEN 이름으로 넣거나 채팅에 붙이지 마세요.';
export const TOKEN_FORMAT_LINE = `history:status 중단: ${STATUS_TOKEN_ENV} 값의 형식이 맞지 않습니다. vercel_blob_rw_로 시작하는 토큰 값만 `
  + `${STATUS_TOKEN_ENV}=토큰 한 줄로 넣으세요(따옴표 안의 값만, 다른 변수 이름은 빼고).`;

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export type FileState = 'ok' | 'missing' | HistoryStoreErrorCode;

export interface FileStatus {
  /** Store file name relative to news-history/v1/; null for a ledger head that was not found. */
  file: string | null;
  state: FileState;
  /** JSON bytes of the parsed file; null unless state is ok. */
  bytes: number | null;
}

export interface CompanyLedgerStatus {
  companyId: string; name: string;
  /** Unique entries over the segments read. */
  entries: number;
  observedFrom: string | null; lastSnapshotAt: string | null;
  gaps: number;
  /** Gaps detected within 7 days of the check. */
  recentGaps: number;
  latestGap: ObservationGap | null;
}

export interface LedgerStatus extends FileStatus {
  segment: string | null; writtenAt: string | null; createdAt: string | null;
  journal: WriteJournal | null;
  /** Segment ids in the head's directory, the head included. */
  directory: number;
  headEntries: number;
  /** Unique (company, article) entries over the segments read; complete when segmentsFailed and segmentsSkipped are empty. */
  totalEntries: number;
  /** Entries of companies outside the core list (counted, never named). */
  otherEntries: number;
  /** The head included. */
  segmentsRead: number;
  segmentsFailed: Array<{ id: string; state: FileState }>;
  /** Older segments beyond MAX_STATUS_SEGMENTS, not read. */
  segmentsSkipped: number;
  companies: CompanyLedgerStatus[];
  otherObservations: number;
}

export interface CompanyStatsStatus {
  companyId: string; name: string;
  status: HistoryReadyStatus | 'missing';
  /** Verdicts for positive and negative news; null when the company has no directions. */
  verdicts: Record<Horizon, { positive: Verdict; negative: Verdict } | null>;
  lastPriceDate: string | null;
  carriedOver: boolean;
}

export interface StatsStatus extends FileStatus {
  computedAt: string | null;
  companies: CompanyStatsStatus[];
  /** Core company ids copied unchanged from the previous file. */
  carriedOver: string[];
  otherCompanies: number;
}

export interface SeriesStatus {
  key: string; label: string; provider: PriceProviderId;
  bars: number; firstDate: string | null; lastDate: string | null;
  lastSuccessAt: string;
  /** code: a known price code or http_NNN, else unknown_code. */
  lastAttempt: { at: string; code: string };
  rebasedAt: string | null;
}

export interface PricesStatus extends FileStatus {
  writtenAt: string | null;
  /** In PRICE_IDENTITY order. */
  series: SeriesStatus[];
  /** Known series keys absent from the file. */
  missing: string[];
  otherSeries: number;
}

export interface ShadowEntryStatus {
  companyId: string; name: string; horizon: Horizon;
  baseline: Signal; integrated: Signal; verdict: Verdict | null; stale: boolean; statsStatus: HistoryReadyStatus | 'missing';
}

export interface ShadowStatus extends FileStatus {
  year: number;
  records: number;
  latestDate: string | null;
  latestRecordedAt: string | null;
  /** Priced core companies × horizons recorded on latestDate, in company then horizon order. */
  latest: ShadowEntryStatus[];
  expectedPerDay: number;
}

export interface OutcomesStatus extends FileStatus { year: number; records: number }

export type StatusWarningCode =
  | 'nothing_stored' | 'read_errors' | 'ledger_missing' | 'journal_future' | 'write_cap'
  | 'observation_missing' | 'observation_gap' | 'observation_stale' | 'ledger_rollover'
  | 'stats_missing' | 'stats_stale' | 'stats_not_written' | 'stats_at_ledger_hour' | 'stats_off_schedule' | 'stats_carried_over'
  | 'stats_company_missing' | 'prices_missing' | 'price_series_missing' | 'price_attempt' | 'price_stale'
  | 'shadow_behind' | 'shadow_count' | 'file_near_cap';

export interface StatusWarning {
  code: StatusWarningCode;
  /** warn: needs a look; info: expected in normal operation. */
  level: 'warn' | 'info';
  text: string;
  hint: string;
}

export interface HistoryStatus {
  checkedAt: string;
  kstDate: string;
  ledger: LedgerStatus;
  stats: StatsStatus;
  prices: PricesStatus;
  shadow: ShadowStatus;
  weekly: OutcomesStatus;
  daily: OutcomesStatus;
  warnings: StatusWarning[];
}

// ---------------------------------------------------------------------------
// Names and time
// ---------------------------------------------------------------------------

const COMPANY_NAMES: ReadonlyMap<string, string> = new Map(coreCompanies.map(company => [company.id, company.name]));
const PRICED = coreCompanies.filter(company => companyPriceIdentities(company.id) !== null);
const HORIZONS: readonly Horizon[] = ['day', 'week'];
export const SHADOW_RECORDS_PER_DAY = PRICED.length * HORIZONS.length;
const KNOWN_SERIES = new Set(PRICE_IDENTITY.map(identity => identity.key));
const nameOf = (companyId: string): string => COMPANY_NAMES.get(companyId) ?? companyId;

function seriesLabel(identity: PriceIdentity): string {
  if (identity.companyId) return nameOf(identity.companyId);
  return identity.key === 'krx:069500' ? 'KODEX 200' : identity.providerSymbol;
}

const iso = (ms: number): string => new Date(ms).toISOString();
const kstShifted = (ms: number): Date => new Date(ms + KST_OFFSET_MS);
/** Minutes since KST midnight (KST has no daylight saving time). */
function kstMinutes(ms: number): number {
  const shifted = kstShifted(ms);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}
/** "2026-11-12 15:23 KST" */
export function formatKst(instant: string): string {
  const text = kstShifted(Date.parse(instant)).toISOString();
  return `${text.slice(0, 10)} ${text.slice(11, 16)} KST`;
}
function formatGap(gap: ObservationGap): string {
  const start = kstShifted(Date.parse(gap.start)).toISOString();
  const end = kstShifted(Date.parse(gap.end)).toISOString();
  return `${start.slice(0, 10)} ${start.slice(11, 16)}~${end.slice(0, 10)} ${end.slice(11, 16)} KST`;
}
/** KB below 1 MiB (one decimal under 10 KB), MB with two decimals above. */
export function formatBytes(bytes: number): string {
  const kb = bytes / 1024;
  if (kb < 10) return `${kb.toFixed(1)}KB`;
  if (kb < 1024) return `${Math.round(kb)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}
const count = (n: number): string => n.toLocaleString('en-US');

type RunWindow = 'ledger_08' | 'full_15' | 'ledger_21' | 'other';
/** Which scheduled run an instant falls in: 08 and 21 KST ledger steps, the 15 KST full job (vercel.json). */
function runWindow(instant: string): RunWindow {
  const minutes = kstMinutes(Date.parse(instant));
  const within = (hour: number) => minutes >= hour * 60 && minutes < (hour + 1) * 60 + RUN_SLACK_MINUTES;
  return within(8) ? 'ledger_08' : within(15) ? 'full_15' : within(21) ? 'ledger_21' : 'other';
}
const WINDOW_LABELS: Record<RunWindow, string> = {
  ledger_08: '08시대 실행', full_15: '15시대 전체 작업', ledger_21: '21시대 실행', other: '예약 시각 밖',
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

type Read<T> = { state: 'ok'; file: StoredFile<T> } | { state: Exclude<FileState, 'ok'>; file: null };

const stateOf = (error: unknown): HistoryStoreErrorCode => error instanceof HistoryStoreError ? error.code : 'unreadable';

async function attempt<T>(read: () => Promise<StoredFile<T> | null>): Promise<Read<T>> {
  try {
    const file = await read();
    return file ? { state: 'ok', file } : { state: 'missing', file: null };
  } catch (error) {
    return { state: stateOf(error), file: null };
  }
}

async function mapLimit<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await task(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function emptyLedger(state: FileState, file: string | null): LedgerStatus {
  return {
    file, state, bytes: null, segment: null, writtenAt: null, createdAt: null, journal: null, directory: 0, headEntries: 0,
    totalEntries: 0, otherEntries: 0, segmentsRead: 0, segmentsFailed: [], segmentsSkipped: 0, otherObservations: 0,
    companies: coreCompanies.map(company => ({
      companyId: company.id, name: company.name, entries: 0, observedFrom: null, lastSnapshotAt: null, gaps: 0, recentGaps: 0, latestGap: null,
    })),
  };
}

/** Store-made file names only ('ledger/2026-11.json'); anything else is not shown. */
const safeFileName = (name: string): string | null => /^[a-z]+(?:\/[0-9]{4}(?:-[0-9]{2}(?:\.[0-9]{1,3})?)?)?\.json$/.test(name) ? name : null;

async function readLedger(store: ReadOnlyHistoryStore, nowMs: number): Promise<LedgerStatus> {
  let head: StoredFile<LedgerSegmentFile> | null;
  try {
    head = await store.findLedgerHead(kstMonth(nowMs), LEDGER_PROBE_MONTHS);
  } catch (error) {
    return emptyLedger(stateOf(error), error instanceof HistoryStoreError ? safeFileName(error.file) : null);
  }
  if (!head) return emptyLedger('missing', null);
  const value = head.value;
  const others = value.state.directory.slice(0, -1);
  const toRead = others.slice(-MAX_STATUS_SEGMENTS);
  const reads = await mapLimit(toRead, SEGMENT_READ_CONCURRENCY, id => attempt(() => store.readLedgerSegment(id, FRESH)));
  // An entry changed later is written again into a newer segment; the ledger counts it once.
  const seen = new Map<string, Set<string>>();
  const add = (entries: readonly LedgerEntry[]) => {
    for (const entry of entries) {
      let ids = seen.get(entry.companyId);
      if (!ids) seen.set(entry.companyId, ids = new Set());
      ids.add(entry.id);
    }
  };
  add(value.entries);
  const segmentsFailed: LedgerStatus['segmentsFailed'] = [];
  reads.forEach((read, i) => {
    if (read.state === 'ok') add(read.file.value.entries);
    else segmentsFailed.push({ id: toRead[i]!, state: read.state });
  });
  let totalEntries = 0;
  let otherEntries = 0;
  for (const [companyId, ids] of seen) {
    totalEntries += ids.size;
    if (!COMPANY_NAMES.has(companyId)) otherEntries += ids.size;
  }
  const observations = value.state.observations;
  return {
    file: `ledger/${value.segment}.json`, state: 'ok', bytes: jsonByteLength(value),
    segment: value.segment, writtenAt: value.writtenAt, createdAt: value.state.createdAt, journal: { ...value.state.journal },
    directory: value.state.directory.length, headEntries: value.entries.length, totalEntries, otherEntries,
    segmentsRead: 1 + reads.filter(read => read.state === 'ok').length, segmentsFailed, segmentsSkipped: others.length - toRead.length,
    otherObservations: Object.keys(observations).filter(id => !COMPANY_NAMES.has(id)).length,
    companies: coreCompanies.map(company => {
      const record = Object.hasOwn(observations, company.id) ? observations[company.id] : undefined;
      const gaps = record?.gaps ?? [];
      let latestGap: ObservationGap | null = null;
      for (const gap of gaps) if (!latestGap || Date.parse(gap.start) > Date.parse(latestGap.start)) latestGap = gap;
      return {
        companyId: company.id, name: company.name, entries: seen.get(company.id)?.size ?? 0,
        observedFrom: record?.observedFrom ?? null, lastSnapshotAt: record?.lastSnapshotAt ?? null, gaps: gaps.length,
        recentGaps: gaps.filter(gap => nowMs - Date.parse(gap.detectedAt) <= RECENT_GAP_MS).length,
        latestGap: latestGap ? { ...latestGap } : null,
      };
    }),
  };
}

function statsStatus(read: Read<StatsFile>): StatsStatus {
  const missing = (companyId: string, name: string): CompanyStatsStatus => ({
    companyId, name, status: 'missing', verdicts: { day: null, week: null }, lastPriceDate: null, carriedOver: false,
  });
  if (read.state !== 'ok') {
    return { file: STATS_FILE, state: read.state, bytes: null, computedAt: null, carriedOver: [], otherCompanies: 0,
      companies: coreCompanies.map(company => missing(company.id, company.name)) };
  }
  const value = read.file.value;
  const carried = new Set(value.carriedOver);
  return {
    file: STATS_FILE, state: 'ok', bytes: jsonByteLength(value), computedAt: value.computedAt,
    carriedOver: coreCompanies.filter(company => carried.has(company.id)).map(company => company.id),
    otherCompanies: Object.keys(value.companies).filter(id => !COMPANY_NAMES.has(id)).length,
    companies: coreCompanies.map(company => {
      const stats = Object.hasOwn(value.companies, company.id) ? value.companies[company.id] : undefined;
      if (!stats) return missing(company.id, company.name);
      const verdicts = (horizon: Horizon) => {
        const directions = stats.horizons[horizon].directions;
        return directions ? { positive: directions.positive.verdict, negative: directions.negative.verdict } : null;
      };
      return {
        companyId: company.id, name: company.name, status: stats.status, verdicts: { day: verdicts('day'), week: verdicts('week') },
        lastPriceDate: stats.dataAsOf.lastPriceDate, carriedOver: carried.has(company.id),
      };
    }),
  };
}

const PRICE_CODE_LABELS: ReadonlyMap<string, string> = new Map([
  ['ok', '정상'], ['not_configured', '가격 키 없음'], ['unsafe_env', '안전하지 않은 서버 실행 설정'], ['stopped', '앞선 오류로 호출 중단'],
  ['skipped_budget', '시간·호출 한도로 건너뜀'], ['timeout', '응답 시간 초과'], ['network', '네트워크 오류'], ['too_large', '응답이 너무 큼'],
  ['echoed_secret', '응답에 키가 섞여 버림'], ['bad_json', '응답 형식 오류'], ['provider_error', '제공자 오류 응답(하루 한도 초과 포함)'],
  ['truncated', '응답이 잘림'], ['identity_mismatch', '다른 종목 응답'], ['calendar_mismatch', '거래일 달력 불일치'],
  ['duplicate_dates', '같은 날짜 중복'], ['not_adjusted', '분할 조정 안 된 응답'], ['bad_timestamp', '시각 형식 오류'],
  ['unknown_code', '알 수 없는 코드'],
]);

/** A stored attempt code as shown: the price layer's codes and http_NNN as they are, anything else unknown_code. */
export function safePriceCode(code: string): string {
  return PRICE_CODE_LABELS.has(code) || /^http_\d{1,3}$/.test(code) ? code : 'unknown_code';
}

function priceCodeLabel(code: string): string {
  const known = PRICE_CODE_LABELS.get(code);
  if (known) return known;
  const status = /^http_(\d{1,3})$/.exec(code)?.[1] ?? '';
  if (status === '401' || status === '403') return '키 거부(인증 실패)';
  if (status === '429') return '호출 한도 초과';
  if (/^5\d\d$/.test(status)) return '제공자 서버 오류';
  return 'HTTP 오류';
}

function pricesStatus(read: Read<PricesFile>): PricesStatus {
  if (read.state !== 'ok') return { file: PRICES_FILE, state: read.state, bytes: null, writtenAt: null, series: [], missing: [], otherSeries: 0 };
  const value = read.file.value;
  const series: SeriesStatus[] = [];
  const missing: string[] = [];
  for (const identity of PRICE_IDENTITY) {
    const stored = Object.hasOwn(value.series, identity.key) ? value.series[identity.key] : undefined;
    if (!stored) { missing.push(identity.key); continue; }
    series.push({
      key: identity.key, label: seriesLabel(identity), provider: identity.provider, bars: stored.bars.length,
      firstDate: stored.bars[0]?.date ?? null, lastDate: stored.bars[stored.bars.length - 1]?.date ?? null,
      lastSuccessAt: stored.lastSuccessAt, lastAttempt: { at: stored.lastAttempt.at, code: safePriceCode(stored.lastAttempt.code) },
      rebasedAt: stored.rebasedAt,
    });
  }
  return {
    file: PRICES_FILE, state: 'ok', bytes: jsonByteLength(value), writtenAt: value.writtenAt, series, missing,
    otherSeries: Object.keys(value.series).filter(key => !KNOWN_SERIES.has(key)).length,
  };
}

function shadowStatus(read: Read<ShadowFile>, year: number): ShadowStatus {
  const base = { file: `shadow/${year}.json`, year, expectedPerDay: SHADOW_RECORDS_PER_DAY };
  if (read.state !== 'ok') return { ...base, state: read.state, bytes: null, records: 0, latestDate: null, latestRecordedAt: null, latest: [] };
  const records = read.file.value.records;
  let latestDate: string | null = null;
  for (const record of records) if (latestDate === null || record.recordDate > latestDate) latestDate = record.recordDate;
  const onDate = records.filter(record => record.recordDate === latestDate);
  let latestRecordedAt: string | null = null;
  for (const record of onDate) if (latestRecordedAt === null || Date.parse(record.recordedAt) > Date.parse(latestRecordedAt)) latestRecordedAt = record.recordedAt;
  const latest = PRICED.flatMap(company => HORIZONS.flatMap(horizon => {
    const record = onDate.find(item => item.companyId === company.id && item.horizon === horizon);
    return record ? [{
      companyId: company.id, name: company.name, horizon, baseline: record.baseline, integrated: record.integrated,
      verdict: record.verdict, stale: record.stale, statsStatus: record.statsStatus,
    }] : [];
  }));
  return { ...base, state: 'ok', bytes: jsonByteLength(read.file.value), records: records.length, latestDate, latestRecordedAt, latest };
}

function outcomesStatus(read: Read<WeeklyOutcomesFile | DailyOutcomesFile>, kind: 'weekly' | 'daily', year: number): OutcomesStatus {
  const file = `${kind}/${year}.json`;
  return read.state === 'ok'
    ? { file, state: 'ok', bytes: jsonByteLength(read.file.value), year, records: read.file.value.records.length }
    : { file, state: read.state, bytes: null, year, records: 0 };
}

/**
 * What the history files hold at nowMs, by fresh reads only (findLedgerHead from the current KST month, every other
 * ledger segment of the head's directory up to MAX_STATUS_SEGMENTS, stats.json, prices.json and the current KST
 * year's shadow, weekly and daily files). A file that is missing or fails is reported, never thrown.
 */
export async function readHistoryStatus(source: ReadOnlyHistoryStore, nowMs: number): Promise<HistoryStatus> {
  if (!Number.isFinite(nowMs)) throw new RangeError('invalid_now');
  const store = readOnlyHistoryStore(source);
  const year = kstYear(nowMs);
  const [ledger, stats, prices, shadow, weekly, daily] = await Promise.all([
    readLedger(store, nowMs),
    attempt(() => store.readStats(FRESH)).then(statsStatus),
    attempt(() => store.readPrices(FRESH)).then(pricesStatus),
    attempt(() => store.readShadow(year, FRESH)).then(read => shadowStatus(read, year)),
    attempt(() => store.readWeekly(year, FRESH)).then(read => outcomesStatus(read, 'weekly', year)),
    attempt(() => store.readDaily(year, FRESH)).then(read => outcomesStatus(read, 'daily', year)),
  ]);
  const parts = { checkedAt: iso(nowMs), kstDate: kstDate(nowMs), ledger, stats, prices, shadow, weekly, daily };
  return { ...parts, warnings: deriveWarnings(parts, nowMs) };
}

/** True when not one file could be read (every state an error): a token or network problem rather than data. */
export function everyReadFailed(status: HistoryStatus): boolean {
  return filesOf(status).every(file => isError(file.state));
}

// ---------------------------------------------------------------------------
// Derived checks
// ---------------------------------------------------------------------------

const STATE_LABELS: Record<FileState, string> = {
  ok: '정상', missing: '아직 없음', unreadable: '읽기 실패', timeout: '시간 초과', too_large: '5MB 초과', invalid: '형식 오류',
  unsupported_version: '다른 저장 형식 버전', conflict: '읽기 실패', write_failed: '읽기 실패',
};
const isError = (state: FileState): boolean => state !== 'ok' && state !== 'missing';
type StatusParts = Omit<HistoryStatus, 'warnings'>;
const filesOf = (s: StatusParts): FileStatus[] => [s.ledger, s.stats, s.prices, s.shadow, s.weekly, s.daily];
const names = (items: ReadonlyArray<{ name: string }>): string => items.map(item => item.name).join(', ');
/** The head's journal says a full run wrote the ledger today (KST): the head is that run's first write, stats.json its last. */
function fullJobWroteToday(s: StatusParts): boolean {
  const journal = s.ledger.state === 'ok' ? s.ledger.journal : null;
  return journal !== null && journal.kstDate === s.kstDate && journal.fullDone;
}

function deriveWarnings(s: StatusParts, nowMs: number): StatusWarning[] {
  const out: StatusWarning[] = [];
  const add = (level: StatusWarning['level'], code: StatusWarningCode, text: string, hint: string) => out.push({ code, level, text, hint });
  const files = filesOf(s);
  if (files.every(file => file.state === 'missing')) {
    add('warn', 'nothing_stored', '아직 실행 기록이 없습니다.',
      '배포 뒤 첫 예약 실행(08시대 장부 단계나 15시대 전체 작업) 전이면 정상입니다. 그 뒤에도 같으면 Vercel 환경변수 HISTORY_INSIGHTS가 '
      + 'collect인지(값을 바꾼 뒤에는 다시 배포해야 적용됨), 이 토큰이 이 프로젝트 Blob 스토어의 것인지 확인하세요.');
    return out;
  }
  const failed = [
    ...files.filter(file => isError(file.state)).map(file => `${file.file ?? '장부 파일'}(${STATE_LABELS[file.state]})`),
    // A segment the head's directory names is never "not yet there": without it every run stops (ledger_unreadable).
    ...s.ledger.segmentsFailed.map(segment =>
      `ledger/${segment.id}.json(${segment.state === 'missing' ? '파일 없음, 장부 목록에는 있음' : STATE_LABELS[segment.state]})`),
  ];
  if (failed.length) {
    add('warn', 'read_errors', `읽지 못한 파일: ${failed.join(', ')}.`, files.every(file => isError(file.state))
      ? '파일을 하나도 읽지 못했습니다. 인터넷 연결과, 토큰이 이 프로젝트 Blob 스토어의 읽기·쓰기 토큰인지 확인하세요.'
      : '잠시 뒤 다시 실행해 보세요. 계속 같으면 이 결과를 알려 주세요.');
  }
  const today = kstDate(nowMs);
  const minutes = kstMinutes(nowMs);
  const { ledger, stats, prices, shadow } = s;
  const fullRanToday = fullJobWroteToday(s);

  if (ledger.state === 'missing' && files.some(file => file.state === 'ok')) {
    add('warn', 'ledger_missing', '장부 파일을 찾지 못했는데 다른 파일은 있습니다.',
      '장부는 매 실행이 가장 먼저 쓰는 파일이라 보통은 생기지 않는 상태입니다. 이 결과를 알려 주세요.');
  }
  if (ledger.state === 'ok' && ledger.journal) {
    const journal = ledger.journal;
    if (journal.kstDate > today) {
      add('warn', 'journal_future', `장부의 쓰기 기록 날짜(${journal.kstDate})가 오늘(${today})보다 뒤입니다.`,
        '이 PC나 서버의 시계가 어긋났을 수 있습니다. 그 날짜가 될 때까지 작업은 쓰기를 멈춥니다.');
    } else if (journal.kstDate === today && journal.writes >= DAILY_WRITE_CAP) {
      // A normal day is 1 (08) + up to 6 (15) + 1 (21): the cap is often reached by the evening ledger step.
      if (journal.fullDone && minutes >= EVENING_LEDGER_MINUTES) {
        add('info', 'write_cap', `오늘 Blob 쓰기 ${DAILY_WRITE_CAP}회(하루 한도)를 모두 썼습니다.`,
          '21시대 장부 단계까지 쓴 날에는 정상일 수 있습니다. 쓰지 못한 파일은 다음 실행이 다시 계산해 씁니다.');
      } else {
        add('warn', 'write_cap', `오늘 Blob 쓰기 ${DAILY_WRITE_CAP}회(하루 한도)를 벌써 모두 썼습니다.`,
          '오늘 남은 예약 실행은 아무것도 쓰지 못합니다. 같은 날 여러 번 실행됐을 수 있습니다.');
      }
    }
    const unobserved = ledger.companies.filter(company => company.observedFrom === null);
    if (unobserved.length) {
      add('warn', 'observation_missing', `아직 스냅샷을 장부에 한 번도 기록하지 못한 회사: ${names(unobserved)}.`,
        '06시대·20시대 예약 수집(/api/cron/collect)이 그 회사의 스냅샷을 만들었는지 확인이 필요합니다.');
    }
    const gapped = ledger.companies.filter(company => company.recentGaps > 0 && company.latestGap);
    if (gapped.length) {
      add('warn', 'observation_gap',
        `최근 7일 안에 관측 공백이 생긴 회사: ${gapped.map(company => `${company.name}(${formatGap(company.latestGap!)})`).join(', ')}.`,
        '작업이 이틀 넘게 멈추면 그사이 스냅샷에서 밀려난 기사를 놓칠 수 있어, 그 기간은 통계에서 빠집니다.');
    }
    const quiet = ledger.companies.filter(company => company.lastSnapshotAt !== null && nowMs - Date.parse(company.lastSnapshotAt) > SNAPSHOT_STALE_MS);
    if (quiet.length) {
      add('warn', 'observation_stale',
        `2일 넘게 새 스냅샷을 보지 못한 회사: ${quiet.map(company => `${company.name}(마지막 ${formatKst(company.lastSnapshotAt!)})`).join(', ')}.`,
        '예약 수집이나 과거 데이터 작업이 그 회사를 건너뛰고 있을 수 있습니다.');
    }
    if ((ledger.bytes ?? 0) > LEDGER_ROLLOVER_BYTES) {
      add('info', 'ledger_rollover', `장부 맨 끝 파일이 4MB를 넘었습니다(${formatBytes(ledger.bytes!)}).`,
        '다음에 쓸 때 새 장부 파일(.1, .2 …)로 자동으로 넘어갑니다.');
    }
  }

  if (stats.state === 'missing' && ledger.state === 'ok') {
    add('warn', 'stats_missing', '전체 작업 결과(stats.json)가 아직 없습니다.',
      '배포 뒤 첫 15시대(15:00~15:59) 전체 작업 전이면 정상입니다. 그 뒤라면 그 시간에 Vercel → Logs에서 /api/cron/history 기록을 확인하세요(로그는 1시간만 보관).');
  }
  if (stats.state === 'ok' && stats.computedAt) {
    const computedMs = Date.parse(stats.computedAt);
    const when = formatKst(stats.computedAt);
    if (nowMs - computedMs > STATS_STALE_MS || (kstDate(computedMs) < today && minutes >= FULL_DUE_MINUTES)) {
      add('warn', 'stats_stale', `마지막 전체 작업 계산이 ${when}입니다. 15시대 전체 작업이 돌지 않았거나 중간에 멈췄을 수 있습니다.`,
        '다음 15:00~16:00 사이에 Vercel → Logs에서 /api/cron/history 기록을 확인하세요(로그는 1시간만 보관).');
    } else if (fullRanToday && kstDate(computedMs) < today && ledger.writtenAt
      && nowMs - Date.parse(ledger.writtenAt) >= RUN_SLACK_MINUTES * 60_000) {
      // The head is a full run's first write and stats.json its last: a run still writing is given a few minutes.
      add('warn', 'stats_not_written', `오늘 전체 작업이 장부는 썼지만 통계 파일(stats.json)은 쓰지 못했습니다(마지막 계산 ${when}).`,
        '쓰기 한도나 시간 초과, 계산 오류로 마지막 파일을 쓰지 못했을 수 있습니다. 다음 15시대 전체 작업이 다시 계산합니다. 다음 날에도 같으면 이 결과를 알려 주세요.');
    }
    const window = runWindow(stats.computedAt);
    if (window === 'ledger_08' || window === 'ledger_21') {
      add('warn', 'stats_at_ledger_hour',
        `통계 계산 시각(${when})이 ${window === 'ledger_08' ? '08' : '21'}시대입니다. 그 시각의 장부 단계 실행이 전체 작업으로 돌았을 수 있습니다(부록 E-3).`,
        '전체 작업은 15시대에만 돌아야 합니다. 이 결과를 알려 주세요.');
    } else if (window === 'other') {
      add('warn', 'stats_off_schedule', `통계 계산 시각(${when})이 예약 시각(15시대)이 아닙니다.`, '직접(수동) 실행했다면 정상입니다.');
    }
    if (stats.carriedOver.length) {
      add('warn', 'stats_carried_over', `통계를 새로 계산하지 못해 이전 값을 그대로 둔 회사: ${stats.carriedOver.map(nameOf).join(', ')}.`,
        '계산 시간이 모자랐거나 계산 중 오류가 났다는 뜻입니다. 다음 날에도 같으면 알려 주세요.');
    }
    // The job computes every core company; one absent was not computed and had no earlier value to keep.
    const absent = stats.companies.filter(company => company.status === 'missing');
    if (absent.length) {
      add('warn', 'stats_company_missing', `통계 파일에 없는 회사: ${names(absent)}.`,
        '그 회사의 통계 계산이 실패했는데 이전 값도 없다는 뜻입니다. 다음 날에도 같으면 이 결과를 알려 주세요.');
    }
    if (prices.state === 'missing') {
      add('warn', 'prices_missing', '가격 파일(prices.json)이 없습니다.',
        '전체 작업이 돌았는데 가격을 한 번도 받지 못했다는 뜻입니다. Vercel 환경변수 KR_PRICE_API_KEY·US_PRICE_API_KEY를 확인하세요(바꾼 뒤에는 다시 배포).');
    }
    const day = kstDate(computedMs);
    // Shadow records newer than stats.json come from a later run that did not write stats.json; the checks above name that.
    if ((shadow.state === 'ok' || shadow.state === 'missing') && kstYear(computedMs) === shadow.year
      && (shadow.latestDate === null || shadow.latestDate < day)) {
      add('warn', 'shadow_behind', `마지막 전체 작업 날짜(${day})의 그림자 기록이 없습니다.`,
        '그날 쓰기 한도나 오류로 그림자 기록 파일을 쓰지 못했을 수 있습니다.');
    }
  }

  if (prices.state === 'ok') {
    if (prices.missing.length) {
      const labels = prices.missing.map(key => { const identity = PRICE_IDENTITY.find(item => item.key === key)!; return `${seriesLabel(identity)}(${key})`; });
      const keys = [...new Set(prices.missing.map(key => PRICE_KEY_ENV[PRICE_IDENTITY.find(item => item.key === key)!.provider]))];
      add('warn', 'price_series_missing', `가격 기록이 없는 종목: ${labels.join(', ')}.`,
        `가격 키(${keys.join('·')})가 없거나 첫 조회가 아직 성공하지 못했습니다.`);
    }
    const byCode = new Map<string, SeriesStatus[]>();
    for (const series of prices.series) {
      if (series.lastAttempt.code === 'ok') continue;
      byCode.set(series.lastAttempt.code, [...(byCode.get(series.lastAttempt.code) ?? []), series]);
    }
    for (const [code, list] of byCode) {
      const last = list.reduce((latest, series) => Date.parse(series.lastAttempt.at) > Date.parse(latest) ? series.lastAttempt.at : latest, list[0]!.lastAttempt.at);
      const providers = new Set(list.map(series => series.provider));
      add('warn', 'price_attempt',
        `가격 조회 실패 [${code}: ${priceCodeLabel(code)}]: ${list.map(series => series.label).join(', ')} (마지막 시도 ${formatKst(last)}).`,
        priceCodeHint(code, providers));
    }
    // A fetch refused as inconsistent_adjustment keeps the stored series, last attempt included, and a prices.json the
    // run did not write keeps every series: no failure code either way, only a last success before the last full run.
    if (stats.state === 'ok' && stats.computedAt) {
      const computedMs = Date.parse(stats.computedAt);
      const behind = prices.series.filter(series => series.lastAttempt.code === 'ok'
        && Date.parse(series.lastSuccessAt) < computedMs - PRICE_REFRESH_SLACK_MS);
      if (behind.length) {
        add('warn', 'price_stale',
          `마지막 전체 작업(${formatKst(stats.computedAt)})에서 새 가격이 저장되지 않은 종목: ${behind.map(series => series.label).join(', ')}.`,
          '받은 가격이 저장된 가격과 맞지 않아 저장을 건너뛰었거나(미국 종목의 분할 보정 차이), 그날 가격 파일을 쓰지 못했을 수 있습니다. '
          + '며칠 계속되면 이 결과를 알려 주세요.');
      }
    }
  }

  if (shadow.state === 'ok' && shadow.latestDate && shadow.latest.length < shadow.expectedPerDay) {
    add('warn', 'shadow_count', `가장 최근 그림자 기록(${shadow.latestDate})이 ${shadow.latest.length}건입니다(보통 ${shadow.expectedPerDay}건).`,
      '그날 일부 회사·기간의 기록을 남기지 못했습니다.');
  }
  for (const file of [s.stats, s.prices, s.shadow, s.weekly, s.daily]) {
    if ((file.bytes ?? 0) > NEAR_CAP_BYTES) {
      add('warn', 'file_near_cap', `${file.file}이 4MB를 넘었습니다(${formatBytes(file.bytes!)}, 한도 ${formatBytes(MAX_FILE_BYTES)}).`,
        '한도를 넘으면 그 파일을 더 쓰지 못합니다. 정리 작업이 필요하니 알려 주세요.');
    }
  }
  return out;
}

function priceCodeHint(code: string, providers: ReadonlySet<PriceProviderId>): string {
  const keys = [...providers].map(provider => PRICE_KEY_ENV[provider]).join('·');
  if (code === 'not_configured' || code === 'http_401' || code === 'http_403') {
    return `Vercel 환경변수 ${keys}를 확인하세요(바꾼 뒤에는 다시 배포해야 적용됨).`;
  }
  if (code === 'stopped') return '같은 제공자의 앞선 오류 때문에 멈췄습니다. 함께 나온 다른 실패부터 확인하세요.';
  if (['http_429', 'provider_error', 'skipped_budget', 'timeout', 'network'].includes(code)) {
    return '일시적인 한도·시간·연결 문제일 수 있습니다. 다음 전체 작업이 자동으로 다시 받습니다.';
  }
  return '다음 전체 작업이 자동으로 다시 받습니다. 며칠 계속되면 이 결과를 알려 주세요.';
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

const STATUS_LABELS: Record<HistoryReadyStatus | 'missing', string> = {
  ready: '정상', no_history: '과거 기사 없음', identity_unverified: '종목 식별 실패', price_unavailable: '가격 없음',
  stats_not_public: '통계 비공개', missing: '통계 없음',
};
const VERDICT_LABELS: Record<Verdict, string> = {
  supports: '지지', contradicts: '상충', weakens: '약화', no_clear_difference: '뚜렷한 차이 없음', insufficient: '근거 부족',
};
const SIGNAL_LABELS: Record<Signal, string> = { positive: '긍정', negative: '부정', withheld: '유보' };
const HORIZON_LABELS: Record<Horizon, string> = { day: '다음 거래일', week: '다음 주' };
const PROVIDER_LABELS: Record<PriceProviderId, string> = { fsc: '공공데이터포털', massive: 'Massive' };

const fileLine = (file: FileStatus): string =>
  file.state === 'ok' ? `${file.file} · ${formatBytes(file.bytes ?? 0)}` : `${file.file ?? '장부 파일'} ${STATE_LABELS[file.state]}`;

function summaryLines(s: HistoryStatus): string[] {
  const nowMs = Date.parse(s.checkedAt);
  const { ledger, stats } = s;
  const lines = ['[한눈에 보기]'];
  if (stats.state === 'ok' && stats.computedAt) {
    const when = formatKst(stats.computedAt);
    lines.push(kstDate(Date.parse(stats.computedAt)) === s.kstDate ? `- 전체 작업(15시대): 오늘 ${when}에 계산함`
      : fullJobWroteToday(s) ? `- 전체 작업(15시대): 오늘 실행됐지만 stats.json은 아직 새로 쓰지 않음 · 마지막 계산 ${when}`
        : kstMinutes(nowMs) < FULL_DUE_MINUTES ? `- 전체 작업(15시대): 오늘은 아직(15:00~15:59에 돎) · 마지막 계산 ${when}`
          : `- 전체 작업(15시대): 오늘 기록 없음 · 마지막 계산 ${when}`);
  } else {
    lines.push(`- 전체 작업(15시대): ${stats.state !== 'missing' ? `stats.json ${STATE_LABELS[stats.state]}`
      : fullJobWroteToday(s) ? '오늘 실행됐지만 stats.json은 아직 쓰지 않음' : '기록 없음'}`);
  }
  if (ledger.state === 'ok' && ledger.writtenAt && ledger.journal) {
    const writes = ledger.journal.kstDate === s.kstDate ? ledger.journal.writes : 0;
    lines.push(`- 장부 마지막 기록: ${formatKst(ledger.writtenAt)}(${WINDOW_LABELS[runWindow(ledger.writtenAt)]}) · 오늘 Blob 쓰기 ${writes}/${DAILY_WRITE_CAP}회`);
  } else {
    lines.push(`- 장부: ${ledger.state === 'missing' ? '기록 없음' : STATE_LABELS[ledger.state]}`);
  }
  // Appendix E-3: a ledger-step run taken for the full job leaves stats.json computed at 08 or 21.
  if (stats.state !== 'ok' || !stats.computedAt) {
    lines.push(isError(stats.state) ? '- 08·21시대 실행(장부 단계): stats.json을 읽지 못해 판단할 수 없음'
      : '- 08·21시대 실행(장부 단계): 판단할 전체 작업 기록이 아직 없음');
  } else {
    const window = runWindow(stats.computedAt);
    const headWindow = ledger.writtenAt ? runWindow(ledger.writtenAt) : 'other';
    const wrote = ledger.writtenAt && (headWindow === 'ledger_08' || headWindow === 'ledger_21')
      ? ` · ${WINDOW_LABELS[headWindow]}이 ${formatKst(ledger.writtenAt)}에 장부를 씀` : '';
    lines.push(window === 'ledger_08' || window === 'ledger_21'
      ? '- 08·21시대 실행(장부 단계): 전체 작업으로 돈 흔적 있음(아래 확인할 점)'
      : `- 08·21시대 실행(장부 단계): 전체 작업으로 돈 흔적 없음(통계 계산이 ${WINDOW_LABELS[window]})${wrote}`);
  }
  return lines;
}

function warningLines(s: HistoryStatus): string[] {
  const lines: string[] = [];
  const warns = s.warnings.filter(warning => warning.level === 'warn');
  const infos = s.warnings.filter(warning => warning.level === 'info');
  lines.push(warns.length ? '[확인할 점]' : '[확인할 점] 없음');
  for (const warning of warns) lines.push(`- ${warning.text}`, `  → ${warning.hint}`);
  if (infos.length) {
    lines.push('[참고]');
    for (const warning of infos) lines.push(`- ${warning.text}`, `  → ${warning.hint}`);
  }
  return lines;
}

function ledgerLines(ledger: LedgerStatus): string[] {
  if (ledger.state !== 'ok' || !ledger.journal || !ledger.writtenAt) return [`[장부] ${fileLine(ledger)}`];
  const journal = ledger.journal;
  const lines = [`[장부] ${fileLine(ledger)} (4MB를 넘으면 다음 파일로, 한도 5MB) · 기록 ${formatKst(ledger.writtenAt)}`];
  // fullDone: a full run wrote the head that day (its first write), not that it finished.
  lines.push(`- 쓰기 기록: ${journal.kstDate} ${journal.writes}/${DAILY_WRITE_CAP}회 · ${journal.fullDone ? '그날 전체 작업 실행됨' : '그날 전체 작업 전'}`
    + (ledger.createdAt ? ` · 장부 시작 ${formatKst(ledger.createdAt)}` : ''));
  const read = ledger.segmentsFailed.length || ledger.segmentsSkipped
    ? `${ledger.directory}개 중 ${ledger.segmentsRead}개 읽음${ledger.segmentsFailed.length ? `(${ledger.segmentsFailed.length}개 실패)` : ''}`
      + `${ledger.segmentsSkipped ? `(오래된 ${ledger.segmentsSkipped}개는 읽지 않음)` : ''}, 합계는 일부`
    : `${ledger.directory}개 모두 읽음`;
  lines.push(`- 장부 파일 ${read} · 기사 합계 ${count(ledger.totalEntries)}건 · 이 파일 ${count(ledger.headEntries)}건`
    + (ledger.otherEntries ? ` · 목록 밖 회사 ${count(ledger.otherEntries)}건` : ''));
  for (const company of ledger.companies) {
    const observed = company.observedFrom === null || company.lastSnapshotAt === null ? '관측 기록 없음'
      : `관측 ${formatKst(company.observedFrom)}부터 · 마지막 스냅샷 ${formatKst(company.lastSnapshotAt)} · `
        + (company.gaps ? `공백 ${company.gaps}회(최근 ${formatGap(company.latestGap!)})` : '공백 없음');
    lines.push(`  ${company.name} ${count(company.entries)}건 · ${observed}`);
  }
  return lines;
}

function statsLines(stats: StatsStatus): string[] {
  if (stats.state !== 'ok' || !stats.computedAt) return [`[통계] ${fileLine(stats)}`];
  const lines = [`[통계] ${fileLine(stats)} · 계산 ${formatKst(stats.computedAt)}`, '- 판정은 긍정 뉴스/부정 뉴스 순서'];
  for (const company of stats.companies) {
    const parts = [`  ${company.name} ${STATUS_LABELS[company.status]}`];
    for (const horizon of HORIZONS) {
      const verdicts = company.verdicts[horizon];
      if (verdicts) parts.push(`${HORIZON_LABELS[horizon]} ${VERDICT_LABELS[verdicts.positive]}/${VERDICT_LABELS[verdicts.negative]}`);
    }
    if (company.lastPriceDate) parts.push(`가격 ${company.lastPriceDate}까지`);
    if (company.carriedOver) parts.push('이전 값 유지');
    lines.push(parts.join(' · '));
  }
  lines.push(`- 이전 값 유지: ${stats.carriedOver.length ? stats.carriedOver.map(nameOf).join(', ') : '없음'}`
    + (stats.otherCompanies ? ` · 목록 밖 회사 ${stats.otherCompanies}곳` : ''));
  return lines;
}

function pricesLines(prices: PricesStatus): string[] {
  if (prices.state !== 'ok') return [`[가격] ${fileLine(prices)}`];
  const lines = [`[가격] ${fileLine(prices)} · ${PRICE_IDENTITY.length}종목 중 ${prices.series.length}종목 저장`];
  for (const identity of PRICE_IDENTITY) {
    const series = prices.series.find(item => item.key === identity.key);
    const name = `  ${seriesLabel(identity)}(${identity.key})`;
    if (!series) { lines.push(`${name} · 기록 없음`); continue; }
    const range = series.firstDate && series.lastDate ? ` ${series.firstDate}~${series.lastDate}` : '';
    let line = `${name} · ${PROVIDER_LABELS[series.provider]} · 일봉 ${count(series.bars)}개${range} · 마지막 성공 ${formatKst(series.lastSuccessAt)}`;
    if (series.lastAttempt.code !== 'ok') {
      line += ` · 마지막 시도 실패: ${series.lastAttempt.code} ${priceCodeLabel(series.lastAttempt.code)}, ${formatKst(series.lastAttempt.at)}`;
    }
    if (series.rebasedAt) line += ` · 분할 보정 ${formatKst(series.rebasedAt)}`;
    lines.push(line);
  }
  if (prices.otherSeries) lines.push(`- 목록 밖 종목 ${prices.otherSeries}개`);
  return lines;
}

function shadowLines(shadow: ShadowStatus): string[] {
  if (shadow.state !== 'ok') return [`[그림자 기록] ${fileLine(shadow)}`];
  const latest = shadow.latestDate ? ` · 최근 ${shadow.latestDate} ${shadow.latest.length}건` : '';
  const lines = [`[그림자 기록] ${fileLine(shadow)} · 모두 ${count(shadow.records)}건${latest}`];
  if (!shadow.latestDate) return lines;
  lines.push('- 기준선→통합, 괄호는 과거 사례 판정');
  for (const company of PRICED) {
    const parts = [`  ${company.name}`];
    for (const horizon of HORIZONS) {
      const entry = shadow.latest.find(item => item.companyId === company.id && item.horizon === horizon);
      if (!entry) { parts.push(`${HORIZON_LABELS[horizon]} 기록 없음`); continue; }
      parts.push(`${HORIZON_LABELS[horizon]} ${SIGNAL_LABELS[entry.baseline]}→${SIGNAL_LABELS[entry.integrated]}`
        + (entry.verdict ? `(${VERDICT_LABELS[entry.verdict]})` : '')
        + (entry.stale ? ' 이전 스냅샷' : '')
        + (entry.statsStatus !== 'ready' ? ` [통계 ${STATUS_LABELS[entry.statsStatus]}]` : ''));
    }
    lines.push(parts.join(' · '));
  }
  return lines;
}

const outcomesText = (file: OutcomesStatus): string =>
  file.state === 'ok' ? `${file.file} ${count(file.records)}건 · ${formatBytes(file.bytes ?? 0)}` : `${file.file} ${STATE_LABELS[file.state]}`;

/** Short plain-Korean lines for the terminal; about 55 in a normal day, no stored free text. */
export function formatHistoryStatus(status: HistoryStatus): string[] {
  const lines = [`과거 데이터 점검 · ${formatKst(status.checkedAt)} 기준 (읽기만 하고 아무것도 쓰지 않음)`];
  if (status.warnings.some(warning => warning.code === 'nothing_stored')) {
    lines.push(...warningLines(status));
    lines.push(`[파일] ${filesOf(status).map(file => file.file ?? '장부(ledger/)').join(' · ')}: 모두 아직 없음`);
    return lines;
  }
  lines.push(...summaryLines(status), ...warningLines(status), ...ledgerLines(status.ledger), ...statsLines(status.stats),
    ...pricesLines(status.prices), ...shadowLines(status.shadow),
    `[완료 결과] ${outcomesText(status.weekly)} / ${outcomesText(status.daily)}`);
  return lines;
}
