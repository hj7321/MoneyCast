import {
  NEWS_HISTORY_VERSION, NEWS_TOPIC_KEYS,
  type CaseRef, type CaseStats, type DirectionStats, type HistoryCoverage, type HistoryDataAsOf, type HistoryReadyStatus,
  type HistorySources, type Horizon, type NewsTopicKey, type ReturnSummary, type SampleStats, type Verdict,
} from '../packages/core/src/index.js';
import {
  createStoryIndex, groupEvents, independentCount, isKnownAt, isStatsEligible, isTimeUnverified, labelAt, ledgerKey, storyRepresentative,
  type EventGroup, type LedgerDirection, type LedgerEntry, type LedgerOutcome, type StoryIndex,
} from './history-ledger.js';
import {
  caseOutcome, nextDayOutcome, weeklyOutcome,
  type CaseOutcome, type DailyBar, type ExclusionReason, type NextDayOutcome, type OutcomeLabel, type WeeklyOutcome,
} from './history-outcomes.js';
import {
  ARTICLE_DELAY_MS, CALENDAR_UNVERIFIED, addDays, classifyArticleTime, inOvernightWindow, lastClosedSession, localDate,
  overnightWindow, sessionOn, sessionsAfter, sessionsBetween, weeklyAsOfsBetween, weeklyWindows,
  type Exchange, type Session,
} from './market-calendar.js';

// Samples, intervals and verdicts for historical news insights (plan ch. 6).
// Pure: the clock, ledger entries and outcomes come in as arguments. Every
// window is classified with what the ledger knew at that window's own asOf,
// so a later fetch, relabel or price revision never rewrites an earlier unit.
// Completed outcomes can be served frozen (withFrozenOutcomes): a frozen
// record counts only under the current price-basis version and only once its
// freezing clock has passed, so a replay never sees a later freeze.

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const ms = (iso: string): number => Date.parse(iso);
const iso = (value: number): string => new Date(value).toISOString();

const publishedTimes = new WeakMap<LedgerEntry, { publishedAt: string; ms: number }>();
/** Parsed publishedAt, cached per entry (entries are treated as immutable). */
function publishedMs(entry: LedgerEntry): number {
  const cached = publishedTimes.get(entry);
  if (cached && cached.publishedAt === entry.publishedAt) return cached.ms;
  const value = ms(entry.publishedAt);
  publishedTimes.set(entry, { publishedAt: entry.publishedAt, ms: value });
  return value;
}

// ---------------------------------------------------------------------------
// Intervals
// ---------------------------------------------------------------------------

/** Two-sided normal quantiles for the 90% and 75% intervals. */
export const Z90 = 1.6448536269514722;
export const Z75 = 1.1503493803760079;

/** Wilson score interval for x successes in n; n = 0 gives the uninformative [0, 1]. */
export function wilson(x: number, n: number, z: number): [number, number] {
  if (!(n > 0)) return [0, 1];
  const p = x / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

/** Newcombe hybrid score interval for p1 − p2 (his method 10); an empty group gives [−1, 1]. */
export function newcombe(x1: number, n1: number, x2: number, n2: number, z: number): [number, number] {
  if (!(n1 > 0) || !(n2 > 0)) return [-1, 1];
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const [l1, u1] = wilson(x1, n1, z);
  const [l2, u2] = wilson(x2, n2, z);
  const d = p1 - p2;
  // Clamped so float noise never leaves [−1, 1], which the contract parser rejects.
  return [
    Math.max(-1, d - Math.sqrt((p1 - l1) ** 2 + (u2 - p2) ** 2)),
    Math.min(1, d + Math.sqrt((u1 - p1) ** 2 + (p2 - l2) ** 2)),
  ];
}

// ---------------------------------------------------------------------------
// Verdict (fixed in advance; never tuned on results)
// ---------------------------------------------------------------------------

/** Decisive (up or down) units each group needs; neutral units do not count (plan "20주 기준"). */
export const MIN_EVENT_UNITS = 20;
export const MIN_OTHER_UNITS = 20;
/** More than this share of decisive event units in one calendar quarter is insufficient. */
export const MAX_QUARTER_SHARE = 0.5;
/** More than this share of measured units without a benchmark is insufficient. */
export const MAX_BENCHMARK_GAP_SHARE = 0.2;
/** Price lag in sessions: above 3 a caution, above 10 insufficient (plan B-7). */
export const PRICE_CAUTION_SESSIONS = 3;
export const PRICE_STALE_SESSIONS = 10;

/** Counts behind one verdict. Up/down/neutral are market-relative outcome labels. */
export interface SampleSummary {
  unit: Horizon;
  eventUp: number;
  eventDown: number;
  eventNeutral: number;
  otherUp: number;
  otherDown: number;
  otherNeutral: number;
  /** Most decisive event units falling in one calendar quarter. */
  eventQuarterMax: number;
  /** Units whose own price was measured, with or without a benchmark. */
  measured: number;
  /** Measured units excluded for a missing benchmark. */
  benchmarkGaps: number;
  from: string | null;
  to: string | null;
}

/** Data-state failures that close the verdict to insufficient whatever the counts say. */
export interface VerdictFlags {
  priceFailed?: boolean;
  identityFailed?: boolean;
  /** Prices more than PRICE_STALE_SESSIONS sessions behind. */
  priceStale?: boolean;
  /** Statistics computed more than 14 days ago (read-side check). */
  statsStale?: boolean;
}

export type InsufficientReason =
  | 'invalid_sample' | 'few_event_units' | 'few_other_units' | 'quarter_concentration' | 'benchmark_gaps'
  | 'price_failed' | 'identity_failed' | 'price_stale' | 'stats_stale';

export interface VerdictResult {
  verdict: Verdict;
  reason: InsufficientReason | null;
  /** D = d × (event up share − other up share); 0 when a group has no decisive unit. */
  difference: number;
  ci90: [number, number];
  ci75: [number, number];
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function insufficientReason(sample: SampleSummary, flags: VerdictFlags): InsufficientReason | null {
  const counts = [sample.eventUp, sample.eventDown, sample.eventNeutral, sample.otherUp, sample.otherDown, sample.otherNeutral,
    sample.eventQuarterMax, sample.measured, sample.benchmarkGaps];
  if (!counts.every(isCount)) return 'invalid_sample';
  const eventN = sample.eventUp + sample.eventDown;
  const otherN = sample.otherUp + sample.otherDown;
  if (eventN < MIN_EVENT_UNITS) return 'few_event_units';
  if (otherN < MIN_OTHER_UNITS) return 'few_other_units';
  if (sample.eventQuarterMax / eventN > MAX_QUARTER_SHARE) return 'quarter_concentration';
  if (sample.measured === 0 || sample.benchmarkGaps / sample.measured > MAX_BENCHMARK_GAP_SHARE) return 'benchmark_gaps';
  if (flags.priceFailed) return 'price_failed';
  if (flags.identityFailed) return 'identity_failed';
  if (flags.priceStale) return 'price_stale';
  if (flags.statsStale) return 'stats_stale';
  return null;
}

/**
 * First match: insufficient, supports (90% lower > 0), contradicts (90% upper
 * < 0), weakens (75% upper < 0), otherwise no_clear_difference. Shares
 * exclude neutral units. A negative direction negates and swaps the interval,
 * so mirrored counts give the mirrored verdict.
 */
export function decideVerdict(sample: SampleSummary, direction: LedgerDirection, flags: VerdictFlags = {}): VerdictResult {
  const reason = insufficientReason(sample, flags);
  if (reason === 'invalid_sample') return { verdict: 'insufficient', reason, difference: 0, ci90: [-1, 1], ci75: [-1, 1] };
  const eventN = sample.eventUp + sample.eventDown;
  const otherN = sample.otherUp + sample.otherDown;
  const sign = direction === 'positive' ? 1 : -1;
  const orient = ([lo, hi]: [number, number]): [number, number] => sign > 0 ? [lo, hi] : [-hi, -lo];
  const ci90 = orient(newcombe(sample.eventUp, eventN, sample.otherUp, otherN, Z90));
  const ci75 = orient(newcombe(sample.eventUp, eventN, sample.otherUp, otherN, Z75));
  const difference = eventN > 0 && otherN > 0 ? sign * (sample.eventUp / eventN - sample.otherUp / otherN) : 0;
  let verdict: Verdict;
  if (reason) verdict = 'insufficient';
  else if (ci90[0] > 0) verdict = 'supports';
  else if (ci90[1] < 0) verdict = 'contradicts';
  else if (ci75[1] < 0) verdict = 'weakens';
  else verdict = 'no_clear_difference';
  return { verdict, reason, difference, ci90, ci75 };
}

// ---------------------------------------------------------------------------
// Verdict samples: company-week and company-session units
// ---------------------------------------------------------------------------

/** Where the ledger was observing. Units whose news window starts before `fromMs` or touches a gap are left out. */
export interface Observation {
  fromMs: number;
  /** Collection outages, [startMs, endMs). */
  gaps?: ReadonlyArray<{ startMs: number; endMs: number }>;
}

export type UnitGroup = 'event' | 'other';

export interface SampleUnit {
  /** Week: the asOf instant (ISO). Day: the target session date. */
  key: string;
  group: UnitGroup;
  /** Week: the first measured session. Day: the target session. Quarters are counted on this date. */
  date: string;
  entryDate: string;
  exitDate: string;
  label: OutcomeLabel;
  relative: number;
  /** A directional in-window article rests on a backfill knowledge time ("시점 미보증"). */
  timeUnverified: boolean;
}

export type UnitExclusion = 'overlap' | 'observation_gap' | 'pending' | 'no_label' | ExclusionReason;

export interface UnitSample {
  unit: Horizon;
  direction: LedgerDirection;
  /** Event and other units; each kept window is exactly one of the two. */
  units: SampleUnit[];
  excluded: Partial<Record<UnitExclusion, number>>;
  measured: number;
  benchmarkGaps: number;
}

function touchesGap(observation: Observation, startMs: number, endMs: number): boolean {
  if (startMs < observation.fromMs) return true;
  return (observation.gaps ?? []).some(gap => gap.startMs <= endMs && gap.endMs > startMs);
}

function companyEntries(entries: readonly LedgerEntry[], companyId: string): LedgerEntry[] {
  return entries.filter(entry => entry.companyId === companyId && Number.isFinite(publishedMs(entry)));
}

const opposite = (direction: LedgerDirection): LedgerDirection => direction === 'positive' ? 'negative' : 'positive';

/** One sample build's entries sorted by publication time, and its incremental stories (asOf only ascends). */
interface WindowIndex {
  sorted: LedgerEntry[];
  times: number[];
  stories: StoryIndex;
}

function windowIndex(entries: readonly LedgerEntry[]): WindowIndex {
  const times = entries.map(publishedMs);
  const order = times.map((_, i) => i).sort((a, b) => times[a]! - times[b]! || a - b);
  return { sorted: order.map(i => entries[i]!), times: order.map(i => times[i]!), stories: createStoryIndex(entries) };
}

/**
 * Event when the window holds an event of the direction known at asOf and no
 * eligible opposite-direction article at all (a story whose copies disagree
 * therefore blocks both directions). Everything else is other. Only entries
 * published in (fromMs, toMs] can be in the window. An event of direction d
 * is in the window exactly when a story visible at asOf whose eligible
 * directional copies are all d has its representative (the earliest one) in
 * the window: the same as `groupEvents(...).some(e => e.direction === d &&
 * e.members.some(inWindow))`, without regrouping the whole ledger.
 */
function classifyWindow(index: WindowIndex, asOfMs: number, fromMs: number, toMs: number, inWindow: (entry: LedgerEntry) => boolean,
  direction: LedgerDirection, unverified: (entry: LedgerEntry) => boolean): { group: UnitGroup; timeUnverified: boolean } {
  const traces = { positive: false, negative: false };
  let timeUnverified = false;
  const candidates: LedgerEntry[] = [];
  let lo = 0;
  let hi = index.times.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (index.times[mid]! <= fromMs) lo = mid + 1; else hi = mid; }
  for (let i = lo; i < index.sorted.length && index.times[i]! <= toMs; i += 1) {
    const entry = index.sorted[i]!;
    if (!isKnownAt(entry, asOfMs) || !inWindow(entry) || !isStatsEligible(entry, asOfMs)) continue;
    const sentiment = labelAt(entry, asOfMs)?.sentiment;
    if (sentiment !== 'positive' && sentiment !== 'negative') continue;
    traces[sentiment] = true;
    if (unverified(entry)) timeUnverified = true;
    if (sentiment === direction) candidates.push(entry);
  }
  if (!traces[direction] || traces[opposite(direction)]) return { group: 'other', timeUnverified };
  // Stories are the costly step, so they advance only where the cheap trace check leaves an event possible.
  index.stories.advance(asOfMs);
  const event = candidates.some(entry => {
    const story = index.stories.storyOf(entry);
    const found = story ? storyRepresentative(story, asOfMs) : null;
    return found !== null && found.direction === direction && inWindow(found.entry);
  });
  return { group: event ? 'event' : 'other', timeUnverified };
}

type Measured = { entryDate: string; exitDate: string; label: OutcomeLabel; relative: number };

/** A completed, labelled market-relative outcome, or the reason it is not one. Rechecks the exit against nowMs so a stored outcome cannot leak. */
function measuredOutcome(outcome: WeeklyOutcome | NextDayOutcome, nowMs: number, sample: UnitSample): Measured | null {
  const count = (reason: UnitExclusion) => { sample.excluded[reason] = (sample.excluded[reason] ?? 0) + 1; };
  if (outcome.status === 'pending' || outcome.exitAtMs === null || outcome.exitAtMs > nowMs) { count('pending'); return null; }
  if (outcome.status === 'excluded') {
    const reason = outcome.reason ?? 'price_gap';
    if (reason === 'benchmark_gap' && outcome.r !== null) { sample.measured += 1; sample.benchmarkGaps += 1; }
    count(reason);
    return null;
  }
  sample.measured += 1;
  if (outcome.label === null || outcome.relative === null || outcome.entryDate === null || outcome.exitDate === null) {
    count('no_label');
    return null;
  }
  return { entryDate: outcome.entryDate, exitDate: outcome.exitDate, label: outcome.label, relative: outcome.relative };
}

const emptySample = (unit: Horizon, direction: LedgerDirection): UnitSample =>
  ({ unit, direction, units: [], excluded: {}, measured: 0, benchmarkGaps: 0 });

export interface WeekSampleInput {
  exchange: Exchange;
  companyId: string;
  direction: LedgerDirection;
  entries: readonly LedgerEntry[];
  /** Evaluation clock: nothing completed or known after it is used. */
  nowMs: number;
  observation: Observation;
  /** Outcome for a weekly anchor; stored (frozen) or computed, see outcomesFromPrices. */
  outcome: (weekAsOfMs: number) => WeeklyOutcome;
  /** Latest anchor considered; capped at nowMs. */
  toMs?: number;
}

/**
 * Company-week units. Each Sunday 23:50 UTC anchor whose 7-day news window
 * (asOf − 7d, asOf] is observed; weeks overlapping the previous kept window
 * (calendar only, so prices never move the chain) and weeks without a
 * completed labelled outcome are left out.
 */
export function buildWeekSample(input: WeekSampleInput): UnitSample {
  const sample = emptySample('week', input.direction);
  const index = windowIndex(companyEntries(input.entries, input.companyId));
  const endMs = Math.min(input.toMs ?? input.nowMs, input.nowMs);
  const anchors = weeklyAsOfsBetween(input.observation.fromMs + WEEK_MS, endMs);
  for (const window of weeklyWindows(input.exchange, anchors)) {
    const { asOfMs } = window;
    if (window.skip) { sample.excluded[window.skip] = (sample.excluded[window.skip] ?? 0) + 1; continue; }
    const startMs = asOfMs - WEEK_MS;
    if (touchesGap(input.observation, startMs, asOfMs)) {
      sample.excluded.observation_gap = (sample.excluded.observation_gap ?? 0) + 1;
      continue;
    }
    const measured = measuredOutcome(input.outcome(asOfMs), input.nowMs, sample);
    if (!measured) continue;
    const inWindow = (entry: LedgerEntry) => { const at = publishedMs(entry); return at > startMs && at <= asOfMs; };
    const { group, timeUnverified } = classifyWindow(index, asOfMs, startMs, asOfMs, inWindow, input.direction, isTimeUnverified);
    sample.units.push({ key: iso(asOfMs), group, date: measured.entryDate, ...measured, timeUnverified });
  }
  return sample;
}

/**
 * Day-sample view of an entry. A backfilled entry has no recorded sighting, so
 * its publication time stands in for it (plan: 게시 시각 기준, 시점 미보증) and only
 * its first recorded label is used: a later relabel cannot be dated.
 */
function dayView(entry: LedgerEntry): LedgerEntry {
  if (!isTimeUnverified(entry)) return entry;
  let first = entry.labels[0];
  for (const label of entry.labels) if (first && ms(label.at) < ms(first.at)) first = label;
  return { ...entry, firstSeenAt: entry.publishedAt, labels: first ? [{ ...first, at: entry.publishedAt }] : [] };
}

export interface DaySampleInput {
  exchange: Exchange;
  companyId: string;
  direction: LedgerDirection;
  entries: readonly LedgerEntry[];
  nowMs: number;
  observation: Observation;
  /** Next-day outcome for a target session date. */
  outcome: (sessionDate: string) => NextDayOutcome;
  /** Latest session date considered is the one containing min(toMs, nowMs). */
  toMs?: number;
}

const isWeekday = (date: string) => { const day = new Date(`${date}T00:00:00Z`).getUTCDay(); return day !== 0 && day !== 6; };

/**
 * Company-session units. Session N is an event day when its overnight window
 * (previous close, N open] holds an event of the direction that the ledger had
 * seen by N's open (forward: firstSeenAt ≤ open) and no opposite article. An
 * article whose t′ lands inside a session belongs to no window.
 */
export function buildDaySample(input: DaySampleInput): UnitSample {
  const sample = emptySample('day', input.direction);
  const backfilled = new Set<LedgerEntry>();
  const entries = companyEntries(input.entries, input.companyId).map(entry => {
    const view = dayView(entry);
    if (view !== entry) backfilled.add(view);
    return view;
  });
  const index = windowIndex(entries);
  const endMs = Math.min(input.toMs ?? input.nowMs, input.nowMs);
  const last = localDate(input.exchange, endMs);
  for (let date = localDate(input.exchange, input.observation.fromMs); date <= last; date = addDays(date, 1)) {
    const session = sessionOn(input.exchange, date);
    if (session === null) continue;
    if (session === CALENDAR_UNVERIFIED) {
      if (isWeekday(date)) sample.excluded.calendar_unverified = (sample.excluded.calendar_unverified ?? 0) + 1;
      continue;
    }
    const window = overnightWindow(input.exchange, session);
    if (window === CALENDAR_UNVERIFIED) { sample.excluded.calendar_unverified = (sample.excluded.calendar_unverified ?? 0) + 1; continue; }
    if (touchesGap(input.observation, window.startMs, window.endMs)) {
      sample.excluded.observation_gap = (sample.excluded.observation_gap ?? 0) + 1;
      continue;
    }
    if (session.closeMs > input.nowMs) { sample.excluded.pending = (sample.excluded.pending ?? 0) + 1; continue; }
    const measured = measuredOutcome(input.outcome(date), input.nowMs, sample);
    if (!measured) continue;
    const inWindow = (entry: LedgerEntry) => inOvernightWindow(window, publishedMs(entry), entry.timePrecision === 'day' ? 'day' : 'exact');
    // In the window means published in (start − 5 min, end − 5 min], or a day earlier for day precision: a superset bound.
    const { group, timeUnverified } = classifyWindow(index, session.openMs, window.startMs - ARTICLE_DELAY_MS - DAY_MS, window.endMs,
      inWindow, input.direction, entry => backfilled.has(entry));
    sample.units.push({ key: date, group, date, ...measured, timeUnverified });
  }
  return sample;
}

const quarterOf = (date: string) => `${date.slice(0, 4)}-Q${Math.ceil(Number(date.slice(5, 7)) / 3)}`;

export function summarizeSample(sample: UnitSample): SampleSummary {
  const summary: SampleSummary = {
    unit: sample.unit, eventUp: 0, eventDown: 0, eventNeutral: 0, otherUp: 0, otherDown: 0, otherNeutral: 0,
    eventQuarterMax: 0, measured: sample.measured, benchmarkGaps: sample.benchmarkGaps, from: null, to: null,
  };
  const quarters = new Map<string, number>();
  for (const unit of sample.units) {
    const key = `${unit.group}${unit.label === 'up' ? 'Up' : unit.label === 'down' ? 'Down' : 'Neutral'}` as
      'eventUp' | 'eventDown' | 'eventNeutral' | 'otherUp' | 'otherDown' | 'otherNeutral';
    summary[key] += 1;
    if (unit.group === 'event' && unit.label !== 'neutral') {
      const quarter = quarterOf(unit.date);
      quarters.set(quarter, (quarters.get(quarter) ?? 0) + 1);
    }
    if (summary.from === null || unit.entryDate < summary.from) summary.from = unit.entryDate;
    if (summary.to === null || unit.exitDate > summary.to) summary.to = unit.exitDate;
  }
  summary.eventQuarterMax = Math.max(0, ...quarters.values());
  return summary;
}

/** Contract form of a sample; null when no unit was kept (the contract needs dates). */
export function sampleStats(summary: SampleSummary, result: VerdictResult): SampleStats | null {
  if (summary.from === null || summary.to === null) return null;
  return {
    unit: summary.unit,
    eventUnits: summary.eventUp + summary.eventDown + summary.eventNeutral,
    otherUnits: summary.otherUp + summary.otherDown + summary.otherNeutral,
    eventUp: summary.eventUp, eventDown: summary.eventDown, eventNeutral: summary.eventNeutral,
    otherUp: summary.otherUp, otherDown: summary.otherDown, otherNeutral: summary.otherNeutral,
    difference: result.difference, ci90: result.ci90, from: summary.from, to: summary.to,
  };
}

// ---------------------------------------------------------------------------
// Outcomes from prices
// ---------------------------------------------------------------------------

/** Where the builders get outcomes. The job may serve frozen outcomes instead of recomputing them. */
export interface OutcomeSource {
  week(weekAsOfMs: number): WeeklyOutcome;
  day(sessionDate: string): NextDayOutcome;
  /** Five-session outcome after an entry's publication. */
  case(entry: LedgerEntry): CaseOutcome;
  /** Close → +5 close from a session (base shares of the same period); null on a closed day. */
  closeWindow(sessionDate: string): CaseOutcome | null;
}

export interface PriceInput {
  exchange: Exchange;
  bars: readonly DailyBar[];
  benchmarkBars: readonly DailyBar[] | null;
  availableAtMs?: (session: Session) => number;
  openAvailable?: boolean;
}

/** Memoised outcomes computed from bars at one evaluation clock. */
export function outcomesFromPrices(prices: PriceInput, nowMs: number): OutcomeSource {
  const clock = {
    nowMs,
    ...(prices.availableAtMs ? { availableAtMs: prices.availableAtMs } : {}),
    ...(prices.openAvailable === undefined ? {} : { openAvailable: prices.openAvailable }),
  };
  const base = { exchange: prices.exchange, bars: prices.bars, benchmarkBars: prices.benchmarkBars, ...clock };
  const weeks = new Map<number, WeeklyOutcome>();
  const days = new Map<string, NextDayOutcome>();
  const cases = new Map<string, CaseOutcome>();
  const windows = new Map<string, CaseOutcome | null>();
  const memo = <K, V>(map: Map<K, V>, key: K, make: () => V): V => {
    if (!map.has(key)) map.set(key, make());
    return map.get(key)!;
  };
  return {
    week: asOfMs => memo(weeks, asOfMs, () => weeklyOutcome({ ...base, weekAsOfMs: asOfMs })),
    day: date => memo(days, date, () => nextDayOutcome({ ...base, sessionDate: date })),
    case: entry => memo(cases, `${entry.publishedAt}\u0000${entry.timePrecision}`, () => caseOutcome({
      ...base, publishedAtMs: publishedMs(entry), timePrecision: entry.timePrecision === 'day' ? 'day' : 'exact',
    })),
    closeWindow: date => memo(windows, date, () => {
      const session = sessionOn(prices.exchange, date);
      if (!session || session === CALENDAR_UNVERIFIED) return null;
      // t′ one minute before the close is in session, so the case rule gives this close → +5 close.
      return caseOutcome({ ...base, publishedAtMs: session.closeMs - ARTICLE_DELAY_MS - 60_000 });
    }),
  };
}

// ---------------------------------------------------------------------------
// Frozen outcomes (plan "완료 사례의 수익률·라벨·σ는 완료 시점 값으로 동결")
// ---------------------------------------------------------------------------

/** A completed outcome as stored by the job. */
export interface FrozenRecord<T> {
  outcome: T;
  frozenAt: string;
  priceBasisVersion: string;
}

export interface FrozenLookup {
  week(weekAsOfMs: number): FrozenRecord<WeeklyOutcome> | null;
  day(sessionDate: string): FrozenRecord<NextDayOutcome> | null;
}

/** Receives every newly completed outcome; may see one more than once (the job deduplicates). */
export interface FreezeSink {
  week(outcome: WeeklyOutcome): void;
  day(sessionDate: string, outcome: NextDayOutcome): void;
  case(entry: LedgerEntry, outcome: LedgerOutcome): void;
}

export interface FrozenSourceInput {
  computed: OutcomeSource;
  frozen: FrozenLookup;
  sink: FreezeSink | null;
  nowMs: number;
  /** `${identity.priceBasis}/${OUTCOME_RULES_VERSION}` of the company's current price series. */
  priceBasisVersion: string;
}

/**
 * Frozen outcomes first, computed ones otherwise. A frozen record is used only
 * under the current price-basis version and once its frozenAt ≤ nowMs, so a
 * replay at an earlier clock recomputes what was not yet frozen then. Only
 * complete computed outcomes reach the sink; pending and excluded ones are
 * recomputed every run. closeWindow (display-only base shares) is never frozen.
 */
export function withFrozenOutcomes(input: FrozenSourceInput): OutcomeSource {
  const { computed, frozen, sink, nowMs, priceBasisVersion } = input;
  const usable = (record: { frozenAt: string; priceBasisVersion: string } | null | undefined): boolean =>
    record !== null && record !== undefined && record.priceBasisVersion === priceBasisVersion && ms(record.frozenAt) <= nowMs;
  const sentWeeks = new Set<number>();
  const sentDays = new Set<string>();
  const sentCases = new Set<string>();
  return {
    week(weekAsOfMs) {
      const record = frozen.week(weekAsOfMs);
      if (record && usable(record)) return record.outcome;
      const outcome = computed.week(weekAsOfMs);
      if (outcome.status === 'complete' && sink && !sentWeeks.has(weekAsOfMs)) { sentWeeks.add(weekAsOfMs); sink.week(outcome); }
      return outcome;
    },
    day(sessionDate) {
      const record = frozen.day(sessionDate);
      if (record && usable(record)) return record.outcome;
      const outcome = computed.day(sessionDate);
      if (outcome.status === 'complete' && sink && !sentDays.has(sessionDate)) { sentDays.add(sessionDate); sink.day(sessionDate, outcome); }
      return outcome;
    },
    case(entry) {
      if (entry.outcome && usable(entry.outcome)) return caseOutcomeOfLedger(entry, entry.outcome);
      const outcome = computed.case(entry);
      const key = ledgerKey(entry);
      if (sink && !sentCases.has(key)) {
        const record = ledgerOutcomeOf(outcome, priceBasisVersion, nowMs);
        if (record) { sentCases.add(key); sink.case(entry, record); }
      }
      return outcome;
    },
    closeWindow: sessionDate => computed.closeWindow(sessionDate),
  };
}

/** Ledger form of a complete case outcome; null for a pending or excluded one. */
export function ledgerOutcomeOf(outcome: CaseOutcome, priceBasisVersion: string, frozenAtMs: number): LedgerOutcome | null {
  if (outcome.status !== 'complete' || outcome.entryType === null || outcome.entryDate === null || outcome.exitDate === null ||
      outcome.entryAtMs === null || outcome.exitAtMs === null || outcome.basis === null || outcome.r === null ||
      !Number.isFinite(frozenAtMs)) return null;
  return {
    entryType: outcome.entryType, entryDate: outcome.entryDate, exitDate: outcome.exitDate,
    entryAt: iso(outcome.entryAtMs), exitAt: iso(outcome.exitAtMs), sessions: [...outcome.sessions], basis: outcome.basis,
    r: outcome.r, benchmarkR: outcome.benchmarkR, relative: outcome.relative, sigma: outcome.sigma, band: outcome.band,
    label: outcome.label, flags: [...outcome.flags], priceBasisVersion, frozenAt: iso(frozenAtMs),
  };
}

/** The case outcome a frozen ledger outcome stands for; exactly what `caseOutcome` returned when it was frozen. */
export function caseOutcomeOfLedger(entry: Pick<LedgerEntry, 'publishedAt' | 'timePrecision'>, outcome: LedgerOutcome): CaseOutcome {
  const tPrimeMs = ms(entry.publishedAt) + ARTICLE_DELAY_MS + (entry.timePrecision === 'day' ? DAY_MS : 0);
  return {
    status: 'complete', reason: null, entryType: outcome.entryType, entryDate: outcome.entryDate, exitDate: outcome.exitDate,
    entryAtMs: ms(outcome.entryAt), exitAtMs: ms(outcome.exitAt), sessions: [...outcome.sessions], basis: outcome.basis,
    r: outcome.r, benchmarkR: outcome.benchmarkR, relative: outcome.relative, sigma: outcome.sigma, band: outcome.band,
    label: outcome.label, flags: [...outcome.flags], tPrimeMs,
  };
}

/** Sessions closed after the last price date, up to one past the stale limit; null when the calendar cannot tell. */
export function priceLagSessions(exchange: Exchange, lastPriceDate: string, nowMs: number): number | null {
  const last = lastClosedSession(exchange, nowMs);
  if (last === CALENDAR_UNVERIFIED) return null;
  if (last.date <= lastPriceDate) return 0;
  const after = sessionsAfter(exchange, lastPriceDate, PRICE_STALE_SESSIONS + 1);
  if (after === CALENDAR_UNVERIFIED) return null;
  return after.filter(session => session.closeMs <= nowMs).length;
}

// ---------------------------------------------------------------------------
// Case statistics (display only)
// ---------------------------------------------------------------------------

/** Below this many events only the list is shown. */
export const CASE_STATS_MIN_EVENTS = 5;
/** Below this many independent windows counts are shown without shares. */
export const CASE_SHARES_MIN_NEFF = 10;
/** Cases must predate the current 7-day window with a day to spare (기준 시각 < 계산 시각 − 8일). */
export const CASE_RECENT_EXCLUSION_MS = 8 * DAY_MS;
const MAX_EXAMPLES = 5;

export type CaseDisplayLevel = 'list' | 'counts' | 'shares';

export function caseDisplayLevel(stats: Pick<CaseStats, 'cases' | 'nEff'>): CaseDisplayLevel {
  if (stats.cases < CASE_STATS_MIN_EVENTS) return 'list';
  return stats.nEff < CASE_SHARES_MIN_NEFF ? 'counts' : 'shares';
}

export type CaseExclusion = 'recent' | 'pending' | 'not_overnight' | ExclusionReason;

interface CaseItem {
  anchor: LedgerEntry;
  topic: NewsTopicKey;
  anchorMs: number;
  entryType: 'open' | 'close';
  entryDate: string;
  exitDate: string;
  entryAtMs: number;
  exitAtMs: number;
  r: number;
  relative: number | null;
  label: OutcomeLabel | null;
}

/** The overnight target session of an article, or null when its t′ falls in a session or the calendar cannot tell. */
function overnightTarget(exchange: Exchange, entry: LedgerEntry): Session | null {
  const precision = entry.timePrecision === 'day' ? 'day' : 'exact';
  const timing = classifyArticleTime(exchange, publishedMs(entry), { precision });
  if (timing === CALENDAR_UNVERIFIED || timing.kind === 'in_session') return null;
  const window = overnightWindow(exchange, timing.session);
  if (window === CALENDAR_UNVERIFIED || !inOvernightWindow(window, publishedMs(entry), precision)) return null;
  return timing.session;
}

/**
 * One case per event of the direction, measured from its anchor. Week cases
 * use the five sessions after the article; day cases are overnight articles
 * with the next-day outcome of their target session.
 */
function collectCases(horizon: Horizon, exchange: Exchange, events: readonly EventGroup[], direction: LedgerDirection,
  nowMs: number, outcomes: OutcomeSource, excluded: Partial<Record<CaseExclusion, number>>): CaseItem[] {
  const count = (reason: CaseExclusion) => { excluded[reason] = (excluded[reason] ?? 0) + 1; };
  const items: CaseItem[] = [];
  for (const event of events) {
    if (event.direction !== direction) continue;
    if (!event.members.every(member => publishedMs(member) < nowMs - CASE_RECENT_EXCLUSION_MS)) { count('recent'); continue; }
    const anchor = event.members[0]!;
    let outcome: CaseOutcome | NextDayOutcome;
    if (horizon === 'week') outcome = outcomes.case(anchor);
    else {
      const target = overnightTarget(exchange, anchor);
      if (!target) { count('not_overnight'); continue; }
      outcome = outcomes.day(target.date);
    }
    if (outcome.status === 'pending' || outcome.exitAtMs === null || outcome.exitAtMs > nowMs) { count('pending'); continue; }
    if (outcome.status === 'excluded' && !(horizon === 'week' && outcome.reason === 'benchmark_gap')) {
      count(outcome.reason ?? 'price_gap');
      continue;
    }
    if (outcome.r === null || outcome.entryDate === null || outcome.exitDate === null || outcome.entryAtMs === null) {
      count('price_gap');
      continue;
    }
    items.push({
      anchor, topic: event.topic, anchorMs: event.anchorMs, entryType: outcome.entryType === 'open' ? 'open' : 'close',
      entryDate: outcome.entryDate, exitDate: outcome.exitDate, entryAtMs: outcome.entryAtMs, exitAtMs: outcome.exitAtMs,
      r: outcome.r, relative: outcome.relative, label: outcome.label,
    });
  }
  return items;
}

function quantile(sorted: readonly number[], q: number): number {
  const position = (sorted.length - 1) * q;
  const lo = Math.floor(position);
  const hi = Math.ceil(position);
  const value = sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (position - lo);
  return Math.min(Math.max(value, sorted[lo]!), sorted[hi]!);
}

const median = (values: readonly number[]) => quantile([...values].sort((a, b) => a - b), 0.5);

function returnSummary(items: readonly CaseItem[]): ReturnSummary {
  const sorted = items.map(item => item.r).sort((a, b) => a - b);
  const relatives = items.flatMap(item => item.relative === null ? [] : [item.relative]);
  return {
    median: quantile(sorted, 0.5), q1: quantile(sorted, 0.25), q3: quantile(sorted, 0.75),
    min: sorted[0]!, max: sorted[sorted.length - 1]!, relativeMedian: relatives.length ? median(relatives) : null,
  };
}

/** Up and down shares of every labelled window of the stock inside the period; the same measure as the cases. */
function periodShares(horizon: Horizon, exchange: Exchange, period: { from: string; to: string }, nowMs: number,
  outcomes: OutcomeSource): CaseStats['allWindows'] {
  let up = 0;
  let down = 0;
  let labelled = 0;
  for (const { date } of sessionsBetween(exchange, period.from, period.to)) {
    const outcome = horizon === 'week' ? outcomes.closeWindow(date) : outcomes.day(date);
    if (!outcome || outcome.status !== 'complete' || outcome.label === null || outcome.entryDate === null ||
        outcome.exitDate === null || outcome.entryDate < period.from || outcome.exitDate > period.to ||
        outcome.exitAtMs === null || outcome.exitAtMs > nowMs) continue;
    labelled += 1;
    if (outcome.label === 'up') up += 1;
    if (outcome.label === 'down') down += 1;
  }
  return labelled ? { up: up / labelled, down: down / labelled } : null;
}

const EMPTY_CASES: CaseStats = {
  cases: 0, nEff: 0, up: 0, neutral: 0, down: 0, returns: null, period: null, entryType: null, allWindows: null,
};

/** Counts always; returns from five events; shares only from ten independent windows. */
function caseStatsOf(horizon: Horizon, exchange: Exchange, items: readonly CaseItem[], nowMs: number, outcomes: OutcomeSource): CaseStats {
  if (!items.length) return { ...EMPTY_CASES };
  const nEff = independentCount(items.map(item => ({ entryMs: item.entryAtMs, exitMs: item.exitAtMs })));
  const period = {
    from: items.reduce((min, item) => item.entryDate < min ? item.entryDate : min, items[0]!.entryDate),
    to: items.reduce((max, item) => item.exitDate > max ? item.exitDate : max, items[0]!.exitDate),
  };
  const types = new Set(items.map(item => item.entryType));
  const level = caseDisplayLevel({ cases: items.length, nEff });
  return {
    cases: items.length,
    nEff,
    up: items.filter(item => item.label === 'up').length,
    neutral: items.filter(item => item.label === 'neutral').length,
    down: items.filter(item => item.label === 'down').length,
    returns: level === 'list' ? null : returnSummary(items),
    period,
    entryType: types.size === 1 ? [...types][0]! : 'mixed',
    allWindows: level === 'shares' ? periodShares(horizon, exchange, period, nowMs, outcomes) : null,
  };
}

function httpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && value.length <= 2000;
  } catch {
    return false;
  }
}

function caseRef(exchange: Exchange, item: CaseItem): CaseRef | null {
  const source = (item.anchor.source || item.anchor.sourceProvider || '').trim().slice(0, 100);
  if (!source || !httpsUrl(item.anchor.url)) return null;
  const ref: CaseRef = {
    date: localDate(exchange, item.anchorMs), source, url: item.anchor.url,
    entryDate: item.entryDate, exitDate: item.exitDate, r: item.r, relative: item.relative,
  };
  const title = item.anchor.title?.trim().slice(0, 300);
  if (title) ref.title = title;
  return ref;
}

export interface CaseStatsInput {
  horizon: Horizon;
  exchange: Exchange;
  direction: LedgerDirection;
  /** Events grouped at nowMs (groupEvents) for one company. */
  events: readonly EventGroup[];
  nowMs: number;
  outcomes: OutcomeSource;
}

export interface CaseStatsResult {
  /** L2: same company and direction. */
  all: CaseStats;
  /** L1: same company, direction and topic; `other` is never a topic row. */
  topics: Array<{ topic: NewsTopicKey; cases: CaseStats }>;
  /** Most recent first, https links only. */
  examples: CaseRef[];
  excluded: Partial<Record<CaseExclusion, number>>;
}

export function buildCaseStats(input: CaseStatsInput): CaseStatsResult {
  const excluded: Partial<Record<CaseExclusion, number>> = {};
  const items = collectCases(input.horizon, input.exchange, input.events, input.direction, input.nowMs, input.outcomes, excluded);
  const topics: CaseStatsResult['topics'] = [];
  for (const topic of NEWS_TOPIC_KEYS) {
    if (topic === 'other') continue;
    const own = items.filter(item => item.topic === topic);
    if (own.length) topics.push({ topic, cases: caseStatsOf(input.horizon, input.exchange, own, input.nowMs, input.outcomes) });
  }
  const examples: CaseRef[] = [];
  for (const item of [...items].sort((a, b) => b.anchorMs - a.anchorMs)) {
    if (examples.length >= MAX_EXAMPLES) break;
    const ref = caseRef(input.exchange, item);
    if (ref) examples.push(ref);
  }
  return { all: caseStatsOf(input.horizon, input.exchange, items, input.nowMs, input.outcomes), topics, examples, excluded };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export interface DirectionStatsInput {
  horizon: Horizon;
  exchange: Exchange;
  companyId: string;
  direction: LedgerDirection;
  entries: readonly LedgerEntry[];
  nowMs: number;
  observation: Observation;
  outcomes: OutcomeSource;
  flags?: VerdictFlags;
  /** Events grouped at nowMs for this company; computed when omitted. */
  events?: readonly EventGroup[];
}

export interface DirectionBuild {
  stats: DirectionStats;
  sample: UnitSample;
  summary: SampleSummary;
  result: VerdictResult;
  caseExclusions: Partial<Record<CaseExclusion, number>>;
}

export function buildDirection(input: DirectionStatsInput): DirectionBuild {
  const common = {
    exchange: input.exchange, companyId: input.companyId, direction: input.direction, entries: input.entries,
    nowMs: input.nowMs, observation: input.observation,
  };
  const sample = input.horizon === 'week'
    ? buildWeekSample({ ...common, outcome: asOfMs => input.outcomes.week(asOfMs) })
    : buildDaySample({ ...common, outcome: date => input.outcomes.day(date) });
  const summary = summarizeSample(sample);
  const result = decideVerdict(summary, input.direction, input.flags);
  const events = input.events ?? groupEvents(companyEntries(input.entries, input.companyId), input.nowMs);
  const cases = buildCaseStats({
    horizon: input.horizon, exchange: input.exchange, direction: input.direction,
    events: events.filter(event => event.companyId === input.companyId), nowMs: input.nowMs, outcomes: input.outcomes,
  });
  const stats: DirectionStats = {
    verdict: result.verdict, sample: sampleStats(summary, result), all: cases.all, topics: cases.topics, examples: cases.examples,
  };
  if (result.reason) stats.reason = result.reason;
  return { stats, sample, summary, result, caseExclusions: cases.excluded };
}

export function directionStats(input: DirectionStatsInput): DirectionStats {
  return buildDirection(input).stats;
}

export interface CompanyStatsInput {
  companyId: string;
  exchange: Exchange;
  entries: readonly LedgerEntry[];
  nowMs: number;
  observation: Observation;
  outcomes: OutcomeSource;
  lastPriceDate: string | null;
  /** The market's provider allowed showing price statistics (plan 질문 8). */
  statsPublic: boolean;
  identityVerified: boolean;
  priceAvailable: boolean;
  sources: HistorySources;
  flags?: VerdictFlags;
}

export interface HorizonStats {
  /** Null for every status but ready: no numbers leave the job. */
  directions: { positive: DirectionStats; negative: DirectionStats } | null;
  /** Kept units whose directional articles rest on a backfill knowledge time ("과거 데이터 포함 · 시점 미보증"). */
  timeUnverifiedUnits: number;
}

/** What the job writes per company. Request-time fields (targetWindow, validation) are added by the API. */
export interface CompanyStats {
  version: typeof NEWS_HISTORY_VERSION;
  companyId: string;
  exchange: Exchange;
  status: HistoryReadyStatus;
  horizons: Record<Horizon, HorizonStats>;
  coverage: HistoryCoverage;
  dataAsOf: HistoryDataAsOf;
  sources: HistorySources;
}

function addCounts(target: Record<string, number>, prefix: string, counts: Partial<Record<string, number>>): void {
  for (const [key, value] of Object.entries(counts)) if (value) target[`${prefix}${key}`] = value;
}

export function companyStats(input: CompanyStatsInput): CompanyStats {
  // A replay at an earlier clock must not count or date entries the ledger had not seen yet.
  const entries = companyEntries(input.entries, input.companyId).filter(entry => isKnownAt(entry, input.nowMs));
  const events = groupEvents(entries, input.nowMs);
  const published = entries.map(entry => publishedMs(entry)).sort((a, b) => a - b);
  const dataAsOf: HistoryDataAsOf = {
    computedAt: iso(input.nowMs),
    lastPriceDate: input.lastPriceDate,
    ledgerFrom: published.length ? iso(published[0]!) : null,
    ledgerTo: published.length ? iso(published[published.length - 1]!) : null,
  };
  let status: HistoryReadyStatus = 'ready';
  if (!input.statsPublic) status = 'stats_not_public';
  else if (!input.identityVerified) status = 'identity_unverified';
  else if (!input.priceAvailable || input.lastPriceDate === null) status = 'price_unavailable';
  else if (!entries.length) status = 'no_history';
  const coverage: HistoryCoverage = { articles: entries.length, events: events.length, usable: 0, excluded: {}, observationGaps: 0 };
  const closed: HorizonStats = { directions: null, timeUnverifiedUnits: 0 };
  const record: CompanyStats = {
    version: NEWS_HISTORY_VERSION, companyId: input.companyId, exchange: input.exchange, status,
    horizons: { day: { ...closed }, week: { ...closed } }, coverage, dataAsOf, sources: input.sources,
  };
  if (status !== 'ready') return record;

  const lag = priceLagSessions(input.exchange, input.lastPriceDate!, input.nowMs);
  const flags: VerdictFlags = { ...input.flags, priceStale: Boolean(input.flags?.priceStale) || lag === null || lag > PRICE_STALE_SESSIONS };
  for (const horizon of ['week', 'day'] as const) {
    const build = (direction: LedgerDirection) => buildDirection({
      horizon, exchange: input.exchange, companyId: input.companyId, direction, entries, nowMs: input.nowMs,
      observation: input.observation, outcomes: input.outcomes, flags, events,
    });
    const positive = build('positive');
    const negative = build('negative');
    // Exclusions and units do not depend on the direction; the positive build stands for both.
    record.horizons[horizon] = {
      directions: { positive: positive.stats, negative: negative.stats },
      timeUnverifiedUnits: positive.sample.units.filter(unit => unit.timeUnverified).length,
    };
    addCounts(coverage.excluded, `${horizon}_`, positive.sample.excluded);
    if (horizon === 'week') {
      coverage.usable = positive.sample.units.length;
      coverage.observationGaps = positive.sample.excluded.observation_gap ?? 0;
      const cases: Record<string, number> = {};
      for (const [key, value] of [...Object.entries(positive.caseExclusions), ...Object.entries(negative.caseExclusions)]) {
        cases[key] = (cases[key] ?? 0) + (value ?? 0);
      }
      addCounts(coverage.excluded, 'case_', cases);
    }
  }
  return record;
}
