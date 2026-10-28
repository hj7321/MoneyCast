import { createHash } from 'node:crypto';
import { COMPANY_NEWS_IDENTITY, matchesCompanyTitle, NEWS_CACHE_TTL_MS, type NewsArticle } from '../packages/core/src/index.js';
import { urlKey } from './aggregate.js';
import { boundedJson, parseProviderResponse, plainText, ProviderError, type NewsProvider, type NewsProviderResult } from './provider.js';

const API = 'https://api.gdeltproject.org/api/v2/doc/doc';
const DAY = 86_400_000;
// GDELT asks clients to send at most one request every five seconds.
const REQUEST_INTERVAL_MS = 5_000;
const COOLDOWN_MS = 60_000;
const TIMEOUT_MS = 8_000;
const MAX_ROWS = 50;
const MAX_ARTICLES = 15;
const LANGUAGES: Record<string, string> = {
  english: 'en', korean: 'ko', japanese: 'ja', chinese: 'zh', spanish: 'es', french: 'fr', german: 'de',
  italian: 'it', portuguese: 'pt', russian: 'ru', arabic: 'ar', hindi: 'hi', vietnamese: 'vi',
  indonesian: 'id', turkish: 'tr', dutch: 'nl', thai: 'th', polish: 'pl',
};
export const GDELT_NOTES = [
  'GDELT 기사 목록은 GDELT Project(https://www.gdeltproject.org) 검색 결과를 포함합니다. GDELT 검색은 영어 기계 번역 기준이며 제목에 회사명이 있는 기사만 남깁니다.',
  'GDELT 시각은 GDELT가 기사를 처음 확인한 시각으로, 게시 시각과 다를 수 있습니다. GDELT 기사에는 기사별 감성 점수가 없습니다.',
];

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const gdeltTime = (date: Date) => date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
function safeHttps(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** GDELT seendate (YYYYMMDDTHHMMSSZ) as an ISO timestamp, or null when malformed. */
export function parseSeenDate(value: unknown): string | null {
  const match = typeof value === 'string' ? /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value) : null;
  if (!match) return null;
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
  const time = Date.parse(iso);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === iso.slice(0, 19) ? iso : null;
}

async function boundedText(response: Response, max = 2048): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  let text = '';
  try {
    while (text.length < max) {
      const part = await reader.read();
      if (part.done) break;
      text += new TextDecoder().decode(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text.slice(0, max);
}

/** GDELT DOC 2.0 article list: titles, links and first-seen times only; no key and no sentiment. */
export function createGdeltProvider(
  fetcher: typeof fetch = globalThis.fetch,
  clock: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): NewsProvider {
  let nextRequestAt = 0;
  let blockedUntil = 0;
  return {
    name: 'GDELT', cacheTtlMs: NEWS_CACHE_TTL_MS,
    async getArticles(company, now): Promise<NewsProviderResult> {
      const identity = COMPANY_NEWS_IDENTITY[company.id];
      if (!identity) throw new ProviderError('error', 'identity_unverified');
      if (blockedUntil > clock()) throw new ProviderError('rate_limited', undefined, blockedUntil - clock());
      // Requests wait their turn within this process; a long queue skips GDELT for this refresh.
      const wait = nextRequestAt - clock();
      if (wait > REQUEST_INTERVAL_MS) throw new ProviderError('rate_limited', undefined, wait);
      nextRequestAt = Math.max(clock(), nextRequestAt) + REQUEST_INTERVAL_MS;
      if (wait > 0) await sleep(wait);
      const url = new URL(API);
      for (const [key, value] of Object.entries({
        query: identity.searchQuery, mode: 'artlist', format: 'json', maxrecords: String(MAX_ROWS), sort: 'datedesc',
        startdatetime: gdeltTime(new Date(now.getTime() - 7 * DAY)), enddatetime: gdeltTime(now),
      })) url.searchParams.set(key, value);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
      let payload: unknown;
      try {
        const response = await fetcher(url, { method: 'GET', redirect: 'error', signal: controller.signal, headers: { Accept: 'application/json' } });
        if (response.status === 429) {
          blockedUntil = clock() + COOLDOWN_MS;
          throw new ProviderError('rate_limited', undefined, COOLDOWN_MS);
        }
        if (!response.ok) throw new ProviderError('error');
        if (!response.headers.get('content-type')?.toLowerCase().includes('json')) {
          // Throttling and query errors arrive as short plain-text bodies.
          if (/limit requests/i.test(await boundedText(response))) {
            blockedUntil = clock() + COOLDOWN_MS;
            throw new ProviderError('rate_limited', undefined, COOLDOWN_MS);
          }
          throw new ProviderError('error');
        }
        // Re-labelled so boundedJson's size limit also covers variants such as text/json.
        payload = await boundedJson(new Response(response.body, { headers: { 'content-type': 'application/json' } }));
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError('error');
      } finally {
        clearTimeout(timeout);
      }
      if (!record(payload)) throw new ProviderError('error');
      const rows = payload.articles === undefined ? [] : payload.articles;
      if (!Array.isArray(rows) || rows.length > 250) throw new ProviderError('error');
      const articles: NewsArticle[] = [];
      let insecure = 0;
      let unmatched = 0;
      for (const row of rows) {
        if (!record(row)) continue;
        const title = plainText(row.title, 500);
        const source = plainText(row.domain, 100);
        const seenAt = parseSeenDate(row.seendate);
        if (!title || !source || !seenAt || typeof row.url !== 'string' || row.url.length > 2048) continue;
        if (!safeHttps(row.url)) { insecure += 1; continue; }
        if (!matchesCompanyTitle(company.id, title)) { unmatched += 1; continue; }
        const seen = Date.parse(seenAt);
        if (seen < now.getTime() - 7 * DAY || seen > now.getTime()) continue;
        const language = typeof row.language === 'string' ? LANGUAGES[row.language.toLowerCase()] : undefined;
        const rationaleLines = [
          'GDELT 검색 결과라 기사별 감성 점수가 없어 미분류로 표시합니다.',
          '기업명이 제목에 있어 포함했으며, 종목·거래소는 확인되지 않았습니다.',
          '긍정·부정 요인 집계에서 제외합니다.',
        ];
        articles.push({
          id: `gdelt-${createHash('sha256').update(urlKey(row.url)).digest('hex').slice(0, 24)}`,
          title, source, publishedAt: seenAt, url: row.url, sentiment: 'unclassified', classificationMethod: 'unavailable',
          rationale: rationaleLines.join(' '), rationaleLines,
          sourceProvider: 'GDELT', timeKind: 'seen', identity: 'name_match', ...(language ? { language } : {}),
        });
        if (articles.length >= MAX_ARTICLES) break;
      }
      const validated = parseProviderResponse({ companyId: company.id, provider: 'GDELT', articles }, company, now);
      const notes = [...GDELT_NOTES];
      if (insecure) notes.push(`보안 연결(https)이 아닌 GDELT 기사 ${insecure}건은 표시하지 않았습니다.`);
      if (unmatched) notes.push(`제목에 회사명이 없거나 다른 회사로 보이는 GDELT 기사 ${unmatched}건을 제외했습니다.`);
      return { ...validated, notes };
    },
  };
}
