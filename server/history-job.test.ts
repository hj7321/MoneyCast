import test from 'node:test';
import assert from 'node:assert/strict';
import { companies, integrateOutlook, NEWS_CACHE_ANALYSIS_VERSION, type Company, type NewsAnalysis, type NewsArticle } from '@moneycast/core';
import {
  DAILY_WRITE_CAP, FULL_MIN_WRITES, FULL_RESERVE_FOR_LEDGER, GDELT_COLLECTION, MARKETAUX_COLLECTION,
  allowedWrites, companyStatsInput, coverageStartMs, createHistoryService, frozenIndex, kstDate, observationAt, observeSnapshot,
  parseHistoryMode, runHistoryJob, selectWrites, shadowRecordsFor, usedWrites,
  type HistoryFileKind, type HistoryJobDeps, type HistoryJobMode, type HistoryJobSummary,
} from './history-job.js';
import { entriesFromSnapshot, foldLedger, ledgerKey, mergeLedger, type LedgerEntry } from './history-ledger.js';
import { companyStats } from './history-stats.js';
import {
  HISTORY_VERSIONS, createMemoryHistoryStore, parseLedgerSegmentFile,
  type DailyOutcomesFile, type FrozenDailyRecord, type FrozenWeeklyRecord, type HistoryStore, type LedgerSegmentFile,
  type MemoryHistoryStore, type MemoryStoreOptions, type PricesFile, type ShadowFile, type StatsFile, type StoredPriceSeries,
  type WeeklyOutcomesFile,
} from './history-store.js';
import { dayTargetWindow, sessionOn, sessionsBetween, weekTargetWindow, zonedTimeToUtc, CALENDAR_UNVERIFIED } from './market-calendar.js';
import {
  FETCH_ORDER, createPriceProviders, priceIdentity, publicationMs,
  type FetchedBar, type PriceFetchRequest, type PriceFetchResult, type PriceIdentity, type PriceProvider, type PriceProviderId,
  type PriceSeries,
} from './price-provider.js';
import { secretForms } from './price-wire.js';
import { createSnapshot, SNAPSHOT_POOL_LIMIT, type CompanySnapshot } from './snapshot-store.js';

// Compile-time: the stored series and the provider's series are the same shape.
const _storedIsSeries: PriceSeries = {} as StoredPriceSeries; void _storedIsSeries;
const _seriesIsStored: StoredPriceSeries = {} as PriceSeries; void _seriesIsStored;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const at = (text: string) => Date.parse(text);
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Deterministic 32-bit hash. */
function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
}

interface Clock { now: () => number; set(ms: number): void; advance(ms: number): void; tick: number }
function clock(startMs: number): Clock {
  let value = startMs;
  const c: Clock = {
    tick: 0,
    now: () => { value += c.tick; return value; },
    set: ms => { value = ms; },
    advance: ms => { value += ms; },
  };
  return c;
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

interface FakeOptions {
  /** Per key: a code to fail with. */
  fail?: (key: string) => PriceFetchResult['code'] | null;
  /** Clock time one fetch takes. */
  costMs?: number;
  /** Replaces the delivered bars. */
  transform?: (key: string, bars: FetchedBar[]) => FetchedBar[];
  calls?: Array<{ key: string; at: number; from: string; to: string }>;
}

/** Fake providers that deliver the published bars in range, with the provider's own clock. */
function fakeProviders(c: Clock, options: FakeOptions = {}): () => Record<PriceProviderId, PriceProvider> {
  const make = (id: PriceProviderId): PriceProvider => ({
    id, configured: true,
    async fetch(request: PriceFetchRequest): Promise<PriceFetchResult> {
      const attemptedAtMs = c.now();
      options.calls?.push({ key: request.identity.key, at: attemptedAtMs, from: request.from, to: request.to });
      c.advance(options.costMs ?? 0);
      const code = options.fail?.(request.identity.key) ?? null;
      const base = { key: request.identity.key, providerCode: null, counts: emptyCounts(), attemptedAt: iso(attemptedAtMs), ms: options.costMs ?? 0 };
      if (code && code !== 'ok') return { ...base, code, bars: [], receivedAt: null };
      const receivedAt = c.now();
      let bars = allBars(request.identity).filter(bar => {
        if (bar.date < request.from || bar.date > request.to) return false;
        const session = sessionOn(request.identity.exchange, bar.date);
        if (!session || session === CALENDAR_UNVERIFIED) return false;
        const pub = publicationMs(request.identity, session);
        return pub !== null && pub <= receivedAt;
      });
      if (options.transform) bars = options.transform(request.identity.key, bars);
      return { ...base, code: 'ok', bars: bars.map(bar => ({ ...bar })), receivedAt: iso(receivedAt) };
    },
  });
  return () => ({ fsc: make('fsc'), massive: make('massive') });
}

const company = (id: string) => companies.find(item => item.id === id)!;
const TITLE_WORDS = ['실적', '신제품', '공장', '계약', '규제', '소송', '증설', '배당', '인수', '협력', '출시', '감산', '수주', '전망', '투자', '리콜'];

let articleCounter = 0;
function article(companyId: string, publishedMs: number, sentiment: NewsArticle['sentiment'], extra: Partial<NewsArticle> = {}): NewsArticle {
  articleCounter += 1;
  const random = seeded(hash(`${companyId}-${articleCounter}-${publishedMs}`));
  const words = Array.from({ length: 5 }, () => TITLE_WORDS[Math.floor(random() * TITLE_WORDS.length)]!);
  const id = extra.id ?? `a-${companyId.replace(/\W/g, '')}-${articleCounter}`;
  return {
    id, title: `${company(companyId).name} ${words.join(' ')} ${articleCounter}호 ${hash(id).toString(36)}`, source: `pub${articleCounter % 7}.example`,
    publishedAt: iso(publishedMs), url: `https://news.example/${id}`, sentiment, rationale: '', sourceProvider: 'Marketaux',
    identity: 'entity_verified', classificationMethod: 'provider', sentimentScore: sentiment === 'positive' ? 0.5 : sentiment === 'negative' ? -0.5 : 0,
    ...extra,
  };
}

function snapshotOf(companyId: string, updatedMs: number, pool: NewsArticle[], analysis: Partial<NewsAnalysis> = {}): CompanySnapshot {
  const base: NewsAnalysis = {
    company: company(companyId), status: 'ready', articles: pool, asOf: iso(updatedMs),
    period: { start: '2026-11-16', end: '2026-11-20' }, evidence: 'low', summary: '요약', positiveFactors: ['긍정 요인'], negativeFactors: [], risks: [],
    provider: 'Marketaux', analysisVersion: NEWS_CACHE_ANALYSIS_VERSION, newsWindow: { start: iso(updatedMs - 7 * DAY), end: iso(updatedMs) },
    sources: [{ id: 'marketaux', label: 'Marketaux', status: 'ok', articleCount: pool.length }],
    ...analysis,
  };
  return createSnapshot(base, pool, new Date(updatedMs));
}

interface World {
  clock: Clock;
  store: MemoryHistoryStore;
  snapshots: Map<string, CompanySnapshot>;
  deps: (overrides?: Partial<HistoryJobDeps>) => HistoryJobDeps;
  run: (mode: HistoryJobMode, startMs?: number, overrides?: Partial<HistoryJobDeps>) => Promise<HistoryJobSummary>;
  ids: number;
}

function world(options: { start?: number; storeOptions?: MemoryStoreOptions; companies?: readonly Company[]; prices?: FakeOptions } = {}): World {
  const c = clock(options.start ?? at('2026-11-11T06:20:00Z'));
  const store = createMemoryHistoryStore({ now: () => c.now(), ...options.storeOptions });
  const snapshots = new Map<string, CompanySnapshot>();
  const w: World = {
    clock: c, store, snapshots, ids: 0,
    deps: overrides => ({
      store, snapshots: { read: async id => snapshots.get(id) ?? null }, priceProviders: fakeProviders(c, options.prices),
      companies: options.companies ?? companies, now: () => c.now(), randomId: () => `run-${++w.ids}`, redactKeys: [],
      ...overrides,
    }),
    async run(mode, startMs, overrides) {
      if (startMs !== undefined) c.set(startMs);
      return runHistoryJob(w.deps(overrides), mode);
    },
  };
  return w;
}

/** History before the scenario: articles from June, seen an hour after publication, in a 2026-10 segment. */
async function seedHistory(w: World, ids: readonly string[] = companies.map(item => item.id), throughMs = at('2026-10-30T00:00:00Z')) {
  const random = seeded(7);
  const entries: LedgerEntry[] = [];
  const sentiments: NewsArticle['sentiment'][] = ['positive', 'negative', 'neutral', 'positive', 'negative'];
  for (const id of ids) {
    for (let t = at('2026-06-01T01:00:00Z'); t < throughMs; t += Math.floor((1.5 + random() * 2.5) * DAY)) {
      const published = t + Math.floor(random() * 10) * HOUR;
      const item = article(id, published, sentiments[Math.floor(random() * sentiments.length)]!);
      entries.push(...entriesFromSnapshot(id, snapshotOf(id, published + HOUR, [item]), { collection: MARKETAUX_COLLECTION }));
    }
  }
  const observations = Object.fromEntries(ids.map(id => [id, { observedFrom: '2026-06-01T00:00:00.000Z', lastSnapshotAt: iso(throughMs), gaps: [] }]));
  const head: LedgerSegmentFile = {
    version: HISTORY_VERSIONS.ledger, segment: '2026-10', writtenAt: iso(throughMs),
    state: { createdAt: '2026-06-01T00:00:00.000Z', directory: ['2026-10'], observations, journal: { kstDate: '2026-10-30', writes: 3, fullDone: true }, writeToken: 'seed' },
    entries,
  };
  await w.store.writeLedgerSegment(head, { kind: 'createOnly' });
  return entries;
}

/** Fresh snapshots for every company: the seeded pool plus `extra` new articles each. */
function refreshSnapshots(w: World, updatedMs: number, perCompany = 2, ids: readonly string[] = companies.map(item => item.id)) {
  for (const id of ids) {
    const old = w.snapshots.get(id)?.pool ?? [];
    const fresh = Array.from({ length: perCompany }, (_, i) => article(id, updatedMs - (3 + i) * HOUR, i % 2 ? 'negative' : 'positive'));
    const pool = [...fresh, ...old].filter(item => Date.parse(item.publishedAt) > updatedMs - 7 * DAY).slice(0, SNAPSHOT_POOL_LIMIT);
    w.snapshots.set(id, snapshotOf(id, updatedMs, pool));
  }
}

function readFile<T>(store: MemoryHistoryStore, file: string): T | null {
  const stored = store.files.get(file);
  return stored ? JSON.parse(stored.text) as T : null;
}

async function foldStore(store: HistoryStore, month: string): Promise<LedgerEntry[]> {
  const head = await store.findLedgerHead(month);
  if (!head) return [];
  const segments: LedgerEntry[][] = [];
  for (const id of head.value.state.directory) segments.push((await store.readLedgerSegment(id))!.value.entries);
  return foldLedger(segments);
}

const writesBetween = (store: MemoryHistoryStore, fromMs: number, toMs = Infinity) => store.writeLog.filter(item => item.at >= fromMs && item.at < toMs);

// ---------------------------------------------------------------------------
// Pure parts
// ---------------------------------------------------------------------------

test('HISTORY_INSIGHTS: only off, collect and on, trimmed and case-insensitive; anything else is off', () => {
  for (const [value, mode] of [[undefined, 'off'], ['', 'off'], [' Collect ', 'collect'], ['ON', 'on'], ['maybe', 'off'], ['off', 'off'], ['true', 'off']] as const) {
    assert.equal(parseHistoryMode(value), mode, String(value));
  }
});

test('write allowance keeps a normal day at exactly 8 writes and leaves the full job its share', () => {
  const kst = '2026-11-11';
  const j = (writes: number, fullDone = false, date = kst) => ({ kstDate: date, writes, fullDone });
  assert.equal(usedWrites(j(5, false, '2026-11-10'), kst), 0);
  assert.equal(usedWrites(j(1, false, '2026-11-12'), kst), DAILY_WRITE_CAP, 'a journal from a later day blocks writing');
  assert.equal(allowedWrites(j(0, false, '2026-11-10'), kst, 'ledger'), DAILY_WRITE_CAP - FULL_MIN_WRITES - FULL_RESERVE_FOR_LEDGER);
  assert.equal(allowedWrites(j(1), kst, 'full'), DAILY_WRITE_CAP - 1 - FULL_RESERVE_FOR_LEDGER);
  assert.equal(allowedWrites(j(7, true), kst, 'ledger'), 1);
  assert.equal(allowedWrites(j(8, true), kst, 'ledger'), 0);
  // The full job keeps one write for the evening ledger run, so ledger runs before it leave three.
  assert.equal(allowedWrites(j(5), kst, 'ledger'), 0, 'ledger runs stop before the full job’s head, stats.json and evening write');
  assert.equal(allowedWrites(j(5), kst, 'full'), FULL_MIN_WRITES);
  const all = new Set<HistoryFileKind>(['head', 'stats', 'shadow', 'prices', 'daily', 'weekly']);
  assert.deepEqual(selectWrites(all, 6), { selected: ['head', 'shadow', 'prices', 'daily', 'weekly', 'stats'], deferred: [] });
  assert.deepEqual(selectWrites(all, 3), { selected: ['head', 'shadow', 'stats'], deferred: ['prices', 'daily', 'weekly'] });
  assert.deepEqual(selectWrites(all, 0), { selected: [], deferred: ['head', 'stats', 'shadow', 'prices', 'daily', 'weekly'] });
  assert.deepEqual(selectWrites(new Set(['head']), 1), { selected: ['head'], deferred: [] });
  assert.deepEqual(selectWrites(new Set(), 5), { selected: [], deferred: [] });
});

test('observation: first sighting starts it, continuous coverage adds no gap, a later coverage start leaves a dated gap', () => {
  const id = 'nasdaq:AAPL';
  const first = snapshotOf(id, at('2026-11-01T21:40:00Z'), [article(id, at('2026-10-30T00:00:00Z'), 'positive')]);
  const record = observeSnapshot(null, first, at('2026-11-01T23:10:00Z'));
  assert.deepEqual(record, { observedFrom: first.updatedAt, lastSnapshotAt: first.updatedAt, gaps: [] });
  assert.equal(observeSnapshot(record, first, at('2026-11-02T00:00:00Z')), record, 'the same snapshot changes nothing');
  const next = snapshotOf(id, at('2026-11-02T21:40:00Z'), first.pool);
  const continuous = observeSnapshot(record, next, at('2026-11-02T23:10:00Z'));
  assert.deepEqual(continuous.gaps, []);
  assert.equal(continuous.lastSnapshotAt, next.updatedAt);
  // Twelve days later the 7-day window starts after the last snapshot: a gap.
  const late = snapshotOf(id, at('2026-11-14T21:40:00Z'), []);
  const gapped = observeSnapshot(continuous, late, at('2026-11-14T23:10:00Z'));
  assert.deepEqual(gapped.gaps, [{ start: next.updatedAt, end: '2026-11-07T21:40:00.000Z', detectedAt: '2026-11-14T23:10:00.000Z' }]);
  assert.equal(gapped.observedFrom, first.updatedAt);
  // A full pool covers only back to its oldest article.
  const pool = Array.from({ length: SNAPSHOT_POOL_LIMIT }, (_, i) => article(id, at('2026-11-15T06:00:00Z') + i * MIN, 'neutral'));
  const full = snapshotOf(id, at('2026-11-15T21:40:00Z'), pool);
  assert.equal(coverageStartMs(full), at('2026-11-15T06:00:00Z'));
  const fullGap = observeSnapshot(gapped, full, at('2026-11-15T23:10:00Z'));
  assert.deepEqual(fullGap.gaps.at(-1), { start: late.updatedAt, end: '2026-11-15T06:00:00.000Z', detectedAt: '2026-11-15T23:10:00.000Z' });
  const state = { observations: { [id]: fullGap } };
  assert.deepEqual(observationAt(state, id, at('2026-11-14T00:00:00Z')), { fromMs: Date.parse(first.updatedAt), gaps: [] }, 'gaps are known only from detectedAt');
  assert.equal(observationAt(state, id, at('2026-11-16T00:00:00Z')).gaps!.length, 2);
  assert.deepEqual(observationAt({ observations: {} }, id, 123), { fromMs: 123, gaps: [] });
});

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

test('first full run creates the head, prices, shadow and stats, and its journal counts the writes', async () => {
  const w = world();
  refreshSnapshots(w, at('2026-11-10T21:40:00Z'));
  const summary = await w.run('full');
  assert.equal(summary.status, 'done', JSON.stringify(summary.errors));
  assert.deepEqual(summary.errors, []);
  assert.deepEqual(summary.writes.done, ['ledger/2026-11.json', 'shadow/2026.json', 'prices.json', 'stats.json']);
  assert.deepEqual(w.store.writeLog.map(item => item.ok), [true, true, true, true]);
  const head = readFile<LedgerSegmentFile>(w.store, 'ledger/2026-11.json')!;
  assert.deepEqual(head.state.journal, { kstDate: '2026-11-11', writes: 4, fullDone: true });
  assert.deepEqual(head.state.directory, ['2026-11']);
  assert.equal(head.state.writeToken, summary.runId);
  assert.equal(head.entries.length, 16);
  assert.equal(summary.ledger.newEntries, 16);
  assert.ok(head.entries.every(entry => entry.collection.fetch === MARKETAUX_COLLECTION.fetch));
  const stats = readFile<StatsFile>(w.store, 'stats.json')!;
  assert.deepEqual(Object.keys(stats.companies), companies.map(item => item.id));
  assert.equal(stats.computedAt, '2026-11-11T06:20:00.000Z');
  const prices = readFile<PricesFile>(w.store, 'prices.json')!;
  assert.deepEqual(Object.keys(prices.series).sort(), [...FETCH_ORDER.fsc, ...FETCH_ORDER.massive].sort());
  assert.equal(readFile<ShadowFile>(w.store, 'shadow/2026.json')!.records.length, 16);
  assert.equal(summary.ledger.snapshots.read.length, 8);
  // Observation starts at the first snapshot seen.
  assert.equal(head.state.observations['krx:005930']!.observedFrom, '2026-11-10T21:40:00.000Z');
  // The same day's rerun stops after one fresh stats.json read.
  const reads = w.store.reads.length;
  const writes = w.store.writeLog.length;
  const again = await w.run('full', at('2026-11-11T06:50:00Z'));
  assert.equal(again.status, 'already_done');
  assert.deepEqual(w.store.reads.slice(reads), [{ file: 'stats.json', fresh: true }]);
  assert.equal(w.store.writeLog.length, writes);
});

test('ledger mode writes the head once for new pool articles and nothing for duplicates or observation-only changes', async () => {
  const w = world({ start: at('2026-11-10T23:10:00Z') });
  refreshSnapshots(w, at('2026-11-10T21:40:00Z'));
  const first = await w.run('ledger');
  assert.equal(first.status, 'done');
  assert.deepEqual(first.writes.done, ['ledger/2026-11.json']);
  assert.equal(w.store.writeLog.length, 1);
  assert.equal(first.prices, null);
  assert.equal(first.stats, null);
  const duplicate = await w.run('ledger', at('2026-11-10T23:40:00Z'));
  assert.equal(duplicate.status, 'done');
  assert.deepEqual(duplicate.writes.done, []);
  // A newer snapshot with the same articles and labels moves only the observation.
  for (const [id, snapshot] of w.snapshots) w.snapshots.set(id, snapshotOf(id, at('2026-11-10T23:30:00Z'), snapshot.pool));
  const observationOnly = await w.run('ledger', at('2026-11-10T23:50:00Z'));
  assert.equal(observationOnly.ledger.changedEntries + observationOnly.ledger.newEntries, 0);
  assert.equal(w.store.writeLog.length, 1);
  // Ledger mode reads the head and only recent segments, and never prices or stats.
  assert.ok(w.store.reads.every(read => read.file.startsWith('ledger/')));
});

test('pools are split by provider: Marketaux and GDELT articles carry their collection descriptors', async () => {
  const w = world({ start: at('2026-11-10T23:10:00Z'), companies: [company('nasdaq:AAPL')] });
  const id = 'nasdaq:AAPL';
  const updated = at('2026-11-10T21:40:00Z');
  w.snapshots.set(id, snapshotOf(id, updated, [
    article(id, updated - 2 * HOUR, 'positive'),
    article(id, updated - 3 * HOUR, 'unclassified', { sourceProvider: 'GDELT', identity: 'name_match', timeKind: 'seen', publishedAt: '2026-11-10T18:40:00Z' }),
    article(id, updated - 4 * HOUR, 'neutral', { sourceProvider: 'Other' }),
  ]));
  const summary = await w.run('ledger');
  assert.equal(summary.status, 'done');
  const head = readFile<LedgerSegmentFile>(w.store, 'ledger/2026-11.json')!;
  assert.deepEqual(head.entries.map(entry => [entry.sourceProvider, entry.collection.fetch]).sort(),
    [['GDELT', GDELT_COLLECTION.fetch], ['Marketaux', MARKETAUX_COLLECTION.fetch], ['Other', 'snapshot']]);
  // A provider's own timestamp format is stored as the same instant in toISOString form.
  assert.ok(head.entries.some(entry => entry.publishedAt === '2026-11-10T18:40:00.000Z'));
});

test('a KST day of duplicate ledger runs, a weekly-freeze full run and a month boundary never exceeds 8 writes', async () => {
  const w = world({ start: at('2026-11-25T00:00:00Z') });
  await seedHistory(w, undefined, at('2026-11-25T00:00:00Z'));
  const dayStart = at('2026-11-30T15:00:00Z'); // 2026-12-01 00:00 KST
  // 08:10 KST on 2026-12-01: the month is new, the head lives in 2026-10.
  refreshSnapshots(w, at('2026-11-30T21:40:00Z'));
  const morning = await w.run('ledger', at('2026-11-30T23:10:00Z'));
  assert.deepEqual(morning.writes.done, ['ledger/2026-12.json']);
  assert.equal(morning.ledger.rolledOver, true);
  refreshSnapshots(w, at('2026-11-30T23:20:00Z'), 1);
  const morningAgain = await w.run('ledger', at('2026-11-30T23:40:00Z'));
  assert.deepEqual(morningAgain.writes.done, ['ledger/2026-12.json']);
  // 15:20 KST full: the first full run on this history freezes completed weeks, days and cases.
  const full = await w.run('full', at('2026-12-01T06:20:00Z'));
  assert.equal(full.status, 'partial');
  assert.ok(full.frozen!.weekly > 0 && full.frozen!.daily > 0 && full.frozen!.cases > 0, JSON.stringify(full.frozen));
  assert.equal(full.writes.allowance, 5);
  assert.deepEqual(full.writes.done, ['ledger/2026-12.json', 'shadow/2026.json', 'prices.json', 'daily/2026.json', 'stats.json']);
  assert.deepEqual(full.writes.deferred, ['weekly/2026.json']);
  assert.ok(full.errors.includes('write_cap'));
  // 21:10 KST: the evening ledger still gets its write; its duplicate does not.
  refreshSnapshots(w, at('2026-12-01T11:40:00Z'), 1);
  const evening = await w.run('ledger', at('2026-12-01T12:10:00Z'));
  assert.deepEqual(evening.writes.done, ['ledger/2026-12.json']);
  refreshSnapshots(w, at('2026-12-01T12:20:00Z'), 1);
  const eveningAgain = await w.run('ledger', at('2026-12-01T12:40:00Z'));
  assert.equal(eveningAgain.status, 'partial');
  assert.deepEqual(eveningAgain.writes.done, []);
  assert.deepEqual(eveningAgain.writes.deferred, ['ledger/2026-12.json']);
  assert.deepEqual(eveningAgain.errors, ['write_cap']);
  const today = writesBetween(w.store, dayStart, dayStart + DAY);
  assert.equal(today.length, DAILY_WRITE_CAP);
  const head = readFile<LedgerSegmentFile>(w.store, 'ledger/2026-12.json')!;
  assert.deepEqual(head.state.journal, { kstDate: '2026-12-01', writes: 8, fullDone: true });
  assert.deepEqual(head.state.directory, ['2026-10', '2026-12']);
  // The next KST day starts a fresh count, and the deferred weekly file is recomputed and written.
  refreshSnapshots(w, at('2026-12-01T21:40:00Z'), 1);
  const nextFull = await w.run('full', at('2026-12-02T06:20:00Z'));
  assert.ok(nextFull.writes.done.includes('weekly/2026.json'));
});

test('ledger runs before the full job stop at five writes, leaving it the head and stats.json', async () => {
  // Regression: ledger runs used to stop at six, and the full job's evening reserve then left it only the head.
  const w = world({ start: at('2026-11-10T22:00:00Z'), companies: [company('nasdaq:AAPL')] });
  const results: HistoryJobSummary[] = [];
  for (let i = 0; i < 8; i += 1) {
    refreshSnapshots(w, at('2026-11-10T22:00:00Z') + i * MIN, 1, ['nasdaq:AAPL']);
    results.push(await w.run('ledger', at('2026-11-10T22:30:00Z') + i * MIN));
  }
  assert.equal(results.reduce((sum, item) => sum + item.writes.done.length, 0), DAILY_WRITE_CAP - FULL_MIN_WRITES - FULL_RESERVE_FOR_LEDGER);
  assert.deepEqual(results.slice(-3).map(item => item.errors), [['write_cap'], ['write_cap'], ['write_cap']]);
  const full = await w.run('full', at('2026-11-11T06:20:00Z'));
  assert.deepEqual(full.writes.done, ['ledger/2026-11.json', 'stats.json']);
  assert.equal(w.store.writeLog.length, 7);
  // The day is done: a rerun stops at once, and the evening ledger run still has its write.
  assert.equal((await w.run('full', at('2026-11-11T06:50:00Z'))).status, 'already_done');
  refreshSnapshots(w, at('2026-11-11T11:40:00Z'), 1, ['nasdaq:AAPL']);
  assert.deepEqual((await w.run('ledger', at('2026-11-11T12:10:00Z'))).writes.done, ['ledger/2026-11.json']);
  assert.equal(w.store.writeLog.length, DAILY_WRITE_CAP);
});

test('a head changed by another run between read and write stops every write; a landed retry counts as success', async () => {
  let hijack = false;
  const w = world({ storeOptions: { failWrite: file => {
    if (hijack && file.startsWith('ledger/')) { const stored = w.store.files.get(file); if (stored) stored.etag = '"other-run"'; }
    return null;
  } } });
  refreshSnapshots(w, at('2026-11-10T21:40:00Z'));
  await w.run('ledger', at('2026-11-10T23:10:00Z'));
  refreshSnapshots(w, at('2026-11-11T05:00:00Z'), 1);
  hijack = true;
  const before = w.store.writeLog.length;
  const conflicted = await w.run('full', at('2026-11-11T06:20:00Z'));
  assert.equal(conflicted.status, 'failed');
  assert.deepEqual(conflicted.errors, ['ledger_conflict']);
  assert.deepEqual(conflicted.writes.done, []);
  assert.deepEqual(conflicted.writes.failed, [{ file: 'ledger/2026-11.json', code: 'conflict' }]);
  assert.deepEqual(w.store.writeLog.slice(before).map(item => item.file), ['ledger/2026-11.json']);
  assert.ok(!w.store.files.has('stats.json'));

  // The SDK retried a write that had landed: the second put conflicts, the stored writeToken is ours.
  const v = world();
  const retrying: HistoryStore = Object.create(v.store, {
    writeLedgerSegment: { value: async (file: LedgerSegmentFile, condition: Parameters<HistoryStore['writeLedgerSegment']>[1]) => {
      await v.store.writeLedgerSegment(file, condition);
      return v.store.writeLedgerSegment(file, condition);
    } },
  });
  refreshSnapshots(v, at('2026-11-10T21:40:00Z'));
  const landed = await v.run('full', at('2026-11-11T06:20:00Z'), { store: retrying });
  assert.equal(landed.status, 'done', JSON.stringify(landed.errors));
  assert.ok(landed.writes.done.includes('stats.json'));
});

test('month boundary and rollover: new segments carry patches and the fold equals one merged ledger', async () => {
  const w = world({ start: at('2026-11-30T12:10:00Z'), companies: [company('krx:005930'), company('nasdaq:AAPL')] });
  const ids = ['krx:005930', 'nasdaq:AAPL'];
  refreshSnapshots(w, at('2026-11-30T11:40:00Z'), 2, ids);
  const incoming: LedgerEntry[][] = [];
  const collect = () => incoming.push([...w.snapshots].flatMap(([id, snapshot]) => entriesFromSnapshot(id, snapshot, { collection: MARKETAUX_COLLECTION })));
  collect();
  const last = await w.run('ledger');
  assert.deepEqual(last.writes.done, ['ledger/2026-11.json']);
  // The first KST day of December relabels a November article and adds new ones.
  for (const id of ids) {
    const snapshot = w.snapshots.get(id)!;
    const [first, ...rest] = snapshot.pool;
    w.snapshots.set(id, snapshotOf(id, at('2026-11-30T21:40:00Z'), [{ ...first!, sentiment: 'negative', sentimentScore: -0.6 }, ...rest,
      article(id, at('2026-11-30T20:00:00Z'), 'positive')]));
  }
  collect();
  const firstDay = await w.run('ledger', at('2026-11-30T23:10:00Z'));
  assert.deepEqual(firstDay.writes.done, ['ledger/2026-12.json']);
  assert.equal(firstDay.ledger.rolledOver, true);
  const december = readFile<LedgerSegmentFile>(w.store, 'ledger/2026-12.json')!;
  assert.deepEqual(december.state.directory, ['2026-11', '2026-12']);
  assert.equal(december.entries.length, 4, 'two new entries and two relabel patches');
  const patch = december.entries.find(entry => entry.labels.length === 2)!;
  assert.ok(patch, 'a patch is the full merged entry');
  const reference = incoming.reduce<LedgerEntry[]>((ledger, batch) => mergeLedger(ledger, batch.map(entry => ({ ...entry, publishedAt: iso(Date.parse(entry.publishedAt)) }))), []);
  const folded = await foldStore(w.store, '2026-12');
  const byKey = (entries: LedgerEntry[]) => new Map(entries.map(entry => [ledgerKey(entry), json(entry)]));
  assert.deepEqual(byKey(folded), byKey(reference));

  // A small rollover limit opens shard .1 within the month, after sealing the old head under its etag
  // (journal and token only: its entries are unchanged, and both writes are counted).
  refreshSnapshots(w, at('2026-12-01T11:40:00Z'), 1, ids);
  const sealedBefore = readFile<LedgerSegmentFile>(w.store, 'ledger/2026-12.json')!;
  const shard = await w.run('ledger', at('2026-12-01T12:10:00Z'), { limits: { rolloverBytes: 1_000 } });
  assert.deepEqual(shard.writes.done, ['ledger/2026-12.json', 'ledger/2026-12.1.json']);
  const sealed = readFile<LedgerSegmentFile>(w.store, 'ledger/2026-12.json')!;
  assert.deepEqual(sealed.entries, sealedBefore.entries);
  assert.deepEqual(sealed.state.observations, sealedBefore.state.observations);
  assert.equal(sealed.state.writeToken, shard.runId);
  const head = (await w.store.findLedgerHead('2026-12'))!;
  assert.equal(head.value.segment, '2026-12.1');
  assert.deepEqual(head.value.state.directory, ['2026-11', '2026-12', '2026-12.1']);
  assert.deepEqual(head.value.state.journal, sealed.state.journal);
  assert.equal(head.value.state.journal.writes, shard.writes.usedBefore + 2);
  assert.equal((await foldStore(w.store, '2026-12')).length, folded.length + 2);
});

// ---------------------------------------------------------------------------
// Partial failures (spec 5.8)
// ---------------------------------------------------------------------------

const TWO = [company('krx:005930'), company('nasdaq:AAPL')];

test('no Blob store: not_configured and nothing runs', async () => {
  let providerCalls = 0;
  const w = world();
  const summary = await w.run('full', undefined, { store: null, priceProviders: () => { providerCalls += 1; return fakeProviders(w.clock)(); } });
  assert.equal(summary.status, 'not_configured');
  assert.deepEqual(summary.errors, ['store_not_configured']);
  assert.equal(providerCalls, 0);
  assert.equal(w.store.reads.length, 0);
});

test('an unreadable, invalid or unsupported ledger stops the run before any fetch or write', async () => {
  for (const [setup, error] of [
    [(w: World) => { w.store.files.set('ledger/2026-11.json', { text: '{not json', etag: '"x"' }); }, 'ledger_invalid'],
    [(w: World) => { w.store.files.set('ledger/2026-11.json', { text: JSON.stringify({ version: 'news-history-ledger-v9' }), etag: '"x"' }); }, 'ledger_unsupported'],
  ] as const) {
    const w = world({ companies: TWO });
    setup(w);
    let calls = 0;
    const summary = await w.run('full', undefined, { priceProviders: () => { calls += 1; return fakeProviders(w.clock)(); } });
    assert.equal(summary.status, 'failed');
    assert.deepEqual(summary.errors, [error]);
    assert.equal(calls, 0);
    assert.equal(w.store.writeLog.length, 0);
  }
  const unreadable = world({ companies: TWO, storeOptions: { failRead: file => file === 'ledger/2026-11.json' ? 'unreadable' : null } });
  const summary = await unreadable.run('ledger');
  assert.deepEqual([summary.status, summary.errors], ['failed', ['ledger_unreadable']]);
  // A missing older segment is as bad as an unreadable head.
  const w = world({ companies: TWO, start: at('2026-11-25T00:00:00Z') });
  await seedHistory(w, ['krx:005930'], at('2026-11-20T00:00:00Z'));
  refreshSnapshots(w, at('2026-11-30T21:40:00Z'), 1, ['krx:005930']);
  await w.run('ledger', at('2026-11-30T23:10:00Z'));
  w.store.files.delete('ledger/2026-10.json');
  const missing = await w.run('full', at('2026-12-01T06:20:00Z'));
  assert.deepEqual([missing.status, missing.errors], ['failed', ['ledger_unreadable']]);
  assert.equal(writesBetween(w.store, at('2026-12-01T00:00:00Z')).length, 0);
});

test('the load deadline fails the run with no writes', async () => {
  const w = world({ companies: TWO, start: at('2026-11-25T00:00:00Z') });
  await seedHistory(w, ['krx:005930'], at('2026-11-20T00:00:00Z'));
  refreshSnapshots(w, at('2026-11-30T21:40:00Z'), 1, ['krx:005930']);
  await w.run('ledger', at('2026-11-30T23:10:00Z'));
  const slow: HistoryStore = Object.create(w.store, {
    readLedgerSegment: { value: async (id: string, o?: { fresh?: boolean }) => { w.clock.advance(50_000); return w.store.readLedgerSegment(id, o); } },
  });
  const before = w.store.writeLog.length;
  const summary = await w.run('full', at('2026-12-01T06:20:00Z'), { store: slow });
  assert.deepEqual([summary.status, summary.errors], ['failed', ['ledger_load_timeout']]);
  assert.equal(w.store.writeLog.length, before);
});

test('stats, snapshot, prices, provider, outcome and shadow failures degrade to partial and keep stored data', async () => {
  // stats.json unreadable: the run continues and the journal still caps writes.
  {
    const w = world({ companies: TWO, storeOptions: { failRead: file => file === 'stats.json' ? 'unreadable' : null } });
    refreshSnapshots(w, at('2026-11-10T21:40:00Z'), 1, ['krx:005930', 'nasdaq:AAPL']);
    const summary = await w.run('full');
    assert.deepEqual([summary.status, summary.errors], ['partial', ['stats_unreadable']]);
    assert.ok(summary.writes.done.includes('stats.json'));
  }
  // A missing snapshot is normal (done); an unreadable one is partial. Both leave a withheld shadow.
  {
    const w = world({ companies: TWO });
    refreshSnapshots(w, at('2026-11-10T21:40:00Z'), 1, ['krx:005930']);
    const missing = await w.run('full');
    assert.equal(missing.status, 'done');
    assert.deepEqual(missing.ledger.snapshots.missing, ['nasdaq:AAPL']);
    const shadow = readFile<ShadowFile>(w.store, 'shadow/2026.json')!;
    assert.ok(shadow.records.filter(record => record.companyId === 'nasdaq:AAPL').every(record => record.snapshot === null && record.baseline === 'withheld'));
    const v = world({ companies: TWO });
    refreshSnapshots(v, at('2026-11-10T21:40:00Z'), 1, ['krx:005930']);
    const unreadable = await v.run('full', undefined, { snapshots: { read: async id => { if (id === 'nasdaq:AAPL') throw new Error('blob'); return v.snapshots.get(id) ?? null; } } });
    assert.deepEqual([unreadable.status, unreadable.errors], ['partial', ['snapshot_unreadable']]);
    assert.deepEqual(unreadable.ledger.snapshots.unreadable, ['nasdaq:AAPL']);
    const none = await world({ companies: TWO }).run('full', undefined, { snapshots: null });
    assert.deepEqual([none.status, none.errors], ['partial', ['snapshots_not_configured']]);
  }
  // prices.json invalid: fetch and compute, never overwrite it.
  {
    const w = world({ companies: TWO });
    w.store.files.set('prices.json', { text: JSON.stringify({ version: HISTORY_VERSIONS.prices, writtenAt: 'bad', series: {} }), etag: '"p"' });
    refreshSnapshots(w, at('2026-11-10T21:40:00Z'), 1, ['krx:005930', 'nasdaq:AAPL']);
    const summary = await w.run('full');
    assert.deepEqual([summary.status, summary.errors], ['partial', ['prices_invalid']]);
    assert.ok(!summary.writes.done.includes('prices.json'));
    assert.equal(w.store.files.get('prices.json')!.etag, '"p"');
    assert.equal(summary.stats!.statuses['krx:005930'], 'ready', 'statistics use the fetched bars');
  }
  // One provider down or unconfigured: stored bars are used, the other lane merges.
  {
    const w = world({ companies: TWO });
    refreshSnapshots(w, at('2026-11-10T21:40:00Z'), 1, ['krx:005930', 'nasdaq:AAPL']);
    await w.run('full');
    const stored = readFile<PricesFile>(w.store, 'prices.json')!;
    refreshSnapshots(w, at('2026-11-11T21:40:00Z'), 1, ['krx:005930', 'nasdaq:AAPL']);
    const down = await w.run('full', at('2026-11-12T06:20:00Z'), {
      priceProviders: fakeProviders(w.clock, { fail: key => key.startsWith('krx:') ? 'http_503' : key === 'nasdaq:QQQ' ? 'not_configured' : null }),
    });
    assert.deepEqual([down.status, down.errors], ['partial', ['price_fetch_failed', 'price_not_configured']]);
    const after = readFile<PricesFile>(w.store, 'prices.json')!;
    assert.deepEqual(after.series['krx:005930']!.bars, stored.series['krx:005930']!.bars);
    assert.equal(after.series['krx:005930']!.lastAttempt.code, 'http_503');
    assert.ok(after.series['nasdaq:AAPL']!.bars.length > stored.series['nasdaq:AAPL']!.bars.length);
    assert.equal(down.stats!.statuses['krx:005930'], 'ready');
  }
  // inconsistent_adjustment keeps the stored series.
  {
    const w = world({ companies: TWO });
    refreshSnapshots(w, at('2026-11-10T21:40:00Z'), 1, ['krx:005930', 'nasdaq:AAPL']);
    await w.run('full');
    const stored = readFile<PricesFile>(w.store, 'prices.json')!.series['nasdaq:AAPL']!;
    const summary = await w.run('full', at('2026-11-12T06:20:00Z'), {
      priceProviders: fakeProviders(w.clock, { transform: (key, bars) => key === 'nasdaq:AAPL'
        ? bars.map((bar, i) => ({ ...bar, close: bar.close * (i % 2 ? 1.5 : 1), adjClose: bar.close * (i % 2 ? 1.5 : 1) })) : bars }),
    });
    assert.equal(summary.prices!['nasdaq:AAPL']!.code, 'inconsistent_adjustment');
    assert.ok(summary.errors.includes('price_fetch_failed'));
    assert.deepEqual(readFile<PricesFile>(w.store, 'prices.json')!.series['nasdaq:AAPL'], stored);
  }
  // A current-year weekly file that fails its check is not written; a shadow file likewise.
  {
    const w = world({ companies: TWO });
    const badWeekly = { version: HISTORY_VERSIONS.outcomes, kind: 'weekly', year: 2026, writtenAt: '2026-01-01T00:00:00.000Z', records: [{}] };
    w.store.files.set('weekly/2026.json', { text: JSON.stringify(badWeekly), etag: '"w"' });
    w.store.files.set('shadow/2026.json', { text: JSON.stringify({ version: 'news-history-shadow-v0' }), etag: '"s"' });
    refreshSnapshots(w, at('2026-11-10T21:40:00Z'), 1, ['krx:005930', 'nasdaq:AAPL']);
    const summary = await w.run('full');
    assert.deepEqual([summary.status, summary.errors], ['partial', ['outcomes_invalid', 'shadow_invalid']]);
    assert.ok(!summary.writes.done.includes('weekly/2026.json') && !summary.writes.done.includes('shadow/2026.json'));
    assert.equal(w.store.files.get('weekly/2026.json')!.etag, '"w"');
    assert.ok(summary.writes.done.includes('stats.json'));
  }
  // A non-head write failure is recorded and the remaining files continue.
  {
    const w = world({ companies: TWO, storeOptions: { failWrite: file => file === 'prices.json' ? 'write_failed' : null } });
    refreshSnapshots(w, at('2026-11-10T21:40:00Z'), 1, ['krx:005930', 'nasdaq:AAPL']);
    const summary = await w.run('full');
    assert.deepEqual([summary.status, summary.errors], ['partial', ['write_failed']]);
    assert.deepEqual(summary.writes.failed, [{ file: 'prices.json', code: 'write_failed' }]);
    assert.deepEqual(summary.writes.done, ['ledger/2026-11.json', 'shadow/2026.json', 'stats.json']);
  }
});

test('a company that throws or the compute budget carries its previous statistics over', async () => {
  const w = world({ companies: [...TWO, { id: 'krx:999999', name: '가상', symbol: '999999', exchange: 'KOSPI', region: 'KR' }] });
  refreshSnapshots(w, at('2026-11-10T21:40:00Z'), 1, ['krx:005930', 'nasdaq:AAPL']);
  const first = await w.run('full');
  assert.deepEqual(first.stats!.failed, ['krx:999999']);
  assert.ok(first.errors.includes('stats_failed'));
  const firstStats = readFile<StatsFile>(w.store, 'stats.json')!;
  assert.deepEqual(firstStats.carriedOver, []);
  // The next day the clock races during computation: later companies carry over.
  refreshSnapshots(w, at('2026-11-11T21:40:00Z'), 1, ['krx:005930', 'nasdaq:AAPL']);
  const providers = fakeProviders(w.clock);
  const summary = await w.run('full', at('2026-11-12T06:20:00Z'), {
    priceProviders: () => {
      const made = providers();
      const massive = made.massive;
      let count = 0;
      made.massive = { ...massive, fetch: async (request, deadline) => {
        const result = await massive.fetch(request, deadline);
        // Computation starts just before the 220 s checkpoint, and every clock read then takes 0.6 s.
        if (++count === FETCH_ORDER.massive.length) { w.clock.set(at('2026-11-12T06:20:00Z') + 218_000); w.clock.tick = 600; }
        return result;
      } };
      return made;
    },
  });
  w.clock.tick = 0;
  assert.deepEqual(summary.errors, ['compute_budget']);
  assert.ok(summary.writes.done.includes('stats.json'));
  assert.deepEqual(summary.stats!.computed, ['krx:005930']);
  assert.deepEqual(summary.stats!.carriedOver, ['nasdaq:AAPL']);
  const stats = readFile<StatsFile>(w.store, 'stats.json')!;
  assert.deepEqual(stats.carriedOver, ['nasdaq:AAPL']);
  assert.deepEqual(stats.companies['nasdaq:AAPL'], firstStats.companies['nasdaq:AAPL']);
  assert.notDeepEqual(stats.companies['krx:005930']!.dataAsOf, firstStats.companies['krx:005930']!.dataAsOf);
});

// ---------------------------------------------------------------------------
// Look-ahead, replay and freezing
// ---------------------------------------------------------------------------

async function replayStats(store: MemoryHistoryStore, month: string, nowMs: number, companyId: string) {
  const head = (await store.findLedgerHead(month))!;
  const entries = await foldStore(store, month);
  const prices = (await store.readPrices())!.value;
  const weekly: FrozenWeeklyRecord[] = [];
  const daily: FrozenDailyRecord[] = [];
  for (let year = 2026; year <= 2026; year += 1) {
    weekly.push(...((await store.readWeekly(year))?.value.records ?? []));
    daily.push(...((await store.readDaily(year))?.value.records ?? []));
  }
  return companyStats(companyStatsInput({
    companyId, entries, observations: head.value.state.observations, series: prices.series as Record<string, PriceSeries>,
    frozen: frozenIndex(weekly, daily), nowMs,
  }));
}

test('replay: the next day’s store computed at the earlier clock gives the earlier stats exactly', async () => {
  const w = world({ start: at('2026-11-01T00:00:00Z') });
  await seedHistory(w, undefined, at('2026-11-01T00:00:00Z'));
  // Day N: morning ledger, full job.
  refreshSnapshots(w, at('2026-11-10T21:40:00Z'));
  await w.run('ledger', at('2026-11-10T23:10:00Z'));
  const dayN = await w.run('full', at('2026-11-11T06:20:00Z'));
  assert.ok(['done', 'partial'].includes(dayN.status), JSON.stringify(dayN.errors));
  const statsN = readFile<StatsFile>(w.store, 'stats.json')!;
  const computeAtN = Date.parse(statsN.computedAt);
  assert.ok(Object.values(statsN.companies).some(stats => stats.status === 'ready'));
  const weeklyN = readFile<WeeklyOutcomesFile>(w.store, 'weekly/2026.json')!;
  const dailyN = readFile<DailyOutcomesFile>(w.store, 'daily/2026.json')!;
  const foldedN = new Map((await foldStore(w.store, '2026-11')).map(entry => [ledgerKey(entry), entry.outcome]));
  assert.ok(weeklyN.records.length > 0 && dailyN.records.length > 0);
  assert.ok(weeklyN.records.every(record => record.outcome.status === 'complete' && record.frozenAt === statsN.computedAt));

  // Evening: relabels and new articles. Next morning: a full pool after a pause leaves a gap. Then the next full job.
  for (const [id, snapshot] of w.snapshots) {
    const [first, ...rest] = snapshot.pool;
    w.snapshots.set(id, snapshotOf(id, at('2026-11-11T11:40:00Z'), [{ ...first!, sentiment: 'negative', sentimentScore: -0.7 }, ...rest,
      article(id, at('2026-11-11T09:00:00Z'), 'positive')]));
  }
  await w.run('ledger', at('2026-11-11T12:10:00Z'));
  const apple = 'nasdaq:AAPL';
  w.snapshots.set(apple, snapshotOf(apple, at('2026-11-11T21:40:00Z'),
    Array.from({ length: SNAPSHOT_POOL_LIMIT }, (_, i) => article(apple, at('2026-11-11T14:00:00Z') + i * 10 * MIN, i % 3 ? 'positive' : 'neutral'))));
  const morning = await w.run('ledger', at('2026-11-11T23:10:00Z'));
  assert.deepEqual(morning.ledger.gapsAdded, [apple]);
  const dayN1 = await w.run('full', at('2026-11-12T06:20:00Z'));
  assert.ok(dayN1.writes.done.includes('stats.json'));
  assert.ok(dayN1.prices!['nasdaq:AAPL']!.newBars > 0);

  for (const { id } of companies) {
    assert.deepEqual(json(await replayStats(w.store, '2026-11', computeAtN, id)), json(statsN.companies[id]), id);
  }
  // Frozen records and case outcomes from day N are kept as they were.
  const weeklyN1 = readFile<WeeklyOutcomesFile>(w.store, 'weekly/2026.json')!;
  assert.deepEqual(weeklyN1.records.slice(0, weeklyN.records.length), weeklyN.records);
  const keys = new Set<string>();
  for (const record of [...weeklyN1.records]) {
    const key = `${record.companyId}|${record.weekAsOf}|${record.priceBasisVersion}`;
    assert.ok(!keys.has(key), 'one frozen record per key');
    keys.add(key);
  }
  for (const entry of await foldStore(w.store, '2026-11')) {
    const before = foldedN.get(ledgerKey(entry));
    if (before) assert.deepEqual(entry.outcome, before);
  }
});

test('rewriting prices inside and after frozen windows never changes a frozen outcome; a basis change re-freezes once', async () => {
  const ids = ['krx:005930', 'nasdaq:AAPL'];
  const w = world({ start: at('2026-11-01T00:00:00Z'), companies: TWO });
  await seedHistory(w, ids, at('2026-11-01T00:00:00Z'));
  refreshSnapshots(w, at('2026-11-10T21:40:00Z'), 2, ids);
  await w.run('full', at('2026-11-11T06:20:00Z'));
  const weekly = readFile<WeeklyOutcomesFile>(w.store, 'weekly/2026.json')!.records;
  const daily = readFile<DailyOutcomesFile>(w.store, 'daily/2026.json')!.records;
  const cases = new Map((await foldStore(w.store, '2026-11')).filter(entry => entry.outcome).map(entry => [ledgerKey(entry), entry.outcome!]));
  assert.ok(weekly.length && daily.length && cases.size);
  assert.ok([...cases.values()].every(outcome => outcome.frozenAt === '2026-11-11T06:20:00.000Z'));
  // Rewrite every stored bar (inside and after the frozen windows) and serve the rewritten bars from now on.
  const stored = (await w.store.readPrices())!;
  // The exchange base price moves with the close, so the rewrite is no corporate action.
  const scale = (bars: PriceSeries['bars']) => bars.map(bar => ({ ...bar, open: bar.open * 1.7, high: bar.high * 1.9, low: bar.low * 1.5, close: bar.close * 1.8,
    ...(bar.adjClose ? { adjClose: bar.adjClose * 1.8 } : {}), ...(bar.base ? { base: bar.base * 1.8 } : {}) }));
  const series = Object.fromEntries(Object.entries(stored.value.series).map(([key, item]) => [key, { ...item, bars: scale(item.bars) }]));
  await w.store.writePrices({ ...stored.value, series });
  refreshSnapshots(w, at('2026-11-11T21:40:00Z'), 1, ids);
  const next = await w.run('full', at('2026-11-12T06:20:00Z'), {
    priceProviders: fakeProviders(w.clock, { transform: (_key, bars) => scale(bars as PriceSeries['bars']) }),
  });
  assert.ok(next.writes.done.includes('stats.json'));
  const weeklyAfter = readFile<WeeklyOutcomesFile>(w.store, 'weekly/2026.json')!.records;
  assert.deepEqual(weeklyAfter.slice(0, weekly.length), weekly);
  assert.deepEqual(readFile<DailyOutcomesFile>(w.store, 'daily/2026.json')!.records.slice(0, daily.length), daily);
  const folded = await foldStore(w.store, '2026-11');
  for (const entry of folded) if (cases.has(ledgerKey(entry))) assert.deepEqual(entry.outcome, cases.get(ledgerKey(entry)));
  // The source the job uses serves the frozen values, not the rewritten bars.
  const head = (await w.store.findLedgerHead('2026-11'))!;
  const input = companyStatsInput({ companyId: 'krx:005930', entries: folded, observations: head.value.state.observations,
    series: (await w.store.readPrices())!.value.series as Record<string, PriceSeries>, frozen: frozenIndex(weeklyAfter, []), nowMs: at('2026-11-12T06:20:00Z') });
  const frozenWeek = weekly.find(record => record.companyId === 'krx:005930')!;
  assert.deepEqual(input.outcomes.week(frozenWeek.outcome.weekAsOfMs), frozenWeek.outcome);
  assert.ok(weeklyAfter.every(record => record.outcome.status === 'complete'));

  // A basis-version change (simulated by relabelling every stored version) re-freezes everything once, later.
  const relabel = <T extends { priceBasisVersion: string }>(records: T[]) => records.map(record => ({ ...record, priceBasisVersion: 'old-basis/outcomes-v0' }));
  const weeklyFile = (await w.store.readWeekly(2026))!.value;
  await w.store.writeWeekly({ ...weeklyFile, records: relabel(weeklyFile.records) });
  const headFile = (await w.store.findLedgerHead('2026-11'))!;
  await w.store.writeLedgerSegment({ ...headFile.value, entries: headFile.value.entries.map(entry => entry.outcome
    ? { ...entry, outcome: { ...entry.outcome, priceBasisVersion: 'old-basis/outcomes-v0' } } : entry) }, { kind: 'ifMatch', etag: headFile.etag });
  refreshSnapshots(w, at('2026-11-12T21:40:00Z'), 1, ids);
  const refrozen = await w.run('full', at('2026-11-13T06:20:00Z'));
  assert.ok(refrozen.frozen!.weekly >= weeklyFile.records.length, JSON.stringify(refrozen.frozen));
  const latest = await foldStore(w.store, '2026-11');
  const relabelled = latest.filter(entry => cases.has(ledgerKey(entry)));
  assert.ok(relabelled.every(entry => entry.outcome!.priceBasisVersion === 'fsc-raw-v1/outcomes-v1' || entry.outcome!.priceBasisVersion === 'massive-split-v1/outcomes-v1'));
  assert.ok(relabelled.every(entry => entry.outcome!.frozenAt === '2026-11-13T06:20:00.000Z'));
});

// ---------------------------------------------------------------------------
// Shadow records
// ---------------------------------------------------------------------------

test('shadow: 16 records per day, the first wins on rerun, targets and integration follow the shared rules, stale is marked', async () => {
  const w = world();
  refreshSnapshots(w, at('2026-11-10T21:40:00Z'));
  const apple = w.snapshots.get('nasdaq:AAPL')!;
  // Two overnight articles for Apple's next session window.
  const window = dayTargetWindow('NASDAQ', at('2026-11-11T06:20:00Z')).newsWindow;
  const overnight = [article('nasdaq:AAPL', Date.parse(window.start) + HOUR, 'positive'), article('nasdaq:AAPL', Date.parse(window.start) + 2 * HOUR, 'positive')];
  w.snapshots.set('nasdaq:AAPL', snapshotOf('nasdaq:AAPL', Date.parse(apple.updatedAt), [...overnight, ...apple.pool]));
  const first = await w.run('full');
  assert.deepEqual(first.shadow, { recorded: 16, kept: 0 });
  const records = readFile<ShadowFile>(w.store, 'shadow/2026.json')!.records;
  assert.equal(records.length, 16);
  const stats = readFile<StatsFile>(w.store, 'stats.json')!;
  for (const record of records) {
    const exchange = record.companyId.startsWith('krx:') ? 'KRX' : 'NASDAQ';
    const target = record.horizon === 'day' ? dayTargetWindow(exchange, at('2026-11-11T06:20:00Z')).targetWindow : weekTargetWindow(exchange, at('2026-11-11T06:20:00Z'));
    assert.deepEqual(record.target, { start: target.start, end: target.end, basis: target.basis, phase: target.phase });
    assert.equal(record.recordDate, '2026-11-11');
    assert.equal(record.statsStatus, stats.companies[record.companyId]!.status);
    const expected = integrateOutlook(record.baseline, record.verdict ?? 'insufficient');
    assert.deepEqual([record.integrated, record.changed, record.note], [expected.signal, expected.changed, expected.note]);
    assert.equal(record.stale, false);
    assert.equal(record.newsWindow === null, record.horizon === 'week');
  }
  const appleDay = records.find(record => record.companyId === 'nasdaq:AAPL' && record.horizon === 'day')!;
  assert.deepEqual(appleDay.overnight, { reason: 'one_direction', evidence: 'moderate', counts: { positive: 2, negative: 0, neutral: 0, ignored: 0 } });
  assert.equal(appleDay.baseline, 'positive');
  const appleWeek = records.find(record => record.companyId === 'nasdaq:AAPL' && record.horizon === 'week')!;
  assert.equal(appleWeek.baseline, 'positive', 'week baseline from the analysis factors');
  // A rerun the same day (stats.json removed) keeps the first records.
  w.store.files.delete('stats.json');
  const rerun = await w.run('full', at('2026-11-11T07:00:00Z'));
  assert.deepEqual(rerun.shadow, { recorded: 0, kept: 16 });
  assert.ok(!rerun.writes.done.includes('shadow/2026.json'));
  // The next day with the same snapshots: every record is stale.
  const next = await w.run('full', at('2026-11-12T06:20:00Z'));
  assert.deepEqual(next.shadow, { recorded: 16, kept: 0 });
  const nextRecords = readFile<ShadowFile>(w.store, 'shadow/2026.json')!.records.filter(record => record.recordDate === '2026-11-12');
  assert.ok(nextRecords.every(record => record.stale));
  // The pure builder agrees with what the job stored.
  const built = shadowRecordsFor({ companyId: 'nasdaq:AAPL', exchange: 'NASDAQ', snapshot: w.snapshots.get('nasdaq:AAPL')!,
    stats: stats.companies['nasdaq:AAPL']!, computeAtMs: at('2026-11-11T06:20:00Z'), previous: [] });
  assert.deepEqual(json(built), records.filter(record => record.companyId === 'nasdaq:AAPL'));
});

// ---------------------------------------------------------------------------
// Time budgets and the real adapters
// ---------------------------------------------------------------------------

function aggsBody(ticker: string, from: string, to: string, nowMs: number, echo = '') {
  const identity = [...FETCH_ORDER.massive].map(key => priceIdentity(key)!).find(item => item.providerSymbol === ticker)!;
  const results = allBars(identity).filter(bar => bar.date >= from && bar.date <= to).filter(bar => {
    const session = sessionOn('NASDAQ', bar.date);
    return session && session !== CALENDAR_UNVERIFIED && publicationMs(identity, session)! <= nowMs;
  }).map(bar => ({ o: bar.open, h: bar.high, l: bar.low, c: bar.close, v: bar.volume, t: zonedTimeToUtc(bar.date, '00:00', 'America/New_York') }));
  return JSON.stringify({ ticker, adjusted: true, queryCount: results.length, resultsCount: results.length, status: 'OK', request_id: `r${echo}`, results });
}

function fscBody(code: string, begin: string, end: string, nowMs: number) {
  const identity = [...FETCH_ORDER.fsc].map(key => priceIdentity(key)!).find(item => item.providerSymbol === code)!;
  const dash = (text: string) => `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  const items = allBars(identity).filter(bar => bar.date >= dash(begin) && bar.date < dash(end)).filter(bar => {
    const session = sessionOn('KRX', bar.date);
    return session && session !== CALENDAR_UNVERIFIED && publicationMs(identity, session)! <= nowMs;
  }).map(bar => ({
    basDt: bar.date.replace(/-/g, ''), srtnCd: code, isinCd: identity.isin, itmsNm: '테스트',
    ...(identity.instrument === 'stock' ? { mrktCtg: 'KOSPI' } : { bssIdxIdxNm: '코스피 200', bssIdxClpr: String(bar.close * 2) }),
    mkp: String(bar.open), hipr: String(bar.high), lopr: String(bar.low), clpr: String(bar.close),
    vs: bar.base === undefined ? '' : String(bar.close - bar.base), trqu: String(bar.volume),
  }));
  return JSON.stringify({ response: { header: { resultCode: '00', resultMsg: 'NORMAL SERVICE.' }, body: { numOfRows: 3000, pageNo: 1, totalCount: items.length, items: { item: items } } } });
}

const FSC_KEY = 'Kr+Fake/Key=For+Job/Tests==';
const MASSIVE_KEY = 'massive-fake-key-for-job-tests-0123';
const CRON = 'fixture-cron-secret-never-real-0000';

function realAdapters(c: Clock, handler: (url: URL, init: RequestInit) => Response, calls: Array<{ host: string; at: number }> = []) {
  const fetcher = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ host: url.host, at: c.now() });
    return handler(url, init ?? {});
  }) as typeof fetch;
  return () => createPriceProviders({ KR_PRICE_API_KEY: FSC_KEY, US_PRICE_API_KEY: MASSIVE_KEY }, {
    fetcher, now: () => c.now(), sleep: async ms => { c.advance(ms); },
  });
}

test('the real adapters with a fake fetcher fill prices.json; Massive starts stay 13 s apart', async () => {
  const w = world({ companies: TWO });
  refreshSnapshots(w, at('2026-11-10T21:40:00Z'), 1, ['krx:005930', 'nasdaq:AAPL']);
  const calls: Array<{ host: string; at: number }> = [];
  const summary = await w.run('full', undefined, {
    priceProviders: realAdapters(w.clock, url => {
      if (url.host === 'apis.data.go.kr') {
        return new Response(fscBody(url.searchParams.get('likeSrtnCd')!, url.searchParams.get('beginBasDt')!, url.searchParams.get('endBasDt')!, w.clock.now()));
      }
      const [, , , , ticker, , , , from, to] = url.pathname.split('/');
      return new Response(aggsBody(ticker!, from!, to!, w.clock.now()));
    }, calls),
    redactKeys: [FSC_KEY, MASSIVE_KEY, CRON],
  });
  assert.equal(summary.status, 'done', JSON.stringify([summary.errors, summary.prices]));
  assert.ok(Object.values(summary.prices!).every(item => item.code === 'ok'));
  const massive = calls.filter(call => call.host === 'api.massive.com').map(call => call.at);
  assert.equal(massive.length, 6);
  for (let i = 1; i < massive.length; i += 1) assert.ok(massive[i]! - massive[i - 1]! >= 13_000);
  assert.ok(massive[5]! - massive[0]! >= 65_000);
  const prices = readFile<PricesFile>(w.store, 'prices.json')!;
  const kodex = prices.series['krx:069500']!;
  assert.equal(kodex.bars[0]!.date, '2023-01-02');
  assert.ok(kodex.bars.slice(1).every(bar => bar.baseFactor !== undefined && Math.abs(bar.baseFactor - 1) < 1e-9));
  assert.ok(prices.series['arca:SPY']!.bars.every(bar => bar.adjClose === bar.close));
  assert.equal(summary.stats!.statuses['krx:005930'], 'ready');
  assert.equal(summary.stats!.statuses['nasdaq:AAPL'], 'ready');
});

test('a hanging lane ends by its deadline and later symbols are skipped; write deadlines defer files', async () => {
  const w = world({ companies: TWO });
  refreshSnapshots(w, at('2026-11-10T21:40:00Z'), 1, ['krx:005930', 'nasdaq:AAPL']);
  const calls: Array<{ host: string; at: number }> = [];
  const start = at('2026-11-11T06:20:00Z');
  const summary = await w.run('full', start, {
    priceProviders: realAdapters(w.clock, url => {
      // Every Massive request hangs for its full 20 s and then fails; FSC answers at once.
      if (url.host === 'api.massive.com') { w.clock.advance(20_000); throw new Error('hung'); }
      return new Response(fscBody(url.searchParams.get('likeSrtnCd')!, url.searchParams.get('beginBasDt')!, url.searchParams.get('endBasDt')!, w.clock.now()));
    }, calls),
  });
  assert.equal(summary.prices!['nasdaq:QQQ']!.code, 'skipped_budget');
  assert.deepEqual(FETCH_ORDER.massive.slice(0, 5).map(key => summary.prices![key]!.code), ['network', 'network', 'network', 'network', 'network']);
  const massiveStarts = calls.filter(call => call.host === 'api.massive.com').map(call => call.at);
  assert.equal(massiveStarts.length, 5);
  assert.ok(massiveStarts.every(time => time + 20_000 <= start + 110_000), 'every request can end by the lane deadline');
  assert.ok(summary.errors.includes('price_fetch_failed'));

  // Head start past 240 s: nothing is written.
  const late = world({ companies: TWO });
  refreshSnapshots(late, at('2026-11-10T21:40:00Z'), 1, ['krx:005930', 'nasdaq:AAPL']);
  const lateSummary = await late.run('full', start, { priceProviders: fakeProviders(late.clock, { costMs: 22_000 }) });
  assert.equal(lateSummary.status, 'failed');
  assert.ok(lateSummary.errors.includes('write_deadline'));
  assert.ok(lateSummary.errors.includes('compute_budget'));
  assert.equal(late.store.writeLog.length, 0);

  // Head written in time, the rest after 270 s: deferred.
  const slow = world({ companies: TWO });
  refreshSnapshots(slow, at('2026-11-10T21:40:00Z'), 1, ['krx:005930', 'nasdaq:AAPL']);
  const slowStore: HistoryStore = Object.create(slow.store, {
    writeLedgerSegment: { value: async (file: LedgerSegmentFile, condition: Parameters<HistoryStore['writeLedgerSegment']>[1]) => {
      const result = await slow.store.writeLedgerSegment(file, condition);
      slow.clock.set(start + 271_000);
      return result;
    } },
  });
  const deferred = await slow.run('full', start, { store: slowStore });
  assert.equal(deferred.status, 'partial');
  assert.deepEqual(deferred.writes.done, ['ledger/2026-11.json']);
  assert.deepEqual(deferred.writes.deferred, ['shadow/2026.json', 'prices.json', 'stats.json']);
  assert.deepEqual(deferred.errors, ['write_deadline']);
});

test('keys never reach the summary, a stored file or the console, even when a provider echoes them', async () => {
  const w = world({ companies: TWO });
  refreshSnapshots(w, at('2026-11-10T21:40:00Z'), 1, ['krx:005930', 'nasdaq:AAPL']);
  const printed: string[] = [];
  const original = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const name of ['log', 'error', 'warn', 'info'] as const) console[name] = (...args: unknown[]) => { printed.push(args.map(String).join(' ')); };
  let summary: HistoryJobSummary;
  try {
    summary = await w.run('full', undefined, {
      priceProviders: realAdapters(w.clock, url => {
        const echoed = `${url.toString()} ${FSC_KEY} ${encodeURIComponent(FSC_KEY)} ${MASSIVE_KEY}`;
        if (url.host === 'apis.data.go.kr') return new Response(`<error>${echoed}</error>`, { status: 500, headers: { 'x-echo': encodeURIComponent(FSC_KEY) } });
        return new Response(JSON.stringify({ status: 'ERROR', error: echoed }), { status: 401, headers: { authorization: `Bearer ${MASSIVE_KEY}` } });
      }),
      redactKeys: [FSC_KEY, MASSIVE_KEY, CRON],
    });
  } finally {
    Object.assign(console, original);
  }
  assert.equal(summary.status, 'partial');
  const forms = secretForms([FSC_KEY, MASSIVE_KEY, CRON]);
  const texts = [JSON.stringify(summary), ...[...w.store.files.values()].map(file => file.text), ...printed];
  for (const text of texts) for (const form of forms) assert.ok(!text.includes(form), `a key form leaked: ${form.slice(0, 4)}…`);
  // A summary string that somehow carried a key is redacted.
  const redacted = await runHistoryJob({ ...w.deps(), store: null, redactKeys: [CRON], randomId: () => `id-${CRON}` }, 'ledger');
  assert.ok(!JSON.stringify(redacted).includes(CRON));
});

test('createHistoryService builds nothing until run and gives each run fresh price providers', async () => {
  let built = 0;
  const w = world({ companies: TWO });
  refreshSnapshots(w, at('2026-11-10T21:40:00Z'), 1, ['krx:005930', 'nasdaq:AAPL']);
  const service = createHistoryService({}, { ...w.deps(), priceProviders: () => { built += 1; return fakeProviders(w.clock)(); } });
  assert.equal(built, 0);
  assert.equal(w.store.reads.length, 0);
  assert.equal((await service.run('ledger')).status, 'done');
  assert.equal(built, 0, 'ledger mode never builds providers');
  await service.run('full');
  w.store.files.delete('stats.json');
  await service.run('full');
  assert.equal(built, 2);
  // Without Blob credentials the default service is not configured and touches nothing.
  const summary = await createHistoryService({}).run('full');
  assert.deepEqual([summary.status, summary.errors], ['not_configured', ['store_not_configured']]);
});

test('ledger head content passes the store check', () => {
  // Guards the probe the job relies on: a valid file parses, a non-canonical instant does not.
  const base = { version: HISTORY_VERSIONS.ledger, segment: '2026-11', writtenAt: '2026-11-11T00:00:00.000Z',
    state: { createdAt: '2026-11-11T00:00:00.000Z', directory: ['2026-11'], observations: {}, journal: { kstDate: '2026-11-11', writes: 1, fullDone: false }, writeToken: 't' } };
  const entry = entriesFromSnapshot('nasdaq:AAPL', snapshotOf('nasdaq:AAPL', at('2026-11-10T21:40:00Z'), [article('nasdaq:AAPL', at('2026-11-10T20:00:00Z'), 'positive')]))[0]!;
  assert.equal(parseLedgerSegmentFile({ ...base, entries: [entry] }).ok, true);
  assert.equal(parseLedgerSegmentFile({ ...base, entries: [{ ...entry, publishedAt: '2026-11-10T20:00:00.000000Z' }] }).ok, false);
  assert.equal(kstDate(at('2026-11-10T15:00:00Z')), '2026-11-11');
});

// ---------------------------------------------------------------------------
// Review regressions
// ---------------------------------------------------------------------------

test('a series never fetched reads price_unavailable; only an identity mismatch reads identity_unverified', async () => {
  // Regression: a missing series counted as an identity failure, so a missing key or a provider down since the
  // start would have shown the identity message for every company of the market.
  const ids = ['krx:005930', 'nasdaq:AAPL'];
  const w = world({ companies: TWO });
  refreshSnapshots(w, at('2026-11-10T21:40:00Z'), 1, ids);
  const none = await w.run('full', undefined, { priceProviders: fakeProviders(w.clock, { fail: () => 'not_configured' }) });
  assert.deepEqual(none.stats!.statuses, { 'krx:005930': 'price_unavailable', 'nasdaq:AAPL': 'price_unavailable' });
  refreshSnapshots(w, at('2026-11-11T21:40:00Z'), 1, ids);
  const priced = await w.run('full', at('2026-11-12T06:20:00Z'));
  assert.deepEqual(priced.stats!.statuses, { 'krx:005930': 'ready', 'nasdaq:AAPL': 'ready' });
  // With bars stored, a provider answer naming another instrument closes that company's statistics.
  refreshSnapshots(w, at('2026-11-12T21:40:00Z'), 1, ids);
  const mismatch = await w.run('full', at('2026-11-13T06:20:00Z'), {
    priceProviders: fakeProviders(w.clock, { fail: key => key === 'nasdaq:AAPL' ? 'identity_mismatch' : null }),
  });
  assert.deepEqual(mismatch.stats!.statuses, { 'krx:005930': 'ready', 'nasdaq:AAPL': 'identity_unverified' });
});

test('one corrected US close in the provider window no longer stops the series', async () => {
  // Regression: any stored-to-fetched ratio off by more than 1e-6 kept the stored series, and the corrected bar
  // stays in Massive's 729-day window, so no new US bar would have been stored for two years.
  const ids = ['krx:005930', 'nasdaq:AAPL'];
  const w = world({ companies: TWO });
  refreshSnapshots(w, at('2026-11-10T21:40:00Z'), 1, ids);
  await w.run('full');
  const before = readFile<PricesFile>(w.store, 'prices.json')!.series['nasdaq:AAPL']!;
  const target = before.bars[before.bars.length - 30]!;
  refreshSnapshots(w, at('2026-11-11T21:40:00Z'), 1, ids);
  const next = await w.run('full', at('2026-11-12T06:20:00Z'), {
    priceProviders: fakeProviders(w.clock, { transform: (key, bars) => key !== 'nasdaq:AAPL' ? bars
      : bars.map(bar => bar.date === target.date ? { ...bar, close: bar.close + 0.01, adjClose: bar.close + 0.01, high: bar.high + 0.01 } : bar) }),
  });
  assert.equal(next.prices!['nasdaq:AAPL']!.code, 'ok');
  assert.equal(next.prices!['nasdaq:AAPL']!.newBars, 1);
  assert.ok(!next.errors.includes('price_fetch_failed'), JSON.stringify(next.errors));
  const after = readFile<PricesFile>(w.store, 'prices.json')!.series['nasdaq:AAPL']!;
  assert.equal(after.bars.length, before.bars.length + 1);
  const revised = after.bars.find(bar => bar.date === target.date)!;
  assert.equal(revised.close, target.close + 0.01);
  assert.equal(revised.firstFetchedAt, target.firstFetchedAt);
  assert.equal(after.lastSuccessAt, '2026-11-12T06:20:00.000Z');
});

test('replay: a US session the provider filled in a day late is not offered to the earlier clock', async () => {
  // Regression: a bar first stored by a later fetch counted as known from its publication time when that
  // preceded the series' first fetch, so a replay at the earlier clock measured windows the job saw as gaps.
  const ids = ['krx:005930', 'nasdaq:AAPL'];
  const w = world({ start: at('2026-11-01T00:00:00Z'), companies: TWO });
  await seedHistory(w, ids, at('2026-11-01T00:00:00Z'));
  refreshSnapshots(w, at('2026-11-10T21:40:00Z'), 1, ids);
  const gap = '2026-11-04';
  const us = (key: string) => key.startsWith('nasdaq:') || key === 'arca:SPY';
  await w.run('full', at('2026-11-11T06:20:00Z'), {
    priceProviders: fakeProviders(w.clock, { transform: (key, bars) => us(key) ? bars.filter(bar => bar.date !== gap) : bars }),
  });
  const statsN = readFile<StatsFile>(w.store, 'stats.json')!;
  const computeAtN = Date.parse(statsN.computedAt);
  refreshSnapshots(w, at('2026-11-11T21:40:00Z'), 1, ids);
  await w.run('full', at('2026-11-12T06:20:00Z'));
  const series = readFile<PricesFile>(w.store, 'prices.json')!.series as Record<string, PriceSeries>;
  assert.equal(series['nasdaq:AAPL']!.bars.find(bar => bar.date === gap)!.firstFetchedAt, '2026-11-12T06:20:00.000Z');
  const head = (await w.store.findLedgerHead('2026-11'))!;
  const input = companyStatsInput({
    companyId: 'nasdaq:AAPL', entries: await foldStore(w.store, '2026-11'), observations: head.value.state.observations, series,
    frozen: frozenIndex([], []), nowMs: computeAtN,
  });
  // 11-05's next-day return needs 11-04's close: the earlier clock had no such price.
  assert.notEqual(input.outcomes.day('2026-11-05').status, 'complete');
  const replay = await replayStats(w.store, '2026-11', computeAtN, 'nasdaq:AAPL');
  assert.deepEqual(json(replay.horizons), json(statsN.companies['nasdaq:AAPL']!.horizons));
});

test('a backlog of completed cases is frozen over several runs within the per-run patch budget, oldest first', async () => {
  // Regression: every completed case was patched into the ledger in one run; after a price outage the patches
  // alone could pass the 5 MiB file limit, and no later full run could write the ledger head again.
  const ids = ['krx:005930', 'nasdaq:AAPL'];
  const w = world({ start: at('2026-11-01T00:00:00Z'), companies: TWO });
  await seedHistory(w, ids, at('2026-11-01T00:00:00Z'));
  const budget = 25_000;
  const runs: HistoryJobSummary[] = [];
  for (let day = 0; day < 12; day += 1) {
    refreshSnapshots(w, at('2026-11-10T21:40:00Z') + day * DAY, 1, ids);
    const summary = await w.run('full', at('2026-11-11T06:20:00Z') + day * DAY, { limits: { patchBytes: budget } });
    assert.ok(summary.writes.done.includes('stats.json'), JSON.stringify(summary.errors));
    runs.push(summary);
    if (summary.frozen!.casesDeferred === 0) break;
  }
  assert.ok(runs.length > 2, 'the backlog took several runs');
  assert.ok(runs[0]!.frozen!.cases > 0 && runs[0]!.frozen!.casesDeferred > 0, JSON.stringify(runs[0]!.frozen));
  assert.equal(runs.at(-1)!.frozen!.casesDeferred, 0);
  const folded = await foldStore(w.store, '2026-11');
  const frozen = folded.filter(entry => entry.outcome).sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt));
  // Each run's patches stay within the budget, and older articles were never frozen after newer ones.
  const perRun = new Map<string, number>();
  for (const entry of frozen) perRun.set(entry.outcome!.frozenAt, (perRun.get(entry.outcome!.frozenAt) ?? 0) + Buffer.byteLength(JSON.stringify(entry)));
  assert.ok([...perRun.values()].every(bytes => bytes <= budget), JSON.stringify([...perRun]));
  const seededFrozen = frozen.filter(entry => Date.parse(entry.publishedAt) < at('2026-11-01T00:00:00Z'));
  for (let i = 1; i < seededFrozen.length; i += 1) {
    assert.ok(seededFrozen[i - 1]!.outcome!.frozenAt <= seededFrozen[i]!.outcome!.frozenAt, seededFrozen[i]!.id);
  }
  assert.ok(seededFrozen.length > 40);
});

test('an unreadable earlier-year outcome file blocks new freezes of that kind, so nothing is frozen twice', async () => {
  // Regression: only the current-year file's failure stopped freezing; with an earlier year unreadable, its
  // weeks looked unfrozen and were frozen again into the current-year file under a later clock.
  let failWeekly2026 = false;
  const w = world({
    start: at('2026-11-01T00:00:00Z'), companies: [company('nasdaq:AAPL')],
    storeOptions: { failRead: file => failWeekly2026 && file === 'weekly/2026.json' ? 'unreadable' : null },
  });
  await seedHistory(w, ['nasdaq:AAPL'], at('2026-11-01T00:00:00Z'));
  refreshSnapshots(w, at('2026-12-30T21:40:00Z'), 1, ['nasdaq:AAPL']);
  await w.run('full', at('2026-12-31T06:20:00Z'));
  const frozen2026 = readFile<WeeklyOutcomesFile>(w.store, 'weekly/2026.json')!.records;
  assert.ok(frozen2026.length > 0);
  failWeekly2026 = true;
  refreshSnapshots(w, at('2027-01-04T21:40:00Z'), 1, ['nasdaq:AAPL']);
  const blocked = await w.run('full', at('2027-01-05T06:20:00Z'));
  assert.ok(blocked.errors.includes('outcomes_unreadable'), JSON.stringify(blocked.errors));
  assert.ok(!w.store.files.has('weekly/2027.json'), 'no week frozen again under the 2027 clock');
  assert.ok(blocked.writes.done.includes('stats.json'));
  failWeekly2026 = false;
  refreshSnapshots(w, at('2027-01-05T21:40:00Z'), 1, ['nasdaq:AAPL']);
  await w.run('full', at('2027-01-06T06:20:00Z'));
  const keys2026 = new Set(frozen2026.map(record => `${record.companyId}|${record.weekAsOf}|${record.priceBasisVersion}`));
  const records2027 = readFile<WeeklyOutcomesFile>(w.store, 'weekly/2027.json')?.records ?? [];
  assert.ok(records2027.every(record => !keys2026.has(`${record.companyId}|${record.weekAsOf}|${record.priceBasisVersion}`)));
});

// ---------------------------------------------------------------------------
// Security and operations review regressions
// ---------------------------------------------------------------------------

/** Ledger writes wait until `count` of them have arrived, so concurrent runs all read the same head before any writes. */
function rendezvous(store: MemoryHistoryStore, count: number): HistoryStore {
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>(resolve => { open = resolve; });
  return Object.create(store, {
    writeLedgerSegment: { value: async (file: LedgerSegmentFile, condition: Parameters<HistoryStore['writeLedgerSegment']>[1]) => {
      arrived += 1;
      if (arrived === count) open();
      await gate;
      return store.writeLedgerSegment(file, condition);
    } },
  });
}

test('duplicate runs that split between rewriting the head and opening its next shard never both write', { timeout: 60_000 }, async () => {
  // Regression: a run whose head still fitted rewrote it (ifMatch) while a duplicate whose content had grown past
  // the rollover size created the next shard (createOnly). Both conditions held, both runs wrote every file, and the
  // new head's journal missed the other run's writes, so the day could pass the 8-write cap.
  const ids = ['krx:005930', 'nasdaq:AAPL'];
  const limits = { in_place: { rolloverBytes: 50_000_000 }, rollover: { rolloverBytes: 1_000 } } as const;
  for (const order of [['in_place', 'rollover'], ['rollover', 'in_place']] as const) {
    const w = world({ companies: TWO });
    refreshSnapshots(w, at('2026-11-10T21:40:00Z'), 1, ids);
    assert.equal((await w.run('full', at('2026-11-11T06:20:00Z'))).writes.done[0], 'ledger/2026-11.json');
    // The next KST day: two deliveries of the 15:00 cron read the same head and the same stats.json.
    refreshSnapshots(w, at('2026-11-11T21:40:00Z'), 1, ids);
    w.clock.set(at('2026-11-12T06:20:00Z'));
    const dayStart = at('2026-11-11T15:00:00Z');
    const store = rendezvous(w.store, 2);
    const runs = await Promise.all(order.map(kind => runHistoryJob(w.deps({ store, limits: limits[kind] }), 'full')));
    const report = JSON.stringify(runs.map(run => [run.status, run.errors, run.writes.done]));
    const writers = runs.filter(run => run.writes.done.length > 0);
    assert.equal(writers.length, 1, `${order.join('/')}: ${report}`);
    const loser = runs.find(run => run !== writers[0])!;
    assert.equal(loser.status, 'failed', report);
    assert.ok(loser.errors.includes('ledger_conflict'), report);
    const written = writesBetween(w.store, dayStart).filter(item => item.ok);
    assert.equal(written.filter(item => item.file === 'stats.json').length, 1, report);
    assert.ok(written.length <= DAILY_WRITE_CAP - FULL_RESERVE_FOR_LEDGER, report);
    const head = (await w.store.findLedgerHead('2026-11'))!;
    assert.equal(head.value.state.journal.writes, written.length, `the head's journal counts every write of the day: ${report}`);
  }
});
