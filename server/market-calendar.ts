// Regular-session calendar for the exchanges history insights measure against.
// Pure: every function takes its clock as an argument and reads no I/O.
//
// The holiday, early-close and late-open tables were entered from the
// exchanges' published schedules and statutory holiday rules as recalled at
// authoring time, not checked against an official notice in this change. They
// MUST be re-verified against KRX and Nasdaq notices before release and
// extended every year end (plan B-10); CALENDAR_VERIFIED stays false until
// then. Dates outside a declared coverage range yield 'calendar_unverified',
// never a weekday-only guess, because a missed early close would let an
// already-settled close pass for a post-article price.

export type Exchange = 'KRX' | 'NASDAQ';
export type CalendarBasis = 'exchange_calendar' | 'weekdays_only';
export type SessionPhase = 'before_open' | 'in_session' | 'after_close';

export const CALENDAR_UNVERIFIED = 'calendar_unverified' as const;
export type CalendarUnverified = typeof CALENDAR_UNVERIFIED;

/** False until every table below is checked against the exchanges' official notices. */
export const CALENDAR_VERIFIED = false;

/** Article stamps can precede actual publication slightly (plan B-2). */
export const ARTICLE_DELAY_MS = 5 * 60_000;
const DAY_MS = 86_400_000;

/** One regular session; times are UTC epoch milliseconds, `date` is the exchange-local date. */
export interface Session {
  date: string;
  openMs: number;
  closeMs: number;
}

interface ExchangeCalendar {
  timeZone: string;
  open: string;
  close: string;
  /** Inclusive exchange-local dates the tables below are complete for. */
  coverage: { from: string; to: string };
  holidays: ReadonlySet<string>;
  earlyCloses: ReadonlyMap<string, string>;
  lateOpens: ReadonlyMap<string, string>;
}

// KRX: full-day closures only. KRX has no early closes. Late opens (first
// trading day 10:00, the CSAT day 10:00-16:30) are left out on purpose: a
// missing late open or late close only defers entry, while a wrong one would
// place entry before the article (plan "개장 지연일").
const KRX_HOLIDAYS = [
  // 2023
  '2023-01-23', '2023-01-24', '2023-03-01', '2023-05-01', '2023-05-05', '2023-05-29', '2023-06-06',
  '2023-08-15', '2023-09-28', '2023-09-29', '2023-10-02', '2023-10-03', '2023-10-09', '2023-12-25', '2023-12-29',
  // 2024
  '2024-01-01', '2024-02-09', '2024-02-12', '2024-03-01', '2024-04-10', '2024-05-01', '2024-05-06', '2024-05-15',
  '2024-06-06', '2024-08-15', '2024-09-16', '2024-09-17', '2024-09-18', '2024-10-01', '2024-10-03', '2024-10-09',
  '2024-12-25', '2024-12-31',
  // 2025
  '2025-01-01', '2025-01-27', '2025-01-28', '2025-01-29', '2025-01-30', '2025-03-03', '2025-05-01', '2025-05-05',
  '2025-05-06', '2025-06-03', '2025-06-06', '2025-08-15', '2025-10-03', '2025-10-06', '2025-10-07', '2025-10-08',
  '2025-10-09', '2025-12-25', '2025-12-31',
  // 2026
  '2026-01-01', '2026-02-16', '2026-02-17', '2026-02-18', '2026-03-02', '2026-05-01', '2026-05-05', '2026-05-25',
  '2026-06-03', '2026-08-17', '2026-09-24', '2026-09-25', '2026-10-05', '2026-10-09', '2026-12-25', '2026-12-31',
];

// Nasdaq follows the NYSE holiday schedule; early closes are 13:00 ET.
const NASDAQ_HOLIDAYS = [
  // 2023
  '2023-01-02', '2023-01-16', '2023-02-20', '2023-04-07', '2023-05-29', '2023-06-19', '2023-07-04', '2023-09-04',
  '2023-11-23', '2023-12-25',
  // 2024
  '2024-01-01', '2024-01-15', '2024-02-19', '2024-03-29', '2024-05-27', '2024-06-19', '2024-07-04', '2024-09-02',
  '2024-11-28', '2024-12-25',
  // 2025 (01-09: national day of mourning)
  '2025-01-01', '2025-01-09', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26', '2025-06-19', '2025-07-04',
  '2025-09-01', '2025-11-27', '2025-12-25',
  // 2026
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07',
  '2026-11-26', '2026-12-25',
  // 2027
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06',
  '2027-11-25', '2027-12-24',
];
const NASDAQ_EARLY_CLOSES = [
  '2023-07-03', '2023-11-24',
  '2024-07-03', '2024-11-29', '2024-12-24',
  '2025-07-03', '2025-11-28', '2025-12-24',
  '2026-11-27', '2026-12-24',
  '2027-11-26',
];

export const EXCHANGE_CALENDARS: Readonly<Record<Exchange, ExchangeCalendar>> = {
  KRX: {
    timeZone: 'Asia/Seoul', open: '09:00', close: '15:30',
    coverage: { from: '2023-01-01', to: '2026-12-31' },
    holidays: new Set(KRX_HOLIDAYS),
    earlyCloses: new Map(),
    lateOpens: new Map(),
  },
  NASDAQ: {
    timeZone: 'America/New_York', open: '09:30', close: '16:00',
    coverage: { from: '2023-01-01', to: '2027-12-31' },
    holidays: new Set(NASDAQ_HOLIDAYS),
    earlyCloses: new Map(NASDAQ_EARLY_CLOSES.map(date => [date, '13:00'])),
    lateOpens: new Map(),
  },
};

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let value = formatters.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formatters.set(timeZone, value);
  }
  return value;
}

function wallClock(ms: number, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return { year: parts.year!, month: parts.month!, day: parts.day!, hour: parts.hour! % 24, minute: parts.minute!, second: parts.second! };
}

/** Zone offset (local minus UTC) at an instant, from Intl rather than a fixed table so DST follows the zone database. */
function offsetMs(ms: number, timeZone: string): number {
  const wall = wallClock(ms, timeZone);
  const base = Math.floor(ms / 1000) * 1000;
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - base;
}

function parseDate(date: string): [number, number, number] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new RangeError(`invalid date: ${date}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Local wall time on a date in a zone, as UTC epoch milliseconds. Two passes settle the offset across a DST change. */
export function zonedTimeToUtc(date: string, time: string, timeZone: string): number {
  const [year, month, day] = parseDate(date);
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) throw new RangeError(`invalid time: ${time}`);
  const wall = Date.UTC(year, month - 1, day, Number(match[1]), Number(match[2]));
  const first = wall - offsetMs(wall, timeZone);
  return wall - offsetMs(first, timeZone);
}

const pad = (value: number) => String(value).padStart(2, '0');

/** Exchange-local calendar date of an instant. */
export function localDate(exchange: Exchange, ms: number): string {
  const wall = wallClock(ms, EXCHANGE_CALENDARS[exchange].timeZone);
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}`;
}

export function addDays(date: string, days: number): string {
  const [year, month, day] = parseDate(date);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function weekday(date: string): number {
  const [year, month, day] = parseDate(date);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function inCoverage(exchange: Exchange, date: string): boolean {
  const { from, to } = EXCHANGE_CALENDARS[exchange].coverage;
  return date >= from && date <= to;
}

/**
 * The regular session on an exchange-local date, null when the exchange is
 * closed. `weekdays_only` ignores the tables and their coverage and exists for
 * display-only target windows (plan "표 범위를 넘는 targetWindow").
 */
export function sessionOn(exchange: Exchange, date: string, basis: CalendarBasis = 'exchange_calendar'): Session | null | CalendarUnverified {
  const calendar = EXCHANGE_CALENDARS[exchange];
  const day = weekday(date);
  if (basis === 'exchange_calendar' && !inCoverage(exchange, date)) return CALENDAR_UNVERIFIED;
  if (day === 0 || day === 6) return null;
  if (basis === 'weekdays_only') {
    return { date, openMs: zonedTimeToUtc(date, calendar.open, calendar.timeZone), closeMs: zonedTimeToUtc(date, calendar.close, calendar.timeZone) };
  }
  if (calendar.holidays.has(date)) return null;
  const open = calendar.lateOpens.get(date) ?? calendar.open;
  const close = calendar.earlyCloses.get(date) ?? calendar.close;
  return { date, openMs: zonedTimeToUtc(date, open, calendar.timeZone), closeMs: zonedTimeToUtc(date, close, calendar.timeZone) };
}

// Longest closure in the tables is under ten days; the bound only stops a runaway scan.
const MAX_SCAN_DAYS = 400;

function scan(exchange: Exchange, start: string, step: 1 | -1, count: number, basis: CalendarBasis,
  accept: (session: Session) => boolean): Session[] | CalendarUnverified {
  const found: Session[] = [];
  let date = start;
  for (let days = 0; found.length < count; days += 1, date = addDays(date, step)) {
    if (days > MAX_SCAN_DAYS + count * 2) return CALENDAR_UNVERIFIED;
    const session = sessionOn(exchange, date, basis);
    if (session === CALENDAR_UNVERIFIED) return CALENDAR_UNVERIFIED;
    if (session && accept(session)) found.push(session);
  }
  return found;
}

/** The first `count` sessions whose open is at or after `fromMs`. */
export function sessionsFrom(exchange: Exchange, fromMs: number, count: number, basis: CalendarBasis = 'exchange_calendar'): Session[] | CalendarUnverified {
  if (count <= 0) return [];
  return scan(exchange, localDate(exchange, fromMs), 1, count, basis, session => session.openMs >= fromMs);
}

/** The `count` sessions after an exchange-local date, ascending. */
export function sessionsAfter(exchange: Exchange, date: string, count: number, basis: CalendarBasis = 'exchange_calendar'): Session[] | CalendarUnverified {
  if (count <= 0) return [];
  return scan(exchange, addDays(date, 1), 1, count, basis, () => true);
}

/** The `count` sessions before an exchange-local date, ascending. */
export function sessionsBefore(exchange: Exchange, date: string, count: number, basis: CalendarBasis = 'exchange_calendar'): Session[] | CalendarUnverified {
  if (count <= 0) return [];
  const found = scan(exchange, addDays(date, -1), -1, count, basis, () => true);
  return found === CALENDAR_UNVERIFIED ? found : found.reverse();
}

/** The latest session whose close is at or before `atMs`. */
export function lastClosedSession(exchange: Exchange, atMs: number, basis: CalendarBasis = 'exchange_calendar'): Session | CalendarUnverified {
  const found = scan(exchange, localDate(exchange, atMs), -1, 1, basis, session => session.closeMs <= atMs);
  return found === CALENDAR_UNVERIFIED ? found : found[0]!;
}

export type ArticleTiming =
  /** open < t′ ≤ close of session D: the first observable price is D's close. */
  | { kind: 'in_session'; tPrimeMs: number; session: Session }
  /** Before an open, after a close, or on a closed day: E is the first session opening at or after t′. */
  | { kind: 'out_of_session'; tPrimeMs: number; session: Session };

export interface ArticleTimeOptions {
  /** 'day' marks a midnight stamp whose time of day is unknown (plan "기사 시각 오류"). */
  precision?: 'exact' | 'day';
  basis?: CalendarBasis;
}

/**
 * Classifies an article by t′ = publishedAt + 5 minutes. A day-precision stamp
 * could be any time that day, so it enters at the first open at or after the
 * end of that day plus the same margin.
 */
export function classifyArticleTime(exchange: Exchange, publishedAtMs: number, options: ArticleTimeOptions = {}): ArticleTiming | CalendarUnverified {
  const basis = options.basis ?? 'exchange_calendar';
  if (options.precision === 'day') {
    const tPrimeMs = publishedAtMs + DAY_MS + ARTICLE_DELAY_MS;
    if (basis === 'exchange_calendar' && !inCoverage(exchange, localDate(exchange, publishedAtMs))) return CALENDAR_UNVERIFIED;
    const next = sessionsFrom(exchange, tPrimeMs, 1, basis);
    return next === CALENDAR_UNVERIFIED ? next : { kind: 'out_of_session', tPrimeMs, session: next[0]! };
  }
  const tPrimeMs = publishedAtMs + ARTICLE_DELAY_MS;
  const today = sessionOn(exchange, localDate(exchange, tPrimeMs), basis);
  if (today === CALENDAR_UNVERIFIED) return today;
  if (today && today.openMs < tPrimeMs && tPrimeMs <= today.closeMs) return { kind: 'in_session', tPrimeMs, session: today };
  const next = sessionsFrom(exchange, tPrimeMs, 1, basis);
  return next === CALENDAR_UNVERIFIED ? next : { kind: 'out_of_session', tPrimeMs, session: next[0]! };
}

export interface TargetSession {
  /** N: the nearest regular session that has not yet closed. */
  session: Session;
  /** N−1, whose close is the next-day return's base. */
  previous: Session;
  phase: SessionPhase;
}

/**
 * Next-trading-day target. Before the open and during the session it is
 * today; at or after the close, on weekends and on holidays it is the next
 * session, and the phase reads after_close.
 */
export function targetSession(exchange: Exchange, nowMs: number, basis: CalendarBasis = 'exchange_calendar'): TargetSession | CalendarUnverified {
  const date = localDate(exchange, nowMs);
  const today = sessionOn(exchange, date, basis);
  if (today === CALENDAR_UNVERIFIED) return today;
  let session: Session;
  let phase: SessionPhase;
  if (today && nowMs < today.closeMs) {
    session = today;
    phase = nowMs < today.openMs ? 'before_open' : 'in_session';
  } else {
    const next = sessionsAfter(exchange, date, 1, basis);
    if (next === CALENDAR_UNVERIFIED) return next;
    session = next[0]!;
    phase = 'after_close';
  }
  const previous = sessionsBefore(exchange, session.date, 1, basis);
  if (previous === CALENDAR_UNVERIFIED) return previous;
  return { session, previous: previous[0]!, phase };
}

/** Overnight news window for a target session: t′ in (previous close, this open]. */
export interface OvernightWindow {
  startMs: number;
  endMs: number;
}

export function overnightWindow(exchange: Exchange, session: Session, basis: CalendarBasis = 'exchange_calendar'): OvernightWindow | CalendarUnverified {
  const previous = sessionsBefore(exchange, session.date, 1, basis);
  if (previous === CALENDAR_UNVERIFIED) return previous;
  return { startMs: previous[0]!.closeMs, endMs: session.openMs };
}

/**
 * Same boundaries as classifyArticleTime: an article whose t′ lands in a
 * session belongs to no window. A day-precision stamp counts only when the
 * whole day it could fall in lies inside the window.
 */
export function inOvernightWindow(window: OvernightWindow, publishedAtMs: number, precision: 'exact' | 'day' = 'exact'): boolean {
  const earliest = publishedAtMs + ARTICLE_DELAY_MS;
  const latest = precision === 'day' ? earliest + DAY_MS : earliest;
  return window.startMs < earliest && latest <= window.endMs;
}

/** Weekly sample anchor: Sunday 23:50 UTC, before both markets' Monday opens even after the 5-minute margin. */
export const WEEKLY_AS_OF_UTC = { weekday: 0, hour: 23, minute: 50 } as const;

/** The latest weekly anchor at or before `atMs`. */
export function weeklyAsOfAtOrBefore(atMs: number): number {
  const day = new Date(atMs);
  const sameDay = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), WEEKLY_AS_OF_UTC.hour, WEEKLY_AS_OF_UTC.minute);
  let anchor = sameDay - ((day.getUTCDay() - WEEKLY_AS_OF_UTC.weekday + 7) % 7) * DAY_MS;
  if (anchor > atMs) anchor -= 7 * DAY_MS;
  return anchor;
}

/** Weekly anchors in [fromMs, toMs], ascending. */
export function weeklyAsOfsBetween(fromMs: number, toMs: number): number[] {
  const anchors: number[] = [];
  let anchor = weeklyAsOfAtOrBefore(toMs);
  while (anchor >= fromMs) { anchors.push(anchor); anchor -= 7 * DAY_MS; }
  return anchors.reverse();
}

/** The five sessions a weekly sample measures: next open after asOf + 5 minutes through the fourth session after it. */
export function weekSessions(exchange: Exchange, asOfMs: number, basis: CalendarBasis = 'exchange_calendar'): Session[] | CalendarUnverified {
  return sessionsFrom(exchange, asOfMs + ARTICLE_DELAY_MS, 5, basis);
}

export interface WeeklyWindow {
  asOfMs: number;
  sessions: Session[] | null;
  /** overlap: entry before the last kept window's exit (holiday weeks); such a week is skipped. */
  skip: 'overlap' | 'calendar_unverified' | null;
}

/** Weekly windows for ascending anchors, skipping any that would overlap the previous kept window. */
export function weeklyWindows(exchange: Exchange, asOfs: readonly number[]): WeeklyWindow[] {
  let lastExitMs = -Infinity;
  return asOfs.map(asOfMs => {
    const sessions = weekSessions(exchange, asOfMs);
    if (sessions === CALENDAR_UNVERIFIED) return { asOfMs, sessions: null, skip: CALENDAR_UNVERIFIED };
    if (sessions[0]!.openMs < lastExitMs) return { asOfMs, sessions, skip: 'overlap' };
    lastExitMs = sessions[sessions.length - 1]!.closeMs;
    return { asOfMs, sessions, skip: null };
  });
}

/** Display window for one horizon; dates are exchange-local. */
export interface TargetWindow {
  start: string;
  end: string;
  basis: CalendarBasis;
  exchange: Exchange;
  phase: SessionPhase;
}

/** Five sessions a request at `nowMs` looks ahead to, by the same entry rule as an article at that time. */
function fiveSessionsAhead(exchange: Exchange, nowMs: number, basis: CalendarBasis): Session[] | CalendarUnverified {
  const timing = classifyArticleTime(exchange, nowMs - ARTICLE_DELAY_MS, { basis });
  if (timing === CALENDAR_UNVERIFIED) return timing;
  if (timing.kind === 'in_session') return sessionsAfter(exchange, timing.session.date, 5, basis);
  const rest = sessionsAfter(exchange, timing.session.date, 4, basis);
  return rest === CALENDAR_UNVERIFIED ? rest : [timing.session, ...rest];
}

/**
 * Request-time windows (never stored, so a past session is never shown as
 * next). Outside table coverage they fall back to weekdays_only for display;
 * nothing measured may use that basis.
 */
export function dayTargetWindow(exchange: Exchange, nowMs: number): { targetWindow: TargetWindow; newsWindow: { start: string; end: string } } {
  let basis: CalendarBasis = 'exchange_calendar';
  let target = targetSession(exchange, nowMs, basis);
  if (target === CALENDAR_UNVERIFIED) { basis = 'weekdays_only'; target = targetSession(exchange, nowMs, basis) as TargetSession; }
  return {
    targetWindow: { start: target.session.date, end: target.session.date, basis, exchange, phase: target.phase },
    newsWindow: { start: new Date(target.previous.closeMs).toISOString(), end: new Date(target.session.openMs).toISOString() },
  };
}

export function weekTargetWindow(exchange: Exchange, nowMs: number): TargetWindow {
  let basis: CalendarBasis = 'exchange_calendar';
  let sessions = fiveSessionsAhead(exchange, nowMs, basis);
  let target = targetSession(exchange, nowMs, basis);
  if (sessions === CALENDAR_UNVERIFIED || target === CALENDAR_UNVERIFIED) {
    basis = 'weekdays_only';
    sessions = fiveSessionsAhead(exchange, nowMs, basis) as Session[];
    target = targetSession(exchange, nowMs, basis) as TargetSession;
  }
  return { start: sessions[0]!.date, end: sessions[sessions.length - 1]!.date, basis, exchange, phase: target.phase };
}
