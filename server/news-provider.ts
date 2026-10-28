import { createGatewayProvider, ProviderError, type NewsProvider } from './provider.js';
import { createMarketauxProvider } from './marketaux.js';
import { createGdeltProvider } from './gdelt.js';
import { createMultiSourceProvider } from './aggregate.js';

const SOURCE_LABELS: Record<string, string> = { marketaux: 'Marketaux', gdelt: 'GDELT' };

function configurationError(): NewsProvider {
  return { name: '설정 오류', getArticles: async () => { throw new ProviderError('error'); } };
}

/**
 * The user gateway stays exclusive. Otherwise the sources in NEWS_SOURCES
 * (default: Marketaux and GDELT) are queried together; each article keeps
 * the source that delivered it, so nothing is silently substituted.
 */
export function createNewsProvider(env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = globalThis.fetch): NewsProvider {
  const mode = env.NEWS_PROVIDER?.trim().toLowerCase() || 'auto';
  if (mode === 'gateway' || mode === 'auto' && env.NEWS_PROVIDER_URL?.trim()) return createGatewayProvider(env, fetcher);
  if (mode !== 'marketaux' && mode !== 'auto') return configurationError();
  const requested = [...new Set((env.NEWS_SOURCES?.trim() || 'marketaux,gdelt').toLowerCase().split(',').map(id => id.trim()).filter(Boolean))];
  if (!requested.length || requested.some(id => !SOURCE_LABELS[id])) return configurationError();
  const entries = requested.map(id => ({
    id, label: SOURCE_LABELS[id]!,
    provider: id === 'marketaux' ? createMarketauxProvider(env, fetcher) : createGdeltProvider(fetcher),
  }));
  return entries.length === 1 ? entries[0]!.provider : createMultiSourceProvider(entries);
}
