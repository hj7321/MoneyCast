import { createGatewayProvider, ProviderError, type NewsProvider } from './provider.js';
import { createMarketauxProvider } from './marketaux.js';

/** Explicit modes never silently fall back to another data source. */
export function createNewsProvider(env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = globalThis.fetch): NewsProvider {
  const mode = env.NEWS_PROVIDER?.trim().toLowerCase() || 'auto';
  if (mode === 'marketaux' || mode === 'auto' && !env.NEWS_PROVIDER_URL?.trim()) return createMarketauxProvider(env, fetcher);
  if (mode === 'gateway' || mode === 'auto') return createGatewayProvider(env, fetcher);
  return { name: '설정 오류', getArticles: async () => { throw new ProviderError('error'); } };
}
