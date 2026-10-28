import { companies, isNewsAnalysis, type NewsAnalysis } from './index.js';

export const NEWS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
export const NEWS_CACHE_ANALYSIS_VERSION = 'news-evidence-v3';
/** The last successful result is offered, labelled as old, for at most a week. */
export const NEWS_LAST_GOOD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_SCHEMA = 1;
const STORAGE_PREFIX = 'moneycast.news.v1.';
const MAX_STORED_CHARS = 1_048_576;

export interface NewsCacheStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface CacheEntry {
  schema: number;
  analysisVersion: string;
  expiresAt: number;
  value: NewsAnalysis;
}

interface LastGoodEntry {
  schema: number;
  analysisVersion: string;
  value: NewsAnalysis;
}

interface NewsCacheOptions {
  load: (companyId: string) => Promise<unknown>;
  clock?: () => number;
  /** Optional synchronous persistence; native clients may use memory only. */
  storage?: () => NewsCacheStorage | undefined;
}

function matchesCatalog(value: NewsAnalysis, companyId: string): boolean {
  const company = companies.find(item => item.id === companyId);
  return !!company && (['name', 'symbol', 'exchange', 'region'] as const).every(field => value.company[field] === company[field]);
}

/**
 * Only validated successful results are persisted; failed requests remain retryable.
 * A separate last-good copy is kept for display, labelled as old, when a refresh fails.
 */
export function createNewsCache({ load, clock = Date.now, storage }: NewsCacheOptions) {
  const memory = new Map<string, CacheEntry>();
  const lastGood = new Map<string, NewsAnalysis>();
  const pending = new Map<string, Promise<NewsAnalysis>>();
  const keyFor = (companyId: string) => `${STORAGE_PREFIX}${NEWS_CACHE_ANALYSIS_VERSION}.${companyId}`;
  const lastKeyFor = (companyId: string) => `${STORAGE_PREFIX}last.${NEWS_CACHE_ANALYSIS_VERSION}.${companyId}`;

  function persistence(): NewsCacheStorage | undefined {
    try { return storage?.(); } catch { return undefined; }
  }

  function expiry(value: NewsAnalysis, now: number): number | null {
    if (!['ready', 'insufficient'].includes(value.status) || value.analysisVersion !== NEWS_CACHE_ANALYSIS_VERSION) return null;
    const asOf = Date.parse(value.asOf);
    if (asOf > now + 60_000) return null;
    // Re-reading a result never extends its original freshness window.
    const expiresAt = Math.min(asOf + NEWS_CACHE_TTL_MS, now + NEWS_CACHE_TTL_MS,
      value.cachedUntil ? Date.parse(value.cachedUntil) : Infinity);
    return Number.isFinite(expiresAt) && expiresAt > now ? expiresAt : null;
  }

  function validEntry(value: unknown, companyId: string, now: number): value is CacheEntry {
    if (!value || typeof value !== 'object') return false;
    const entry = value as Partial<CacheEntry>;
    if (entry.schema !== CACHE_SCHEMA || entry.analysisVersion !== NEWS_CACHE_ANALYSIS_VERSION ||
        typeof entry.expiresAt !== 'number' || !Number.isFinite(entry.expiresAt) || entry.expiresAt <= now ||
        !isNewsAnalysis(entry.value, companyId) || !matchesCatalog(entry.value, companyId)) return false;
    const maximum = expiry(entry.value, now);
    return maximum !== null && entry.expiresAt <= maximum;
  }

  function peek(companyId: string): NewsAnalysis | null {
    const now = clock();
    const existing = memory.get(companyId);
    if (validEntry(existing, companyId, now)) return existing.value;
    memory.delete(companyId);
    const store = persistence();
    if (!store) return null;
    try {
      const raw = store.getItem(keyFor(companyId));
      if (!raw) return null;
      const entry: unknown = raw.length <= MAX_STORED_CHARS ? JSON.parse(raw) : null;
      if (!validEntry(entry, companyId, now)) {
        store.removeItem(keyFor(companyId));
        return null;
      }
      memory.set(companyId, entry);
      return entry.value;
    } catch {
      try { store.removeItem(keyFor(companyId)); } catch { /* Storage may be blocked or full. */ }
      return null;
    }
  }

  function usableLastGood(value: unknown, companyId: string, now: number): value is NewsAnalysis {
    if (!isNewsAnalysis(value, companyId) || !matchesCatalog(value, companyId) || !['ready', 'insufficient'].includes(value.status) ||
        value.analysisVersion !== NEWS_CACHE_ANALYSIS_VERSION || value.servedFrom === 'stale') return false;
    const asOf = Date.parse(value.asOf);
    return asOf <= now + 60_000 && now - asOf <= NEWS_LAST_GOOD_MAX_AGE_MS;
  }

  /** The last successful result regardless of freshness; callers must label it as old. */
  function peekLastGood(companyId: string): NewsAnalysis | null {
    const now = clock();
    const remembered = lastGood.get(companyId);
    if (usableLastGood(remembered, companyId, now)) return remembered;
    lastGood.delete(companyId);
    const store = persistence();
    if (!store) return null;
    try {
      const raw = store.getItem(lastKeyFor(companyId));
      if (!raw) return null;
      const entry = (raw.length <= MAX_STORED_CHARS ? JSON.parse(raw) : null) as Partial<LastGoodEntry> | null;
      if (entry?.schema !== CACHE_SCHEMA || entry.analysisVersion !== NEWS_CACHE_ANALYSIS_VERSION ||
          !usableLastGood(entry.value, companyId, now)) {
        store.removeItem(lastKeyFor(companyId));
        return null;
      }
      lastGood.set(companyId, entry.value);
      return entry.value;
    } catch {
      try { store.removeItem(lastKeyFor(companyId)); } catch { /* Storage may be blocked. */ }
      return null;
    }
  }

  function rememberLastGood(companyId: string, value: NewsAnalysis) {
    if (!usableLastGood(value, companyId, clock())) return;
    lastGood.set(companyId, value);
    const entry: LastGoodEntry = { schema: CACHE_SCHEMA, analysisVersion: NEWS_CACHE_ANALYSIS_VERSION, value };
    const store = persistence();
    if (store) try { store.setItem(lastKeyFor(companyId), JSON.stringify(entry)); } catch { /* Memory copy still works. */ }
  }

  async function getAnalysis(companyId: string): Promise<NewsAnalysis> {
    if (!companies.some(company => company.id === companyId)) throw new Error('검색 결과에서 회사와 거래소를 선택해 주세요.');
    const existing = peek(companyId);
    if (existing) return existing;
    const inflight = pending.get(companyId);
    if (inflight) return inflight;
    const request = Promise.resolve().then(() => load(companyId)).then(value => {
      if (!isNewsAnalysis(value, companyId)) throw new Error('뉴스 응답 형식이 올바르지 않습니다.');
      const expiresAt = expiry(value, clock());
      if (expiresAt !== null) {
        const entry: CacheEntry = { schema: CACHE_SCHEMA, analysisVersion: NEWS_CACHE_ANALYSIS_VERSION, expiresAt, value };
        memory.set(companyId, entry);
        const store = persistence();
        if (store) try { store.setItem(keyFor(companyId), JSON.stringify(entry)); } catch { /* Memory caching still works. */ }
      }
      rememberLastGood(companyId, value);
      return value;
    }).finally(() => pending.delete(companyId));
    pending.set(companyId, request);
    return request;
  }

  return { getAnalysis, peek, peekLastGood };
}
