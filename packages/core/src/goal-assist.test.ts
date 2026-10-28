import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createGoalPlanner, describeSwitchPrefill, goalFactActions, goalSwitchActions, livingCostActions, resolveGoalTarget, updateGoalPlanner,
  type GoalPlannerAction, type GoalPlannerState,
} from './index.ts';

const format = (amount: number) => amount.toLocaleString('en-US');
const run = (actions: GoalPlannerAction[], start: GoalPlannerState = createGoalPlanner(format)) => actions.reduce(updateGoalPlanner, start);
const target = (state: GoalPlannerState) => resolveGoalTarget(state.goal, state.drafts, state.overrides[state.goal]);

test('ticked facts fill the free goal: a name, one typed amount or rows', () => {
  const typed = run(goalFactActions({ name: '결혼 자금', amount: 30_000_000 }, format));
  assert.equal(typed.drafts.free.name, '결혼 자금');
  assert.deepEqual([target(typed).source, target(typed).amount], ['manual', 30_000_000]);
  const rows = run(goalFactActions({ items: [{ label: '예식', value: 20_000_000, text: '2천만 원' }, { label: '', value: 5_000_000, text: '500만 원' }] }, format));
  assert.deepEqual(rows.drafts.free.items, [{ label: '예식', amount: '20,000,000' }, { label: '', amount: '5,000,000' }]);
  assert.deepEqual([target(rows).source, target(rows).amount], ['details', 25_000_000]);
  const fromHome = run(goalFactActions({ amount: 1 }, format), run([{ type: 'select', goal: 'home' }]));
  assert.equal(fromHome.goal, 'free');
  assert.equal(fromHome.overrides.home, undefined);
});

test('switching to a goal type fills in what the description says and nothing else', () => {
  const trip = run(goalSwitchActions('travel', { travelers: { value: 2, text: '2명' }, nights: { value: 3, text: '3박 4일' }, days: { value: 4, text: '3박 4일' } }, format));
  assert.deepEqual([trip.goal, trip.drafts.travel.method, trip.drafts.travel.travelers, trip.drafts.travel.nights, trip.drafts.travel.days], ['travel', 'items', '2', '3', '4']);
  const budget = run(goalSwitchActions('travel', { amount: { value: 3_000_000, text: '300만 원' } }, format));
  assert.deepEqual([budget.drafts.travel.method, budget.drafts.travel.total], ['total', '3,000,000']);
  const car = run(goalSwitchActions('car', { amount: { value: 35_000_000, text: '3천5백만 원' } }, format));
  assert.deepEqual([car.goal, car.drafts.car.price, target(car).amount], ['car', '35,000,000', 35_000_000]);
  assert.deepEqual(run(goalSwitchActions('home', {}, format)).drafts.home, createGoalPlanner(format).drafts.home);
  assert.deepEqual(goalSwitchActions('wedding', { amount: { value: 1, text: '1원' } }, format), []);
  assert.equal(describeSwitchPrefill('travel', { travelers: { value: 2, text: '2명' }, nights: { value: 3, text: '3박' } }), '인원 2명, 3박을 채워 둘게요.');
  assert.equal(describeSwitchPrefill('car', { amount: { value: 35_000_000, text: '3천5백만 원' } }), '차량 가격 3,500만 원을 채워 둘게요.');
  assert.equal(describeSwitchPrefill('home', {}), '');
});

test('living costs times months become one visible row', () => {
  const state = run(livingCostActions(2_500_000, 6, format));
  assert.deepEqual(state.drafts.free.items, [{ label: '한 달 생활비 250만 원 × 6개월', amount: '15,000,000' }]);
  assert.deepEqual([target(state).source, target(state).amount], ['details', 15_000_000]);
});
