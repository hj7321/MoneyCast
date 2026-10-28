/**
 * Rule-based reading of a free goal's description, shared by both clients
 * and by the server that checks a model's answer. Only figures the user
 * wrote are read; nothing here estimates a price.
 */
import { goalTypeName, type GoalType } from './goals.js';

export const GOAL_CATEGORIES = [
  { id: 'home', label: '내 집 마련', name: '내 집 마련', goal: 'home' },
  { id: 'car', label: '자동차', name: '자동차', goal: 'car' },
  { id: 'travel', label: '여행', name: '여행', goal: 'travel' },
  { id: 'wedding', label: '결혼', name: '결혼 자금' },
  { id: 'education', label: '교육', name: '교육비' },
  { id: 'emergency', label: '비상금', name: '비상금' },
  { id: 'housing', label: '전세·이사', name: '전세·이사 자금' },
  { id: 'retirement', label: '노후', name: '노후 자금' },
  { id: 'other', label: '기타', name: '' },
] as const;
export type GoalCategory = typeof GOAL_CATEGORIES[number]['id'];
export const GOAL_CATEGORY_IDS: readonly GoalCategory[] = GOAL_CATEGORIES.map(category => category.id);

export function isGoalCategory(value: unknown): value is GoalCategory {
  return typeof value === 'string' && (GOAL_CATEGORY_IDS as readonly string[]).includes(value);
}

/** The goal type with its own detail form, if the category has one. */
export function categoryGoalType(category: GoalCategory): Exclude<GoalType, 'free'> | null {
  return category === 'home' || category === 'car' || category === 'travel' ? category : null;
}

export function categoryLabel(category: GoalCategory): string {
  return GOAL_CATEGORIES.find(item => item.id === category)!.label;
}

/** A default goal name for the category; empty when there is none. */
export function categoryGoalName(category: GoalCategory): string {
  return GOAL_CATEGORIES.find(item => item.id === category)!.name;
}

/** Keywords matched without spaces; the category with most matches wins and earlier ones break ties. */
const CATEGORY_KEYWORDS: ReadonlyArray<[GoalCategory, readonly string[]]> = [
  ['housing', ['전세', '월세', '보증금', '이사']],
  ['home', ['내집', '집마련', '집을사', '집장만', '아파트', '주택', '청약', '분양', '매매', '빌라', '오피스텔']],
  ['car', ['자동차', '차량', '신차', '중고차', '전기차', '자차', '첫차', '새차', '차를사', '차사기', '차구입', '차구매', 'suv', '세단', '하이브리드']],
  ['travel', ['여행', '휴가', '해외', '배낭', '항공권', '투어', '크루즈']],
  ['wedding', ['결혼', '웨딩', '예식', '혼수', '상견례', '스드메', '신혼']],
  ['education', ['학비', '등록금', '유학', '대학원', '학원', '교육', '어학연수', '자격증', '입학']],
  ['emergency', ['비상금', '비상자금', '예비비', '긴급자금', '생활비']],
  ['retirement', ['노후', '은퇴', '연금']],
];

export function classifyGoalText(text: string): GoalCategory {
  const compact = text.normalize('NFKC').toLocaleLowerCase('ko-KR').replace(/\s+/g, '');
  let best: GoalCategory = 'other';
  let bestScore = 0;
  for (const [category, keywords] of CATEGORY_KEYWORDS) {
    const score = keywords.filter(keyword => compact.includes(keyword)).length;
    if (score > bestScore) {
      best = category;
      bestScore = score;
    }
  }
  return best;
}

const HANGUL_DIGITS: Readonly<Record<string, number>> = { 영: 0, 공: 0, 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 륙: 6, 칠: 7, 팔: 8, 구: 9 };
const SMALL_UNITS: Readonly<Record<string, number>> = { 십: 10, 백: 100, 천: 1000 };
const LARGE_UNITS: ReadonlyArray<[string, number]> = [['조', 1e12], ['억', 1e8], ['만', 1e4]];

/** "3천5백" → 3500, "1,500" → 1500, "1.5" → 1.5, "삼천" → 3000. */
function parseSmallNumber(text: string): number | null {
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
  let total = 0;
  let current: number | null = null;
  for (let index = 0; index < text.length;) {
    const digits = /^\d+(\.\d+)?/.exec(text.slice(index));
    const char = text[index]!;
    if (digits) {
      if (current !== null) return null;
      current = Number(digits[0]);
      index += digits[0].length;
    } else if (char in HANGUL_DIGITS) {
      if (current !== null) return null;
      current = HANGUL_DIGITS[char]!;
      index += 1;
    } else if (char in SMALL_UNITS) {
      total += (current ?? 1) * SMALL_UNITS[char]!;
      current = null;
      index += 1;
    } else return null;
  }
  return text === '' ? null : total + (current ?? 0);
}

/**
 * Korean money as written: "3천만 원", "1억 5천", "1.5억", "50,000,000원",
 * "오백만". A bare remainder after 억 or 조 is the spoken shorthand for the
 * next unit down ("1억 5천" is 1억 5천만). Null when the text is not an amount.
 */
export function parseKoreanAmount(text: string): number | null {
  let rest = text.normalize('NFKC').replace(/[\s,]/g, '').replace(/원$/, '');
  if (!rest) return null;
  let total = 0;
  let lastUnit = 1;
  for (const [unit, value] of LARGE_UNITS) {
    const at = rest.indexOf(unit);
    if (at < 0) continue;
    const head = rest.slice(0, at);
    const number = head === '' ? 1 : parseSmallNumber(head);
    if (number === null) return null;
    total += number * value;
    rest = rest.slice(at + 1);
    lastUnit = value;
  }
  if (rest) {
    const number = parseSmallNumber(rest);
    if (number === null) return null;
    total += number * (lastUnit === 1e8 ? 1e4 : lastUnit === 1e12 ? 1e8 : 1);
  }
  return Number.isFinite(total) && total > 0 ? total : null;
}

export interface GoalTextFact { value: number; text: string }
export interface GoalTextItem { label: string; value: number; text: string }
/** Figures found in a description, each with the words it was read from. */
export interface GoalTextFacts {
  amount?: GoalTextFact;
  /** Two or more amounts, each with the word written just before it. */
  items?: GoalTextItem[];
  months?: GoalTextFact;
  travelers?: GoalTextFact;
  nights?: GoalTextFact;
  days?: GoalTextFact;
}

const AMOUNT_LIMIT = 1_000_000_000_000;
const AMOUNT_RUN = /[0-9일이삼사오육륙칠팔구십백천만억조][0-9일이삼사오육륙칠팔구십백천만억조,.\s원]*/g;
/** Particles dropped from the word before an amount; a generic word such as 비용 gives way to the one before it. */
const PARTICLES = /(은|는|을|를|에는|에|으로|과|와|랑)$/;
const GENERIC_WORDS = /^(비용|자금|예산|정도|쯤|약|대략|총|모두|합계|합쳐서)$/;

function labelBefore(text: string): string {
  const words = text.trimEnd().split(/[\s,·:()]+/).filter(Boolean);
  while (words.length && GENERIC_WORDS.test(words.at(-1)!.replace(PARTICLES, ''))) words.pop();
  const label = (words.at(-1) ?? '').replace(PARTICLES, '');
  return /^[가-힣a-zA-Z]{1,10}$/.test(label) ? label : '';
}

/** Every amount in the text, in order; an amount needs 만·억·조 or 원 so counts and years never qualify. */
export function findKoreanAmounts(text: string): GoalTextItem[] {
  const found: GoalTextItem[] = [];
  for (const match of text.normalize('NFKC').matchAll(AMOUNT_RUN)) {
    let run = match[0];
    const won = run.indexOf('원');
    if (won >= 0) run = run.slice(0, won + 1);
    // Trailing particles that are also numerals ("5천만이") fall off until the run ends in a unit.
    while (run && !/[만억조원천백]$/.test(run.trimEnd())) run = run.slice(0, -1);
    run = run.trimEnd();
    if (!/[만억조원]/.test(run) || !(/[0-9일이삼사오육륙칠팔구]/.test(run) || /^[십백천]+[만억조]/.test(run))) continue;
    const value = parseKoreanAmount(run);
    if (value === null || value > AMOUNT_LIMIT) continue;
    found.push({ label: labelBefore(text.normalize('NFKC').slice(0, match.index)), value, text: run });
  }
  return found;
}

const NATIVE_COUNTS: Readonly<Record<string, number>> = {
  한: 1, 두: 2, 세: 3, 네: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10, 열한: 11, 열두: 12,
};

/** Months from `now` to the start of a calendar month; null unless it lies ahead. */
export function monthsUntil(year: number, month: number, now: Date): number | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return null;
  const months = (year - now.getFullYear()) * 12 + (month - (now.getMonth() + 1));
  return months >= 1 && months <= 600 ? months : null;
}

/**
 * A saving period from words such as "2년", "18개월", "1년 반", "두 달",
 * "2027년 10월" or "내년 3월", in whole months (1–600).
 */
export function findGoalPeriod(text: string, now: Date): GoalTextFact | null {
  const source = text.normalize('NFKC');
  const year = now.getFullYear();
  // "(?:^|[^\d.])" keeps "27년" inside "2027년" from reading as 27 years; the boundary is not part of the quoted text.
  const rules: Array<[RegExp, (match: RegExpExecArray) => number | null]> = [
    [/(?:^|[^\d.])(\d{4})\s*년\s*(\d{1,2})\s*월/, match => monthsUntil(Number(match[1]), Number(match[2]), now)],
    [/(올해|올|내년|내후년)\s*(\d{1,2})\s*월/, match =>
      monthsUntil(year + ({ 올해: 0, 올: 0, 내년: 1, 내후년: 2 } as Record<string, number>)[match[1]!]!, Number(match[2]), now)],
    [/(?:^|[^\d.])(\d{1,2})\s*년\s*(\d{1,2})\s*개월/, match => Number(match[1]) * 12 + Number(match[2])],
    [/(?:^|[^\d.])(\d{1,2})\s*년\s*반/, match => Number(match[1]) * 12 + 6],
    [/(?:^|[^\d.])(\d{1,2}(?:\.\d+)?)\s*년(?!\s*(?:차|째|전|생|도))/, match => Math.round(Number(match[1]) * 12)],
    // "6개월치" sizes an emergency fund; it is not the saving period.
    [/(?:^|[^\d.])(\d{1,3})\s*(?:개월|달)(?!\s*치)/, match => Number(match[1])],
    [/(열한|열두|한|두|세|네|다섯|여섯|일곱|여덟|아홉|열)\s*달(?!\s*(?:치|생활비|월급|용돈|에))/, match => NATIVE_COUNTS[match[1]!] ?? null],
    [/반\s*년/, () => 6],
  ];
  for (const [pattern, toMonths] of rules) {
    const match = pattern.exec(source);
    if (!match) continue;
    const months = toMonths(match);
    // The quoted words start at the first group, after any boundary character.
    const quoted = match[1] === undefined ? match[0] : match[0].slice(match[0].indexOf(match[1]));
    if (months !== null && Number.isInteger(months) && months >= 1 && months <= 600) return { value: months, text: quoted };
  }
  return null;
}

/** Party size from "2명", "4인" (not "2인분"), or 혼자·둘이·셋이·넷이. */
export function findTravelers(text: string): GoalTextFact | null {
  const source = text.normalize('NFKC');
  const counted = /(?:^|\D)(\d{1,2})\s*(?:명|인)(?!\s*(?:분|용|실))/.exec(source);
  if (counted) {
    const value = Number(counted[1]);
    return value >= 1 && value <= 20 ? { value, text: counted[0].replace(/^\D/, '') } : null;
  }
  const spoken = /(혼자|둘이|셋이|넷이)/.exec(source);
  return spoken ? { value: { 혼자: 1, 둘이: 2, 셋이: 3, 넷이: 4 }[spoken[1] as '혼자']!, text: spoken[0] } : null;
}

/** Trip length from "3박 4일", "5박" or 당일치기. */
export function findTripLength(text: string): { nights: GoalTextFact; days?: GoalTextFact } | null {
  const source = text.normalize('NFKC');
  const both = /(\d{1,3})\s*박\s*(\d{1,3})\s*일/.exec(source);
  if (both) return { nights: { value: Number(both[1]), text: both[0] }, days: { value: Number(both[2]), text: both[0] } };
  const nights = /(\d{1,3})\s*박/.exec(source);
  if (nights) return { nights: { value: Number(nights[1]), text: nights[0] } };
  const dayTrip = /당일\s*치기/.exec(source);
  return dayTrip ? { nights: { value: 0, text: dayTrip[0] }, days: { value: 1, text: dayTrip[0] } } : null;
}

/** Phone, card, account and resident numbers or an e-mail address; such text is never sent to a model. */
export function hasPersonalData(text: string): boolean {
  const source = text.normalize('NFKC');
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(source)) return true;
  for (const match of source.matchAll(/\d[\d\s-]*\d/g)) {
    const digits = match[0].replace(/\D/g, '');
    const after = source.slice((match.index ?? 0) + match[0].length);
    if (digits.length >= 10 && !/^\s*(원|만|억|조)/.test(after)) return true;
  }
  return false;
}

export interface GoalTextAnalysis {
  category: GoalCategory;
  facts: GoalTextFacts;
  personalData: boolean;
}

export function analyzeGoalText(text: string, now: Date): GoalTextAnalysis {
  const amounts = findKoreanAmounts(text);
  const facts: GoalTextFacts = {};
  if (amounts.length === 1) facts.amount = { value: amounts[0]!.value, text: amounts[0]!.text };
  if (amounts.length > 1) facts.items = amounts.slice(0, 5);
  const months = findGoalPeriod(text, now);
  if (months) facts.months = months;
  const travelers = findTravelers(text);
  if (travelers) facts.travelers = travelers;
  const trip = findTripLength(text);
  if (trip) {
    facts.nights = trip.nights;
    if (trip.days) facts.days = trip.days;
  }
  return { category: classifyGoalText(text), facts, personalData: hasPersonalData(text) };
}

export type GoalQuestionId = 'amount' | 'livingCost' | 'switchType' | 'period';

/**
 * At most two fixed questions, chosen by rule: the amount first (as monthly
 * living costs for an emergency fund), then a move to the matching goal
 * type's own form, then the period.
 */
export function planGoalQuestions(analysis: Pick<GoalTextAnalysis, 'category' | 'facts'>, context: { amountKnown: boolean; periodKnown?: boolean }): GoalQuestionId[] {
  const { category, facts } = analysis;
  const questions: GoalQuestionId[] = [];
  if (!context.amountKnown && !facts.amount && !facts.items) questions.push(category === 'emergency' ? 'livingCost' : 'amount');
  if (categoryGoalType(category)) questions.push('switchType');
  if (!facts.months && !context.periodKnown) questions.push('period');
  return questions.slice(0, 2);
}

export function goalQuestionText(question: GoalQuestionId, category: GoalCategory): string {
  if (question === 'amount') return '모으려는 금액이 정해져 있나요?';
  if (question === 'livingCost') return '한 달 생활비와 몇 개월치를 모을지 알려 주세요.';
  if (question === 'period') return '언제까지 모을까요?';
  const type = categoryGoalType(category);
  return `‘${type ? goalTypeName(type) : categoryLabel(category)}’ 목표로 바꿔서 자세히 입력할까요?`;
}
