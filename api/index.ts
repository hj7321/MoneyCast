import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequestHandler } from '../server/app.js';

const ROUTE_PARAMETER = '__moneycast_route';
const ROUTES = new Set(['health', 'companies', 'news', 'cron/collect']);

/** Shared by the Vercel Node runtime and HTTP integration tests; never listens. */
export function createApiHandler(service?: Parameters<typeof createRequestHandler>[0], env?: NodeJS.ProcessEnv) {
  const handle = createRequestHandler(service, { staticDirectory: null, env });
  return async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url || '/', 'http://localhost');
    // Vercel may preserve the public URL or present the rewritten function URL.
    // In the first case the original path is authoritative, never a query value.
    if (url.pathname === '/api/index' || url.pathname === '/api/index.ts' || url.pathname === '/api/index.js') {
      const route = url.searchParams.getAll(ROUTE_PARAMETER);
      url.pathname = route.length === 1 && ROUTES.has(route[0]!) ? `/api/${route[0]}` : '/api/not-found';
    }
    url.searchParams.delete(ROUTE_PARAMETER);
    request.url = `${url.pathname}${url.search}`;
    return handle(request, response);
  };
}

export default createApiHandler();
