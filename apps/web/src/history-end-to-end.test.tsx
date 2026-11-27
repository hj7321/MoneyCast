import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { after, afterEach, beforeEach, test } from 'node:test';
import {
  companies, coverageLine, sampleLine, sourcesLine, NEWS_CACHE_ANALYSIS_VERSION, STATS_NOT_PUBLIC_MESSAGE,
  type CaseStats, type Company, type DirectionStats, type Horizon, type NewsAnalysis, type NewsArticle, type ReadyCompanyHistory,
} from '@moneycast/core';
import { createApiHandler } from '../../../api/index.js';
import { createHistoryServe } from '../../../server/history-serve.js';
import type { CompanyStats } from '../../../server/history-stats.js';
import { HISTORY_VERSIONS, createMemoryHistoryStore, type MemoryHistoryStore, type StatsFile } from '../../../server/history-store.js';

// End to end: the real serverless entry (createApiHandler) on a loopback port and the real news screen in jsdom,
// with nothing between them but HTTP. The hint has to travel /api/news, the browser news cache and NewsPanel, and
// the answer the server builds has to pass the shared parser before a card is drawn. No provider is ever asked:
// the news service is a fake, stats.json lives in a memory store, and any other address fails the request.

// jsdom is a test-only dependency. Install its browser globals before importing
// React DOM and Testing Library, which capture document at module initialization.
const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => {
    window: Window & typeof globalThis & { close(): void };
  };
};
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/#news' });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  SVGElement: dom.window.SVGElement,
  MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
dom.window.scrollTo = () => undefined;

const React = await import('react');
// The repository-level tsx test runner may fall back to the classic JSX transform.
Object.assign(globalThis, { React });
const { render, screen, fireEvent, cleanup, waitFor, within } = await import('@testing-library/react');
const { NewsPanel } = await import('./NewsPanel');
const { resetHistoryInsightCache } = await import('./HistoryInsight');
const realFetch = globalThis.fetch;

const HOUR = 3_600_000;
/** The server's clock: Monday 2026-11-23 22:00 KST. KRX has closed (next open 00:00Z); NASDAQ opens at 14:30Z. */
const SERVER_NOW = Date.parse('2026-11-23T13:00:00.000Z');
/** Inside both overnight windows the server computes at SERVER_NOW, and inside the analysis's seven days. */
const OVERNIGHT = '2026-11-23T12:00:00.000Z';
const SECTION = '전망 한눈에 보기';
const SUMMARY = '테스트 전용: 현재 기사 기반 요약입니다.';
/** An analysis version the browser news cache never keeps, so every load asks the server. */
const UNCACHED_VERSION = 'news-evidence-test-v1';
const WAIT = { timeout: 5_000 };

function company(id: string): Company {
  const found = companies.find(item => item.id === id);
  assert.ok(found, id);
  return { ...found };
}

function article(id: string, sentiment: NewsArticle['sentiment']): NewsArticle {
  return {
    id, title: `테스트 전용 기사 ${id}`, source: 'publisher.example.test', publishedAt: OVERNIGHT,
    url: `https://publisher.example.test/${id}`, sentiment, rationale: '테스트 전용 분류 근거입니다.',
  };
}

/** A live ready analysis with two positive overnight articles, as the news service would hand it out. */
function readyAnalysis(id: string, analysisVersion: string): NewsAnalysis {
  const item = company(id);
  return {
    company: item, status: 'ready', articles: [article(`${item.symbol}-1`, 'positive'), article(`${item.symbol}-2`, 'positive')],
    asOf: new Date(Date.now() - HOUR).toISOString(), cachedUntil: new Date(Date.now() + 5 * HOUR).toISOString(),
    period: { start: '2026-11-24', end: '2026-11-28' }, evidence: 'moderate', summary: SUMMARY,
    positiveFactors: ['테스트 전용 긍정 요인'], negativeFactors: [], risks: ['테스트 전용: 미래 방향은 불확실합니다.'],
    provider: 'Marketaux', analysisVersion, servedFrom: 'live',
    newsWindow: { start: '2026-11-16T13:00:00.000Z', end: '2026-11-23T13:00:00.000Z' },
    sources: [{ id: 'marketaux', label: 'Marketaux', status: 'ok', articleCount: 2 }],
  };
}

function notConfigured(item: Company): NewsAnalysis {
  return {
    company: { ...item }, status: 'not_configured', articles: [], asOf: new Date(Date.now() - HOUR).toISOString(),
    period: { start: '2026-11-24', end: '2026-11-28' }, evidence: 'none', summary: '테스트 전용: 뉴스 제공자가 연결되지 않았습니다.',
    positiveFactors: [], negativeFactors: [], risks: [], provider: null, analysisVersion: UNCACHED_VERSION,
  };
}

function caseStats(): CaseStats {
  return {
    cases: 12, nEff: 10, up: 6, neutral: 2, down: 4,
    returns: { median: 0.012, q1: -0.01, q3: 0.03, min: -0.05, max: 0.08, relativeMedian: 0.004 },
    period: { from: '2025-01-02', to: '2026-11-20' }, entryType: 'close', allWindows: { up: 0.48, down: 0.42 },
  };
}

function direction(verdict: DirectionStats['verdict'], unit: Horizon): DirectionStats {
  return {
    verdict,
    sample: {
      unit, eventUnits: 24, otherUnits: 180, eventUp: 14, eventDown: 8, eventNeutral: 2, otherUp: 80, otherDown: 85, otherNeutral: 15,
      difference: 0.14, ci90: [0.02, 0.26], from: '2025-01-02', to: '2026-11-20',
    },
    all: caseStats(), topics: [{ topic: 'earnings', cases: caseStats() }],
    examples: [{
      date: '2026-10-01', source: 'Example News', url: 'https://example.com/a', title: 'Example',
      entryDate: '2026-10-01', exitDate: '2026-10-02', r: 0.021, relative: 0.008,
    }],
  };
}

/** stats.json as the daily job writes it: every company ready, computed an hour before the browser's clock. */
function statsStore(): MemoryHistoryStore {
  const computedAt = new Date(Date.now() - HOUR).toISOString();
  const entry = (item: Company): CompanyStats => ({
    version: 'news-history-v1', companyId: item.id, exchange: item.region === 'KR' ? 'KRX' : 'NASDAQ', status: 'ready',
    horizons: {
      day: { directions: { positive: direction('supports', 'day'), negative: direction('no_clear_difference', 'day') }, timeUnverifiedUnits: 0 },
      week: { directions: { positive: direction('supports', 'week'), negative: direction('no_clear_difference', 'week') }, timeUnverifiedUnits: 0 },
    },
    coverage: { articles: 120, events: 80, usable: 90, excluded: { week_overlap: 3 }, observationGaps: 2 },
    dataAsOf: { computedAt, lastPriceDate: '2026-11-20', ledgerFrom: '2026-11-14T00:35:00.000Z', ledgerTo: '2026-11-23T05:00:00.000Z' },
    sources: {
      news: ['Marketaux', 'GDELT'],
      price: item.region === 'KR' ? { label: '금융위원회 주식시세', adjustment: 'raw' } : { label: 'Massive(구 Polygon) 일봉', adjustment: 'split' },
    },
  });
  const file: StatsFile = {
    version: HISTORY_VERSIONS.stats, computedAt, runId: 'end-to-end', carriedOver: [],
    companies: Object.fromEntries(companies.map(item => [item.id, entry(item)])),
  };
  const store = createMemoryHistoryStore();
  store.files.set('stats.json', { text: JSON.stringify(file), etag: '"stats-end-to-end"' });
  return store;
}

// ---------------------------------------------------------------------------
// The deployment and the browser's view of it
// ---------------------------------------------------------------------------

interface Exchange { path: string; status: number; cacheControl: string | null; cdn: string | null; body: unknown }
let exchanges: Exchange[] = [];
let elsewhere: string[] = [];
let servers: Server[] = [];

/** Starts the real entry with these settings and points the screen's fetch at it. Returns the news service's calls. */
async function deploy(env: NodeJS.ProcessEnv, store: MemoryHistoryStore, analyses: NewsAnalysis[]): Promise<string[]> {
  const asked: string[] = [];
  const byId = new Map(analyses.map(item => [item.company.id, item]));
  const service = {
    getAnalysis: async (item: Company) => { asked.push(item.id); return byId.get(item.id) ?? notConfigured(item); },
  } as unknown as Parameters<typeof createApiHandler>[0];
  const historyServe = createHistoryServe(env, { store, clock: () => SERVER_NOW });
  const server = createServer(createApiHandler(service, env, { historyServe }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  exchanges = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input), origin);
    if (url.origin !== origin) {
      elsewhere.push(url.href);
      throw new TypeError('테스트 전용: 이 서버 밖으로는 요청하지 않습니다');
    }
    // Recorded when asked, so a request still in flight already counts.
    const exchange: Exchange = { path: `${url.pathname}${url.search}`, status: 0, cacheControl: null, cdn: null, body: undefined };
    exchanges.push(exchange);
    const response = await realFetch(url, init);
    const text = await response.clone().text();
    Object.assign(exchange, {
      status: response.status, cacheControl: response.headers.get('cache-control'), cdn: response.headers.get('vercel-cdn-cache-control'),
    });
    try { exchange.body = JSON.parse(text); } catch { exchange.body = text; }
    return response;
  }) as typeof fetch;
  return asked;
}

const historyRequests = () => exchanges.filter(item => item.path.startsWith('/api/news/history'));
const newsRequests = (id: string) => exchanges.filter(item => item.path === `/api/news?companyId=${encodeURIComponent(id)}`);
/** Lets effects and any stray request start before counting requests. */
const settle = () => new Promise(resolve => setTimeout(resolve, 50));

async function openCompany(name: RegExp) {
  const view = render(React.createElement(NewsPanel));
  await screen.findByText('데이터 연동 대기', undefined, WAIT);
  fireEvent.click(screen.getByRole('button', { name }));
  return view;
}

async function outlook(): Promise<HTMLElement> {
  const section = await screen.findByRole('region', { name: SECTION }, WAIT);
  await waitFor(() => assert.equal(section.querySelectorAll('.history-card').length, 2), WAIT);
  return section;
}

function cards(section: HTMLElement): { day: HTMLElement; week: HTMLElement } {
  const [day, week] = Array.from(section.querySelectorAll<HTMLElement>('.history-card'));
  assert.ok(day && week);
  return { day, week };
}

/** The values the browser news cache persisted for one company. */
function persistedAnalyses(id: string): NewsAnalysis[] {
  const found: NewsAnalysis[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    try {
      const entry = JSON.parse(window.localStorage.getItem(window.localStorage.key(index)!) ?? 'null') as { value?: NewsAnalysis } | null;
      if (entry?.value?.company?.id === id) found.push(entry.value);
    } catch { /* not a news cache entry */ }
  }
  return found;
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  resetHistoryInsightCache();
  elsewhere = [];
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  for (const server of servers) { server.closeAllConnections(); server.close(); }
  servers = [];
});
after(() => dom.window.close());

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('end to end, production today (collect): /api/news carries no hint, the screen asks for no history and the card is the one shown with the feature off', async () => {
  const analysis = readyAnalysis('krx:000660', UNCACHED_VERSION);
  const markup: string[] = [];
  for (const env of [{}, { HISTORY_INSIGHTS: 'collect' }] as NodeJS.ProcessEnv[]) {
    const store = statsStore();
    const asked = await deploy(env, store, [analysis]);
    const view = await openCompany(/SK하이닉스/);
    await screen.findByRole('heading', { name: SUMMARY }, WAIT);
    await settle();
    const [news] = newsRequests('krx:000660');
    assert.ok(news, 'the screen asked its server for the news');
    assert.equal(Object.hasOwn(news.body as object, 'historyAvailable'), false, JSON.stringify(env));
    assert.deepEqual(historyRequests(), [], JSON.stringify(env));
    assert.equal(document.querySelector('.history-insight'), null);
    assert.equal(store.reads.length, 0);
    assert.deepEqual(asked, [companies[0]!.id, 'krx:000660']);
    markup.push(document.querySelector('.analysis-card')!.innerHTML);
    view.unmount();
  }
  assert.equal(markup[0], markup[1]);
  assert.deepEqual(elsewhere, []);
});

test('end to end, on without a public market: the hint reaches the screen through the news cache, and the Hyundai cards show news signals only', async () => {
  const store = statsStore();
  await deploy({ HISTORY_INSIGHTS: 'on' }, store, [readyAnalysis('krx:005380', NEWS_CACHE_ANALYSIS_VERSION)]);
  await openCompany(/현대자동차/);
  const section = await outlook();

  // The server added the hint, and the browser's news cache kept it with the analysis.
  const [news] = newsRequests('krx:005380');
  assert.equal((news!.body as NewsAnalysis).historyAvailable, true);
  const persisted = persistedAnalyses('krx:005380');
  assert.ok(persisted.length > 0, 'the analysis was cached');
  assert.ok(persisted.every(item => item.historyAvailable === true));

  // One history request, answered from the request time alone: no stats.json read and no number.
  const requests = historyRequests();
  assert.deepEqual(requests.map(item => item.path), ['/api/news/history?companyId=krx%3A005380']);
  assert.deepEqual([requests[0]!.status, requests[0]!.cacheControl, requests[0]!.cdn], [200, 'no-store', 'public, s-maxage=3600']);
  assert.equal((requests[0]!.body as { status: string }).status, 'stats_not_public');
  assert.equal(store.reads.length, 0);

  // Hyundai is shown like every other company: its news signal, the sessions the server computed, no statistic.
  const { day, week } = cards(section);
  for (const text of ['다음 거래일 · 11/24(화)', '상승 전망', '검증 전 · 참고 정보', '밤사이 긍정 기사 2건', STATS_NOT_PUBLIC_MESSAGE]) {
    assert.ok(within(day).getByText(text), text);
  }
  for (const text of ['다음 주 · 11/24(화)~11/30(월)', '상승 전망', '최근 7일 긍정 기사 2건', STATS_NOT_PUBLIC_MESSAGE]) {
    assert.ok(within(week).getByText(text), text);
  }
  assert.doesNotMatch(section.textContent ?? '', /\d+(\.\d+)?%/);
  assert.ok(screen.getByRole('heading', { name: SUMMARY }));
  assert.deepEqual(elsewhere, []);
});

test('end to end, on with KR public: Korean statistics from stats.json reach the cards through the shared parser, and a US company stays not public', async () => {
  const store = statsStore();
  await deploy({ HISTORY_INSIGHTS: 'on', HISTORY_PUBLIC_MARKETS: 'KR' }, store, [
    readyAnalysis('krx:000660', NEWS_CACHE_ANALYSIS_VERSION), readyAnalysis('nasdaq:MSFT', NEWS_CACHE_ANALYSIS_VERSION),
  ]);
  await openCompany(/SK하이닉스/);
  let section = await outlook();
  let { day, week } = cards(section);
  for (const text of ['다음 거래일 · 11/24(화)', '상승 전망', '과거 비슷한 날: 지지']) assert.ok(within(day).getByText(text), text);
  for (const text of ['다음 주 · 11/24(화)~11/30(월)', '상승 전망', '과거 비슷한 주: 지지']) assert.ok(within(week).getByText(text), text);
  const [answer] = historyRequests();
  assert.deepEqual([answer!.path, answer!.cacheControl, answer!.cdn], ['/api/news/history?companyId=krx%3A000660', 'no-store', 'public, s-maxage=3600']);
  const sent = answer!.body as ReadyCompanyHistory;
  assert.equal(sent.status, 'ready');
  // The numbers on screen are the ones the server sent.
  const block = section.querySelector<HTMLElement>('.history-evidence');
  assert.ok(block);
  assert.ok(within(block).getByText(sampleLine(sent.horizons.day.directions!.positive.sample!)));
  assert.ok(within(block).getByText(coverageLine(sent.coverage)));
  assert.ok(within(block).getByText(sourcesLine(sent.sources)));
  assert.ok(within(block).getByText('가격 기준일 2026-11-20'));
  assert.deepEqual(store.reads, [{ file: 'stats.json', fresh: false }]);

  // The same deployment for a market without permission: no number, and no further stats.json read.
  fireEvent.click(screen.getByRole('button', { name: /마이크로소프트/ }));
  await waitFor(() => {
    section = screen.getByRole('region', { name: SECTION });
    assert.ok(within(section).getByText('다음 거래일 · 11/23(월)'));
  }, WAIT);
  ({ day, week } = cards(section));
  for (const text of ['상승 전망', '밤사이 긍정 기사 2건', STATS_NOT_PUBLIC_MESSAGE]) assert.ok(within(day).getByText(text), text);
  assert.ok(within(week).getByText('다음 주 · 11/23(월)~11/30(월)'));
  assert.doesNotMatch(section.textContent ?? '', /\d+(\.\d+)?%/);
  assert.deepEqual(historyRequests().map(item => [item.path, (item.body as { status: string }).status]), [
    ['/api/news/history?companyId=krx%3A000660', 'ready'], ['/api/news/history?companyId=nasdaq%3AMSFT', 'stats_not_public'],
  ]);
  assert.deepEqual(store.reads, [{ file: 'stats.json', fresh: false }]);
  assert.deepEqual(elsewhere, []);
});
