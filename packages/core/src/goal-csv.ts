/**
 * The CSV export: the goal and the calculator's assumptions first, then the
 * month-by-month projection. Goal names and places are typed by the person,
 * so a text cell that a spreadsheet would run as a formula is prefixed with
 * an apostrophe.
 */
import { GOAL_SOURCE_LABELS, formatGoalFormula, type GoalTargetResolution } from './goals.js';
import { formatYearMonth, periodEndMonth, type GoalComparison } from './goal-time.js';
import type { CalculatorInput, Projection } from './index.js';

export type CsvValue = string | number;

export function csvCell(value: CsvValue): string {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Summary rows, a blank row, then one row per month. */
export function buildProjectionCsv(projection: Projection, summary: ReadonlyArray<readonly [string, CsvValue]> = []): string {
  const rows: ReadonlyArray<readonly CsvValue[]> = [
    ...(summary.length ? [['항목', '값'], ...summary, []] : []),
    ['개월', '납입 원금(원)', '예상 자산(원)', '예상 수익(원)'],
    ...projection.points.map(point => [point.month, point.principal, point.balance, point.profit]),
  ];
  return rows.map(row => row.map(csvCell).join(',')).join('\r\n');
}

export interface GoalCsvInput {
  /** The goal's name as the result area shows it (`describeGoal`). */
  goal: string;
  resolution: GoalTargetResolution;
  comparison: GoalComparison;
  input: CalculatorInput;
  projection: Projection;
  now: Date;
  /** Formats the amounts inside the formula text. */
  format: (amount: number) => string;
}

/** What the projection was calculated for; amounts are plain numbers so a spreadsheet can use them. */
export function goalCsvSummary({ goal, resolution, comparison, input, projection, now, format }: GoalCsvInput): Array<[string, CsvValue]> {
  const { source, amount, lines } = resolution;
  const rows: Array<[string, CsvValue]> = [
    ['목표', goal],
    ['목표 금액 출처', GOAL_SOURCE_LABELS[source]],
    ['목표 금액(원)', source === 'undecided' || amount === null || !Number.isFinite(amount) ? '미정' : Math.round(amount)],
  ];
  if (source === 'details' && lines.length) rows.push(['계산식', formatGoalFormula(lines, format)]);
  if (comparison.inflation) rows.push(['연 물가상승률 가정(%)', comparison.inflation.rate], ['물가 반영 목표 금액(원)', comparison.inflation.amount]);
  rows.push(
    ['현재 시드머니(원)', input.initial],
    ['매월 저축·투자 금액(원)', input.monthly],
    ['연간 예상 수익률(%)', input.annualRate],
    ['목표 기간(개월)', projection.months],
    ['목표 시점', formatYearMonth(periodEndMonth(projection.months, now))],
    ['예상 자산(원)', projection.finalBalance],
  );
  if (input.target > 0) rows.push(['예상 목표 달성률(%)', Math.round(projection.finalBalance / input.target * 1000) / 10]);
  rows.push(['안내', '참고용 시뮬레이션입니다. 수익률은 가정이며 세금·수수료는 반영하지 않았습니다.']);
  return rows;
}
