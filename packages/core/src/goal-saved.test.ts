import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createGoalPlanner, createSavedGoal, describeSavedGoal, formatCompactKRW, loadSavedGoalAction, parseSavedGoals, resolveGoalTarget,
  serializeSavedGoals, updateGoalPlanner, SAVED_GOAL_LIMIT, type GoalPlannerAction, type GoalPlannerState, type SavedGoal,
} from './index.ts';

const calculator = { initial: '10,000,000', monthly: '500,000', annualRate: '5', months: '24' };
const now = new Date('2026-10-28T03:00:00.000Z');
const run = (...actions: GoalPlannerAction[]) => actions.reduce<GoalPlannerState>(updateGoalPlanner, createGoalPlanner());

test('a saved goal keeps its type\'s entries, typed target and price-rise setting, but never the free goal\'s description', () => {
  const state = run(
    { type: 'update', goal: 'free', patch: { name: '결혼 자금', method: 'items', note: '연락처 010-0000-0000', items: [{ label: '예식', amount: '20,000,000' }] } },
    { type: 'inflation', patch: { on: true, rate: '2' } },
  );
  const saved = createSavedGoal(state, calculator, 'goal-1', now);
  assert.equal(saved.goal, 'free');
  assert.equal((saved.draft as { note: string }).note, '');
  assert.equal(saved.override, undefined);
  assert.equal(saved.savedAt, '2026-10-28T03:00:00.000Z');
  assert.equal(describeSavedGoal(saved, formatCompactKRW), '결혼 자금 · 상세 계산 2,000만 원');

  const typed = createSavedGoal(run({ type: 'select', goal: 'car' }, { type: 'typeTarget', text: '30,000,000' }), calculator, 'goal-2', now);
  assert.equal(typed.override, '30,000,000');
  assert.equal(describeSavedGoal(typed, formatCompactKRW), '자동차 · 차량 가격 전체 기준 · 직접 입력 3,000만 원');
});

test('loading a saved goal replaces its own type\'s entries and leaves the others', () => {
  const saved = createSavedGoal(run(
    { type: 'select', goal: 'home' },
    { type: 'update', goal: 'home', patch: { scope: 'equity', price: '500000000', loan: '300000000', district: '마포구' } },
    { type: 'inflation', patch: { on: true, rate: '3' } },
  ), calculator, 'goal-1', now);
  const elsewhere = run({ type: 'update', goal: 'travel', patch: { destination: '오사카' } }, { type: 'select', goal: 'home' }, { type: 'typeTarget', text: '1' });
  const loaded = updateGoalPlanner(elsewhere, loadSavedGoalAction(saved));
  assert.equal(loaded.goal, 'home');
  assert.deepEqual(loaded.drafts.home, saved.draft);
  assert.equal(loaded.drafts.travel.destination, '오사카');
  assert.deepEqual(loaded.overrides, {}, 'the typed text for home gives way to the saved details');
  assert.deepEqual(loaded.inflation, { on: true, rate: '3' });
  assert.equal(resolveGoalTarget('home', loaded.drafts).amount, 200_000_000);
});

test('saved goals survive a round trip through storage text, up to the limit', () => {
  const goals = Array.from({ length: SAVED_GOAL_LIMIT + 2 }, (_, index) => createSavedGoal(createGoalPlanner(), calculator, `goal-${index}`, now));
  const restored = parseSavedGoals(serializeSavedGoals(goals));
  assert.equal(restored.length, SAVED_GOAL_LIMIT);
  assert.deepEqual(restored, goals.slice(0, SAVED_GOAL_LIMIT));
  assert.deepEqual(parseSavedGoals(JSON.stringify({ version: 1, goals: [goals[0], goals[0]] })), [goals[0]]);
});

test('anything unreadable in storage is left out instead of reaching the planner', () => {
  const good = createSavedGoal(run({ type: 'select', goal: 'travel' }), calculator, 'goal-1', now);
  const variant = (patch: Record<string, unknown>) => ({ ...good, ...patch });
  const draft = (patch: Record<string, unknown>) => variant({ draft: { ...good.draft, ...patch } });
  for (const stored of [null, '', 'not json', '[]', '{"version":2,"goals":[]}', JSON.stringify({ version: 1, goals: 'x' })]) {
    assert.deepEqual(parseSavedGoals(stored), [], String(stored));
  }
  const bad = [
    'x', null, variant({ id: 'has space' }), variant({ id: 7 }), variant({ savedAt: 'yesterday' }), variant({ goal: 'boat' }),
    variant({ draft: 'x' }), draft({ method: 'cheap' }), draft({ total: 12 }), draft({ destination: '가'.repeat(31) }), draft({ total: '1'.repeat(31) }),
    variant({ override: 5 }), variant({ inflation: { on: 'yes', rate: '' } }), variant({ calculator: { ...calculator, months: 24 } }),
    variant({ goal: 'free', draft: { name: '이름', method: 'items', items: [] } }),
    variant({ goal: 'free', draft: { name: '이름', method: 'items', items: [{ label: '<b>', amount: 3 }] } }),
    variant({ goal: 'home', draft: { region: '평양' } }), variant({ goal: 'car', draft: { condition: 'broken' } }),
  ];
  assert.deepEqual(parseSavedGoals(JSON.stringify({ version: 1, goals: [...bad, good] })), [good]);
  // Missing fields take their defaults, unknown ones are dropped, and the free goal never gets a description back.
  const [free] = parseSavedGoals(JSON.stringify({ version: 1, goals: [variant({ goal: 'free', draft: { name: '비상금', note: '메모', extra: 1 } })] })) as [SavedGoal];
  assert.deepEqual(free.draft, { name: '비상금', method: 'direct', note: '', items: [{ label: '', amount: '' }] });
  const [home] = parseSavedGoals(JSON.stringify({ version: 1, goals: [variant({ goal: 'home', draft: { price: '1', script: '<x>' } })] })) as [SavedGoal];
  assert.equal((home.draft as { price: string }).price, '1');
  assert.equal('script' in home.draft, false);
  assert.equal((home.draft as { district: string }).district, '');
});
