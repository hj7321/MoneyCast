/**
 * Contract of the optional AI reading of a free goal's description. The
 * server sends only the description to a model, keeps an answer only when
 * every figure is quoted from the description, and both clients check the
 * response again before showing it.
 */
import { findGoalPeriod, findTravelers, findTripLength, isGoalCategory, parseKoreanAmount, type GoalCategory, type GoalTextFact, type GoalTextFacts } from './goal-text.js';

export const GOAL_CLARIFY_PROMPT_VERSION = 'goal-clarify-v1';
export const GOAL_CLARIFY_MAX_LENGTH = 200;
export const GOAL_TITLE_MAX_LENGTH = 20;

export type GoalClarifyStatus = 'ok' | 'not_configured' | 'rate_limited' | 'timeout' | 'error' | 'invalid_input';
export interface GoalAiProvider { id: 'gemini' | 'cloudflare'; label: string; model: string }
/** Whether the server will read descriptions with a model, and which ones, in the order tried. */
export interface GoalAiAvailability { enabled: boolean; providers: GoalAiProvider[]; promptVersion: string; maxLength: number }
export interface GoalClarification {
  status: GoalClarifyStatus;
  promptVersion: string;
  provider?: GoalAiProvider;
  category?: GoalCategory;
  title?: string;
  facts?: GoalTextFacts;
  retryAt?: string;
  message?: string;
}

const STATUSES: readonly GoalClarifyStatus[] = ['ok', 'not_configured', 'rate_limited', 'timeout', 'error', 'invalid_input'];
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const compact = (value: string) => value.normalize('NFKC').replace(/\s+/g, '');

/** Normalized so spacing differences between the model's quote and the description do not matter. */
export function isQuotedFrom(quote: string, description: string): boolean {
  const needle = compact(quote);
  return needle.length > 0 && compact(description).includes(needle);
}

function isProvider(value: unknown): value is GoalAiProvider {
  return isRecord(value) && (value.id === 'gemini' || value.id === 'cloudflare') && isText(value.label, 40) && isText(value.model, 80);
}

export function isGoalAiAvailability(value: unknown): value is GoalAiAvailability {
  return isRecord(value) && typeof value.enabled === 'boolean' && Array.isArray(value.providers) && value.providers.length <= 2 &&
    value.providers.every(isProvider) && (!value.enabled || value.providers.length > 0) &&
    isText(value.promptVersion, 40) && typeof value.maxLength === 'number' && Number.isSafeInteger(value.maxLength) && value.maxLength > 0;
}

/** A fact is kept only when its words appear in the description and read as the stated value. */
function factMatches(fact: unknown, description: string, reads: (text: string, value: number) => boolean): fact is GoalTextFact {
  return isRecord(fact) && typeof fact.value === 'number' && Number.isFinite(fact.value) && isText(fact.text, 40) &&
    isQuotedFrom(fact.text, description) && reads(fact.text, fact.value);
}

/**
 * The response shape, and, given the description that was sent, that every
 * figure is quoted from it. Used by the server on its own answer and by the
 * clients on what arrives. A calendar month ("내년 3월") is counted from the
 * reader's own month, so only its range is compared, not the exact count.
 */
export function isGoalClarification(value: unknown, description: string, now: Date): value is GoalClarification {
  if (!isRecord(value) || typeof value.status !== 'string' || !STATUSES.includes(value.status as GoalClarifyStatus) ||
      !isText(value.promptVersion, 40)) return false;
  if (value.retryAt !== undefined && !(typeof value.retryAt === 'string' && Number.isFinite(Date.parse(value.retryAt)))) return false;
  if (value.message !== undefined && !isText(value.message, 200)) return false;
  if (value.status !== 'ok') return value.provider === undefined || isProvider(value.provider);
  if (!isProvider(value.provider) || !isGoalCategory(value.category)) return false;
  if (value.title !== undefined && !isText(value.title, GOAL_TITLE_MAX_LENGTH)) return false;
  const facts = value.facts;
  if (!isRecord(facts)) return false;
  const readers: Record<string, (text: string, value: number) => boolean> = {
    amount: (text, amount) => /[만억조원]/.test(text) && parseKoreanAmount(text) === amount && amount <= 1_000_000_000_000,
    months: (text, months) => Number.isInteger(months) && months >= 1 && months <= 600 && findGoalPeriod(text, now) !== null,
    travelers: (text, count) => findTravelers(text)?.value === count,
    nights: (text, count) => findTripLength(text)?.nights.value === count,
    days: (text, count) => findTripLength(text)?.days?.value === count,
  };
  return Object.entries(facts).every(([key, fact]) => key in readers && factMatches(fact, description, readers[key]!));
}

export const GOAL_PERSONAL_DATA_NOTICE = '전화번호·이메일·주민등록번호·카드·계좌번호처럼 보이는 내용이 있어 AI로 보내지 않아요. 지우면 보낼 수 있어요.';

/** Shown next to the AI button, before anything is sent. */
export function goalAiNotice(providers: readonly GoalAiProvider[]): string {
  const names = providers.map(provider => provider.label).join(' 또는 ');
  const gemini = providers.some(provider => provider.id === 'gemini')
    ? ' Google Gemini 무료 등급에서는 입력이 Google 제품 개선에 쓰이고 사람이 검토할 수 있어요.' : '';
  return `AI로 정리하면 설명 문장만 MoneyCast 서버를 거쳐 ${names}로 보내요. 시드머니·납입액 같은 계산 숫자는 보내지 않아요. 이름·연락처·계좌번호는 쓰지 마세요.${gemini} AI 정리는 틀릴 수 있어요.`;
}

/** Why an AI answer is not shown; every case ends in the questions the person answers directly. */
export function goalAiFailure(result: GoalClarification, formatTime: (iso: string) => string): string {
  if (result.status === 'invalid_input' && result.message) return result.message;
  if (result.status === 'rate_limited') return `AI 정리 한도에 도달했어요${result.retryAt ? `(${formatTime(result.retryAt)} 이후 다시 시도할 수 있어요)` : ''}. 아래 질문에 직접 답해 주세요.`;
  if (result.status === 'timeout') return 'AI가 제시간에 답하지 않았어요. 아래 질문에 직접 답해 주세요.';
  if (result.status === 'not_configured') return '지금은 AI 정리를 쓸 수 없어요. 아래 질문에 직접 답해 주세요.';
  return 'AI 답을 확인하지 못했어요. 아래 질문에 직접 답해 주세요.';
}

/** Where the card's information came from. */
export function goalFoundSource(provider?: GoalAiProvider): string {
  return provider ? `AI(${provider.label})가 정리했어요. 틀릴 수 있으니 확인한 뒤 적용해 주세요.` : '이 기기에서 규칙으로 찾았어요. 서버로 보내지 않았어요.';
}
