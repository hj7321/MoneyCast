import test from 'node:test';
import assert from 'node:assert/strict';
import { companies, NEWS_CACHE_ANALYSIS_VERSION, type AiJudgement, type NewsAnalysis, type NewsArticle } from '@moneycast/core';
import {
  BACKFILL_KNOWN_DELAY_MS, entriesFromSnapshot, groupEvents, groupStories, independentCount, isStatsEligible, isTimeUnverified,
  knownAtMs, labelAt, ledgerKey, mergeLedger, selectIndependent, statsInclusion, type LedgerEntry, type LedgerLabel,
} from './history-ledger.js';
import { backfillEntry, createStoryIndex, foldLedger, mergeEntry, pickOutcome, type LedgerOutcome } from './history-ledger.js';
import type { NextDayOutcome, WeeklyOutcome } from './history-outcomes.js';
import { buildDaySample, buildWeekSample } from './history-stats.js';
import { createSnapshot } from './snapshot-store.js';

const HOUR = 3_600_000;
const company = companies[0]!;
const other = companies[1]!;
const T0 = Date.parse('2026-06-01T03:17:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const at = (hours: number) => iso(T0 + hours * HOUR);

function article(id: string, hours: number, overrides: Partial<NewsArticle> = {}): NewsArticle {
  return { id, title: id.repeat(20), topics: ['earnings'], source: `${id}.example`, publishedAt: at(hours),
    url: `https://${id}.example/a`, sentiment: 'positive', rationale: 'test', sentimentScore: 0.4, classificationMethod: 'provider',
    sourceProvider: 'marketaux', identity: 'entity_verified', ...overrides };
}
function snapshot(companyId: string, updatedHours: number, pool: NewsArticle[], promptVersion?: string) {
  const co = companies.find(item => item.id === companyId)!;
  const analysis = { company: co, status: 'insufficient', articles: pool, asOf: at(updatedHours), period: { start: '2026-06-01', end: '2026-06-05' },
    evidence: 'low', summary: 'x', positiveFactors: [], negativeFactors: [], risks: [], provider: 'Test', analysisVersion: NEWS_CACHE_ANALYSIS_VERSION,
    ...(promptVersion ? { ai: { providers: [], unrelatedCount: 0, promptVersion } } : {}) } as NewsAnalysis;
  return createSnapshot(analysis, pool, new Date(T0 + updatedHours * HOUR));
}
function label(hours: number, overrides: Partial<LedgerLabel> = {}): LedgerLabel {
  return { at: at(hours), sentiment: 'positive', score: 0.4, method: 'provider', relevance: null, consensus: null, promptVersion: null, models: [], ...overrides };
}
/** Entry as the ledger would hold it: seen two hours after publication unless said otherwise. */
function entry(id: string, hours: number, overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return { id, storyId: id, companyId: company.id, publishedAt: at(hours), timeKind: 'published', timePrecision: 'second',
    firstSeenAt: at(hours + 2), source: `${id}.example`, sourceProvider: 'marketaux', url: `https://${id}.example/a`,
    title: id.repeat(20), language: 'en', topic: 'earnings', identity: 'entity_verified',
    origin: 'forward', collection: { sort: 'published', limit: 3, languages: ['en'], fetch: 'cron' }, labels: [label(hours + 2)], ...overrides };
}
const judgement = (provider: 'gemini' | 'cloudflare', relevant: boolean): AiJudgement =>
  ({ provider, model: `${provider}-model`, relevant, sentiment: 'positive', judgedAt: at(0) });

test('entries take both clocks from the snapshot, never from the job or the article', () => {
  const snap = snapshot(company.id, 30, [
    article('a', 1), article('midnight-utc', 0, { publishedAt: '2026-06-02T00:00:00Z' }),
    article('midnight-kst', 0, { publishedAt: '2026-06-01T15:00:00.000Z' }), article('sec', 0, { publishedAt: '2026-06-02T00:00:01Z' }),
    article('seen', 2, { timeKind: 'seen' }),
  ], 'prompt-v9');
  const entries = entriesFromSnapshot(company.id, snap);
  const by = (id: string) => entries.find(item => item.id === id)!;
  assert.equal(entries.length, 5);
  for (const item of entries) {
    assert.equal(item.firstSeenAt, snap.updatedAt);
    assert.equal(item.labels[0]!.at, snap.updatedAt);
    assert.equal(item.origin, 'forward');
    assert.equal(item.storyId, item.id);
  }
  assert.equal(by('midnight-utc').timePrecision, 'day');
  assert.equal(by('midnight-kst').timePrecision, 'day');
  assert.equal(by('sec').timePrecision, 'second');
  assert.equal(by('a').timePrecision, 'second');
  assert.equal(by('seen').timeKind, 'seen');
  assert.equal(by('a').labels[0]!.promptVersion, 'prompt-v9');
  assert.equal(by('a').topic, 'earnings');
});

test('entries keep only features, label values and identity; foreign or bad snapshots add nothing', () => {
  const judged = article('j', 1, { sentiment: 'unclassified', sentimentScore: undefined, classificationMethod: 'unavailable', identity: undefined,
    aiJudgements: [judgement('gemini', true), judgement('cloudflare', true)], aiConsensus: 'withheld', description: 'must not be stored', topics: ['regulation'] });
  const [item] = entriesFromSnapshot(company.id, snapshot(company.id, 5, [judged]));
  assert.equal(item!.identity, 'name_match');
  assert.equal(item!.topic, 'regulation');
  assert.deepEqual(item!.labels[0], { at: at(5), sentiment: 'unclassified', score: null, method: 'unavailable', relevance: 'related', consensus: 'withheld',
    promptVersion: null, models: ['cloudflare:cloudflare-model', 'gemini:gemini-model'] });
  assert.equal(JSON.stringify(item).includes('must not be stored'), false);
  const unrelated = article('u', 1, { aiRelevance: 'unrelated', aiJudgements: [judgement('gemini', false), judgement('cloudflare', false)] });
  assert.equal(entriesFromSnapshot(company.id, snapshot(company.id, 5, [unrelated]))[0]!.labels[0]!.relevance, 'unrelated');
  assert.deepEqual(entriesFromSnapshot(other.id, snapshot(company.id, 5, [article('a', 1)])), []);
  assert.deepEqual(entriesFromSnapshot(company.id, snapshot(company.id, 5, [article('bad', 1, { publishedAt: 'not a date' })])), []);
  assert.equal(entriesFromSnapshot(company.id, snapshot(company.id, 5, [article('d', 1), article('d', 2)])).length, 1);
});

test('merging is keyed by company and id, never deletes, and keeps the first times and story', () => {
  const first = entry('a', 0);
  const retimed = entry('a', -50, { firstSeenAt: at(-40), storyId: 'other-story', timeKind: 'seen', title: 'rewritten' });
  const merged = mergeLedger([first, entry('b', 3)], [retimed]);
  assert.equal(merged.length, 2);
  const a = merged.find(item => item.id === 'a')!;
  assert.equal(a.publishedAt, first.publishedAt);
  assert.equal(a.firstSeenAt, first.firstSeenAt);
  assert.equal(a.storyId, 'a');
  assert.equal(a.timeKind, 'published');
  assert.equal(a.title, first.title);
  // Nothing incoming means nothing lost, and the inputs are not changed.
  assert.deepEqual(mergeLedger(merged, []).map(ledgerKey), merged.map(ledgerKey));
  assert.deepEqual(first, entry('a', 0));
  // A later publishedAt cannot replace the first one either.
  assert.equal(mergeLedger([first], [entry('a', 90)])[0]!.publishedAt, first.publishedAt);
});

test('labels are appended only when the value changes and only after the latest one', () => {
  const base = entry('a', 0, { labels: [label(2)] });
  const same = mergeLedger([base], [entry('a', 0, { labels: [label(10)] })]);
  assert.equal(same[0]!.labels.length, 1);
  const changed = mergeLedger(same, [entry('a', 0, { labels: [label(20, { sentiment: 'negative', score: -0.3 })] })]);
  assert.deepEqual(changed[0]!.labels.map(item => item.at), [at(2), at(20)]);
  // Repeating the new value later is not a change; neither is an older snapshot arriving late.
  assert.equal(mergeLedger(changed, [entry('a', 0, { labels: [label(30, { sentiment: 'negative', score: -0.3 })] })])[0]!.labels.length, 2);
  assert.equal(mergeLedger(changed, [entry('a', 0, { labels: [label(5, { sentiment: 'neutral', score: 0 })] })])[0]!.labels.length, 2);
  // A different model set or prompt version is a different value.
  const reread = mergeLedger(changed, [entry('a', 0, { labels: [label(40, { sentiment: 'negative', score: -0.3, promptVersion: 'v2' })] })]);
  assert.equal(reread[0]!.labels.length, 3);
  assert.equal(base.labels.length, 1);
});

test('a snapshot pass records first sightings once and the label history by time', () => {
  const day1 = entriesFromSnapshot(company.id, snapshot(company.id, 10, [article('a', 1), article('b', 2)]));
  const day2 = entriesFromSnapshot(company.id, snapshot(company.id, 34, [article('a', 1, { sentiment: 'negative', sentimentScore: -0.5 }), article('b', 2), article('c', 30)]));
  const ledger = mergeLedger(mergeLedger([], day1), day2);
  assert.equal(ledger.length, 3);
  const a = ledger.find(item => item.id === 'a')!;
  assert.equal(a.firstSeenAt, at(10));
  assert.equal(ledger.find(item => item.id === 'c')!.firstSeenAt, at(34));
  assert.equal(ledger.find(item => item.id === 'b')!.labels.length, 1);
  assert.equal(labelAt(a, T0 + 9 * HOUR), null);
  assert.equal(labelAt(a, T0 + 10 * HOUR)!.sentiment, 'positive');
  assert.equal(labelAt(a, T0 + 33.9 * HOUR)!.sentiment, 'positive');
  assert.equal(labelAt(a, T0 + 34 * HOUR)!.sentiment, 'negative');
  assert.equal(labelAt(a, T0 + 1000 * HOUR)!.score, -0.5);
});

test('the same article in two companies keeps each company its own labels', () => {
  const shared = article('shared', 1);
  const pass1 = [
    ...entriesFromSnapshot(company.id, snapshot(company.id, 10, [shared])),
    ...entriesFromSnapshot(other.id, snapshot(other.id, 10, [{ ...shared, sentiment: 'negative', sentimentScore: -0.6 }])),
  ];
  const pass2 = entriesFromSnapshot(company.id, snapshot(company.id, 40, [{ ...shared, sentiment: 'neutral', sentimentScore: 0 }]));
  const ledger = mergeLedger(mergeLedger([], pass1), pass2);
  assert.equal(ledger.length, 2);
  const mine = ledger.find(item => item.companyId === company.id)!;
  const theirs = ledger.find(item => item.companyId === other.id)!;
  assert.deepEqual(mine.labels.map(item => item.sentiment), ['positive', 'neutral']);
  assert.deepEqual(theirs.labels.map(item => item.sentiment), ['negative']);
  assert.equal(labelAt(theirs, T0 + 100 * HOUR)!.score, -0.6);
  assert.equal(groupStories(ledger, T0 + 100 * HOUR).length, 2);
});

test('a backfill entry is known a day after publication and flagged until a real sighting arrives', () => {
  const backfill = entry('old', -400, { origin: 'backfill', firstSeenAt: null, labels: [label(-376)] });
  assert.equal(isTimeUnverified(backfill), true);
  assert.equal(knownAtMs(backfill), T0 - 400 * HOUR + BACKFILL_KNOWN_DELAY_MS);
  assert.equal(groupStories([backfill], T0 - 377 * HOUR).length, 0);
  assert.equal(groupStories([backfill], T0 - 376 * HOUR)[0]!.timeUnverified, true);
  assert.equal(groupStories([entry('new', 0)], T0 + 2 * HOUR)[0]!.timeUnverified, false);
  const seen = mergeLedger([backfill], [entry('old', -400, { firstSeenAt: at(-399) })])[0]!;
  assert.equal(seen.firstSeenAt, at(-399));
  assert.equal(seen.origin, 'backfill');
  assert.equal(mergeLedger([seen], [entry('old', -400, { firstSeenAt: at(-100) })])[0]!.firstSeenAt, at(-399));
});

test('a story needs a matching URL or title and at most 48 hours between the copies', () => {
  const base = entry('a', 0, { url: 'https://www.news.example/world/story?id=7', title: 'Samsung posts record profit' });
  const tracked = entry('b', 3, { url: 'https://news.example/world/story/?utm_source=x&id=7&fbclid=abc', title: 'Something else entirely about weather' });
  const tail = entry('c', 5, { url: 'https://mirror.example/x', title: 'Samsung posts record profit - Reuters' });
  const similar = entry('d', 6, { url: 'https://mirror2.example/y', title: 'Samsung posts record profits' });
  const unrelated = entry('e', 7, { url: 'https://third.example/z', title: 'Hyundai opens a new plant in Georgia' });
  const stories = groupStories([base, tracked, tail, similar, unrelated], T0 + 100 * HOUR);
  assert.equal(stories.length, 2);
  const big = stories.find(item => item.entries.length === 4)!;
  assert.deepEqual(big.entries.map(item => item.id), ['a', 'b', 'c', 'd']);
  assert.equal(big.key, 'a');
  // The window is inclusive at 48 hours.
  const edge = [entry('x', 0, { title: 'Same headline today' }), entry('y', 48, { title: 'Same headline today' })];
  assert.equal(groupStories(edge, T0 + 100 * HOUR).length, 1);
  assert.equal(groupStories([edge[0]!, entry('y', 48.1, { title: 'Same headline today' })], T0 + 100 * HOUR).length, 2);
});

test('the same title or URL months apart stays two stories', () => {
  const march = entry('m', 0, { title: 'Why Nvidia Stock Is Moving Today', url: 'https://fool.example/nvda-today' });
  const august = entry('n', 24 * 150, { title: 'Why Nvidia Stock Is Moving Today', url: 'https://fool.example/nvda-today' });
  assert.equal(groupStories([march, august], T0 + 24 * 200 * HOUR).length, 2);
  assert.equal(mergeLedger([march], [august])[0]!.storyId, 'm');
  assert.equal(mergeLedger([march], [august])[1]!.storyId, 'n');
});

test('a headline repeated every 30 hours never chains past 48 hours into one story', () => {
  const daily = [0, 30, 60, 90].map((hours, i) => entry(`d${i}`, hours, { title: 'Why Nvidia Stock Is Moving Today', url: `https://fool.example/nvda-${i}` }));
  const stories = groupStories(daily, T0 + 200 * HOUR);
  assert.deepEqual(stories.map(item => item.entries.map(member => member.id)), [['d0', 'd1'], ['d2', 'd3']]);
  for (const story of stories) {
    const times = story.entries.map(member => Date.parse(member.publishedAt));
    assert.ok(Math.max(...times) - Math.min(...times) <= 48 * HOUR);
  }
  // The stored story follows the same bound.
  const stored = daily.reduce<LedgerEntry[]>((ledger, item) => mergeLedger(ledger, [item]), []);
  assert.deepEqual(stored.map(item => item.storyId), ['d0', 'd0', 'd2', 'd2']);
});

test('a new entry joins the story of the earliest matching entry; the stored storyId is not used for replay', () => {
  const first = entry('a', 0, { title: 'Chipmaker wins big order' });
  const copy = entry('b', 10, { title: 'Chipmaker wins big order', url: 'https://copy.example/b' });
  const ledger = mergeLedger([first], [copy]);
  assert.equal(ledger[1]!.storyId, 'a');
  // The copy is unknown before it was seen, so at that time the story has one member.
  assert.deepEqual(groupStories(ledger, T0 + 5 * HOUR).map(item => item.entries.length), [1]);
  assert.deepEqual(groupStories(ledger, T0 + 20 * HOUR).map(item => item.entries.length), [2]);
});

test('events use a 72-hour window from the anchor and do not chain', () => {
  const entries = [entry('a', 0), entry('b', 60), entry('c', 72), entry('d', 120), entry('e', 130)];
  const events = groupEvents(entries, T0 + 500 * HOUR);
  assert.deepEqual(events.map(event => event.members.map(item => item.id)), [['a', 'b', 'c'], ['d', 'e']]);
  assert.deepEqual(events.map(event => event.anchorId), ['a', 'd']);
  assert.equal(events[0]!.anchorMs, T0);
  // 60 -> 120 is within 72 hours, but 120 is 120 hours after the anchor.
  assert.equal(groupEvents([entry('a', 0), entry('b', 60), entry('c', 120)], T0 + 500 * HOUR).length, 2);
  assert.equal(groupEvents([entry('a', 0), entry('b', 72.1)], T0 + 500 * HOUR).length, 2);
});

test('mixed directions, topics and companies make separate events; neutral and unclassified make none', () => {
  const entries = [
    entry('up', 0), entry('down', 1, { labels: [label(3, { sentiment: 'negative', score: -0.5 })] }),
    entry('product', 2, { topic: 'product' }),
    entry('theirs', 3, { companyId: other.id }),
    entry('flat', 4, { labels: [label(6, { sentiment: 'neutral', score: 0 })] }),
    entry('none', 5, { labels: [label(7, { sentiment: 'unclassified', score: null, method: 'unavailable' })] }),
  ];
  const events = groupEvents(entries, T0 + 100 * HOUR);
  assert.equal(events.length, 4);
  assert.deepEqual(events.map(event => `${event.companyId}/${event.direction}/${event.topic}`).sort(), [
    `${company.id}/negative/earnings`, `${company.id}/positive/earnings`, `${company.id}/positive/product`, `${other.id}/positive/earnings`].sort());
});

test('copies of one story count once and conflicting copies leave the story out', () => {
  const a = entry('a', 0, { title: 'Chipmaker wins big order' });
  const copy = entry('b', 1, { title: 'Chipmaker wins big order', url: 'https://copy.example/b' });
  const events = groupEvents([a, copy], T0 + 100 * HOUR);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]!.members.map(item => item.id), ['a']);
  const conflicting = entry('b', 1, { title: 'Chipmaker wins big order', url: 'https://copy.example/b', labels: [label(3, { sentiment: 'negative' })] });
  assert.deepEqual(groupEvents([a, conflicting], T0 + 100 * HOUR), []);
  // The earliest eligible copy represents the story, so an unrelated first copy is skipped.
  const unrelatedFirst = entry('a', 0, { title: 'Chipmaker wins big order', labels: [label(2, { relevance: 'unrelated' })] });
  assert.deepEqual(groupEvents([unrelatedFirst, copy], T0 + 100 * HOUR)[0]!.members.map(item => item.id), ['b']);
});

test('an earlier article collected late does not change the result for an earlier asOf', () => {
  const known = [entry('a', 10), entry('b', 80)];
  const late = entry('z', 0, { firstSeenAt: at(100), labels: [label(100)] });
  const asOf = T0 + 95 * HOUR;
  assert.deepEqual(groupEvents([...known, late], asOf), groupEvents(known, asOf));
  assert.deepEqual(groupStories([...known, late], asOf), groupStories(known, asOf));
  assert.deepEqual(groupEvents(known, asOf).map(event => event.members.map(item => item.id)), [['a', 'b']]);
  // Once it is known, the earlier article becomes the anchor and the later one falls out of its window.
  const after = groupEvents([...known, late], T0 + 120 * HOUR);
  assert.equal(after[0]!.anchorId, 'z');
  assert.deepEqual(after[0]!.members.map(item => item.id), ['z', 'a']);
  assert.deepEqual(after[1]!.members.map(item => item.id), ['b']);
});

test('label history decides the direction and eligibility at each time', () => {
  const flipped = entry('a', 0, { labels: [label(2), label(30, { sentiment: 'negative', score: -0.4 }), label(60, { sentiment: 'neutral', score: 0 })] });
  assert.equal(groupEvents([flipped], T0 + 1 * HOUR).length, 0);
  assert.equal(groupEvents([flipped], T0 + 10 * HOUR)[0]!.direction, 'positive');
  assert.equal(groupEvents([flipped], T0 + 40 * HOUR)[0]!.direction, 'negative');
  assert.equal(groupEvents([flipped], T0 + 70 * HOUR).length, 0);
});

test('a scored article later judged unrelated counts before and not after', () => {
  const later = entry('a', 0, { labels: [label(2), label(50, { relevance: 'unrelated', consensus: null, models: ['cloudflare:m', 'gemini:m'] })] });
  assert.equal(statsInclusion(later, T0 + 10 * HOUR), 'included_verified');
  assert.equal(groupEvents([later], T0 + 10 * HOUR).length, 1);
  assert.equal(statsInclusion(later, T0 + 50 * HOUR), 'excluded_unrelated');
  assert.equal(groupEvents([later], T0 + 60 * HOUR).length, 0);
  // The provider score is still the latest sentiment; only relevance removes it.
  assert.equal(labelAt(later, T0 + 60 * HOUR)!.sentiment, 'positive');
});

test('title-only matches count only when two models agreed the article is relevant', () => {
  const name = (labels: LedgerLabel[]) => entry('n', 0, { identity: 'name_match', labels });
  assert.equal(statsInclusion(name([label(2)]), T0 + 10 * HOUR), 'excluded_name_match');
  assert.equal(statsInclusion(name([label(2), label(4, { relevance: 'related', models: ['cloudflare:m', 'gemini:m'] })]), T0 + 3 * HOUR), 'excluded_name_match');
  const agreed = name([label(2), label(4, { relevance: 'related', models: ['cloudflare:m', 'gemini:m'] })]);
  assert.equal(statsInclusion(agreed, T0 + 10 * HOUR), 'included_name_match');
  assert.equal(isStatsEligible(agreed, T0 + 10 * HOUR), true);
  assert.equal(groupEvents([agreed], T0 + 10 * HOUR)[0]!.nameMatch, true);
  assert.equal(groupEvents([entry('v', 0)], T0 + 10 * HOUR)[0]!.nameMatch, false);
  assert.equal(statsInclusion(name([label(2, { relevance: 'unrelated' })]), T0 + 10 * HOUR), 'excluded_unrelated');
  assert.equal(groupEvents([name([label(2)])], T0 + 10 * HOUR).length, 0);
});

test('backfill members mark the event as time-unverified', () => {
  const events = groupEvents([entry('a', 0), entry('b', 5, { origin: 'backfill', firstSeenAt: null, labels: [label(-100)] })], T0 + 200 * HOUR);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.timeUnverified, true);
  assert.equal(groupEvents([entry('a', 0)], T0 + 200 * HOUR)[0]!.timeUnverified, false);
});

test('n_eff counts greedily the windows that enter no earlier than the previous kept exit', () => {
  const w = (entryHours: number, exitHours: number) => ({ entryMs: T0 + entryHours * HOUR, exitMs: T0 + exitHours * HOUR });
  assert.equal(independentCount([]), 0);
  assert.equal(independentCount([w(0, 120)]), 1);
  // Overlapping windows: only the first and the one entering at or after its exit count.
  assert.equal(independentCount([w(0, 120), w(24, 144), w(72, 192), w(120, 240), w(130, 250)]), 2);
  assert.equal(independentCount([w(0, 120), w(119.9, 240)]), 1);
  assert.equal(independentCount([w(0, 120), w(120, 240), w(240, 360)]), 3);
  // Order of input does not matter, and malformed windows are ignored.
  const shuffled = [w(120, 240), w(0, 120), w(60, 180), { entryMs: Number.NaN, exitMs: T0 }, w(50, 10)];
  assert.equal(independentCount(shuffled), 2);
  assert.deepEqual(selectIndependent([w(240, 360), w(0, 120), w(60, 180)]).map(item => item.entryMs), [T0, T0 + 240 * HOUR]);
});

// --- Step 4: frozen outcomes, segment folding, backfill entries, story index ---------------

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function outcome(overrides: Partial<LedgerOutcome> = {}): LedgerOutcome {
  return {
    entryType: 'close_no_open', entryDate: '2026-06-01', exitDate: '2026-06-08', entryAt: '2026-06-01T20:00:00.000Z',
    exitAt: '2026-06-08T20:00:00.000Z', sessions: ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05', '2026-06-08'],
    basis: 'raw', r: 0.001, benchmarkR: 0.002, relative: -0.001, sigma: 0.01, band: 0.005, label: 'neutral',
    flags: ['no_open', 'unadjusted', 'benchmark_chained'], priceBasisVersion: 'fsc-raw-v1/outcomes-v1', frozenAt: at(200), ...overrides,
  };
}

test('LedgerOutcome uses the outcome names (neutral, close_no_open) and survives a merge, a fold and JSON', () => {
  const frozen = outcome();
  const merged = mergeLedger([entry('a', 0)], [entry('a', 0, { outcome: frozen })])[0]!;
  assert.deepEqual(merged.outcome, frozen);
  const folded = foldLedger([[entry('a', 0)], [{ ...merged }]])[0]!;
  assert.deepEqual(JSON.parse(JSON.stringify(folded)).outcome, frozen);
  assert.equal(folded.outcome!.label, 'neutral');
  assert.equal(folded.outcome!.entryType, 'close_no_open');
  // A null label (insufficient volatility history) is a valid frozen outcome too.
  assert.equal(mergeLedger([entry('b', 0)], [entry('b', 0, { outcome: outcome({ label: null, sigma: null, band: null }) })])[0]!.outcome!.label, null);
});

test('pickOutcome: the same version keeps the first frozen outcome, a new version replaces only when frozen later', () => {
  const first = outcome({ r: 0.01, frozenAt: at(100) });
  const later = outcome({ r: 0.02, frozenAt: at(150) });
  assert.equal(pickOutcome(undefined, first), first);
  assert.equal(pickOutcome(first, undefined), first);
  assert.equal(pickOutcome(first, later), first);
  assert.equal(pickOutcome(later, first), later);
  const rebased = outcome({ r: 0.03, priceBasisVersion: 'fsc-raw-v2/outcomes-v1', frozenAt: at(300) });
  assert.equal(pickOutcome(first, rebased), rebased);
  // A record of another version that was frozen earlier (a replayed older file) does not win.
  assert.equal(pickOutcome(rebased, first), rebased);
  assert.equal(pickOutcome(first, outcome({ priceBasisVersion: 'x/outcomes-v2', frozenAt: at(100) })), first);
  // Through mergeEntry: nothing else of the entry changes, and an unchanged merge keeps identity.
  const stored = entry('a', 0, { outcome: first });
  assert.equal(mergeEntry(stored, entry('a', 0, { outcome: later })), stored);
  const replaced = mergeEntry(stored, entry('a', 0, { outcome: rebased }));
  assert.equal(replaced.outcome, rebased);
  assert.deepEqual({ ...replaced, outcome: undefined }, { ...stored, outcome: undefined });
});

test('foldLedger: segments fold in order like sequential mergeEntry, storyId stays and inputs are untouched', () => {
  const january = [entry('a', 0, { storyId: 'story-x' }), entry('b', 1), entry('c', 2, { companyId: other.id })];
  const patchA = { ...january[0]!, labels: [...january[0]!.labels, label(30, { sentiment: 'negative' })], storyId: 'ignored' };
  const february = [patchA, entry('d', 40), { ...january[1]!, outcome: outcome() }];
  const march = [entry('a', 0, { labels: [label(10, { sentiment: 'neutral' })] }), entry('e', 41, { url: 'https://d.example/a' })];
  const before = structuredClone([january, february, march]);
  const folded = foldLedger([january, february, march]);
  assert.deepEqual([january, february, march], before);
  assert.deepEqual(folded.map(ledgerKey), [january[0]!, january[1]!, january[2]!, february[1]!, march[1]!].map(ledgerKey));
  const a = folded[0]!;
  assert.equal(a.storyId, 'story-x');
  assert.deepEqual(a.labels.map(item => item.sentiment), ['positive', 'negative']);
  assert.deepEqual(folded[1]!.outcome, outcome());
  // The fold never regroups: e keeps its own stored storyId even though its URL matches d.
  assert.equal(folded[4]!.storyId, 'e');
  // Equal to applying mergeEntry key by key.
  const manual = new Map<string, LedgerEntry>();
  for (const item of [...january, ...february, ...march]) {
    const key = ledgerKey(item);
    manual.set(key, manual.has(key) ? mergeEntry(manual.get(key)!, item) : structuredClone(item));
  }
  assert.deepEqual(folded, [...manual.values()]);
  // Shallow copies, not the stored objects: a merge builds new label arrays instead of pushing.
  assert.notEqual(folded[3], february[1]);
  assert.notEqual(folded[0]!.labels, january[0]!.labels);
  assert.equal(january[0]!.labels.length, 1);
  assert.deepEqual(foldLedger([]), []);
});

test('backfillEntry: no first sighting, one label dated publication + 24 hours, known from then', () => {
  const published = '2025-03-04T05:06:07.000Z';
  const collection = { sort: 'datedesc', limit: 250, languages: ['en'], fetch: 'gdelt:doc/artlist' };
  const item = backfillEntry({ companyId: company.id, article: article('old', 0, { publishedAt: published, identity: undefined }), collection })!;
  assert.equal(item.origin, 'backfill');
  assert.equal(item.firstSeenAt, null);
  assert.equal(item.storyId, item.id);
  assert.equal(item.identity, 'name_match');
  assert.equal(item.timePrecision, 'second');
  assert.equal(item.labels.length, 1);
  assert.equal(item.labels[0]!.at, iso(Date.parse(published) + BACKFILL_KNOWN_DELAY_MS));
  assert.equal(item.labels[0]!.promptVersion, null);
  assert.equal(knownAtMs(item), Date.parse(published) + 24 * HOUR);
  assert.equal(isTimeUnverified(item), true);
  assert.notEqual(item.collection, collection);
  assert.deepEqual(item.collection, collection);
  assert.equal(backfillEntry({ companyId: company.id, article: article('bad', 0, { publishedAt: 'not a date' }), collection }), null);
  assert.equal(backfillEntry({ companyId: company.id, article: article('day', 0, { publishedAt: '2025-03-04T00:00:00Z' }), collection })!.timePrecision, 'day');
});

test('backfill entries are invisible to a week asOf 12 hours after publication; the day sample uses publication time', () => {
  const asOf = Date.parse('2026-06-07T23:50:00Z');
  const make = (id: string, published: string) => backfillEntry({
    companyId: company.id, article: article(id, 0, { publishedAt: published }),
    collection: { sort: 'datedesc', limit: 250, languages: [], fetch: 'gdelt:doc/artlist' },
  })!;
  const weekOutcome = (weekAsOfMs: number): WeeklyOutcome => ({
    status: 'complete', reason: null, entryType: 'open', entryDate: '2026-06-08', exitDate: '2026-06-12', entryAtMs: asOf + HOUR,
    exitAtMs: asOf + 5 * 24 * HOUR, sessions: [], basis: 'raw', r: 0.02, benchmarkR: 0, relative: 0.02, sigma: 0.01, band: 0.005,
    label: 'up', flags: [], weekAsOfMs,
  });
  const week = (entries: LedgerEntry[]) => buildWeekSample({
    exchange: 'NASDAQ', companyId: company.id, direction: 'positive', entries, nowMs: asOf + 10 * 24 * HOUR,
    observation: { fromMs: asOf - 7 * 24 * HOUR - HOUR }, outcome: weekOutcome, toMs: asOf,
  }).units;
  const late = week([make('half-day', '2026-06-07T11:50:00Z')]);
  assert.deepEqual(late.map(unit => [unit.group, unit.timeUnverified]), [['other', false]]);
  const known = week([make('day-old', '2026-06-06T20:00:00Z')]);
  assert.deepEqual(known.map(unit => [unit.group, unit.timeUnverified]), [['event', true]]);
  // Day sample: Mon 22:00 ET is overnight before Tue 2026-06-02's open, 11.5 hours later.
  const dayOutcome = (date: string): NextDayOutcome => ({
    status: 'complete', reason: null, entryType: 'close', entryDate: date, exitDate: date, entryAtMs: Date.parse(`${date}T00:00:00Z`),
    exitAtMs: Date.parse(`${date}T20:00:00Z`), sessions: [], basis: 'raw', r: 0.01, benchmarkR: 0, relative: 0.01, sigma: 0.01,
    band: 0.002, label: 'up', flags: [], intraday: null, benchmarkIntraday: null, relativeIntraday: null,
  });
  const days = buildDaySample({
    exchange: 'NASDAQ', companyId: company.id, direction: 'positive', entries: [make('overnight', '2026-06-02T02:00:00Z')],
    nowMs: Date.parse('2026-06-03T00:00:00Z'), observation: { fromMs: Date.parse('2026-06-01T00:00:00Z') }, outcome: dayOutcome,
  });
  const tuesday = days.units.find(unit => unit.key === '2026-06-02')!;
  assert.deepEqual([tuesday.group, tuesday.timeUnverified], ['event', true]);
});

/** Random ledger: two companies, late sightings, backfill, daily recurring titles, URL copies and similar titles. */
function randomLedger(seed: number, count: number): LedgerEntry[] {
  const next = seeded(seed);
  const items: LedgerEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const hours = Math.floor(next() * 24 * 25);
    const overrides: Partial<LedgerEntry> = { companyId: next() < 0.6 ? company.id : other.id };
    const kind = next();
    const source = items.length ? items[Math.floor(next() * items.length)]! : null;
    if (source && kind < 0.2) overrides.url = source.url;
    else if (kind < 0.35) overrides.title = `Why ${overrides.companyId} stock is moving today`;
    else if (source && kind < 0.5) overrides.title = `${source.title} - Wire`;
    else if (source && kind < 0.6) overrides.title = `${source.title.slice(0, -2)}zz`;
    const seen = next();
    if (seen < 0.1) { overrides.firstSeenAt = null; overrides.origin = 'backfill'; }
    else overrides.firstSeenAt = at(hours + Math.floor(seen * 40));
    items.push(entry(`e${i}`, next() < 0.1 && source ? (Date.parse(source.publishedAt) - T0) / HOUR : hours, overrides));
  }
  return items;
}

test('createStoryIndex equals groupStories after every advance (seeded property test)', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const items = randomLedger(seed, 260);
    const index = createStoryIndex(items);
    const next = seeded(seed * 97);
    let checks = 0;
    for (let asOf = T0 - 20 * HOUR; asOf < T0 + 26 * 24 * HOUR + 60 * HOUR; asOf += Math.floor(1 + next() * 30) * HOUR) {
      index.advance(asOf);
      const expected = groupStories(items, asOf);
      assert.deepStrictEqual(index.stories(), expected, `seed ${seed} at ${iso(asOf)}`);
      for (const group of expected) for (const member of group.entries) assert.deepStrictEqual(index.storyOf(member), group);
      checks += 1;
    }
    // The same asOf twice is fine; going back is not.
    index.advance(T0 + 40 * 24 * HOUR);
    index.advance(T0 + 40 * 24 * HOUR);
    assert.deepStrictEqual(index.stories(), groupStories(items, T0 + 40 * 24 * HOUR));
    assert.throws(() => index.advance(T0), RangeError);
    assert.ok(checks > 20);
  }
  // Not yet known: no story.
  const late = entry('late', 0, { firstSeenAt: at(100) });
  const index = createStoryIndex([late]);
  index.advance(T0 + 50 * HOUR);
  assert.equal(index.storyOf(late), undefined);
  assert.deepEqual(index.stories(), []);
});

/** A large ledger: `perCompany` entries per company over two years, one every ~105 minutes per company. */
function largeLedger(companyIds: readonly string[], perCompany: number): LedgerEntry[] {
  const next = seeded(7);
  const items: LedgerEntry[] = [];
  for (const companyId of companyIds) {
    for (let i = 0; i < perCompany; i += 1) {
      const hours = i * 1.75 + next();
      items.push(entry(`${companyId}-${i}`, hours, { companyId, title: `${companyId} headline ${i} ${Math.floor(next() * 1e6)}`,
        url: `https://news.example/${companyId}/${i}` }));
    }
  }
  return items;
}

test('benchmark: merging 240 incoming entries into 40,000 takes under 500 ms', t => {
  const ids = companies.slice(0, 8).map(item => item.id);
  const existing = largeLedger(ids, 5_000);
  const incoming: LedgerEntry[] = [];
  for (let i = 0; i < 240; i += 1) {
    const companyId = ids[i % ids.length]!;
    const n = 4_900 + Math.floor(i / ids.length);
    if (i % 2 === 0) incoming.push(entry(`${companyId}-${n}`, n * 1.75, { companyId, labels: [label(n * 1.75 + 30, { sentiment: 'negative' })] }));
    else incoming.push(entry(`${companyId}-copy-${i}`, n * 1.75 + 1, { companyId, url: `https://news.example/${companyId}/${n}` }));
  }
  const started = performance.now();
  const merged = mergeLedger(existing, incoming);
  const elapsed = performance.now() - started;
  assert.equal(merged.length, 40_000 + 120);
  assert.ok(merged.slice(40_000).every(item => item.storyId.includes('-') && !item.storyId.includes('copy')));
  t.diagnostic(`mergeLedger ${elapsed.toFixed(1)} ms`);
  assert.ok(elapsed < 500, `${elapsed.toFixed(0)} ms`);
});

test('benchmark: folding 40,000 entries in 20 segments takes under 300 ms', t => {
  const all = largeLedger(companies.slice(0, 8).map(item => item.id), 5_000);
  const segments: LedgerEntry[][] = [];
  for (let s = 0; s < 20; s += 1) {
    const segment = all.slice(s * 2_000, (s + 1) * 2_000);
    // Each later segment also patches 100 entries of the previous one.
    if (s > 0) {
      for (const old of all.slice((s - 1) * 2_000, (s - 1) * 2_000 + 100)) {
        segment.push({ ...old, labels: [...old.labels, label(Date.parse(old.publishedAt) / HOUR - T0 / HOUR + 50, { sentiment: 'negative' })] });
      }
    }
    segments.push(segment);
  }
  const started = performance.now();
  const folded = foldLedger(segments);
  const elapsed = performance.now() - started;
  assert.equal(folded.length, 40_000);
  assert.equal(folded[0]!.labels.length, 2);
  t.diagnostic(`foldLedger ${elapsed.toFixed(1)} ms`);
  assert.ok(elapsed < 300, `${elapsed.toFixed(0)} ms`);
});
