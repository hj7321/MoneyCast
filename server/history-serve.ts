import {
  NEWS_HISTORY_VERSION, horizonSampleOrigin, parseCompanyHistory,
  type Company, type CompanyHistory, type HistoryValidation, type Horizon, type HorizonHistory, type NewsAnalysis,
} from '../packages/core/src/index.js';
import { parseHistoryMode, type HistoryMode } from './history-job.js';
import type { CompanyStats } from './history-stats.js';
import { HistoryStoreError, createBlobHistoryStore, type HistoryStore, type StatsFile } from './history-store.js';
import { CALENDAR_UNVERIFIED, dayTargetWindow, targetSession, weekTargetWindow, type CalendarBasis, type Exchange } from './market-calendar.js';
import { companyPriceIdentities } from './price-provider.js';

// GET /api/news/history (step 6, plan ch. 3 and 6). Invariants:
// - No external call: one cached stats.json read per instance and hour, nothing else, and none at all
//   for a market missing from HISTORY_PUBLIC_MARKETS. Creation does no I/O and starts no timer.
// - A market whose price statistics are not public gets stats_not_public with no number from
//   stats.json: no directions, zero coverage, no dates and no sources (plan 질문 8).
// - Target and news windows are computed per request and never stored, so a past session is never
//   shown as the next one; the CDN keeps an answer at most until the next open or close.
// - answer() never throws: every failure is { status: 'unavailable' }, kept at the CDN for 60 s.
// - A stats.json read that fails (no store, a Blob error, an invalid file) writes one console.warn line,
//   `history_serve <code>`: a fixed code only, never a message, a path or a secret, and at most once per
//   60 s failure window, since the failure is cached that long. A missing file is no failure.
// - /api/news never reads stats.json: it only gains the historyAvailable hint (withHistoryHint).

export const HISTORY_STATS_TTL_MS = 3_600_000;
export const HISTORY_STATS_RETRY_MS = 60_000;
export const HISTORY_CDN_MAX_SECONDS = 3_600;
export const HISTORY_CDN_MIN_SECONDS = 30;
export const HISTORY_FAILURE_CDN = 'public, s-maxage=60';

function notEvaluated(): HistoryValidation {
  return Object.freeze({ status: 'not_evaluated', directions: Object.freeze([]), markets: Object.freeze([]), evaluatedAt: null }) as unknown as HistoryValidation;
}

/**
 * Code constants, changed only by a pull request (plan 8장: a badge changes only after the evaluation).
 * Every answer gets fresh copies; these arrays are never sent themselves.
 */
export const HISTORY_VALIDATION: Readonly<Record<Horizon, HistoryValidation>> = Object.freeze({ day: notEvaluated(), week: notEvaluated() });

const copyValidation = (validation: HistoryValidation): HistoryValidation => ({
  status: validation.status, directions: [...validation.directions], markets: [...validation.markets], evaluatedAt: validation.evaluatedAt,
});

export type PublicMarket = 'KR' | 'US';

/** HISTORY_PUBLIC_MARKETS: comma separated, trimmed, any case; anything but KR and US is ignored. Unset or empty: none. */
export function parsePublicMarkets(value: string | undefined): ReadonlySet<PublicMarket> {
  const markets = new Set<PublicMarket>();
  for (const part of (value ?? '').split(',')) {
    const market = part.trim().toUpperCase();
    if (market === 'KR' || market === 'US') markets.add(market);
  }
  return markets;
}

const isPublic = (markets: ReadonlySet<PublicMarket>, region: string): boolean => (markets as ReadonlySet<string>).has(region);

/**
 * The /api/news hint: a new object with historyAvailable for a ready or insufficient live analysis
 * while HISTORY_INSIGHTS is on. Anything else is returned as the same object, so the answer is
 * byte for byte what it was. The input is never changed: the news service caches it.
 */
export function withHistoryHint(analysis: NewsAnalysis, mode: HistoryMode): NewsAnalysis {
  if (mode !== 'on' || (analysis.status !== 'ready' && analysis.status !== 'insufficient') || analysis.servedFrom === 'stale') return analysis;
  return { ...analysis, historyAvailable: true };
}

/**
 * CDN lifetime of a history answer: until the target session's next open, or its close while it is
 * open, within 30 s and 1 h. At an open or a close the phase, the target or a window changes, so an
 * answer cached across one would show a past session as the next. (The local midnight after a close
 * only turns after_close into before_open, which the screen does not tell apart, so it ends nothing.)
 * The open instant itself gets the minimum: there the phase already reads in_session while the week
 * window still starts with today (an article at t′ = open is outside the session), and both move one
 * millisecond later.
 * Near the end of a calendar table the week can fall back to weekdays_only while the day keeps the
 * table (KRX, 2026-12-24 after the close: the day waits for the 12-28 open, the week moves at a
 * weekday open on the 12-25 holiday), so the earliest boundary of each basis the two windows use counts.
 */
export function historyCdnCacheControl(exchange: Exchange, nowMs: number): string {
  const bases = new Set<CalendarBasis>([dayTargetWindow(exchange, nowMs).targetWindow.basis, weekTargetWindow(exchange, nowMs).basis]);
  let seconds = HISTORY_CDN_MAX_SECONDS;
  for (const basis of bases) {
    const target = targetSession(exchange, nowMs, basis);
    let left = Number.NaN;
    if (target !== CALENDAR_UNVERIFIED) {
      const { openMs, closeMs } = target.session;
      const boundary = nowMs < openMs ? openMs : nowMs === openMs ? openMs + 1 : closeMs;
      left = Math.floor((boundary - nowMs) / 1000);
    }
    seconds = Math.min(seconds, Number.isFinite(left) ? Math.max(HISTORY_CDN_MIN_SECONDS, left) : HISTORY_CDN_MIN_SECONDS);
  }
  return `public, s-maxage=${seconds}`;
}

export interface StatsReader { read(): Promise<StatsFile | null> }

/** The fixed codes of a failed stats.json read, the only text its warning line carries. */
export type HistoryServeWarning = 'store_not_configured' | 'stats_unreadable' | 'stats_timeout' | 'stats_too_large' | 'stats_invalid'
  | 'stats_unsupported_version';

/** The store's own codes map one to one; anything else (another error, a code a read never has) is stats_unreadable. */
export function statsReadWarning(error: unknown): HistoryServeWarning {
  const code = error instanceof HistoryStoreError ? error.code : null;
  return code === 'timeout' ? 'stats_timeout' : code === 'too_large' ? 'stats_too_large' : code === 'invalid' ? 'stats_invalid'
    : code === 'unsupported_version' ? 'stats_unsupported_version' : 'stats_unreadable';
}

export function historyServeLogLine(code: HistoryServeWarning): string {
  return `history_serve ${code}`;
}

/** Looked up when called, so a test that replaces console.warn sees the line. */
const consoleWarn = (line: string): void => { console.warn(line); };

/**
 * stats.json through a memory cache: a file is kept for an hour; a missing file or a failed read is
 * remembered for 60 s and answered with the last good file (null before the first). Concurrent
 * callers share one read. A read is the store's default cached read, never a fresh one.
 * Each failed read writes one warning line, so at most one per 60 s failure window; a missing file writes none.
 */
export function createStatsReader(store: () => HistoryStore | null, clock: () => number,
  warn: (line: string) => void = consoleWarn): StatsReader {
  let entry: { kind: 'file' | 'missing' | 'failed'; until: number; file: StatsFile | null } | null = null;
  let lastGood: StatsFile | null = null;
  let pending: Promise<StatsFile | null> | null = null;

  async function refresh(): Promise<StatsFile | null> {
    let configured = true;
    try {
      const target = store();
      configured = target !== null;
      if (!target) throw new Error('no history store');
      const stored = await target.readStats();
      if (stored === null) {
        entry = { kind: 'missing', until: clock() + HISTORY_STATS_RETRY_MS, file: null };
        return lastGood;
      }
      entry = { kind: 'file', until: clock() + HISTORY_STATS_TTL_MS, file: stored.value };
      lastGood = stored.value;
      return stored.value;
    } catch (error) {
      entry = { kind: 'failed', until: clock() + HISTORY_STATS_RETRY_MS, file: null };
      // Only the code: the error's message may quote a path, a provider answer or a token.
      try { warn(historyServeLogLine(configured ? statsReadWarning(error) : 'store_not_configured')); } catch { /* logging never fails a read */ }
      return lastGood;
    }
  }

  return {
    read() {
      if (entry && clock() < entry.until) return Promise.resolve(entry.kind === 'file' ? entry.file : lastGood);
      pending ??= refresh().finally(() => { pending = null; });
      return pending;
    },
  };
}

export interface HistoryAnswer { body: CompanyHistory; cdnCacheControl: string }
export interface HistoryServe {
  /** Never throws. */
  answer(company: Company): Promise<HistoryAnswer>;
}

/** No I/O, timers or throws here: api/index.ts builds the handler when the module loads. `warn` defaults to console.warn. */
export function createHistoryServe(env: NodeJS.ProcessEnv = process.env,
  overrides: { store?: HistoryStore | null; clock?: () => number; warn?: (line: string) => void } = {}): HistoryServe {
  const clock = overrides.clock ?? Date.now;
  let resolved = false;
  let blobStore: HistoryStore | null = null;
  const store = (): HistoryStore | null => {
    if ('store' in overrides) return overrides.store ?? null;
    if (!resolved) {
      resolved = true;
      try { blobStore = createBlobHistoryStore(env); } catch { blobStore = null; }
    }
    return blobStore;
  };
  const reader = createStatsReader(store, clock, overrides.warn);

  return {
    async answer(company) {
      const unavailable: HistoryAnswer = {
        body: { version: NEWS_HISTORY_VERSION, companyId: company.id, status: 'unavailable' }, cdnCacheControl: HISTORY_FAILURE_CDN,
      };
      try {
        if (parseHistoryMode(env.HISTORY_INSIGHTS) !== 'on') {
          return { body: { version: NEWS_HISTORY_VERSION, companyId: company.id, status: 'off' }, cdnCacheControl: HISTORY_FAILURE_CDN };
        }
        const exchange = companyPriceIdentities(company.id)?.stock.exchange ?? null;
        if (!exchange) return unavailable;
        const publicMarkets = parsePublicMarkets(env.HISTORY_PUBLIC_MARKETS);
        let stats: CompanyStats | null = null;
        // A market whose statistics are not public never causes a stats.json read.
        if (isPublic(publicMarkets, company.region)) {
          const file = await reader.read();
          stats = file && Object.prototype.hasOwnProperty.call(file.companies, company.id) ? file.companies[company.id] ?? null : null;
          if (!stats) return unavailable;
        }
        const nowMs = clock();
        const body = buildCompanyHistory({ company, exchange, nowMs, publicMarkets, stats });
        if (body.status === 'off' || body.status === 'unavailable' || parseCompanyHistory(JSON.parse(JSON.stringify(body))) === null) return unavailable;
        return { body, cdnCacheControl: historyCdnCacheControl(exchange, nowMs) };
      } catch {
        return unavailable;
      }
    },
  };
}

/**
 * One company's answer at nowMs. A market missing from publicMarkets gets stats_not_public with no
 * number from stats.json (dataAsOf.computedAt is the request time); a public one needs its stats.
 */
export function buildCompanyHistory(input: {
  company: Company; exchange: Exchange; nowMs: number; publicMarkets: ReadonlySet<PublicMarket>; stats: CompanyStats | null;
}): CompanyHistory {
  const { company, exchange, nowMs } = input;
  const statsPublic = isPublic(input.publicMarkets, company.region);
  const stats = statsPublic ? input.stats : null;
  if (statsPublic && !stats) return { version: NEWS_HISTORY_VERSION, companyId: company.id, status: 'unavailable' };
  const day = dayTargetWindow(exchange, nowMs);
  const week = weekTargetWindow(exchange, nowMs);
  const horizon = (h: Horizon): HorizonHistory => {
    const directions = stats ? stats.horizons[h].directions : null;
    return {
      validation: copyValidation(HISTORY_VALIDATION[h]),
      targetWindow: h === 'day' ? { ...day.targetWindow } : { ...week },
      newsWindow: h === 'day' ? { ...day.newsWindow } : null,
      directions,
      ...(stats && directions !== null ? { sampleOrigin: horizonSampleOrigin(stats.horizons[h].timeUnverifiedUnits) } : {}),
    };
  };
  const horizons = { day: horizon('day'), week: horizon('week') };
  if (!stats) {
    return {
      version: NEWS_HISTORY_VERSION, companyId: company.id, status: 'stats_not_public', horizons,
      coverage: { articles: 0, events: 0, usable: 0, excluded: {}, observationGaps: 0 },
      dataAsOf: { computedAt: new Date(nowMs).toISOString(), lastPriceDate: null, ledgerFrom: null, ledgerTo: null },
      sources: { news: [], price: null },
    };
  }
  return {
    version: NEWS_HISTORY_VERSION, companyId: company.id, status: stats.status, horizons,
    coverage: { ...stats.coverage, excluded: { ...stats.coverage.excluded } },
    dataAsOf: { ...stats.dataAsOf },
    sources: { news: [...stats.sources.news], price: stats.sources.price ? { ...stats.sources.price } : null },
  };
}
