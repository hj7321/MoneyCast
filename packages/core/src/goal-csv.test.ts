import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildProjectionCsv, calculateProjection, compareGoalTarget, createGoalDrafts, csvCell, describeGoal, formatCompactKRW, goalCsvSummary,
  resolveGoalTarget, type GoalDrafts,
} from './index.ts';

const now = new Date(2026, 9, 28);

test('csv cells quote separators and keep typed text from running as a spreadsheet formula', () => {
  assert.equal(csvCell('결혼 자금'), '결혼 자금');
  assert.equal(csvCell(-1200), '-1200');
  assert.equal(csvCell(Number.NaN), '');
  assert.equal(csvCell('예식 2,000만 원'), '"예식 2,000만 원"');
  assert.equal(csvCell('따옴표 "여기"'), '"따옴표 ""여기"""');
  for (const text of ['=HYPERLINK("x")', '+1', '-1+2', '@SUM(A1)', '\t=1', '\r=1']) assert.equal(csvCell(text).replace(/^"/, '')[0], "'", text);
  assert.equal(csvCell('=1,2'), '"\'=1,2"');
});

test('the export starts with the goal and the assumptions, then the same monthly rows as before', () => {
  const base = createGoalDrafts();
  const drafts: GoalDrafts = { ...base, free: { ...base.free, name: '=결혼 자금', method: 'items', items: [{ label: '예식', amount: '20000000' }, { label: '여행', amount: '5000000' }] } };
  const resolution = resolveGoalTarget('free', drafts);
  const comparison = compareGoalTarget(resolution, { on: true, rate: '2' }, 24);
  const input = { initial: 10_000_000, monthly: 500_000, annualRate: 5, years: 2, target: comparison.target };
  const projection = calculateProjection(input);
  const summary = goalCsvSummary({ goal: describeGoal('free', drafts), resolution, comparison, input, projection, now, format: formatCompactKRW });
  assert.deepEqual(summary.slice(0, 6), [
    ['목표', '=결혼 자금'], ['목표 금액 출처', '상세 계산'], ['목표 금액(원)', 25_000_000], ['계산식', '예식 2,000만 원 + 여행 500만 원'],
    ['연 물가상승률 가정(%)', 2], ['물가 반영 목표 금액(원)', 26_010_000],
  ]);
  assert.deepEqual(summary.slice(6, 12), [
    ['현재 시드머니(원)', 10_000_000], ['매월 저축·투자 금액(원)', 500_000], ['연간 예상 수익률(%)', 5], ['목표 기간(개월)', 24],
    ['목표 시점', '2028년 10월'], ['예상 자산(원)', projection.finalBalance],
  ]);
  assert.deepEqual(summary[12], ['예상 목표 달성률(%)', Math.round(projection.finalBalance / 26_010_000 * 1000) / 10]);
  assert.match(String(summary.at(-1)![1]), /참고용 시뮬레이션/);

  const lines = buildProjectionCsv(projection, summary).split('\r\n');
  assert.deepEqual(lines.slice(0, 3), ['항목,값', "목표,'=결혼 자금", '목표 금액 출처,상세 계산']);
  assert.equal(lines[4], '계산식,"예식 2,000만 원 + 여행 500만 원"');
  const header = lines.indexOf('개월,납입 원금(원),예상 자산(원),예상 수익(원)');
  assert.equal(lines[header - 1], '');
  assert.equal(lines.length - header - 1, 25);
  assert.equal(lines.at(-1), `24,${projection.points.at(-1)!.principal},${projection.finalBalance},${projection.totalProfit}`);
  assert.equal(buildProjectionCsv(projection).split('\r\n')[0], '개월,납입 원금(원),예상 자산(원),예상 수익(원)');
});

test('an undecided goal is written as such, without a formula, price rise or achievement', () => {
  const base = createGoalDrafts();
  const drafts: GoalDrafts = { ...base, free: { ...base.free, method: 'undecided' } };
  const resolution = resolveGoalTarget('free', drafts);
  const comparison = compareGoalTarget(resolution, { on: true, rate: '2' }, 60);
  const input = { initial: 10_000_000, monthly: 500_000, annualRate: 5, years: 5, target: comparison.target };
  const summary = goalCsvSummary({ goal: '자유 목표', resolution, comparison, input, projection: calculateProjection(input), now, format: formatCompactKRW });
  const labels = summary.map(([label]) => label);
  assert.deepEqual(summary[2], ['목표 금액(원)', '미정']);
  for (const absent of ['계산식', '연 물가상승률 가정(%)', '예상 목표 달성률(%)']) assert.equal(labels.includes(absent), false, absent);
});
