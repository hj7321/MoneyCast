import { NEWS_CACHE_TTL_MS, type Company, type NewsArticle } from '../packages/core/src/index.js';
import { boundedJson, parseProviderResponse, ProviderError, type NewsProvider, type NewsProviderResult } from './provider.js';

const API = 'https://api.marketaux.com';
const DAY = 86_400_000;
const ENTITY_TTL = 6 * 3_600_000;
const NAMES: Record<string, string[]> = {
  'krx:005930': ['삼성전자', 'Samsung Electronics'],
  'krx:000660': ['SK하이닉스', '에스케이하이닉스', 'SK Hynix'],
  'krx:035420': ['NAVER', '네이버'],
  'krx:005380': ['현대자동차', 'Hyundai Motor'],
  'nasdaq:AAPL': ['Apple'],
  'nasdaq:NVDA': ['Nvidia'],
  'nasdaq:MSFT': ['Microsoft'],
  'nasdaq:TSLA': ['Tesla'],
};
const EXCHANGES: Record<string, Set<string>> = {
  NASDAQ: new Set(['NASDAQ', 'XNAS', 'NASDAQGS', 'NASDAQGM', 'NASDAQCM', 'NMS', 'NGM', 'NCM',
    'NASDAQGLOBALSELECTMARKET', 'NASDAQGLOBALMARKET', 'NASDAQCAPITALMARKET']),
  KOSPI: new Set(['KOSPI', 'KSC', 'KOE', 'KSE', 'KRX', 'XKRX', 'KOREAEXCHANGE', 'KOREASTOCKEXCHANGE',
    'KOREAEXCHANGEKOSPI', 'KOREAEXCHANGESTOCKMARKET', 'KOREAEXCHANGEKOSPIMARKET']),
};
const BASE_NOTES = [
  'Marketaux에서 최근 7일의 기사 최대 3건을 조회합니다. 전체 뉴스나 한국어 기사 제공 범위를 보장하지 않습니다.',
  '긍정·부정·중립은 Marketaux가 제공한 해당 기업의 감성 점수 분류입니다. 주가 변동 확률이나 독립적으로 검증한 예측 점수가 아닙니다.',
  '원문 언어를 그대로 표시하며 기사 본문을 수집하거나 자동 번역하지 않습니다.',
];

type Entity = { symbol: string; name: string; country: string; type: string; exchange: string | null; exchange_long: string | null; sentiment_score?: unknown };
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown, max = 200): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}
function normalName(value: string): string {
  let name = value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  let previous = '';
  while (name !== previous) {
    previous = name;
    name = name.replace(/(?:corporation|company|limited|corp|inc|ltd|co)$/, '');
  }
  return name;
}
function normalExchange(value: string): string { return value.toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function namedCompany(entity: Entity, company: Company): boolean {
  return (NAMES[company.id] ?? []).some(name => normalName(name) === normalName(entity.name));
}
function matchingExchange(entity: Entity, company: Company): boolean {
  const allowed = EXCHANGES[company.exchange];
  return !!allowed && [entity.exchange, entity.exchange_long].every(value => value === null || allowed.has(normalExchange(value)));
}
function parseEntity(value: unknown): Entity | null {
  if (!record(value) || !text(value.symbol, 80) || !text(value.name) || !text(value.country, 20) || !text(value.type, 40) ||
      !(value.exchange === undefined || value.exchange === null || text(value.exchange, 100)) ||
      !(value.exchange_long === undefined || value.exchange_long === null || text(value.exchange_long, 200))) return null;
  return {
    symbol: value.symbol, name: value.name, country: value.country.toLowerCase(), type: value.type.toLowerCase(),
    exchange: typeof value.exchange === 'string' ? value.exchange : null,
    exchange_long: typeof value.exchange_long === 'string' ? value.exchange_long : null,
    sentiment_score: value.sentiment_score,
  };
}
function compatible(entity: Entity, company: Company): boolean {
  return entity.country === company.region.toLowerCase() && entity.type === 'equity' &&
    namedCompany(entity, company) && matchingExchange(entity, company);
}
function dataArray(value: unknown, maximum: number): unknown[] {
  if (!record(value) || !Array.isArray(value.data) || value.data.length > maximum || value.error !== undefined) throw new ProviderError('error');
  return value.data;
}

function cooldownMs(response: Response, instant: number): number {
  const fallback = response.status === 402 ? 15 * 60_000 : 60_000;
  const value = response.headers.get('retry-after');
  if (!value) return fallback;
  const seconds = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - instant;
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(DAY, Math.max(1000, seconds)) : fallback;
}

/** Official API metadata only. Tokens never leave this fixed server-side origin. */
export function createMarketauxProvider(
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = globalThis.fetch,
  clock: () => number = Date.now,
): NewsProvider {
  const entities = new Map<string, { expiresAt: number; entity: Entity | null }>();
  let blockedUntil = 0;
  function checkCooldown() {
    if (blockedUntil > clock()) throw new ProviderError('rate_limited', undefined, blockedUntil - clock());
  }
  async function request(path: '/v1/entity/search' | '/v1/news/all', params: Record<string, string>, token: string, signal: AbortSignal): Promise<unknown> {
    checkCooldown();
    if (signal.aborted) throw new ProviderError('error');
    const url = new URL(path, API);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set('api_token', token);
    const response = await fetcher(url, { method: 'GET', redirect: 'error', signal, headers: { Accept: 'application/json' } });
    if (response.status === 402 || response.status === 429) {
      const delay = cooldownMs(response, clock());
      blockedUntil = Math.max(blockedUntil, clock() + delay);
      throw new ProviderError('rate_limited', undefined, delay);
    }
    if (response.status === 401) throw new ProviderError('error', 'invalid_key');
    if (response.status === 403) throw new ProviderError('error', 'access_denied');
    if (!response.ok) throw new ProviderError('error');
    const payload = await boundedJson(response);
    // A successful but malformed upstream response can echo request credentials.
    if (JSON.stringify(payload).includes(token)) throw new ProviderError('error');
    return payload;
  }
  async function resolve(company: Company, token: string, signal: AbortSignal): Promise<Entity> {
    if (!NAMES[company.id]) throw new ProviderError('error', 'identity_unverified');
    if (company.region === 'US') {
      return { symbol: company.symbol, name: NAMES[company.id]![0]!, country: 'us', type: 'equity', exchange: null, exchange_long: null };
    }
    if (company.region !== 'KR' || !/^\d{6}$/.test(company.symbol)) throw new ProviderError('error', 'identity_unverified');
    const cached = entities.get(company.id);
    if (cached && cached.expiresAt > clock()) {
      if (!cached.entity) throw new ProviderError('error', 'identity_unverified');
      return cached.entity;
    }
    const rows = dataArray(await request('/v1/entity/search', { search: company.symbol, countries: 'kr', types: 'equity' }, token, signal), 50);
    const matches = rows.map(parseEntity).filter((item): item is Entity => !!item &&
      /^(\d{6})(?:[.:-][a-zA-Z0-9]{1,12})?$/.exec(item.symbol)?.[1] === company.symbol && compatible(item, company));
    const unique = new Map(matches.map(item => [JSON.stringify([
      item.symbol, normalName(item.name), item.country, item.type,
      item.exchange === null ? null : normalExchange(item.exchange),
      item.exchange_long === null ? null : normalExchange(item.exchange_long),
    ]), item]));
    const entity = unique.size === 1 ? [...unique.values()][0]! : null;
    entities.set(company.id, { entity, expiresAt: clock() + ENTITY_TTL });
    if (!entity) throw new ProviderError('error', 'identity_unverified');
    return entity;
  }
  return {
    name: 'Marketaux', cacheTtlMs: NEWS_CACHE_TTL_MS,
    setupMessage: '서버의 .env에 MARKETAUX_API_TOKEN을 입력하고 API 서버를 재시작해 주세요. 키는 웹이나 모바일 앱에 입력하지 않습니다.',
    async getArticles(company, now): Promise<NewsProviderResult> {
      const token = env.MARKETAUX_API_TOKEN?.trim();
      if (!token) throw new ProviderError('not_configured');
      checkCooldown();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const entity = await resolve(company, token, controller.signal);
        const rows = dataArray(await request('/v1/news/all', {
          symbols: entity.symbol, countries: company.region.toLowerCase(), entity_types: 'equity',
          filter_entities: 'true', must_have_entities: 'true', group_similar: 'true', limit: '3',
          published_after: new Date(now.getTime() - 7 * DAY).toISOString().slice(0, 19),
          published_before: now.toISOString().slice(0, 19),
        }, token, controller.signal), 3);
        const articles: NewsArticle[] = [];
        let excluded = 0;
        let unknownExchange = false;
        for (const row of rows) {
          if (!record(row) || !Array.isArray(row.entities) || row.entities.length > 200) throw new ProviderError('error');
          const matching = row.entities.map(parseEntity).filter((item): item is Entity => !!item &&
            item.symbol === entity.symbol && compatible(item, company));
          // Multiple different records for the selected symbol are ambiguous, not averaged.
          if (matching.length !== 1) { excluded++; continue; }
          const match = matching[0]!;
          unknownExchange ||= match.exchange === null && match.exchange_long === null;
          if (!text(row.uuid) || !text(row.title, 500) || !text(row.source, 100) || !text(row.published_at, 60) || !text(row.url, 2048) ||
              !(row.language === undefined || row.language === null || typeof row.language === 'string' && /^[a-z]{2,3}(?:-[a-zA-Z]{2,8})?$/.test(row.language))) throw new ProviderError('error');
          const score = match.sentiment_score;
          if (score !== undefined && score !== null && (typeof score !== 'number' || !Number.isFinite(score) || score < -1 || score > 1)) throw new ProviderError('error');
          const scored = typeof score === 'number';
          const sentiment: NewsArticle['sentiment'] = !scored ? 'unclassified' : score > 0 ? 'positive' : score < 0 ? 'negative' : 'neutral';
          const rationale = scored
            ? `Marketaux가 ${company.name} 관련 문맥에 제공한 감성 점수 ${String(score)}를 ${sentiment === 'positive' ? '긍정' : sentiment === 'negative' ? '부정' : '중립'}으로 분류했습니다. 기사 분위기이며 주가 방향이나 확률을 뜻하지 않습니다.`
            : 'Marketaux가 이 기업의 감성 점수를 제공하지 않아 미분류로 표시하며 방향 근거 집계에서 제외합니다.';
          articles.push({
            id: row.uuid, title: row.title, source: row.source, publishedAt: row.published_at, url: row.url,
            sentiment, rationale, classificationMethod: scored ? 'provider' : 'unavailable',
            ...(scored ? { sentimentScore: score } : {}),
            ...(typeof row.language === 'string' ? { language: row.language } : {}),
            providerEntity: { symbol: match.symbol, name: match.name, country: match.country, exchange: match.exchange },
          });
        }
        const validated = parseProviderResponse({ companyId: company.id, provider: 'Marketaux', articles }, company, now);
        const fresh = validated.articles.filter(article => {
          const publishedAt = Date.parse(article.publishedAt);
          return publishedAt >= now.getTime() - 7 * DAY && publishedAt <= now.getTime();
        });
        excluded += validated.articles.length - fresh.length;
        const notes = [...BASE_NOTES];
        if (excluded) notes.push(`기업 식별이 일치하지 않거나 조회 기간 밖인 기사 ${excluded}건을 제외했습니다.`);
        if (unknownExchange) notes.push('일부 기사의 제공자 거래소 필드가 비어 있습니다. 해당 기업명·종목 코드·국가를 대조했으며 거래소 표기는 별도로 확인되지 않았습니다.');
        return { ...validated, articles: fresh, notes };
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        // fetch errors may contain the URL (and api_token); never propagate them.
        if (env.VERCEL) {
          const cause = error instanceof Error ? error.cause as { code?: unknown } | undefined : undefined;
          const code = typeof cause?.code === 'string' &&
            ['ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT'].includes(cause.code)
            ? cause.code : 'NETWORK_ERROR';
          console.warn('Marketaux transport failed', { timedOut: controller.signal.aborted, code });
        }
        throw new ProviderError('error');
      } finally { clearTimeout(timeout); }
    },
  };
}
