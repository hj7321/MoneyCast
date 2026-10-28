/**
 * When a goal is due and what it may cost by then. A target month is another
 * way to enter the saving period, and an assumed yearly price rise grows
 * today's target until the period ends. Both are the person's own entries;
 * nothing here forecasts prices.
 */
import { parseGoalNumber, type GoalInflationDraft, type GoalTargetResolution } from './goals.js';
import { monthsUntil } from './goal-text.js';
import { formatDurationMonths } from './index.js';

export interface YearMonth { year: number; month: number }

/** Same ceiling as the calculator's amount fields. */
const AMOUNT_LIMIT = 1_000_000_000_000;
export const INFLATION_RATE_MAX = 20;

/** "2028-03" from a month picker, or "2028-3", "2028.03", "2028/3" and "2028년 3월" typed by hand. */
export function parseYearMonth(text: string): YearMonth | null {
  const match = /^(\d{4})\s*(?:[-./]|년)\s*(\d{1,2})\s*월?$/.exec(text.normalize('NFKC').trim());
  if (!match) return null;
  const month = Number(match[2]);
  return month >= 1 && month <= 12 ? { year: Number(match[1]), month } : null;
}

/** The calendar month a saving period ends in, counted from this month; the inverse of `monthsUntil`. */
export function periodEndMonth(months: number, now: Date): YearMonth {
  const index = now.getFullYear() * 12 + now.getMonth() + months;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

export function formatYearMonth({ year, month }: YearMonth): string {
  return `${year}년 ${month}월`;
}

/** The value an `<input type="month">` holds. */
export function monthInputValue({ year, month }: YearMonth): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** A target month as a saving period of 1–600 months, or why it cannot be one. */
export function monthsFromTargetMonth(text: string, now: Date): { months: number } | { error: string } {
  const target = parseYearMonth(text);
  if (!target) return { error: '목표 시점을 2028-03처럼 연도와 월로 입력해 주세요.' };
  const months = monthsUntil(target.year, target.month, now);
  if (months !== null) return { months };
  const ahead = (target.year - now.getFullYear()) * 12 + target.month - (now.getMonth() + 1);
  return { error: ahead < 1 ? '목표 시점은 다음 달 이후로 정해 주세요.' : '목표 시점은 50년(600개월) 안으로 정해 주세요.' };
}

/** What the calculator compares the projection against. */
export interface GoalComparison {
  /** The target, raised by the assumed price rise when it applies; NaN while the rate is invalid. */
  target: number;
  /** Set when the price rise changed what is compared. */
  inflation?: { rate: number; base: number; amount: number; months: number };
  /** For the rate field. */
  error?: string;
  /** The price rise is on but its rate is still empty. */
  pending?: boolean;
}

/**
 * Today's target grown by an assumed yearly rate until the period ends:
 * target × (1 + rate / 100)^(months / 12), rounded to won. An undecided or
 * zero target stays as it is, and so does any target while the period is
 * invalid, which the period field reports.
 */
export function compareGoalTarget(resolution: GoalTargetResolution, inflation: GoalInflationDraft, months: number): GoalComparison {
  const base = resolution.amount ?? 0;
  if (!inflation.on) return { target: base };
  const rate = parseGoalNumber(inflation.rate);
  if (rate === null) return { target: base, pending: true };
  if (!Number.isFinite(rate) || rate < 0 || rate > INFLATION_RATE_MAX) {
    return { target: Number.NaN, error: `물가상승률은 0~${INFLATION_RATE_MAX}% 사이로 입력해 주세요.` };
  }
  if (!Number.isFinite(base) || base <= 0 || !Number.isInteger(months) || months < 1 || months > 600) return { target: base };
  const amount = Math.round(base * (1 + rate / 100) ** (months / 12));
  if (amount > AMOUNT_LIMIT) return { target: Number.NaN, error: '물가상승을 반영한 목표 금액이 1조 원을 넘어요. 비율이나 기간을 줄여 주세요.' };
  return { target: amount, inflation: { rate, base, amount, months } };
}

/** The line under the rate field; worded as an assumption, never as a forecast. */
export function describeInflation(comparison: GoalComparison, format: (amount: number) => string): string {
  if (comparison.error) return comparison.error;
  if (comparison.pending) return '연 물가상승률을 입력하면 목표 금액에 반영해요.';
  const applied = comparison.inflation;
  if (!applied) return '목표 금액과 목표 기간이 정해지면 반영해요.';
  return `오늘 ${format(applied.base)}이 연 ${applied.rate}%씩 오르면 ${formatDurationMonths(applied.months)} 뒤 ${format(applied.amount)}이에요. 이 금액과 비교해요.`;
}
