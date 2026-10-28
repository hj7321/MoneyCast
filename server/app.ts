import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { companies, searchCompanies, NEWS_CACHE_TTL_MS, type NewsAnalysis } from '../packages/core/src/index.js';
import { collectNews } from './collect.js';
import { createGoalClarifier, type GoalClarifier } from './goal-clarify.js';
import { createAiClassifier } from './llm.js';
import { createLlmClients, createLlmJudges } from './llm-judges.js';
import { createNewsProvider } from './news-provider.js';
import { createNewsService } from './service.js';
import { createBlobSnapshotStore } from './snapshot-store.js';
import { DEFAULT_STATIC_DIRECTORY, serveWeb } from './static.js';

type NewsService = ReturnType<typeof createNewsService>;
interface HandlerOptions {
  staticDirectory?: string | null; clock?: () => number; env?: NodeJS.ProcessEnv;
  /** Defaults to the models named in GOAL_AI_PROVIDERS, sharing the news service's clients when both are defaults. */
  goals?: GoalClarifier;
}

/** A goal description is short; anything larger is refused before it is read. */
export const GOAL_BODY_LIMIT_BYTES = 2_048;
const GOAL_REQUESTS_PER_WINDOW = 5;
const GOAL_WINDOW_MS = 10 * 60_000;

/**
 * Production wiring: configured sources, snapshots when a Blob store is
 * connected, and models when keys exist. The news check and goal
 * clarification share one client per model, so a quota pause holds for both.
 */
export function createDefaultServices(env: NodeJS.ProcessEnv = process.env): { news: NewsService; goals: GoalClarifier } {
  const clients = createLlmClients(env);
  return {
    news: createNewsService(createNewsProvider(env), undefined, {
      store: createBlobSnapshotStore(env), classifier: createAiClassifier(createLlmJudges(env, undefined, undefined, clients)),
    }),
    goals: createGoalClarifier(clients, env),
  };
}

export function createDefaultNewsService(env: NodeJS.ProcessEnv = process.env): NewsService {
  return createDefaultServices(env).news;
}

/** Requests per client address within a sliding window, kept in this instance's memory only. */
function createRequestLimiter(clock: () => number) {
  const hits = new Map<string, number[]>();
  return (key: string): number | null => {
    const now = clock();
    const recent = (hits.get(key) ?? []).filter(time => time > now - GOAL_WINDOW_MS);
    if (recent.length >= GOAL_REQUESTS_PER_WINDOW) {
      hits.set(key, recent);
      return recent[0]! + GOAL_WINDOW_MS;
    }
    hits.set(key, [...recent, now]);
    if (hits.size > 1_000) for (const [address, times] of hits) if (times.every(time => time <= now - GOAL_WINDOW_MS)) hits.delete(address);
    return null;
  };
}

function clientAddress(request: IncomingMessage): string {
  const real = request.headers['x-real-ip'];
  const forwarded = request.headers['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  return (typeof real === 'string' && real.trim()) || first || request.socket.remoteAddress || 'unknown';
}

/** JSON only, within the byte limit; the body is never logged. */
async function readJsonBody(request: IncomingMessage): Promise<{ value: unknown } | { status: 400 | 413 | 415 }> {
  if (!/^application\/json\b/i.test(request.headers['content-type'] ?? '')) return { status: 415 };
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > GOAL_BODY_LIMIT_BYTES) {
    request.resume();
    return { status: 413 };
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > GOAL_BODY_LIMIT_BYTES) {
      request.resume();
      return { status: 413 };
    }
    chunks.push(chunk as Buffer);
  }
  try {
    return { value: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  } catch {
    return { status: 400 };
  }
}

/** Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`; compared in constant time. */
function authorizedCron(header: string | undefined, secret: string): boolean {
  const expected = Buffer.from(`Bearer ${secret}`);
  const received = Buffer.from(header ?? '');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function send(response: ServerResponse, status: number, body: unknown, cdnCacheControl = 'no-store') {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'Vercel-CDN-Cache-Control': cdnCacheControl,
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  });
  response.end(JSON.stringify(body));
}

/** Public news may be shared at the edge, but its original expiry never moves. */
export function newsCdnCacheControl(analysis: NewsAnalysis, now: number = Date.now()): string {
  if (!['ready', 'insufficient'].includes(analysis.status) || !analysis.cachedUntil || analysis.servedFrom === 'stale') return 'no-store';
  const asOf = Date.parse(analysis.asOf);
  const expiresAt = Math.min(Date.parse(analysis.cachedUntil), asOf + NEWS_CACHE_TTL_MS);
  if (!Number.isFinite(asOf) || !Number.isFinite(expiresAt) || asOf > now + 60_000) return 'no-store';
  const seconds = Math.min(NEWS_CACHE_TTL_MS / 1000, Math.floor((expiresAt - now) / 1000));
  return seconds > 0 ? `public, s-maxage=${seconds}` : 'no-store';
}

export function createRequestHandler(service?: NewsService, options: HandlerOptions = {}) {
  const env = options.env ?? process.env;
  const defaults = service ? null : createDefaultServices(env);
  const news = service ?? defaults!.news;
  const goals = options.goals ?? defaults?.goals ?? createGoalClarifier(createLlmClients(env), env);
  const limited = createRequestLimiter(options.clock ?? Date.now);
  return async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const url = new URL(request.url || '/', 'http://localhost');
      if (!url.pathname.startsWith('/api/') && url.pathname !== '/api') {
        const directory = options.staticDirectory === undefined ? DEFAULT_STATIC_DIRECTORY : options.staticDirectory;
        if (directory) return await serveWeb(request, response, url, directory);
        return send(response, 404, { error: '요청한 파일을 찾을 수 없습니다.' });
      }
      if (url.pathname === '/api/goals/clarify') {
        if (request.method === 'GET') return send(response, 200, goals.availability());
        if (request.method !== 'POST') return send(response, 405, { error: 'GET 또는 POST 요청만 지원합니다.' });
        const body = await readJsonBody(request);
        if ('status' in body) {
          return send(response, body.status, { error: body.status === 413 ? '설명이 너무 깁니다.' : body.status === 415 ? 'JSON 요청만 지원합니다.' : '요청 형식이 올바르지 않습니다.' });
        }
        if (typeof body.value !== 'object' || body.value === null || typeof (body.value as { text?: unknown }).text !== 'string') {
          return send(response, 400, { error: '설명(text)을 문자열로 보내 주세요.' });
        }
        const retryAt = limited(clientAddress(request));
        if (retryAt !== null) {
          return send(response, 429, { status: 'rate_limited', promptVersion: goals.availability().promptVersion,
            retryAt: new Date(retryAt).toISOString(), message: '요청이 많아요. 잠시 후 다시 시도해 주세요.' });
        }
        return send(response, 200, await goals.clarify((body.value as { text: string }).text));
      }
      if (request.method !== 'GET') return send(response, 405, { error: 'GET 요청만 지원합니다.' });
      if (url.pathname === '/api/health') return send(response, 200, { status: 'ok', service: 'MoneyCast API' });
      if (url.pathname === '/api/companies') {
        const query = url.searchParams.get('q') || '';
        if (query.length > 100) return send(response, 400, { error: '검색어는 100자 이내로 입력해 주세요.' });
        return send(response, 200, { companies: searchCompanies(query) });
      }
      if (url.pathname === '/api/cron/collect') {
        const secret = env.CRON_SECRET?.trim();
        if (!secret) return send(response, 503, { error: '예약 수집이 설정되지 않았습니다.' });
        if (!authorizedCron(request.headers.authorization, secret)) return send(response, 401, { error: '인증되지 않은 요청입니다.' });
        return send(response, 200, await collectNews(news, companies));
      }
      if (url.pathname === '/api/news') {
        const id = url.searchParams.get('companyId');
        const company = companies.find(item => item.id === id);
        if (!company) return send(response, 400, { error: '검색 결과에서 회사와 거래소를 선택해 주세요.' });
        const analysis = await news.getAnalysis(company);
        return send(response, 200, analysis, newsCdnCacheControl(analysis, options.clock?.() ?? Date.now()));
      }
      return send(response, 404, { error: '요청한 API를 찾을 수 없습니다.' });
    } catch {
      if (response.headersSent) { response.destroy(); return; }
      return send(response, 500, { error: '요청 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
    }
  };
}

export function createApp(service?: NewsService, options: HandlerOptions = {}) {
  return createServer(createRequestHandler(service, options));
}
