import { boundedJson } from './provider.js';
import { buildPrompt, judgementSchema, LlmError, parseModelJson, type LlmJudge } from './llm.js';

const API = 'https://generativelanguage.googleapis.com';
/** Free-tier model with minimal thinking by default; GEMINI_MODEL overrides it. */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';
const MODEL = /^[a-z0-9][a-z0-9.-]{1,63}$/;
const DEFAULT_COOLDOWN_MS = 15 * 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Gemini's response schema is an OpenAPI subset with upper-case type names. */
export function toGeminiSchema(schema: unknown): unknown {
  if (!isRecord(schema)) return schema;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'type' && typeof value === 'string') result.type = value.toUpperCase();
    else if (key === 'properties' && isRecord(value)) {
      result.properties = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, toGeminiSchema(child)]));
      result.propertyOrdering = Object.keys(value);
    } else if (key === 'items') result.items = toGeminiSchema(value);
    else result[key] = value;
  }
  if (Array.isArray(schema.enum)) result.format = 'enum';
  return result;
}

/** `error.details[].retryDelay` such as "17s", when Google supplies one. */
function retryDelayMs(payload: unknown): number | undefined {
  const details = isRecord(payload) && isRecord(payload.error) && Array.isArray(payload.error.details) ? payload.error.details : [];
  for (const detail of details) {
    const match = isRecord(detail) && typeof detail.retryDelay === 'string' ? /^(\d+(?:\.\d+)?)s$/.exec(detail.retryDelay) : null;
    if (match) return Number(match[1]) * 1000;
  }
  return undefined;
}

function candidateText(payload: unknown): string {
  const candidate = isRecord(payload) && Array.isArray(payload.candidates) ? payload.candidates[0] : undefined;
  // Any stop other than a natural one (length, safety, recitation) can leave the JSON incomplete.
  if (!isRecord(candidate) || (candidate.finishReason !== undefined && candidate.finishReason !== 'STOP') ||
      !isRecord(candidate.content) || !Array.isArray(candidate.content.parts)) throw new LlmError('error');
  const text = candidate.content.parts
    .filter((part): part is { text: string } => isRecord(part) && typeof part.text === 'string' && part.thought !== true)
    .map(part => part.text).join('');
  if (!text) throw new LlmError('error');
  return text;
}

/** Gemini API with a server-side key in a header; never in a URL or a response. */
export function createGeminiJudge(
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = globalThis.fetch,
  clock: () => number = Date.now,
): LlmJudge {
  const key = env.GEMINI_API_KEY?.trim();
  const model = env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
  const configured = !!key && MODEL.test(model);
  let blockedUntil = 0;
  return {
    id: 'gemini', label: 'Gemini', model: MODEL.test(model) ? model : DEFAULT_GEMINI_MODEL,
    unavailable() {
      if (!configured) return { code: 'not_configured' };
      return blockedUntil > clock() ? { code: 'rate_limited', retryAt: blockedUntil } : null;
    },
    async judge(request, signal) {
      if (!configured || !key) throw new LlmError('not_configured');
      if (blockedUntil > clock()) throw new LlmError('rate_limited', blockedUntil - clock());
      const { system, user } = buildPrompt(request);
      let response: Response;
      try {
        response = await fetcher(new URL(`/v1beta/models/${model}:generateContent`, API), {
          method: 'POST', redirect: 'error', signal,
          headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts: [{ text: user }] }],
            generationConfig: { responseMimeType: 'application/json', responseSchema: toGeminiSchema(judgementSchema(request)), maxOutputTokens: 8192 },
          }),
        });
      } catch {
        throw new LlmError(signal.aborted ? 'timeout' : 'error');
      }
      try {
        if (response.status === 429) {
          const delay = Math.min(3_600_000, Math.max(60_000, retryDelayMs(await boundedJson(response).catch(() => null)) ?? DEFAULT_COOLDOWN_MS));
          blockedUntil = Math.max(blockedUntil, clock() + delay);
          throw new LlmError('rate_limited', delay);
        }
        if (!response.ok) throw new LlmError('error');
        const payload = await boundedJson(response);
        // A malformed upstream answer must never carry the key any further.
        if (JSON.stringify(payload).includes(key)) throw new LlmError('error');
        return parseModelJson(candidateText(payload));
      } catch (error) {
        if (error instanceof LlmError) throw error;
        throw new LlmError(signal.aborted ? 'timeout' : 'error');
      } finally {
        await response.body?.cancel().catch(() => undefined);
      }
    },
  };
}
