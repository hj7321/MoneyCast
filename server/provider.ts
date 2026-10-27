import { isNewsArticle, type Company, type NewsArticle } from '../packages/core/src/index.js';

export interface NewsProviderResult {
  provider: string;
  articles: NewsArticle[];
  notes?: string[];
}

export interface NewsProvider {
  name?: string;
  setupMessage?: string;
  cacheTtlMs?: number;
  getArticles(company: Company, now: Date): Promise<NewsProviderResult>;
}

export class ProviderError extends Error {
  constructor(
    public readonly code: 'not_configured' | 'rate_limited' | 'error',
    public readonly reason?: 'invalid_key' | 'access_denied' | 'identity_unverified',
    public readonly retryAfterMs?: number,
  ) {
    super(code);
    this.name = 'ProviderError';
  }
}

const MAX_BYTES = 1_048_576;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function validPublishedAt(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_TIME.test(value) || !Number.isFinite(Date.parse(value))) return false;
  const calendarDate = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  return Number.isFinite(calendarDate.getTime()) && calendarDate.toISOString().slice(0, 10) === value.slice(0, 10) &&
    Number(value.slice(11, 13)) < 24 && Number(value.slice(14, 16)) < 60 && Number(value.slice(17, 19)) < 60;
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function safeArticleUrl(value: unknown): value is string {
  if (!boundedString(value, 2048)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function parseProviderResponse(value: unknown, company: Company, now: Date): NewsProviderResult {
  if (!value || typeof value !== 'object') throw new ProviderError('error');
  const payload = value as Record<string, unknown>;
  if (payload.companyId !== company.id || !boundedString(payload.provider, 100) || !Array.isArray(payload.articles) || payload.articles.length > 40) {
    throw new ProviderError('error');
  }
  const articles: NewsArticle[] = [];
  const seenIds = new Set<string>();
  const seenUrls = new Set<string>();
  for (const raw of payload.articles) {
    if (!raw || typeof raw !== 'object') throw new ProviderError('error');
    const article = raw as Record<string, unknown>;
    if (!boundedString(article.id, 200) || !boundedString(article.title, 500) ||
        !boundedString(article.source, 100) || !boundedString(article.rationale, 1000) ||
        !safeArticleUrl(article.url) || !validPublishedAt(article.publishedAt) || !isNewsArticle(article) ||
        Date.parse(article.publishedAt) > now.getTime() + 600_000 ||
        typeof article.sentiment !== 'string' || !['positive', 'negative', 'neutral', 'unclassified'].includes(article.sentiment)) {
      throw new ProviderError('error');
    }
    if (seenIds.has(article.id) || seenUrls.has(article.url)) continue;
    seenIds.add(article.id);
    seenUrls.add(article.url);
    articles.push({
      id: article.id, title: article.title.trim(), source: article.source.trim(),
      publishedAt: article.publishedAt, url: article.url,
      sentiment: article.sentiment as NewsArticle['sentiment'], rationale: article.rationale.trim(),
      ...(article.language === undefined ? {} : { language: article.language }),
      ...(article.sentimentScore === undefined ? {} : { sentimentScore: article.sentimentScore }),
      ...(article.classificationMethod === undefined ? {} : { classificationMethod: article.classificationMethod }),
      ...(article.providerEntity === undefined ? {} : { providerEntity: {
        symbol: article.providerEntity.symbol, name: article.providerEntity.name,
        exchange: article.providerEntity.exchange, country: article.providerEntity.country,
      } }),
    });
  }
  return { provider: payload.provider.trim(), articles: articles.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)) };
}

export async function boundedJson(response: Response): Promise<unknown> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_BYTES) throw new ProviderError('error');
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json') || !response.body) throw new ProviderError('error');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_BYTES) throw new ProviderError('error');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const data = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(data));
}

export function createGatewayProvider(
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = globalThis.fetch,
): NewsProvider {
  return {
    name: '사용자 뉴스 게이트웨이',
    setupMessage: '서버에 NEWS_PROVIDER_URL과 NEWS_API_KEY를 설정한 뒤 API 서버를 재시작해 주세요.',
    async getArticles(company, now) {
      const endpoint = env.NEWS_PROVIDER_URL?.trim();
      const apiKey = env.NEWS_API_KEY?.trim();
      if (!endpoint || !apiKey) throw new ProviderError('not_configured');
      let url: URL;
      try { url = new URL(endpoint); } catch { throw new ProviderError('error'); }
      if (url.protocol !== 'https:' || url.username || url.password) throw new ProviderError('error');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetcher(url, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ company, since: new Date(now.getTime() - 7 * 86400000).toISOString(), until: now.toISOString() }),
        });
        if (response.status === 429) throw new ProviderError('rate_limited');
        if (!response.ok) throw new ProviderError('error');
        return parseProviderResponse(await boundedJson(response), company, now);
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError('error');
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
