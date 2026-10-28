/**
 * Goals the person chooses to keep on this device. Only what the calculator
 * needs is kept: the goal type's entries without the free goal's
 * description, a typed target, the price-rise setting and the calculator
 * fields. Storage can hold anything, so every entry is checked field by
 * field when it is read back.
 */
import {
  CAR_CONDITIONS, GOAL_DISTRICT_MAX_LENGTH, GOAL_ITEM_LIMIT, GOAL_LABEL_MAX_LENGTH, GOAL_NAME_MAX_LENGTH, GOAL_TYPES, HOME_REGIONS, HOUSING_TYPES,
  createGoalDrafts, describeGoalResult, resolveGoalTarget,
  type GoalDrafts, type GoalInflationDraft, type GoalPlannerAction, type GoalPlannerState, type GoalType,
} from './goals.js';

export const SAVED_GOAL_LIMIT = 5;
/** Versioned so a later format can be told apart instead of misread. */
export const SAVED_GOALS_KEY = 'moneycast.goals.v1';
/** Longest text a number field keeps; the fields themselves report invalid numbers. */
const NUMBER_TEXT_MAX = 30;

export interface SavedCalculatorFields { initial: string; monthly: string; annualRate: string; months: string }
export interface SavedGoal {
  id: string;
  savedAt: string;
  goal: GoalType;
  draft: GoalDrafts[GoalType];
  override?: string;
  inflation: GoalInflationDraft;
  calculator: SavedCalculatorFields;
}

export function createSavedGoal(state: GoalPlannerState, calculator: SavedCalculatorFields, id: string, now: Date): SavedGoal {
  const draft = state.goal === 'free' ? { ...state.drafts.free, note: '' } : state.drafts[state.goal];
  const override = state.overrides[state.goal];
  return {
    id, savedAt: now.toISOString(), goal: state.goal, draft, ...(override === undefined ? {} : { override }),
    inflation: { ...state.inflation }, calculator: { ...calculator },
  };
}

export function loadSavedGoalAction(saved: SavedGoal): GoalPlannerAction {
  return { type: 'load', goal: saved.goal, draft: saved.draft, ...(saved.override === undefined ? {} : { override: saved.override }), inflation: saved.inflation };
}

/** "결혼 자금 · 상세 계산 2,500만 원", computed again from the saved entries. */
export function describeSavedGoal(saved: SavedGoal, format: (amount: number) => string): string {
  const drafts = { ...createGoalDrafts(), [saved.goal]: saved.draft } as GoalDrafts;
  return describeGoalResult(saved.goal, drafts, resolveGoalTarget(saved.goal, drafts, saved.override), format);
}

export function serializeSavedGoals(goals: readonly SavedGoal[]): string {
  return JSON.stringify({ version: 1, goals: goals.slice(0, SAVED_GOAL_LIMIT) });
}

type Rule = 'number' | { text: number } | 'flag' | readonly string[];
const CHOICE_EMPTY = '';
const PURCHASE_RULES: Record<string, Rule> = {
  price: 'number', initialBy: ['rate', 'amount'], initialRate: 'number', initialAmount: 'number', includeCosts: 'flag', costs: 'number',
};
const DRAFT_RULES: Record<Exclude<GoalType, 'free'>, Record<string, Rule>> = {
  home: {
    scope: ['full', 'equity', 'initial'], ...PURCHASE_RULES, loan: 'number',
    region: [CHOICE_EMPTY, ...HOME_REGIONS], district: { text: GOAL_DISTRICT_MAX_LENGTH }, housing: [CHOICE_EMPTY, ...HOUSING_TYPES.map(type => type.id)],
  },
  car: {
    scope: ['full', 'initial'], ...PURCHASE_RULES,
    model: { text: GOAL_LABEL_MAX_LENGTH }, condition: [CHOICE_EMPTY, ...CAR_CONDITIONS.map(condition => condition.id)],
  },
  travel: {
    destination: { text: GOAL_LABEL_MAX_LENGTH }, method: ['total', 'items'], total: 'number', travelers: 'number', nights: 'number',
    days: 'number', flight: 'number', lodging: 'number', daily: 'number', other: 'number',
  },
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isShortText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;

function follows(value: unknown, rule: Rule): boolean {
  if (rule === 'number') return isShortText(value, NUMBER_TEXT_MAX);
  if (rule === 'flag') return typeof value === 'boolean';
  if (Array.isArray(rule)) return typeof value === 'string' && rule.includes(value);
  return isShortText(value, (rule as { text: number }).text);
}

/** Known fields only; a missing one takes its default, and an invalid one rejects the whole goal. */
function readDraft(goal: GoalType, value: unknown): GoalDrafts[GoalType] | null {
  if (!isRecord(value)) return null;
  const defaults = createGoalDrafts();
  if (goal === 'free') {
    const { name = '', method = 'direct', items } = value;
    if (!isShortText(name, GOAL_NAME_MAX_LENGTH) || !follows(method, ['direct', 'items', 'undecided'])) return null;
    if (items !== undefined && !(Array.isArray(items) && items.length >= 1 && items.length <= GOAL_ITEM_LIMIT &&
        items.every(item => isRecord(item) && isShortText(item.label, GOAL_LABEL_MAX_LENGTH) && isShortText(item.amount, NUMBER_TEXT_MAX)))) return null;
    return {
      name, method: method as GoalDrafts['free']['method'], note: '',
      items: items === undefined ? defaults.free.items : (items as Array<{ label: string; amount: string }>).map(item => ({ label: item.label, amount: item.amount })),
    };
  }
  const draft: Record<string, unknown> = { ...defaults[goal] };
  for (const [key, rule] of Object.entries(DRAFT_RULES[goal])) {
    if (value[key] === undefined) continue;
    if (!follows(value[key], rule)) return null;
    draft[key] = value[key];
  }
  return draft as unknown as GoalDrafts[GoalType];
}

function readSavedGoal(value: unknown): SavedGoal | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !/^[\w-]{1,40}$/.test(value.id)) return null;
  if (typeof value.savedAt !== 'string' || !Number.isFinite(Date.parse(value.savedAt))) return null;
  const goal = GOAL_TYPES.find(type => type.id === value.goal)?.id;
  if (!goal) return null;
  const draft = readDraft(goal, value.draft);
  if (!draft) return null;
  if (value.override !== undefined && !isShortText(value.override, NUMBER_TEXT_MAX)) return null;
  const { inflation, calculator } = value;
  if (!isRecord(inflation) || typeof inflation.on !== 'boolean' || !isShortText(inflation.rate, NUMBER_TEXT_MAX)) return null;
  const fields = ['initial', 'monthly', 'annualRate', 'months'] as const;
  if (!isRecord(calculator) || !fields.every(field => isShortText(calculator[field], NUMBER_TEXT_MAX))) return null;
  return {
    id: value.id, savedAt: value.savedAt, goal, draft, ...(value.override === undefined ? {} : { override: value.override as string }),
    inflation: { on: inflation.on, rate: inflation.rate }, calculator: Object.fromEntries(fields.map(field => [field, calculator[field]])) as unknown as SavedCalculatorFields,
  };
}

/** Whatever storage returned, as valid saved goals; anything unreadable is left out. */
export function parseSavedGoals(stored: string | null): SavedGoal[] {
  if (!stored) return [];
  let value: unknown;
  try { value = JSON.parse(stored); } catch { return []; }
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.goals)) return [];
  const goals: SavedGoal[] = [];
  for (const item of value.goals) {
    const saved = readSavedGoal(item);
    if (saved && !goals.some(goal => goal.id === saved.id)) goals.push(saved);
    if (goals.length === SAVED_GOAL_LIMIT) break;
  }
  return goals;
}
