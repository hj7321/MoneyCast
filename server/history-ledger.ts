import type { AiConsensus, NewsArticle, NewsSentiment, NewsTopicKey } from '../packages/core/src/index.js';
import { titleKey, urlKey } from './aggregate.js';
import type { EntryType, OutcomeFlag, OutcomeLabel, PriceBasis } from './history-outcomes.js';
import type { CompanySnapshot } from './snapshot-store.js';
import { articleTopic } from './synthesis.js';

// Article ledger for historical news insights (plan ch. 5). Pure: entries,
// snapshots and clocks come in as arguments. Invariants: entries are keyed by
// (companyId, id) and never deleted; the first publishedAt, firstSeenAt and
// storyId stay; labels only grow, and only after the latest one; stories and
// events are recomputed from what was known at each asOf, never stored.
// Entries and labels passed in are treated as immutable: parsed
// times and URL/title keys are cached per object (checked against the source
// string, so a changed field is recomputed).

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const KST_OFFSET_MS = 9 * HOUR;
/** Same cut-off as `mergeArticles`; that constant is private to aggregate.ts. */
const SIMILAR_TITLE = 0.8;
export const STORY_WINDOW_MS = 48 * HOUR;
export const EVENT_WINDOW_MS = 72 * HOUR;
/** Replay assumption for backfilled entries, which have no recorded first-seen time. */
export const BACKFILL_KNOWN_DELAY_MS = DAY;

export type LedgerDirection = 'positive' | 'negative';

export interface LedgerCollection {
  sort: string;
  limit: number;
  languages: string[];
  fetch: string;
}

/** What the ledger knew about an article's classification from `at` onward. */
export interface LedgerLabel {
  /** `updatedAt` of the first snapshot that carried this value; never a model's `judgedAt`. */
  at: string;
  sentiment: NewsSentiment;
  score: number | null;
  method: 'provider' | 'unavailable' | 'llm' | null;
  /** 'related' only when both models judged the article to be about the company. */
  relevance: 'unrelated' | 'related' | null;
  consensus: AiConsensus | null;
  promptVersion: string | null;
  /** Sorted `provider:model` of the judgements behind this value. */
  models: string[];
}

/** Frozen five-session case outcome of one entry (the week-horizon case), written once by the daily job. */
export interface LedgerOutcome {
  entryType: EntryType;
  entryDate: string;
  exitDate: string;
  /** ISO instants of the entry price and the exit close. */
  entryAt: string;
  exitAt: string;
  /** Entry session through exit session. */
  sessions: string[];
  basis: PriceBasis;
  r: number;
  benchmarkR: number | null;
  relative: number | null;
  sigma: number | null;
  band: number | null;
  /** Null: insufficient_volatility_history, no direction label. */
  label: OutcomeLabel | null;
  flags: OutcomeFlag[];
  /** `${identity.priceBasis}/${OUTCOME_RULES_VERSION}`. */
  priceBasisVersion: string;
  /** ISO clock of the run that froze it. */
  frozenAt: string;
}

/** One article for one company. No body, description or AI summary is kept. */
export interface LedgerEntry {
  id: string;
  storyId: string;
  companyId: string;
  publishedAt: string;
  timeKind: 'published' | 'seen';
  timePrecision: 'second' | 'day';
  /** Null for backfilled entries: nobody recorded when the ledger first saw them. */
  firstSeenAt: string | null;
  source: string;
  sourceProvider: string | null;
  url: string;
  title: string;
  language: string | null;
  topic: NewsTopicKey;
  identity: 'entity_verified' | 'name_match';
  origin: 'forward' | 'backfill';
  collection: LedgerCollection;
  labels: LedgerLabel[];
  outcome?: LedgerOutcome;
}

const UNSPECIFIED_COLLECTION: LedgerCollection = { sort: 'unspecified', limit: 0, languages: [], fetch: 'snapshot' };

const ms = (iso: string): number => Date.parse(iso);
const iso = (value: number): string => new Date(value).toISOString();

// ---------------------------------------------------------------------------
// Parse caches (per object, validated against the source strings)
// ---------------------------------------------------------------------------

interface EntryTimes { publishedAt: string; firstSeenAt: string | null; publishedMs: number; knownMs: number }
const entryTimes = new WeakMap<LedgerEntry, EntryTimes>();

function timesOf(entry: LedgerEntry): EntryTimes {
  const cached = entryTimes.get(entry);
  if (cached && cached.publishedAt === entry.publishedAt && cached.firstSeenAt === entry.firstSeenAt) return cached;
  const publishedMs = ms(entry.publishedAt);
  const times = {
    publishedAt: entry.publishedAt, firstSeenAt: entry.firstSeenAt, publishedMs,
    knownMs: entry.firstSeenAt !== null ? ms(entry.firstSeenAt as string) : publishedMs + BACKFILL_KNOWN_DELAY_MS,
  };
  entryTimes.set(entry, times);
  return times;
}

const publishedMsOf = (entry: LedgerEntry): number => timesOf(entry).publishedMs;

const labelTimes = new WeakMap<LedgerLabel, { at: string; ms: number }>();
function labelMs(label: LedgerLabel): number {
  const cached = labelTimes.get(label);
  if (cached && cached.at === label.at) return cached.ms;
  const value = ms(label.at);
  labelTimes.set(label, { at: label.at, ms: value });
  return value;
}

/** An entry's story-matching keys: aggregate.ts's urlKey and titleKey, and the title's bigrams once needed. */
interface StoryKeys { url: string; urlKey: string; title: string; titleKey: string; grams: Float64Array | null }
const storyKeys = new WeakMap<LedgerEntry, StoryKeys>();
function keysOf(entry: LedgerEntry): StoryKeys {
  let keys = storyKeys.get(entry);
  if (!keys) {
    keys = { url: entry.url, urlKey: urlKey(entry.url), title: entry.title, titleKey: titleKey(entry.title), grams: null };
    storyKeys.set(entry, keys);
    return keys;
  }
  if (keys.url !== entry.url) { keys.url = entry.url; keys.urlKey = urlKey(entry.url); }
  if (keys.title !== entry.title) { keys.title = entry.title; keys.titleKey = titleKey(entry.title); keys.grams = null; }
  return keys;
}

/**
 * The distinct code-point bigrams of aggregate.ts (private there; it iterates
 * code points, so a valid surrogate pair is one point), each coded as one exact
 * number (first × 0x110000 + second), sorted ascending.
 */
function bigrams(value: string): Float64Array {
  const codes: number[] = [];
  let previous = -1;
  for (let i = 0; i < value.length; i += 1) {
    let point = value.charCodeAt(i);
    if (point >= 0xd800 && point <= 0xdbff && i + 1 < value.length) {
      const low = value.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) { point = (point - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000; i += 1; }
    }
    if (previous >= 0) codes.push(previous * 0x110000 + point);
    previous = point;
  }
  const sorted = Float64Array.from(codes).sort();
  let size = 0;
  for (let i = 0; i < sorted.length; i += 1) if (i === 0 || sorted[i] !== sorted[i - 1]) sorted[size++] = sorted[i]!;
  return sorted.subarray(0, size);
}

/** Exactly `titleSimilarity(a.title, b.title)` (Jaccard of the bigram sets), from the cached keys. */
function similarity(a: StoryKeys, b: StoryKeys): number {
  const left = a.grams ??= bigrams(a.titleKey);
  const right = b.grams ??= bigrams(b.titleKey);
  if (!left.length || !right.length) return a.titleKey === b.titleKey ? 1 : 0;
  let shared = 0;
  for (let i = 0, j = 0; i < left.length && j < right.length;) {
    if (left[i] === right[j]) { shared += 1; i += 1; j += 1; } else if (left[i]! < right[j]!) i += 1; else j += 1;
  }
  return shared / (left.length + right.length - shared);
}

/** Jaccard ≤ min / max set size, so a size ratio under this can never reach SIMILAR_TITLE (kept below it for float safety). */
const SIZE_RATIO_BOUND = SIMILAR_TITLE - 0.01;

/** An entry with its publication time and (lazily) its keys, for the story loops. */
interface StoryItem {
  entry: LedgerEntry;
  ms: number;
  keys?: StoryKeys;
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

/** Merge key: the same article id in two companies' pools must never share labels. */
export function ledgerKey(entry: Pick<LedgerEntry, 'companyId' | 'id'>): string {
  return `${entry.companyId}\u0000${entry.id}`;
}

function byTimeThenId(a: LedgerEntry, b: LedgerEntry): number {
  return publishedMsOf(a) - publishedMsOf(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** A timestamp at exactly 00:00 UTC or 00:00 KST carries a date, not a time. */
function precisionOf(publishedMs: number): LedgerEntry['timePrecision'] {
  return publishedMs % DAY === 0 || (publishedMs + KST_OFFSET_MS) % DAY === 0 ? 'day' : 'second';
}

function relevanceOf(article: NewsArticle): LedgerLabel['relevance'] {
  if (article.aiRelevance === 'unrelated') return 'unrelated';
  const judgements = article.aiJudgements ?? [];
  return judgements.length >= 2 && judgements.every(item => item.relevant) ? 'related' : null;
}

function labelFromArticle(article: NewsArticle, at: string, promptVersion: string | null): LedgerLabel {
  return {
    at, sentiment: article.sentiment, score: article.sentimentScore ?? null, method: article.classificationMethod ?? null,
    relevance: relevanceOf(article), consensus: article.aiConsensus ?? null, promptVersion,
    models: [...new Set((article.aiJudgements ?? []).map(item => `${item.provider}:${item.model}`))].sort(),
  };
}

const copyCollection = (collection: LedgerCollection): LedgerCollection => ({ ...collection, languages: [...collection.languages] });

/** The stored features of an article; the clocks and origin are the caller's. */
function entryFromArticle(companyId: string, article: NewsArticle, publishedMs: number, collection: LedgerCollection):
  Omit<LedgerEntry, 'firstSeenAt' | 'origin' | 'labels'> {
  return {
    id: article.id, storyId: article.id, companyId, publishedAt: article.publishedAt,
    timeKind: article.timeKind ?? 'published', timePrecision: precisionOf(publishedMs),
    source: article.source, sourceProvider: article.sourceProvider ?? null, url: article.url, title: article.title,
    language: article.language ?? null, topic: articleTopic(article),
    // An untagged article is treated as the weaker identity: it then needs the models' agreement to count.
    identity: article.identity ?? 'name_match',
    collection: copyCollection(collection),
  };
}

/**
 * Pool articles as forward entries. Both clocks come from the snapshot's own
 * `updatedAt`: a job's clock or `publishedAt` would claim knowledge the ledger
 * did not have yet.
 */
export function entriesFromSnapshot(companyId: string, snapshot: CompanySnapshot,
  options: { collection?: LedgerCollection } = {}): LedgerEntry[] {
  if (snapshot.companyId !== companyId || !Number.isFinite(ms(snapshot.updatedAt))) return [];
  const promptVersion = snapshot.analysis.ai?.promptVersion ?? null;
  const seen = new Set<string>();
  const entries: LedgerEntry[] = [];
  for (const article of snapshot.pool) {
    const publishedMs = ms(article.publishedAt);
    if (seen.has(article.id) || !Number.isFinite(publishedMs)) continue;
    seen.add(article.id);
    const base = entryFromArticle(companyId, article, publishedMs, options.collection ?? UNSPECIFIED_COLLECTION);
    entries.push({
      ...base, firstSeenAt: snapshot.updatedAt, origin: 'forward',
      labels: [labelFromArticle(article, snapshot.updatedAt, promptVersion)],
    });
  }
  return entries;
}

export interface BackfillArticleInput {
  companyId: string;
  article: NewsArticle;
  collection: LedgerCollection;
}

/**
 * A backfilled article (plan step 8). Nobody saw it when it was published, so
 * firstSeenAt stays null and its one label is dated publication + 24 hours,
 * the assumed knowledge time; dating it at the run would leave every past
 * week unclassified. Null for a non-finite publishedAt.
 */
export function backfillEntry(input: BackfillArticleInput): LedgerEntry | null {
  const publishedMs = ms(input.article.publishedAt);
  if (!Number.isFinite(publishedMs)) return null;
  return {
    ...entryFromArticle(input.companyId, input.article, publishedMs, input.collection), firstSeenAt: null, origin: 'backfill',
    labels: [labelFromArticle(input.article, iso(publishedMs + BACKFILL_KNOWN_DELAY_MS), null)],
  };
}

function latestLabel(labels: readonly LedgerLabel[]): LedgerLabel | null {
  let latest: LedgerLabel | null = null;
  for (const label of labels) if (!latest || labelMs(label) >= labelMs(latest)) latest = label;
  return latest;
}

function sameLabelValue(a: LedgerLabel, b: LedgerLabel): boolean {
  return a.sentiment === b.sentiment && a.score === b.score && a.method === b.method && a.relevance === b.relevance &&
    a.consensus === b.consensus && a.promptVersion === b.promptVersion &&
    a.models.length === b.models.length && a.models.every((model, i) => model === b.models[i]);
}

/** The classification the ledger knew at `atMs`; null means unclassified. */
export function labelAt(entry: LedgerEntry, atMs: number): LedgerLabel | null {
  let found: LedgerLabel | null = null;
  let foundMs = 0;
  for (const label of entry.labels) {
    const at = labelMs(label);
    if (at <= atMs && (!found || at >= foundMs)) { found = label; foundMs = at; }
  }
  return found;
}

/** When a replay may use the entry: the first sighting, or publication plus a day for backfill. */
export function knownAtMs(entry: LedgerEntry): number {
  return timesOf(entry).knownMs;
}

export function isKnownAt(entry: LedgerEntry, asOfMs: number): boolean {
  return knownAtMs(entry) <= asOfMs;
}

/** Backfilled entries rest on an assumed knowledge time and are reported as such. */
export function isTimeUnverified(entry: LedgerEntry): boolean {
  return entry.firstSeenAt === null;
}

/**
 * Which frozen outcome an entry keeps. Under one price-basis version the first
 * one frozen wins; an outcome under another version replaces it only when it
 * was frozen later (a provider or rule change re-freezes everything once).
 */
export function pickOutcome(a: LedgerOutcome | undefined, b: LedgerOutcome | undefined): LedgerOutcome | undefined {
  if (!a) return b;
  if (!b) return a;
  return a.priceBasisVersion !== b.priceBasisVersion && ms(b.frozenAt) > ms(a.frozenAt) ? b : a;
}

/**
 * One key's merge: labels appended only when the value changed and only after
 * the latest one; the first firstSeenAt; the outcome by `pickOutcome`. Returns
 * `old` itself when nothing changed.
 */
export function mergeEntry(old: LedgerEntry, incoming: LedgerEntry): LedgerEntry {
  let labels = old.labels;
  for (const label of [...incoming.labels].sort((a, b) => labelMs(a) - labelMs(b))) {
    const latest = latestLabel(labels);
    // An older snapshot arriving late must not rewrite what the ledger knew at that time.
    if (!Number.isFinite(labelMs(label)) || (latest && (labelMs(label) <= labelMs(latest) || sameLabelValue(latest, label)))) continue;
    labels = [...labels, label];
  }
  // A recorded sighting replaces the backfill assumption; two recorded sightings keep the earlier one.
  const firstSeenAt = old.firstSeenAt ?? incoming.firstSeenAt;
  const outcome = pickOutcome(old.outcome, incoming.outcome);
  if (labels === old.labels && firstSeenAt === old.firstSeenAt && outcome === old.outcome) return old;
  return { ...old, firstSeenAt, labels, ...(outcome ? { outcome } : {}) };
}

/** Pairs inside the story window only: a headline reused months later is a different story. */
function sameStory(a: StoryItem, b: StoryItem): boolean {
  if (Math.abs(a.ms - b.ms) > STORY_WINDOW_MS) return false;
  const keyA = a.keys ??= keysOf(a.entry);
  const keyB = b.keys ??= keysOf(b.entry);
  if (keyA.urlKey === keyB.urlKey) return true;
  if (keyA.titleKey && keyA.titleKey === keyB.titleKey) return true;
  if (keyA.titleKey === '') return false;
  const left = keyA.grams ??= bigrams(keyA.titleKey);
  const right = keyB.grams ??= bigrams(keyB.titleKey);
  if (left.length && right.length && Math.min(left.length, right.length) < SIZE_RATIO_BOUND * Math.max(left.length, right.length)) return false;
  return similarity(keyA, keyB) >= SIMILAR_TITLE;
}

const copyEntry = (entry: LedgerEntry): LedgerEntry =>
  ({ ...entry, labels: entry.labels.map(label => ({ ...label, models: [...label.models] })) });

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * One company's peers for joining a story: indexes sorted by finite publication
 * time, and the peers whose storyId is not their own id (a story's other
 * members are found through those and the key index, so the common
 * storyId === id case costs nothing).
 */
interface CompanyPeers {
  times: number[];
  indexes: number[];
  joined: Map<string, number[]>;
}

/** One pass over a company's existing entries (parsed directly: most are never looked at again in this merge). */
function buildPeers(entries: readonly LedgerEntry[], indexes: readonly number[]): CompanyPeers {
  const joined = new Map<string, number[]>();
  let times: number[] = [];
  let finite: number[] = [];
  let sorted = true;
  for (const i of indexes) {
    const entry = entries[i]!;
    if (entry.storyId !== entry.id) pushTo(joined, entry.storyId, i);
    const at = ms(entry.publishedAt);
    if (!Number.isFinite(at)) continue;
    if (times.length && at < times[times.length - 1]!) sorted = false;
    times.push(at);
    finite.push(i);
  }
  if (!sorted) {
    const order = times.map((_, k) => k).sort((a, b) => times[a]! - times[b]! || finite[a]! - finite[b]!);
    times = order.map(k => times[k]!);
    finite = order.map(k => finite[k]!);
  }
  return { times, indexes: finite, joined };
}

function addPeer(peers: CompanyPeers, entry: LedgerEntry, i: number): void {
  if (entry.storyId !== entry.id) pushTo(peers.joined, entry.storyId, i);
  const at = publishedMsOf(entry);
  if (!Number.isFinite(at)) return;
  let lo = 0;
  let hi = peers.times.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (peers.times[mid]! <= at) lo = mid + 1; else hi = mid; }
  peers.times.splice(lo, 0, at);
  peers.indexes.splice(lo, 0, i);
}

/**
 * Upserts by (companyId, id) and never deletes. The first publishedAt, firstSeenAt
 * and storyId stay; later copies add labels only when the value changed, and only
 * after the latest one. A new entry joins the story of an earlier-published match.
 * Inputs are never mutated; unchanged entries keep their identity.
 */
export function mergeLedger(existing: readonly LedgerEntry[], incoming: readonly LedgerEntry[]): LedgerEntry[] {
  const result = existing.slice();
  const index = new Map<string, number>();
  const byCompany = new Map<string, number[]>();
  for (let i = 0; i < result.length; i += 1) {
    const key = ledgerKey(result[i]!);
    if (index.has(key)) continue;
    index.set(key, i);
    pushTo(byCompany, result[i]!.companyId, i);
  }
  // Built on a company's first new entry; merges never change storyId or publishedAt, so it stays valid.
  const peersByCompany = new Map<string, CompanyPeers>();
  const peersOf = (companyId: string): CompanyPeers => {
    let peers = peersByCompany.get(companyId);
    if (!peers) {
      peers = buildPeers(result, byCompany.get(companyId) ?? []);
      peersByCompany.set(companyId, peers);
    }
    return peers;
  };
  for (const entry of incoming) {
    const key = ledgerKey(entry);
    const at = index.get(key);
    if (at !== undefined) { result[at] = mergeEntry(result[at]!, entry); continue; }
    const peers = peersOf(entry.companyId);
    const publishedMs = publishedMsOf(entry);
    const self: StoryItem = { entry, ms: publishedMs };
    let home: LedgerEntry | undefined;
    // A peer with an unknown time, or an entry with one, can never satisfy the 48-hour join rule.
    if (Number.isFinite(publishedMs)) {
      // Joining must keep every pair in the story within 48 hours, or a daily recurring headline would chain into one story.
      // Every peer carrying storyId: the one whose id it is, and those that joined it.
      const fits = (storyId: string) => {
        const members = [...(peers.joined.get(storyId) ?? [])];
        const own = index.get(ledgerKey({ companyId: entry.companyId, id: storyId }));
        if (own !== undefined && result[own]!.storyId === storyId) members.push(own);
        return members.every(i => Math.abs(publishedMsOf(result[i]!) - publishedMs) <= STORY_WINDOW_MS);
      };
      let lo = 0;
      let hi = peers.times.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (peers.times[mid]! < publishedMs - STORY_WINDOW_MS) lo = mid + 1; else hi = mid; }
      const matches: LedgerEntry[] = [];
      for (let i = lo; i < peers.times.length && peers.times[i]! <= publishedMs + STORY_WINDOW_MS; i += 1) {
        const peer = result[peers.indexes[i]!]!;
        if (sameStory({ entry: peer, ms: peers.times[i]! }, self)) matches.push(peer);
      }
      home = matches.sort(byTimeThenId).find(peer => fits(peer.storyId));
    }
    const created: LedgerEntry = { ...copyEntry(entry), storyId: home?.storyId ?? entry.storyId };
    index.set(key, result.length);
    pushTo(byCompany, entry.companyId, result.length);
    addPeer(peers, created, result.length);
    result.push(created);
  }
  return result;
}

/**
 * Folds stored ledger segments in order (plan step 4: append-only segments
 * with full-entry patches). A key's first appearance is copied as stored,
 * storyId included; every later appearance goes through `mergeEntry`. Output is
 * in first-appearance order; inputs are never mutated. The copies are shallow:
 * nested values (labels, collection, outcome) are shared and, like everything
 * in the ledger, never mutated in place.
 */
export function foldLedger(segments: ReadonlyArray<readonly LedgerEntry[]>): LedgerEntry[] {
  const result: LedgerEntry[] = [];
  const index = new Map<string, number>();
  for (const segment of segments) {
    for (const entry of segment) {
      const key = ledgerKey(entry);
      const at = index.get(key);
      if (at === undefined) { index.set(key, result.length); result.push({ ...entry }); }
      else result[at] = mergeEntry(result[at]!, entry);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

export interface StoryGroup {
  /** Id of the earliest member known at asOf; recomputed, never the stored `storyId`. */
  key: string;
  companyId: string;
  /** Oldest first. */
  entries: LedgerEntry[];
  timeUnverified: boolean;
}

const compareGroups = (a: StoryGroup, b: StoryGroup) =>
  byTimeThenId(a.entries[0]!, b.entries[0]!) || (a.companyId < b.companyId ? -1 : a.companyId > b.companyId ? 1 : 0);

/**
 * Stories as they were visible at asOf: only entries known by then, grouped by
 * the ledger rule (URL or title match AND within 48 hours). Oldest first, an
 * entry joins the earliest story it matches whose first member is at most 48
 * hours older, so every pair in a story is within 48 hours and copies never
 * chain (a daily "Why X stock is moving today" stays one story per day pair).
 */
export function groupStories(entries: readonly LedgerEntry[], asOfMs: number): StoryGroup[] {
  const groups: StoryGroup[] = [];
  const byCompany = new Map<string, IndexItem[]>();
  entries.forEach((entry, order) => {
    const times = timesOf(entry);
    if (times.knownMs <= asOfMs && Number.isFinite(times.publishedMs)) pushTo(byCompany, entry.companyId, { entry, ms: times.publishedMs, order, story: null });
  });
  for (const [companyId, all] of byCompany) {
    const stories: Array<{ firstMs: number; list: IndexItem[] }> = [];
    // Stories are created oldest first, so those too old for the current entry form a prefix.
    let open = 0;
    // (publishedAt, id) with input order for ties: the order of a stable sort by time then id.
    for (const item of all.sort(compareItems)) {
      while (open < stories.length && item.ms - stories[open]!.firstMs > STORY_WINDOW_MS) open += 1;
      let home: { firstMs: number; list: IndexItem[] } | undefined;
      for (let i = open; i < stories.length && !home; i += 1) {
        if (stories[i]!.list.some(member => sameStory(member, item))) home = stories[i];
      }
      if (home) home.list.push(item);
      else stories.push({ firstMs: item.ms, list: [item] });
    }
    for (const { list } of stories) {
      const members = list.map(item => item.entry);
      groups.push({ key: members[0]!.id, companyId, entries: members, timeUnverified: members.some(isTimeUnverified) });
    }
  }
  return groups.sort(compareGroups);
}

/** Incremental `groupStories` over one fixed entry list for ascending asOf values. */
export interface StoryIndex {
  /** Adds the entries known at asOfMs; a RangeError if asOfMs is lower than the last one. */
  advance(asOfMs: number): void;
  /** The entry's story at the last advance; undefined while the entry is not known. Do not mutate. */
  storyOf(entry: LedgerEntry): StoryGroup | undefined;
  /** Fresh copies, deepStrictEqual to groupStories(entries, last asOf). */
  stories(): StoryGroup[];
}

interface IndexItem extends StoryItem {
  /** Position in the input: ties of (publishedAt, id) keep input order, as a stable sort by time then id does. */
  order: number;
  story: IndexStory | null;
}

interface IndexStory {
  firstMs: number;
  members: IndexItem[];
  group: StoryGroup | null;
}

interface CompanyIndex {
  companyId: string;
  /** Known entries in story order (publishedAt, id, input order). */
  known: IndexItem[];
  /** In creation order, which is also ascending first-member order. */
  stories: IndexStory[];
}

function compareItems(a: IndexItem, b: IndexItem): number {
  return a.ms - b.ms || (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0) || a.order - b.order;
}

/**
 * Exact incremental replacement for repeated `groupStories` calls. A story
 * decision depends only on the entries before it in story order, so when a
 * batch becomes known with earliest key p, everything before p stands. Stories
 * whose first member is more than 48 hours before p are final; the others drop
 * their members from p on, and the greedy rule re-runs over the known entries
 * from p.
 */
export function createStoryIndex(entries: readonly LedgerEntry[]): StoryIndex {
  const pending: Array<{ item: IndexItem; knownMs: number }> = [];
  const itemOf = new Map<LedgerEntry, IndexItem>();
  entries.forEach((entry, order) => {
    const publishedMs = publishedMsOf(entry);
    const knownMs = knownAtMs(entry);
    if (!Number.isFinite(publishedMs) || Number.isNaN(knownMs)) return;
    const item: IndexItem = { entry, ms: publishedMs, order, story: null };
    pending.push({ item, knownMs });
    itemOf.set(entry, item);
  });
  pending.sort((a, b) => a.knownMs - b.knownMs || a.item.order - b.item.order);
  const companies = new Map<string, CompanyIndex>();
  let next = 0;
  let lastAsOf = -Infinity;

  const groupOf = (company: CompanyIndex, story: IndexStory): StoryGroup => story.group ??= {
    key: story.members[0]!.entry.id, companyId: company.companyId, entries: story.members.map(member => member.entry),
    timeUnverified: story.members.some(member => isTimeUnverified(member.entry)),
  };

  function insert(company: CompanyIndex, batch: IndexItem[]): void {
    batch.sort(compareItems);
    const p = batch[0]!;
    const known = company.known;
    // Only the known entries from p on move: merge that tail with the batch in place.
    let start = 0;
    let hi = known.length;
    while (start < hi) { const mid = (start + hi) >>> 1; if (compareItems(known[mid]!, p) < 0) start = mid + 1; else hi = mid; }
    const tail = known.splice(start);
    for (let i = 0, j = 0; i < tail.length || j < batch.length;) {
      if (j >= batch.length || (i < tail.length && compareItems(tail[i]!, batch[j]!) < 0)) known.push(tail[i++]!);
      else known.push(batch[j++]!);
    }
    const merged = known;
    const cut = p.ms - STORY_WINDOW_MS;
    for (let s = company.stories.length - 1; s >= 0 && company.stories[s]!.firstMs >= cut; s -= 1) {
      const story = company.stories[s]!;
      const keep = story.members.findIndex(member => compareItems(member, p) >= 0);
      if (keep === -1) continue;
      story.group = null;
      if (keep === 0) company.stories.splice(s, 1);
      else story.members.length = keep;
    }
    let open = 0;
    hi = company.stories.length;
    while (open < hi) { const mid = (open + hi) >>> 1; if (p.ms - company.stories[mid]!.firstMs > STORY_WINDOW_MS) open = mid + 1; else hi = mid; }
    for (let k = start; k < merged.length; k += 1) {
      const item = merged[k]!;
      while (open < company.stories.length && item.ms - company.stories[open]!.firstMs > STORY_WINDOW_MS) open += 1;
      let home: IndexStory | undefined;
      for (let s = open; s < company.stories.length && !home; s += 1) {
        if (company.stories[s]!.members.some(member => sameStory(member, item))) home = company.stories[s];
      }
      if (home) { home.members.push(item); home.group = null; }
      else { home = { firstMs: item.ms, members: [item], group: null }; company.stories.push(home); }
      item.story = home;
    }
  }

  return {
    advance(asOfMs: number): void {
      if (Number.isNaN(asOfMs) || asOfMs < lastAsOf) throw new RangeError('story index asOf must not decrease');
      lastAsOf = asOfMs;
      const batches = new Map<string, IndexItem[]>();
      while (next < pending.length && pending[next]!.knownMs <= asOfMs) {
        const { item } = pending[next++]!;
        pushTo(batches, item.entry.companyId, item);
      }
      for (const [companyId, batch] of batches) {
        let company = companies.get(companyId);
        if (!company) { company = { companyId, known: [], stories: [] }; companies.set(companyId, company); }
        insert(company, batch);
      }
    },
    storyOf(entry: LedgerEntry): StoryGroup | undefined {
      const item = itemOf.get(entry);
      if (!item?.story) return undefined;
      return groupOf(companies.get(entry.companyId)!, item.story);
    },
    stories(): StoryGroup[] {
      const groups: StoryGroup[] = [];
      for (const company of companies.values()) {
        for (const story of company.stories) {
          const group = groupOf(company, story);
          groups.push({ ...group, entries: [...group.entries] });
        }
      }
      return groups.sort(compareGroups);
    },
  };
}

// ---------------------------------------------------------------------------
// Inclusion and events
// ---------------------------------------------------------------------------

export type StatsInclusion = 'included_verified' | 'included_name_match' | 'excluded_unrelated' | 'excluded_name_match';

/**
 * Statistics use verified articles; a title-only match counts when two models
 * agreed it is about the company, and is kept apart. Judged at `atMs`, so an
 * article later found unrelated still counted before that.
 */
export function statsInclusion(entry: LedgerEntry, atMs: number): StatsInclusion {
  const label = labelAt(entry, atMs);
  if (label?.relevance === 'unrelated') return 'excluded_unrelated';
  if (entry.identity === 'entity_verified') return 'included_verified';
  return label?.relevance === 'related' ? 'included_name_match' : 'excluded_name_match';
}

export function isStatsEligible(entry: LedgerEntry, atMs: number): boolean {
  return statsInclusion(entry, atMs).startsWith('included');
}

function directionAt(entry: LedgerEntry, atMs: number): LedgerDirection | null {
  const sentiment = labelAt(entry, atMs)?.sentiment;
  return sentiment === 'positive' || sentiment === 'negative' ? sentiment : null;
}

/**
 * A story's representative at asOf: its earliest eligible directional copy, or
 * null when it has none or its copies disagree on direction.
 */
export function storyRepresentative(story: StoryGroup, asOfMs: number): { entry: LedgerEntry; direction: LedgerDirection } | null {
  let found: { entry: LedgerEntry; direction: LedgerDirection } | null = null;
  for (const entry of story.entries) {
    const direction = directionAt(entry, asOfMs);
    if (!direction || !isStatsEligible(entry, asOfMs)) continue;
    if (!found) found = { entry, direction };
    else if (found.direction !== direction) return null;
  }
  return found;
}

export interface EventGroup {
  companyId: string;
  direction: LedgerDirection;
  topic: NewsTopicKey;
  /** Earliest representative article; the 72-hour window starts here. */
  anchorId: string;
  anchorMs: number;
  /** One representative per story, oldest first; the anchor is first. */
  members: LedgerEntry[];
  storyKeys: string[];
  /** Any member rests on a backfill assumption instead of a recorded first sighting. */
  timeUnverified: boolean;
  /** Any member was matched by title only and admitted by the models' agreement. */
  nameMatch: boolean;
}

/**
 * Events as they were visible at asOf. A story is represented by its earliest
 * eligible directional copy; copies that disagree on direction leave the story
 * out. Same company, direction and topic within 72 hours of the anchor form one
 * event, and the next anchor starts a new one (no chaining).
 */
export function groupEvents(entries: readonly LedgerEntry[], asOfMs: number): EventGroup[] {
  const buckets = new Map<string, Array<{ story: StoryGroup; representative: LedgerEntry }>>();
  for (const story of groupStories(entries, asOfMs)) {
    const found = storyRepresentative(story, asOfMs);
    if (!found) continue;
    const key = `${story.companyId}\u0000${found.direction}\u0000${found.entry.topic}`;
    pushTo(buckets, key, { story, representative: found.entry });
  }
  const events: EventGroup[] = [];
  for (const items of buckets.values()) {
    items.sort((a, b) => byTimeThenId(a.representative, b.representative));
    for (let i = 0; i < items.length;) {
      const anchorMs = publishedMsOf(items[i]!.representative);
      let end = i + 1;
      while (end < items.length && publishedMsOf(items[end]!.representative) - anchorMs <= EVENT_WINDOW_MS) end += 1;
      const taken = items.slice(i, end);
      const anchor = taken[0]!.representative;
      events.push({
        companyId: anchor.companyId, direction: directionAt(anchor, asOfMs)!, topic: anchor.topic, anchorId: anchor.id, anchorMs,
        members: taken.map(item => item.representative), storyKeys: taken.map(item => item.story.key),
        timeUnverified: taken.some(item => isTimeUnverified(item.representative)),
        nameMatch: taken.some(item => statsInclusion(item.representative, asOfMs) === 'included_name_match'),
      });
      i = end;
    }
  }
  return events.sort((a, b) => a.anchorMs - b.anchorMs || (a.anchorId < b.anchorId ? -1 : a.anchorId > b.anchorId ? 1 : 0) ||
    (a.companyId < b.companyId ? -1 : a.companyId > b.companyId ? 1 : 0));
}

export interface ReturnWindow {
  entryMs: number;
  exitMs: number;
}

/**
 * Greedy by entry time: a window is independent when it enters no earlier than
 * the exit of the previously kept one. Malformed windows are skipped.
 */
export function selectIndependent<T extends ReturnWindow>(windows: readonly T[]): T[] {
  const kept: T[] = [];
  const valid = windows.filter(window => Number.isFinite(window.entryMs) && Number.isFinite(window.exitMs) && window.exitMs >= window.entryMs);
  for (const window of [...valid].sort((a, b) => a.entryMs - b.entryMs || a.exitMs - b.exitMs)) {
    const last = kept[kept.length - 1];
    if (!last || window.entryMs >= last.exitMs) kept.push(window);
  }
  return kept;
}

/** n_eff: how many non-overlapping return windows the events give. */
export function independentCount(windows: readonly ReturnWindow[]): number {
  return selectIndependent(windows).length;
}
