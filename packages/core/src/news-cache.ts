import { companies, isNewsAnalysis, type NewsAnalysis } from './index';

export const NEWS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
export const NEWS_CACHE_ANALYSIS_VERSION = 'news-evidence-v2';
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

interface NewsCacheOptions {
  load: (companyId: string) => Promise<unknown>;
  clock?: () => number;
  /** Optional synchronous persistence; native clients may use memory only. */
  storage?: () => NewsCacheStorage | undefined;
}

/** Only validated successful results are persisted; failed requests remain retryable. */
export function createNewsCache({ load, clock = Date.now, storage }: NewsCacheOptions) {
  const memory = new Map<string, CacheEntry>();
  const pending = new Map<string, Promise<NewsAnalysis>>();
  const keyFor = (companyId: string) => `${STORAGE_PREFIX}${NEWS_CACHE_ANALYSIS_VERSION}.${companyId}`;

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
        !isNewsAnalysis(entry.value, companyId)) return false;
    const company = companies.find(item => item.id === companyId);
    if (!company || ['name', 'symbol', 'exchange', 'region'].some(field =>
      entry.value!.company[field as keyof typeof company] !== company[field as keyof typeof company])) return false;
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
      return value;
    }).finally(() => pending.delete(companyId));
    pending.set(companyId, request);
    return request;
  }

  return { getAnalysis, peek };
}
