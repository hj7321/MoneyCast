import { hasPersonalData } from './goal-text.js';
import { deriveBaselineSignal } from './news-history.js';
import { formatKstTime, formatSessionDate } from './news-history-view.js';
import type { NewsAnalysis } from './index.js';

/**
 * Contract and fixed text of the AI question feature ("AI에게 물어보기", plan ch. 7). Like
 * news-history.ts: no Node or DOM APIs and no clock reads, because the mobile runtime loads this file
 * too. The server answers with codes; every sentence the screen shows comes from here. No text
 * promises a direction, names a hit rate or a probability, recommends buying or selling, or uses an arrow.
 */

export const NEWS_ASK_VERSION = 'news-ask-v1';
/** String.length of the question after trim. */
export const ASK_QUESTION_MAX_LENGTH = 300;
export const ASK_BODY_LIMIT_BYTES = 4_096;
/** The model's text with its {F1} tokens, before the server fills them. */
export const ASK_RAW_TEXT_MAX_LENGTH = 300;
/** The filled text on the wire. */
export const ASK_TEXT_MAX_LENGTH = 800;
export const ASK_EVIDENCE_MAX = 3;
export const ASK_LIMITS_MAX = 5;

export type AskProviderId = 'gemini';
export interface AskProvider { id: AskProviderId; label: string }
export interface AskAvailability { version: typeof NEWS_ASK_VERSION; enabled: boolean; providers: AskProvider[]; maxLength: number }
/** All a client ever sends: no earlier turns, so everyone asking the same question gets an answer from the same data. */
export interface AskRequest { companyId: string; question: string }

export const ASK_REFUSAL_REASONS = ['advice', 'target_price', 'personal', 'other_company', 'unlisted_company', 'off_topic'] as const;
export type AskRefusalReason = (typeof ASK_REFUSAL_REASONS)[number];
export const ASK_INVALID_REASONS = ['empty', 'too_long', 'personal_data', 'too_large', 'bad_request', 'unknown_company'] as const;
export type AskInvalidReason = (typeof ASK_INVALID_REASONS)[number];
export const ASK_UNAVAILABLE_REASONS = ['timeout', 'model_limit', 'error', 'news_unavailable'] as const;
export type AskUnavailableReason = (typeof ASK_UNAVAILABLE_REASONS)[number];

/** A link the answer rests on: a current article or a past case. publishedAt is a timestamp or a YYYY-MM-DD date. */
export interface AskEvidence { title: string; source: string; url: string; publishedAt: string }

type V = { version: typeof NEWS_ASK_VERSION };
/** Every status but answered carries codes only; the screen maps them to the fixed texts below. */
export type AskAnswer =
  | V & { status: 'answered'; companyId: string; by: 'ai' | 'template'; text: string; evidence: AskEvidence[]; limits: string[]; asOf: string }
  | V & { status: 'refused'; companyId: string; reason: AskRefusalReason }
  | V & { status: 'invalid_input'; reason: AskInvalidReason }
  | V & { status: 'rate_limited'; scope: 'ip' | 'daily'; retryAt?: string }
  | V & { status: 'not_configured' }
  | V & { status: 'unavailable'; reason: AskUnavailableReason };

// ---------------------------------------------------------------------------
// Parsers. Both rebuild the value field by field, so unknown keys never pass through, and never throw.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!;
}

/** A timestamp with a zone whose fields are all in range. */
function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  return match !== null && isCalendarDate(value.slice(0, 10)) &&
    Number(match[1]) < 24 && Number(match[2]) < 60 && Number(match[3]) < 60 &&
    Number.isFinite(Date.parse(value));
}

function isHttpsUrl(value: unknown): value is string {
  if (!isText(value, 2000)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** One evidence link as the screen may show it, rebuilt; null when any field is out of bounds. */
export function parseAskEvidence(value: unknown): AskEvidence | null {
  if (!isRecord(value) || !isText(value.title, 300) || !isText(value.source, 100) || !isHttpsUrl(value.url) ||
      !(isCalendarDate(value.publishedAt) || isTimestamp(value.publishedAt))) return null;
  return { title: value.title, source: value.source, url: value.url, publishedAt: value.publishedAt };
}

export function parseAskAvailability(value: unknown): AskAvailability | null {
  try {
    if (!isRecord(value) || value.version !== NEWS_ASK_VERSION || typeof value.enabled !== 'boolean' ||
        !Array.isArray(value.providers) || value.providers.length > 2 ||
        typeof value.maxLength !== 'number' || !Number.isSafeInteger(value.maxLength) || value.maxLength <= 0) return null;
    const providers: AskProvider[] = [];
    for (const item of value.providers) {
      if (!isRecord(item) || item.id !== 'gemini' || !isText(item.label, 40)) return null;
      providers.push({ id: 'gemini', label: item.label });
    }
    if (value.enabled && providers.length === 0) return null;
    return { version: NEWS_ASK_VERSION, enabled: value.enabled, providers, maxLength: value.maxLength };
  } catch {
    return null;
  }
}

export function parseAskAnswer(value: unknown, expectedCompanyId: string): AskAnswer | null {
  try {
    if (!isRecord(value) || value.version !== NEWS_ASK_VERSION) return null;
    const version = NEWS_ASK_VERSION;
    switch (value.status) {
      case 'answered': {
        if (value.companyId !== expectedCompanyId || !oneOf(value.by, ['ai', 'template'] as const) ||
            !isText(value.text, ASK_TEXT_MAX_LENGTH) || !Array.isArray(value.evidence) || value.evidence.length > ASK_EVIDENCE_MAX ||
            !Array.isArray(value.limits) || value.limits.length < 1 || value.limits.length > ASK_LIMITS_MAX ||
            !value.limits.every(line => isText(line, 300)) || !isTimestamp(value.asOf)) return null;
        const evidence: AskEvidence[] = [];
        for (const item of value.evidence) {
          const parsed = parseAskEvidence(item);
          if (parsed === null) return null;
          evidence.push(parsed);
        }
        return {
          version, status: 'answered', companyId: expectedCompanyId, by: value.by, text: value.text, evidence,
          limits: [...value.limits] as string[], asOf: value.asOf,
        };
      }
      case 'refused':
        if (value.companyId !== expectedCompanyId || !oneOf(value.reason, ASK_REFUSAL_REASONS)) return null;
        return { version, status: 'refused', companyId: expectedCompanyId, reason: value.reason };
      case 'invalid_input':
        return oneOf(value.reason, ASK_INVALID_REASONS) ? { version, status: 'invalid_input', reason: value.reason } : null;
      case 'rate_limited':
        if (!oneOf(value.scope, ['ip', 'daily'] as const) || !(value.retryAt === undefined || isTimestamp(value.retryAt))) return null;
        return { version, status: 'rate_limited', scope: value.scope, ...(value.retryAt === undefined ? {} : { retryAt: value.retryAt }) };
      case 'not_configured':
        return { version, status: 'not_configured' };
      case 'unavailable':
        return oneOf(value.reason, ASK_UNAVAILABLE_REASONS) ? { version, status: 'unavailable', reason: value.reason } : null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The question
// ---------------------------------------------------------------------------

/**
 * hasPersonalData, also through the separators a phone or account number is written with: dots, dashes of any width,
 * slashes, underscores, brackets and invisible characters (010.1234.5678, 010–1234–5678). A Seoul number such as
 * 02-123-4567 has nine digits, one under hasPersonalData's ten, so a dashed phone pattern counts as well. The server
 * checks every question with it before anything is sent to a model.
 */
export function askHasPersonalData(question: string): boolean {
  if (hasPersonalData(question)) return true;
  const joined = question.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/[.·\u2010-\u2015\u2212_\/()[\]]/g, '-');
  return hasPersonalData(joined) || /(?<!\d)0\d{1,2}-+\d{3,4}-+\d{4}(?!\d)/.test(joined);
}

// ---------------------------------------------------------------------------
// Fixed text
// ---------------------------------------------------------------------------

export const ASK_TITLE = 'AI에게 물어보기';
export const ASK_LABEL = 'AI 답변 · 수치는 코드 계산';
export const ASK_TEMPLATE_LABEL = '정해진 문장 · 수치는 코드 계산';

export function askIntro(companyName: string): string {
  return `${companyName}의 뉴스, 과거 사례, 전망의 근거, 용어를 화면의 자료로 설명합니다. 사거나 팔지는 답하지 않습니다.`;
}

export const ASK_INPUT_LABEL = '질문';
export const ASK_PLACEHOLDER = '예: 왜 판단 유보인가요?';
export const ASK_SUBMIT_LABEL = '질문하기';
export const ASK_SUGGESTIONS_LABEL = '추천 질문';
export const ASK_REFUSAL_LEAD = '이런 질문을 할 수 있습니다';
export const ASK_EVIDENCE_TITLE = '근거 기사';
export const ASK_MEMORY_NOTE = '대화는 이 화면에만 남고 새로 고치면 사라집니다.';
export const ASK_LOADING_TEXT = '답을 준비하고 있습니다';
export const ASK_UNAVAILABLE_TEXT = '지금은 질문 기능을 쓸 수 없습니다';
export const ASK_EMPTY_TEXT = '질문을 적어 주세요.';
export const ASK_TOO_LONG_TEXT = '질문은 300자 이내로 적어 주세요.';
export const ASK_PERSONAL_DATA_TEXT = '전화번호·이메일·계좌번호처럼 보이는 내용이 있어 보내지 않았습니다. 그 부분을 지우고 다시 질문해 주세요.';

export const ASK_RATE_LIMITED_TEXTS: Record<'ip' | 'daily', string> = {
  ip: '짧은 시간에 질문이 많았습니다. 잠시 뒤 다시 질문해 주세요.',
  daily: '오늘 질문 한도에 도달했습니다. 내일 다시 질문해 주세요.',
};

export const ASK_REFUSAL_TEXTS: Record<AskRefusalReason, string> = {
  advice: '사거나 팔지, 언제 얼마나 투자할지는 답하지 않습니다. 이 기능은 화면에 있는 뉴스와 과거 사례, 전망의 근거를 설명합니다.',
  target_price: '목표 가격이나 앞으로의 주가는 답하지 않습니다. 화면에 있는 뉴스와 과거 사례, 전망의 근거를 물어봐 주세요.',
  personal: '개인 상황에 맞춘 투자 상담은 하지 않습니다. 누구에게나 같은 화면의 자료만 설명합니다.',
  other_company: '지금 고른 회사에 대해서만 답합니다. 다른 회사는 회사 목록에서 고른 뒤 물어봐 주세요.',
  unlisted_company: '목록에 있는 회사의 뉴스만 설명합니다. 목록에 없는 회사나 다른 종목은 답하지 않습니다.',
  off_topic: '이 기능은 고른 회사의 뉴스, 과거 사례, 전망의 근거, 용어만 설명합니다.',
};

export const ASK_ANSWER_NOTE = 'AI가 화면의 자료로 쓴 설명이며 틀릴 수 있습니다. 매수·매도 권유가 아닙니다.';
export const ASK_TEMPLATE_NOTE = 'AI 답을 쓰지 않고 화면의 자료로 만든 정해진 문장입니다. 매수·매도 권유가 아닙니다.';

/** '뉴스 기준 11/27(금) 17:00 KST'; the year is shown only when it differs from contextYear. */
export function askNewsTimeLine(asOf: string, contextYear: number): string {
  return `뉴스 기준 ${formatKstTime(asOf, contextYear)}`;
}

/** The company each provider belongs to, as the privacy line names it. */
export const ASK_PROVIDER_NAMES: Record<AskProviderId, string> = { gemini: 'Google' };

/** With Gemini: '질문은 AI 제공사(Google)로 전송됩니다. 개인정보를 적지 마세요.' */
export function askPrivacyLine(providers: readonly AskProvider[]): string {
  const names = [...new Set(providers.map(provider => ASK_PROVIDER_NAMES[provider.id]).filter(Boolean))].join('·');
  return `질문은 AI 제공사${names ? `(${names})` : ''}로 전송됩니다. 개인정보를 적지 마세요.`;
}

export function askInvalidText(reason: AskInvalidReason): string {
  switch (reason) {
    case 'empty': return ASK_EMPTY_TEXT;
    case 'too_long':
    case 'too_large': return ASK_TOO_LONG_TEXT;
    case 'personal_data': return ASK_PERSONAL_DATA_TEXT;
    case 'bad_request':
    case 'unknown_company': return ASK_UNAVAILABLE_TEXT;
  }
}

/** '연합뉴스 · 11/24(화) 09:00 KST' for an article, '연합뉴스 · 10/1(목)' for a past case's date. */
export function askEvidenceMeta(e: AskEvidence, contextYear: number): string {
  return `${e.source} · ${/^\d{4}-\d{2}-\d{2}$/.test(e.publishedAt) ? formatSessionDate(e.publishedAt) : formatKstTime(e.publishedAt, contextYear)}`;
}

/** Always four distinct questions, chosen by the situation on screen; none of them is ever refused. */
export function askSuggestions(a: Pick<NewsAnalysis, 'status' | 'positiveFactors' | 'negativeFactors' | 'historyAvailable'>): string[] {
  const history = a.historyAvailable === true;
  return [
    deriveBaselineSignal(a) === 'withheld' ? '왜 판단 유보인가요?' : '이 판단은 어떤 기사에서 나왔나요?',
    history ? '과거 비슷한 뉴스 뒤에는 어땠나요?' : '최근 기사는 주로 어떤 내용인가요?',
    history ? "'시장 대비'가 무슨 뜻인가요?" : "'근거 수준'은 무슨 뜻인가요?",
    '이 자료는 언제 기준이고 어떤 한계가 있나요?',
  ];
}

// ---------------------------------------------------------------------------
// Term dictionary for explain_term. Model-facing, so no label or text holds a digit.
// ---------------------------------------------------------------------------

export const ASK_TERM_IDS = [
  'trading_day', 'next_trading_day', 'next_week', 'session', 'open_close', 'overnight', 'prev_close_change', 'benchmark',
  'market_relative', 'return', 'entry_exit', 'baseline', 'verdict', 'integrated', 'withheld', 'evidence_level', 'sample',
  'independent_windows', 'median', 'past_up_share', 'interval', 'validation', 'backfill', 'stats_not_public', 'unrelated',
  'adjusted_price',
] as const;
export type AskTermId = (typeof ASK_TERM_IDS)[number];

const term = (label: string, text: string) => Object.freeze({ label, text });

export const ASK_TERMS: Readonly<Record<AskTermId, { label: string; text: string }>> = Object.freeze({
  trading_day: term('거래일', '주식시장이 열리는 날입니다. 주말과 공휴일 같은 휴장일은 빠집니다.'),
  next_trading_day: term('다음 거래일', "지금 뒤로 시장이 처음 열리는 날입니다. 금요일 밤이나 연휴 전날에는 '내일'과 다른 날이 됩니다."),
  next_week: term('다음 주(다음 다섯 거래일)', '기준 시각 뒤로 시장이 다섯 번 열리는 기간입니다. 휴장일이 끼면 달력의 다음 주보다 길어집니다.'),
  session: term('장(정규 거래 시간)', '하루 중 정규 거래가 이뤄지는 시간입니다. 한국과 미국은 시간이 다르고, 정규 시간 밖의 거래는 반영하지 않습니다.'),
  open_close: term('시가·종가', '그날 정규장의 첫 거래 가격과 마지막 거래 가격입니다.'),
  overnight: term('밤사이 뉴스', '직전 장 마감부터 다음 장 시작 전까지 나온 뉴스입니다. 다음 거래일 전망은 이 뉴스로 만듭니다.'),
  prev_close_change: term('전일 대비', '다음 거래일 종가를 바로 앞 거래일 종가와 비교한 등락입니다. 장이 열릴 때 이미 벌어지는 가격 차이가 들어 있습니다.'),
  benchmark: term('벤치마크', '시장 전체 흐름을 대신하는 비교 기준입니다. 예를 들어 시장 대표 ETF를 씁니다.'),
  market_relative: term('시장 대비', '종목 수익률에서 같은 기간 벤치마크 수익률을 뺀 값입니다. 시장 전체가 함께 움직인 몫을 빼고 보기 위해 씁니다.'),
  return: term('수익률', '출발 가격(진입)에서 도착 가격(종료)까지 가격이 변한 비율입니다. 거래비용과 세금은 빼지 않았습니다.'),
  entry_exit: term('진입·종료', '수익률을 계산할 때의 출발 가격과 도착 가격입니다. 기사가 나온 뒤의 가격만 씁니다.'),
  baseline: term('기준선', '지금 있는 현재 기사 기반 판단입니다. 과거 사례를 더하기 전의 판단입니다.'),
  verdict: term('과거 사례 판정', '같은 방향 뉴스가 있던 과거 기간과 나머지 기간을 시장 대비 결과로 비교한 결과입니다. 지지·약화·상충·뚜렷한 차이 없음·근거 부족 중 하나입니다.'),
  integrated: term('통합 전망', '기준선에 과거 사례 판정을 합친 참고 전망입니다. 과거 사례는 판단을 낮출 수만 있고 높이지는 않습니다.'),
  withheld: term('판단 유보', '긍정 기사와 부정 기사가 함께 있거나 기사가 적어 방향을 정하지 않은 상태입니다.'),
  evidence_level: term('근거 수준', '최근 기사 수와 기사 분류가 서로 엇갈리는지에 따라 붙이는 표시입니다. 전망이 맞을지를 나타내지 않습니다.'),
  sample: term('표본(사건 주·사건 일)', '과거 판정에 쓴 기간의 모음입니다. 같은 방향 뉴스만 있던 기간을 사건 기간, 나머지를 비교 기간으로 셉니다.'),
  independent_windows: term('겹치지 않는 구간', '서로 기간이 겹치지 않는 사례만 센 수입니다. 겹치는 사례를 여러 번 세면 근거가 실제보다 많아 보이기 때문입니다.'),
  median: term('중앙값', '값을 크기순으로 늘어놓았을 때 가운데 값입니다. 아주 크거나 작은 값 하나에 덜 흔들립니다.'),
  past_up_share: term('과거 상승 비중(미래 확률 아님)', '과거 사례 가운데 오른 사례의 비중입니다. 앞으로 오를지를 뜻하지 않습니다.'),
  interval: term('구간(불확실성 범위)', '표본에서 계산한 차이가 놓일 수 있는 범위입니다. 범위가 넓을수록 불확실합니다.'),
  validation: term('검증 전 · 참고 정보', '이 전망 방식이 실제로 나아졌는지 아직 평가하지 않았다는 표시입니다. 참고로만 보세요.'),
  backfill: term('과거 데이터 포함 · 시점 미보증', '나중에 거슬러 모은 과거 기사가 섞여 있어, 그때 실제로 언제 알려졌는지 확인할 수 없다는 표시입니다.'),
  stats_not_public: term('통계 비공개', '주가 데이터 제공자의 이용 허가를 확인하기 전이라 과거 사례 통계를 보여 주지 않는다는 뜻입니다. 뉴스로 만든 전망은 그대로 보입니다.'),
  unrelated: term('관련성 낮은 기사', '두 AI가 모두 이 회사 기사가 아니라고 본 기사입니다. 목록 아래에 접어 두고 요인 집계에서 뺍니다.'),
  adjusted_price: term('수정주가', '주식 분할이나 배당으로 생긴 가격 변화를 반영해 과거 가격을 고친 값입니다.'),
});
