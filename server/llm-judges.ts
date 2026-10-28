import { createCloudflareJudge } from './llm-cloudflare.js';
import { createGeminiJudge } from './llm-gemini.js';
import type { LlmJudge } from './llm.js';

const KNOWN = ['gemini', 'cloudflare'] as const;

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
): LlmJudge[] {
  const requested = (env.LLM_PROVIDERS?.trim() || KNOWN.join(',')).toLowerCase().split(',').map(item => item.trim()).filter(Boolean);
  const wanted = KNOWN.filter(id => requested.includes(id));
  const judges = wanted.map(id => id === 'gemini' ? createGeminiJudge(env, fetcher, clock) : createCloudflareJudge(env, fetcher, clock));
  return judges.some(judge => judge.unavailable()?.code !== 'not_configured') ? judges : [];
}
