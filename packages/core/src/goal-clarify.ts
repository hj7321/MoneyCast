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
    amount: (text, amount) => parseKoreanAmount(text) === amount && amount <= 1_000_000_000_000,
    months: (text, months) => Number.isInteger(months) && months >= 1 && months <= 600 && findGoalPeriod(text, now) !== null,
    travelers: (text, count) => findTravelers(text)?.value === count,
    nights: (text, count) => findTripLength(text)?.nights.value === count,
    days: (text, count) => findTripLength(text)?.days?.value === count,
  };
  return Object.entries(facts).every(([key, fact]) => key in readers && factMatches(fact, description, readers[key]!));
}
