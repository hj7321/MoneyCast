import test from 'node:test';
import assert from 'node:assert/strict';
import { BlobError, BlobPreconditionFailedError, type get, type put } from '@vercel/blob';
import type { LedgerEntry } from './history-ledger.js';
import type { DailyBar, NextDayOutcome, WeeklyOutcome } from './history-outcomes.js';
import { companyStats, outcomesFromPrices, type CompanyStats } from './history-stats.js';
import { CALENDAR_UNVERIFIED, addDays, sessionOn, weeklyAsOfsBetween, type Exchange } from './market-calendar.js';
import {
  HISTORY_PREFIX, HISTORY_VERSIONS, LEDGER_BACKFILL_FILE, MAX_FILE_BYTES, STORE_TIMEOUT_MS, HistoryStoreError,
  addMonths, compareLedgerSegmentIds, createBlobHistoryStore, createMemoryHistoryStore, jsonByteLength, ledgerSegmentId,
  parseDailyOutcomesFile, parseLedgerSegmentFile, parseLedgerSegmentId, parsePricesFile, parseShadowFile, parseStatsFile,
  parseWeeklyOutcomesFile,
  type DailyOutcomesFile, type HistoryStore, type HistoryStoreErrorCode, type LedgerSegmentFile, type PricesFile, type ShadowFile,
  type StatsFile, type WeeklyOutcomesFile,
} from './history-store.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-11-11T08:50:00.000Z');
const iso = (value: number) => new Date(value).toISOString();
/** Plain JSON copy: parsed maps are prototype-free, so whole-file comparisons go through JSON. */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

async function codeOf(promise: Promise<unknown>): Promise<HistoryStoreErrorCode | 'resolved'> {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    assert.ok(error instanceof HistoryStoreError, 'store errors are HistoryStoreError');
    assert.equal(error.message, error.code, 'the message is the code only');
    return error.code;
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function ledgerEntry(id: string, overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id, storyId: id, companyId: 'krx:005930', publishedAt: '2026-11-10T01:00:00.000Z', timeKind: 'published', timePrecision: 'second',
    firstSeenAt: '2026-11-10T21:30:00.000Z', source: 'example.com', sourceProvider: 'Marketaux', url: `https://example.com/${id}`,
    title: `삼성전자 테스트 기사 ${id}`, language: 'ko', topic: 'earnings', identity: 'entity_verified', origin: 'forward',
    collection: { sort: 'entity_match_score', limit: 3, languages: ['en', 'ko'], fetch: 'marketaux:/v1/news/all' },
    labels: [{ at: '2026-11-10T21:30:00.000Z', sentiment: 'positive', score: 0.4, method: 'provider', relevance: null, consensus: null, promptVersion: null, models: [] }],
    ...overrides,
  };
}

/** The step-4 LedgerOutcome shape (spec 3.1), including the new flag. */
const LEDGER_OUTCOME = {
  entryType: 'close_no_open', entryDate: '2026-11-02', exitDate: '2026-11-09', entryAt: '2026-11-02T06:30:00.000Z',
  exitAt: '2026-11-09T06:30:00.000Z', sessions: ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-09'],
  basis: 'raw', r: 0.02, benchmarkR: 0.01, relative: 0.01, sigma: 0.015, band: 0.008, label: 'neutral',
  flags: ['unadjusted', 'benchmark_chained'], priceBasisVersion: 'fsc-raw-v1/outcomes-v1', frozenAt: '2026-11-10T06:30:00.000Z',
};

function segmentFile(id: string, directory: string[], writeToken = 'run-1', entries: LedgerEntry[] = [ledgerEntry(`a-${id}`)]): LedgerSegmentFile {
  return {
    version: HISTORY_VERSIONS.ledger, segment: id, writtenAt: iso(NOW),
    state: {
      createdAt: '2026-10-01T00:00:00.000Z', directory,
      observations: {
        'krx:005930': {
          observedFrom: '2026-10-01T21:10:00.000Z', lastSnapshotAt: '2026-11-10T21:30:00.000Z',
          gaps: [{ start: '2026-10-20T21:10:00.000Z', end: '2026-10-22T01:00:00.000Z', detectedAt: '2026-10-29T21:10:00.000Z' }],
        },
      },
      journal: { kstDate: '2026-11-11', writes: 1, fullDone: false }, writeToken,
    },
    entries,
  };
}

const SEGMENT = segmentFile('2026-11', ['2026-10', '2026-11'], 'run-1', [
  ledgerEntry('a'),
  { ...ledgerEntry('b', { firstSeenAt: null, origin: 'backfill', sourceProvider: null, language: null }), outcome: LEDGER_OUTCOME } as unknown as LedgerEntry,
  ledgerEntry('a', { companyId: 'krx:000660' }),
]);

function bar(date: string, close: number, extra: Record<string, unknown> = {}) {
  return { date, open: close * 0.99, high: close * 1.01, low: close * 0.98, close, volume: 1_000, firstFetchedAt: '2026-11-10T07:00:00.000Z', ...extra };
}

const PRICES: PricesFile = {
  version: HISTORY_VERSIONS.prices, writtenAt: iso(NOW),
  series: {
    'krx:069500': {
      key: 'krx:069500', provider: 'fsc', providerSymbol: '069500', exchange: 'KRX', currency: 'KRW', basis: 'raw', priceBasis: 'fsc-raw-v1',
      forwardSince: '2026-11-10T07:00:00.000Z', lastSuccessAt: '2026-11-11T06:10:00.000Z', lastAttempt: { at: '2026-11-11T06:10:00.000Z', code: 'ok' },
      rebasedAt: null,
      bars: [
        bar('2026-11-09', 40_000, { base: 39_800, indexClose: 420.5 }),
        bar('2026-11-10', 40_200, { base: 40_000, baseFactor: 1, indexClose: 421.1, volume: 0, flags: ['zero_volume'] }),
      ],
    },
    'nasdaq:AAPL': {
      key: 'nasdaq:AAPL', provider: 'massive', providerSymbol: 'AAPL', exchange: 'NASDAQ', currency: 'USD', basis: 'split_adjusted',
      priceBasis: 'massive-split-v1', forwardSince: '2026-11-10T07:00:00.000Z', lastSuccessAt: '2026-11-11T06:10:00.000Z',
      lastAttempt: { at: '2026-11-11T06:12:00.000Z', code: 'http_503' }, rebasedAt: '2026-11-11T06:10:00.000Z',
      bars: [bar('2026-11-09', 230, { adjClose: 230 }), bar('2026-11-10', 231.5, { adjClose: 231.5 })],
    },
  },
};

const WEEK_AS_OF = Date.parse('2026-11-01T23:50:00.000Z');
const WEEKLY: WeeklyOutcomesFile = {
  version: HISTORY_VERSIONS.outcomes, kind: 'weekly', year: 2026, writtenAt: iso(NOW),
  records: [{
    companyId: 'nasdaq:AAPL', weekAsOf: iso(WEEK_AS_OF), frozenAt: iso(NOW), priceBasisVersion: 'massive-split-v1/outcomes-v1',
    outcome: {
      status: 'complete', reason: null, entryType: 'open', entryDate: '2026-11-02', exitDate: '2026-11-06',
      entryAtMs: Date.parse('2026-11-02T14:30:00.000Z'), exitAtMs: Date.parse('2026-11-06T21:00:00.000Z'),
      sessions: ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'], basis: 'adjusted',
      r: 0.03, benchmarkR: 0.01, relative: 0.02, sigma: 0.012, band: 0.007, label: 'up', flags: [], weekAsOfMs: WEEK_AS_OF,
    } as unknown as WeeklyOutcome,
  }],
};

const DAILY: DailyOutcomesFile = {
  version: HISTORY_VERSIONS.outcomes, kind: 'daily', year: 2026, writtenAt: iso(NOW),
  records: [{
    companyId: 'krx:005930', sessionDate: '2026-11-06', frozenAt: iso(NOW), priceBasisVersion: 'fsc-raw-v1/outcomes-v1',
    outcome: {
      status: 'complete', reason: null, entryType: 'close', entryDate: '2026-11-05', exitDate: '2026-11-06',
      entryAtMs: Date.parse('2026-11-05T06:30:00.000Z'), exitAtMs: Date.parse('2026-11-06T06:30:00.000Z'),
      sessions: ['2026-11-05', '2026-11-06'], basis: 'raw', r: -0.01, benchmarkR: -0.005, relative: -0.005, sigma: 0.01, band: 0.003,
      label: 'down', flags: ['unadjusted', 'benchmark_chained'], intraday: 0.002, benchmarkIntraday: null, relativeIntraday: null,
    } as unknown as NextDayOutcome,
  }],
};

const SHADOW: ShadowFile = {
  version: HISTORY_VERSIONS.shadow, year: 2026, writtenAt: iso(NOW),
  records: [
    {
      recordDate: '2026-11-11', recordedAt: '2026-11-11T06:30:00.000Z', companyId: 'krx:005930', horizon: 'day', exchange: 'KRX',
      target: { start: '2026-11-12', end: '2026-11-12', basis: 'exchange_calendar', phase: 'after_close' },
      newsWindow: { start: '2026-11-11T06:30:00.000Z', end: '2026-11-12T00:00:00.000Z' },
      snapshot: { asOf: '2026-11-10T21:30:00.000Z', knownAt: '2026-11-10T21:30:00.000Z', analysisVersion: 'news-evidence-v3', status: 'ready', partial: false },
      stale: false, baseline: 'positive',
      overnight: { reason: 'one_direction', evidence: 'low', counts: { positive: 1, negative: 0, neutral: 2, ignored: 0 } },
      statsStatus: 'ready', statsComputedAt: '2026-11-11T06:29:00.000Z', verdict: 'supports', integrated: 'positive', changed: false, note: 'supports',
    },
    {
      recordDate: '2026-11-11', recordedAt: '2026-11-11T06:30:00.000Z', companyId: 'krx:005930', horizon: 'week', exchange: 'KRX',
      target: { start: '2026-11-12', end: '2026-11-18', basis: 'exchange_calendar', phase: 'after_close' }, newsWindow: null,
      snapshot: null, stale: false, baseline: 'withheld', overnight: null, statsStatus: 'missing', statsComputedAt: null,
      verdict: null, integrated: 'withheld', changed: false, note: 'baseline_withheld',
    },
  ],
};

// A real companyStats output: the same kind of fixture as history-stats.test.ts, on one US stock.
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
function bars(exchange: Exchange, from: string, to: string, seed: number, volatility = 0.02): DailyBar[] {
  const next = random(seed);
  const result: DailyBar[] = [];
  let previous = 100;
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const session = sessionOn(exchange, day);
    if (!session || session === CALENDAR_UNVERIFIED) continue;
    const open = previous * (1 + (next() - 0.5) * volatility / 2);
    const close = open * (1 + (next() - 0.5) * volatility);
    result.push({ date: day, open, high: Math.max(open, close) * 1.01, low: Math.min(open, close) * 0.99, close, volume: 1_000 });
    previous = close;
  }
  return result;
}
const STATS_NOW = Date.parse('2026-11-02T00:00:00Z');
const STATS_FROM = Date.parse('2025-09-01T00:00:00Z');
function realStats(): CompanyStats {
  const entries = weeklyAsOfsBetween(STATS_FROM + 7 * DAY, STATS_NOW).flatMap((asOf, index) => {
    if (index % 3 === 2) return [];
    const published = asOf - 4 * DAY;
    const id = `s${index}`;
    const seen = iso(published + 2 * HOUR);
    return [ledgerEntry(id, {
      companyId: 'nasdaq:AAPL', publishedAt: iso(published), firstSeenAt: seen, source: `${id}.example`, url: `https://${id}.example/a`,
      title: `${id}#`.repeat(12), language: 'en',
      labels: [{ at: seen, sentiment: index % 3 === 0 ? 'positive' : 'negative', score: 0.4, method: 'provider', relevance: null, consensus: null, promptVersion: null, models: [] }],
    })];
  });
  return companyStats({
    companyId: 'nasdaq:AAPL', exchange: 'NASDAQ', entries, nowMs: STATS_NOW, observation: { fromMs: STATS_FROM },
    outcomes: outcomesFromPrices({ exchange: 'NASDAQ', bars: bars('NASDAQ', '2025-06-02', '2026-10-30', 11), benchmarkBars: bars('NASDAQ', '2025-06-02', '2026-10-30', 12, 0.01) }, STATS_NOW),
    lastPriceDate: '2026-10-30', statsPublic: true, identityVerified: true, priceAvailable: true,
    sources: { news: ['Marketaux'], price: { label: 'Massive(구 Polygon) 일봉', adjustment: 'split' } },
  });
}
const COMPANY = realStats();
const STATS: StatsFile = {
  version: HISTORY_VERSIONS.stats, computedAt: iso(NOW), runId: 'run-1',
  companies: { 'nasdaq:AAPL': COMPANY }, carriedOver: [],
};

// ---------------------------------------------------------------------------
// Fake Blob SDK
// ---------------------------------------------------------------------------

interface Call { pathname: string; options: Record<string, unknown> }

function fakeBlob() {
  const objects = new Map<string, { text: string; etag: string }>();
  const gets: Call[] = [];
  const puts: Array<Call & { body: string }> = [];
  let version = 0;
  const hooks: { get?: (pathname: string) => unknown; put?: (pathname: string) => unknown } = {};
  const api = {
    get: (async (pathname: string, options: Record<string, unknown>) => {
      gets.push({ pathname, options });
      const hooked = hooks.get?.(pathname);
      if (hooked !== undefined) return hooked;
      const stored = objects.get(pathname);
      return stored ? { statusCode: 200, stream: new Response(stored.text).body, blob: { etag: stored.etag } } : null;
    }) as unknown as typeof get,
    put: (async (pathname: string, body: unknown, options: Record<string, unknown>) => {
      puts.push({ pathname, body: String(body), options });
      hooks.put?.(pathname);
      const existing = objects.get(pathname);
      if (options.ifMatch !== undefined && existing?.etag !== options.ifMatch) throw new BlobPreconditionFailedError();
      if (options.allowOverwrite !== true && options.ifMatch === undefined && existing) {
        throw new BlobError('This blob already exists, use `allowOverwrite: true` if you want to overwrite it.');
      }
      version += 1;
      const etag = `"blob-${version}"`;
      objects.set(pathname, { text: String(body), etag });
      return { etag, pathname, url: `https://store.example/${pathname}` };
    }) as unknown as typeof put,
  };
  return { api, objects, gets, puts, hooks };
}

function blobStore() {
  const fake = fakeBlob();
  const store = createBlobHistoryStore({ BLOB_STORE_ID: 'store_test' }, fake.api)!;
  assert.notEqual(store, null);
  return { ...fake, store };
}

const withoutSignal = ({ abortSignal, ...rest }: Record<string, unknown>) => {
  assert.ok(abortSignal instanceof AbortSignal, 'every call carries an abort signal');
  return rest;
};

const BASE_PUT = { access: 'private', addRandomSuffix: false, contentType: 'application/json', cacheControlMaxAge: 60 };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

test('segment ids, month arithmetic and byte lengths', () => {
  assert.equal(ledgerSegmentId('2026-11', 0), '2026-11');
  assert.equal(ledgerSegmentId('2026-11', 3), '2026-11.3');
  assert.throws(() => ledgerSegmentId('2026-13', 0), RangeError);
  assert.throws(() => ledgerSegmentId('2026-11', -1), RangeError);
  assert.throws(() => ledgerSegmentId('2026-11', 1.5), RangeError);
  assert.deepEqual(parseLedgerSegmentId('2026-11'), { month: '2026-11', shard: 0 });
  assert.deepEqual(parseLedgerSegmentId('2026-11.12'), { month: '2026-11', shard: 12 });
  for (const bad of ['2026-11.0', '2026-11.01', '2026-1', '2026-00', 'x', '2026-11.', '../2026-11', '2026-11.json']) {
    assert.equal(parseLedgerSegmentId(bad), null, bad);
  }
  const ids = ['2026-11.2', '2025-12', '2026-11', '2026-11.10', '2026-01.1', '2026-01'];
  assert.deepEqual([...ids].sort(compareLedgerSegmentIds), ['2025-12', '2026-01', '2026-01.1', '2026-11', '2026-11.2', '2026-11.10']);
  assert.throws(() => compareLedgerSegmentIds('2026-11', 'bad'), RangeError);
  assert.equal(addMonths('2026-11', 0), '2026-11');
  assert.equal(addMonths('2026-01', -1), '2025-12');
  assert.equal(addMonths('2026-11', 2), '2027-01');
  assert.equal(addMonths('2026-11', -36), '2023-11');
  assert.throws(() => addMonths('2026-1', 1), RangeError);
  assert.equal(jsonByteLength({ a: '가' }), Buffer.byteLength('{"a":"가"}', 'utf8'));
  assert.equal(jsonByteLength({ a: '가' }), 11);
  assert.equal(jsonByteLength(undefined), 0);
  assert.equal(LEDGER_BACKFILL_FILE, 'ledger-backfill.json');
  assert.equal(HISTORY_PREFIX, 'news-history/v1/');
  assert.equal(STORE_TIMEOUT_MS, 20_000);
});

// ---------------------------------------------------------------------------
// Blob adapter
// ---------------------------------------------------------------------------

test('Blob store: not configured gives null, construction does no I/O', () => {
  const fake = fakeBlob();
  assert.equal(createBlobHistoryStore({}, fake.api), null);
  assert.equal(createBlobHistoryStore({ BLOB_READ_WRITE_TOKEN: '  ', BLOB_STORE_ID: '' }, fake.api), null);
  assert.notEqual(createBlobHistoryStore({ BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_test' }, fake.api), null);
  const store = createBlobHistoryStore({ BLOB_STORE_ID: 'store_test' }, fake.api)!;
  assert.equal(store.writes, 0);
  assert.equal(store.attempts, 0);
  assert.equal(fake.gets.length + fake.puts.length, 0);
});

test('Blob store: exact paths and put options per file kind, cache bypass only when fresh', async () => {
  const { store, gets, puts } = blobStore();
  await store.writeStats(STATS);
  await store.writePrices(PRICES);
  await store.writeWeekly(WEEKLY);
  await store.writeDaily(DAILY);
  await store.writeShadow(SHADOW);
  const created = await store.writeLedgerSegment(SEGMENT, { kind: 'createOnly' });
  const next = { ...SEGMENT, writtenAt: iso(NOW + HOUR), state: { ...SEGMENT.state, writeToken: 'run-2' } };
  const updated = await store.writeLedgerSegment(next, { kind: 'ifMatch', etag: created.etag });
  assert.notEqual(updated.etag, created.etag);
  assert.deepEqual(puts.map(call => call.pathname), [
    'news-history/v1/stats.json', 'news-history/v1/prices.json', 'news-history/v1/weekly/2026.json', 'news-history/v1/daily/2026.json',
    'news-history/v1/shadow/2026.json', 'news-history/v1/ledger/2026-11.json', 'news-history/v1/ledger/2026-11.json',
  ]);
  for (const call of puts.slice(0, 5)) assert.deepEqual(withoutSignal(call.options), { ...BASE_PUT, allowOverwrite: true });
  assert.deepEqual(withoutSignal(puts[5]!.options), { ...BASE_PUT, allowOverwrite: false });
  assert.deepEqual(withoutSignal(puts[6]!.options), { ...BASE_PUT, ifMatch: created.etag });
  assert.equal(puts[0]!.body, JSON.stringify(STATS));
  assert.equal(created.bytes, jsonByteLength(SEGMENT));
  assert.equal(store.writes, 7);
  assert.equal(store.attempts, 7);

  assert.deepEqual(plain((await store.readStats())!.value), plain(STATS));
  assert.deepEqual(plain((await store.readPrices({ fresh: true }))!.value), plain(PRICES));
  assert.deepEqual(plain((await store.readWeekly(2026))!.value), plain(WEEKLY));
  assert.deepEqual(plain((await store.readDaily(2026, { fresh: false }))!.value), plain(DAILY));
  assert.deepEqual(plain((await store.readShadow(2026, { fresh: true }))!.value), plain(SHADOW));
  const head = (await store.readLedgerSegment('2026-11', { fresh: true }))!;
  assert.deepEqual(plain(head.value), plain(next));
  assert.equal(head.etag, updated.etag);
  assert.deepEqual(gets.map(call => [call.pathname, withoutSignal(call.options)]), [
    ['news-history/v1/stats.json', { access: 'private', useCache: true }],
    ['news-history/v1/prices.json', { access: 'private', useCache: false }],
    ['news-history/v1/weekly/2026.json', { access: 'private', useCache: true }],
    ['news-history/v1/daily/2026.json', { access: 'private', useCache: true }],
    ['news-history/v1/shadow/2026.json', { access: 'private', useCache: false }],
    ['news-history/v1/ledger/2026-11.json', { access: 'private', useCache: false }],
  ]);
  // Missing files are null; a missing year is a different file.
  assert.equal(await store.readWeekly(2025), null);
  assert.equal(await store.readLedgerSegment('2026-10'), null);
  assert.equal(await codeOf(store.readLedgerSegment('../stats')), 'invalid');
  assert.equal(await codeOf(store.readWeekly(26)), 'invalid');
});

test('Blob store: read errors map to null, unreadable and timeout without provider text', async () => {
  const { store, hooks } = blobStore();
  hooks.get = () => null;
  assert.equal(await store.readStats(), null);
  hooks.get = () => ({ statusCode: 304, stream: null, blob: { etag: '"x"' } });
  assert.equal(await store.readStats(), null);
  hooks.get = () => { throw new BlobError('Failed to fetch blob: 500 secret-token-text'); };
  assert.equal(await codeOf(store.readStats()), 'unreadable');
  hooks.get = () => { throw new DOMException('The operation timed out.', 'TimeoutError'); };
  assert.equal(await codeOf(store.readStats()), 'timeout');
  hooks.get = () => { throw new DOMException('aborted', 'AbortError'); };
  assert.equal(await codeOf(store.readStats()), 'timeout');
  const broken = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error('socket reset')); } });
  hooks.get = () => ({ statusCode: 200, stream: broken, blob: { etag: '"x"' } });
  assert.equal(await codeOf(store.readStats()), 'unreadable');
  try {
    hooks.get = () => { throw new BlobError('Failed to fetch blob: 500 secret-token-text'); };
    await store.readPrices();
    assert.fail('expected a throw');
  } catch (error) {
    assert.ok(error instanceof HistoryStoreError);
    assert.equal(error.file, 'prices.json');
    assert.doesNotMatch(String(error.message) + String(error.stack), /secret-token-text/);
  }
});

test('Blob store: a body over 5 MiB is too_large and the stream is cancelled before full buffering', async () => {
  const { store, hooks } = blobStore();
  const chunk = new Uint8Array(1024 * 1024).fill(0x20);
  let pulls = 0;
  let cancelled = false;
  const total = 20;
  hooks.get = () => ({
    statusCode: 200, blob: { etag: '"big"' },
    stream: new ReadableStream<Uint8Array>({
      pull(controller) { pulls += 1; if (pulls > total) controller.close(); else controller.enqueue(chunk); },
      cancel() { cancelled = true; },
    }),
  });
  assert.equal(await codeOf(store.readStats()), 'too_large');
  assert.ok(cancelled, 'stream cancelled');
  assert.ok(pulls <= 8, `pulled ${pulls} MiB of ${total}`);
  // Exactly the limit is read (and then rejected as invalid JSON: spaces only); one byte more is too large.
  const exact = new Uint8Array(MAX_FILE_BYTES).fill(0x20);
  hooks.get = () => ({ statusCode: 200, blob: { etag: '"e"' }, stream: new Response(exact).body });
  assert.equal(await codeOf(store.readStats()), 'invalid');
  const over = new Uint8Array(MAX_FILE_BYTES + 1).fill(0x20);
  hooks.get = () => ({ statusCode: 200, blob: { etag: '"e"' }, stream: new Response(over).body });
  assert.equal(await codeOf(store.readStats()), 'too_large');
  hooks.get = () => ({ statusCode: 200, blob: { etag: '"e"' }, stream: new Response(new Uint8Array([0x22, 0xff, 0x22])).body });
  assert.equal(await codeOf(store.readStats()), 'invalid', 'malformed UTF-8 is invalid');
});

test('Blob store: a write over 5 MiB is too_large with no put and no attempt; an invalid value never reaches put', async () => {
  const { store, puts } = blobStore();
  const base = jsonByteLength({ ...STATS, runId: '' });
  const over = { ...STATS, runId: 'x'.repeat(MAX_FILE_BYTES + 1 - base) };
  assert.equal(jsonByteLength(over), MAX_FILE_BYTES + 1);
  assert.equal(await codeOf(store.writeStats(over)), 'too_large');
  // At exactly the limit the size check passes and validation rejects the 5 MiB runId.
  const exact = { ...STATS, runId: 'x'.repeat(MAX_FILE_BYTES - base) };
  assert.equal(jsonByteLength(exact), MAX_FILE_BYTES);
  assert.equal(await codeOf(store.writeStats(exact)), 'invalid');
  const bad = plain(SEGMENT);
  (bad.entries[1] as unknown as Record<string, unknown>).publishedAt = 'yesterday';
  assert.equal(await codeOf(store.writeLedgerSegment(bad, { kind: 'createOnly' })), 'invalid');
  assert.equal(puts.length, 0);
  assert.equal(store.attempts, 0);
  assert.equal(store.writes, 0);
});

test('Blob store: precondition failures are conflicts, a landed retry with our writeToken succeeds, other errors are write_failed', async () => {
  const { store, objects, hooks, puts } = blobStore();
  const first = await store.writeLedgerSegment(SEGMENT, { kind: 'createOnly' });
  // Someone else rewrote the head: ifMatch on the old etag fails and their token differs.
  objects.set('news-history/v1/ledger/2026-11.json', { text: JSON.stringify({ ...SEGMENT, state: { ...SEGMENT.state, writeToken: 'other-run' } }), etag: '"theirs"' });
  const ours = { ...SEGMENT, state: { ...SEGMENT.state, writeToken: 'run-2' } };
  assert.equal(await codeOf(store.writeLedgerSegment(ours, { kind: 'ifMatch', etag: first.etag })), 'conflict');
  // createOnly on an existing segment: the SDK's "already exists" error is a conflict too.
  assert.equal(await codeOf(store.writeLedgerSegment(ours, { kind: 'createOnly' })), 'conflict');
  // The SDK retried a write that had landed: the stored token is ours, so the write counts as done.
  hooks.put = pathname => objects.set(pathname, { text: JSON.stringify(ours), etag: '"landed"' });
  const landed = await store.writeLedgerSegment(ours, { kind: 'ifMatch', etag: '"stale"' });
  assert.deepEqual(landed, { etag: '"landed"', bytes: jsonByteLength(ours) });
  hooks.put = () => { throw new BlobPreconditionFailedError(); };
  assert.equal(await codeOf(store.writeStats(STATS)), 'conflict');
  hooks.put = () => { throw new BlobError('The blob service is currently not available. Please try again.'); };
  assert.equal(await codeOf(store.writePrices(PRICES)), 'write_failed');
  hooks.put = () => { throw new DOMException('timed out', 'TimeoutError'); };
  assert.equal(await codeOf(store.writePrices(PRICES)), 'timeout');
  hooks.put = () => { throw new Error('socket hang up'); };
  assert.equal(await codeOf(store.writeLedgerSegment({ ...ours, segment: '2026-11.1', state: { ...ours.state, directory: ['2026-10', '2026-11', '2026-11.1'] } }, { kind: 'createOnly' })), 'write_failed');
  assert.equal(puts.length, 8);
  assert.equal(store.attempts, 8);
  assert.equal(store.writes, 2, 'the first write and the landed retry');
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

type Mutation = [string, (value: Record<string, any>) => void];

async function expectInvalid(store: ReturnType<typeof createMemoryHistoryStore>, file: string, value: unknown,
  read: (store: HistoryStore) => Promise<unknown>, expected: HistoryStoreErrorCode = 'invalid', label = file) {
  store.files.set(file, { text: typeof value === 'string' ? value : JSON.stringify(value), etag: '"t"' });
  assert.equal(await codeOf(read(store)), expected, label);
}

async function mutationTable(file: string, base: unknown, read: (store: HistoryStore) => Promise<unknown>, mutations: Mutation[]) {
  const store = createMemoryHistoryStore();
  store.files.set(file, { text: JSON.stringify(base), etag: '"ok"' });
  assert.notEqual(await read(store), null, `${file} fixture is valid`);
  for (const [name, mutate] of mutations) {
    const copy = plain(base) as Record<string, any>;
    mutate(copy);
    await expectInvalid(store, file, copy, read, 'invalid', `${file}: ${name}`);
  }
}

test('every file kind: invalid JSON, a wrong version and non-object bodies', async () => {
  const store = createMemoryHistoryStore();
  const cases: Array<[string, unknown, (s: HistoryStore) => Promise<unknown>]> = [
    ['stats.json', STATS, s => s.readStats()],
    ['prices.json', PRICES, s => s.readPrices()],
    ['weekly/2026.json', WEEKLY, s => s.readWeekly(2026)],
    ['daily/2026.json', DAILY, s => s.readDaily(2026)],
    ['shadow/2026.json', SHADOW, s => s.readShadow(2026)],
    ['ledger/2026-11.json', SEGMENT, s => s.readLedgerSegment('2026-11')],
  ];
  for (const [file, value, read] of cases) {
    await expectInvalid(store, file, '{"version":', read, 'invalid', `${file} truncated`);
    await expectInvalid(store, file, '[]', read, 'invalid', `${file} array`);
    await expectInvalid(store, file, 'null', read, 'invalid', `${file} null`);
    await expectInvalid(store, file, { ...(value as object), version: 'news-history-v0' }, read, 'unsupported_version', `${file} version`);
    await expectInvalid(store, file, { ...(value as object), version: undefined }, read, 'invalid', `${file} no version`);
  }
  assert.deepEqual(parseWeeklyOutcomesFile(plain(DAILY)), { ok: false, code: 'invalid' }, 'kind must match the method');
  assert.deepEqual(parseDailyOutcomesFile(plain(WEEKLY)), { ok: false, code: 'invalid' });
  assert.equal(parseWeeklyOutcomesFile(plain(WEEKLY), 2025).ok, false, 'year must match the file');
  assert.equal(parseShadowFile(plain(SHADOW), 2025).ok, false);
  assert.equal(parseLedgerSegmentFile(plain(SEGMENT), '2026-10').ok, false, 'segment must match the file name');
});

test('unknown fields are dropped and parsed maps are prototype-free', () => {
  const extra = plain(PRICES) as unknown as Record<string, any>;
  extra.note = 'drop me';
  extra.series['krx:069500'].extra = 1;
  extra.series['krx:069500'].bars[0].junk = true;
  const parsed = parsePricesFile(extra);
  assert.ok(parsed.ok);
  assert.deepEqual(plain(parsed.value), plain(PRICES));
  assert.equal(Object.getPrototypeOf(parsed.value.series), null);
  const ledger = plain(SEGMENT) as unknown as Record<string, any>;
  ledger.entries[0].description = 'never stored';
  ledger.entries[0].labels[0].judgedAt = '2026-11-10T21:00:00.000Z';
  const parsedLedger = parseLedgerSegmentFile(ledger);
  assert.ok(parsedLedger.ok);
  assert.deepEqual(plain(parsedLedger.value), plain(SEGMENT));
  assert.equal('outcome' in parsedLedger.value.entries[0]!, false, 'absent outcome stays absent');
  assert.deepEqual(plain(parsedLedger.value.entries[1]!.outcome), LEDGER_OUTCOME);
  assert.equal(Object.getPrototypeOf(parsedLedger.value.state.observations), null);
});

test('hostile keys are rejected in every map', async () => {
  const store = createMemoryHistoryStore();
  const hostile = (json: string, key: string, replacement: string) => json.replace(key, replacement);
  for (const bad of ['__proto__', 'constructor', 'prototype']) {
    const stats = JSON.stringify({ ...STATS, companies: { ...STATS.companies, [`@@${bad}`]: COMPANY } }).replace(`"@@${bad}"`, `"${bad}"`);
    await expectInvalid(store, 'stats.json', stats, s => s.readStats(), 'invalid', `stats ${bad}`);
    const prices = hostile(JSON.stringify(PRICES), '"nasdaq:AAPL":{', `"${bad}":{`);
    await expectInvalid(store, 'prices.json', prices, s => s.readPrices(), 'invalid', `prices ${bad}`);
    const ledger = hostile(JSON.stringify(SEGMENT), '"krx:005930":{"observedFrom"', `"${bad}":{"observedFrom"`);
    await expectInvalid(store, 'ledger/2026-11.json', ledger, s => s.readLedgerSegment('2026-11'), 'invalid', `observations ${bad}`);
  }
  // __proto__ in JSON text is an own key after JSON.parse and must not reach a prototype.
  const parsed = parsePricesFile(JSON.parse(hostile(JSON.stringify(PRICES), '"nasdaq:AAPL":{', '"__proto__":{')));
  assert.deepEqual(parsed, { ok: false, code: 'invalid' });
  assert.equal(({} as Record<string, unknown>).provider, undefined);
});

test('stats: a real companyStats output passes the contract probe; tampered ones fail', async () => {
  assert.equal(COMPANY.status, 'ready');
  assert.notEqual(COMPANY.horizons.week.directions, null);
  const parsed = parseStatsFile(plain(STATS));
  assert.ok(parsed.ok);
  assert.deepEqual(plain(parsed.value.companies['nasdaq:AAPL']), plain(COMPANY));
  const withCarry = parseStatsFile({ ...plain(STATS), carriedOver: ['nasdaq:AAPL'] });
  assert.ok(withCarry.ok);
  await mutationTable('stats.json', STATS, s => s.readStats(), [
    ['company key differs from companyId', v => { v.companies['nasdaq:MSFT'] = v.companies['nasdaq:AAPL']; }],
    ['companyId tampered', v => { v.companies['nasdaq:AAPL'].companyId = 'nasdaq:MSFT'; }],
    ['contract version', v => { v.companies['nasdaq:AAPL'].version = 'news-history-v0'; }],
    ['off is not a stats status', v => { v.companies['nasdaq:AAPL'].status = 'off'; }],
    ['exchange', v => { v.companies['nasdaq:AAPL'].exchange = 'NYSE'; }],
    ['timeUnverifiedUnits negative', v => { v.companies['nasdaq:AAPL'].horizons.week.timeUnverifiedUnits = -1; }],
    ['timeUnverifiedUnits fractional', v => { v.companies['nasdaq:AAPL'].horizons.day.timeUnverifiedUnits = 0.5; }],
    ['difference out of range', v => { v.companies['nasdaq:AAPL'].horizons.week.directions.positive.sample.difference = 2; }],
    ['verdict', v => { v.companies['nasdaq:AAPL'].horizons.week.directions.negative.verdict = 'buy'; }],
    ['statistics while not public', v => { v.companies['nasdaq:AAPL'].status = 'stats_not_public'; }],
    ['coverage count', v => { v.companies['nasdaq:AAPL'].coverage.articles = -3; }],
    ['coverage hostile key', v => { v.companies['nasdaq:AAPL'].coverage.excluded.constructor = 1; }],
    ['computedAt', v => { v.computedAt = '2026-11-11'; }],
    ['computedAt not canonical', v => { v.computedAt = '2026-11-11T08:50:00Z'; }],
    ['runId empty', v => { v.runId = ''; }],
    ['carriedOver unknown company', v => { v.carriedOver = ['nasdaq:TSLA']; }],
    ['carriedOver duplicate', v => { v.carriedOver = ['nasdaq:AAPL', 'nasdaq:AAPL']; }],
    ['companies array', v => { v.companies = [v.companies['nasdaq:AAPL']]; }],
  ]);
});

test('prices: mutation table', async () => {
  const krx = (v: Record<string, any>) => v.series['krx:069500'];
  await mutationTable('prices.json', PRICES, s => s.readPrices(), [
    ['series key differs from map key', v => { krx(v).key = 'krx:005930'; }],
    ['provider', v => { krx(v).provider = 'krx'; }],
    ['exchange', v => { krx(v).exchange = 'KOSPI'; }],
    ['currency', v => { krx(v).currency = 'EUR'; }],
    ['basis', v => { krx(v).basis = 'adjusted'; }],
    ['forwardSince', v => { krx(v).forwardSince = 'soon'; }],
    ['lastAttempt code', v => { krx(v).lastAttempt.code = 'HTTP 500: key=abc'; }],
    ['rebasedAt', v => { krx(v).rebasedAt = 0; }],
    ['bars out of order', v => { krx(v).bars.reverse(); }],
    ['duplicate bar date', v => { krx(v).bars[1].date = krx(v).bars[0].date; }],
    ['bar date', v => { krx(v).bars[0].date = '2026-02-30'; }],
    ['close zero', v => { krx(v).bars[0].close = 0; }],
    ['negative open', v => { krx(v).bars[0].open = -1; }],
    ['NaN as null', v => { krx(v).bars[0].high = null; }],
    ['string volume', v => { krx(v).bars[0].volume = '1000'; }],
    ['baseFactor zero', v => { krx(v).bars[1].baseFactor = 0; }],
    ['indexClose zero', v => { krx(v).bars[1].indexClose = 0; }],
    ['adjClose negative', v => { v.series['nasdaq:AAPL'].bars[0].adjClose = -230; }],
    ['base negative', v => { krx(v).bars[0].base = -5; }],
    ['unknown flag', v => { krx(v).bars[1].flags = ['split']; }],
    ['firstFetchedAt', v => { krx(v).bars[0].firstFetchedAt = null; }],
    ['series not an object', v => { v.series['krx:069500'] = []; }],
  ]);
});

test('weekly and daily outcomes: complete outcomes only, exact shapes', async () => {
  const week = (v: Record<string, any>) => v.records[0].outcome;
  await mutationTable('weekly/2026.json', WEEKLY, s => s.readWeekly(2026), [
    ['pending', v => { week(v).status = 'pending'; }],
    ['excluded reason', v => { week(v).reason = 'price_gap'; }],
    ['entryType', v => { week(v).entryType = 'midday'; }],
    ['entryType null', v => { week(v).entryType = null; }],
    ['basis', v => { week(v).basis = 'total_return'; }],
    ['label', v => { week(v).label = 'flat'; }],
    ['flag', v => { week(v).flags = ['suspect']; }],
    ['sessions not ascending', v => { week(v).sessions = ['2026-11-02', '2026-11-04', '2026-11-03', '2026-11-05', '2026-11-06']; }],
    ['entryDate not first session', v => { week(v).entryDate = '2026-11-03'; }],
    ['exitDate not last session', v => { week(v).exitDate = '2026-11-05'; }],
    ['r below -1', v => { week(v).r = -1.5; }],
    ['relative null is fine, NaN is not', v => { week(v).relative = 'NaN'; }],
    ['entryAtMs missing', v => { delete week(v).entryAtMs; }],
    ['exit before entry', v => { week(v).exitAtMs = week(v).entryAtMs - 1; }],
    ['weekAsOf differs from weekAsOfMs', v => { v.records[0].weekAsOf = iso(WEEK_AS_OF + 1); }],
    ['frozenAt', v => { v.records[0].frozenAt = 'later'; }],
    ['priceBasisVersion empty', v => { v.records[0].priceBasisVersion = ''; }],
    ['kind', v => { v.kind = 'daily'; }],
    ['year', v => { v.year = 2025; }],
  ]);
  const day = (v: Record<string, any>) => v.records[0].outcome;
  await mutationTable('daily/2026.json', DAILY, s => s.readDaily(2026), [
    ['sessionDate differs from exitDate', v => { v.records[0].sessionDate = '2026-11-05'; }],
    ['intraday not finite', v => { day(v).intraday = 'x'; }],
    ['relativeIntraday missing', v => { delete day(v).relativeIntraday; }],
    ['excluded', v => { day(v).status = 'excluded'; day(v).reason = 'benchmark_gap'; }],
    ['companyId empty', v => { v.records[0].companyId = ''; }],
  ]);
  const flags = parseDailyOutcomesFile(plain(DAILY));
  assert.ok(flags.ok);
  assert.deepEqual(flags.value.records[0]!.outcome.flags, ['unadjusted', 'benchmark_chained']);
  const nulls = plain(DAILY) as unknown as Record<string, any>;
  Object.assign(nulls.records[0].outcome, { benchmarkR: null, relative: null, sigma: null, band: null, label: null, flags: ['insufficient_volatility_history'] });
  assert.ok(parseDailyOutcomesFile(nulls).ok, 'nullable fields accept null');
});

test('shadow records: enums and cross-field rules', async () => {
  const dayRecord = (v: Record<string, any>) => v.records[0];
  const weekRecord = (v: Record<string, any>) => v.records[1];
  await mutationTable('shadow/2026.json', SHADOW, s => s.readShadow(2026), [
    ['recordDate is not the KST date', v => { dayRecord(v).recordDate = '2026-11-10'; }],
    ['horizon', v => { dayRecord(v).horizon = 'month'; }],
    ['exchange', v => { dayRecord(v).exchange = 'NYSE'; }],
    ['target basis', v => { dayRecord(v).target.basis = 'calendar'; }],
    ['target phase', v => { dayRecord(v).target.phase = 'lunch'; }],
    ['target reversed', v => { weekRecord(v).target.end = '2026-11-01'; }],
    ['newsWindow on week', v => { weekRecord(v).newsWindow = dayRecord(v).newsWindow; }],
    ['newsWindow reversed', v => { dayRecord(v).newsWindow = { start: '2026-11-12T00:00:00.000Z', end: '2026-11-11T06:30:00.000Z' }; }],
    ['overnight on week', v => { weekRecord(v).overnight = dayRecord(v).overnight; }],
    ['overnight count', v => { dayRecord(v).overnight.counts.neutral = -1; }],
    ['snapshot status', v => { dayRecord(v).snapshot.status = 'stale'; }],
    ['snapshot partial', v => { dayRecord(v).snapshot.partial = 'no'; }],
    ['directional baseline without snapshot', v => { weekRecord(v).baseline = 'positive'; }],
    ['verdict with withheld baseline', v => { weekRecord(v).verdict = 'supports'; }],
    ['verdict', v => { dayRecord(v).verdict = 'maybe'; }],
    ['integrated disagrees with integrateOutlook', v => { dayRecord(v).integrated = 'withheld'; }],
    ['changed disagrees', v => { dayRecord(v).changed = true; }],
    ['note disagrees', v => { dayRecord(v).note = 'contradicts'; }],
    ['statsStatus', v => { dayRecord(v).statsStatus = 'off'; }],
    ['statsComputedAt', v => { dayRecord(v).statsComputedAt = ''; }],
    ['stale', v => { dayRecord(v).stale = 0; }],
  ]);
  const contradicted = plain(SHADOW) as unknown as Record<string, any>;
  Object.assign(contradicted.records[0], { verdict: 'contradicts', integrated: 'withheld', changed: true, note: 'contradicts' });
  assert.ok(parseShadowFile(contradicted).ok);
});

test('ledger: one bad entry invalidates the whole segment; state and directory rules', async () => {
  const entry = (v: Record<string, any>, i = 0) => v.entries[i];
  const outcome = (v: Record<string, any>) => v.entries[1].outcome;
  await mutationTable('ledger/2026-11.json', SEGMENT, s => s.readLedgerSegment('2026-11'), [
    ['segment differs from file name', v => { v.segment = '2026-10'; v.state.directory = ['2026-10']; }],
    ['directory does not end with segment', v => { v.state.directory = ['2026-11', '2026-10']; }],
    ['directory unsorted', v => { v.state.directory = ['2026-10.1', '2026-10', '2026-11']; }],
    ['directory duplicate', v => { v.state.directory = ['2026-10', '2026-10', '2026-11']; }],
    ['directory bad id', v => { v.state.directory = ['2026-10.0', '2026-11']; }],
    ['journal writes', v => { v.state.journal.writes = -1; }],
    ['journal date', v => { v.state.journal.kstDate = '2026-11-31'; }],
    ['journal fullDone', v => { v.state.journal.fullDone = 'yes'; }],
    ['writeToken', v => { v.state.writeToken = ''; }],
    ['createdAt', v => { v.state.createdAt = null; }],
    ['gap reversed', v => { v.state.observations['krx:005930'].gaps[0].end = v.state.observations['krx:005930'].gaps[0].start; }],
    ['gap detectedAt', v => { delete v.state.observations['krx:005930'].gaps[0].detectedAt; }],
    ['too many gaps', v => { v.state.observations['krx:005930'].gaps = Array.from({ length: 501 }, () => v.state.observations['krx:005930'].gaps[0]); }],
    ['duplicate (companyId, id)', v => { v.entries.push(plain(v.entries[0])); }],
    ['id empty', v => { entry(v).id = ''; }],
    ['id too long', v => { entry(v).id = 'x'.repeat(301); }],
    ['companyId too long', v => { entry(v).companyId = 'x'.repeat(41); }],
    ['publishedAt', v => { entry(v).publishedAt = '2026-11-10'; }],
    ['timeKind', v => { entry(v).timeKind = 'guessed'; }],
    ['timePrecision', v => { entry(v).timePrecision = 'minute'; }],
    ['identity', v => { entry(v).identity = 'ticker'; }],
    ['origin', v => { entry(v).origin = 'import'; }],
    ['firstSeenAt', v => { entry(v).firstSeenAt = ''; }],
    ['url too long', v => { entry(v).url = `https://example.com/${'x'.repeat(2000)}`; }],
    ['title too long', v => { entry(v).title = 'x'.repeat(1001); }],
    ['source too long', v => { entry(v).source = 'x'.repeat(301); }],
    ['topic', v => { entry(v).topic = 'gossip'; }],
    ['collection limit', v => { entry(v).collection.limit = -3; }],
    ['collection languages', v => { entry(v).collection.languages = [1]; }],
    ['labels missing', v => { delete entry(v).labels; }],
    ['too many labels', v => { entry(v).labels = Array.from({ length: 101 }, () => entry(v).labels[0]); }],
    ['label sentiment', v => { entry(v).labels[0].sentiment = 'bullish'; }],
    ['label score', v => { entry(v).labels[0].score = 'high'; }],
    ['label method', v => { entry(v).labels[0].method = 'human'; }],
    ['label relevance', v => { entry(v).labels[0].relevance = 'maybe'; }],
    ['label consensus', v => { entry(v).labels[0].consensus = 'unanimous'; }],
    ['label models', v => { entry(v).labels[0].models = 'gemini'; }],
    ['outcome old draft label', v => { outcome(v).label = 'flat'; }],
    ['outcome entryAt missing', v => { delete outcome(v).entryAt; }],
    ['outcome flag', v => { outcome(v).flags = ['split']; }],
    ['outcome sessions', v => { outcome(v).sessions = []; }],
    ['outcome frozenAt', v => { outcome(v).frozenAt = null; }],
    ['outcome r', v => { outcome(v).r = -2; }],
    ['entries not an array', v => { v.entries = {}; }],
  ]);
  // The same article id under two companies is two entries.
  const parsed = parseLedgerSegmentFile(plain(SEGMENT), '2026-11');
  assert.ok(parsed.ok);
  assert.equal(parsed.value.entries.length, 3);
});

// ---------------------------------------------------------------------------
// Ledger head
// ---------------------------------------------------------------------------

test('findLedgerHead probes fresh from the current month back and shards upward', async () => {
  const store = createMemoryHistoryStore();
  const put = (id: string, directory: string[]) => store.files.set(`ledger/${id}.json`, { text: JSON.stringify(segmentFile(id, directory)), etag: `"${id}"` });
  assert.equal(await store.findLedgerHead('2026-11'), null, 'nothing within 36 months');
  assert.equal(store.reads.length, 36);
  assert.deepEqual(store.reads[0], { file: 'ledger/2026-11.json', fresh: true });
  assert.deepEqual(store.reads[35], { file: 'ledger/2023-12.json', fresh: true });
  assert.ok(store.reads.every(read => read.fresh));

  put('2023-11', ['2023-11']);
  assert.equal(await store.findLedgerHead('2026-11'), null, 'a segment 36 months back is outside the probe');
  put('2026-10', ['2026-10']);
  store.reads.length = 0;
  const previous = (await store.findLedgerHead('2026-11'))!;
  assert.equal(previous.value.segment, '2026-10', 'empty current month → previous month');
  assert.equal(previous.etag, '"2026-10"');
  assert.deepEqual(store.reads.map(read => read.file), ['ledger/2026-11.json', 'ledger/2026-10.json', 'ledger/2026-10.1.json']);

  put('2026-11', ['2026-10', '2026-11']);
  assert.equal((await store.findLedgerHead('2026-11'))!.value.segment, '2026-11', 'shard 0 only');
  put('2026-11.1', ['2026-10', '2026-11', '2026-11.1']);
  assert.equal((await store.findLedgerHead('2026-11'))!.value.segment, '2026-11.1', 'shards 0 and 1');
  assert.equal((await store.findLedgerHead('2026-12', 2))!.value.segment, '2026-11.1');
  assert.equal(await store.findLedgerHead('2027-01', 2), null);
});

test('findLedgerHead throws on any failure other than not found', async () => {
  const valid = segmentFile('2026-10', ['2026-10']);
  let failing: string | null = 'ledger/2026-10.json';
  const store = createMemoryHistoryStore({ failRead: file => (file === failing ? 'unreadable' : null) });
  store.files.set('ledger/2026-10.json', { text: JSON.stringify(valid), etag: '"a"' });
  assert.equal(await codeOf(store.findLedgerHead('2026-11')), 'unreadable');
  failing = null;
  store.files.set('ledger/2026-10.1.json', { text: '{"broken"', etag: '"b"' });
  assert.equal(await codeOf(store.findLedgerHead('2026-11')), 'invalid', 'an unreadable shard is never skipped');
  store.files.set('ledger/2026-10.1.json', { text: JSON.stringify({ ...segmentFile('2026-10.1', ['2026-10', '2026-10.1']), version: 'news-history-ledger-v9' }), etag: '"c"' });
  assert.equal(await codeOf(store.findLedgerHead('2026-11')), 'unsupported_version');

  const fake = blobStore();
  fake.hooks.get = pathname => {
    if (pathname.endsWith('2026-11.json')) return null;
    throw new DOMException('timed out', 'TimeoutError');
  };
  assert.equal(await codeOf(fake.store.findLedgerHead('2026-11')), 'timeout');
  assert.deepEqual(fake.gets.map(call => withoutSignal(call.options)), [{ access: 'private', useCache: false }, { access: 'private', useCache: false }]);
});

// ---------------------------------------------------------------------------
// Memory store parity
// ---------------------------------------------------------------------------

test('memory store: same parsers and etag conditions, writeLog timestamps, failure injection and counters', async () => {
  let clock = NOW;
  let failNext: HistoryStoreErrorCode | null = null;
  const store = createMemoryHistoryStore({
    now: () => clock,
    failWrite: () => { const code = failNext; failNext = null; return code; },
  });
  const created = await store.writeLedgerSegment(SEGMENT, { kind: 'createOnly' });
  assert.equal(store.files.get('ledger/2026-11.json')!.etag, created.etag);
  assert.equal(store.files.get('ledger/2026-11.json')!.text, JSON.stringify(SEGMENT));
  clock += 1_000;
  assert.equal(await codeOf(store.writeLedgerSegment({ ...SEGMENT, state: { ...SEGMENT.state, writeToken: 'run-x' } }, { kind: 'createOnly' })), 'conflict', 'createOnly on an existing segment');
  clock += 1_000;
  const next = { ...SEGMENT, state: { ...SEGMENT.state, writeToken: 'run-2' } };
  assert.equal(await codeOf(store.writeLedgerSegment(next, { kind: 'ifMatch', etag: '"wrong"' })), 'conflict');
  clock += 1_000;
  const updated = await store.writeLedgerSegment(next, { kind: 'ifMatch', etag: created.etag });
  assert.notEqual(updated.etag, created.etag);
  assert.equal(await codeOf(store.writeLedgerSegment({ ...next, state: { ...next.state, writeToken: 'run-3' } }, { kind: 'ifMatch', etag: '"mem-404"' })), 'conflict');
  clock += 1_000;
  failNext = 'write_failed';
  assert.equal(await codeOf(store.writeStats(STATS)), 'write_failed');
  failNext = 'timeout';
  assert.equal(await codeOf(store.writePrices(PRICES)), 'timeout');
  assert.equal(store.files.has('stats.json'), false, 'a failed put stores nothing');
  await store.writeStats(STATS);
  assert.equal(await codeOf(store.writeStats({ ...STATS, runId: 'x'.repeat(MAX_FILE_BYTES) })), 'too_large');
  assert.deepEqual(store.writeLog, [
    { file: 'ledger/2026-11.json', at: NOW, ok: true },
    { file: 'ledger/2026-11.json', at: NOW + 1_000, ok: false },
    { file: 'ledger/2026-11.json', at: NOW + 2_000, ok: false },
    { file: 'ledger/2026-11.json', at: NOW + 3_000, ok: true },
    { file: 'ledger/2026-11.json', at: NOW + 3_000, ok: false },
    { file: 'stats.json', at: NOW + 4_000, ok: false },
    { file: 'prices.json', at: NOW + 4_000, ok: false },
    { file: 'stats.json', at: NOW + 4_000, ok: true },
  ]);
  assert.equal(store.attempts, 8, 'every put call, but not the too_large rejection');
  assert.equal(store.writes, 3, 'successful puts only');

  // A landed write that came back as a conflict: the hook stores our file first, as an SDK retry would.
  let landOnce = true;
  const landedStore = createMemoryHistoryStore({
    failWrite: file => {
      if (file !== 'ledger/2026-12.json' || !landOnce) return null;
      landOnce = false;
      landedStore.files.set(file, { text: JSON.stringify(december), etag: '"landed"' });
      return 'conflict';
    },
  });
  const december = segmentFile('2026-12', ['2026-12'], 'run-dec');
  assert.deepEqual(await landedStore.writeLedgerSegment(december, { kind: 'createOnly' }), { etag: '"landed"', bytes: jsonByteLength(december) });
  assert.equal(landedStore.writes, 1);
  landedStore.files.set('ledger/2026-12.json', { text: JSON.stringify(segmentFile('2026-12', ['2026-12'], 'someone-else')), etag: '"x"' });
  assert.equal(await codeOf(landedStore.writeLedgerSegment(december, { kind: 'createOnly' })), 'conflict', 'a different token stays a conflict');

  // Reads: the same parsers, sizes and logs; injected failures carry the code.
  const reading = createMemoryHistoryStore({ failRead: file => (file === 'prices.json' ? 'timeout' : null) });
  assert.equal(await reading.readStats(), null);
  assert.equal(await codeOf(reading.readPrices({ fresh: true })), 'timeout');
  reading.files.set('stats.json', { text: ' '.repeat(MAX_FILE_BYTES + 1), etag: '"big"' });
  assert.equal(await codeOf(reading.readStats()), 'too_large');
  reading.files.set('stats.json', { text: JSON.stringify(STATS), etag: '"s"' });
  const stats = (await reading.readStats({ fresh: true }))!;
  assert.equal(stats.etag, '"s"');
  assert.deepEqual(plain(stats.value), plain(STATS));
  assert.deepEqual(reading.reads, [
    { file: 'stats.json', fresh: false }, { file: 'prices.json', fresh: true }, { file: 'stats.json', fresh: false }, { file: 'stats.json', fresh: true },
  ]);
  assert.equal(reading.writes + reading.attempts, 0);
});

test('memory and Blob stores agree on bytes, files and round trips', async () => {
  const memory = createMemoryHistoryStore();
  const { store: blob, objects } = blobStore();
  for (const s of [memory, blob]) {
    await s.writeStats(STATS);
    await s.writePrices(PRICES);
    await s.writeWeekly(WEEKLY);
    await s.writeDaily(DAILY);
    await s.writeShadow(SHADOW);
    await s.writeLedgerSegment(SEGMENT, { kind: 'createOnly' });
  }
  assert.deepEqual([...memory.files.keys()].map(file => HISTORY_PREFIX + file), [...objects.keys()]);
  for (const [file, stored] of memory.files) assert.equal(objects.get(HISTORY_PREFIX + file)!.text, stored.text);
  for (const s of [memory, blob]) {
    assert.deepEqual(plain((await s.findLedgerHead('2026-11'))!.value), plain(SEGMENT));
    assert.deepEqual(plain((await s.readShadow(2026))!.value), plain(SHADOW));
    assert.equal(s.writes, 6);
    assert.equal(s.attempts, 6);
  }
});
