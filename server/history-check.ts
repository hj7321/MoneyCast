// One-off data check for the history-insights price and news sources (plan
// step 3). Every effect is injected (fetcher, clock, sleep, env, print) so
// tests run on fake fetches only. The default mode is a dry run that builds
// the call plan and makes no request; `live` performs it within hard per-
// provider caps, never retries and never pages. Only aggregates leave this
// module, and every string that leaves it passes through the key redactor.

import { companies, COMPANY_NEWS_IDENTITY, type Company } from '../packages/core/src/index.js';
import {
  addDays, CALENDAR_UNVERIFIED, EXCHANGE_CALENDARS, closesEarly, localDate, sessionOn, sessionsBefore, weeklyAsOfAtOrBefore, type Exchange,
} from './market-calendar.js';

export type HistoryProvider = 'fsc' | 'massive' | 'marketaux';
export const PROVIDERS: readonly HistoryProvider[] = ['fsc', 'massive', 'marketaux'];
export const CAPS: Readonly<Record<HistoryProvider, number>> = { fsc: 10, massive: 12, marketaux: 20 };
export const ENV_KEYS: Readonly<Record<HistoryProvider, string>> = {
  fsc: 'KR_PRICE_API_KEY', massive: 'US_PRICE_API_KEY', marketaux: 'MARKETAUX_API_TOKEN',
};
export const SECRET_ENV_KEYS: readonly string[] = Object.values(ENV_KEYS);
const ORIGINS: Readonly<Record<HistoryProvider, string>> = {
  fsc: 'https://apis.data.go.kr', massive: 'https://api.massive.com', marketaux: 'https://api.marketaux.com',
};
const TIMEOUT_MS: Readonly<Record<HistoryProvider, number>> = { fsc: 60_000, massive: 30_000, marketaux: 20_000 };
const MAX_BODY: Readonly<Record<HistoryProvider, number>> = { fsc: 16 * 1024 * 1024, massive: 8 * 1024 * 1024, marketaux: 8 * 1024 * 1024 };
/** Minimum gap between the starts of consecutive requests to one provider. */
export const MIN_GAP_MS: Readonly<Record<HistoryProvider, number>> = { fsc: 1000, massive: 13_000, marketaux: 2000 };
const DAY_MS = 86_400_000;

type Json = Record<string, unknown>;
function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const round = (value: number, digits = 6) => Math.round(value * 10 ** digits) / 10 ** digits;
const compactDate = (date: string) => date.replace(/-/g, '');

// ---------------------------------------------------------------- budget

export class BudgetExceeded extends Error {
  constructor(public readonly provider: HistoryProvider) { super('budget'); this.name = 'BudgetExceeded'; }
}

export interface Budget {
  /** Called immediately before each fetch; throws once the provider's cap is reached. */
  take(provider: HistoryProvider): void;
  used(provider: HistoryProvider): number;
  remaining(provider: HistoryProvider): number;
  snapshot(): Record<HistoryProvider, { cap: number; used: number }>;
}

export function createBudget(caps: Readonly<Record<HistoryProvider, number>> = CAPS): Budget {
  const used: Record<HistoryProvider, number> = { fsc: 0, massive: 0, marketaux: 0 };
  return {
    take(provider) {
      if (used[provider] >= caps[provider]) throw new BudgetExceeded(provider);
      used[provider] += 1;
    },
    used: provider => used[provider],
    remaining: provider => caps[provider] - used[provider],
    snapshot: () => ({
      fsc: { cap: caps.fsc, used: used.fsc }, massive: { cap: caps.massive, used: used.massive },
      marketaux: { cap: caps.marketaux, used: used.marketaux },
    }),
  };
}

// ---------------------------------------------------------------- secrets

function safeDecode(value: string): string {
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

// ---------------------------------------------------------------- dates

export interface CheckDates {
  nowIso: string;
  kstToday: string;
  /** endBasDt (exclusive), YYYYMMDD. */
  fscEnd: string;
  etToday: string;
  massiveFrom: string;
  massiveTo: string;
  /** Marketaux window, YYYY-MM-DDTHH:mm:ss UTC without a zone. */
  w0: string;
  w1: string;
}

const utcStamp = (ms: number) => new Date(ms).toISOString().slice(0, 19);

export function deriveDates(nowMs: number): CheckDates {
  const kstToday = localDate('KRX', nowMs);
  const etToday = localDate('NASDAQ', nowMs);
  const w1Ms = weeklyAsOfAtOrBefore(nowMs);
  return {
    nowIso: new Date(nowMs).toISOString(), kstToday, fscEnd: compactDate(addDays(kstToday, 1)), etToday,
    massiveTo: addDays(etToday, -1), massiveFrom: addDays(etToday, -729),
    w1: utcStamp(w1Ms), w0: utcStamp(w1Ms - 728 * DAY_MS),
  };
}

// ---------------------------------------------------------------- plan

export interface PlannedCall {
  id: string;
  provider: HistoryProvider;
  path: string;
  params: Record<string, string>;
  purpose: string;
  /** Set when the call runs only if an earlier result meets a condition. */
  conditional?: string;
  companyId?: string;
}

const FSC_STOCK = '/1160100/GetStockSecuritiesInfoService_V2/getStockPriceInfo_V2';
const FSC_ETF = '/1160100/GetSecuritiesProductInfoService_V2/getETFPriceInfo_V2';
const FSC_INDEX = '/1160100/GetMarketIndexInfoService_V2/getStockMarketIndex_V2';
export const KR_STOCKS: readonly { code: string; companyId: string }[] = [
  { code: '005930', companyId: 'krx:005930' }, { code: '000660', companyId: 'krx:000660' },
  { code: '035420', companyId: 'krx:035420' }, { code: '005380', companyId: 'krx:005380' },
];
export const KR_ETF = '069500';
const KAKAO = '035720';
export const US_TICKERS: readonly string[] = ['AAPL', 'NVDA', 'MSFT', 'TSLA', 'SPY', 'QQQ'];
export const SPLIT_PREFERENCE: readonly string[] = ['ORLY', 'IBKR', 'FAST', 'AVGO', 'NVDA'];
/** Marketaux company order: KR first, then US, as in COMPANIES. */
const NEWS_COMPANY_IDS = ['krx:005930', 'krx:000660', 'krx:035420', 'krx:005380', 'nasdaq:AAPL', 'nasdaq:NVDA', 'nasdaq:MSFT', 'nasdaq:TSLA'];
const TOTAL_COMPANY_IDS = ['krx:005930', 'krx:005380', 'nasdaq:AAPL'];
export const SENTIMENT_THRESHOLD = 0.0001;

/** KOSPI 200 query: names containing 200 with exactly 200 constituents (endEpyItmsCnt is exclusive). */
function kospi200Params(begin: string, end: string, rows: string): Record<string, string> {
  return { likeIdxNm: '200', beginEpyItmsCnt: '200', endEpyItmsCnt: '201', beginBasDt: begin, endBasDt: end, numOfRows: rows, pageNo: '1', resultType: 'json' };
}
function fscWindow(begin: string, end: string, rows: string): Record<string, string> {
  return { beginBasDt: begin, endBasDt: end, numOfRows: rows, pageNo: '1', resultType: 'json' };
}

export function latestEarlyClose(from: string, to: string): string | null {
  const dates = [...EXCHANGE_CALENDARS.NASDAQ.changedHours.keys()]
    .filter(date => closesEarly('NASDAQ', date) && date >= from && date <= to).sort();
  return dates.length ? dates[dates.length - 1]! : null;
}

/** The full-length session 20 sessions before `to` (stepping further back past early closes). */
export function regularSessionBefore(to: string, count = 20): string | null {
  const sessions = sessionsBefore('NASDAQ', to, count + 10);
  if (sessions === CALENDAR_UNVERIFIED) return null;
  for (let index = sessions.length - count; index >= 0; index -= 1) {
    const date = sessions[index]!.date;
    if (!closesEarly('NASDAQ', date)) return date;
  }
  return null;
}

export function marketauxSymbol(company: Company): string {
  return company.region === 'KR' ? `${company.symbol}.KS` : company.symbol;
}

/** The production `/v1/news/all` parameters (server/marketaux.ts) plus an optional sentiment filter. */
export function marketauxNewsParams(symbol: string, country: string, after: string, before: string,
  query: 'positive' | 'negative' | 'total'): Record<string, string> {
  return {
    symbols: symbol, countries: country, entity_types: 'equity',
    filter_entities: 'true', must_have_entities: 'true', group_similar: 'true', limit: '3',
    language: 'en,ko', sort: 'entity_match_score', published_after: after, published_before: before,
    ...(query === 'positive' ? { sentiment_gte: String(SENTIMENT_THRESHOLD) } : {}),
    ...(query === 'negative' ? { sentiment_lte: String(-SENTIMENT_THRESHOLD) } : {}),
  };
}

function company(id: string): Company {
  const found = companies.find(item => item.id === id);
  if (!found) throw new Error('unknown_company');
  return found;
}

export function buildPlan(dates: CheckDates, only: readonly HistoryProvider[] = PROVIDERS): PlannedCall[] {
  const plan: PlannedCall[] = [];
  if (only.includes('fsc')) {
    KR_STOCKS.forEach((stock, index) => plan.push({
      id: `F${index + 1}`, provider: 'fsc', path: FSC_STOCK, companyId: stock.companyId,
      params: { likeSrtnCd: stock.code, ...fscWindow('20230101', dates.fscEnd, '2000') },
      purpose: `${stock.code} 일별 시세(2023~), 형식·범위·기준가 일관성·달력 대조`,
    }));
    plan.push({ id: 'F5', provider: 'fsc', path: FSC_ETF, params: { likeSrtnCd: KR_ETF, ...fscWindow('20230101', dates.fscEnd, '2000') },
      purpose: 'KODEX 200 ETF 일별 시세(2023~), 기초지수 이름' });
    plan.push({ id: 'F6', provider: 'fsc', path: FSC_INDEX, params: kospi200Params('20230101', dates.fscEnd, '10000'),
      purpose: '코스피 200 지수(2023~), 지수 이름 변형 기록' });
    plan.push({ id: 'F7', provider: 'fsc', path: FSC_STOCK, params: { likeSrtnCd: '005930', ...fscWindow('19800101', '20230101', '10000') },
      purpose: '주식 시세 제공 시작일' });
    plan.push({ id: 'F8', provider: 'fsc', path: FSC_ETF, params: { likeSrtnCd: KR_ETF, ...fscWindow('19800101', '20230101', '10000') },
      purpose: 'ETF 시세 제공 시작일' });
    plan.push({ id: 'F9', provider: 'fsc', path: FSC_INDEX, params: kospi200Params('19800101', '20230101', '10000'),
      purpose: '지수 시세 제공 시작일' });
    plan.push({ id: 'F10', provider: 'fsc', path: FSC_STOCK, params: { likeSrtnCd: KAKAO, ...fscWindow('20210401', '20210501', '100') },
      purpose: '카카오 5:1 분할(2021-04-15 재개) 전후 수정주가 여부', conditional: 'F7에 2021-04-01 이전 행이 있을 때만' });
  }
  if (only.includes('massive')) {
    const aggs = { adjusted: 'true', sort: 'asc', limit: '50000' };
    US_TICKERS.forEach((ticker, index) => plan.push({
      id: `M${index + 1}`, provider: 'massive', path: `/v2/aggs/ticker/${ticker}/range/1/day/${dates.massiveFrom}/${dates.massiveTo}`,
      params: { ...aggs }, purpose: `${ticker} 일봉 2년, 형식·범위·ET 시각·달력 대조`,
    }));
    const early = latestEarlyClose(dates.massiveFrom, dates.massiveTo);
    const regular = regularSessionBefore(dates.massiveTo);
    plan.push({ id: 'M7', provider: 'massive', path: `/v1/open-close/AAPL/${early ?? '{none}'}`, params: { adjusted: 'true' },
      purpose: 'AAPL 단축일 공식 시가·종가와 일봉 비교', ...(early ? {} : { conditional: '범위 안 단축일 없음' }) });
    plan.push({ id: 'M8', provider: 'massive', path: `/v1/open-close/AAPL/${regular ?? '{none}'}`, params: { adjusted: 'true' },
      purpose: 'AAPL 정규 거래일(20거래일 전) 공식 시가·종가와 일봉 비교', ...(regular ? {} : { conditional: '달력 범위 밖' }) });
    plan.push({ id: 'M9', provider: 'massive', path: '/stocks/v1/dividends',
      params: { ticker: 'AAPL', 'ex_dividend_date.gte': dates.massiveFrom, limit: '50', sort: 'ex_dividend_date.desc' },
      purpose: '배당 응답 필드와 조정 계수 필드' });
    // /stocks/v1/splits returns newest first and allows up to 5000 rows; 1000 (the old /v3 maximum) could cut off
    // the older half of the window, where the preferred ORLY / IBKR / FAST splits lie.
    plan.push({ id: 'M10', provider: 'massive', path: '/stocks/v1/splits',
      params: { 'execution_date.gte': dates.massiveFrom, 'execution_date.lte': addDays(dates.massiveTo, -14), limit: '5000' },
      purpose: '분할 응답 필드, 조정 시험 대상 선택' });
    for (const [id, adjusted] of [['M11', 'true'], ['M12', 'false']] as const) {
      plan.push({ id, provider: 'massive', path: '/v2/aggs/ticker/{split}/range/1/day/{exec-10}/{exec+10}',
        params: { adjusted, sort: 'asc', limit: '50000' }, purpose: `분할 전후 일봉 adjusted=${adjusted}`,
        conditional: 'M10에 2:1 이상 정분할이 있을 때만' });
    }
  }
  if (only.includes('marketaux')) {
    plan.push({ id: 'A1', provider: 'marketaux', path: '/v1/entity/search',
      params: { symbols: KR_STOCKS.map(stock => `${stock.code}.KS`).join(','), countries: 'kr', types: 'equity' },
      purpose: '한국 4종목 식별 확인(한 번에). 지원하지 않으면 종목별 search로 대체하고 A18~A20을 줄임' });
    let next = 2;
    for (const id of NEWS_COMPANY_IDS) {
      const item = company(id);
      for (const query of ['positive', 'negative'] as const) {
        plan.push({ id: `A${next++}`, provider: 'marketaux', path: '/v1/news/all', companyId: id,
          params: marketauxNewsParams(marketauxSymbol(item), item.region.toLowerCase(), dates.w0, dates.w1, query),
          purpose: `${item.name} ${query === 'positive' ? '긍정' : '부정'} 기사 수(104주)`,
          ...(item.region === 'KR' ? { conditional: 'A1에서 식별 확인된 경우만' } : {}) });
      }
    }
    for (const id of TOTAL_COMPANY_IDS) {
      const item = company(id);
      plan.push({ id: `A${next++}`, provider: 'marketaux', path: '/v1/news/all', companyId: id,
        params: marketauxNewsParams(marketauxSymbol(item), item.region.toLowerCase(), dates.w0, dates.w1, 'total'),
        purpose: `${item.name} 감성 필터 없는 전체 기사 수`, conditional: '상한 안에서, 식별 확인된 경우만' });
    }
  }
  return plan;
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

function requestUrl(provider: HistoryProvider, path: string, params: Record<string, string>, key: string): string {
  if (provider === 'fsc') return `${ORIGINS.fsc}${path}?${fscQuery(key, params)}`;
  const url = new URL(path, ORIGINS[provider]);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  if (provider === 'marketaux') url.searchParams.set('api_token', key);
  return url.toString();
}

async function readBounded(response: Response, max: number): Promise<string | 'too_large'> {
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

export interface CallRecord {
  id: string;
  provider: HistoryProvider;
  path: string;
  params: Record<string, string>;
  status: number | null;
  code: string;
  ms: number;
  requestId?: string;
  providerCode?: string;
}

interface Outcome { status: number | null; code: string; text: string | null }

export interface HistoryCheckDeps {
  env: Readonly<Record<string, string | undefined>>;
  fetcher: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  print: (line: string) => void;
}

interface Context {
  deps: HistoryCheckDeps;
  dates: CheckDates;
  budget: Budget;
  redact: Redactor;
  keys: Record<HistoryProvider, string | undefined>;
  calls: CallRecord[];
  stopped: Set<HistoryProvider>;
  lastStart: Partial<Record<HistoryProvider, number>>;
}

/** Provider codes are copied only when they look like identifiers, never as free text. */
function codeToken(value: unknown, max = 64): string | null {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  return /^[A-Za-z0-9_.:-]+$/.test(text) && text.length <= max ? text : null;
}

function skip(ctx: Context, call: PlannedCall, code: string): CallRecord {
  const record: CallRecord = { id: call.id, provider: call.provider, path: call.path, params: { ...call.params }, status: null, code, ms: 0 };
  ctx.calls.push(record);
  return record;
}

async function perform(ctx: Context, call: PlannedCall): Promise<{ record: CallRecord; outcome: Outcome }> {
  const provider = call.provider;
  const key = ctx.keys[provider];
  if (!key) return { record: skip(ctx, call, 'not_configured'), outcome: { status: null, code: 'not_configured', text: null } };
  if (ctx.stopped.has(provider)) return { record: skip(ctx, call, 'stopped'), outcome: { status: null, code: 'stopped', text: null } };
  const last = ctx.lastStart[provider];
  if (last !== undefined) {
    // A timer can end a millisecond early against the wall clock, so the gap is re-checked (a bounded number of times).
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const wait = MIN_GAP_MS[provider] - (ctx.deps.now() - last);
      if (wait <= 0) break;
      await ctx.deps.sleep(wait);
    }
  }
  try { ctx.budget.take(provider); } catch {
    return { record: skip(ctx, call, 'budget'), outcome: { status: null, code: 'budget', text: null } };
  }
  const record = skip(ctx, call, 'pending');
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (provider === 'massive') headers.Authorization = `Bearer ${key}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS[provider]);
  const started = ctx.deps.now();
  ctx.lastStart[provider] = started;
  let outcome: Outcome;
  try {
    const response = await ctx.deps.fetcher(requestUrl(provider, call.path, call.params, key),
      { method: 'GET', redirect: 'error', signal: controller.signal, headers });
    record.status = response.status;
    const body = await readBounded(response, MAX_BODY[provider]);
    if (body === 'too_large') outcome = { status: response.status, code: 'too_large', text: null };
    // A body that echoes the key is discarded unread.
    else if (ctx.redact.contains(body)) outcome = { status: response.status, code: 'echoed_secret', text: null };
    else outcome = { status: response.status, code: response.ok ? 'ok' : `http_${response.status}`, text: body };
  } catch {
    // Never read the error: fetch errors can carry the request URL and its key.
    outcome = { status: record.status, code: controller.signal.aborted ? 'timeout' : 'network', text: null };
  } finally {
    clearTimeout(timer);
  }
  record.code = outcome.code;
  record.ms = Math.max(0, ctx.deps.now() - started);
  return { record, outcome };
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
function messageToken(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  return codeToken(String(value).trim().replace(/\s+/g, '_').replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, ''), 80);
}

function classifyFscError(fields: FscErrorFields): { name: string | null; stop: boolean } {
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

// ---------------------------------------------------------------- summaries

export interface Capped { count: number; items: string[] }
function capped(list: readonly string[], max = 100): Capped { return { count: list.length, items: list.slice(0, max) }; }

function orderOf(dates: readonly string[]): 'asc' | 'desc' | 'unsorted' | 'empty' {
  if (!dates.length) return 'empty';
  let asc = true;
  let desc = true;
  for (let index = 1; index < dates.length; index += 1) {
    if (dates[index]! < dates[index - 1]!) asc = false;
    if (dates[index]! > dates[index - 1]!) desc = false;
  }
  return asc ? 'asc' : desc ? 'desc' : 'unsorted';
}
function isWeekend(date: string): boolean {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}
function duplicatesOf(dates: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const date of dates) (seen.has(date) ? duplicates : seen).add(date);
  return [...duplicates].sort();
}

const FSC_FIELDS = ['mkp', 'hipr', 'lopr', 'clpr', 'vs', 'fltRt', 'trqu'] as const;
type FscField = typeof FSC_FIELDS[number];
interface FscBar extends Record<FscField, number | null> { date: string }

function fscBars(items: readonly Json[]): { bars: FscBar[]; badDates: number } {
  const bars: FscBar[] = [];
  let badDates = 0;
  for (const item of items) {
    const date = fscDate(item.basDt);
    if (!date) { badDates += 1; continue; }
    const bar = { date } as FscBar;
    for (const field of FSC_FIELDS) bar[field] = parseNum(item[field]);
    bars.push(bar);
  }
  return { bars, badDates };
}
function sortedUnique<T extends { date: string }>(bars: readonly T[]): T[] {
  const sorted = [...bars].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  return sorted.filter((bar, index) => index === 0 || bar.date !== sorted[index - 1]!.date);
}

/** Ratios only: vs itself plus impliedReturn and factor would give back the raw closes, which the summary must not hold. */
export interface BaseMismatch { date: string; rawRatio: number; impliedReturn: number | null; factor: number }

export interface FscSeriesSummary {
  count: number;
  badDates: number;
  firstDate: string | null;
  lastDate: string | null;
  order: 'asc' | 'desc' | 'unsorted' | 'empty';
  duplicateDates: Capped;
  weekendDates: Capped;
  fieldPresence: Record<FscField, number>;
  invalid: Capped;
  haltLike: number;
  extremeMoves: { date: string; r: number; fltRt: number | null }[];
  basePrice: { pairs: number; equal: number; share: number | null; mismatches: BaseMismatch[] };
}

/** FSC rows in any order; consecutive pairs are consecutive observed dates. */
export function summarizeFscSeries(items: readonly Json[]): FscSeriesSummary {
  const { bars, badDates } = fscBars(items);
  const dates = bars.map(bar => bar.date);
  const fieldPresence = Object.fromEntries(FSC_FIELDS.map(field => [field, bars.filter(bar => bar[field] !== null).length])) as Record<FscField, number>;
  const invalid = bars.filter(bar => {
    const { mkp, hipr, lopr, clpr } = bar;
    if (mkp === null || clpr === null || hipr === null || lopr === null) return true;
    return mkp <= 0 || clpr <= 0 || hipr < lopr || clpr < lopr || clpr > hipr || mkp < lopr || mkp > hipr;
  }).map(bar => bar.date);
  const haltLike = bars.filter(bar => bar.mkp === 0 && bar.hipr === 0 && bar.lopr === 0).length;
  const unique = sortedUnique(bars);
  const extremeMoves: FscSeriesSummary['extremeMoves'] = [];
  const mismatches: BaseMismatch[] = [];
  let pairs = 0;
  let equal = 0;
  for (let index = 1; index < unique.length; index += 1) {
    const previous = unique[index - 1]!;
    const current = unique[index]!;
    if (previous.clpr === null || current.clpr === null || previous.clpr <= 0) continue;
    const r = current.clpr / previous.clpr - 1;
    if (Math.abs(r) > 0.3) extremeMoves.push({ date: current.date, r: round(r, 3), fltRt: current.fltRt });
    if (current.vs === null) continue;
    pairs += 1;
    if (Math.abs(current.clpr - previous.clpr - current.vs) < 1e-6) { equal += 1; continue; }
    const base = current.clpr - current.vs;
    mismatches.push({ date: current.date, rawRatio: round(current.clpr / previous.clpr),
      impliedReturn: base === 0 ? null : round(current.vs / base), factor: round(base / previous.clpr) });
  }
  return {
    count: bars.length, badDates, firstDate: unique[0]?.date ?? null, lastDate: unique[unique.length - 1]?.date ?? null,
    order: orderOf(dates), duplicateDates: capped(duplicatesOf(dates)), weekendDates: capped(dates.filter(isWeekend)),
    fieldPresence, invalid: capped(invalid), haltLike, extremeMoves,
    basePrice: { pairs, equal, share: pairs ? round(equal / pairs, 4) : null, mismatches },
  };
}

const etClock = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
/** Epoch milliseconds a Date can hold; anything else (nanoseconds, say) would make Intl throw and end the whole run. */
const instant = (value: unknown) => { const ms = finite(value); return ms !== null && Math.abs(ms) <= 8.64e15 ? ms : null; };

export function etTime(ms: number): string {
  return instant(ms) === null ? 'invalid' : etClock.format(new Date(ms)).replace(/^24/, '00');
}

const MASSIVE_FIELDS = ['o', 'h', 'l', 'c', 'v', 'vw', 'n', 't'] as const;
type MassiveField = typeof MASSIVE_FIELDS[number];
export interface MassiveBar { date: string; t: number; o: number | null; h: number | null; l: number | null; c: number | null; v: number | null }

export function massiveBars(results: readonly unknown[]): MassiveBar[] {
  return results.filter(isRecord).flatMap(bar => {
    const t = instant(bar.t);
    return t === null ? [] : [{ date: localDate('NASDAQ', t), t, o: finite(bar.o), h: finite(bar.h), l: finite(bar.l), c: finite(bar.c), v: finite(bar.v) }];
  });
}

export interface MassiveAggsSummary {
  count: number;
  /** Bars dropped because t is missing or not epoch milliseconds a Date can hold. */
  badTimes: number;
  firstDate: string | null;
  lastDate: string | null;
  order: 'asc' | 'desc' | 'unsorted' | 'empty';
  etClockTimes: Record<string, number>;
  fieldPresence: Record<MassiveField, number>;
  duplicateDates: Capped;
  weekendDates: Capped;
  invalid: Capped;
  extremeMoves: { date: string; r: number }[];
  zeroVolume: Capped;
}

export function summarizeMassiveAggs(results: readonly unknown[]): MassiveAggsSummary {
  const records = results.filter(isRecord);
  const bars = massiveBars(records);
  const dates = bars.map(bar => bar.date);
  const etClockTimes: Record<string, number> = {};
  for (const bar of bars) { const time = etTime(bar.t); etClockTimes[time] = (etClockTimes[time] ?? 0) + 1; }
  const fieldPresence = Object.fromEntries(MASSIVE_FIELDS.map(field => [field, records.filter(bar => finite(bar[field]) !== null).length])) as Record<MassiveField, number>;
  const invalid = bars.filter(({ o, h, l, c }) => o === null || h === null || l === null || c === null ||
    o <= 0 || c <= 0 || h < l || o < l || o > h || c < l || c > h).map(bar => bar.date);
  const unique = sortedUnique(bars);
  const extremeMoves: MassiveAggsSummary['extremeMoves'] = [];
  for (let index = 1; index < unique.length; index += 1) {
    const previous = unique[index - 1]!.c;
    const current = unique[index]!.c;
    if (previous === null || current === null || previous <= 0) continue;
    const r = current / previous - 1;
    if (Math.abs(r) > 0.5) extremeMoves.push({ date: unique[index]!.date, r: round(r, 3) });
  }
  return {
    count: bars.length, badTimes: records.length - bars.length, firstDate: unique[0]?.date ?? null, lastDate: unique[unique.length - 1]?.date ?? null,
    order: orderOf(dates), etClockTimes, fieldPresence, duplicateDates: capped(duplicatesOf(dates)),
    weekendDates: capped(dates.filter(isWeekend)), invalid: capped(invalid),
    extremeMoves, zeroVolume: capped(bars.filter(bar => bar.v === 0).map(bar => bar.date)),
  };
}

export interface CalendarCheck { exchange: Exchange; from: string; to: string; expected: number; observed: number; missing: Capped; extra: Capped; unverified: Capped }

/** Observed trading dates against server/market-calendar.ts in [from, to]. */
export function crossCheckCalendar(exchange: Exchange, observedDates: readonly string[], from: string, to: string): CalendarCheck {
  const observed = new Set(observedDates.filter(date => date >= from && date <= to));
  const expected: string[] = [];
  const unverified: string[] = [];
  const extra: string[] = [];
  for (let date = from, guard = 0; date <= to && guard < 20_000; date = addDays(date, 1), guard += 1) {
    const session = sessionOn(exchange, date);
    if (session === CALENDAR_UNVERIFIED) { if (observed.has(date)) unverified.push(date); continue; }
    if (session) expected.push(date);
    else if (observed.has(date)) extra.push(date);
  }
  return {
    exchange, from, to, expected: expected.length, observed: observed.size,
    missing: capped(expected.filter(date => !observed.has(date))), extra: capped(extra), unverified: capped(unverified),
  };
}

export interface OpenCloseComparison {
  date: string | null;
  agg: { o: number | null; c: number | null } | null;
  official: { open: number | null; close: number | null; preMarket: number | null; afterHours: number | null } | null;
  openDiff: number | null; openRel: number | null; closeDiff: number | null; closeRel: number | null;
  openEqualsOfficial: boolean | null; openEqualsPreMarket: boolean | null; closeEqualsOfficial: boolean | null;
}

export function compareOpenClose(aggBar: MassiveBar | null, openClose: unknown): OpenCloseComparison {
  const official = isRecord(openClose) ? {
    open: finite(openClose.open), close: finite(openClose.close), preMarket: finite(openClose.preMarket), afterHours: finite(openClose.afterHours),
  } : null;
  const date = aggBar?.date ?? (isRecord(openClose) && typeof openClose.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(openClose.from) ? openClose.from : null);
  const diff = (a: number | null | undefined, b: number | null | undefined) => a === null || a === undefined || b === null || b === undefined ? null : round(a - b);
  const rel = (a: number | null | undefined, b: number | null | undefined) => a === null || a === undefined || !b ? null : round(a / b - 1);
  const same = (a: number | null | undefined, b: number | null | undefined) => a === null || a === undefined || b === null || b === undefined ? null : Math.abs(a - b) < 1e-9;
  return {
    date, agg: aggBar ? { o: aggBar.o, c: aggBar.c } : null, official,
    openDiff: diff(aggBar?.o, official?.open), openRel: rel(aggBar?.o, official?.open),
    closeDiff: diff(aggBar?.c, official?.close), closeRel: rel(aggBar?.c, official?.close),
    openEqualsOfficial: same(aggBar?.o, official?.open), openEqualsPreMarket: same(aggBar?.o, official?.preMarket),
    closeEqualsOfficial: same(aggBar?.c, official?.close),
  };
}

function fieldsSeen(records: readonly Json[]): string[] {
  return [...new Set(records.flatMap(record => Object.keys(record)))].sort();
}
function countBy(records: readonly Json[], field: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const record of records) {
    const value = codeToken(record[field]) ?? (record[field] === undefined ? '(none)' : '(other)');
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}
function dateRange(records: readonly Json[], field: string): { first: string | null; last: string | null } {
  const dates = records.map(record => record[field]).filter((value): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)).sort();
  return { first: dates[0] ?? null, last: dates[dates.length - 1] ?? null };
}
function factorInfo(records: readonly Json[]): { field: string | null; min: number | null; max: number | null } {
  const field = fieldsSeen(records).find(name => /adjustment_factor/i.test(name)) ?? null;
  const values = field ? records.map(record => finite(record[field])).filter((value): value is number => value !== null) : [];
  return { field, min: values.length ? Math.min(...values) : null, max: values.length ? Math.max(...values) : null };
}

export interface CorporateActionSummary {
  fields: string[];
  count: number;
  dateRange: { first: string | null; last: string | null };
  types: Record<string, number>;
  tickers: number;
  factor: { field: string | null; min: number | null; max: number | null };
}

export function summarizeDividends(results: readonly unknown[]): CorporateActionSummary {
  const records = results.filter(isRecord);
  const typeField = records.some(record => 'distribution_type' in record) ? 'distribution_type' : 'dividend_type';
  return { fields: fieldsSeen(records), count: records.length, dateRange: dateRange(records, 'ex_dividend_date'),
    types: countBy(records, typeField), tickers: new Set(records.map(record => record.ticker)).size, factor: factorInfo(records) };
}

export function summarizeSplits(results: readonly unknown[]): CorporateActionSummary & { forwardRatio2Plus: number } {
  const records = results.filter(isRecord);
  return { fields: fieldsSeen(records), count: records.length, dateRange: dateRange(records, 'execution_date'),
    types: countBy(records, 'adjustment_type'), tickers: new Set(records.map(record => record.ticker)).size, factor: factorInfo(records),
    forwardRatio2Plus: records.filter(record => splitRatio(record) !== null && splitRatio(record)! >= 2).length };
}

function splitRatio(record: Json): number | null {
  const from = finite(record.split_from);
  const to = finite(record.split_to);
  return from && to && from > 0 ? to / from : null;
}

export interface ChosenSplit { ticker: string; executionDate: string; splitFrom: number; splitTo: number; ratio: number }

/** A forward split of at least 2:1 whose ±10-day window lies inside [from, to]. */
export function pickSplit(results: readonly unknown[], from: string, to: string): ChosenSplit | null {
  const candidates: ChosenSplit[] = results.filter(isRecord).flatMap(record => {
    const ratio = splitRatio(record);
    const ticker = typeof record.ticker === 'string' ? record.ticker : '';
    const date = typeof record.execution_date === 'string' ? record.execution_date : '';
    if (ratio === null || ratio < 2 || !/^[A-Z]{1,5}$/.test(ticker) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
    if (record.adjustment_type !== undefined && record.adjustment_type !== 'forward_split') return [];
    if (addDays(date, -10) < from || addDays(date, 10) > to) return [];
    return [{ ticker, executionDate: date, splitFrom: finite(record.split_from)!, splitTo: finite(record.split_to)!, ratio: round(ratio, 4) }];
  });
  const latest = (list: ChosenSplit[]) => list.sort((a, b) => b.executionDate.localeCompare(a.executionDate))[0]!;
  for (const ticker of SPLIT_PREFERENCE) {
    const mine = candidates.filter(candidate => candidate.ticker === ticker);
    if (mine.length) return latest(mine);
  }
  if (!candidates.length) return null;
  return candidates.sort((a, b) => b.ratio - a.ratio || b.executionDate.localeCompare(a.executionDate) || a.ticker.localeCompare(b.ticker))[0]!;
}

export interface SplitWindow {
  split: ChosenSplit;
  rows: { date: string; adjClose: number | null; rawClose: number | null; rawOverAdj: number | null }[];
  medianRatioBefore: number | null;
  medianRatioAfter: number | null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return round(sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2, 4);
}

export function compareSplitWindow(split: ChosenSplit, adjusted: readonly unknown[], raw: readonly unknown[]): SplitWindow {
  const adj = new Map(massiveBars(adjusted).map(bar => [bar.date, bar.c]));
  const unadj = new Map(massiveBars(raw).map(bar => [bar.date, bar.c]));
  const dates = [...new Set([...adj.keys(), ...unadj.keys()])].sort();
  const rows = dates.map(date => {
    const adjClose = adj.get(date) ?? null;
    const rawClose = unadj.get(date) ?? null;
    return { date, adjClose, rawClose, rawOverAdj: adjClose && rawClose !== null ? round(rawClose / adjClose, 4) : null };
  });
  const ratios = (before: boolean) => rows.filter(row => (row.date < split.executionDate) === before && row.rawOverAdj !== null).map(row => row.rawOverAdj!);
  return { split, rows, medianRatioBefore: median(ratios(true)), medianRatioAfter: median(ratios(false)) };
}

// ---------------------------------------------------------------- Marketaux

function normalName(value: string): string {
  let name = value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  let previous = '';
  while (name !== previous) {
    previous = name;
    name = name.replace(/(?:corporation|company|limited|corp|inc|ltd|co)$/, '');
  }
  return name;
}

export interface EntityVerification { companyId: string; symbol: string | null; verified: boolean; via: 'symbols' | 'search' | null; candidates: number; name: string | null; exchange: string | null }

/** A Korean company is verified only when exactly one distinct entity carries its symbol and that entity is kr / equity / a known name. */
export function verifyKrEntity(data: readonly unknown[], companyId: string, code: string, via: 'symbols' | 'search'): EntityVerification {
  const names = (COMPANY_NEWS_IDENTITY[companyId]?.entityNames ?? []).map(normalName);
  const matches = data.filter(isRecord).filter(entity => typeof entity.symbol === 'string' && (via === 'symbols'
    ? entity.symbol === `${code}.KS`
    : /^(\d{6})(?:[.:-][a-zA-Z0-9]{1,12})?$/.exec(entity.symbol)?.[1] === code));
  const distinct = [...new Map(matches.map(entity => [JSON.stringify([entity.symbol, entity.name, entity.country, entity.type, entity.exchange ?? null]), entity])).values()];
  const only = distinct.length === 1 ? distinct[0]! : null;
  const verified = !!only && typeof only.name === 'string' && typeof only.country === 'string' && typeof only.type === 'string' &&
    only.country.toLowerCase() === 'kr' && only.type.toLowerCase() === 'equity' && names.includes(normalName(only.name));
  const text = (value: unknown) => typeof value === 'string' && value.length <= 200 ? value : null;
  return { companyId, symbol: verified ? only!.symbol as string : null, verified, via, candidates: distinct.length,
    name: text(only?.name), exchange: text(only?.exchange) };
}

export interface ArticleRecord { companyId: string; query: 'positive' | 'negative' | 'total'; uuid: string; published_at: string | null; language: string | null; score: number | null }

export interface MarketauxQueryResult {
  id: string;
  companyId: string;
  query: 'positive' | 'negative' | 'total';
  code: string;
  found: number | null;
  returned: number | null;
  violations: number;
  noScore: number;
  articles: ArticleRecord[];
}

/** Keeps only uuid, published_at, language and the queried symbol's score; counts scores that break the filter. */
export function extractArticles(data: readonly unknown[], companyId: string, symbol: string, query: ArticleRecord['query']):
  { articles: ArticleRecord[]; violations: number; noScore: number } {
  const articles: ArticleRecord[] = [];
  let violations = 0;
  let noScore = 0;
  for (const row of data) {
    if (!isRecord(row) || typeof row.uuid !== 'string' || !row.uuid || row.uuid.length > 200) continue;
    const entities = Array.isArray(row.entities) ? row.entities.filter(isRecord).filter(entity => entity.symbol === symbol) : [];
    const score = entities.length === 1 ? finite(entities[0]!.sentiment_score) : null;
    if (score === null) noScore += 1;
    else if (query === 'positive' ? score < SENTIMENT_THRESHOLD : query === 'negative' ? score > -SENTIMENT_THRESHOLD : false) violations += 1;
    articles.push({
      companyId, query, uuid: row.uuid,
      published_at: typeof row.published_at === 'string' && row.published_at.length <= 60 ? row.published_at : null,
      language: typeof row.language === 'string' && row.language.length <= 16 ? row.language : null, score,
    });
  }
  return { articles, violations, noScore };
}

export interface MarketauxCompanySummary {
  companyId: string;
  positive: number | null;
  negative: number | null;
  total: number | null;
  neutralOrUnscored: number | null;
  shares: { positive: number; negative: number; neutralOrUnscored: number } | null;
  perWeek: { positive: number | null; negative: number | null; total: number | null };
  violations: { positive: number; negative: number };
  noScore: number;
}

export function summarizeMarketaux(results: readonly MarketauxQueryResult[], weeks = 104): MarketauxCompanySummary[] {
  const ids = [...new Set(results.map(result => result.companyId))];
  return ids.map(companyId => {
    const mine = results.filter(result => result.companyId === companyId);
    const found = (query: MarketauxQueryResult['query']) => mine.find(result => result.query === query && result.code === 'ok')?.found ?? null;
    const positive = found('positive');
    const negative = found('negative');
    const total = found('total');
    const neutralOrUnscored = total !== null && positive !== null && negative !== null ? total - positive - negative : null;
    const perWeek = (value: number | null) => value === null ? null : round(value / weeks, 2);
    return {
      companyId, positive, negative, total, neutralOrUnscored,
      shares: total && neutralOrUnscored !== null ? {
        positive: round(positive! / total, 4), negative: round(negative! / total, 4), neutralOrUnscored: round(neutralOrUnscored / total, 4),
      } : null,
      perWeek: { positive: perWeek(positive), negative: perWeek(negative), total: perWeek(total) },
      violations: {
        positive: mine.filter(result => result.query === 'positive').reduce((sum, result) => sum + result.violations, 0),
        negative: mine.filter(result => result.query === 'negative').reduce((sum, result) => sum + result.violations, 0),
      },
      noScore: mine.reduce((sum, result) => sum + result.noScore, 0),
    };
  });
}

// ---------------------------------------------------------------- live runners

const KOSPI200_NAMES = new Set(['코스피200', 'KOSPI200']);
export function isKospi200Name(value: unknown): boolean {
  return typeof value === 'string' && KOSPI200_NAMES.has(value.normalize('NFKC').replace(/\s+/g, '').toUpperCase());
}

interface FscFetch { items: Json[]; totalCount: number | null; truncated: boolean }

async function fscCall(ctx: Context, call: PlannedCall): Promise<FscFetch | null> {
  const { record, outcome } = await perform(ctx, call);
  if (outcome.status === 401 || outcome.status === 403 || outcome.status === 429) ctx.stopped.add('fsc');
  if (outcome.text === null) return null;
  const parsed = parseFscBody(outcome.text);
  if (!parsed.ok) {
    if (outcome.code === 'ok') record.code = parsed.code;
    else record.providerCode = parsed.code;
    if (parsed.stop) ctx.stopped.add('fsc');
    return null;
  }
  record.providerCode = `resultCode:${parsed.resultCode}`;
  if (outcome.code !== 'ok') return null;
  return { items: parsed.items, totalCount: parsed.totalCount, truncated: parsed.totalCount !== null && parsed.totalCount > parsed.items.length };
}

function textField(value: unknown, max = 100): string | null {
  return typeof value === 'string' && value.length <= max ? value.trim() : typeof value === 'number' ? String(value) : null;
}

interface Distinct { key: unknown[]; count: number; first: string | null; last: string | null }
function distinctBy(items: readonly Json[], fields: readonly string[]): Distinct[] {
  const groups = new Map<string, Distinct>();
  for (const item of items) {
    const key = fields.map(field => textField(item[field]));
    const id = JSON.stringify(key);
    const date = fscDate(item.basDt);
    const group = groups.get(id) ?? { key, count: 0, first: null, last: null };
    group.count += 1;
    if (date && (!group.first || date < group.first)) group.first = date;
    if (date && (!group.last || date > group.last)) group.last = date;
    groups.set(id, group);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 50);
}

export interface FscSeriesReport {
  id: string;
  code: string;
  totalCount: number | null;
  returned: number;
  kept: number;
  truncated: boolean;
  identity: Distinct[];
  /** Identity of the rows the exact code / name filter dropped, so an unexpected code format stays visible. */
  dropped: Distinct[];
  series: FscSeriesSummary | null;
}

async function runFsc(ctx: Context, plan: PlannedCall[]): Promise<Json> {
  const calls = new Map(plan.filter(call => call.provider === 'fsc').map(call => [call.id, call]));
  const series: FscSeriesReport[] = [];
  const earliest: Json = {};
  const calendar: Record<string, CalendarCheck> = {};
  let etfItems: Json[] = [];
  let indexItems: Json[] = [];
  let indexNames: Distinct[] = [];
  let etfBaseIndex: Distinct[] = [];
  const keep = (id: string, code: string, fetched: FscFetch | null, filter: (item: Json) => boolean, identityFields: string[]): Json[] => {
    const call = ctx.calls[ctx.calls.length - 1]!;
    const items = fetched ? fetched.items.filter(filter) : [];
    series.push({ id, code, totalCount: fetched?.totalCount ?? null, returned: fetched?.items.length ?? 0, kept: items.length,
      truncated: fetched?.truncated ?? false, identity: distinctBy(items, identityFields),
      dropped: fetched ? distinctBy(fetched.items.filter(item => !filter(item)), identityFields) : [],
      series: fetched ? summarizeFscSeries(items) : null });
    if (fetched && call.code === 'ok' && items.length) {
      const dates = items.map(item => fscDate(item.basDt)).filter((date): date is string => !!date).sort();
      calendar[id] = crossCheckCalendar('KRX', dates, '2023-01-02', dates[dates.length - 1]!);
    }
    return items;
  };
  for (const [index, stock] of KR_STOCKS.entries()) {
    const id = `F${index + 1}`;
    const fetched = await fscCall(ctx, calls.get(id)!);
    keep(id, stock.code, fetched, item => item.srtnCd === stock.code, ['srtnCd', 'isinCd', 'itmsNm', 'mrktCtg']);
  }
  const etf = await fscCall(ctx, calls.get('F5')!);
  etfItems = keep('F5', KR_ETF, etf, item => item.srtnCd === KR_ETF, ['srtnCd', 'isinCd', 'itmsNm']);
  etfBaseIndex = distinctBy(etfItems, ['bssIdxIdxNm']);
  const index = await fscCall(ctx, calls.get('F6')!);
  indexNames = distinctBy(index?.items ?? [], ['idxNm', 'idxCsf', 'epyItmsCnt', 'basPntm', 'basIdx']);
  indexItems = keep('F6', 'KOSPI200', index, item => isKospi200Name(item.idxNm), ['idxNm', 'idxCsf']);
  const first = (fetched: FscFetch | null, filter: (item: Json) => boolean) => {
    const dates = (fetched?.items ?? []).filter(filter).map(item => fscDate(item.basDt)).filter((date): date is string => !!date).sort();
    return { code: ctx.calls[ctx.calls.length - 1]!.code, firstDate: dates[0] ?? null, rows: dates.length,
      returned: fetched?.items.length ?? 0, totalCount: fetched?.totalCount ?? null, truncated: fetched?.truncated ?? false };
  };
  earliest.F7 = first(await fscCall(ctx, calls.get('F7')!), item => item.srtnCd === '005930');
  earliest.F8 = first(await fscCall(ctx, calls.get('F8')!), item => item.srtnCd === KR_ETF);
  const f9 = await fscCall(ctx, calls.get('F9')!);
  earliest.F9 = { ...first(f9, item => isKospi200Name(item.idxNm)), names: distinctBy(f9?.items ?? [], ['idxNm', 'idxCsf', 'epyItmsCnt', 'basPntm', 'basIdx']) };
  let adjustment: Json = { skipped: true };
  const f7First = (earliest.F7 as { firstDate: string | null }).firstDate;
  if (f7First && f7First <= '2021-04-01') {
    const kakao = await fscCall(ctx, calls.get('F10')!);
    const items = (kakao?.items ?? []).filter(item => item.srtnCd === KAKAO);
    // Raw values are kept only for this adjustment window.
    const rows = sortedUnique(fscBars(items).bars);
    adjustment = { skipped: false, code: ctx.calls[ctx.calls.length - 1]!.code, rows, summary: summarizeFscSeries(items) };
  } else {
    skip(ctx, calls.get('F10')!, 'skipped_condition');
  }
  // ETF base-index close against the KOSPI 200 close on the same date.
  const indexClose = new Map(indexItems.map(item => [fscDate(item.basDt), parseNum(item.clpr)]));
  let matched = 0; let equal = 0; let maxAbsRel = 0;
  for (const item of etfItems) {
    const date = fscDate(item.basDt);
    const base = parseNum(item.bssIdxClpr);
    const close = date ? indexClose.get(date) : undefined;
    if (base === null || close === undefined || close === null || close === 0) continue;
    matched += 1;
    if (Math.abs(base - close) < 1e-6) equal += 1;
    maxAbsRel = Math.max(maxAbsRel, Math.abs(base / close - 1));
  }
  return { series, earliest, adjustment, indexNames, etfBaseIndex,
    etfVsIndex: { matchedDates: matched, equal, maxAbsRel: round(maxAbsRel) }, calendar };
}

async function massiveCall(ctx: Context, call: PlannedCall): Promise<Json | null> {
  const { record, outcome } = await perform(ctx, call);
  if (outcome.status === 429 || outcome.status === 401) ctx.stopped.add('massive');
  if (outcome.text === null) return null;
  let json: unknown;
  try { json = JSON.parse(outcome.text); } catch {
    if (outcome.code === 'ok') record.code = 'bad_json';
    return null;
  }
  if (isRecord(json)) {
    const requestId = codeToken(json.request_id);
    if (requestId) record.requestId = requestId;
    const status = codeToken(json.status);
    if (status) record.providerCode = status;
  }
  if (outcome.code !== 'ok') return null;
  if (!isRecord(json)) { record.code = 'bad_json'; return null; }
  return json;
}
const resultsOf = (json: Json | null): unknown[] => json && Array.isArray(json.results) ? json.results : [];

async function runMassive(ctx: Context, plan: PlannedCall[]): Promise<Json> {
  const calls = new Map(plan.filter(call => call.provider === 'massive').map(call => [call.id, call]));
  const series: Json[] = [];
  const calendar: Record<string, CalendarCheck> = {};
  let aaplBars: MassiveBar[] = [];
  for (const [index, ticker] of US_TICKERS.entries()) {
    const id = `M${index + 1}`;
    const json = await massiveCall(ctx, calls.get(id)!);
    const results = resultsOf(json);
    const summary = json ? summarizeMassiveAggs(results) : null;
    series.push({ id, ticker, code: ctx.calls[ctx.calls.length - 1]!.code, resultsCount: json ? finite(json.resultsCount) : null,
      // Only the flag itself: the summary never carries a provider value it has not checked.
      adjusted: json && typeof json.adjusted === 'boolean' ? json.adjusted : null, nextUrlPresent: !!json && typeof json.next_url === 'string', summary });
    if (json) calendar[id] = crossCheckCalendar('NASDAQ', massiveBars(results).map(bar => bar.date), ctx.dates.massiveFrom, ctx.dates.massiveTo);
    if (ticker === 'AAPL') aaplBars = massiveBars(results);
  }
  const openClose: Json[] = [];
  for (const id of ['M7', 'M8']) {
    const call = calls.get(id)!;
    if (call.conditional) { skip(ctx, call, 'skipped_condition'); continue; }
    const date = call.path.slice(call.path.lastIndexOf('/') + 1);
    const json = await massiveCall(ctx, call);
    openClose.push({ id, code: ctx.calls[ctx.calls.length - 1]!.code,
      ...compareOpenClose(aaplBars.find(bar => bar.date === date) ?? null, json), date });
  }
  const dividendsJson = await massiveCall(ctx, calls.get('M9')!);
  const dividends = { code: ctx.calls[ctx.calls.length - 1]!.code, nextUrlPresent: !!dividendsJson && typeof dividendsJson.next_url === 'string',
    ...summarizeDividends(resultsOf(dividendsJson)) };
  const splitsJson = await massiveCall(ctx, calls.get('M10')!);
  const splitResults = resultsOf(splitsJson);
  const splits = { code: ctx.calls[ctx.calls.length - 1]!.code, nextUrlPresent: !!splitsJson && typeof splitsJson.next_url === 'string',
    ...summarizeSplits(splitResults) };
  const chosen = pickSplit(splitResults, ctx.dates.massiveFrom, ctx.dates.massiveTo);
  let adjustment: Json = { skipped: true };
  if (chosen) {
    const path = `/v2/aggs/ticker/${chosen.ticker}/range/1/day/${addDays(chosen.executionDate, -10)}/${addDays(chosen.executionDate, 10)}`;
    const adjusted = await massiveCall(ctx, { ...calls.get('M11')!, path, conditional: undefined });
    const adjustedCode = ctx.calls[ctx.calls.length - 1]!.code;
    const raw = await massiveCall(ctx, { ...calls.get('M12')!, path, conditional: undefined });
    adjustment = { skipped: false, codes: [adjustedCode, ctx.calls[ctx.calls.length - 1]!.code],
      ...compareSplitWindow(chosen, resultsOf(adjusted), resultsOf(raw)) };
  } else {
    skip(ctx, calls.get('M11')!, 'skipped_condition');
    skip(ctx, calls.get('M12')!, 'skipped_condition');
  }
  return { series, openClose, dividends, splits, adjustment, calendar };
}

async function marketauxCall(ctx: Context, call: PlannedCall): Promise<Json | null> {
  const { record, outcome } = await perform(ctx, call);
  if ([401, 402, 403, 429].includes(outcome.status ?? 0)) ctx.stopped.add('marketaux');
  if (outcome.text === null) return null;
  let json: unknown;
  try { json = JSON.parse(outcome.text); } catch {
    if (outcome.code === 'ok') record.code = 'bad_json';
    return null;
  }
  if (isRecord(json) && isRecord(json.error)) {
    const code = codeToken(json.error.code);
    if (code) record.providerCode = code;
  }
  if (outcome.code !== 'ok') return null;
  if (!isRecord(json) || !Array.isArray(json.data) || json.error !== undefined) { record.code = 'bad_json'; return null; }
  return json;
}

async function runMarketaux(ctx: Context, plan: PlannedCall[]): Promise<{ summary: Json; articles: ArticleRecord[] }> {
  const calls = plan.filter(call => call.provider === 'marketaux');
  const lookup = calls.find(call => call.id === 'A1')!;
  const newsCalls = calls.filter(call => call.id !== 'A1');
  const symbols = new Map<string, string>(companies.filter(item => item.region === 'US').map(item => [item.id, item.symbol]));
  const verification: EntityVerification[] = [];
  const pending = new Set(KR_STOCKS.map(stock => stock.companyId));
  const lookupJson = await marketauxCall(ctx, lookup);
  let symbolsList: 'supported' | 'unsupported' | 'unknown' = 'unknown';
  if (lookupJson) {
    const data = lookupJson.data as unknown[];
    const results = KR_STOCKS.map(stock => verifyKrEntity(data, stock.companyId, stock.code, 'symbols'));
    symbolsList = results.some(result => result.verified) ? 'supported' : 'unsupported';
    for (const result of results.filter(item => item.verified)) {
      verification.push(result);
      symbols.set(result.companyId, result.symbol!);
      pending.delete(result.companyId);
    }
  }
  // Per-code fallback only while every possibly usable company's two news calls still fit the cap.
  for (const stock of KR_STOCKS.filter(item => pending.has(item.companyId))) {
    const possible = symbols.size + pending.size;
    if (ctx.stopped.has('marketaux') || ctx.budget.remaining('marketaux') < 1 + 2 * possible) {
      verification.push({ companyId: stock.companyId, symbol: null, verified: false, via: null, candidates: 0, name: null, exchange: null });
      pending.delete(stock.companyId);
      continue;
    }
    const json = await marketauxCall(ctx, { id: `A1-${stock.code}`, provider: 'marketaux', path: '/v1/entity/search',
      params: { search: stock.code, countries: 'kr', types: 'equity' }, purpose: 'fallback', companyId: stock.companyId });
    const result = json ? verifyKrEntity(json.data as unknown[], stock.companyId, stock.code, 'search')
      : { companyId: stock.companyId, symbol: null, verified: false, via: 'search' as const, candidates: 0, name: null, exchange: null };
    verification.push(result);
    if (result.verified) symbols.set(stock.companyId, result.symbol!);
    pending.delete(stock.companyId);
  }
  const results: MarketauxQueryResult[] = [];
  const articles: ArticleRecord[] = [];
  for (const call of newsCalls) {
    const companyId = call.companyId!;
    const symbol = symbols.get(companyId);
    const query: ArticleRecord['query'] = call.params.sentiment_gte ? 'positive' : call.params.sentiment_lte ? 'negative' : 'total';
    if (!symbol) { skip(ctx, call, 'skipped_unverified'); continue; }
    const json = await marketauxCall(ctx, { ...call, params: { ...call.params, symbols: symbol } });
    const code = ctx.calls[ctx.calls.length - 1]!.code;
    const meta = json && isRecord(json.meta) ? json.meta : {};
    const extracted = json ? extractArticles(json.data as unknown[], companyId, symbol, query) : { articles: [], violations: 0, noScore: 0 };
    results.push({ id: call.id, companyId, query, code, found: finite(meta.found), returned: finite(meta.returned), ...extracted });
    articles.push(...extracted.articles);
  }
  return {
    summary: {
      window: { from: ctx.dates.w0, to: ctx.dates.w1, weeks: 104 }, symbolsList, verification,
      queries: results.map(({ articles: _articles, ...rest }) => rest), companies: summarizeMarketaux(results),
    },
    articles,
  };
}

// ---------------------------------------------------------------- entry

export interface HistoryCheckOptions { live?: boolean; only?: readonly HistoryProvider[] }
export interface HistoryCheckOutput { name: string; content: string }
export interface HistoryCheckResult {
  mode: 'dry_run' | 'live';
  plan: PlannedCall[];
  summary: Json | null;
  outputs: HistoryCheckOutput[];
}

export function parseArgs(argv: readonly string[]): HistoryCheckOptions | { error: string } {
  let live = false;
  let only: HistoryProvider[] | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--live') { live = true; continue; }
    const value = arg === '--only' ? argv[++index] : arg.startsWith('--only=') ? arg.slice(7) : undefined;
    if (value === undefined) return { error: 'unknown_argument' };
    const names = value.split(',').map(name => name.trim()).filter(Boolean);
    if (!names.length || names.some(name => !(PROVIDERS as readonly string[]).includes(name))) return { error: 'unknown_provider' };
    only = names as HistoryProvider[];
  }
  return { live, ...(only ? { only } : {}) };
}

function shortList(list: readonly string[], max = 10): string {
  if (!list.length) return '없음';
  return list.length <= max ? list.join(', ') : `${list.slice(0, max).join(', ')} 외 ${list.length - max}건`;
}
const paramText = (params: Record<string, string>) => Object.entries(params).map(([name, value]) => `${name}=${value}`).join('&');
const pct = (value: number | null) => value === null ? '-' : `${round(value * 100, 2)}%`;

function printPlan(out: (line: string) => void, plan: PlannedCall[]): void {
  out('계획한 호출 (시험 실행이라 보내지 않음):');
  for (const call of plan) {
    out(`${call.id} [${call.provider}] ${call.path}?${paramText(call.params)} · ${call.purpose}${call.conditional ? ` · (조건부: ${call.conditional})` : ''}`);
  }
  for (const provider of PROVIDERS) {
    const mine = plan.filter(call => call.provider === provider);
    if (!mine.length) continue;
    out(`계획 호출 수 ${provider}: ${mine.length}회 (조건부 ${mine.filter(call => call.conditional).length}회) · 상한 ${CAPS[provider]}회`);
  }
}

function printSummary(out: (line: string) => void, ctx: Context, fsc: Json | null, massive: Json | null, marketaux: Json | null): void {
  const used = ctx.budget.snapshot();
  out(`호출 사용량: ${PROVIDERS.map(provider => `${provider} ${used[provider].used}/${used[provider].cap}`).join(' · ')}`);
  const failed = ctx.calls.filter(call => call.code !== 'ok');
  if (failed.length) out(`성공하지 않은 호출: ${shortList(failed.map(call => `${call.id}=${call.code}${call.providerCode ? `(${call.providerCode})` : ''}`))}`);
  if (fsc) {
    for (const report of fsc.series as FscSeriesReport[]) {
      const s = report.series;
      const cal = (fsc.calendar as Record<string, CalendarCheck>)[report.id];
      if (!s) { out(`[금융위] ${report.id} ${report.code}: 결과 없음`); continue; }
      out(`[금융위] ${report.id} ${report.code}: ${report.kept}행(전체 ${report.totalCount ?? '-'}${report.truncated ? ', 잘림' : ''}) ${s.firstDate ?? '-'}~${s.lastDate ?? '-'}` +
        ` · 순서 ${s.order} · 중복 ${s.duplicateDates.count} · 주말 ${s.weekendDates.count} · 무효 ${s.invalid.count} · 거래정지형 ${s.haltLike}` +
        ` · 30% 초과 ${s.extremeMoves.length} · 전일종가+vs 일치 ${s.basePrice.equal}/${s.basePrice.pairs}` +
        (cal ? ` · 달력 누락 ${cal.missing.count} 추가 ${cal.extra.count} 미검증 ${cal.unverified.count}` : ''));
      if (!report.kept && report.returned) {
        out(`  코드·이름이 맞는 행이 없음. 받은 ${report.returned}행의 식별값: ${shortList(report.dropped.map(item => `${item.key.join('/')}×${item.count}`))}`);
      }
      if (s.basePrice.mismatches.length) out(`  vs 불일치일: ${shortList(s.basePrice.mismatches.map(item => `${item.date}(계수 ${item.factor})`))}`);
      if (cal?.missing.count) out(`  달력에는 있으나 자료 없음: ${shortList(cal.missing.items)}`);
      if (cal?.extra.count) out(`  자료는 있으나 달력상 휴장: ${shortList(cal.extra.items)}`);
    }
    const earliest = fsc.earliest as Record<string, { firstDate: string | null; code: string; truncated: boolean }>;
    // Rows may come newest first, so a cut-off response can hide the true start date.
    const start = (item: { firstDate: string | null; truncated: boolean } | undefined) =>
      `${item?.firstDate ?? '-'}${item?.truncated ? '(잘림: 실제 시작일은 더 이를 수 있음)' : ''}`;
    out(`[금융위] 가장 이른 날짜: 주식 ${start(earliest.F7)} · ETF ${start(earliest.F8)} · 지수 ${start(earliest.F9)}`);
    out(`[금융위] 지수 이름(F6): ${shortList((fsc.indexNames as Distinct[]).map(item => `${item.key.join('/')} ${item.first}~${item.last}`))}`);
    out(`[금융위] ETF 기초지수: ${shortList((fsc.etfBaseIndex as Distinct[]).map(item => `${item.key[0]} ${item.first}~${item.last}`))}`);
    const etfVsIndex = fsc.etfVsIndex as { matchedDates: number; equal: number; maxAbsRel: number };
    out(`[금융위] ETF 기초지수 종가 대 지수 종가: ${etfVsIndex.equal}/${etfVsIndex.matchedDates}일 일치 · 최대 차 ${pct(etfVsIndex.maxAbsRel)}`);
    const adjustment = fsc.adjustment as { skipped: boolean; summary?: FscSeriesSummary };
    out(adjustment.skipped ? '[금융위] F10 카카오 분할 시험: 조건 미충족으로 건너뜀'
      : `[금융위] F10 카카오 분할 시험: vs 불일치일 ${shortList((adjustment.summary?.basePrice.mismatches ?? []).map(item => `${item.date} 원시 비율 ${item.rawRatio} · 계수 ${item.factor}`))}`);
  }
  if (massive) {
    for (const item of massive.series as { id: string; ticker: string; code: string; summary: MassiveAggsSummary | null }[]) {
      const s = item.summary;
      const cal = (massive.calendar as Record<string, CalendarCheck>)[item.id];
      if (!s) { out(`[Massive] ${item.id} ${item.ticker}: 결과 없음 (${item.code})`); continue; }
      out(`[Massive] ${item.id} ${item.ticker}: ${s.count}개 ${s.firstDate ?? '-'}~${s.lastDate ?? '-'} · ET 시각 ${Object.entries(s.etClockTimes).map(([time, count]) => `${time}×${count}`).join(',') || '-'}` +
        ` · 무효 ${s.invalid.count} · 50% 초과 ${s.extremeMoves.length} · 거래량 0 ${s.zeroVolume.count}` +
        (cal ? ` · 달력 누락 ${cal.missing.count} 추가 ${cal.extra.count}` : ''));
      if (cal?.missing.count) out(`  달력에는 있으나 자료 없음: ${shortList(cal.missing.items)}`);
      if (cal?.extra.count) out(`  자료는 있으나 달력상 휴장: ${shortList(cal.extra.items)}`);
    }
    for (const item of massive.openClose as (OpenCloseComparison & { id: string; code: string })[]) {
      out(`[Massive] ${item.id} AAPL ${item.date ?? '-'} 공식 시가·종가 비교(${item.code}): 시가 차 ${item.openDiff ?? '-'} · 종가 차 ${item.closeDiff ?? '-'}` +
        ` · 시가=공식 ${item.openEqualsOfficial ?? '-'} · 시가=프리마켓 ${item.openEqualsPreMarket ?? '-'} · 종가=공식 ${item.closeEqualsOfficial ?? '-'}`);
    }
    const dividends = massive.dividends as CorporateActionSummary & { code: string };
    out(`[Massive] 배당(${dividends.code}): ${dividends.count}건 · 조정 계수 필드 ${dividends.factor.field ?? '없음'} · 필드 ${shortList(dividends.fields, 20)}`);
    const splits = massive.splits as CorporateActionSummary & { code: string; forwardRatio2Plus: number };
    out(`[Massive] 분할(${splits.code}): ${splits.count}건 · 2:1 이상 정분할 ${splits.forwardRatio2Plus}건 · 조정 계수 필드 ${splits.factor.field ?? '없음'}`);
    const adjustment = massive.adjustment as { skipped: boolean } & Partial<SplitWindow>;
    out(adjustment.skipped ? '[Massive] 분할 조정 시험: 대상 없음으로 건너뜀'
      : `[Massive] 분할 조정 시험 ${adjustment.split!.ticker} ${adjustment.split!.executionDate} ${adjustment.split!.splitTo}:${adjustment.split!.splitFrom}` +
        ` · 미조정/조정 종가 비율 분할 전 ${adjustment.medianRatioBefore ?? '-'} · 후 ${adjustment.medianRatioAfter ?? '-'}`);
  }
  if (marketaux) {
    const verification = marketaux.verification as EntityVerification[];
    out(`[Marketaux] 한국 종목 식별: symbols 목록 ${marketaux.symbolsList} · 확인 ${verification.filter(item => item.verified).length}/${KR_STOCKS.length}` +
      ` (${verification.map(item => `${item.companyId}=${item.verified ? item.symbol : '미확인'}`).join(', ')})`);
    for (const item of marketaux.companies as MarketauxCompanySummary[]) {
      out(`[Marketaux] ${item.companyId}: 긍정 ${item.positive ?? '-'} · 부정 ${item.negative ?? '-'} · 전체 ${item.total ?? '-'} · 중립·미점수 ${item.neutralOrUnscored ?? '-'}` +
        ` · 비중 ${item.shares ? `${pct(item.shares.positive)}/${pct(item.shares.negative)}/${pct(item.shares.neutralOrUnscored)}` : '-'}` +
        ` · 주당 긍정 ${item.perWeek.positive ?? '-'} 부정 ${item.perWeek.negative ?? '-'} · 필터 위반 ${item.violations.positive + item.violations.negative} · 점수 없음 ${item.noScore}`);
    }
  }
}

/** A deliberate stop with a fixed code, as opposed to an unexpected internal error. */
class CheckAborted extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'CheckAborted'; }
}

/** Provider text (index names, say) reaches the terminal without control or direction-override characters. */
function terminalSafe(line: string): string {
  return line.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ');
}

export async function runHistoryCheck(deps: HistoryCheckDeps, options: HistoryCheckOptions = {}): Promise<HistoryCheckResult> {
  const keys: Record<HistoryProvider, string | undefined> = {
    fsc: deps.env.KR_PRICE_API_KEY?.trim() || undefined,
    massive: deps.env.US_PRICE_API_KEY?.trim() || undefined,
    marketaux: deps.env.MARKETAUX_API_TOKEN?.trim() || undefined,
  };
  const redact = createRedactor(Object.values(keys));
  const out = (line: string) => deps.print(terminalSafe(redact(line)));
  // Settings under which Node itself would expose the keys: NODE_DEBUG=fetch or undici prints every request path,
  // query keys included, straight to stderr; NODE_TLS_REJECT_UNAUTHORIZED=0 sends them over unverified TLS.
  const unsafeEnv = deps.env.NODE_DEBUG?.trim() ? { code: 'node_debug_set', name: 'NODE_DEBUG' }
    : deps.env.NODE_TLS_REJECT_UNAUTHORIZED?.trim() === '0' ? { code: 'tls_unverified', name: 'NODE_TLS_REJECT_UNAUTHORIZED' } : null;
  try {
    const nowMs = deps.now();
    const dates = deriveDates(nowMs);
    const only = options.only ?? PROVIDERS;
    const plan = buildPlan(dates, only);
    const keysPresent = Object.fromEntries(PROVIDERS.map(provider => [ENV_KEYS[provider], !!keys[provider]]));
    out(`[history:check] ${options.live ? '실제 호출 모드 (--live)' : '시험 실행 (네트워크 호출 0회, 파일 쓰기 없음)'}`);
    out(`기준 시각 ${dates.nowIso} · KST ${dates.kstToday} · ET ${dates.etToday} · 금융위 endBasDt ${dates.fscEnd} · Massive ${dates.massiveFrom}~${dates.massiveTo} · Marketaux ${dates.w0}~${dates.w1} UTC`);
    out(`키 설정 여부: ${Object.entries(keysPresent).map(([name, present]) => `${name}=${present}`).join(' · ')}`);
    if (!options.live) {
      printPlan(out, plan);
      out('실제 점검은 --live 로 실행합니다. 일부 제공자만: --only fsc,massive,marketaux');
      if (unsafeEnv) out(`주의: ${unsafeEnv.name}가 설정되어 있어 --live는 실행되지 않습니다. ${unsafeEnv.name}를 비운 뒤 실행하세요.`);
      return { mode: 'dry_run', plan, summary: null, outputs: [] };
    }
    if (unsafeEnv) {
      out(`${unsafeEnv.name} 설정에서는 Node가 키를 그대로 출력하거나 검증되지 않은 연결로 보낼 수 있어 호출하지 않습니다. ${unsafeEnv.name}를 비운 뒤 다시 실행하세요.`);
      throw new CheckAborted(unsafeEnv.code);
    }
    const ctx: Context = { deps, dates, budget: createBudget(), redact, keys, calls: [], stopped: new Set(), lastStart: {} };
    // A provider without a key records every planned call as not_configured and makes none.
    const configured = (provider: HistoryProvider) => {
      if (!only.includes(provider)) return false;
      if (keys[provider]) return true;
      for (const call of plan.filter(item => item.provider === provider)) skip(ctx, call, 'not_configured');
      return false;
    };
    const fsc = configured('fsc') ? await runFsc(ctx, plan) : null;
    const massive = configured('massive') ? await runMassive(ctx, plan) : null;
    const news = configured('marketaux') ? await runMarketaux(ctx, plan) : null;
    const summary: Json = {
      generatedAt: dates.nowIso, mode: 'live', keysPresent, dates, budgets: ctx.budget.snapshot(), calls: ctx.calls,
      fsc: fsc ? { ...fsc, calendar: undefined } : null, massive: massive ? { ...massive, calendar: undefined } : null,
      marketaux: news?.summary ?? null,
      calendar: { fsc: fsc?.calendar ?? null, massive: massive?.calendar ?? null },
    };
    printSummary(out, ctx, fsc, massive, news?.summary ?? null);
    const stamp = dates.nowIso.replace(/[-:]/g, '').slice(0, 13);
    const outputs: HistoryCheckOutput[] = [{ name: `summary-${stamp}Z.json`, content: redact(JSON.stringify(summary, null, 2)) }];
    if (news) outputs.push({ name: `marketaux-articles-${stamp.slice(0, 8)}.json`, content: redact(JSON.stringify(news.articles, null, 2)) });
    out(`저장할 파일: ${outputs.map(output => `.history-check/${output.name}`).join(', ')}`);
    return { mode: 'live', plan, summary: JSON.parse(redact(JSON.stringify(summary))) as Json, outputs };
  } catch (error) {
    // Internal failures surface as a fixed code; the original error text never leaves this function.
    const name = error instanceof BudgetExceeded ? 'budget' : error instanceof CheckAborted ? error.code : 'internal_error';
    out(`[history:check] 중단: ${name}`);
    throw new Error(name);
  }
}
