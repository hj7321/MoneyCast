/**
 * Goal types and the details that turn them into a target amount. Every
 * amount is the user's own entry, or a sum, difference or share of their
 * entries; nothing here knows or estimates a price.
 */

export type GoalType = 'free' | 'home' | 'car' | 'travel';

export interface GoalTypeDefinition {
  id: GoalType;
  name: string;
  /** Shown, and labelled as an example, until the user enters their own figures. */
  exampleAmount: number;
}

export const GOAL_TYPES: readonly GoalTypeDefinition[] = [
  { id: 'free', name: '자유 목표', exampleAmount: 50_000_000 },
  { id: 'home', name: '내 집 마련', exampleAmount: 300_000_000 },
  { id: 'car', name: '자동차', exampleAmount: 40_000_000 },
  { id: 'travel', name: '여행', exampleAmount: 10_000_000 },
];

export const GOAL_NAME_MAX_LENGTH = 20;
export const GOAL_LABEL_MAX_LENGTH = 30;
export const GOAL_NOTE_MAX_LENGTH = 200;
export const GOAL_ITEM_LIMIT = 5;
/** A district is typed rather than picked: a label only, like the region. */
export const GOAL_DISTRICT_MAX_LENGTH = 20;
export const TRAVELERS_LIMIT = 20;
export const TRIP_NIGHTS_LIMIT = 365;
/** Same ceiling as the calculator's amount fields. */
const AMOUNT_LIMIT = 1_000_000_000_000;

/** These fill in the goal name only; choosing one never changes an amount. */
export const FREE_GOAL_NAME_SUGGESTIONS = ['결혼 자금', '비상금', '학비', '이사 비용', '노후 준비'] as const;
/** The 17 metropolitan and provincial governments; a label only, never priced. */
export const HOME_REGIONS = [
  '서울', '부산', '대구', '인천', '광주', '대전', '울산', '세종', '경기',
  '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주',
] as const;
export const HOUSING_TYPES = [
  { id: 'apartment', label: '아파트' }, { id: 'villa', label: '빌라·연립' }, { id: 'officetel', label: '오피스텔' },
  { id: 'house', label: '단독주택' }, { id: 'other', label: '기타' },
] as const;
export type HousingType = typeof HOUSING_TYPES[number]['id'];
export const CAR_CONDITIONS = [{ id: 'new', label: '신차' }, { id: 'used', label: '중고차' }] as const;
export type CarCondition = typeof CAR_CONDITIONS[number]['id'];

export interface GoalItemDraft { label: string; amount: string }
export interface FreeGoalDraft {
  name: string;
  /** direct: the target field holds the amount. items: the rows add up to it. undecided: no goal comparison yet. */
  method: 'direct' | 'items' | 'undecided';
  items: GoalItemDraft[];
  note: string;
}
interface PurchaseDraft {
  price: string;
  /** Initial funds as a share of the price, or as an amount the user already knows. */
  initialBy: 'rate' | 'amount';
  initialRate: string;
  initialAmount: string;
  includeCosts: boolean;
  costs: string;
}
export interface HomeGoalDraft extends PurchaseDraft {
  /** full: the whole price. equity: the price less the planned loan. initial: a deposit or other initial funds. */
  scope: 'full' | 'equity' | 'initial';
  loan: string;
  region: string;
  district: string;
  housing: HousingType | '';
}
export interface CarGoalDraft extends PurchaseDraft {
  scope: 'full' | 'initial';
  model: string;
  condition: CarCondition | '';
}
export interface TravelGoalDraft {
  destination: string;
  method: 'total' | 'items';
  total: string;
  travelers: string;
  nights: string;
  /** Empty means nights + 1. */
  days: string;
  /** Per person, round trip. */
  flight: string;
  /** Per night for the whole party. */
  lodging: string;
  /** Per person per day. */
  daily: string;
  other: string;
}
/** Text exactly as typed, per goal type, so switching types never loses an entry. */
export interface GoalDrafts { free: FreeGoalDraft; home: HomeGoalDraft; car: CarGoalDraft; travel: TravelGoalDraft }

export const HOME_SCOPE_LABELS: Record<HomeGoalDraft['scope'], string> = { full: '집값 전체', equity: '자기자본', initial: '초기 자금' };
export const CAR_SCOPE_LABELS: Record<CarGoalDraft['scope'], string> = { full: '차량 가격 전체', initial: '초기 자금' };

/** MoneyCast holds no price data, so each type says where its amounts must come from. */
export const GOAL_SOURCE_NOTES: Record<GoalType, string> = {
  free: '금액을 직접 정하거나, 필요한 항목으로 나눠 합산해요.',
  home: 'MoneyCast는 집값 시세를 제공하지 않아요. 실거래가나 분양 공고에서 확인한 가격을 입력해 주세요.',
  car: 'MoneyCast는 차량 가격 정보를 제공하지 않아요. 견적서나 가격표의 금액을 입력해 주세요.',
  travel: 'MoneyCast는 여행 경비 정보를 제공하지 않아요. 예약 화면 등에서 확인한 금액을 원화로 입력해 주세요. 성수기에는 요금이 달라질 수 있어요.',
};
export const HOME_SCOPE_NOTES: Record<HomeGoalDraft['scope'], string> = {
  full: '집값 전부를 모아요.',
  equity: '매입 가격에서 대출 예정 금액을 뺀 자기자본을 모아요. 대출 가능 여부와 한도는 계산하지 않아요.',
  initial: '계약금처럼 먼저 필요한 돈을 모아요.',
};
export const CAR_SCOPE_NOTES: Record<CarGoalDraft['scope'], string> = {
  full: '일시불로 살 금액을 모아요.',
  initial: '계약금·선수금처럼 출고 전에 필요한 돈을 모아요. 할부·리스 조건은 계산하지 않아요.',
};

export type GoalTargetSource = 'example' | 'manual' | 'details' | 'undecided';
export const GOAL_SOURCE_LABELS: Record<GoalTargetSource, string> = {
  example: '예시 금액', manual: '직접 입력', details: '상세 계산', undecided: '미정',
};

export interface GoalFormulaLine {
  label: string;
  amount: number;
  /** -1 for an amount taken away, such as a planned loan. */
  sign: 1 | -1;
}

export interface GoalTargetResolution {
  source: GoalTargetSource;
  /** null: no amount yet, so the calculator compares against no goal. NaN: an entry is not a valid amount. */
  amount: number | null;
  /** The entered amounts that add up to a derived target. */
  lines: GoalFormulaLine[];
  /** Optional amounts left empty and counted as zero. */
  zeroed: string[];
  /** Required entries that are still empty. */
  missing: string[];
  /** Messages for invalid entries, keyed by draft field (`items.0.amount` for a free-goal row). */
  errors: Record<string, string>;
}

const exampleAmount = (type: GoalType) => GOAL_TYPES.find(item => item.id === type)!.exampleAmount;

export function goalTypeName(type: GoalType): string {
  return GOAL_TYPES.find(item => item.id === type)!.name;
}

/** Example amounts are written with the client's own number format. */
export function createGoalDrafts(formatAmount: (amount: number) => string = String): GoalDrafts {
  const purchase = (type: GoalType): PurchaseDraft => ({
    price: formatAmount(exampleAmount(type)), initialBy: 'rate', initialRate: '', initialAmount: '', includeCosts: false, costs: '',
  });
  return {
    free: { name: '', method: 'direct', items: [{ label: '', amount: '' }], note: '' },
    home: { scope: 'full', ...purchase('home'), loan: '', region: '', district: '', housing: '' },
    car: { scope: 'full', ...purchase('car'), model: '', condition: '' },
    travel: {
      destination: '', method: 'total', total: formatAmount(exampleAmount('travel')),
      travelers: '1', nights: '', days: '', flight: '', lodging: '', daily: '', other: '',
    },
  };
}

/** Empty text is "not entered" (null); anything else must be a plain number, commas allowed. */
export function parseGoalNumber(text: string): number | null {
  const cleaned = text.replace(/[,\s]/g, '');
  return cleaned === '' ? null : Number(cleaned);
}

/** 을/를 and 은/는 follow whether the label's last Hangul syllable ends in a consonant. */
function particle(label: string, withFinal: string, withoutFinal: string): string {
  for (let index = label.length - 1; index >= 0; index -= 1) {
    const code = label.charCodeAt(index) - 0xac00;
    if (code >= 0 && code <= 11171) return code % 28 === 0 ? withoutFinal : withFinal;
  }
  return withFinal;
}

function collector() {
  const errors: Record<string, string> = {};
  const missing: string[] = [];
  const zeroed: string[] = [];
  const read = (key: string, text: string, label: string, required: boolean, check: (value: number) => string | null) => {
    const value = parseGoalNumber(text);
    if (value === null) {
      if (required) missing.push(label);
      return null;
    }
    const message = check(value);
    if (message) {
      errors[key] = message;
      return null;
    }
    return value;
  };
  const amount = (key: string, text: string, label: string, required: boolean) =>
    read(key, text, label, required, value =>
      !Number.isFinite(value) ? `${label}${particle(label, '을', '를')} 숫자로 입력해 주세요.`
        : value < 0 ? `${label}${particle(label, '은', '는')} 0원 이상이어야 합니다.`
          : value > AMOUNT_LIMIT ? `${label}${particle(label, '은', '는')} 1조 원 이하로 입력해 주세요.` : null);
  return {
    errors, missing, zeroed, amount,
    /** An optional amount left empty still counts, as zero, and is reported as such. */
    optionalAmount(key: string, text: string, label: string) {
      const value = amount(key, text, label, false);
      if (value === null && !errors[key]) zeroed.push(label);
      return value ?? 0;
    },
    count(key: string, text: string, label: string, unit: string, min: number, max: number, required: boolean) {
      return read(key, text, label, required, value => Number.isInteger(value) && value >= min && value <= max
        ? null : `${label}${particle(label, '은', '는')} ${min}~${max}${unit} 사이의 정수로 입력해 주세요.`);
    },
    rate(key: string, text: string, label: string) {
      return read(key, text, label, true, value => Number.isFinite(value) && value > 0 && value <= 100
        ? null : `${label}${particle(label, '은', '는')} 0% 초과 100% 이하로 입력해 주세요.`);
    },
  };
}
type Collector = ReturnType<typeof collector>;

function finish(c: Collector, lines: GoalFormulaLine[], example: boolean): GoalTargetResolution {
  const base = { lines: [], zeroed: [], missing: c.missing, errors: c.errors };
  if (Object.keys(c.errors).length) return { ...base, source: 'details', amount: Number.NaN };
  if (c.missing.length) return { ...base, source: 'undecided', amount: null };
  const total = lines.reduce((sum, line) => sum + line.sign * line.amount, 0);
  if (total > AMOUNT_LIMIT) {
    return { ...base, source: 'details', amount: Number.NaN, errors: { total: '목표 금액이 1조 원을 넘습니다. 입력한 금액을 줄여 주세요.' } };
  }
  return { source: example ? 'example' : 'details', amount: total, lines, zeroed: c.zeroed, missing: [], errors: {} };
}

/** Whole price, price less a loan, or initial funds, plus optional acquisition costs. */
function purchaseTarget(draft: HomeGoalDraft | CarGoalDraft, type: 'home' | 'car'): GoalTargetResolution {
  const c = collector();
  const priceLabel = type === 'home' ? '예상 매입 가격' : '예상 차량 가격';
  const knownInitial = draft.scope === 'initial' && draft.initialBy === 'amount';
  const price = c.amount('price', draft.price, priceLabel, !knownInitial);
  const lines: GoalFormulaLine[] = [];
  if (draft.scope === 'full' && price !== null) lines.push({ label: type === 'home' ? '매입 가격' : '차량 가격', amount: price, sign: 1 });
  if (draft.scope === 'equity') {
    const loan = c.amount('loan', (draft as HomeGoalDraft).loan, '대출 예정 금액', true);
    if (price !== null && loan !== null && loan > price) c.errors.loan = '대출 예정 금액이 매입 가격보다 클 수 없어요.';
    else if (price !== null && loan !== null) lines.push({ label: '매입 가격', amount: price, sign: 1 }, { label: '대출 예정 금액', amount: loan, sign: -1 });
  }
  if (draft.scope === 'initial' && !knownInitial) {
    const rate = c.rate('initialRate', draft.initialRate, '초기 자금 비율');
    if (price !== null && rate !== null) lines.push({ label: `초기 자금(${type === 'home' ? '매입' : '차량'} 가격의 ${rate}%)`, amount: price * rate / 100, sign: 1 });
  }
  if (knownInitial) {
    const initial = c.amount('initialAmount', draft.initialAmount, '초기 자금', true);
    if (price !== null && initial !== null && initial > price) c.errors.initialAmount = `초기 자금이 ${type === 'home' ? '매입' : '차량'} 가격보다 클 수 없어요.`;
    else if (initial !== null) lines.push({ label: '초기 자금', amount: initial, sign: 1 });
  }
  if (draft.includeCosts) {
    const costs = c.optionalAmount('costs', draft.costs, '부대비용');
    if (costs > 0) lines.push({ label: '부대비용', amount: costs, sign: 1 });
  }
  return finish(c, lines, draft.scope === 'full' && !draft.includeCosts && price === exampleAmount(type));
}

function travelTarget(draft: TravelGoalDraft): GoalTargetResolution {
  const c = collector();
  if (draft.method === 'total') {
    const total = c.amount('total', draft.total, '총 예산', true);
    return finish(c, total === null ? [] : [{ label: '총 예산', amount: total, sign: 1 }], total === exampleAmount('travel'));
  }
  const entered = (text: string) => parseGoalNumber(text) !== null;
  const travelers = c.count('travelers', draft.travelers, '인원', '명', 1, TRAVELERS_LIMIT, true);
  const days = c.count('days', draft.days, '일 수', '일', 1, TRIP_NIGHTS_LIMIT + 1, false);
  // Lodging is priced per night; daily costs need nights only when the days are not entered.
  const needsNights = entered(draft.lodging) || (entered(draft.daily) && !entered(draft.days));
  const nights = c.count('nights', draft.nights, '박 수', '박', 0, TRIP_NIGHTS_LIMIT, needsNights);
  if (nights !== null && days !== null && days < nights) c.errors.days = '일 수는 박 수보다 작을 수 없어요.';
  const tripDays = days ?? (nights === null ? null : nights + 1);
  if (![draft.flight, draft.lodging, draft.daily, draft.other].some(entered)) c.missing.push('여행 경비');
  const flight = c.optionalAmount('flight', draft.flight, '항공권');
  const lodging = c.optionalAmount('lodging', draft.lodging, '숙박비');
  const daily = c.optionalAmount('daily', draft.daily, '현지 경비');
  const other = c.optionalAmount('other', draft.other, '기타 비용');
  const lines: GoalFormulaLine[] = [];
  if (flight > 0 && travelers !== null) lines.push({ label: `항공권(1인 × ${travelers}명)`, amount: flight * travelers, sign: 1 });
  if (lodging > 0 && nights !== null) lines.push({ label: `숙박(${nights}박)`, amount: lodging * nights, sign: 1 });
  if (daily > 0 && travelers !== null && tripDays !== null) {
    lines.push({ label: `현지 경비(${travelers}명 × ${tripDays}일)`, amount: daily * travelers * tripDays, sign: 1 });
  }
  if (other > 0) lines.push({ label: '기타 비용', amount: other, sign: 1 });
  return finish(c, lines, false);
}

function freeTarget(draft: FreeGoalDraft): GoalTargetResolution {
  const c = collector();
  if (draft.method === 'direct') return finish(c, [{ label: '목표 금액', amount: exampleAmount('free'), sign: 1 }], true);
  if (draft.method === 'undecided') return { source: 'undecided', amount: null, lines: [], zeroed: [], missing: [], errors: {} };
  const lines: GoalFormulaLine[] = [];
  draft.items.slice(0, GOAL_ITEM_LIMIT).forEach((item, index) => {
    const amount = c.amount(`items.${index}.amount`, item.amount, `항목 ${index + 1} 금액`, false);
    if (amount !== null) lines.push({ label: item.label.trim().slice(0, GOAL_LABEL_MAX_LENGTH) || `항목 ${index + 1}`, amount, sign: 1 });
  });
  if (lines.length === 0 && Object.keys(c.errors).length === 0) c.missing.push('구성 항목 금액');
  return finish(c, lines, false);
}

/**
 * Where the target comes from. Text the user typed into the target field
 * (`override`) always wins; otherwise the selected type's details decide it.
 * An untouched example keeps its example label, and missing required
 * entries leave the target undecided rather than inventing a figure.
 */
export function resolveGoalTarget(type: GoalType, drafts: GoalDrafts, override?: string): GoalTargetResolution {
  if (override !== undefined) {
    return { source: 'manual', amount: parseGoalNumber(override) ?? Number.NaN, lines: [], zeroed: [], missing: [], errors: {} };
  }
  if (type === 'home') return purchaseTarget(drafts.home, 'home');
  if (type === 'car') return purchaseTarget(drafts.car, 'car');
  if (type === 'travel') return travelTarget(drafts.travel);
  return freeTarget(drafts.free);
}

/** An assumed yearly price rise applied to the target; off unless the person turns it on. */
export interface GoalInflationDraft { on: boolean; rate: string }

/** Everything the goal section holds; memory only, like the calculator's other inputs, until the person saves a goal. */
export interface GoalPlannerState {
  goal: GoalType;
  drafts: GoalDrafts;
  /** Text typed into the target field, per goal type; absent while the details decide the target. */
  overrides: Partial<Record<GoalType, string>>;
  inflation: GoalInflationDraft;
}

type DraftUpdate = { [K in GoalType]: { type: 'update'; goal: K; patch: Partial<GoalDrafts[K]> } }[GoalType];
export type GoalPlannerAction =
  | { type: 'select'; goal: GoalType }
  | DraftUpdate
  | { type: 'freeMethod'; method: FreeGoalDraft['method'] }
  | { type: 'typeTarget'; text: string }
  | { type: 'followDetails' }
  | { type: 'inflation'; patch: Partial<GoalInflationDraft> }
  | { type: 'load'; goal: GoalType; draft: GoalDrafts[GoalType]; override?: string; inflation: GoalInflationDraft }
  | { type: 'reset'; drafts: GoalDrafts };

const NO_INFLATION: GoalInflationDraft = { on: false, rate: '' };

export function createGoalPlanner(formatAmount?: (amount: number) => string): GoalPlannerState {
  return { goal: 'free', drafts: createGoalDrafts(formatAmount), overrides: {}, inflation: NO_INFLATION };
}

function withoutOverride(overrides: GoalPlannerState['overrides'], goal: GoalType): GoalPlannerState['overrides'] {
  const { [goal]: _removed, ...rest } = overrides;
  return rest;
}

/**
 * Shared by both clients. Switching types keeps every type's entries. Typed
 * target text wins until the details are asked for again; for a free goal it
 * means a direct amount, and choosing rows or "not decided yet" hands the
 * amount back to the details.
 */
export function updateGoalPlanner(state: GoalPlannerState, action: GoalPlannerAction): GoalPlannerState {
  switch (action.type) {
    case 'select':
      return { ...state, goal: action.goal };
    case 'update':
      return { ...state, drafts: { ...state.drafts, [action.goal]: { ...state.drafts[action.goal], ...action.patch } } };
    case 'freeMethod':
      return {
        ...state, drafts: { ...state.drafts, free: { ...state.drafts.free, method: action.method } },
        overrides: action.method === 'direct' ? state.overrides : withoutOverride(state.overrides, 'free'),
      };
    case 'typeTarget': {
      const overrides = { ...state.overrides, [state.goal]: action.text };
      if (state.goal !== 'free' || state.drafts.free.method === 'direct') return { ...state, overrides };
      return { ...state, overrides, drafts: { ...state.drafts, free: { ...state.drafts.free, method: 'direct' } } };
    }
    case 'followDetails':
      return { ...state, overrides: withoutOverride(state.overrides, state.goal) };
    case 'inflation':
      return { ...state, inflation: { ...state.inflation, ...action.patch } };
    case 'load': {
      // A saved goal replaces its own type's entries; the other types keep theirs.
      const overrides = action.override === undefined ? withoutOverride(state.overrides, action.goal) : { ...state.overrides, [action.goal]: action.override };
      return { goal: action.goal, drafts: { ...state.drafts, [action.goal]: action.draft }, overrides, inflation: action.inflation };
    }
    case 'reset':
      return { goal: 'free', drafts: action.drafts, overrides: {}, inflation: NO_INFLATION };
  }
}

/** "매입 가격 3억 원 − 대출 예정 금액 2억 원 + 부대비용 1,500만 원" with the client's number format. */
export function formatGoalFormula(lines: readonly GoalFormulaLine[], format: (amount: number) => string): string {
  return lines.map((line, index) => `${index === 0 ? (line.sign < 0 ? '− ' : '') : line.sign < 0 ? ' − ' : ' + '}${line.label} ${format(line.amount)}`).join('');
}

/** The line under the target field: the amount and where it came from, or what is still missing. */
export function describeGoalTarget(resolution: GoalTargetResolution, format: (amount: number) => string): string {
  const { source, amount, missing, errors } = resolution;
  if (Object.keys(errors).length) return errors.total ?? '목표 상세에서 표시된 입력을 고쳐 주세요.';
  if (source === 'undecided') return missing.length ? `빈 칸: ${missing.join(', ')} · 채우면 목표 금액이 계산돼요.` : '목표 금액 없이 자산 추이만 계산해요.';
  if (amount === null || !Number.isFinite(amount)) return '';
  if (source === 'manual') return amount === 0 ? '0원은 목표 없이 자산 추이만 계산합니다.' : format(amount);
  return `${format(amount)} · ${source === 'example' ? '예시 금액이에요. 내 목표에 맞게 바꿔 보세요.' : '목표 상세로 계산했어요.'}`;
}

/**
 * "여행(오사카) · 상세 계산 245만 원": the goal and its target, for the result
 * area, followed by the amount compared against when a price rise is assumed.
 */
export function describeGoalResult(
  type: GoalType, drafts: GoalDrafts, resolution: GoalTargetResolution, format: (amount: number) => string, inflated?: number,
): string {
  const { source, amount } = resolution;
  const target = source === 'undecided' || amount === null || !Number.isFinite(amount) ? '목표 금액 미정' : `${GOAL_SOURCE_LABELS[source]} ${format(amount)}`;
  return `${describeGoal(type, drafts)} · ${target}${inflated === undefined ? '' : ` → 물가 반영 ${format(inflated)}`}`;
}

/** A short name for the result: what the goal is and, for purchases, which part of the price it covers. */
export function describeGoal(type: GoalType, drafts: GoalDrafts): string {
  const clip = (text: string, max: number) => Array.from(text.trim()).slice(0, max).join('');
  const named = (name: string, details: string[]) => {
    const shown = details.filter(Boolean).join(', ');
    return shown ? `${name}(${shown})` : name;
  };
  if (type === 'free') return clip(drafts.free.name, GOAL_NAME_MAX_LENGTH) || goalTypeName('free');
  if (type === 'home') {
    const { region, district, housing, scope } = drafts.home;
    const place = [region, clip(district, GOAL_DISTRICT_MAX_LENGTH), HOUSING_TYPES.find(item => item.id === housing)?.label ?? ''].filter(Boolean).join(' ');
    return `${named(goalTypeName('home'), [place])} · ${HOME_SCOPE_LABELS[scope]} 기준`;
  }
  if (type === 'car') {
    const { model, condition, scope } = drafts.car;
    const kind = CAR_CONDITIONS.find(item => item.id === condition)?.label ?? '';
    return `${named(goalTypeName('car'), [clip(model, GOAL_LABEL_MAX_LENGTH), kind])} · ${CAR_SCOPE_LABELS[scope]} 기준`;
  }
  const trip = drafts.travel;
  const details = [clip(trip.destination, GOAL_LABEL_MAX_LENGTH)];
  if (trip.method === 'items') {
    const travelers = parseGoalNumber(trip.travelers);
    const nights = parseGoalNumber(trip.nights);
    const days = parseGoalNumber(trip.days) ?? (nights === null ? null : nights + 1);
    if (travelers !== null && Number.isInteger(travelers) && travelers > 0) details.push(`${travelers}명`);
    if (nights !== null && days !== null && Number.isInteger(nights) && Number.isInteger(days)) details.push(`${nights}박 ${days}일`);
  }
  return named(goalTypeName('travel'), details);
}
