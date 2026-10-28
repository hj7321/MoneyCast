import { get, put } from '@vercel/blob';
import { isNewsAnalysis, isNewsArticle, NEWS_CACHE_ANALYSIS_VERSION, type NewsAnalysis, type NewsArticle } from '../packages/core/src/index.js';

const SNAPSHOT_SCHEMA = 1;
const MAX_SNAPSHOT_BYTES = 1_048_576;
/** Articles kept across refreshes so a free plan's three-per-request limit accumulates over the week. */
export const SNAPSHOT_POOL_LIMIT = 30;

/** Last successful analysis and the seven-day article pool for one company. */
export interface CompanySnapshot {
  schema: number;
  analysisVersion: string;
  companyId: string;
  updatedAt: string;
  analysis: NewsAnalysis;
  pool: NewsArticle[];
}

export interface SnapshotStore {
  read(companyId: string): Promise<CompanySnapshot | null>;
  write(snapshot: CompanySnapshot): Promise<void>;
}

export function isCompanySnapshot(value: unknown, companyId: string): value is CompanySnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<CompanySnapshot>;
  return snapshot.schema === SNAPSHOT_SCHEMA && snapshot.analysisVersion === NEWS_CACHE_ANALYSIS_VERSION &&
    snapshot.companyId === companyId && typeof snapshot.updatedAt === 'string' && Number.isFinite(Date.parse(snapshot.updatedAt)) &&
    isNewsAnalysis(snapshot.analysis, companyId) && snapshot.analysis.servedFrom !== 'stale' &&
    Array.isArray(snapshot.pool) && snapshot.pool.length <= SNAPSHOT_POOL_LIMIT && snapshot.pool.every(isNewsArticle);
}

export function createSnapshot(analysis: NewsAnalysis, pool: NewsArticle[], updatedAt: Date): CompanySnapshot {
  return { schema: SNAPSHOT_SCHEMA, analysisVersion: NEWS_CACHE_ANALYSIS_VERSION, companyId: analysis.company.id,
    updatedAt: updatedAt.toISOString(), analysis, pool: pool.slice(0, SNAPSHOT_POOL_LIMIT) };
}

const pathFor = (companyId: string) => `news/${NEWS_CACHE_ANALYSIS_VERSION}/${companyId.replace(/[^a-zA-Z0-9]+/g, '-')}.json`;

async function boundedText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_SNAPSHOT_BYTES) throw new Error('snapshot too large');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const data = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(data);
}

/**
 * Private Vercel Blob storage, or null when no store is connected. On Vercel the
 * SDK authenticates with OIDC (BLOB_STORE_ID); elsewhere with BLOB_READ_WRITE_TOKEN.
 * Snapshots are an optimization: callers treat every failure as "no snapshot".
 */
export function createBlobSnapshotStore(
  env: NodeJS.ProcessEnv = process.env,
  blob: { get: typeof get; put: typeof put } = { get, put },
): SnapshotStore | null {
  if (!env.BLOB_READ_WRITE_TOKEN?.trim() && !env.BLOB_STORE_ID?.trim()) return null;
  return {
    async read(companyId) {
      const result = await blob.get(pathFor(companyId), { access: 'private' });
      if (!result || result.statusCode !== 200 || !result.stream) return null;
      const value: unknown = JSON.parse(await boundedText(result.stream));
      return isCompanySnapshot(value, companyId) ? value : null;
    },
    async write(snapshot) {
      await blob.put(pathFor(snapshot.companyId), JSON.stringify(snapshot), {
        access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json', cacheControlMaxAge: 60,
      });
    },
  };
}

/** In-process store for tests and local development. */
export function createMemorySnapshotStore(): SnapshotStore & { writes: number; entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries, writes: 0,
    async read(companyId) {
      const raw = entries.get(companyId);
      const value: unknown = raw ? JSON.parse(raw) : null;
      return isCompanySnapshot(value, companyId) ? value : null;
    },
    async write(snapshot) {
      this.writes += 1;
      entries.set(snapshot.companyId, JSON.stringify(snapshot));
    },
  };
}
