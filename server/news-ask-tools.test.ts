import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASK_TERM_IDS, ASK_TERMS, BACKFILL_SAMPLE_NOTE, EXPIRED_STATS_MESSAGE, GDELT_CREDIT, HISTORY_DISCLAIMER, MARKETAUX_TOP_NOTE,
  NEWS_HISTORY_VERSION, NEWS_TOPIC_KEYS, STATS_NOT_PUBLIC_MESSAGE, companies, parseCompanyHistory,
  type CaseStats, type CompanyHistory, type DirectionStats, type Horizon, type NewsAnalysis, type NewsArticle, type Verdict,
} from '@moneycast/core';
import { buildCompanyHistory, parsePublicMarkets } from './history-serve.js';
import type { CompanyStats } from './history-stats.js';
import {
  ASK_DEFAULT_TOOL_ARGS, ASK_TOOL_NAMES, createFactTable, kstYear, parseToolCall, readyHistory, runAskTool,
  type AskToolArgs, type AskToolContext, type AskToolName, type AskToolResult, type FactTable,
} from './news-ask-tools.js';

// Friday 19:00 KST: KRX closed at 15:30, so the day horizon is Monday 11-30 and its overnight window opened at 06:30Z.
const NOW = Date.parse('2026-11-27T10:00:00Z');
const DAY_MS = 86_400_000;
const COMPANY = companies.find(item => item.id === 'krx:005930')!;

function article(n: number, extra: Partial<NewsArticle>): NewsArticle {
  return {
    id: `a${n}`, title: `삼성전자 기사 ${n}`, source: '연합뉴스', publishedAt: '2026-11-25T00:00:00.000Z', url: `https://news.example/a${n}`,
    sentiment: 'neutral', rationale: '근거', ...extra,
  };
}

/** A1 and A5 fall in the overnight window (A5 unclassified), A4 is unrelated; titles and one source carry digits. */
const ARTICLES: readonly NewsArticle[] = [
  article(1, { title: '삼성전자, 3분기 영업이익 12조 원 기록', sentiment: 'positive', publishedAt: '2026-11-27T08:00:00.000Z', topics: ['earnings'] }),
  article(2, { title: 'Samsung faces 2nd EU probe over chips', source: 'Reuters', sentiment: 'negative', publishedAt: '2026-11-26T02:00:00.000Z', topics: ['regulation'] }),
  article(3, { title: '삼성전자 신제품 공개', source: '전자신문', publishedAt: '2026-11-25T05:00:00.000Z', topics: ['product'] }),
  article(4, { title: '삼성 라이온즈 우승', source: '스포츠24', sentiment: 'positive', publishedAt: '2026-11-27T07:30:00.000Z', aiRelevance: 'unrelated', topics: ['other'] }),
  article(5, { title: 'Samsung Electronics shares in focus', source: '뉴스1', sentiment: 'unclassified', publishedAt: '2026-11-27T07:00:00.000Z', timeKind: 'seen', sourceProvider: 'gdelt' }),
];

function analysisOf(extra: Partial<NewsAnalysis> = {}): NewsAnalysis {
  return {
    company: COMPANY, status: 'ready', articles: ARTICLES.map(item => ({ ...item })), asOf: '2026-11-27T09:30:00.000Z',
    period: { start: '2026-11-30', end: '2026-12-04' }, evidence: 'moderate', summary: '최근 7일 관련 기사 4건 가운데 긍정 1건',
    positiveFactors: ['실적 개선 기사'], negativeFactors: [], risks: ['변동성'], provider: 'Marketaux', analysisVersion: 'news-evidence-v3',
    newsWindow: { start: '2026-11-20T09:30:00.000Z', end: '2026-11-27T09:30:00.000Z' }, cachedUntil: '2026-11-27T15:30:00.000Z', servedFrom: 'live',
    sources: [{ id: 'marketaux', label: 'Marketaux', status: 'ok', articleCount: 3 }, { id: 'gdelt', label: 'GDELT', status: 'ok', articleCount: 1 }],
    ...extra,
  };
}

// Statistics whose display text occurs nowhere else in these fixtures.
function caseStats(extra: Partial<CaseStats> = {}): CaseStats {
  return {
    cases: 37, nEff: 29, up: 19, neutral: 6, down: 12,
    returns: { median: 0.0437, q1: -0.0123, q3: 0.0789, min: -0.0912, max: 0.1534, relativeMedian: 0.0211 },
    period: { from: '2024-03-04', to: '2026-11-20' }, entryType: 'close', allWindows: { up: 0.587, down: 0.333 }, ...extra,
  };
}

function direction(unit: Horizon, verdict: Verdict): DirectionStats {
  return {
    verdict,
    sample: {
      unit, eventUnits: 26, otherUnits: 113, eventUp: 15, eventDown: 8, eventNeutral: 3, otherUp: 50, otherDown: 52, otherNeutral: 11,
      difference: 0.1432, ci90: [0.0218, 0.2645], from: '2024-03-04', to: '2026-11-20',
    },
    all: caseStats(),
    topics: [{ topic: 'earnings', cases: caseStats({ cases: 13, nEff: 11, up: 7, neutral: 2, down: 4 }) }],
    examples: [
      { date: '2026-10-01', source: 'Example Wire', url: 'https://cases.example/1', title: '삼성전자 사례 기사', entryDate: '2026-10-02', exitDate: '2026-10-09', r: 0.0351, relative: 0.0117 },
      { date: '2026-09-15', source: 'Example Wire', url: 'https://cases.example/2', entryDate: '2026-09-16', exitDate: '2026-09-23', r: -0.0264, relative: null },
    ],
  };
}

function companyStats(extra: Partial<CompanyStats> = {}): CompanyStats {
  return {
    version: NEWS_HISTORY_VERSION, companyId: COMPANY.id, exchange: 'KRX', status: 'ready',
    horizons: {
      day: { directions: { positive: direction('day', 'supports'), negative: direction('day', 'weakens') }, timeUnverifiedUnits: 0 },
      week: { directions: { positive: direction('week', 'contradicts'), negative: direction('week', 'no_clear_difference') }, timeUnverifiedUnits: 3 },
    },
    coverage: { articles: 4321, events: 876, usable: 98, excluded: { week_overlap: 7 }, observationGaps: 2 },
    dataAsOf: { computedAt: '2026-11-27T06:31:00.000Z', lastPriceDate: '2026-11-24', ledgerFrom: '2024-03-04T00:00:00.000Z', ledgerTo: '2026-11-27T05:00:00.000Z' },
    sources: { news: ['Marketaux', 'GDELT'], price: { label: '금융위원회 주식시세', adjustment: 'raw' } },
    ...extra,
  };
}

/** Strings only the public statistics produce, from stats.json's numbers, dates, sources and links. */
const SENTINELS = [
  '+4.4%', '-1.2%', '+7.9%', '+2.1%', '+14.3%p', '+2.2%p', '+26.5%p', '37건', '29개', '51%', '59%', '33%', '4321', '876', '2024-03-04',
  '2026-11-24', '15:31', '금융위원회', 'Example Wire', 'cases.example', '+3.5%', '-2.6%',
];

const publicHistory = (stats = companyStats()) =>
  buildCompanyHistory({ company: COMPANY, exchange: 'KRX', nowMs: NOW, publicMarkets: parsePublicMarkets('KR'), stats });
const privateHistory = () =>
  buildCompanyHistory({ company: COMPANY, exchange: 'KRX', nowMs: NOW, publicMarkets: parsePublicMarkets(''), stats: companyStats() });
const OFF: CompanyHistory = { version: NEWS_HISTORY_VERSION, companyId: COMPANY.id, status: 'off' };
const UNAVAILABLE: CompanyHistory = { version: NEWS_HISTORY_VERSION, companyId: COMPANY.id, status: 'unavailable' };

function contextOf(history: CompanyHistory, analysis = analysisOf(), facts: FactTable = createFactTable()): AskToolContext {
  return { company: COMPANY, analysis, history, nowMs: NOW, facts, refs: new Map() };
}

const args = (extra: Partial<AskToolArgs> = {}): AskToolArgs => ({ ...ASK_DEFAULT_TOOL_ARGS, ...extra });
const run = (ctx: AskToolContext, tool: AskToolName, extra: Partial<AskToolArgs> = {}) => runAskTool(tool, args(extra), ctx);
const runAll = (ctx: AskToolContext): AskToolResult[] =>
  ASK_TOOL_NAMES.map(tool => run(ctx, tool, tool === 'explain_term' ? { term: 'market_relative' } : {}));

/** The value behind a fact reference in a result. */
function value(ctx: AskToolContext, ref: unknown): string | undefined {
  const id = (ref as { id?: unknown } | undefined)?.id;
  return typeof id === 'string' ? ctx.facts.get(id)?.value : undefined;
}

function factValues(ctx: AskToolContext): string[] {
  return Array.from({ length: ctx.facts.size }, (_, index) => ctx.facts.get(`F${index + 1}`)!.value);
}

/** Every key, string and number a model reads, apart from ids, titles and source names (also a news source's label). */
function modelStrings(item: unknown, key = '', parent = ''): string[] {
  if (typeof item === 'string') return ['id', 'title', 'source'].includes(key) || (key === 'label' && parent === 'sources') ? [] : [item];
  if (typeof item === 'number') return [String(item)];
  if (Array.isArray(item)) return item.flatMap(child => modelStrings(child, key, parent));
  if (typeof item === 'object' && item !== null) return Object.entries(item).flatMap(([name, child]) => [name, ...modelStrings(child, name, key)]);
  return [];
}

function assertNoDigit(results: readonly unknown[], ctx: AskToolContext, label: string) {
  for (const text of results.flatMap(result => modelStrings(result))) assert.doesNotMatch(text, /\p{Nd}/u, `${label}: ${text}`);
  for (let index = 1; index <= ctx.facts.size; index += 1) assert.doesNotMatch(ctx.facts.get(`F${index}`)!.label, /\p{Nd}/u, `${label}: label F${index}`);
}

test('the fixtures are values the history route would serve', () => {
  for (const history of [publicHistory(), privateHistory()]) assert.ok(parseCompanyHistory(JSON.parse(JSON.stringify(history))), history.status);
  assert.equal(publicHistory().status, 'ready');
  assert.equal(privateHistory().status, 'stats_not_public');
  assert.equal(kstYear(Date.parse('2026-12-31T14:59:00Z')), 2026);
  assert.equal(kstYear(Date.parse('2026-12-31T15:00:00Z')), 2027);
});

test('parseToolCall takes a listed tool with every argument from its list, and nothing else', () => {
  const base = { tool: 'get_history', horizon: 'week', direction: 'positive', topic: 'all', overnight: 'all', term: 'none' };
  assert.deepEqual(parseToolCall(base), { tool: 'get_history', args: { horizon: 'week', direction: 'positive', topic: 'all', overnight: 'all', term: 'none' } });
  // Extra keys a model adds (action, text) are not arguments.
  assert.deepEqual(parseToolCall({ ...base, action: 'tool', text: 'x', refusal: 'none', evidence: [] })?.tool, 'get_history');
  assert.deepEqual(parseToolCall({ ...base, tool: 'get_articles', direction: 'neutral', topic: 'earnings', overnight: 'only' })?.args,
    { horizon: 'week', direction: 'neutral', topic: 'earnings', overnight: 'only', term: 'none' });
  assert.deepEqual(parseToolCall({ ...base, tool: 'explain_term', term: 'market_relative' })?.args.term, 'market_relative');
  for (const tool of ASK_TOOL_NAMES) assert.ok(parseToolCall({ ...base, tool, term: tool === 'explain_term' ? 'median' : 'none' }), tool);
  const rejected: Array<[string, Record<string, unknown>]> = [
    ['unknown tool', { ...base, tool: 'get_prices' }],
    ['no tool', { ...base, tool: 'none' }],
    ['tool not a string', { ...base, tool: ['get_history'] }],
    ['horizon', { ...base, horizon: 'month' }],
    ['direction', { ...base, direction: 'up' }],
    ['topic', { ...base, topic: 'crypto' }],
    ['overnight', { ...base, overnight: 'yes' }],
    ['term', { ...base, term: 'pe_ratio' }],
    ['a term the tool does not use, still checked', { ...base, term: 'price_target' }],
    ['missing argument', { tool: 'get_history', horizon: 'week', direction: 'positive', topic: 'all', overnight: 'all' }],
    ['neutral for get_history', { ...base, direction: 'neutral' }],
    ['neutral for get_cases', { ...base, tool: 'get_cases', direction: 'neutral' }],
    ['neutral for get_outlook', { ...base, tool: 'get_outlook', direction: 'neutral' }],
    ['explain_term without a term', { ...base, tool: 'explain_term' }],
  ];
  for (const [name, raw] of rejected) assert.equal(parseToolCall(raw), null, name);
  assert.equal(parseToolCall(null as unknown as Record<string, unknown>), null);
  assert.equal(parseToolCall([] as unknown as Record<string, unknown>), null);
});

test('the fact table numbers facts in order, keeps one id per key and stops at its size', () => {
  const facts = createFactTable(3);
  assert.equal(facts.add('a', '이름 가', '1건'), 'F1');
  assert.equal(facts.add('b', '이름 나', '2건'), 'F2');
  assert.equal(facts.add('a', '이름 다', '9건'), 'F1');
  assert.deepEqual(facts.get('F1'), { label: '이름 가', value: '1건' });
  assert.equal(facts.add('c', '이름 라', '3건'), 'F3');
  assert.equal(facts.add('d', '이름 마', '4건'), '');
  assert.equal(facts.size, 3);
  assert.equal(facts.get('F4'), undefined);
  assert.equal(facts.get('F0'), undefined);
  assert.equal(createFactTable().add('x', '이름', '값'), 'F1');
  // A tool past the table's size leaves those fields out instead of naming an id that does not exist.
  const ctx = contextOf(publicHistory(), analysisOf(), createFactTable(2));
  const outlook = run(ctx, 'get_outlook');
  assert.equal(ctx.facts.size, 2);
  assert.ok(!JSON.stringify(outlook).includes('"F3"'));
  // The same question asks for the same facts twice: the same ids, and the table does not grow.
  const again = contextOf(publicHistory());
  const first = run(again, 'get_outlook');
  const size = again.facts.size;
  assert.deepEqual(run(again, 'get_outlook'), first);
  assert.equal(again.facts.size, size);
});

test('get_outlook: the current analysis always, and both horizons as the cards show them', () => {
  const ctx = contextOf(publicHistory());
  const result = run(ctx, 'get_outlook', { horizon: 'day' });
  assert.equal(result.tool, 'get_outlook');
  assert.equal(result.status, 'shown');
  const current = result.current as Record<string, unknown>;
  assert.deepEqual(Object.keys(current), [
    'status', 'statusCode', 'evidence', 'evidenceCode', 'summary', 'relatedCount', 'positiveFactors', 'negativeFactors', 'hasPositive', 'hasNegative',
  ]);
  assert.deepEqual(current.status, { id: 'F1', label: '현재 분석 상태' });
  assert.equal(value(ctx, current.status), '뉴스 참고 · 불확실성 존재');
  assert.equal(value(ctx, current.evidence), '보통');
  assert.equal(value(ctx, current.summary), '최근 7일 관련 기사 4건 가운데 긍정 1건');
  assert.equal(value(ctx, current.relatedCount), '4건');
  assert.deepEqual((current.positiveFactors as unknown[]).map(ref => value(ctx, ref)), ['실적 개선 기사']);
  assert.deepEqual([current.statusCode, current.evidenceCode, current.hasPositive, current.hasNegative, current.negativeFactors], ['ready', 'moderate', true, false, []]);
  // horizon is ignored: both are always there.
  const day = result.day as Record<string, unknown>;
  const week = result.week as Record<string, unknown>;
  assert.equal(value(ctx, day.title), '다음 거래일 · 11/30(월)');
  assert.equal(value(ctx, day.signal), '상승 전망');
  assert.equal(value(ctx, day.baseline), '상승 전망');
  assert.equal(value(ctx, day.verdict), '지지');
  assert.equal(value(ctx, day.validation), '검증 전 · 참고 정보');
  assert.equal(value(ctx, day.newsLine), '밤사이 긍정 기사 1건');
  assert.equal(value(ctx, day.pastLine), '과거 비슷한 날: 지지');
  assert.match(value(ctx, day.integrationLine)!, /^같은 방향 뉴스가 있던 날의 다음 거래일도/);
  assert.equal('changeLine' in day, false);
  assert.deepEqual([day.signalCode, day.baselineCode, day.verdictCode, day.overnightReason, day.changed, day.phase],
    ['positive', 'positive', 'supports', 'one_direction', false, 'after_close']);
  // The week's contradicting cases lowered it.
  assert.equal(value(ctx, week.title), '다음 주 · 11/30(월)~12/4(금)');
  assert.equal(value(ctx, week.signal), '판단 유보');
  assert.equal(value(ctx, week.verdict), '상충');
  assert.equal(value(ctx, week.newsLine), '최근 7일 긍정 기사 1건');
  assert.equal(value(ctx, week.changeLine), '기준선 상승 전망에서 판단 유보로 낮췄습니다.');
  assert.deepEqual([week.signalCode, week.verdictCode, week.changed, 'overnightReason' in week], ['withheld', 'contradicts', true, false]);
  assert.deepEqual([result.statsPublic, result.statsAge], [true, 'fresh']);
  assert.match((day.signal as { label: string }).label, /^다음 거래일 · /);
  // Without a history only the current analysis.
  const shownOff = run(contextOf(OFF), 'get_outlook');
  assert.deepEqual(Object.keys(shownOff), ['tool', 'status', 'current']);
  assert.equal(shownOff.status, 'not_shown');
  assert.equal(run(contextOf(UNAVAILABLE), 'get_outlook').status, 'not_shown');
});

test('get_outlook takes the factor summary lines when there are any, at most five per side', () => {
  const lines = (prefix: string, n: number) => Array.from({ length: n }, (_, index) => ({ text: `${prefix} 문장 ${index + 1}`, topic: 'earnings' as const, articleIds: ['a1'] }));
  const ctx = contextOf(OFF, analysisOf({
    positiveFactors: Array.from({ length: 7 }, (_, index) => `옛 긍정 ${index}`), negativeFactors: ['옛 부정'],
    factorSummary: {
      positive: { state: 'repeated', lines: lines('긍정', 7), chips: [] }, negative: { state: 'single', lines: lines('부정', 1), chips: [] }, chips: [], note: '',
    },
  }));
  const current = run(ctx, 'get_outlook').current as Record<string, unknown>;
  assert.deepEqual((current.positiveFactors as unknown[]).map(ref => value(ctx, ref)), ['긍정 문장 1', '긍정 문장 2', '긍정 문장 3', '긍정 문장 4', '긍정 문장 5']);
  assert.deepEqual((current.negativeFactors as unknown[]).map(ref => value(ctx, ref)), ['부정 문장 1']);
  assert.deepEqual([current.hasPositive, current.hasNegative], [true, true]);
  const legacy = contextOf(OFF, analysisOf({ positiveFactors: Array.from({ length: 7 }, (_, index) => `옛 긍정 ${index}`) }));
  assert.equal(((run(legacy, 'get_outlook').current as Record<string, unknown>).positiveFactors as unknown[]).length, 5);
});

test('get_articles: related articles in order with stable ids, filters, and links remembered for the answer', () => {
  const ctx = contextOf(publicHistory());
  const result = run(ctx, 'get_articles');
  assert.equal(result.status, 'ok');
  assert.equal(value(ctx, result.matched), '4건');
  const articles = result.articles as Array<Record<string, unknown>>;
  assert.deepEqual(articles.map(item => item.id), ['A1', 'A2', 'A3', 'A5']);
  assert.deepEqual(articles[0], {
    id: 'A1', title: '삼성전자, 3분기 영업이익 12조 원 기록', source: '연합뉴스', sentiment: 'positive', topics: ['earnings'], overnight: true,
    time: { id: (articles[0]!.time as { id: string }).id, label: '게시 시각' },
  });
  assert.deepEqual(Object.keys(articles[0]!), ['id', 'title', 'source', 'sentiment', 'topics', 'overnight', 'time']);
  assert.equal(value(ctx, articles[0]!.time), '11/27(금) 17:00 KST');
  // A crawler's time is named as such; an article without topics gets the factor summary's keyword topics.
  assert.deepEqual([(articles[3]!.time as { label: string }).label, articles[3]!.topics, articles[3]!.overnight, articles[1]!.overnight],
    ['처음 확인한 시각', ['other'], true, false]);
  assert.deepEqual([...ctx.refs.keys()], ['A1', 'A2', 'A3', 'A5']);
  assert.deepEqual(ctx.refs.get('A1'), { title: '삼성전자, 3분기 영업이익 12조 원 기록', source: '연합뉴스', url: 'https://news.example/a1', publishedAt: '2026-11-27T08:00:00.000Z' });
  const ids = (extra: Partial<AskToolArgs>) => (run(ctx, 'get_articles', extra).articles as Array<{ id: string }>).map(item => item.id);
  assert.deepEqual(ids({ direction: 'positive' }), ['A1']);
  assert.deepEqual(ids({ direction: 'negative' }), ['A2']);
  assert.deepEqual(ids({ direction: 'neutral' }), ['A3', 'A5']);
  assert.deepEqual(ids({ topic: 'regulation' }), ['A2']);
  assert.deepEqual(ids({ topic: 'deal' }), []);
  assert.deepEqual(ids({ overnight: 'only' }), ['A1', 'A5']);
  assert.deepEqual(ids({ overnight: 'only', direction: 'positive', topic: 'earnings' }), ['A1']);
  const matched = run(ctx, 'get_articles', { direction: 'neutral' }).matched;
  assert.equal(value(ctx, matched), '2건');
  assert.notDeepEqual(matched, result.matched);
  // At most eight, still numbered by their place in the analysis.
  const many = contextOf(OFF, analysisOf({ articles: Array.from({ length: 12 }, (_, index) => article(index + 1, { sentiment: 'positive' })) }));
  const listed = run(many, 'get_articles');
  assert.deepEqual((listed.articles as Array<{ id: string }>).map(item => item.id), ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8']);
  assert.equal(value(many, listed.matched), '12건');
  assert.equal(many.refs.size, 8);
  // Without a history there is no overnight window: no overnight field, and 'only' cannot be answered.
  const off = contextOf(OFF);
  assert.equal('overnight' in (run(off, 'get_articles').articles as Array<Record<string, unknown>>)[0]!, false);
  assert.deepEqual(run(off, 'get_articles', { overnight: 'only' }), { tool: 'get_articles', status: 'no_window' });
  assert.deepEqual(run(contextOf(UNAVAILABLE), 'get_articles', { overnight: 'only' }), { tool: 'get_articles', status: 'no_window' });
  // News gathered before the window opened has not checked it, as the day card says.
  const early = contextOf(publicHistory(), analysisOf({ asOf: '2026-11-27T06:00:00.000Z' }));
  assert.deepEqual(run(early, 'get_articles', { overnight: 'only' }), { tool: 'get_articles', status: 'not_checked' });
  assert.ok((run(early, 'get_articles').articles as Array<{ overnight: boolean }>).every(item => item.overnight === false));
});

test('get_history: per horizon and direction, every figure behind a fact id', () => {
  const ctx = contextOf(publicHistory());
  const result = run(ctx, 'get_history', { horizon: 'week', direction: 'positive' });
  assert.equal(result.status, 'ok');
  assert.equal(result.statsAge, 'fresh');
  const horizons = result.horizons as Record<string, Record<string, Record<string, unknown>>>;
  assert.deepEqual(Object.keys(horizons), ['week']);
  assert.deepEqual(Object.keys(horizons.week!), ['positive']);
  const week = horizons.week!.positive!;
  assert.equal(week.verdictCode, 'contradicts');
  assert.equal(value(ctx, week.verdict), '상충');
  assert.equal(week.includesBackfill, true);
  const sample = week.sample as Record<string, unknown>;
  assert.deepEqual(Object.keys(sample), ['eventUnits', 'otherUnits', 'difference', 'interval', 'period']);
  assert.deepEqual(Object.values(sample).map(ref => value(ctx, ref)), ['26개', '113개', '+14.3%p', '+2.2%p ~ +26.5%p', '2024-03-04 ~ 2026-11-20']);
  const cases = week.cases as Record<string, unknown>;
  assert.equal(cases.hasStats, true);
  assert.deepEqual(['count', 'independent', 'up', 'neutral', 'down', 'median', 'middle', 'relativeMedian', 'period', 'allWindowsUp', 'allWindowsDown', 'share']
    .map(field => value(ctx, cases[field])), ['37건', '29개', '19건', '6건', '12건', '+4.4%', '-1.2% ~ +7.9%', '+2.1%', '2024-03-04 ~ 2026-11-20', '59%', '33%', '51%(미래 확률 아님)']);
  assert.deepEqual((week.topics as Array<{ topic: string; count: unknown }>).map(item => [item.topic, value(ctx, item.count)]), [['earnings', '13건']]);
  assert.equal((sample.eventUnits as { label: string }).label, '다음 주 · 긍정 방향 · 사건 기간 수');
  assert.equal((cases.share as { label: string }).label, '다음 주 · 긍정 방향 · 과거 상승 비중');
  // 'all' gives both directions, 'both' both horizons; the day sample has no backfill.
  const all = run(ctx, 'get_history').horizons as Record<string, Record<string, Record<string, unknown>>>;
  assert.deepEqual(Object.keys(all), ['day', 'week']);
  assert.deepEqual(Object.keys(all.day!), ['positive', 'negative']);
  assert.deepEqual([all.day!.positive!.verdictCode, all.day!.negative!.verdictCode, all.day!.positive!.includesBackfill], ['supports', 'weakens', false]);
  // Below five cases there are no statistics, and below ten non-overlapping windows no share.
  const few = companyStats();
  few.horizons.day.directions!.positive.all = caseStats({ cases: 4, nEff: 4, up: 2, neutral: 1, down: 1, returns: null, period: null, allWindows: null });
  few.horizons.day.directions!.negative.all = caseStats({ nEff: 9 });
  const thin = contextOf(publicHistory(few));
  const thinDay = (run(thin, 'get_history', { horizon: 'day' }).horizons as Record<string, Record<string, Record<string, Record<string, unknown>>>>).day!;
  assert.deepEqual(Object.keys(thinDay.positive!.cases!), ['count', 'independent', 'up', 'neutral', 'down', 'hasStats']);
  assert.equal(thinDay.positive!.cases!.hasStats, false);
  assert.equal('share' in thinDay.negative!.cases!, false);
  assert.equal('median' in thinDay.negative!.cases!, true);
});

test('get_cases: up to five examples per direction with C ids, a link for each, and the title optional', () => {
  const ctx = contextOf(publicHistory());
  const result = run(ctx, 'get_cases', { horizon: 'day', direction: 'positive' });
  assert.equal(result.status, 'ok');
  const examples = (result.horizons as Record<string, Record<string, Array<Record<string, unknown>>>>).day!.positive!;
  assert.deepEqual(examples.map(item => item.id), ['C1', 'C2']);
  assert.deepEqual(Object.keys(examples[0]!), ['id', 'source', 'title', 'date', 'period', 'return', 'relative']);
  assert.deepEqual(Object.keys(examples[1]!), ['id', 'source', 'date', 'period', 'return']);
  assert.deepEqual(['date', 'period', 'return', 'relative'].map(field => value(ctx, examples[0]![field])), ['2026-10-01', '2026-10-02 ~ 2026-10-09', '+3.5%', '+1.2%']);
  assert.equal(value(ctx, examples[1]!.return), '-2.6%');
  assert.deepEqual(ctx.refs.get('C1'), { title: '삼성전자 사례 기사', source: 'Example Wire', url: 'https://cases.example/1', publishedAt: '2026-10-01' });
  assert.deepEqual(ctx.refs.get('C2'), { title: 'Example Wire 기사', source: 'Example Wire', url: 'https://cases.example/2', publishedAt: '2026-09-15' });
  // The same link keeps its id across horizons and directions.
  const all = run(ctx, 'get_cases').horizons as Record<string, Record<string, Array<{ id: string }>>>;
  assert.deepEqual([all.day!.negative!, all.week!.positive!, all.week!.negative!].map(list => list.map(item => item.id)), [['C1', 'C2'], ['C1', 'C2'], ['C1', 'C2']]);
  const many = companyStats();
  many.horizons.week.directions!.negative.examples = Array.from({ length: 5 }, (_, index) => ({
    date: `2026-08-0${index + 1}`, source: 'Example Wire', url: `https://cases.example/m${index}`, entryDate: '2026-08-10', exitDate: '2026-08-17', r: 0.01, relative: null,
  }));
  const five = contextOf(publicHistory(many));
  const week = (run(five, 'get_cases', { horizon: 'week', direction: 'negative' }).horizons as Record<string, Record<string, Array<{ id: string }>>>).week!.negative!;
  assert.deepEqual(week.map(item => item.id), ['C1', 'C2', 'C3', 'C4', 'C5']);
});

test('explain_term gives the dictionary text verbatim for every term', () => {
  for (const term of ASK_TERM_IDS) {
    const ctx = contextOf(OFF);
    const result = run(ctx, 'explain_term', { term });
    assert.deepEqual(result, { tool: 'explain_term', status: 'ok', term, label: ASK_TERMS[term].label, text: ASK_TERMS[term].text, definition: { id: 'F1', label: '용어 풀이' } });
    assert.equal(value(ctx, result.definition), `${ASK_TERMS[term].label}: ${ASK_TERMS[term].text}`);
  }
  assert.deepEqual(run(contextOf(OFF), 'explain_term', { term: 'none' }), { tool: 'explain_term', status: 'error' });
});

test('get_data_status: times, sources and limits; statistics time, coverage and price only for a public market', () => {
  const ctx = contextOf(publicHistory());
  const result = run(ctx, 'get_data_status');
  assert.equal(result.status, 'ok');
  assert.equal(value(ctx, result.asOf), '11/27(금) 18:30 KST');
  const window = result.newsWindow as Record<string, unknown>;
  assert.deepEqual([value(ctx, window.start), value(ctx, window.end)], ['11/20(금) 18:30 KST', '11/27(금) 18:30 KST']);
  assert.equal(value(ctx, result.provider), 'Marketaux');
  assert.deepEqual(result.sources, [{ label: 'Marketaux', status: 'ok' }, { label: 'GDELT', status: 'ok' }]);
  assert.deepEqual([result.history, result.statsPublic, result.statsAge], ['ready', true, 'fresh']);
  assert.equal(value(ctx, result.computedAt), '11/27(금) 15:31 KST');
  assert.equal(value(ctx, result.lastPriceDate), '2026-11-24');
  assert.equal(value(ctx, result.sourcesLine), '출처: 뉴스 Marketaux, GDELT · 가격 금융위원회 주식시세(미조정 가격)');
  assert.equal(value(ctx, result.coverage), '기사 4321건 · 사건 876개 · 판정 표본 98개 · 관측 공백 2개');
  const notes = result.notes as Array<{ code: string; text: unknown }>;
  assert.deepEqual(notes.map(note => [note.code, value(ctx, note.text)]),
    [['marketaux_top', MARKETAUX_TOP_NOTE], ['gdelt', GDELT_CREDIT], ['backfill', BACKFILL_SAMPLE_NOTE]]);
  assert.equal(value(ctx, result.disclaimer), HISTORY_DISCLAIMER);
  // Off: no history fields and no disclaimer; an analysis without a provider says so, and without a GDELT article no credit.
  const off = contextOf(OFF, analysisOf({ provider: null, sources: [], newsWindow: undefined, articles: ARTICLES.slice(0, 4).map(item => ({ ...item })) }));
  const plain = run(off, 'get_data_status');
  assert.deepEqual(Object.keys(plain), ['tool', 'status', 'asOf', 'newsWindow', 'provider', 'sources', 'history', 'statsPublic', 'notes']);
  assert.deepEqual([plain.newsWindow, plain.history, plain.statsPublic, plain.notes, value(off, plain.provider)], [null, 'off', false, [], '미연결']);
});

test('a market without permission: get_history and get_cases say private and nothing else; the outlook says not yet public', () => {
  const ctx = contextOf(privateHistory(), analysisOf(), createFactTable(500));
  const outlook = run(ctx, 'get_outlook');
  const size = ctx.facts.size;
  const refs = [...ctx.refs];
  for (const tool of ['get_history', 'get_cases'] as const) {
    for (const extra of [{}, { horizon: 'day', direction: 'negative' }] as const) assert.deepEqual(run(ctx, tool, extra), { tool, status: 'private' });
  }
  assert.equal(ctx.facts.size, size, 'no fact added');
  assert.deepEqual([...ctx.refs], refs, 'no link added');
  for (const horizon of ['day', 'week'] as const) {
    const item = outlook[horizon] as Record<string, unknown>;
    assert.equal(value(ctx, item.verdict), '공개 전', horizon);
    assert.equal(item.verdictCode, null, horizon);
    assert.equal(value(ctx, item.pastLine), STATS_NOT_PUBLIC_MESSAGE, horizon);
    assert.equal(value(ctx, item.integrationLine), STATS_NOT_PUBLIC_MESSAGE, horizon);
    assert.equal(value(ctx, item.signal), '상승 전망', `${horizon}: the news signal is still shown`);
  }
  assert.equal(outlook.statsPublic, false);
  const status = run(ctx, 'get_data_status');
  for (const field of ['computedAt', 'lastPriceDate', 'sourcesLine', 'coverage', 'statsAge']) assert.equal(field in status, false, field);
  assert.deepEqual([status.history, status.statsPublic], ['stats_not_public', false]);
  assert.deepEqual((status.notes as Array<{ code: string }>).map(note => note.code), ['marketaux_top', 'gdelt', 'stats_not_public']);
  assert.equal(value(ctx, status.disclaimer), HISTORY_DISCLAIMER);
});

test('the six tools and every fact value carry none of the public statistics for a market without permission', () => {
  const dump = (history: CompanyHistory) => {
    const ctx = contextOf(history, analysisOf(), createFactTable(500));
    const results = runAll(ctx);
    return { ctx, text: JSON.stringify([results, factValues(ctx), [...ctx.refs]]) };
  };
  // The public market shows every sentinel somewhere, so their absence below means something.
  const shown = dump(publicHistory()).text;
  for (const sentinel of SENTINELS) assert.ok(shown.includes(sentinel), `public: ${sentinel}`);
  // A served stats_not_public value, and one that wrongly kept its statistics (the route's parser would refuse it).
  const leaky = { ...publicHistory(), status: 'stats_not_public' } as CompanyHistory;
  for (const [name, history] of [['built', privateHistory()], ['leaky', leaky]] as const) {
    const { ctx, text } = dump(history);
    for (const sentinel of SENTINELS) assert.ok(!text.includes(sentinel), `${name}: ${sentinel}`);
    assert.ok(![...ctx.refs.keys()].some(id => id.startsWith('C')), `${name}: no case link`);
  }
  // Read without its statistics, the leaky value keeps the news baselines, as the built one does.
  const view = readyHistory(leaky);
  assert.ok(view && view.horizons.day.directions === null && view.horizons.week.directions === null && !('sampleOrigin' in view.horizons.week));
  const outlook = run(contextOf(leaky), 'get_outlook');
  assert.equal('changeLine' in (outlook.week as Record<string, unknown>), false);
  assert.deepEqual(readyHistory(publicHistory()), publicHistory());
  assert.equal(readyHistory(OFF), null);
  assert.equal(readyHistory(UNAVAILABLE), null);
});

test('no model-facing output holds a digit outside ids, titles and source names', () => {
  const cases: Array<[string, CompanyHistory]> = [['public', publicHistory()], ['private', privateHistory()], ['off', OFF], ['unavailable', UNAVAILABLE]];
  for (const [name, history] of cases) {
    const ctx = contextOf(history, analysisOf(), createFactTable(500));
    const results = [
      ...runAll(ctx),
      ...ASK_TERM_IDS.map(term => run(ctx, 'explain_term', { term })),
      ...(['positive', 'negative', 'neutral'] as const).map(item => run(ctx, 'get_articles', { direction: item, overnight: 'only' })),
      ...NEWS_TOPIC_KEYS.map(topic => run(ctx, 'get_articles', { topic })),
    ];
    assertNoDigit(results, ctx, name);
  }
  // Labels stay digit-free when the table fills up past get_history and get_cases.
  const crowded = contextOf(publicHistory());
  assertNoDigit(runAll(crowded), crowded, 'crowded');
  assert.equal(crowded.facts.size, 120);
});

test('history without statistics: off, unavailable, the no-statistics statuses and expired statistics', () => {
  const old = companyStats({ dataAsOf: { ...companyStats().dataAsOf, computedAt: new Date(NOW - 15 * DAY_MS).toISOString() } });
  for (const tool of ['get_history', 'get_cases'] as const) {
    assert.deepEqual(run(contextOf(OFF), tool), { tool, status: 'off' });
    assert.deepEqual(run(contextOf(UNAVAILABLE), tool), { tool, status: 'unavailable' });
    for (const status of ['no_history', 'identity_unverified', 'price_unavailable'] as const) {
      const stats = companyStats({ status, horizons: { day: { directions: null, timeUnverifiedUnits: 0 }, week: { directions: null, timeUnverifiedUnits: 0 } } });
      const ctx = contextOf(publicHistory(stats));
      assert.equal(ctx.history.status, status);
      assert.deepEqual(run(ctx, tool), { tool, status }, `${tool} ${status}`);
      assert.equal(ctx.facts.size, 0);
    }
    // Computed more than 14 days ago: never used, and said in the screen's words.
    const ctx = contextOf(publicHistory(old));
    const result = run(ctx, tool);
    assert.deepEqual(Object.keys(result), ['tool', 'status', 'text']);
    assert.equal(result.status, 'expired');
    assert.equal(value(ctx, result.text), EXPIRED_STATS_MESSAGE);
  }
  assert.equal(run(contextOf(publicHistory(old)), 'get_outlook').statsAge, 'expired');
});

test('runAskTool never throws and answers only plain JSON', () => {
  const broken = contextOf(OFF, { ...analysisOf(), articles: null } as unknown as NewsAnalysis);
  assert.deepEqual(run(broken, 'get_articles'), { tool: 'get_articles', status: 'error' });
  assert.deepEqual(run(broken, 'get_outlook'), { tool: 'get_outlook', status: 'error' });
  assert.deepEqual(runAskTool('get_prices' as AskToolName, args(), contextOf(OFF)), { tool: 'get_prices', status: 'error' });
  const ctx = contextOf(publicHistory(), analysisOf({ summary: '' }));
  for (const result of runAll(ctx)) assert.deepEqual(JSON.parse(JSON.stringify(result)), result, result.tool);
  // An empty value is no fact: the field is left out.
  assert.equal('summary' in (run(ctx, 'get_outlook').current as Record<string, unknown>), false);
});
