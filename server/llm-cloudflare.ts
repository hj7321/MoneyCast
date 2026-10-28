import { boundedJson } from './provider.js';
import { judgeWith, LlmError, parseModelJson, type LlmClient, type LlmJudge } from './llm.js';

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

const codeList = (codes: number[]) => codes.length ? ` (code ${codes.join(', ')})` : '';

/** Older models answer in `result.response`; newer ones use the chat-completion shape. */
function resultText(payload: unknown): string {
  if (!isRecord(payload) || payload.success !== true || !isRecord(payload.result)) {
    console.warn(`Cloudflare answer rejected: request not successful${codeList(errorCodes(payload))}`);
    throw new LlmError('error');
  }
  const result = payload.result;
  if (typeof result.response === 'string') return result.response;
  if (isRecord(result.response)) return JSON.stringify(result.response);
  const choice = Array.isArray(result.choices) ? result.choices[0] : undefined;
  if (isRecord(choice) && isRecord(choice.message) && typeof choice.message.content === 'string') return choice.message.content;
  console.warn('Cloudflare answer had no text');
  throw new LlmError('error');
}

/**
 * Workers AI REST API on the Free plan: over the allocation it fails instead of
 * billing. Failures log only status and error code numbers, never bodies or the token.
 */
export function createCloudflareClient(
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = globalThis.fetch,
  clock: () => number = Date.now,
): LlmClient {
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
    async generate(prompt, signal) {
      if (!configured || !account || !token) throw new LlmError('not_configured');
      if (blockedUntil > clock()) throw new LlmError('rate_limited', blockedUntil - clock());
      let response: Response;
      try {
        response = await fetcher(new URL(`/client/v4/accounts/${account}/ai/run/${model}`, API), {
          method: 'POST', redirect: 'error', signal,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            messages: [
              { role: 'system', content: prompt.system },
              // Qwen3 reasons before answering unless told not to; the answer is short structured data.
              { role: 'user', content: /^@cf\/qwen\/qwen3/i.test(model) ? `${prompt.user}\n/no_think` : prompt.user },
            ],
            max_tokens: prompt.maxOutputTokens ?? 4096, temperature: 0,
            ...(JSON_MODE.has(model) ? { response_format: { type: 'json_schema', json_schema: prompt.schema } } : {}),
          }),
        });
      } catch {
        console.warn(`Cloudflare request failed: ${signal.aborted ? 'timeout' : 'network error'}`);
        throw new LlmError(signal.aborted ? 'timeout' : 'error');
      }
      try {
        if (response.status === 429) {
          const codes = errorCodes(await boundedJson(response).catch(() => null));
          const until = codes.includes(DAILY_ALLOCATION_USED) ? nextUtcMidnight(clock()) : clock() + 60_000;
          blockedUntil = Math.max(blockedUntil, until);
          console.warn(`Cloudflare request failed: HTTP 429${codeList(codes)}, paused until ${new Date(until).toISOString()}`);
          throw new LlmError('rate_limited', until - clock());
        }
        if (!response.ok) {
          console.warn(`Cloudflare request failed: HTTP ${response.status}${codeList(errorCodes(await boundedJson(response).catch(() => null)))}`);
          throw new LlmError('error');
        }
        const payload = await boundedJson(response);
        if (JSON.stringify(payload).includes(token)) {
          console.warn('Cloudflare response discarded: it echoed request credentials');
          throw new LlmError('error');
        }
        const text = resultText(payload);
        try {
          return parseModelJson(text);
        } catch (error) {
          console.warn('Cloudflare answer was not valid JSON');
          throw error;
        }
      } catch (error) {
        if (error instanceof LlmError) throw error;
        console.warn(`Cloudflare response could not be read${signal.aborted ? ' before the deadline' : ''}`);
        throw new LlmError(signal.aborted ? 'timeout' : 'error');
      } finally {
        await response.body?.cancel().catch(() => undefined);
      }
    },
  };
}

export function createCloudflareJudge(
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = globalThis.fetch,
  clock: () => number = Date.now,
): LlmJudge {
  return judgeWith(createCloudflareClient(env, fetcher, clock));
}
