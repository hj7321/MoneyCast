// Wire helpers shared by the price adapters (price-fsc.ts, price-massive.ts)
// and the one-off step-3 check tool (history-check.ts), which re-exports the
// ones its tests use. Invariants:
// - a key never leaves this module except inside the request it was built for:
//   the redactor knows every textual form a key can take on the wire, and a
//   response body that contains any of them is discarded unread;
// - a fetch error object is never read (it can carry the keyed request URL);
// - nothing here retries, follows a redirect or pages;
// - provider values are copied only as identifier-shaped tokens, never as free text.
// Every effect (fetcher, clock, sleep) is injected.

type Json = Record<string, unknown>;
export function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// ---------------------------------------------------------------- secrets

export function safeDecode(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

/** Every textual form a key can take on the wire or in an echo; forms under 8 characters are ignored. */
export function secretForms(keys: readonly (string | undefined)[]): string[] {
  const forms = new Set<string>();
  for (const raw of keys) {
    const key = raw?.trim();
    if (!key) continue;
    for (const base of new Set([key, safeDecode(key)])) {
      const encoded = encodeURIComponent(base);
      // URLSearchParams (how the Marketaux URL is built) also encodes !'()~ and sends spaces as '+'.
      const formEncoded = new URLSearchParams([['k', base]]).toString().slice(2);
      const lowerHex = (text: string) => text.replace(/%[0-9A-F]{2}/g, hex => hex.toLowerCase());
      for (const form of [base, encoded, formEncoded, safeDecode(base), lowerHex(encoded), lowerHex(formEncoded),
        encoded.replace(/%20/g, '+'), base.replace(/\//g, '\\/'), JSON.stringify(base).slice(1, -1)]) {
        if (form.length >= 8) forms.add(form);
      }
    }
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

export interface Redactor {
  (text: string): string;
  contains(text: string): boolean;
}

export function createRedactor(keys: readonly (string | undefined)[]): Redactor {
  const forms = secretForms(keys);
  const redact = ((text: string) => {
    let out = text;
    for (const form of forms) out = out.split(form).join('[REDACTED]');
    return out;
  }) as Redactor;
  redact.contains = (text: string) => forms.some(form => text.includes(form));
  return redact;
}

// ---------------------------------------------------------------- wire

/** The data.go.kr key as sent: an Encoding (percent-encoded) copy is decoded once, so it is encoded exactly once on the wire. */
export function fscWireKey(key: string): string {
  return /%[0-9A-Fa-f]{2}/.test(key) ? safeDecode(key) : key;
}

/** encodeURIComponent rather than URLSearchParams, which would send spaces as '+'. */
export function fscQuery(key: string, params: Record<string, string>): string {
  return [['serviceKey', fscWireKey(key.trim())], ...Object.entries(params)]
    .map(([name, value]) => `${encodeURIComponent(name!)}=${encodeURIComponent(value!)}`).join('&');
}

export async function readBounded(response: Response, max: number): Promise<string | 'too_large'> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > max) {
    await response.body?.cancel().catch(() => undefined);
    return 'too_large';
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > max) return 'too_large';
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const data = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(data);
}

/** Provider codes are copied only when they look like identifiers, never as free text. */
export function codeToken(value: unknown, max = 64): string | null {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  return /^[A-Za-z0-9_.:-]+$/.test(text) && text.length <= max ? text : null;
}

export type KeyedCode = 'ok' | 'timeout' | 'network' | 'too_large' | 'echoed_secret' | `http_${number}`;

export interface KeyedResponse {
  status: number | null;
  code: KeyedCode;
  /** The body; null unless code is 'ok' or http_*. */
  text: string | null;
  /** When the body was fully read; null without a response. */
  receivedAtMs: number | null;
}

/**
 * One GET with redirect:'error', the given headers, an AbortController timeout, a bounded body and an echo check.
 * Never throws, never retries, and never reads a fetch error.
 * code is 'ok' only for 2xx with a body free of any secret form; text is null unless code is 'ok' or http_*.
 */
export async function keyedGet(fetcher: typeof fetch, url: string, headers: Record<string, string>,
  options: { timeoutMs: number; maxBytes: number; redact: Redactor; now: () => number }): Promise<KeyedResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  let status: number | null = null;
  try {
    const response = await fetcher(url, { method: 'GET', redirect: 'error', signal: controller.signal, headers: { ...headers } });
    status = Number.isInteger(response.status) ? response.status : null;
    const body = await readBounded(response, options.maxBytes);
    const receivedAtMs = options.now();
    if (body === 'too_large') return { status, code: 'too_large', text: null, receivedAtMs };
    // A body that echoes the key is discarded unread, whatever its status.
    if (options.redact.contains(body)) return { status, code: 'echoed_secret', text: null, receivedAtMs };
    const ok = status !== null && status >= 200 && status <= 299;
    return { status, code: ok ? 'ok' : `http_${status ?? 0}`, text: body, receivedAtMs };
  } catch {
    // Never read the error: fetch errors can carry the request URL and its key.
    return { status, code: controller.signal.aborted ? 'timeout' : 'network', text: null, receivedAtMs: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Settings under which Node itself would expose a key: NODE_DEBUG=fetch or undici prints every request path,
 * query keys included, straight to stderr; NODE_TLS_REJECT_UNAUTHORIZED=0 sends keys over unverified TLS.
 * 'node_debug_set' when NODE_DEBUG is non-empty, 'tls_unverified' when NODE_TLS_REJECT_UNAUTHORIZED === '0', else null.
 */
export function unsafeNetworkEnv(env: Readonly<Record<string, string | undefined>>): 'node_debug_set' | 'tls_unverified' | null {
  if (env.NODE_DEBUG?.trim()) return 'node_debug_set';
  if (env.NODE_TLS_REJECT_UNAUTHORIZED?.trim() === '0') return 'tls_unverified';
  return null;
}

export interface RequestGateOptions {
  /** Minimum gap between the starts of consecutive requests. */
  minGapMs: number;
  /** The request timeout: a request starts only when it can also end by the caller's deadline. */
  timeoutMs: number;
  /** Requests per gate (per provider instance). */
  cap: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface RequestGate {
  readonly stopped: boolean;
  readonly requests: number;
  /** Refuses every later request of this gate (key or limit errors). */
  stop(): void;
  /**
   * Waits out the pacing gap and reserves one request. 'skipped_budget' (and no reservation) when the cap is
   * reached, the gap cannot be confirmed, or the request could not end by `deadlineMs`.
   */
  admit(deadlineMs: number): Promise<'ok' | 'skipped_budget'>;
  /** Runs tasks one at a time in call order, so pacing and stop state hold across concurrent callers. */
  serialize<T>(task: () => Promise<T>): Promise<T>;
}

export function createRequestGate(options: RequestGateOptions): RequestGate {
  let stopped = false;
  let requests = 0;
  let lastStart: number | null = null;
  let tail: Promise<unknown> = Promise.resolve();
  return {
    get stopped() { return stopped; },
    get requests() { return requests; },
    stop() { stopped = true; },
    async admit(deadlineMs) {
      if (requests >= options.cap) return 'skipped_budget';
      if (lastStart !== null) {
        // A timer can end a millisecond early against the wall clock, so the gap is re-checked (a bounded number of times).
        for (let attempt = 0; ; attempt += 1) {
          const wait = options.minGapMs - (options.now() - lastStart);
          if (wait <= 0) break;
          if (attempt >= 5 || options.now() + wait + options.timeoutMs > deadlineMs) return 'skipped_budget';
          await options.sleep(wait);
        }
      }
      if (options.now() + options.timeoutMs > deadlineMs) return 'skipped_budget';
      requests += 1;
      lastStart = options.now();
      return 'ok';
    },
    serialize<T>(task: () => Promise<T>): Promise<T> {
      const run = tail.then(task, task);
      tail = run.catch(() => undefined);
      return run;
    },
  };
}

// ---------------------------------------------------------------- FSC parsing

/** Numbers arrive as strings ("-.39", "1,234"); '' is missing, not 0. */
export function parseNum(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/,/g, '');
  if (text === '') return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export function fscDate(value: unknown): string | null {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (!match) return null;
  // Compared field by field: toISOString() on an impossible date such as 20231301 would throw and end the whole run.
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day
    ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

/** items.item can be an array, a single object, '' or missing. */
export function fscItems(body: unknown): Json[] {
  if (!isRecord(body)) return [];
  const items = body.items;
  if (!isRecord(items)) return [];
  const item = items.item;
  if (item === undefined || item === null || item === '') return [];
  return (Array.isArray(item) ? item : [item]).filter(isRecord);
}

const FSC_STOP_NAMES = new Set([
  'SERVICE_KEY_IS_NOT_REGISTERED_ERROR', 'SERVICE_ACCESS_DENIED_ERROR', 'LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR',
  'LIMITED_NUMBER_OF_SERVICE_REQUESTS_PER_SECOND_EXCEEDS_ERROR', 'SERVICE_KEY_IS_NULL', 'PERMISSION_DENIED',
  'BLACKLIST_IP_ACCESS_ERROR', 'DEADLINE_HAS_EXPIRED_ERROR',
]);
const FSC_STOP_CODES = new Set(['20', '22', '23', '29', '30', '31']);

interface FscErrorFields { reasonCode: string | null; authMsg: string | null; errMsg: string | null; resultCode: string | null; resultMsg: string | null }
export interface XmlError extends FscErrorFields { code: string; stop: boolean }

/** A gateway message as an identifier ('SERVICE KEY IS NOT REGISTERED ERROR.' → 'SERVICE_KEY_IS_NOT_REGISTERED_ERROR'); free text yields null. */
export function messageToken(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  return codeToken(String(value).trim().replace(/\s+/g, '_').replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, ''), 80);
}

export function classifyFscError(fields: FscErrorFields): { name: string | null; stop: boolean } {
  const name = [fields.authMsg, fields.resultMsg].find(value => value && /^[A-Z][A-Z0-9_]+$/.test(value)) ?? null;
  const stop = [fields.authMsg, fields.resultMsg, fields.errMsg].some(value => value !== null && FSC_STOP_NAMES.has(value.toUpperCase())) ||
    [fields.reasonCode, fields.resultCode].some(value => value !== null && FSC_STOP_CODES.has(value));
  return { name, stop };
}

export function extractXmlError(text: string): XmlError {
  const tag = (name: string) => {
    const match = new RegExp(`<${name}>\\s*([^<]{0,200}?)\\s*</${name}>`).exec(text);
    return match ? messageToken(match[1]) : null;
  };
  const fields: FscErrorFields = {
    reasonCode: tag('returnReasonCode'), authMsg: tag('returnAuthMsg'), errMsg: tag('errMsg'), resultCode: tag('resultCode'), resultMsg: tag('resultMsg'),
  };
  const { name, stop } = classifyFscError(fields);
  return { code: `xml_error:${name ?? fields.reasonCode ?? fields.resultCode ?? 'unknown'}`, ...fields, stop };
}

export type FscParsed =
  | { ok: true; items: Json[]; totalCount: number | null; numOfRows: number | null; resultCode: string }
  | { ok: false; code: string; stop: boolean };

export function parseFscBody(text: string): FscParsed {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('<')) {
    const error = extractXmlError(trimmed);
    return { ok: false, code: error.code, stop: error.stop };
  }
  if (!trimmed.startsWith('{')) return { ok: false, code: 'bad_json', stop: false };
  let json: unknown;
  try { json = JSON.parse(trimmed); } catch { return { ok: false, code: 'bad_json', stop: false }; }
  const root = isRecord(json) && isRecord(json.response) ? json.response : json;
  if (!isRecord(root)) return { ok: false, code: 'bad_json', stop: false };
  // The gateway's error envelope may also come as JSON, wrapped in OpenAPI_ServiceResponse or bare.
  const gateway = isRecord(root.OpenAPI_ServiceResponse) ? root.OpenAPI_ServiceResponse : root;
  const cmm = isRecord(gateway.cmmMsgHeader) ? gateway.cmmMsgHeader : null;
  if (cmm) {
    const fields: FscErrorFields = { reasonCode: messageToken(cmm.returnReasonCode), authMsg: messageToken(cmm.returnAuthMsg),
      errMsg: messageToken(cmm.errMsg), resultCode: null, resultMsg: null };
    const { name, stop } = classifyFscError(fields);
    return { ok: false, code: `fsc_result:${name ?? fields.reasonCode ?? 'unknown'}`, stop };
  }
  // resultCode / resultMsg may also sit at the top level instead of under header.
  const header = isRecord(root.header) ? root.header : 'resultCode' in root || 'resultMsg' in root ? root : {};
  const resultCode = codeToken(header.resultCode) ?? 'missing';
  const resultMsg = messageToken(header.resultMsg);
  if (resultCode !== '00') {
    const { name, stop } = classifyFscError({ reasonCode: null, authMsg: null, errMsg: null, resultCode, resultMsg });
    return { ok: false, code: `fsc_result:${resultCode === 'missing' && name ? name : resultCode}`, stop };
  }
  const body = isRecord(root.body) ? root.body : {};
  return { ok: true, items: fscItems(body), totalCount: parseNum(body.totalCount), numOfRows: parseNum(body.numOfRows), resultCode };
}

const KOSPI200_NAMES = new Set(['코스피200', 'KOSPI200']);
export function isKospi200Name(value: unknown): boolean {
  return typeof value === 'string' && KOSPI200_NAMES.has(value.normalize('NFKC').replace(/\s+/g, '').toUpperCase());
}

// ---------------------------------------------------------------- Massive parsing

const etClock = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' });
export const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
/** Epoch milliseconds a Date can hold; anything else (nanoseconds, say) would make Intl throw and end the whole run. */
export const instant = (value: unknown) => { const ms = finite(value); return ms !== null && Math.abs(ms) <= 8.64e15 ? ms : null; };

export function etTime(ms: number): string {
  return instant(ms) === null ? 'invalid' : etClock.format(new Date(ms)).replace(/^24/, '00');
}
