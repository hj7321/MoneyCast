import test from 'node:test';
import assert from 'node:assert/strict';
import type { get as blobGet } from '@vercel/blob';
import { companies, NEWS_CACHE_ANALYSIS_VERSION, type NewsAnalysis, type NewsArticle } from '@moneycast/core';
import { LEDGER_ROLLOVER_BYTES, MARKETAUX_COLLECTION, runHistoryJob, type HistoryJobMode, type HistoryJobSummary } from './history-job.js';
import { entriesFromSnapshot, type LedgerEntry } from './history-ledger.js';
import {
  HISTORY_PREFIX, HISTORY_VERSIONS, MAX_FILE_BYTES, createMemoryHistoryStore,
  type LedgerSegmentFile, type MemoryHistoryStore, type MemoryStoreOptions, type PricesFile, type ShadowFile, type StatsFile,
} from './history-store.js';
import {
  MISSING_TOKEN_LINE, NEAR_CAP_BYTES, SHADOW_RECORDS_PER_DAY, STATUS_TOKEN_ENV, TOKEN_FORMAT_LINE, blobTokenProblem, createReadOnlyBlobHistoryStore,
  everyReadFailed, formatHistoryStatus, readHistoryStatus, readOnlyBlobFunctions, readOnlyHistoryStore, safePriceCode,
  type HistoryStatus, type StatusWarningCode,
} from './history-status.js';
import { CALENDAR_UNVERIFIED, sessionOn, sessionsBetween } from './market-calendar.js';
import {
  PRICE_IDENTITY, publicationMs,
  type FetchedBar, type PriceFetchRequest, type PriceFetchResult, type PriceIdentity, type PriceProvider, type PriceProviderId,
} from './price-provider.js';
import { createRedactor } from './price-wire.js';
import { createSnapshot, SNAPSHOT_POOL_LIMIT, type CompanySnapshot } from './snapshot-store.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();
const at = (text: string) => Date.parse(text);
/** Shaped like a Blob read-write token and like a stored price code (lowercase, digits, underscores, ≤ 40). */
const TOKEN = 'vercel_blob_rw_fake7_secret01234567';
const READ_METHODS = ['findLedgerHead', 'readDaily', 'readLedgerSegment', 'readPrices', 'readShadow', 'readStats', 'readWeekly'];

// ---------------------------------------------------------------------------
// Fixtures (the minimal subset of history-job.test.ts)
// ---------------------------------------------------------------------------

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
}

const barCache = new Map<string, FetchedBar[]>();
/** Every session's bar for an instrument, a seeded random walk; identical on every fetch. */
function allBars(identity: PriceIdentity): FetchedBar[] {
  const cached = barCache.get(identity.key);
  if (cached) return cached;
  const random = seeded(hash(identity.key));
  let close = identity.provider === 'fsc' ? 50_000 : 150;
  const bars: FetchedBar[] = [];
  for (const session of sessionsBetween(identity.exchange, '2023-01-02', '2027-12-31')) {
    const previous = close;
    const open = Number((previous * (1 + (random() - 0.5) * 0.01)).toFixed(4));
    close = Number((previous * (1 + (random() - 0.5) * 0.04)).toFixed(4));
    const bar: FetchedBar = {
      date: session.date, open, high: Number((Math.max(open, close) * 1.01).toFixed(4)), low: Number((Math.min(open, close) * 0.99).toFixed(4)),
      close, volume: 1_000_000,
    };
    if (identity.provider === 'fsc') { if (bars.length) bar.base = previous; } else bar.adjClose = close;
    bars.push(bar);
  }
  barCache.set(identity.key, bars);
  return bars;
}

const emptyCounts = () => ({ rows: 0, kept: 0, otherCodes: 0, nonSession: 0, unverifiedDate: 0, notClosed: 0, outsideValidity: 0, malformed: 0, duplicates: 0, flagged: 0 });

type Scale = (key: string, date: string) => number;
const scaled = (bar: FetchedBar, k: number): FetchedBar => k === 1 ? { ...bar } : {
  ...bar, open: bar.open * k, high: bar.high * k, low: bar.low * k, close: bar.close * k, ...(bar.adjClose ? { adjClose: bar.adjClose * k } : {}),
};

/**
 * Fake providers that deliver the bars published by the run's clock; `fail` gives a key a failure code instead,
 * and `scale` multiplies a key's prices date by date (a history the provider adjusted again).
 */
function fakeProviders(now: () => number, fail: (key: string) => PriceFetchResult['code'] | null, scale: Scale = () => 1) {
  const make = (id: PriceProviderId): PriceProvider => ({
    id, configured: true,
    async fetch(request: PriceFetchRequest): Promise<PriceFetchResult> {
      const t = now();
      const base = { key: request.identity.key, providerCode: null, counts: emptyCounts(), attemptedAt: iso(t), ms: 0 };
      const code = fail(request.identity.key);
      if (code && code !== 'ok') return { ...base, code, bars: [], receivedAt: null };
      const bars = allBars(request.identity).filter(bar => {
        if (bar.date < request.from || bar.date > request.to) return false;
        const session = sessionOn(request.identity.exchange, bar.date);
        if (!session || session === CALENDAR_UNVERIFIED) return false;
        const pub = publicationMs(request.identity, session);
        return pub !== null && pub <= t;
      });
      return { ...base, code: 'ok', bars: bars.map(bar => scaled(bar, scale(request.identity.key, bar.date))), receivedAt: iso(t) };
    },
  });
  return () => ({ fsc: make('fsc'), massive: make('massive') });
}

const company = (id: string) => companies.find(item => item.id === id)!;
const TITLE_WORDS = ['실적', '신제품', '공장', '계약', '규제', '소송', '증설', '배당', '인수', '협력', '출시', '감산', '수주', '전망', '투자', '리콜'];

let articleCounter = 0;
function article(companyId: string, publishedMs: number, sentiment: NewsArticle['sentiment']): NewsArticle {
  articleCounter += 1;
  const random = seeded(hash(`${companyId}-${articleCounter}-${publishedMs}`));
  const words = Array.from({ length: 5 }, () => TITLE_WORDS[Math.floor(random() * TITLE_WORDS.length)]!);
  const id = `st-${companyId.replace(/\W/g, '')}-${articleCounter}`;
  return {
    id, title: `${company(companyId).name} ${words.join(' ')} ${articleCounter}호 ${hash(id).toString(36)}`, source: `pub${articleCounter % 7}.example`,
    publishedAt: iso(publishedMs), url: `https://news.example/${id}`, sentiment, rationale: '', sourceProvider: 'Marketaux',
    identity: 'entity_verified', classificationMethod: 'provider', sentimentScore: sentiment === 'positive' ? 0.5 : sentiment === 'negative' ? -0.5 : 0,
  };
}

function snapshotOf(companyId: string, updatedMs: number, pool: NewsArticle[]): CompanySnapshot {
  const analysis: NewsAnalysis = {
    company: company(companyId), status: 'ready', articles: pool, asOf: iso(updatedMs),
    period: { start: '2026-11-02', end: '2026-11-06' }, evidence: 'low', summary: '요약', positiveFactors: ['긍정 요인'], negativeFactors: [], risks: [],
    provider: 'Marketaux', analysisVersion: NEWS_CACHE_ANALYSIS_VERSION, newsWindow: { start: iso(updatedMs - 7 * DAY), end: iso(updatedMs) },
    sources: [{ id: 'marketaux', label: 'Marketaux', status: 'ok', articleCount: pool.length }],
  };
  return createSnapshot(analysis, pool, new Date(updatedMs));
}

interface World {
  store: MemoryHistoryStore;
  snapshots: Map<string, CompanySnapshot>;
  run(mode: HistoryJobMode, startMs: number, fail?: (key: string) => PriceFetchResult['code'] | null, scale?: Scale): Promise<HistoryJobSummary>;
}

function world(options: MemoryStoreOptions = {}): World {
  let nowMs = 0;
  let ids = 0;
  const store = createMemoryHistoryStore({ ...options, now: () => nowMs });
  const snapshots = new Map<string, CompanySnapshot>();
  return {
    store, snapshots,
    async run(mode, startMs, fail = () => null, scale = () => 1) {
      nowMs = startMs;
      const summary = await runHistoryJob({
        store, snapshots: { read: async id => snapshots.get(id) ?? null }, priceProviders: fakeProviders(() => nowMs, fail, scale),
        companies, now: () => nowMs, randomId: () => `run-${++ids}`, redactKeys: [],
      }, mode);
      assert.notEqual(summary.status, 'failed', JSON.stringify(summary.errors));
      return summary;
    },
  };
}

/** A world that goes on from `base`'s files and snapshots; `base` itself is left as it was. */
function fork(base: World, options: MemoryStoreOptions = {}): World {
  const next = world(options);
  for (const [name, file] of base.store.files) next.store.files.set(name, { ...file });
  for (const [id, snapshot] of base.snapshots) next.snapshots.set(id, snapshot);
  return next;
}

/** The realistic day's next morning: the 06:40 collection and the 08:10 KST ledger step of 2026-11-03. */
async function nextMorning(base: World, options: MemoryStoreOptions = {}): Promise<World> {
  const next = fork(base, options);
  refreshSnapshots(next, at('2026-11-02T21:40:00Z'), 1);
  await next.run('ledger', at('2026-11-02T23:10:00Z'));
  return next;
}

/** The scheduled collection: each company's pool gains `perCompany` new articles. */
function refreshSnapshots(w: World, updatedMs: number, perCompany = 2): void {
  for (const { id } of companies) {
    const old = w.snapshots.get(id)?.pool ?? [];
    const fresh = Array.from({ length: perCompany }, (_, i) => article(id, updatedMs - (3 + i) * HOUR, i % 2 ? 'negative' : 'positive'));
    const pool = [...fresh, ...old].filter(item => Date.parse(item.publishedAt) > updatedMs - 7 * DAY).slice(0, SNAPSHOT_POOL_LIMIT);
    w.snapshots.set(id, snapshotOf(id, updatedMs, pool));
  }
}

/** October's ledger, last written by the 21 KST ledger step of 2026-10-31 (KST). */
async function seedOctober(w: World): Promise<void> {
  const random = seeded(11);
  const entries: LedgerEntry[] = [];
  const sentiments: NewsArticle['sentiment'][] = ['positive', 'negative', 'neutral', 'positive', 'negative'];
  for (const { id } of companies) {
    for (let t = at('2026-06-01T01:00:00Z'); t < at('2026-10-31T00:00:00Z'); t += Math.floor((1.5 + random() * 2.5) * DAY)) {
      const published = t + Math.floor(random() * 10) * HOUR;
      const item = article(id, published, sentiments[Math.floor(random() * sentiments.length)]!);
      entries.push(...entriesFromSnapshot(id, snapshotOf(id, published + HOUR, [item]), { collection: MARKETAUX_COLLECTION }));
    }
  }
  const observations = Object.fromEntries(companies.map(({ id }) =>
    [id, { observedFrom: '2026-06-01T00:00:00.000Z', lastSnapshotAt: '2026-10-31T11:40:00.000Z', gaps: [] }]));
  const head: LedgerSegmentFile = {
    version: HISTORY_VERSIONS.ledger, segment: '2026-10', writtenAt: '2026-10-31T12:10:00.000Z',
    state: { createdAt: '2026-06-01T00:00:00.000Z', directory: ['2026-10'], observations, journal: { kstDate: '2026-10-31', writes: 7, fullDone: true }, writeToken: 'seed' },
    entries,
  };
  await w.store.writeLedgerSegment(head, { kind: 'createOnly' });
}

/**
 * A realistic first November day (KST 2026-11-02): 06:40 collection, 08:10 ledger step, 15:20 full job,
 * 20:40 collection, 21:10 ledger step, all by the real job on the October ledger.
 */
async function realisticDay(): Promise<World> {
  const w = world();
  await seedOctober(w);
  refreshSnapshots(w, at('2026-11-01T21:40:00Z'));
  await w.run('ledger', at('2026-11-01T23:10:00Z'));
  await w.run('full', at('2026-11-02T06:20:00Z'));
  refreshSnapshots(w, at('2026-11-02T11:40:00Z'), 1);
  await w.run('ledger', at('2026-11-02T12:10:00Z'));
  return w;
}
let day: Promise<World> | null = null;
/** Shared by several tests; never written to (tests copy its files). */
const sharedDay = () => day ??= realisticDay();
/** 21:35 KST on the realistic day. */
const CHECK_AT = at('2026-11-02T12:35:00Z');

/** The same files in a fresh store: its counters start at 0. */
function copyStore(source: MemoryHistoryStore, options: MemoryStoreOptions = {}): MemoryHistoryStore {
  const store = createMemoryHistoryStore(options);
  for (const [name, file] of source.files) store.files.set(name, { ...file });
  return store;
}
function editJson<T>(store: MemoryHistoryStore, name: string, mutate: (value: T) => void): void {
  const file = store.files.get(name)!;
  const value = JSON.parse(file.text) as T;
  mutate(value);
  store.files.set(name, { text: JSON.stringify(value), etag: `${file.etag}-edited` });
}

type GetOptions = Parameters<typeof blobGet>[1];
/** The Blob SDK's get over a map of store files (null for a missing pathname, as the SDK does on 404). */
function fakeBlobGet(files: ReadonlyMap<string, { text: string; etag: string }>, calls: Array<{ pathname: string; options: GetOptions }>): typeof blobGet {
  return (async (pathname: string, options: GetOptions) => {
    calls.push({ pathname, options: { ...options } });
    const stored = pathname.startsWith(HISTORY_PREFIX) ? files.get(pathname.slice(HISTORY_PREFIX.length)) : undefined;
    if (!stored) return null;
    return { statusCode: 200, stream: new Blob([stored.text]).stream(), headers: new Headers(), blob: { etag: stored.etag } };
  }) as unknown as typeof blobGet;
}

const codes = (status: HistoryStatus) => status.warnings.map(warning => warning.code);
const warning = (status: HistoryStatus, code: StatusWarningCode) => status.warnings.find(item => item.code === code);
const fileStates = (status: HistoryStatus) =>
  [status.ledger, status.stats, status.prices, status.shadow, status.weekly, status.daily].map(file => file.state);

/** `items` repeated (copy n through `copy`) until their JSON is about `bytes` long. */
function grow<T>(items: readonly T[], bytes: number, copy: (item: T, n: number) => T): T[] {
  const each = Buffer.byteLength(JSON.stringify(items), 'utf8') / items.length;
  return Array.from({ length: Math.ceil(bytes / each) }, (_, i) => copy(items[i % items.length]!, Math.floor(i / items.length)));
}

/** Unique (company, article) keys over every ledger file, from the raw stored text. */
function storedLedgerKeys(store: MemoryHistoryStore): Map<string, Set<string>> {
  const keys = new Map<string, Set<string>>();
  for (const [name, file] of store.files) {
    if (!name.startsWith('ledger/')) continue;
    for (const entry of (JSON.parse(file.text) as LedgerSegmentFile).entries) {
      if (!keys.has(entry.companyId)) keys.set(entry.companyId, new Set());
      keys.get(entry.companyId)!.add(entry.id);
    }
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('an empty store reads as nothing stored yet, explained in a few lines, with fresh reads and no write', async () => {
  const store = createMemoryHistoryStore();
  const status = await readHistoryStatus(store, at('2026-11-12T00:35:00Z'));
  assert.deepEqual(codes(status), ['nothing_stored']);
  assert.deepEqual(fileStates(status), ['missing', 'missing', 'missing', 'missing', 'missing', 'missing']);
  assert.equal(status.ledger.file, null);
  assert.equal(status.shadow.file, 'shadow/2026.json');
  assert.equal(everyReadFailed(status), false);
  assert.equal(store.writes, 0);
  assert.equal(store.attempts, 0);
  assert.equal(store.writeLog.length, 0);
  assert.ok(store.reads.length > 0 && store.reads.every(read => read.fresh));
  const lines = formatHistoryStatus(status);
  assert.ok(lines.length <= 6, lines.join('\n'));
  assert.match(lines[0]!, /^과거 데이터 점검 · 2026-11-12 09:35 KST 기준/);
  assert.ok(lines.includes('- 아직 실행 기록이 없습니다.'));
  assert.ok(lines.some(line => line.includes('HISTORY_INSIGHTS') && line.includes('collect') && line.includes('정상')));
});

test('a realistic day by the real job: ledger, statistics, prices, shadow records and outcomes are all summarized', async () => {
  const w = await sharedDay();
  const store = copyStore(w.store);
  const status = await readHistoryStatus(store, CHECK_AT);
  assert.deepEqual(fileStates(status).slice(0, 4), ['ok', 'ok', 'ok', 'ok']);
  assert.equal(status.kstDate, '2026-11-02');

  // Ledger: the head is November's segment, written last by the 21:10 KST ledger step.
  const headFile = JSON.parse(w.store.files.get('ledger/2026-11.json')!.text) as LedgerSegmentFile;
  const ledger = status.ledger;
  assert.equal(ledger.file, 'ledger/2026-11.json');
  assert.equal(ledger.segment, '2026-11');
  assert.equal(ledger.writtenAt, '2026-11-02T12:10:00.000Z');
  assert.deepEqual(ledger.journal, headFile.state.journal);
  assert.deepEqual(ledger.journal, { kstDate: '2026-11-02', writes: 8, fullDone: true });
  assert.equal(ledger.directory, 2);
  assert.equal(ledger.segmentsRead, 2);
  assert.deepEqual(ledger.segmentsFailed, []);
  assert.equal(ledger.headEntries, headFile.entries.length);
  // Entries patched in November sit in both segments; the totals count each once.
  const keys = storedLedgerKeys(w.store);
  assert.equal(ledger.totalEntries, [...keys.values()].reduce((sum, ids) => sum + ids.size, 0));
  for (const item of ledger.companies) {
    assert.equal(item.entries, keys.get(item.companyId)?.size ?? 0, item.companyId);
    assert.equal(item.observedFrom, '2026-06-01T00:00:00.000Z');
    assert.equal(item.lastSnapshotAt, '2026-11-02T11:40:00.000Z');
    assert.equal(item.gaps, 0);
  }
  assert.ok(ledger.companies.every(item => item.entries > 0));

  // stats.json, prices.json and the year files.
  assert.equal(status.stats.computedAt, '2026-11-02T06:20:00.000Z');
  assert.equal(status.stats.companies.length, 8);
  assert.ok(status.stats.companies.every(item => item.status !== 'missing'));
  const stats = JSON.parse(w.store.files.get('stats.json')!.text) as StatsFile;
  for (const item of status.stats.companies) {
    assert.equal(item.status, stats.companies[item.companyId]!.status);
    const directions = stats.companies[item.companyId]!.horizons.week.directions;
    assert.deepEqual(item.verdicts.week, directions ? { positive: directions.positive.verdict, negative: directions.negative.verdict } : null);
  }
  assert.deepEqual(status.stats.carriedOver, []);
  assert.equal(status.prices.series.length, PRICE_IDENTITY.length);
  assert.deepEqual(status.prices.missing, []);
  assert.ok(status.prices.series.every(series => series.lastAttempt.code === 'ok' && series.bars > 0 && series.lastSuccessAt === '2026-11-02T06:20:00.000Z'));
  const kodex = status.prices.series.find(series => series.key === 'krx:069500')!;
  assert.equal(kodex.label, 'KODEX 200');
  assert.equal(kodex.firstDate, '2023-01-02');
  assert.equal(status.shadow.latestDate, '2026-11-02');
  assert.equal(status.shadow.latest.length, SHADOW_RECORDS_PER_DAY);
  assert.equal(SHADOW_RECORDS_PER_DAY, 16);
  const shadow = JSON.parse(w.store.files.get('shadow/2026.json')!.text) as ShadowFile;
  for (const entry of status.shadow.latest) {
    const record = shadow.records.find(item => item.recordDate === '2026-11-02' && item.companyId === entry.companyId && item.horizon === entry.horizon)!;
    assert.deepEqual([entry.baseline, entry.integrated, entry.verdict, entry.stale, entry.statsStatus],
      [record.baseline, record.integrated, record.verdict, record.stale, record.statsStatus]);
  }
  for (const file of [status.weekly, status.daily]) {
    if (file.state === 'ok') assert.equal(file.records, (JSON.parse(w.store.files.get(file.file!)!.text) as { records: unknown[] }).records.length);
  }
  // Reported sizes are the stored bytes (the parsers keep every field the job writes).
  for (const file of [status.ledger, status.stats, status.prices, status.shadow, status.weekly, status.daily]) {
    if (file.state === 'ok') assert.equal(file.bytes, Buffer.byteLength(w.store.files.get(file.file!)!.text, 'utf8'), file.file!);
  }

  // A normal day: nothing to look at; the eighth write of the 21 KST step is only a note.
  assert.deepEqual(status.warnings.filter(item => item.level === 'warn'), []);
  assert.deepEqual(codes(status), ['write_cap']);
  assert.equal(warning(status, 'write_cap')!.level, 'info');

  const lines = formatHistoryStatus(status);
  assert.ok(lines.length <= 60, `${lines.length} lines`);
  assert.ok(lines.includes('- 전체 작업(15시대): 오늘 2026-11-02 15:20 KST에 계산함'));
  assert.ok(lines.includes('- 장부 마지막 기록: 2026-11-02 21:10 KST(21시대 실행) · 오늘 Blob 쓰기 8/8회'));
  assert.ok(lines.includes('- 08·21시대 실행(장부 단계): 전체 작업으로 돈 흔적 없음(통계 계산이 15시대 전체 작업) · 21시대 실행이 2026-11-02 21:10 KST에 장부를 씀'));
  assert.ok(lines.includes('[확인할 점] 없음'));
  assert.ok(lines.some(line => line.startsWith('- 장부 파일 2개 모두 읽음 · 기사 합계 ')));
  assert.ok(lines.some(line => line.startsWith('  삼성전자 ') && line.includes('마지막 스냅샷 2026-11-02 20:40 KST · 공백 없음')));
  assert.ok(lines.some(line => line.startsWith('  KODEX 200(krx:069500) · 공공데이터포털 · 일봉 ')));
  assert.ok(lines.some(line => line.startsWith('[그림자 기록] shadow/2026.json · ') && line.endsWith('최근 2026-11-02 16건')));
  assert.ok(lines.every(line => !line.includes('{"') && !line.includes('":') && !line.includes('undefined') && !line.includes('NaN')));
  // Nothing stored as free text is printed.
  const text = lines.join('\n');
  for (const entry of headFile.entries.slice(0, 20)) assert.ok(!text.includes(entry.title) && !text.includes(entry.url));
  assert.ok(!text.includes('run-'));
});

test('reading leaves a store’s write counters at 0, changes no file and reads every file fresh', async () => {
  const w = await sharedDay();
  const store = copyStore(w.store);
  const before = [...store.files.entries()].map(([name, file]) => [name, file.text, file.etag]);
  await readHistoryStatus(store, CHECK_AT);
  assert.equal(store.writes, 0);
  assert.equal(store.attempts, 0);
  assert.equal(store.writeLog.length, 0);
  assert.deepEqual([...store.files.entries()].map(([name, file]) => [name, file.text, file.etag]), before);
  assert.ok(store.reads.length >= 7);
  assert.ok(store.reads.every(read => read.fresh), JSON.stringify(store.reads.filter(read => !read.fresh)));
  // The facade has the seven read methods and nothing else.
  const facade = readOnlyHistoryStore(store);
  assert.deepEqual(Object.keys(facade).sort(), READ_METHODS);
  assert.ok(!('writeStats' in facade) && !('writeLedgerSegment' in facade) && !('writes' in facade));
  assert.ok(Object.isFrozen(facade));
});

test('an unreadable file is reported with its code while the other files are still shown', async () => {
  const w = await sharedDay();
  const store = copyStore(w.store, { failRead: file => file === 'prices.json' ? 'timeout' : file === 'ledger/2026-10.json' ? 'unreadable' : null });
  const status = await readHistoryStatus(store, CHECK_AT);
  assert.equal(status.prices.state, 'timeout');
  assert.equal(status.prices.bytes, null);
  assert.equal(status.ledger.state, 'ok');
  assert.deepEqual(status.ledger.segmentsFailed, [{ id: '2026-10', state: 'unreadable' }]);
  assert.equal(status.ledger.segmentsRead, 1);
  assert.equal(status.ledger.totalEntries, status.ledger.headEntries);
  assert.deepEqual([status.stats.state, status.shadow.state], ['ok', 'ok']);
  const errors = warning(status, 'read_errors')!;
  assert.equal(errors.level, 'warn');
  assert.equal(errors.text, '읽지 못한 파일: prices.json(시간 초과), ledger/2026-10.json(읽기 실패).');
  assert.ok(errors.hint.includes('다시 실행'));
  assert.equal(everyReadFailed(status), false);
  const lines = formatHistoryStatus(status);
  assert.ok(lines.includes('[가격] prices.json 시간 초과'));
  assert.ok(lines.some(line => line.startsWith('- 장부 파일 2개 중 1개 읽음(1개 실패), 합계는 일부 · 기사 합계 ')));
  assert.ok(lines.some(line => line.startsWith('[통계] stats.json · ') && line.endsWith('계산 2026-11-02 15:20 KST')));
  assert.ok(lines.some(line => line.startsWith('[그림자 기록] shadow/2026.json · ')));
  assert.ok(lines.some(line => line.startsWith('  테슬라 ') && line.includes('다음 거래일 ')));

  // Not one file readable (a wrong token, no network): every state is the error, plus the token hint.
  const blocked = copyStore(w.store, { failRead: () => 'unreadable' });
  const none = await readHistoryStatus(blocked, CHECK_AT);
  assert.deepEqual(fileStates(none), ['unreadable', 'unreadable', 'unreadable', 'unreadable', 'unreadable', 'unreadable']);
  assert.equal(none.ledger.file, 'ledger/2026-11.json');
  assert.deepEqual(codes(none), ['read_errors']);
  assert.ok(warning(none, 'read_errors')!.hint.includes('토큰'));
  assert.equal(everyReadFailed(none), true);
  assert.ok(formatHistoryStatus(none).length <= 20);
});

test('appendix E-3: a full job computed at 08 or 21 KST means a ledger-step run was taken for the full job', async () => {
  // The 08:10 KST run without its ledger step, on a store with no stats.json yet, runs the full job.
  const w = world();
  refreshSnapshots(w, at('2026-11-01T21:40:00Z'));
  const misrouted = await w.run('full', at('2026-11-01T23:10:00Z'));
  assert.equal(misrouted.mode, 'full');
  const status = await readHistoryStatus(w.store, at('2026-11-01T23:40:00Z'));
  assert.equal(status.stats.computedAt, '2026-11-01T23:10:00.000Z');
  const e3 = warning(status, 'stats_at_ledger_hour')!;
  assert.equal(e3.level, 'warn');
  assert.equal(e3.text, '통계 계산 시각(2026-11-02 08:10 KST)이 08시대입니다. 그 시각의 장부 단계 실행이 전체 작업으로 돌았을 수 있습니다(부록 E-3).');
  assert.ok(!codes(status).includes('stats_off_schedule'));
  const lines = formatHistoryStatus(status);
  assert.ok(lines.includes('- 08·21시대 실행(장부 단계): 전체 작업으로 돈 흔적 있음(아래 확인할 점)'));
  assert.ok(lines.includes('[확인할 점]'));
  assert.ok(lines.some(line => line.includes('부록 E-3')));

  // The same at 21 KST, and a 11 KST computation is off schedule but not E-3.
  const base = await sharedDay();
  const evening = copyStore(base.store);
  editJson<StatsFile>(evening, 'stats.json', stats => { stats.computedAt = '2026-11-02T12:05:00.000Z'; });
  const atNine = await readHistoryStatus(evening, CHECK_AT);
  assert.match(warning(atNine, 'stats_at_ledger_hour')!.text, /\(2026-11-02 21:05 KST\)이 21시대입니다/);
  const morning = copyStore(base.store);
  editJson<StatsFile>(morning, 'stats.json', stats => { stats.computedAt = '2026-11-02T02:00:00.000Z'; });
  const atEleven = await readHistoryStatus(morning, CHECK_AT);
  assert.ok(!codes(atEleven).includes('stats_at_ledger_hour'));
  assert.equal(warning(atEleven, 'stats_off_schedule')!.text, '통계 계산 시각(2026-11-02 11:00 KST)이 예약 시각(15시대)이 아닙니다.');
  // A computation in the first minutes after 16:00 still belongs to a run that started at 15:59.
  const late = copyStore(base.store);
  editJson<StatsFile>(late, 'stats.json', stats => { stats.computedAt = '2026-11-02T07:02:30.000Z'; });
  assert.ok(!codes(await readHistoryStatus(late, CHECK_AT)).some(code => code.startsWith('stats_')));
});

test('a price series whose last attempt failed is named with its code and the key to check', async () => {
  const w = world();
  refreshSnapshots(w, at('2026-11-01T21:40:00Z'));
  await w.run('full', at('2026-11-02T06:20:00Z'));
  refreshSnapshots(w, at('2026-11-02T21:40:00Z'), 1);
  await w.run('full', at('2026-11-03T06:20:00Z'),
    key => key === 'arca:SPY' ? 'http_401' : key.startsWith('nasdaq:') ? 'stopped' : key.startsWith('krx:') ? 'not_configured' : null);
  const status = await readHistoryStatus(w.store, at('2026-11-03T07:00:00Z'));
  const failures = status.warnings.filter(item => item.code === 'price_attempt');
  assert.equal(failures.length, 3);
  const byCode = (code: string) => failures.find(item => item.text.includes(`[${code}:`))!;
  assert.equal(byCode('http_401').text, '가격 조회 실패 [http_401: 키 거부(인증 실패)]: SPY (마지막 시도 2026-11-03 15:20 KST).');
  assert.ok(byCode('http_401').hint.includes('US_PRICE_API_KEY') && !byCode('http_401').hint.includes('KR_PRICE_API_KEY'));
  assert.equal(byCode('not_configured').text, '가격 조회 실패 [not_configured: 가격 키 없음]: 삼성전자, SK하이닉스, NAVER, 현대자동차, KODEX 200 (마지막 시도 2026-11-03 15:20 KST).');
  assert.ok(byCode('not_configured').hint.includes('KR_PRICE_API_KEY'));
  assert.ok(byCode('stopped').text.includes('애플, 엔비디아, 마이크로소프트, 테슬라, QQQ'));
  // The stored bars and the last success stay from the day before.
  const spy = status.prices.series.find(series => series.key === 'arca:SPY')!;
  assert.deepEqual(spy.lastAttempt, { at: '2026-11-03T06:20:00.000Z', code: 'http_401' });
  assert.equal(spy.lastSuccessAt, '2026-11-02T06:20:00.000Z');
  const lines = formatHistoryStatus(status);
  assert.ok(lines.some(line => line.startsWith('  SPY(arca:SPY) · Massive · 일봉 ')
    && line.endsWith(' · 마지막 시도 실패: http_401 키 거부(인증 실패), 2026-11-03 15:20 KST')));
  // Never fetched successfully: not stored at all, so named as missing.
  const fresh = world();
  refreshSnapshots(fresh, at('2026-11-01T21:40:00Z'));
  await fresh.run('full', at('2026-11-02T06:20:00Z'), key => key === 'krx:005380' ? 'not_configured' : null);
  const partial = await readHistoryStatus(fresh.store, at('2026-11-02T07:00:00Z'));
  assert.deepEqual(partial.prices.missing, ['krx:005380']);
  assert.equal(warning(partial, 'price_series_missing')!.text, '가격 기록이 없는 종목: 현대자동차(krx:005380).');
  assert.ok(warning(partial, 'price_series_missing')!.hint.includes('KR_PRICE_API_KEY'));
  const partialLines = formatHistoryStatus(partial);
  assert.ok(partialLines.includes('  현대자동차 가격 없음'), 'a company without directions shows its status only');
  assert.ok(partialLines.includes('  현대자동차(krx:005380) · 기록 없음'));
});

test('derived checks: stale statistics, the daily write cap, observations and shadow counts', async () => {
  const base = await sharedDay();
  // Older than 26 hours, or no full job by 16:10 KST of the next day.
  const old = copyStore(base.store);
  editJson<StatsFile>(old, 'stats.json', stats => { stats.computedAt = '2026-11-01T06:20:00.000Z'; });
  assert.equal(warning(await readHistoryStatus(old, CHECK_AT), 'stats_stale')!.text,
    '마지막 전체 작업 계산이 2026-11-01 15:20 KST입니다. 15시대 전체 작업이 돌지 않았거나 중간에 멈췄을 수 있습니다.');
  const nextDay = await readHistoryStatus(copyStore(base.store), at('2026-11-03T07:30:00Z'));
  assert.ok(codes(nextDay).includes('stats_stale'));
  assert.ok(formatHistoryStatus(nextDay).includes('- 전체 작업(15시대): 오늘 기록 없음 · 마지막 계산 2026-11-02 15:20 KST'));
  const before = await readHistoryStatus(copyStore(base.store), at('2026-11-03T05:00:00Z'));
  assert.ok(!codes(before).includes('stats_stale'));
  assert.ok(formatHistoryStatus(before).includes('- 전체 작업(15시대): 오늘은 아직(15:00~15:59에 돎) · 마지막 계산 2026-11-02 15:20 KST'));

  // Eight writes before the evening ledger step is a warning; after it, a note.
  const early = await readHistoryStatus(copyStore(base.store), at('2026-11-02T09:00:00Z'));
  assert.equal(warning(early, 'write_cap')!.level, 'warn');

  // A company never observed, a recent gap, an old last snapshot.
  const observed = copyStore(base.store);
  editJson<LedgerSegmentFile>(observed, 'ledger/2026-11.json', head => {
    delete head.state.observations['krx:035420'];
    head.state.observations['nasdaq:NVDA']!.gaps = [{ start: '2026-10-29T00:00:00.000Z', end: '2026-10-30T12:00:00.000Z', detectedAt: '2026-11-01T23:10:00.000Z' }];
    head.state.observations['nasdaq:TSLA']!.lastSnapshotAt = '2026-10-31T11:40:00.000Z';
  });
  const watched = await readHistoryStatus(observed, CHECK_AT);
  assert.equal(warning(watched, 'observation_missing')!.text, '아직 스냅샷을 장부에 한 번도 기록하지 못한 회사: NAVER.');
  assert.equal(warning(watched, 'observation_gap')!.text, '최근 7일 안에 관측 공백이 생긴 회사: 엔비디아(2026-10-29 09:00~2026-10-30 21:00 KST).');
  assert.equal(warning(watched, 'observation_stale')!.text, '2일 넘게 새 스냅샷을 보지 못한 회사: 테슬라(마지막 2026-10-31 20:40 KST).');
  const watchedLines = formatHistoryStatus(watched);
  assert.ok(watchedLines.some(line => line.startsWith('  NAVER ') && line.endsWith('관측 기록 없음')));
  assert.ok(watchedLines.some(line => line.startsWith('  엔비디아 ') && line.endsWith('공백 1회(최근 2026-10-29 09:00~2026-10-30 21:00 KST)')));

  // Fewer than 16 shadow records on the latest date; no shadow record for the last full job's date.
  const thin = copyStore(base.store);
  editJson<ShadowFile>(thin, 'shadow/2026.json', shadow => { shadow.records = shadow.records.filter(record => record.companyId !== 'nasdaq:MSFT'); });
  const thinStatus = await readHistoryStatus(thin, CHECK_AT);
  assert.equal(warning(thinStatus, 'shadow_count')!.text, '가장 최근 그림자 기록(2026-11-02)이 14건입니다(보통 16건).');
  assert.ok(formatHistoryStatus(thinStatus).some(line => line === '  마이크로소프트 · 다음 거래일 기록 없음 · 다음 주 기록 없음'));
  const marked = copyStore(base.store);
  editJson<ShadowFile>(marked, 'shadow/2026.json', shadow => {
    const record = shadow.records.find(item => item.companyId === 'krx:005930' && item.horizon === 'day')!;
    record.stale = true;
    record.statsStatus = 'price_unavailable';
  });
  const markedStatus = await readHistoryStatus(marked, CHECK_AT);
  assert.deepEqual(markedStatus.warnings.filter(item => item.level === 'warn'), []);
  assert.ok(formatHistoryStatus(markedStatus).some(line => line.startsWith('  삼성전자 · 다음 거래일 ')
    && line.includes(' 이전 스냅샷 [통계 가격 없음] · 다음 주 ')));
  const behind = copyStore(base.store);
  behind.files.delete('shadow/2026.json');
  assert.equal(warning(await readHistoryStatus(behind, CHECK_AT), 'shadow_behind')!.text, '마지막 전체 작업 날짜(2026-11-02)의 그림자 기록이 없습니다.');
  // stats.json missing while the ledger exists: the first full job has not run yet.
  const first = copyStore(base.store);
  first.files.delete('stats.json');
  assert.ok(codes(await readHistoryStatus(first, CHECK_AT)).includes('stats_missing'));
});

test('what a full run leaves without a failure code: a US history adjusted again, an unsaved prices.json, a company without statistics', async () => {
  const base = await sharedDay();
  const next = await nextMorning(base);
  // NVDA's closes come back each scaled differently: no common ratio, so the job keeps the stored series as it was,
  // last attempt included. inconsistent_adjustment appears only in the run's own summary (Vercel logs, 1 hour).
  const run = await next.run('full', at('2026-11-03T06:20:00Z'), () => null,
    (key, date) => key === 'nasdaq:NVDA' ? 1 + (Number(date.slice(8)) % 7) / 50 : 1);
  assert.equal(run.prices!['nasdaq:NVDA']!.code, 'inconsistent_adjustment');
  const status = await readHistoryStatus(copyStore(next.store), at('2026-11-03T07:30:00Z'));
  const nvda = status.prices.series.find(series => series.key === 'nasdaq:NVDA')!;
  assert.deepEqual([nvda.lastSuccessAt, nvda.lastAttempt], ['2026-11-02T06:20:00.000Z', { at: '2026-11-02T06:20:00.000Z', code: 'ok' }]);
  assert.deepEqual(codes(status), ['price_stale']);
  assert.equal(warning(status, 'price_stale')!.text, '마지막 전체 작업(2026-11-03 15:20 KST)에서 새 가격이 저장되지 않은 종목: 엔비디아.');

  // prices.json as the run before left it (its write deferred or failed): every series is behind.
  const unsaved = copyStore(next.store);
  unsaved.files.set('prices.json', { ...base.store.files.get('prices.json')! });
  assert.equal(warning(await readHistoryStatus(unsaved, at('2026-11-03T07:30:00Z')), 'price_stale')!.text,
    '마지막 전체 작업(2026-11-03 15:20 KST)에서 새 가격이 저장되지 않은 종목: '
    + '삼성전자, SK하이닉스, NAVER, 현대자동차, KODEX 200, 애플, 엔비디아, 마이크로소프트, 테슬라, SPY, QQQ.');

  // A company the run could not compute, with no earlier value to carry over.
  const absent = copyStore(next.store);
  editJson<StatsFile>(absent, 'stats.json', stats => { delete stats.companies['krx:005380']; });
  const absentStatus = await readHistoryStatus(absent, at('2026-11-03T07:30:00Z'));
  assert.deepEqual(codes(absentStatus), ['stats_company_missing', 'price_stale']);
  assert.equal(warning(absentStatus, 'stats_company_missing')!.text, '통계 파일에 없는 회사: 현대자동차.');
  assert.ok(formatHistoryStatus(absentStatus).includes('  현대자동차 통계 없음'));
});

test('a full run that wrote the ledger but not stats.json is named at once, not taken for a run still to come', async () => {
  const next = await nextMorning(await sharedDay(), { failWrite: file => file === 'stats.json' ? 'write_failed' : null });
  const run = await next.run('full', at('2026-11-03T06:20:00Z'));
  assert.deepEqual(run.writes.failed, [{ file: 'stats.json', code: 'write_failed' }]);
  // 15:45 KST: stats.json is still the day before's, while the journal says today's full run wrote the ledger.
  const status = await readHistoryStatus(copyStore(next.store), at('2026-11-03T06:45:00Z'));
  assert.deepEqual(status.ledger.journal, { kstDate: '2026-11-03', writes: 6, fullDone: true });
  assert.equal(status.stats.computedAt, '2026-11-02T06:20:00.000Z');
  // The shadow file that run did write holds the day before's records and newer ones: not behind.
  assert.equal(status.shadow.latestDate, '2026-11-03');
  assert.deepEqual(codes(status), ['stats_not_written']);
  assert.equal(warning(status, 'stats_not_written')!.text,
    '오늘 전체 작업이 장부는 썼지만 통계 파일(stats.json)은 쓰지 못했습니다(마지막 계산 2026-11-02 15:20 KST).');
  const lines = formatHistoryStatus(status);
  assert.ok(lines.includes('- 전체 작업(15시대): 오늘 실행됐지만 stats.json은 아직 새로 쓰지 않음 · 마지막 계산 2026-11-02 15:20 KST'));
  assert.ok(lines.includes('- 쓰기 기록: 2026-11-03 6/8회 · 그날 전체 작업 실행됨 · 장부 시작 2026-06-01 09:00 KST'));
  // Minutes after the ledger write the run may still be writing stats.json; from 16:10 KST the stale check names it.
  assert.deepEqual(codes(await readHistoryStatus(copyStore(next.store), at('2026-11-03T06:22:00Z'))), []);
  assert.deepEqual(codes(await readHistoryStatus(copyStore(next.store), at('2026-11-03T07:30:00Z'))), ['stats_stale']);
});

test('the remaining checks: no ledger, a journal dated later, carried-over values, no prices, a lost segment, files past 4 MB', async () => {
  const base = await sharedDay();
  const check = (store: MemoryHistoryStore) => readHistoryStatus(store, CHECK_AT);

  const noLedger = copyStore(base.store);
  for (const name of [...noLedger.files.keys()]) if (name.startsWith('ledger/')) noLedger.files.delete(name);
  assert.ok(codes(await check(noLedger)).includes('ledger_missing'));

  const ahead = copyStore(base.store);
  editJson<LedgerSegmentFile>(ahead, 'ledger/2026-11.json', head => { head.state.journal.kstDate = '2026-11-03'; });
  assert.equal(warning(await check(ahead), 'journal_future')!.text, '장부의 쓰기 기록 날짜(2026-11-03)가 오늘(2026-11-02)보다 뒤입니다.');

  const carried = copyStore(base.store);
  editJson<StatsFile>(carried, 'stats.json', stats => { stats.carriedOver = ['nasdaq:AAPL']; });
  const carriedStatus = await check(carried);
  assert.equal(warning(carriedStatus, 'stats_carried_over')!.text, '통계를 새로 계산하지 못해 이전 값을 그대로 둔 회사: 애플.');
  assert.ok(formatHistoryStatus(carriedStatus).includes('- 이전 값 유지: 애플'));

  const noPrices = copyStore(base.store);
  noPrices.files.delete('prices.json');
  assert.ok(codes(await check(noPrices)).includes('prices_missing'));

  // A segment the head's directory names but the store lacks stops every run: it is never "not yet there".
  const lost = copyStore(base.store);
  lost.files.delete('ledger/2026-10.json');
  assert.equal(warning(await check(lost), 'read_errors')!.text, '읽지 못한 파일: ledger/2026-10.json(파일 없음, 장부 목록에는 있음).');
  // An unreadable stats.json: the E-3 line cannot tell, rather than "no record yet".
  const unreadable = formatHistoryStatus(await check(copyStore(base.store, { failRead: file => file === 'stats.json' ? 'timeout' : null })));
  assert.ok(unreadable.includes('- 전체 작업(15시대): stats.json 시간 초과'));
  assert.ok(unreadable.includes('- 08·21시대 실행(장부 단계): stats.json을 읽지 못해 판단할 수 없음'));

  // Past 4 MiB the ledger head moves to a new file by itself (a note); any other file needs a clean-up (a warning).
  const big = copyStore(base.store);
  const target = 4.3 * 1024 * 1024;
  editJson<LedgerSegmentFile>(big, 'ledger/2026-11.json', head => {
    head.entries = grow(head.entries, target, (entry, n) => n ? { ...entry, id: `${entry.id}-${n}` } : entry);
  });
  editJson<ShadowFile>(big, 'shadow/2026.json', shadow => { shadow.records = grow(shadow.records, target, record => record); });
  const bigStatus = await check(big);
  assert.ok(bigStatus.ledger.bytes! > LEDGER_ROLLOVER_BYTES && bigStatus.ledger.bytes! < MAX_FILE_BYTES);
  assert.ok(bigStatus.shadow.bytes! > NEAR_CAP_BYTES && bigStatus.shadow.bytes! < MAX_FILE_BYTES);
  assert.equal(warning(bigStatus, 'ledger_rollover')!.level, 'info');
  assert.equal(warning(bigStatus, 'file_near_cap')!.level, 'warn');
  assert.match(warning(bigStatus, 'file_near_cap')!.text, /^shadow\/2026\.json이 4MB를 넘었습니다\(4\.\d\dMB, 한도 5\.00MB\)\.$/);
  assert.equal(bigStatus.warnings.filter(item => item.code === 'file_near_cap').length, 1);
});

test('the Blob helper reads with the token option only, cannot write, and no token reaches the output', async () => {
  const w = await sharedDay();
  const files = new Map([...w.store.files].map(([name, file]) => [name, { ...file }]));
  const calls: Array<{ pathname: string; options: GetOptions }> = [];
  const envBefore = process.env.BLOB_READ_WRITE_TOKEN;
  const store = createReadOnlyBlobHistoryStore(TOKEN, { get: fakeBlobGet(files, calls) });
  assert.deepEqual(Object.keys(store).sort(), READ_METHODS);
  // Through the real Blob backend the summary equals the memory store's.
  const viaBlob = await readHistoryStatus(store, CHECK_AT);
  assert.deepEqual(viaBlob, await readHistoryStatus(copyStore(w.store), CHECK_AT));
  assert.equal(process.env.BLOB_READ_WRITE_TOKEN, envBefore, 'process.env is never set');
  assert.ok(calls.length >= 7);
  for (const call of calls) {
    assert.ok(call.pathname.startsWith(HISTORY_PREFIX), call.pathname);
    assert.equal(call.options.token, TOKEN);
    assert.equal(call.options.access, 'private');
    assert.equal(call.options.useCache, false);
  }
  // The token wins over any token in the options, and put always throws.
  const blob = readOnlyBlobFunctions(TOKEN, fakeBlobGet(files, calls));
  await blob.get(`${HISTORY_PREFIX}stats.json`, { access: 'private', token: 'vercel_blob_rw_other_secret' });
  assert.equal(calls[calls.length - 1]!.options.token, TOKEN);
  assert.throws(() => blob.put(`${HISTORY_PREFIX}stats.json`, '{}', { access: 'private', allowOverwrite: true }), /read_only/);

  // A stored code shaped like the token is shown as an unknown code, never echoed.
  const prices = JSON.parse(files.get('prices.json')!.text) as PricesFile;
  prices.series['nasdaq:TSLA']!.lastAttempt.code = TOKEN;
  files.set('prices.json', { text: JSON.stringify(prices), etag: '"planted"' });
  const planted = await readHistoryStatus(createReadOnlyBlobHistoryStore(TOKEN, { get: fakeBlobGet(files, []) }), CHECK_AT);
  assert.equal(planted.prices.series.find(series => series.key === 'nasdaq:TSLA')!.lastAttempt.code, 'unknown_code');
  const text = formatHistoryStatus(planted).join('\n');
  assert.ok(text.includes('[unknown_code: 알 수 없는 코드]: 테슬라'));
  assert.ok(!text.includes(TOKEN) && !text.includes('fake7_secret'));
  assert.equal(createRedactor([TOKEN]).contains(text), false);
  assert.equal(createRedactor([TOKEN]).contains(JSON.stringify(planted)), false);
});

test('token checks, the runner’s messages and the code filter', () => {
  assert.equal(blobTokenProblem(undefined), 'missing');
  assert.equal(blobTokenProblem('   '), 'missing');
  assert.equal(blobTokenProblem('BLOB_READ_WRITE_TOKEN=vercel_blob_rw_a_b'), 'format');
  assert.equal(blobTokenProblem('vercel_blob_rw_store'), 'format');
  assert.equal(blobTokenProblem(` ${TOKEN} `), null);
  assert.throws(() => createReadOnlyBlobHistoryStore('  ', { get: fakeBlobGet(new Map(), []) }), /missing_token/);
  for (const line of [MISSING_TOKEN_LINE, TOKEN_FORMAT_LINE]) {
    assert.ok(!line.includes('\n') && line.startsWith('history:status 중단: ') && line.includes(`${STATUS_TOKEN_ENV}=`));
  }
  assert.ok(MISSING_TOKEN_LINE.includes('D:\\moneycast\\.env') && MISSING_TOKEN_LINE.includes('Storage') && MISSING_TOKEN_LINE.includes('채팅'));
  for (const code of ['ok', 'not_configured', 'stopped', 'provider_error', 'http_401', 'http_429', 'http_0']) assert.equal(safePriceCode(code), code);
  for (const code of ['constructor', '__proto__', TOKEN, 'http_4010', 'ok_']) assert.equal(safePriceCode(code), 'unknown_code');
});
