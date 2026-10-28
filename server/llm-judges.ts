import type { AiProviderId } from '../packages/core/src/index.js';
import { createCloudflareClient } from './llm-cloudflare.js';
import { createGeminiClient } from './llm-gemini.js';
import { judgeWith, type LlmClient, type LlmJudge } from './llm.js';

const KNOWN = ['gemini', 'cloudflare'] as const;

/** One client per model; news and goal features share them so a quota pause applies to both. */
export function createLlmClients(
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = globalThis.fetch,
  clock: () => number = Date.now,
): Record<AiProviderId, LlmClient> {
  return { gemini: createGeminiClient(env, fetcher, clock), cloudflare: createCloudflareClient(env, fetcher, clock) };
}

/**
 * Both models by default; LLM_PROVIDERS can switch one off. Without any key
 * there are no judges at all and articles keep their source labels. A model
 * that is wanted but missing its keys still reports "not configured", because
 * agreement needs both.
 */
export function createLlmJudges(
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = globalThis.fetch,
  clock: () => number = Date.now,
  clients: Record<AiProviderId, LlmClient> = createLlmClients(env, fetcher, clock),
): LlmJudge[] {
  const requested = (env.LLM_PROVIDERS?.trim() || KNOWN.join(',')).toLowerCase().split(',').map(item => item.trim()).filter(Boolean);
  const wanted = KNOWN.filter(id => requested.includes(id));
  const judges = wanted.map(id => judgeWith(clients[id]));
  return judges.some(judge => judge.unavailable()?.code !== 'not_configured') ? judges : [];
}
