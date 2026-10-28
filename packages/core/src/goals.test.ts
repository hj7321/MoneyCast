import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createGoalDrafts, createGoalPlanner, describeGoal, formatCompactKRW, formatGoalFormula, resolveGoalTarget, updateGoalPlanner,
  DEFAULT_CALCULATOR_INPUT, GOAL_TYPES, type GoalDrafts, type GoalPlannerAction, type GoalPlannerState,
} from './index.ts';

/** Fresh drafts with one goal's entries replaced. */
function drafts<T extends keyof GoalDrafts>(type: T, patch: Partial<GoalDrafts[T]>): GoalDrafts {
  const base = createGoalDrafts();
  return { ...base, [type]: { ...base[type], ...patch } };
}

test('goal types keep their example amounts and the free goal matches the calculator default', () => {
  assert.deepEqual(GOAL_TYPES.map(goal => [goal.id, goal.name, goal.exampleAmount]), [
    ['free', '자유 목표', 50_000_000], ['home', '내 집 마련', 300_000_000],
    ['car', '자동차', 40_000_000], ['travel', '여행', 10_000_000],
  ]);
  assert.equal(GOAL_TYPES[0]!.exampleAmount, DEFAULT_CALCULATOR_INPUT.target);
});

test('untouched details resolve to the labelled example amount of each type in any number format', () => {
  for (const format of [String, (amount: number) => amount.toLocaleString('en-US')]) {
    const untouched = createGoalDrafts(format);
    for (const goal of GOAL_TYPES) {
      const result = resolveGoalTarget(goal.id, untouched);
      assert.equal(result.source, 'example', goal.id);
      assert.equal(result.amount, goal.exampleAmount, goal.id);
      assert.deepEqual(result.missing, []);
      assert.deepEqual(result.errors, {});
    }
  }
  assert.equal(createGoalDrafts(amount => amount.toLocaleString('en-US')).home.price, '300,000,000');
});

test('text typed into the target field wins over the details, and empty text is invalid', () => {
  const untouched = createGoalDrafts();
  assert.deepEqual(resolveGoalTarget('home', untouched, '120,000,000'),
    { source: 'manual', amount: 120_000_000, lines: [], zeroed: [], missing: [], errors: {} });
  assert.equal(resolveGoalTarget('free', untouched, '0').amount, 0);
  assert.ok(Number.isNaN(resolveGoalTarget('travel', untouched, '').amount));
  assert.ok(Number.isNaN(resolveGoalTarget('car', untouched, '사천만').amount));
});

test('home goals cover the whole price, equity after the loan, or initial funds, plus optional costs', () => {
  assert.deepEqual(resolveGoalTarget('home', drafts('home', { price: '500,000,000' })),
    { source: 'details', amount: 500_000_000, lines: [{ label: '매입 가격', amount: 500_000_000, sign: 1 }], zeroed: [], missing: [], errors: {} });
  assert.equal(resolveGoalTarget('home', drafts('home', { includeCosts: true, costs: '15,000,000' })).amount, 315_000_000);
  const emptyCosts = resolveGoalTarget('home', drafts('home', { includeCosts: true }));
  assert.equal(emptyCosts.source, 'details');
  assert.equal(emptyCosts.amount, 300_000_000);
  assert.deepEqual(emptyCosts.zeroed, ['부대비용']);

  const equity = resolveGoalTarget('home', drafts('home', { scope: 'equity', loan: '200,000,000', includeCosts: true, costs: '15,000,000' }));
  assert.equal(equity.amount, 115_000_000);
  assert.equal(formatGoalFormula(equity.lines, formatCompactKRW), '매입 가격 3억 원 − 대출 예정 금액 2억 원 + 부대비용 1,500만 원');

  const deposit = resolveGoalTarget('home', drafts('home', { scope: 'initial', initialRate: '10' }));
  assert.equal(deposit.amount, 30_000_000);
  assert.deepEqual(deposit.lines.map(line => line.label), ['초기 자금(매입 가격의 10%)']);
  // A known deposit needs no price.
  assert.equal(resolveGoalTarget('home', drafts('home', { scope: 'initial', initialBy: 'amount', price: '', initialAmount: '20,000,000' })).amount, 20_000_000);
});

test('missing home entries leave the target undecided and invalid ones explain themselves', () => {
  assert.deepEqual(resolveGoalTarget('home', drafts('home', { scope: 'equity' })),
    { source: 'undecided', amount: null, lines: [], zeroed: [], missing: ['대출 예정 금액'], errors: {} });
  assert.deepEqual(resolveGoalTarget('home', drafts('home', { price: '' })).missing, ['예상 매입 가격']);
  assert.deepEqual(resolveGoalTarget('home', drafts('home', { scope: 'initial', initialBy: 'amount' })).missing, ['초기 자금']);
  const cases: Array<[Partial<GoalDrafts['home']>, string, string]> = [
    [{ scope: 'equity', loan: '400,000,000' }, 'loan', '대출 예정 금액이 매입 가격보다 클 수 없어요.'],
    [{ scope: 'initial', initialRate: '0' }, 'initialRate', '초기 자금 비율은 0% 초과 100% 이하로 입력해 주세요.'],
    [{ scope: 'initial', initialRate: '101' }, 'initialRate', '초기 자금 비율은 0% 초과 100% 이하로 입력해 주세요.'],
    [{ scope: 'initial', initialBy: 'amount', initialAmount: '400,000,000' }, 'initialAmount', '초기 자금이 매입 가격보다 클 수 없어요.'],
    [{ price: '-1' }, 'price', '예상 매입 가격은 0원 이상이어야 합니다.'],
    [{ price: '삼억' }, 'price', '예상 매입 가격을 숫자로 입력해 주세요.'],
    [{ price: '1,000,000,000,001' }, 'price', '예상 매입 가격은 1조 원 이하로 입력해 주세요.'],
    [{ includeCosts: true, costs: '-5' }, 'costs', '부대비용은 0원 이상이어야 합니다.'],
  ];
  for (const [patch, key, message] of cases) {
    const result = resolveGoalTarget('home', drafts('home', patch));
    assert.equal(result.source, 'details', key);
    assert.ok(Number.isNaN(result.amount), key);
    assert.equal(result.errors[key], message);
  }
});

test('car goals use the vehicle price or initial funds', () => {
  const initial = resolveGoalTarget('car', drafts('car', { scope: 'initial', initialRate: '30' }));
  assert.equal(initial.amount, 12_000_000);
  assert.deepEqual(initial.lines.map(line => line.label), ['초기 자금(차량 가격의 30%)']);
  assert.equal(resolveGoalTarget('car', drafts('car', { includeCosts: true, costs: '2,800,000' })).amount, 42_800_000);
  assert.deepEqual(resolveGoalTarget('car', drafts('car', { price: '' })).missing, ['예상 차량 가격']);
  assert.equal(resolveGoalTarget('car', drafts('car', { price: 'x' })).errors.price, '예상 차량 가격을 숫자로 입력해 주세요.');
});

test('travel items multiply per person, per night and per day, and empty items count as zero', () => {
  const trip = { method: 'items', travelers: '2', nights: '3', flight: '600,000', lodging: '150,000', daily: '100,000' } as const;
  const result = resolveGoalTarget('travel', drafts('travel', trip));
  assert.equal(result.source, 'details');
  assert.equal(result.amount, 1_200_000 + 450_000 + 800_000);
  assert.deepEqual(result.lines.map(line => [line.label, line.amount]), [
    ['항공권(1인 × 2명)', 1_200_000], ['숙박(3박)', 450_000], ['현지 경비(2명 × 4일)', 800_000],
  ]);
  assert.deepEqual(result.zeroed, ['기타 비용']);
  assert.equal(resolveGoalTarget('travel', drafts('travel', { ...trip, days: '5', other: '50,000' })).amount, 1_200_000 + 450_000 + 1_000_000 + 50_000);
  assert.equal(resolveGoalTarget('travel', drafts('travel', { total: '3,000,000' })).source, 'details');
});

test('travel entries are validated and only the counts each item needs are required', () => {
  const items = (patch: Partial<GoalDrafts['travel']>) => resolveGoalTarget('travel', drafts('travel', { method: 'items', ...patch }));
  assert.equal(items({ flight: '500,000' }).amount, 500_000);
  assert.deepEqual(items({ lodging: '100,000' }).missing, ['박 수']);
  assert.equal(items({ daily: '100,000', days: '2' }).amount, 200_000);
  assert.deepEqual(items({}).missing, ['여행 경비']);
  assert.deepEqual(items({ travelers: '', flight: '500,000' }).missing, ['인원']);
  for (const travelers of ['0', '21', '1.5']) {
    assert.equal(items({ travelers, flight: '1' }).errors.travelers, '인원은 1~20명 사이의 정수로 입력해 주세요.');
  }
  assert.equal(items({ nights: '-1', lodging: '1' }).errors.nights, '박 수는 0~365박 사이의 정수로 입력해 주세요.');
  assert.equal(items({ nights: '3', days: '2', daily: '1' }).errors.days, '일 수는 박 수보다 작을 수 없어요.');
});

test('free goals use the target field, the sum of their rows, or no target yet', () => {
  assert.deepEqual([resolveGoalTarget('free', createGoalDrafts()).source, resolveGoalTarget('free', createGoalDrafts()).amount], ['example', 50_000_000]);
  const rows = resolveGoalTarget('free', drafts('free', { method: 'items', items: [
    { label: '예식', amount: '20,000,000' }, { label: ' ', amount: '8,000,000' }, { label: '혼수', amount: '' },
  ] }));
  assert.equal(rows.amount, 28_000_000);
  assert.deepEqual(rows.lines.map(line => line.label), ['예식', '항목 2']);
  assert.deepEqual(resolveGoalTarget('free', drafts('free', { method: 'items' })).missing, ['구성 항목 금액']);
  assert.equal(resolveGoalTarget('free', drafts('free', { method: 'items', items: [{ label: '', amount: '1' }, { label: '', amount: '-5' }] }))
    .errors['items.1.amount'], '항목 2 금액은 0원 이상이어야 합니다.');
  assert.deepEqual(resolveGoalTarget('free', drafts('free', { method: 'undecided' })),
    { source: 'undecided', amount: null, lines: [], zeroed: [], missing: [], errors: {} });
  const six = Array.from({ length: 6 }, () => ({ label: '', amount: '1' }));
  assert.equal(resolveGoalTarget('free', drafts('free', { method: 'items', items: six })).amount, 5);
});

test('a derived target above the calculator ceiling is rejected', () => {
  const result = resolveGoalTarget('home', drafts('home', { price: '1,000,000,000,000', includeCosts: true, costs: '1' }));
  assert.ok(Number.isNaN(result.amount));
  assert.equal(result.errors.total, '목표 금액이 1조 원을 넘습니다. 입력한 금액을 줄여 주세요.');
});

test('goal descriptions name the goal and the part of the price it covers', () => {
  const untouched = createGoalDrafts();
  assert.equal(describeGoal('free', untouched), '자유 목표');
  assert.equal(describeGoal('free', drafts('free', { name: '  결혼 자금 ' })), '결혼 자금');
  assert.equal(describeGoal('free', drafts('free', { name: '가'.repeat(30) })), '가'.repeat(20));
  assert.equal(describeGoal('home', untouched), '내 집 마련 · 집값 전체 기준');
  assert.equal(describeGoal('home', drafts('home', { region: '서울', housing: 'apartment', scope: 'equity' })), '내 집 마련(서울 아파트) · 자기자본 기준');
  assert.equal(describeGoal('home', drafts('home', { region: '서울', district: ' 마포구 ', housing: 'apartment' })), '내 집 마련(서울 마포구 아파트) · 집값 전체 기준');
  assert.equal(describeGoal('car', drafts('car', { model: '아반떼', condition: 'new', scope: 'initial' })), '자동차(아반떼, 신차) · 초기 자금 기준');
  assert.equal(describeGoal('travel', untouched), '여행');
  assert.equal(describeGoal('travel', drafts('travel', { destination: '오사카' })), '여행(오사카)');
  assert.equal(describeGoal('travel', drafts('travel', { destination: '오사카', method: 'items', travelers: '2', nights: '3' })), '여행(오사카, 2명, 3박 4일)');
});

test('the planner keeps each type\'s entries and typed target text across type switches', () => {
  const run = (...actions: GoalPlannerAction[]) => actions.reduce<GoalPlannerState>(updateGoalPlanner, createGoalPlanner());
  const state = run(
    { type: 'typeTarget', text: '70000000' },
    { type: 'select', goal: 'car' },
    { type: 'update', goal: 'car', patch: { price: '35000000' } },
    { type: 'select', goal: 'free' },
  );
  assert.equal(resolveGoalTarget(state.goal, state.drafts, state.overrides[state.goal]).amount, 70_000_000);
  assert.equal(resolveGoalTarget('car', state.drafts, state.overrides.car).amount, 35_000_000);
  assert.deepEqual(state.overrides, { free: '70000000' });
  const followed = run({ type: 'select', goal: 'home' }, { type: 'typeTarget', text: '1' }, { type: 'followDetails' });
  assert.deepEqual(followed.overrides, {});
  assert.deepEqual(updateGoalPlanner(state, { type: 'reset', drafts: createGoalDrafts() }), createGoalPlanner());
});

test('a free goal\'s amount follows its method: typing means direct, rows and undecided drop typed text', () => {
  const rows = updateGoalPlanner(createGoalPlanner(), { type: 'freeMethod', method: 'items' });
  const typed = updateGoalPlanner(rows, { type: 'typeTarget', text: '30000000' });
  assert.equal(typed.drafts.free.method, 'direct');
  assert.equal(typed.overrides.free, '30000000');
  const kept = updateGoalPlanner(typed, { type: 'freeMethod', method: 'direct' });
  assert.equal(kept.overrides.free, '30000000');
  for (const method of ['items', 'undecided'] as const) {
    const handedBack = updateGoalPlanner(typed, { type: 'freeMethod', method });
    assert.equal(handedBack.drafts.free.method, method);
    assert.equal(handedBack.overrides.free, undefined);
  }
  // Typing for another type never changes the free goal's method.
  const home = updateGoalPlanner(updateGoalPlanner(rows, { type: 'select', goal: 'home' }), { type: 'typeTarget', text: '5' });
  assert.equal(home.drafts.free.method, 'items');
});
