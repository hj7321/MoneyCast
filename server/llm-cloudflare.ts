import { boundedJson } from './provider.js';
import { buildPrompt, judgementSchema, LlmError, parseModelJson, type LlmJudge } from './llm.js';

const API = 'https://api.cloudflare.com';
/** Low Neuron cost and a different model family from Gemini; CLOUDFLARE_AI_MODEL overrides it. */
export const DEFAULT_CLOUDFLARE_MODEL = '@cf/qwen/qwen3-30b-a3b-fp8';
const MODEL = /^@(cf|hf)\/[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i;
const ACCOUNT = /^[a-f0-9]{32}$/i;
/** Models documented to accept a JSON schema; the others are asked for JSON and validated the same way. */
const JSON_MODE = new Set([
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/meta/llama-3-8b-instruct', '@cf/meta/llama-3.1-8b-instruct',
  '@hf/nousresearch/hermes-2-pro-mistral-7b', '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
]);
/** "You have used up your daily free allocation of 10,000 neurons." */
const DAILY_ALLOCATION_USED = 3036;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorCodes(payload: unknown): number[] {
  return isRecord(payload) && Array.isArray(payload.errors)
    ? payload.errors.flatMap(item => isRecord(item) && typeof item.code === 'number' ? [item.code] : []) : [];
}

/** The free allocation resets at 00:00 UTC. */
function nextUtcMidnight(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

/** Older models answer in `result.response`; newer ones use the chat-completion shape. */
function resultText(payload: unknown): string {
  if (!isRecord(payload) || payload.success !== true || !isRecord(payload.result)) throw new LlmError('error');
  const result = payload.result;
  if (typeof result.response === 'string') return result.response;
  if (isRecord(result.response)) return JSON.stringify(result.response);
  const choice = Array.isArray(result.choices) ? result.choices[0] : undefined;
  if (isRecord(choice) && isRecord(choice.message) && typeof choice.message.content === 'string') return choice.message.content;
  throw new LlmError('error');
}

/** Workers AI REST API on the Free plan: over the allocation it fails instead of billing. */
export function createCloudflareJudge(
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = globalThis.fetch,
  clock: () => number = Date.now,
): LlmJudge {
  const account = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const token = env.CLOUDFLARE_API_TOKEN?.trim();
  const model = env.CLOUDFLARE_AI_MODEL?.trim() || DEFAULT_CLOUDFLARE_MODEL;
  const configured = !!account && !!token && ACCOUNT.test(account) && MODEL.test(model);
  let blockedUntil = 0;
  return {
    id: 'cloudflare', label: 'Cloudflare', model: MODEL.test(model) ? model : DEFAULT_CLOUDFLARE_MODEL,
    unavailable() {
      if (!configured) return { code: 'not_configured' };
      return blockedUntil > clock() ? { code: 'rate_limited', retryAt: blockedUntil } : null;
    },
    async judge(request, signal) {
      if (!configured || !account || !token) throw new LlmError('not_configured');
      if (blockedUntil > clock()) throw new LlmError('rate_limited', blockedUntil - clock());
      const { system, user } = buildPrompt(request);
      let response: Response;
      try {
        response = await fetcher(new URL(`/client/v4/accounts/${account}/ai/run/${model}`, API), {
          method: 'POST', redirect: 'error', signal,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            messages: [
              { role: 'system', content: system },
              // Qwen3 reasons before answering unless told not to; the answer is short structured data.
              { role: 'user', content: /^@cf\/qwen\/qwen3/i.test(model) ? `${user}\n/no_think` : user },
            ],
            max_tokens: 4096, temperature: 0,
            ...(JSON_MODE.has(model) ? { response_format: { type: 'json_schema', json_schema: judgementSchema(request) } } : {}),
          }),
        });
      } catch {
        throw new LlmError(signal.aborted ? 'timeout' : 'error');
      }
      try {
        if (response.status === 429) {
          const codes = errorCodes(await boundedJson(response).catch(() => null));
          const until = codes.includes(DAILY_ALLOCATION_USED) ? nextUtcMidnight(clock()) : clock() + 60_000;
          blockedUntil = Math.max(blockedUntil, until);
          throw new LlmError('rate_limited', until - clock());
        }
        if (!response.ok) throw new LlmError('error');
        const payload = await boundedJson(response);
        if (JSON.stringify(payload).includes(token)) throw new LlmError('error');
        return parseModelJson(resultText(payload));
      } catch (error) {
        if (error instanceof LlmError) throw error;
        throw new LlmError(signal.aborted ? 'timeout' : 'error');
      } finally {
        await response.body?.cancel().catch(() => undefined);
      }
    },
  };
}
