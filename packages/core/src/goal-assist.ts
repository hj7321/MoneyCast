/**
 * How information found in a description is applied, as planner actions both
 * clients dispatch. Nothing is applied until the person chooses it.
 */
import { GOAL_ITEM_LIMIT, type GoalPlannerAction } from './goals.js';
import { categoryGoalType, type GoalCategory, type GoalTextFacts, type GoalTextItem } from './goal-text.js';
import { formatCompactKRW } from './index.js';

/** The facts the person ticked in the card. */
export interface GoalFactSelection { name?: string; amount?: number; items?: GoalTextItem[] }

/** Fills the free goal; the saving period goes to the calculator's own field instead. */
export function goalFactActions(selection: GoalFactSelection, formatAmount: (amount: number) => string): GoalPlannerAction[] {
  const actions: GoalPlannerAction[] = [{ type: 'select', goal: 'free' }];
  if (selection.name) actions.push({ type: 'update', goal: 'free', patch: { name: selection.name } });
  if (selection.items?.length) {
    const items = selection.items.slice(0, GOAL_ITEM_LIMIT).map(item => ({ label: item.label, amount: formatAmount(item.value) }));
    actions.push({ type: 'update', goal: 'free', patch: { items } }, { type: 'freeMethod', method: 'items' });
  } else if (selection.amount !== undefined) {
    actions.push({ type: 'freeMethod', method: 'direct' }, { type: 'typeTarget', text: formatAmount(selection.amount) });
  }
  return actions;
}

/** Moves to the category's own form, filling in what the description already says. */
export function goalSwitchActions(category: GoalCategory, facts: GoalTextFacts, formatAmount: (amount: number) => string): GoalPlannerAction[] {
  const type = categoryGoalType(category);
  if (!type) return [];
  const actions: GoalPlannerAction[] = [];
  if (type === 'travel') {
    if (facts.amount) actions.push({ type: 'update', goal: 'travel', patch: { method: 'total', total: formatAmount(facts.amount.value) } });
    else if (facts.travelers || facts.nights) {
      actions.push({ type: 'update', goal: 'travel', patch: {
        method: 'items',
        ...(facts.travelers ? { travelers: String(facts.travelers.value) } : {}),
        ...(facts.nights ? { nights: String(facts.nights.value) } : {}),
        ...(facts.days ? { days: String(facts.days.value) } : {}),
      } });
    }
  } else if (facts.amount) {
    actions.push(type === 'home'
      ? { type: 'update', goal: 'home', patch: { scope: 'full', price: formatAmount(facts.amount.value) } }
      : { type: 'update', goal: 'car', patch: { scope: 'full', price: formatAmount(facts.amount.value) } });
  }
  actions.push({ type: 'select', goal: type });
  return actions;
}

/** An emergency fund as monthly living costs times months, kept as one visible row. */
export function livingCostActions(monthly: number, months: number, formatAmount: (amount: number) => string): GoalPlannerAction[] {
  return [
    { type: 'select', goal: 'free' },
    { type: 'update', goal: 'free', patch: { items: [{ label: `한 달 생활비 ${formatCompactKRW(monthly)} × ${months}개월`, amount: formatAmount(monthly * months) }] } },
    { type: 'freeMethod', method: 'items' },
  ];
}

/** What a switch will fill in, for the question's own wording. */
export function describeSwitchPrefill(category: GoalCategory, facts: GoalTextFacts): string {
  const type = categoryGoalType(category);
  if (!type) return '';
  const filled = type === 'travel'
    ? facts.amount ? [`총 예산 ${formatCompactKRW(facts.amount.value)}`]
      : [facts.travelers && `인원 ${facts.travelers.value}명`, facts.nights && `${facts.nights.value}박`, facts.days && `${facts.days.value}일`]
    : [facts.amount && `${type === 'home' ? '매입' : '차량'} 가격 ${formatCompactKRW(facts.amount.value)}`];
  const shown = filled.filter(Boolean);
  return shown.length ? `${shown.join(', ')}을 채워 둘게요.` : '';
}
