import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { companies, searchCompanies, NEWS_CACHE_TTL_MS, type NewsAnalysis } from '../packages/core/src/index.js';
import { createNewsProvider } from './news-provider.js';
import { createNewsService } from './service.js';
import { DEFAULT_STATIC_DIRECTORY, serveWeb } from './static.js';

type NewsService = ReturnType<typeof createNewsService>;

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
  if (!['ready', 'insufficient'].includes(analysis.status) || !analysis.cachedUntil) return 'no-store';
  const asOf = Date.parse(analysis.asOf);
  const expiresAt = Math.min(Date.parse(analysis.cachedUntil), asOf + NEWS_CACHE_TTL_MS);
  if (!Number.isFinite(asOf) || !Number.isFinite(expiresAt) || asOf > now + 60_000) return 'no-store';
  const seconds = Math.min(NEWS_CACHE_TTL_MS / 1000, Math.floor((expiresAt - now) / 1000));
  return seconds > 0 ? `public, s-maxage=${seconds}` : 'no-store';
}

export function createRequestHandler(service: NewsService = createNewsService(createNewsProvider()),
  options: { staticDirectory?: string | null; clock?: () => number } = {}) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const url = new URL(request.url || '/', 'http://localhost');
      if (!url.pathname.startsWith('/api/') && url.pathname !== '/api') {
        const directory = options.staticDirectory === undefined ? DEFAULT_STATIC_DIRECTORY : options.staticDirectory;
        if (directory) return await serveWeb(request, response, url, directory);
        return send(response, 404, { error: '요청한 파일을 찾을 수 없습니다.' });
      }
      if (request.method !== 'GET') return send(response, 405, { error: 'GET 요청만 지원합니다.' });
      if (url.pathname === '/api/health') return send(response, 200, { status: 'ok', service: 'MoneyCast API' });
      if (url.pathname === '/api/companies') {
        const query = url.searchParams.get('q') || '';
        if (query.length > 100) return send(response, 400, { error: '검색어는 100자 이내로 입력해 주세요.' });
        return send(response, 200, { companies: searchCompanies(query) });
      }
      if (url.pathname === '/api/news') {
        const id = url.searchParams.get('companyId');
        const company = companies.find(item => item.id === id);
        if (!company) return send(response, 400, { error: '검색 결과에서 회사와 거래소를 선택해 주세요.' });
        const analysis = await service.getAnalysis(company);
        return send(response, 200, analysis, newsCdnCacheControl(analysis, options.clock?.() ?? Date.now()));
      }
      return send(response, 404, { error: '요청한 API를 찾을 수 없습니다.' });
    } catch {
      if (response.headersSent) { response.destroy(); return; }
      return send(response, 500, { error: '요청 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
    }
  };
}

export function createApp(service: NewsService = createNewsService(createNewsProvider()),
  options: { staticDirectory?: string | null; clock?: () => number } = {}) {
  return createServer(createRequestHandler(service, options));
}
