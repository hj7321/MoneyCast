import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compareGoalTarget, createGoalDrafts, createGoalPlanner, describeGoalResult, describeInflation, formatCompactKRW, formatYearMonth,
  monthInputValue, monthsFromTargetMonth, monthsUntil, parseYearMonth, periodEndMonth, resolveGoalTarget, updateGoalPlanner,
  type GoalTargetResolution,
} from './index.ts';

const now = new Date(2026, 9, 28);
const fixed = (amount: number | null, source: GoalTargetResolution['source'] = 'manual'): GoalTargetResolution =>
  ({ source, amount, lines: [], zeroed: [], missing: [], errors: {} });

test('a target month reads in the usual written forms and becomes the saving period', () => {
  for (const text of ['2028-03', '2028-3', '2028.03', '2028/3', '2028년 3월', ' 2028 년 03 월 ']) {
    assert.deepEqual(parseYearMonth(text), { year: 2028, month: 3 }, text);
  }
  for (const text of ['', '2028', '2028-13', '2028-00', '28-03', '내년 3월', '2028-03-01']) assert.equal(parseYearMonth(text), null, text);
  assert.deepEqual(monthsFromTargetMonth('2028-03', now), { months: 17 });
  assert.deepEqual(monthsFromTargetMonth('2026-11', now), { months: 1 });
  assert.match((monthsFromTargetMonth('2026-10', now) as { error: string }).error, /다음 달 이후/);
  assert.match((monthsFromTargetMonth('2077-01', now) as { error: string }).error, /600개월/);
  assert.match((monthsFromTargetMonth('3월', now) as { error: string }).error, /2028-03처럼/);
});

test('the end month of a period is the inverse of counting months to a target month', () => {
  for (const months of [1, 2, 3, 12, 13, 17, 60, 600]) {
    const end = periodEndMonth(months, now);
    assert.equal(monthsUntil(end.year, end.month, now), months, String(months));
  }
  assert.deepEqual(periodEndMonth(60, now), { year: 2031, month: 10 });
  assert.equal(formatYearMonth(periodEndMonth(2, now)), '2026년 12월');
  assert.equal(formatYearMonth(periodEndMonth(3, now)), '2027년 1월');
  assert.equal(monthInputValue(periodEndMonth(5, now)), '2027-03');
});

test('an assumed price rise grows today\'s target until the period ends, and only when turned on', () => {
  const target = fixed(50_000_000);
  assert.deepEqual(compareGoalTarget(target, { on: false, rate: '3' }, 60), { target: 50_000_000 });
  assert.deepEqual(compareGoalTarget(target, { on: true, rate: '' }, 60), { target: 50_000_000, pending: true });
  const grown = compareGoalTarget(target, { on: true, rate: '2' }, 60);
  assert.equal(grown.target, Math.round(50_000_000 * 1.02 ** 5));
  assert.deepEqual(grown.inflation, { rate: 2, base: 50_000_000, amount: 55_204_040, months: 60 });
  assert.equal(compareGoalTarget(target, { on: true, rate: '2' }, 18).target, Math.round(50_000_000 * 1.02 ** 1.5));
  assert.equal(compareGoalTarget(target, { on: true, rate: '0' }, 60).target, 50_000_000);
  assert.equal(describeInflation(grown, formatCompactKRW), '오늘 5,000만 원이 연 2%씩 오르면 5년 뒤 5,520.4만 원이에요. 이 금액과 비교해요.');
});

test('a price rise leaves undecided, zero and period-less targets alone and rejects rates out of range', () => {
  for (const resolution of [fixed(null, 'undecided'), fixed(0)]) {
    const result = compareGoalTarget(resolution, { on: true, rate: '3' }, 60);
    assert.equal(result.target, resolution.amount ?? 0);
    assert.equal(result.inflation, undefined);
  }
  assert.equal(compareGoalTarget(fixed(Number.NaN, 'details'), { on: true, rate: '3' }, 60).inflation, undefined);
  for (const months of [0, 1.5, Number.NaN, 601]) assert.equal(compareGoalTarget(fixed(10_000_000), { on: true, rate: '3' }, months).target, 10_000_000);
  for (const rate of ['-1', '20.1', 'abc', '1e9']) {
    const result = compareGoalTarget(fixed(10_000_000), { on: true, rate }, 60);
    assert.ok(Number.isNaN(result.target), rate);
    assert.match(result.error ?? '', /0~20%/, rate);
  }
  const ceiling = compareGoalTarget(fixed(900_000_000_000), { on: true, rate: '5' }, 120);
  assert.ok(Number.isNaN(ceiling.target));
  assert.match(ceiling.error ?? '', /1조 원/);
  assert.equal(describeInflation({ target: 0, pending: true }, formatCompactKRW), '연 물가상승률을 입력하면 목표 금액에 반영해요.');
});

test('the planner keeps the price-rise setting, a reset turns it off, and the result names the compared amount', () => {
  const on = updateGoalPlanner(updateGoalPlanner(createGoalPlanner(), { type: 'inflation', patch: { on: true } }), { type: 'inflation', patch: { rate: '2.5' } });
  assert.deepEqual(on.inflation, { on: true, rate: '2.5' });
  assert.deepEqual(updateGoalPlanner(on, { type: 'select', goal: 'car' }).inflation, { on: true, rate: '2.5' });
  assert.deepEqual(updateGoalPlanner(on, { type: 'reset', drafts: createGoalDrafts() }).inflation, { on: false, rate: '' });
  const drafts = createGoalDrafts();
  const resolution = resolveGoalTarget('free', drafts);
  assert.equal(describeGoalResult('free', drafts, resolution, formatCompactKRW), '자유 목표 · 예시 금액 5,000만 원');
  assert.equal(describeGoalResult('free', drafts, resolution, formatCompactKRW, 55_204_040), '자유 목표 · 예시 금액 5,000만 원 → 물가 반영 5,520.4만 원');
});
