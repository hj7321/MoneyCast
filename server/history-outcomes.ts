import {
  ARTICLE_DELAY_MS, CALENDAR_UNVERIFIED, classifyArticleTime, lastClosedSession, sessionOn, sessionsAfter, sessionsBefore, weekSessions,
  type CalendarUnverified, type Exchange, type Session,
} from './market-calendar.js';

// Outcomes over daily bars passed in by the caller. Pure: the evaluation
// clock, bars and calendar come in as arguments, so a replay at an earlier
// clock sees exactly what was knowable then.
//
// Raw-price corporate actions (B-16, A-17). A bar's base factor
// f = (close − change) / previous close is 1 on an ordinary day; |f − 1| above
// BASE_FACTOR_TOLERANCE marks an action day. A window spans the sessions after
// its entry session (s_1 … s_m), never the entry session itself, whose entry
// price already sits on the post-action basis. A stock window spanning an
// action day is excluded as suspect_corporate_action; a benchmark window is
// chained on the exchange base price, r = exit / (start × Π f) − 1, and flagged
// benchmark_chained. The ±SUSPECT_MOVE rule applies only to days without a
// factor. Adjusted series (adjClose) ignore factors. Bar arrays are treated as
// immutable: their date index is cached per array.

/** One regular-session daily bar. `adjClose` present means the provider's adjusted series (plan "기업행동"). */
export interface DailyBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  adjClose?: number;
  /**
   * Raw series only: the exchange base price over the previous session's close.
   * Valid only when finite and > 0; anything else counts as missing (no change field).
   */
  baseFactor?: number;
}

export type OutcomeLabel = 'up' | 'neutral' | 'down';
/** open: E open → E+4 close. close: D close → D+5 close. close_no_open: provider without opens, E close → E+5 close. */
export type EntryType = 'open' | 'close' | 'close_no_open';
export type PriceBasis = 'raw' | 'adjusted';
export type OutcomeStatus = 'complete' | 'pending' | 'excluded';
/**
 * price_gap: a bar of the measured sessions is missing (the exit is never
 * moved). invalid_bar: zero open, zero volume or prices outside high-low on
 * the entry or exit bar. suspect_corporate_action: an unadjusted single-day
 * move beyond the exchange limit. benchmark_gap excludes only the
 * market-relative samples; a case keeps r and is flagged instead.
 */
export type ExclusionReason = 'calendar_unverified' | 'price_gap' | 'invalid_bar' | 'suspect_corporate_action' | 'benchmark_gap';
/**
 * benchmark_gap: no market-relative value. no_open: provider without opens,
 * pre-open reaction not included. unadjusted: raw prices, small corporate
 * actions and ex-dividend drops not reflected. insufficient_volatility_history:
 * fewer than 50 valid prior returns, so no direction label. benchmark_chained:
 * the benchmark return was chained across a distribution day on the exchange
 * base price (A-17).
 */
export type OutcomeFlag = 'benchmark_gap' | 'no_open' | 'unadjusted' | 'insufficient_volatility_history' | 'benchmark_chained';

/** Unadjusted single-day moves beyond these are treated as corporate actions (KR price limit, US plan default). */
export const SUSPECT_MOVE: Readonly<Record<Exchange, number>> = { KRX: 0.3, NASDAQ: 0.5 };
/** |baseFactor − 1| above this marks a corporate-action (stock) or distribution (benchmark) day (B-16). */
export const BASE_FACTOR_TOLERANCE = 1e-6;
/** Bumped whenever a rule here changes a completed outcome; part of every frozen record's priceBasisVersion. */
export const OUTCOME_RULES_VERSION = 'outcomes-v1';
export const BAND_K = 0.25;
export const WEEK_BAND_FLOOR = 0.005;
export const DAY_BAND_FLOOR = 0.002;
export const SIGMA_RETURNS = 60;
export const SIGMA_MIN_VALID = 50;

export interface OutcomeClock {
  /** The clock the completion condition compares against (the job's run time, or a replay's asOf). */
  nowMs: number;
  /**
   * When a session's bar became knowable: production passes firstFetchedAt
   * or the provider's publication time. Defaults to the session close.
   */
  availableAtMs?: (session: Session) => number;
  /** False for a provider without opens; entries then use closes (plan "시가가 없는 제공자"). */
  openAvailable?: boolean;
}

interface OutcomeBase {
  status: OutcomeStatus;
  reason: ExclusionReason | null;
  entryType: EntryType | null;
  entryDate: string | null;
  exitDate: string | null;
  /** When the entry price was set: the entry session's open or close. */
  entryAtMs: number | null;
  exitAtMs: number | null;
  /** Session dates from the entry session through the exit session. */
  sessions: string[];
  basis: PriceBasis | null;
  r: number | null;
  benchmarkR: number | null;
  relative: number | null;
  /** Daily standard deviation the band was built from. */
  sigma: number | null;
  band: number | null;
  label: OutcomeLabel | null;
  flags: OutcomeFlag[];
}

/** Five-trading-day outcome after one article; labelled on the raw return (display cases). */
export interface CaseOutcome extends OutcomeBase {
  tPrimeMs: number;
}

/** Five sessions after a weekly asOf; labelled on the market-relative return. */
export interface WeeklyOutcome extends OutcomeBase {
  weekAsOfMs: number;
}

/** close(N)/close(N−1) − 1 and open(N) → close(N); labelled on the market-relative close-to-close return. */
export interface NextDayOutcome extends OutcomeBase {
  intraday: number | null;
  benchmarkIntraday: number | null;
  relativeIntraday: number | null;
}

const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const hasAdjusted = (bar: DailyBar) => bar.adjClose !== undefined;

/** Entry/exit bar check (plan "가격 데이터 규칙"). */
export function isUsableBar(bar: DailyBar, openAvailable = true): boolean {
  if (!positive(bar.close) || !positive(bar.high) || !positive(bar.low) || !positive(bar.volume)) return false;
  if (bar.low > bar.high || bar.close < bar.low || bar.close > bar.high) return false;
  if (bar.adjClose !== undefined && !positive(bar.adjClose)) return false;
  if (openAvailable && (!positive(bar.open) || bar.open < bar.low || bar.open > bar.high)) return false;
  return true;
}

const barIndexes = new WeakMap<readonly DailyBar[], { length: number; map: Map<string, DailyBar> }>();

/** Date index of a bar array, cached per array (the length check catches an append). */
function indexBars(bars: readonly DailyBar[]): Map<string, DailyBar> {
  const cached = barIndexes.get(bars);
  if (cached && cached.length === bars.length) return cached.map;
  const map = new Map<string, DailyBar>();
  for (const bar of bars) map.set(bar.date, bar);
  barIndexes.set(bars, { length: bars.length, map });
  return map;
}

/** Whose return a window measures: the stock's own (actions exclude) or the benchmark's (actions chain). */
type SeriesRole = 'own' | 'benchmark';

/** The bar's valid base factor, or undefined when the change field was missing. */
const factorOf = (bar: DailyBar): number | undefined => positive(bar.baseFactor) ? bar.baseFactor : undefined;
const isAction = (factor: number | undefined): factor is number =>
  factor !== undefined && Math.abs(factor - 1) > BASE_FACTOR_TOLERANCE;

/** A series is adjusted only when every bar carries adjClose; a mix has no consistent basis. */
function basisOf(bars: readonly DailyBar[]): PriceBasis | null {
  const adjusted = bars.filter(hasAdjusted).length;
  if (adjusted === bars.length) return 'adjusted';
  return adjusted === 0 ? 'raw' : null;
}

const closeOf = (bar: DailyBar, basis: PriceBasis) => basis === 'adjusted' ? bar.adjClose! : bar.close;
/** Adjusted open = open × adjClose / close. */
const openOf = (bar: DailyBar, basis: PriceBasis) => basis === 'adjusted' ? bar.open * bar.adjClose! / bar.close : bar.open;

/**
 * Close-to-close return between consecutive sessions, null when a bar is
 * missing, bases differ, or a raw move is suspect. Raw days with a factor: an
 * action day drops the stock's return and chains the benchmark's; f = 1 keeps
 * the return whatever its size. Without a factor the ±limit rule decides.
 */
function dailyReturn(previous: DailyBar | undefined, current: DailyBar | undefined, limit: number, role: SeriesRole): number | null {
  if (!previous || !current || !positive(previous.close) || !positive(current.close)) return null;
  if (hasAdjusted(previous) !== hasAdjusted(current)) return null;
  if (hasAdjusted(current)) {
    if (!positive(previous.adjClose) || !positive(current.adjClose)) return null;
    return current.adjClose / previous.adjClose - 1;
  }
  const factor = factorOf(current);
  if (factor === undefined) {
    const value = current.close / previous.close - 1;
    return Math.abs(value) > limit ? null : value;
  }
  if (!isAction(factor)) return current.close / previous.close - 1;
  return role === 'own' ? null : current.close / (previous.close * factor) - 1;
}

function sampleStd(values: readonly number[]): number {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
}

/** The last session and the sixty before it, so sixty close-to-close returns end at `last`. */
function sigmaSessions(exchange: Exchange, last: Session): Session[] | CalendarUnverified {
  const before = sessionsBefore(exchange, last.date, SIGMA_RETURNS);
  return before === CALENDAR_UNVERIFIED ? before : [...before, last];
}

/**
 * Daily standard deviation from the sixty returns ending at `last`; returns
 * across a missing bar, a suspect day or a stock action day are dropped, and
 * fewer than fifty valid ones give null. With a benchmark the returns are
 * market-relative, a day needs both series, and the benchmark is chained on
 * distribution days. With a clock, a session's bars count only once they were
 * available at clock.nowMs; a pair touching a later one is dropped as missing.
 */
export function dailySigma(exchange: Exchange, last: Session, bars: readonly DailyBar[], benchmarkBars?: readonly DailyBar[],
  clock?: OutcomeClock): number | null {
  // Memoised per bar array: many outcomes share the session σ ends at. Exact as
  // long as bar arrays are not mutated and availability functions are pure.
  let memo = sigmaMemo.get(bars);
  if (!memo) { memo = new Map(); sigmaMemo.set(bars, memo); }
  const key = [exchange, last.date, last.closeMs, bars.length, idOf(benchmarkBars), benchmarkBars?.length ?? -1,
    clock ? clock.nowMs : '-', clock ? idOf(clock.availableAtMs) : '-'].join('|');
  const cached = memo.get(key);
  if (cached !== undefined) return cached;
  const value = computeSigma(exchange, last, bars, benchmarkBars, clock);
  if (memo.size >= 100_000) memo.clear();
  memo.set(key, value);
  return value;
}

const sigmaMemo = new WeakMap<readonly DailyBar[], Map<string, number | null>>();
const objectIds = new WeakMap<object, number>();
let nextObjectId = 1;
function idOf(value: object | undefined): number {
  if (!value) return 0;
  let id = objectIds.get(value);
  if (id === undefined) { id = nextObjectId++; objectIds.set(value, id); }
  return id;
}

function computeSigma(exchange: Exchange, last: Session, bars: readonly DailyBar[], benchmarkBars?: readonly DailyBar[],
  clock?: OutcomeClock): number | null {
  const sessions = sigmaSessions(exchange, last);
  if (sessions === CALENDAR_UNVERIFIED) return null;
  const own = indexBars(bars);
  const market = benchmarkBars ? indexBars(benchmarkBars) : null;
  const limit = SUSPECT_MOVE[exchange];
  const known = clock ? sessions.map(session => availableAt(clock, session) <= clock.nowMs) : null;
  const values: number[] = [];
  for (let i = 1; i < sessions.length; i += 1) {
    if (known && (!known[i - 1] || !known[i])) continue;
    const value = dailyReturn(own.get(sessions[i - 1]!.date), own.get(sessions[i]!.date), limit, 'own');
    if (value === null) continue;
    if (!market) { values.push(value); continue; }
    const benchmark = dailyReturn(market.get(sessions[i - 1]!.date), market.get(sessions[i]!.date), limit, 'benchmark');
    if (benchmark !== null) values.push(value - benchmark);
  }
  return values.length >= SIGMA_MIN_VALID ? sampleStd(values) : null;
}

/** Neutral band: ±max(floor, k × σ × √horizon). */
export function neutralBand(sigma: number, horizonSessions: number, floor: number): number {
  return Math.max(floor, BAND_K * sigma * Math.sqrt(horizonSessions));
}

/** Inside the band, boundaries included, is neutral. */
export function labelFor(value: number, band: number): OutcomeLabel {
  if (value > band) return 'up';
  if (value < -band) return 'down';
  return 'neutral';
}

interface WindowPlan {
  entryType: EntryType;
  /** Entry session first, exit session last. */
  sessions: Session[];
}

interface WindowPrices {
  r: number;
  basis: PriceBasis;
  /** The benchmark return was chained across an action day (product of factors ≠ 1). */
  chained: boolean;
}

/**
 * Prices for a planned window, or why the series cannot give one. The window
 * spans sessions[1..m]; the entry session's own factor never matters, except
 * that a factor on it skips the open-entry same-day check (B-16).
 */
function windowReturn(exchange: Exchange, plan: WindowPlan, bars: readonly DailyBar[], openAvailable: boolean, role: SeriesRole):
  WindowPrices | Exclude<ExclusionReason, 'benchmark_gap' | 'calendar_unverified'> {
  const index = indexBars(bars);
  const window = plan.sessions.map(session => index.get(session.date));
  if (window.some(bar => !bar)) return 'price_gap';
  const present = window as DailyBar[];
  const basis = basisOf(present);
  if (!basis) return 'price_gap';
  const entry = present[0]!;
  const exit = present[present.length - 1]!;
  if (!isUsableBar(entry, openAvailable) || !isUsableBar(exit, openAvailable)) return 'invalid_bar';
  if (present.some(bar => !positive(bar.close))) return 'invalid_bar';
  let chain = 1;
  if (basis === 'raw') {
    const limit = SUSPECT_MOVE[exchange];
    if (plan.entryType === 'open' && factorOf(entry) === undefined && Math.abs(entry.close / entry.open - 1) > limit) {
      return 'suspect_corporate_action';
    }
    for (let i = 1; i < present.length; i += 1) {
      const factor = factorOf(present[i]!);
      if (factor === undefined) {
        if (Math.abs(present[i]!.close / present[i - 1]!.close - 1) > limit) return 'suspect_corporate_action';
      } else if (isAction(factor)) {
        if (role === 'own') return 'suspect_corporate_action';
        chain *= factor;
      }
    }
  }
  const start = plan.entryType === 'open' ? openOf(entry, basis) : closeOf(entry, basis);
  return { r: closeOf(exit, basis) / (start * chain) - 1, basis, chained: chain !== 1 };
}

function emptyOutcome(status: OutcomeStatus, reason: ExclusionReason | null): OutcomeBase {
  return { status, reason, entryType: null, entryDate: null, exitDate: null, entryAtMs: null, exitAtMs: null, sessions: [],
    basis: null, r: null, benchmarkR: null, relative: null, sigma: null, band: null, label: null, flags: [] };
}

function planned(plan: WindowPlan, status: OutcomeStatus, reason: ExclusionReason | null): OutcomeBase {
  const entry = plan.sessions[0]!;
  const exit = plan.sessions[plan.sessions.length - 1]!;
  return { ...emptyOutcome(status, reason), entryType: plan.entryType, entryDate: entry.date, exitDate: exit.date,
    entryAtMs: plan.entryType === 'open' ? entry.openMs : entry.closeMs, exitAtMs: exit.closeMs,
    sessions: plan.sessions.map(session => session.date), flags: plan.entryType === 'close_no_open' ? ['no_open'] : [] };
}

/** Entry first, then `after` more sessions; the exit is always a close. */
function planFrom(exchange: Exchange, entry: Session, entryType: EntryType, after: number): WindowPlan | CalendarUnverified {
  const rest = sessionsAfter(exchange, entry.date, after);
  return rest === CALENDAR_UNVERIFIED ? rest : { entryType, sessions: [entry, ...rest] };
}

/** Out of session: E open → E+4 close (or E close → E+5 close without opens). */
function openEntryPlan(exchange: Exchange, entry: Session, openAvailable: boolean): WindowPlan | CalendarUnverified {
  return openAvailable ? planFrom(exchange, entry, 'open', 4) : planFrom(exchange, entry, 'close_no_open', 5);
}

const availableAt = (clock: OutcomeClock, session: Session) => clock.availableAtMs ? clock.availableAtMs(session) : session.closeMs;

/**
 * Every bar a result reads must be knowable at the clock, not only the exit:
 * a gap filled by a later fetch would otherwise decide price_gap or a suspect
 * move with information from after the clock.
 */
const allAvailable = (clock: OutcomeClock, sessions: readonly Session[]) => sessions.every(session => availableAt(clock, session) <= clock.nowMs);

/** Measured return and market-relative return for a plan, shared by the case and weekly outcomes. */
function measure(exchange: Exchange, plan: WindowPlan, bars: readonly DailyBar[], benchmarkBars: readonly DailyBar[] | null,
  clock: OutcomeClock): OutcomeBase {
  if (!allAvailable(clock, plan.sessions)) return planned(plan, 'pending', null);
  const openAvailable = clock.openAvailable ?? true;
  const own = windowReturn(exchange, plan, bars, openAvailable, 'own');
  if (typeof own === 'string') return planned(plan, 'excluded', own);
  const outcome = planned(plan, 'complete', null);
  outcome.basis = own.basis;
  outcome.r = own.r;
  if (own.basis === 'raw') outcome.flags.push('unadjusted');
  const market = benchmarkBars ? windowReturn(exchange, plan, benchmarkBars, openAvailable, 'benchmark') : null;
  if (market && typeof market !== 'string' && market.basis === own.basis) {
    outcome.benchmarkR = market.r;
    outcome.relative = own.r - market.r;
    if (market.chained) outcome.flags.push('benchmark_chained');
  } else {
    outcome.flags.push('benchmark_gap');
  }
  return outcome;
}

export interface CaseOutcomeInput extends OutcomeClock {
  exchange: Exchange;
  publishedAtMs: number;
  timePrecision?: 'exact' | 'day';
  bars: readonly DailyBar[];
  benchmarkBars: readonly DailyBar[] | null;
}

/**
 * Article case (plan entry/exit table). The entry price time is never before
 * t′: out of session the entry session opens at or after t′, in session the
 * entry is D's close with t′ ≤ close.
 */
export function caseOutcome(input: CaseOutcomeInput): CaseOutcome {
  const { exchange, publishedAtMs } = input;
  const timing = classifyArticleTime(exchange, publishedAtMs, { precision: input.timePrecision ?? 'exact' });
  const tPrimeMs = timing === CALENDAR_UNVERIFIED ? publishedAtMs + ARTICLE_DELAY_MS : timing.tPrimeMs;
  if (timing === CALENDAR_UNVERIFIED) return { ...emptyOutcome('excluded', CALENDAR_UNVERIFIED), tPrimeMs };
  const openAvailable = input.openAvailable ?? true;
  const plan = timing.kind === 'in_session'
    ? planFrom(exchange, timing.session, 'close', 5)
    : openEntryPlan(exchange, timing.session, openAvailable);
  if (plan === CALENDAR_UNVERIFIED) return { ...emptyOutcome('excluded', CALENDAR_UNVERIFIED), tPrimeMs };
  const outcome = measure(exchange, plan, input.bars, input.benchmarkBars, input);
  if (outcome.status === 'complete') {
    const last = lastClosedSession(exchange, publishedAtMs);
    outcome.sigma = last === CALENDAR_UNVERIFIED ? null : dailySigma(exchange, last, input.bars, undefined, input);
    if (outcome.sigma === null) outcome.flags.push('insufficient_volatility_history');
    else {
      outcome.band = neutralBand(outcome.sigma, 5, WEEK_BAND_FLOOR);
      outcome.label = labelFor(outcome.r!, outcome.band);
    }
  }
  return { ...outcome, tPrimeMs };
}

export interface WeeklyOutcomeInput extends OutcomeClock {
  exchange: Exchange;
  /** Sunday 23:50 UTC anchor (weeklyAsOfAtOrBefore). */
  weekAsOfMs: number;
  bars: readonly DailyBar[];
  benchmarkBars: readonly DailyBar[] | null;
}

/**
 * Weekly sample: next open after asOf + 5 minutes → fourth session's close,
 * market-relative, band from the relative returns ending at the last session
 * closed by asOf. Without a benchmark the week is excluded.
 */
export function weeklyOutcome(input: WeeklyOutcomeInput): WeeklyOutcome {
  const { exchange, weekAsOfMs } = input;
  const first = weekSessions(exchange, weekAsOfMs);
  if (first === CALENDAR_UNVERIFIED) return { ...emptyOutcome('excluded', CALENDAR_UNVERIFIED), weekAsOfMs };
  const plan = openEntryPlan(exchange, first[0]!, input.openAvailable ?? true);
  if (plan === CALENDAR_UNVERIFIED) return { ...emptyOutcome('excluded', CALENDAR_UNVERIFIED), weekAsOfMs };
  const outcome = measure(exchange, plan, input.bars, input.benchmarkBars, input);
  if (outcome.status === 'complete') {
    if (outcome.relative === null) {
      outcome.status = 'excluded';
      outcome.reason = 'benchmark_gap';
    } else {
      const last = lastClosedSession(exchange, weekAsOfMs);
      outcome.sigma = last === CALENDAR_UNVERIFIED ? null : dailySigma(exchange, last, input.bars, input.benchmarkBars!, input);
      if (outcome.sigma === null) outcome.flags.push('insufficient_volatility_history');
      else {
        outcome.band = neutralBand(outcome.sigma, 5, WEEK_BAND_FLOOR);
        outcome.label = labelFor(outcome.relative, outcome.band);
      }
    }
  }
  return { ...outcome, weekAsOfMs };
}

export interface NextDayOutcomeInput extends OutcomeClock {
  exchange: Exchange;
  /** Target session N's exchange-local date. */
  sessionDate: string;
  bars: readonly DailyBar[];
  benchmarkBars: readonly DailyBar[] | null;
}

function nextDayBase(previous: Session, session: Session, status: OutcomeStatus, reason: ExclusionReason | null): NextDayOutcome {
  return { ...emptyOutcome(status, reason), entryType: 'close', entryDate: previous.date, exitDate: session.date,
    entryAtMs: previous.closeMs, exitAtMs: session.closeMs, sessions: [previous.date, session.date],
    intraday: null, benchmarkIntraday: null, relativeIntraday: null };
}

/**
 * Close-to-close and open-to-close for one series, or why it has none. The
 * window spans N only: an action on N excludes the stock and chains the
 * benchmark (close(N) / (f · close(N−1)) − 1, the official change vs/base).
 */
function dayReturns(exchange: Exchange, previous: Session, session: Session, bars: readonly DailyBar[], openAvailable: boolean,
  role: SeriesRole): { r: number; intraday: number | null; basis: PriceBasis; chained: boolean } |
  Exclude<ExclusionReason, 'benchmark_gap' | 'calendar_unverified'> {
  const index = indexBars(bars);
  const before = index.get(previous.date);
  const bar = index.get(session.date);
  if (!before || !bar) return 'price_gap';
  const basis = basisOf([before, bar]);
  if (!basis) return 'price_gap';
  if (!isUsableBar(before, openAvailable) || !isUsableBar(bar, openAvailable)) return 'invalid_bar';
  let r = closeOf(bar, basis) / closeOf(before, basis) - 1;
  let chained = false;
  if (basis === 'raw') {
    const factor = factorOf(bar);
    if (factor === undefined) {
      if (Math.abs(r) > SUSPECT_MOVE[exchange]) return 'suspect_corporate_action';
    } else if (isAction(factor)) {
      if (role === 'own') return 'suspect_corporate_action';
      r = bar.close / (factor * before.close) - 1;
      chained = true;
    }
  }
  // The adjustment factor cancels within one day, so open → close needs no basis and is never chained.
  return { r, intraday: openAvailable ? bar.close / bar.open - 1 : null, basis, chained };
}

/**
 * Next-trading-day outcome for target session N. The base close precedes
 * the overnight news by design (plan: not a tradable return), and only N's
 * close, set after the window, is predicted.
 */
export function nextDayOutcome(input: NextDayOutcomeInput): NextDayOutcome {
  const { exchange, sessionDate } = input;
  const session = sessionOn(exchange, sessionDate);
  if (session === null) throw new RangeError(`${sessionDate} is not a ${exchange} session`);
  const previousList = session === CALENDAR_UNVERIFIED ? session : sessionsBefore(exchange, sessionDate, 1);
  if (session === CALENDAR_UNVERIFIED || previousList === CALENDAR_UNVERIFIED) {
    return { ...emptyOutcome('excluded', CALENDAR_UNVERIFIED), intraday: null, benchmarkIntraday: null, relativeIntraday: null };
  }
  const previous = previousList[0]!;
  if (!allAvailable(input, [previous, session])) return nextDayBase(previous, session, 'pending', null);
  const openAvailable = input.openAvailable ?? true;
  const own = dayReturns(exchange, previous, session, input.bars, openAvailable, 'own');
  if (typeof own === 'string') return nextDayBase(previous, session, 'excluded', own);
  const outcome = nextDayBase(previous, session, 'complete', null);
  outcome.basis = own.basis;
  outcome.r = own.r;
  outcome.intraday = own.intraday;
  if (own.basis === 'raw') outcome.flags.push('unadjusted');
  if (!openAvailable) outcome.flags.push('no_open');
  const market = input.benchmarkBars ? dayReturns(exchange, previous, session, input.benchmarkBars, openAvailable, 'benchmark') : null;
  if (!market || typeof market === 'string' || market.basis !== own.basis) {
    outcome.status = 'excluded';
    outcome.reason = 'benchmark_gap';
    outcome.flags.push('benchmark_gap');
    return outcome;
  }
  outcome.benchmarkR = market.r;
  outcome.relative = own.r - market.r;
  if (market.chained) outcome.flags.push('benchmark_chained');
  outcome.benchmarkIntraday = market.intraday;
  outcome.relativeIntraday = own.intraday === null || market.intraday === null ? null : own.intraday - market.intraday;
  outcome.sigma = dailySigma(exchange, previous, input.bars, input.benchmarkBars!, input);
  if (outcome.sigma === null) outcome.flags.push('insufficient_volatility_history');
  else {
    outcome.band = neutralBand(outcome.sigma, 1, DAY_BAND_FLOOR);
    outcome.label = labelFor(outcome.relative, outcome.band);
  }
  return outcome;
}
