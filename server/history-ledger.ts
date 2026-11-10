import type { AiConsensus, NewsArticle, NewsSentiment, NewsTopicKey } from '../packages/core/src/index.js';
import { titleKey, titleSimilarity, urlKey } from './aggregate.js';
import type { CompanySnapshot } from './snapshot-store.js';
import { articleTopic } from './synthesis.js';

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

/** Completed result, written once by the outcome step and frozen afterwards. */
export interface LedgerOutcome {
  entryType: 'open' | 'close';
  entryDate: string;
  exitDate: string;
  r: number;
  relative: number | null;
  band: number | null;
  label: 'up' | 'flat' | 'down';
  priceBasisVersion: string;
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

/** Merge key: the same article id in two companies' pools must never share labels. */
export function ledgerKey(entry: Pick<LedgerEntry, 'companyId' | 'id'>): string {
  return `${entry.companyId}\u0000${entry.id}`;
}

function byTimeThenId(a: LedgerEntry, b: LedgerEntry): number {
  return ms(a.publishedAt) - ms(b.publishedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
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
    entries.push({
      id: article.id, storyId: article.id, companyId, publishedAt: article.publishedAt,
      timeKind: article.timeKind ?? 'published', timePrecision: precisionOf(publishedMs), firstSeenAt: snapshot.updatedAt,
      source: article.source, sourceProvider: article.sourceProvider ?? null, url: article.url, title: article.title,
      language: article.language ?? null, topic: articleTopic(article),
      // An untagged article is treated as the weaker identity: it then needs the models' agreement to count.
      identity: article.identity ?? 'name_match', origin: 'forward',
      collection: { ...(options.collection ?? UNSPECIFIED_COLLECTION), languages: [...(options.collection ?? UNSPECIFIED_COLLECTION).languages] },
      labels: [labelFromArticle(article, snapshot.updatedAt, promptVersion)],
    });
  }
  return entries;
}

function latestLabel(labels: readonly LedgerLabel[]): LedgerLabel | null {
  let latest: LedgerLabel | null = null;
  for (const label of labels) if (!latest || ms(label.at) >= ms(latest.at)) latest = label;
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
  for (const label of entry.labels) {
    const at = ms(label.at);
    if (at <= atMs && (!found || at >= ms(found.at))) found = label;
  }
  return found;
}

/** When a replay may use the entry: the first sighting, or publication plus a day for backfill. */
export function knownAtMs(entry: LedgerEntry): number {
  return entry.firstSeenAt !== null ? ms(entry.firstSeenAt) : ms(entry.publishedAt) + BACKFILL_KNOWN_DELAY_MS;
}

export function isKnownAt(entry: LedgerEntry, asOfMs: number): boolean {
  return knownAtMs(entry) <= asOfMs;
}

/** Backfilled entries rest on an assumed knowledge time and are reported as such. */
export function isTimeUnverified(entry: LedgerEntry): boolean {
  return entry.firstSeenAt === null;
}

function mergeEntry(old: LedgerEntry, incoming: LedgerEntry): LedgerEntry {
  let labels = old.labels;
  for (const label of [...incoming.labels].sort((a, b) => ms(a.at) - ms(b.at))) {
    const latest = latestLabel(labels);
    // An older snapshot arriving late must not rewrite what the ledger knew at that time.
    if (!Number.isFinite(ms(label.at)) || (latest && (ms(label.at) <= ms(latest.at) || sameLabelValue(latest, label)))) continue;
    labels = [...labels, label];
  }
  // A recorded sighting replaces the backfill assumption; two recorded sightings keep the earlier one.
  const firstSeenAt = old.firstSeenAt ?? incoming.firstSeenAt;
  const outcome = old.outcome ?? incoming.outcome;
  if (labels === old.labels && firstSeenAt === old.firstSeenAt && outcome === old.outcome) return old;
  return { ...old, firstSeenAt, labels, ...(outcome ? { outcome } : {}) };
}

/** Pairs inside the story window only: a headline reused months later is a different story. */
function sameStoryEntry(a: LedgerEntry, b: LedgerEntry): boolean {
  if (Math.abs(ms(a.publishedAt) - ms(b.publishedAt)) > STORY_WINDOW_MS) return false;
  if (urlKey(a.url) === urlKey(b.url)) return true;
  const keyA = titleKey(a.title);
  if (keyA && keyA === titleKey(b.title)) return true;
  return keyA !== '' && titleSimilarity(a.title, b.title) >= SIMILAR_TITLE;
}

/**
 * Upserts by (companyId, id) and never deletes. The first publishedAt, firstSeenAt
 * and storyId stay; later copies add labels only when the value changed, and only
 * after the latest one. A new entry joins the story of an earlier-published match.
 */
export function mergeLedger(existing: readonly LedgerEntry[], incoming: readonly LedgerEntry[]): LedgerEntry[] {
  const result = [...existing];
  const index = new Map<string, number>();
  const byCompany = new Map<string, number[]>();
  result.forEach((entry, i) => {
    if (index.has(ledgerKey(entry))) return;
    index.set(ledgerKey(entry), i);
    byCompany.set(entry.companyId, [...(byCompany.get(entry.companyId) ?? []), i]);
  });
  for (const entry of incoming) {
    const key = ledgerKey(entry);
    const at = index.get(key);
    if (at !== undefined) { result[at] = mergeEntry(result[at]!, entry); continue; }
    const company = (byCompany.get(entry.companyId) ?? []).map(i => result[i]!);
    const publishedMs = ms(entry.publishedAt);
    // Joining must keep every pair in the story within 48 hours, or a daily recurring headline would chain into one story.
    const fits = (storyId: string) => company.every(peer => peer.storyId !== storyId || Math.abs(ms(peer.publishedAt) - publishedMs) <= STORY_WINDOW_MS);
    const home = company.filter(peer => sameStoryEntry(peer, entry)).sort(byTimeThenId).find(peer => fits(peer.storyId));
    const created: LedgerEntry = { ...entry, storyId: home?.storyId ?? entry.storyId, labels: entry.labels.map(label => ({ ...label, models: [...label.models] })) };
    index.set(key, result.length);
    byCompany.set(entry.companyId, [...(byCompany.get(entry.companyId) ?? []), result.length]);
    result.push(created);
  }
  return result;
}

export interface StoryGroup {
  /** Id of the earliest member known at asOf; recomputed, never the stored `storyId`. */
  key: string;
  companyId: string;
  /** Oldest first. */
  entries: LedgerEntry[];
  timeUnverified: boolean;
}

function groupByCompany(entries: readonly LedgerEntry[]): Map<string, LedgerEntry[]> {
  const byCompany = new Map<string, LedgerEntry[]>();
  for (const entry of entries) byCompany.set(entry.companyId, [...(byCompany.get(entry.companyId) ?? []), entry]);
  return byCompany;
}

/**
 * Stories as they were visible at asOf: only entries known by then, grouped by
 * the ledger rule (URL or title match AND within 48 hours). Oldest first, an
 * entry joins the earliest story it matches whose first member is at most 48
 * hours older, so every pair in a story is within 48 hours and copies never
 * chain (a daily "Why X stock is moving today" stays one story per day pair).
 */
export function groupStories(entries: readonly LedgerEntry[], asOfMs: number): StoryGroup[] {
  const groups: StoryGroup[] = [];
  for (const [companyId, all] of groupByCompany(entries.filter(entry => isKnownAt(entry, asOfMs) && Number.isFinite(ms(entry.publishedAt))))) {
    const stories: Array<{ firstMs: number; list: LedgerEntry[] }> = [];
    for (const entry of all.sort(byTimeThenId)) {
      const at = ms(entry.publishedAt);
      const home = stories.find(story => at - story.firstMs <= STORY_WINDOW_MS && story.list.some(member => sameStoryEntry(member, entry)));
      if (home) home.list.push(entry);
      else stories.push({ firstMs: at, list: [entry] });
    }
    for (const { list } of stories) {
      groups.push({ key: list[0]!.id, companyId, entries: list, timeUnverified: list.some(isTimeUnverified) });
    }
  }
  return groups.sort((a, b) => byTimeThenId(a.entries[0]!, b.entries[0]!) || (a.companyId < b.companyId ? -1 : a.companyId > b.companyId ? 1 : 0));
}

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
    const directional = story.entries.flatMap(entry => {
      const direction = directionAt(entry, asOfMs);
      return direction && isStatsEligible(entry, asOfMs) ? [{ entry, direction }] : [];
    });
    if (!directional.length || directional.some(item => item.direction !== directional[0]!.direction)) continue;
    const representative = directional[0]!.entry;
    const key = `${story.companyId}\u0000${directional[0]!.direction}\u0000${representative.topic}`;
    buckets.set(key, [...(buckets.get(key) ?? []), { story, representative }]);
  }
  const events: EventGroup[] = [];
  for (const items of buckets.values()) {
    items.sort((a, b) => byTimeThenId(a.representative, b.representative));
    for (let i = 0; i < items.length;) {
      const anchorMs = ms(items[i]!.representative.publishedAt);
      let end = i + 1;
      while (end < items.length && ms(items[end]!.representative.publishedAt) - anchorMs <= EVENT_WINDOW_MS) end += 1;
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
