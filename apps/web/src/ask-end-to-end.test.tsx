import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { after, afterEach, beforeEach, test } from 'node:test';
import {
  askEvidenceMeta, companies, formatShare, NEWS_ASK_VERSION, NEWS_CACHE_ANALYSIS_VERSION, STATS_NOT_PUBLIC_MESSAGE,
  ASK_ANSWER_NOTE, ASK_LABEL, ASK_REFUSAL_LEAD, ASK_REFUSAL_TEXTS, ASK_TEMPLATE_LABEL, ASK_TEMPLATE_NOTE, ASK_TERMS, ASK_TITLE,
  ASK_UNAVAILABLE_TEXT,
  type AskAnswer, type CaseStats, type Company, type DirectionStats, type Horizon, type NewsAnalysis, type NewsArticle,
} from '@moneycast/core';
import { createApiHandler } from '../../../api/index.js';
import { createHistoryServe } from '../../../server/history-serve.js';
import type { CompanyStats } from '../../../server/history-stats.js';
import { HISTORY_VERSIONS, createMemoryHistoryStore, type MemoryHistoryStore, type StatsFile } from '../../../server/history-store.js';
import type { LlmClient, LlmPrompt } from '../../../server/llm.js';

// End to end for "AI에게 물어보기": the real serverless entry (createApiHandler) on a loopback port and the real news
// screen in jsdom, with nothing between them but HTTP. The hint has to travel /api/news and the browser news cache,
// the panel asks for availability once, a question goes out as POST /api/news/ask, and the server's answer (tools,
// placeholder filling, checks) has to pass the shared parser before the screen draws it. The only model is a scripted
// fake that reads the prompt it gets; any address other than the loopback server fails the request, the server's own
// calls included, so no provider, model or Blob store is ever reached.

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
  HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
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
const { resetAskPanelCache } = await import('./AskPanel');
const realFetch = globalThis.fetch;
const realConsole = { log: console.log, warn: console.warn };

const HOUR = 3_600_000;
/** The history route's clock: Monday 2026-11-23 22:00 KST, after the KRX close; the next session is Tuesday 11-24. */
const SERVER_NOW = Date.parse('2026-11-23T13:00:00.000Z');
/** Inside the overnight window the history route computes at SERVER_NOW, and inside the analysis's seven days. */
const OVERNIGHT = '2026-11-23T12:00:00.000Z';
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
    company: item, status: 'ready', articles: [article(`${item.symbol}-a`, 'positive'), article(`${item.symbol}-b`, 'positive')],
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

/** stats.json as the daily job writes it (the step-6 fixture): every company ready, computed an hour before the browser's clock. */
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
    version: HISTORY_VERSIONS.stats, computedAt, runId: 'ask-end-to-end', carriedOver: [],
    companies: Object.fromEntries(companies.map(item => [item.id, entry(item)])),
  };
  const store = createMemoryHistoryStore();
  store.files.set('stats.json', { text: JSON.stringify(file), etag: '"stats-ask-end-to-end"' });
  return store;
}

// ---------------------------------------------------------------------------
// The scripted model
// ---------------------------------------------------------------------------

const FIELDS = { tool: 'none', horizon: 'both', direction: 'all', topic: 'all', overnight: 'all', term: 'none', refusal: 'none', text: '', evidence: [] as string[] };
type Reply = Record<string, unknown> | ((prompt: LlmPrompt) => unknown);
const toolReply = (tool: string, extra: Record<string, unknown> = {}): Reply => ({ ...FIELDS, action: 'tool', tool, ...extra });

interface ModelInput { question: string; context: Array<Record<string, unknown>> }
const inputOf = (prompt: LlmPrompt) => JSON.parse(prompt.user) as ModelInput;

/** A fake Gemini client: answers in turn (the last answer repeats) and records every prompt. */
function scriptedModel(replies: readonly Reply[]) {
  const prompts: LlmPrompt[] = [];
  const client: LlmClient & { prompts: LlmPrompt[] } = {
    id: 'gemini', label: 'Gemini', model: 'gemini-end-to-end-fake', prompts, unavailable: () => null,
    async generate(prompt) {
      prompts.push(prompt);
      const reply = replies[Math.min(prompts.length, replies.length) - 1]!;
      return typeof reply === 'function' ? reply(prompt) : structuredClone(reply);
    },
  };
  return client;
}

/** The id of the first fact with this label in the context the model was given, found the way a model would. */
function factId(prompt: LlmPrompt, label: string): string {
  let found: string | undefined;
  const walk = (item: unknown): void => {
    if (found !== undefined || typeof item !== 'object' || item === null) return;
    if (Array.isArray(item)) { item.forEach(walk); return; }
    const record = item as Record<string, unknown>;
    if (record.label === label && typeof record.id === 'string' && /^F\d+$/.test(record.id)) { found = record.id; return; }
    Object.values(record).forEach(walk);
  };
  walk(inputOf(prompt).context);
  assert.ok(found, `no fact labelled ${label}`);
  return found!;
}

// ---------------------------------------------------------------------------
// The deployment and the browser's view of it
// ---------------------------------------------------------------------------

interface Exchange { method: string; path: string; sent: unknown; status: number; cacheControl: string | null; body: unknown }
let exchanges: Exchange[] = [];
let elsewhere: string[] = [];
let servers: Server[] = [];
let origin: string | null = null;
/** The server's one line per question; anything else written to the console passes through. */
let logged: string[] = [];

/**
 * One fetch for the whole process, installed before the handler is built: the screen's requests go to the loopback
 * server, and anything else (a model or provider call the server must never make here) is recorded and refused.
 */
const fakeFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input), origin ?? 'http://unset.invalid');
  if (origin === null || url.origin !== origin) {
    elsewhere.push(url.href);
    throw new TypeError('테스트 전용: 이 서버 밖으로는 요청하지 않습니다');
  }
  // Recorded when asked, so a request still in flight already counts.
  const exchange: Exchange = {
    method: init?.method ?? 'GET', path: `${url.pathname}${url.search}`,
    sent: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined, status: 0, cacheControl: null, body: undefined,
  };
  exchanges.push(exchange);
  const response = await realFetch(url, init);
  const text = await response.clone().text();
  Object.assign(exchange, { status: response.status, cacheControl: response.headers.get('cache-control') });
  try { exchange.body = JSON.parse(text); } catch { exchange.body = text; }
  return response;
}) as typeof fetch;

interface Deployment { env: NodeJS.ProcessEnv; analyses: NewsAnalysis[]; store?: MemoryHistoryStore; model?: LlmClient }

/** Starts the real entry with these settings and points the screen at it. Without a model the default ask client is built. */
async function deploy({ env, analyses, store = statsStore(), model }: Deployment): Promise<void> {
  const byId = new Map(analyses.map(item => [item.company.id, item]));
  const service = {
    getAnalysis: async (item: Company) => byId.get(item.id) ?? notConfigured(item),
  } as unknown as Parameters<typeof createApiHandler>[0];
  origin = null;
  // Before the handler exists, so the clients it builds by default can only reach the fake.
  globalThis.fetch = fakeFetch;
  const historyServe = createHistoryServe(env, { store, clock: () => SERVER_NOW });
  const server = createServer(createApiHandler(service, env, { historyServe, ...(model ? { askClients: { gemini: model } } : {}) }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  exchanges = [];
}

const askGets = () => exchanges.filter(item => item.path === '/api/news/ask' && item.method === 'GET');
const askPosts = () => exchanges.filter(item => item.path === '/api/news/ask' && item.method === 'POST');
const askRequests = () => exchanges.filter(item => item.path.startsWith('/api/news/ask'));
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

const findPanel = () => screen.findByRole('region', { name: ASK_TITLE }, WAIT);
const items = (panel: HTMLElement) => Array.from(panel.querySelectorAll<HTMLElement>('.ask-item'));
const texts = (root: ParentNode, selector: string) => Array.from(root.querySelectorAll(selector)).map(node => node.textContent);
const suggestions = (panel: HTMLElement) =>
  within(within(panel).getByRole('group', { name: '추천 질문' })).getAllByRole('button') as HTMLButtonElement[];

/** Waits until the thread holds `count` turns and the newest one has its answer. */
async function settledTurn(panel: HTMLElement, count: number): Promise<HTMLElement> {
  let turn: HTMLElement | undefined;
  await waitFor(() => {
    const all = items(panel);
    assert.equal(all.length, count);
    turn = all.at(-1);
    assert.ok(turn);
    assert.equal(turn.getAttribute('aria-busy'), null);
  }, WAIT);
  return turn!;
}

/** Types a question into the box and presses the send button. */
function ask(panel: HTMLElement, question: string): void {
  fireEvent.change(within(panel).getByLabelText('질문'), { target: { value: question } });
  fireEvent.click(within(panel).getByRole('button', { name: '질문하기' }));
}

/** The element children of the news column, as tag and classes. */
const columns = () => Array.from(document.querySelector('.news-main')!.children).map(node => `${node.tagName}.${Array.from(node.classList).join('.')}`);

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

/** The answer the server sent for the n-th question, with its status and cache header. */
function sentAnswer(index: number): { status: number; body: AskAnswer; cacheControl: string | null } {
  const post = askPosts()[index];
  assert.ok(post, `question ${index + 1} was sent`);
  return { status: post.status, body: post.body as AskAnswer, cacheControl: post.cacheControl };
}

/** An answered turn as the screen shows it: the label, this exact text, and the limits the server sent. */
function assertAnswered(turn: HTMLElement, body: AskAnswer, label: string, text: string): Extract<AskAnswer, { status: 'answered' }> {
  assert.equal(body.status, 'answered');
  const answered = body as Extract<AskAnswer, { status: 'answered' }>;
  assert.equal(turn.querySelector('.ask-answer-label')?.textContent, label);
  assert.equal(answered.text, text);
  assert.equal(turn.querySelector('.ask-answer')?.textContent, text);
  assert.deepEqual(texts(turn, '.ask-limits li'), answered.limits);
  return answered;
}

const linksOf = (turn: HTMLElement) => Array.from(turn.querySelectorAll<HTMLAnchorElement>('.ask-evidence a'))
  .map(link => [link.getAttribute('href'), link.textContent, link.target, link.rel]);

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  resetHistoryInsightCache();
  resetAskPanelCache();
  elsewhere = [];
  logged = [];
  for (const level of ['log', 'warn'] as const) {
    console[level] = (...parts: unknown[]) => {
      const line = parts.map(String).join(' ');
      if (line.startsWith('news_ask ')) logged.push(line);
      else realConsole[level](...parts);
    };
  }
});

afterEach(() => {
  cleanup();
  Object.assign(console, realConsole);
  globalThis.fetch = realFetch;
  origin = null;
  for (const server of servers) { server.closeAllConnections(); server.close(); }
  servers = [];
});
after(() => dom.window.close());

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('end to end, off as in production today: no hint, no question request and the news column as before; on, the panel sits below an unchanged analysis card', async () => {
  const analysis = readyAnalysis('nasdaq:TSLA', UNCACHED_VERSION);
  const unused = () => scriptedModel([{ ...FIELDS, action: 'answer', text: '쓰이지 않는 답입니다.' }]);
  const variants: Array<[string, NodeJS.ProcessEnv, ReturnType<typeof scriptedModel> | undefined]> = [
    ['unset', {}, undefined],
    // The default ask client reads NEWS_ASK_GEMINI_API_KEY only: gemini without it stays off, and the key alone turns nothing on.
    ['gemini without its own key', { NEWS_ASK_PROVIDERS: 'gemini', GEMINI_API_KEY: 'test-news-key-e2e' }, undefined],
    ['the key without the switch', { NEWS_ASK_GEMINI_API_KEY: 'test-ask-key-e2e' }, undefined],
    ['cloudflare', { NEWS_ASK_PROVIDERS: 'cloudflare' }, unused()],
  ];
  const bodies: string[] = [];
  const cards: string[] = [];
  for (const [name, env, model] of variants) {
    await deploy({ env, analyses: [analysis], ...(model ? { model } : {}) });
    const view = await openCompany(/테슬라/);
    await screen.findByRole('heading', { name: SUMMARY }, WAIT);
    await settle();
    const [news] = newsRequests('nasdaq:TSLA');
    assert.ok(news, name);
    assert.equal(Object.hasOwn(news.body as object, 'askAvailable'), false, name);
    bodies.push(JSON.stringify(news.body));
    assert.deepEqual(askRequests(), [], name);
    assert.equal(screen.queryByText(ASK_TITLE), null, name);
    assert.equal(document.querySelector('.ask-card'), null, name);
    // The news column holds what it held before this feature: the analysis card and the investment notice.
    assert.deepEqual(columns(), ['SECTION.card.analysis-card', 'DIV.investment-notice'], name);
    cards.push(document.querySelector('.analysis-card')!.innerHTML);
    assert.equal(model?.prompts.length ?? 0, 0, name);
    view.unmount();
  }
  assert.equal(new Set(bodies).size, 1, 'every way of being off serves the same /api/news body');
  assert.equal(new Set(cards).size, 1);

  // On: the hint brings the panel below the same analysis card, and nothing reaches the model until a question is sent.
  const model = unused();
  await deploy({ env: { NEWS_ASK_PROVIDERS: 'gemini' }, analyses: [analysis], model });
  await openCompany(/테슬라/);
  const panel = await findPanel();
  await settle();
  assert.equal((newsRequests('nasdaq:TSLA')[0]!.body as NewsAnalysis).askAvailable, true);
  assert.deepEqual(columns(), ['SECTION.card.analysis-card', 'SECTION.card.ask-card', 'DIV.investment-notice']);
  assert.equal(panel.previousElementSibling, document.querySelector('.analysis-card'));
  assert.equal(document.querySelector('.analysis-card')!.innerHTML, cards[0]);
  assert.deepEqual(askRequests().map(item => [item.method, item.status, item.cacheControl]), [['GET', 200, 'no-store']]);
  assert.equal(model.prompts.length, 0);
  assert.deepEqual(logged, []);
  assert.deepEqual(elsewhere, []);
});

test('end to end, on: the hint reaches the screen through the news cache, availability is asked once, and questions come back with code-filled values', async () => {
  const analysis = readyAnalysis('krx:035420', NEWS_CACHE_ANALYSIS_VERSION);
  const model = scriptedModel([prompt => ({
    ...FIELDS, action: 'answer',
    text: `현재 분석 상태는 '{${factId(prompt, '현재 분석 상태')}}'이고 관련 기사는 {${factId(prompt, '관련 기사 수')}}입니다.`,
    // Only ids the model was shown become links: A9 and C1 were never in its context.
    evidence: ['A2', 'A1', 'A9', 'C1'],
  })]);
  await deploy({ env: { NEWS_ASK_PROVIDERS: 'gemini' }, analyses: [analysis], model });
  await openCompany(/NAVER/);
  const panel = await findPanel();

  // The server added the hint, and the browser's news cache kept it with the analysis.
  const [news] = newsRequests('krx:035420');
  assert.equal((news!.body as NewsAnalysis).askAvailable, true);
  const persisted = persistedAnalyses('krx:035420');
  assert.ok(persisted.length > 0, 'the analysis was cached');
  assert.ok(persisted.every(item => item.askAvailable === true));
  await settle();
  assert.deepEqual(askRequests().map(item => [item.method, item.path]), [['GET', '/api/news/ask']]);
  assert.deepEqual(askGets()[0]!.body, { version: NEWS_ASK_VERSION, enabled: true, providers: [{ id: 'gemini', label: 'Google Gemini' }], maxLength: 300 });

  // A suggestion goes out as the company and the question only, and comes back filled in by the server.
  const [suggestion] = suggestions(panel);
  const question = suggestion!.textContent!;
  fireEvent.click(suggestion!);
  const turn = await settledTurn(panel, 1);
  const first = sentAnswer(0);
  assert.deepEqual(askPosts()[0]!.sent, { companyId: 'krx:035420', question });
  assert.deepEqual([first.status, first.cacheControl], [200, 'no-store']);
  const answered = assertAnswered(turn, first.body, ASK_LABEL, "현재 분석 상태는 '뉴스 참고 · 불확실성 존재'이고 관련 기사는 2건입니다.");
  assert.equal(turn.querySelector('.ask-question')?.textContent, question);
  assert.equal(answered.limits[0], ASK_ANSWER_NOTE);
  assert.deepEqual(linksOf(turn), [
    ['https://publisher.example.test/035420-b', '테스트 전용 기사 035420-b', '_blank', 'noopener noreferrer'],
    ['https://publisher.example.test/035420-a', '테스트 전용 기사 035420-a', '_blank', 'noopener noreferrer'],
  ]);
  const year = new Date(Date.now() + 9 * HOUR).getUTCFullYear();
  assert.deepEqual(texts(turn, '.ask-evidence li span'), answered.evidence.map(item => askEvidenceMeta(item, year)));

  // The model got the question as data only and never a value it cited: the server filled those in.
  assert.equal(model.prompts.length, 1);
  const prompt = model.prompts[0]!;
  assert.equal(inputOf(prompt).question, question);
  assert.equal(prompt.system.includes(question), false);
  assert.deepEqual(inputOf(prompt).context.map(item => item.tool), ['get_outlook', 'get_articles']);
  for (const value of ['2건', '뉴스 참고 · 불확실성 존재', SUMMARY]) assert.equal(prompt.user.includes(value), false, value);

  // Advice is refused by code before any model call, with what can be asked instead; Enter sends.
  fireEvent.change(within(panel).getByLabelText('질문'), { target: { value: '지금 사도 될까요?' } });
  fireEvent.keyDown(within(panel).getByLabelText('질문'), { key: 'Enter' });
  const refusal = await settledTurn(panel, 2);
  assert.deepEqual(askPosts()[1]!.sent, { companyId: 'krx:035420', question: '지금 사도 될까요?' });
  assert.deepEqual([sentAnswer(1).status, sentAnswer(1).body], [200, { version: NEWS_ASK_VERSION, status: 'refused', companyId: 'krx:035420', reason: 'advice' }]);
  assert.deepEqual(texts(refusal, '.ask-state'), [ASK_REFUSAL_TEXTS.advice, ASK_REFUSAL_LEAD]);
  assert.equal(within(refusal).getAllByRole('button').length, 4);
  assert.equal(model.prompts.length, 1);

  // Availability was asked once; the analysis card is in place; the log holds one fixed line per question.
  assert.equal(askGets().length, 1);
  assert.ok(screen.getByRole('heading', { name: SUMMARY }));
  assert.deepEqual(logged, [
    'news_ask status=answered by=ai reason=- calls=1 tools=0 note=-',
    'news_ask status=refused by=- reason=advice calls=0 tools=0 note=-',
  ]);
  assert.deepEqual(elsewhere, []);
});

test('end to end, on with the outlook and a market without permission: a tool call goes through the real history route, the statistics stay private, and the answer names the card on screen', async () => {
  const store = statsStore();
  const model = scriptedModel([
    toolReply('get_history'),
    toolReply('explain_term', { term: 'stats_not_public' }),
    prompt => ({
      ...FIELDS, action: 'answer',
      text: `{${factId(prompt, '다음 거래일 · 카드 제목')}} 카드는 '{${factId(prompt, '다음 거래일 · 통합 전망')}}'입니다. {${factId(prompt, '용어 풀이')}}`,
    }),
  ]);
  await deploy({ env: { NEWS_ASK_PROVIDERS: 'gemini', HISTORY_INSIGHTS: 'on' }, analyses: [readyAnalysis('krx:005380', NEWS_CACHE_ANALYSIS_VERSION)], store, model });
  await openCompany(/현대자동차/);
  const section = await screen.findByRole('region', { name: '전망 한눈에 보기' }, WAIT);
  await waitFor(() => assert.equal(section.querySelectorAll('.history-card').length, 2), WAIT);
  const panel = await findPanel();
  const day = section.querySelector<HTMLElement>('.history-card')!;
  const title = day.querySelector('.history-card-title')!.textContent!;
  const signal = day.querySelector('.history-signal')!.textContent!;
  assert.deepEqual([title, signal], ['다음 거래일 · 11/24(화)', '상승 전망']);

  ask(panel, '과거 사례 통계는 왜 보이지 않나요?');
  const turn = await settledTurn(panel, 1);
  const { status, body } = sentAnswer(0);
  assert.equal(status, 200);
  const term = ASK_TERMS.stats_not_public;
  const answered = assertAnswered(turn, body, ASK_LABEL, `${title} 카드는 '${signal}'입니다. ${term.label}: ${term.text}`);
  assert.ok(answered.limits.includes(STATS_NOT_PUBLIC_MESSAGE));

  // Three calls: the history tool answered exactly "private", then the dictionary entry came, then the answer.
  assert.equal(model.prompts.length, 3);
  assert.deepEqual(inputOf(model.prompts[1]!).context.at(-1), { tool: 'get_history', status: 'private' });
  const explained = inputOf(model.prompts[2]!).context.at(-1)!;
  assert.deepEqual([explained.tool, explained.status, explained.term, explained.label, explained.text], ['explain_term', 'ok', 'stats_not_public', term.label, term.text]);
  // The outlook name and the card's date reached the screen through the fact table only.
  for (const prompt of model.prompts) for (const value of [signal, '11/24(화)']) assert.equal(prompt.user.includes(value), false, value);
  // A market without permission causes no stats.json read: neither the cards nor the question read one.
  assert.deepEqual(store.reads, []);
  assert.equal(historyRequests().length, 1);
  assert.equal(askGets().length, 1);
  assert.deepEqual(logged, ['news_ask status=answered by=ai reason=- calls=3 tools=2 note=-']);
  assert.deepEqual(elsewhere, []);
});

test('end to end, on with KR public: the figures in an answer come from stats.json through the fact table, and the model never sees one', async () => {
  const store = statsStore();
  const model = scriptedModel([
    toolReply('get_history', { horizon: 'week', direction: 'positive' }),
    toolReply('get_cases', { horizon: 'week', direction: 'positive' }),
    prompt => ({
      ...FIELDS, action: 'answer',
      text: `과거 비슷한 긍정 뉴스 뒤 상승 비중은 {${factId(prompt, '다음 주 · 긍정 방향 · 과거 상승 비중')}}이고 ` +
        `겹치지 않는 구간은 {${factId(prompt, '다음 주 · 긍정 방향 · 겹치지 않는 구간 수')}}입니다.`,
      evidence: ['C1'],
    }),
  ]);
  await deploy({
    env: { NEWS_ASK_PROVIDERS: 'gemini', HISTORY_INSIGHTS: 'on', HISTORY_PUBLIC_MARKETS: 'KR' },
    analyses: [readyAnalysis('krx:000660', NEWS_CACHE_ANALYSIS_VERSION)], store, model,
  });
  await openCompany(/SK하이닉스/);
  const section = await screen.findByRole('region', { name: '전망 한눈에 보기' }, WAIT);
  await waitFor(() => assert.equal(section.querySelectorAll('.history-card').length, 2), WAIT);
  const panel = await findPanel();
  // The suggestions follow the history hint the screen got.
  assert.equal(suggestions(panel)[1]!.textContent, '과거 비슷한 뉴스 뒤에는 어땠나요?');

  fireEvent.click(suggestions(panel)[1]!);
  const turn = await settledTurn(panel, 1);
  const { status, body } = sentAnswer(0);
  assert.equal(status, 200);
  // Six of the twelve labelled cases went up; the qualifier travels with the figure.
  const share = `${formatShare(6 / 12)}(미래 확률 아님)`;
  const answered = assertAnswered(turn, body, ASK_LABEL, `과거 비슷한 긍정 뉴스 뒤 상승 비중은 ${share}이고 겹치지 않는 구간은 10개입니다.`);
  assert.equal(answered.limits.includes(STATS_NOT_PUBLIC_MESSAGE), false);
  // The past case is the one link, cited by its id; its title never enters the sentence.
  assert.deepEqual(linksOf(turn), [['https://example.com/a', 'Example', '_blank', 'noopener noreferrer']]);
  assert.deepEqual(texts(turn, '.ask-evidence li span'), ['Example News · 10/1(목)']);

  assert.equal(model.prompts.length, 3);
  for (const prompt of model.prompts) {
    assert.equal(prompt.user.includes('%'), false, 'no share, return or difference reaches the model');
    assert.equal(prompt.user.includes('10개'), false);
  }
  // The screen's history request read stats.json once; the question reused that read.
  assert.deepEqual(store.reads, [{ file: 'stats.json', fresh: false }]);
  assert.deepEqual(logged, ['news_ask status=answered by=ai reason=- calls=3 tools=2 note=-']);
  assert.deepEqual(elsewhere, []);
});

test('end to end, failures: an invalid model answer becomes the fixed sentence, and a model failure is a 503 the panel shows in its own turn', async () => {
  const model = scriptedModel([
    { ...FIELDS, action: 'answer', text: '관련 기사 2건을 바탕으로 한 설명입니다.' },
    () => { throw new Error('테스트 전용 모델 장애'); },
  ]);
  await deploy({ env: { NEWS_ASK_PROVIDERS: 'gemini' }, analyses: [readyAnalysis('nasdaq:NVDA', UNCACHED_VERSION)], model });
  await openCompany(/엔비디아/);
  const panel = await findPanel();

  ask(panel, '최근 기사는 주로 어떤 내용인가요?');
  const template = await settledTurn(panel, 1);
  const first = sentAnswer(0);
  assert.equal(first.status, 200);
  const answered = assertAnswered(template, first.body, ASK_TEMPLATE_LABEL,
    "엔비디아의 현재 뉴스 분석은 '뉴스 참고 · 불확실성 존재'이고 근거 수준은 '보통'입니다. 관련 기사 2건을 바탕으로 했습니다. " +
    '자세한 근거는 위 분석 카드의 요인과 기사 목록에서 확인할 수 있습니다.');
  assert.equal(answered.limits[0], ASK_TEMPLATE_NOTE);
  assert.equal(template.querySelector('.ask-evidence'), null);

  ask(panel, "'근거 수준'은 무슨 뜻인가요?");
  const failed = await settledTurn(panel, 2);
  assert.deepEqual([sentAnswer(1).status, sentAnswer(1).cacheControl, sentAnswer(1).body],
    [503, 'no-store', { version: NEWS_ASK_VERSION, status: 'unavailable', reason: 'error' }]);
  assert.deepEqual(texts(failed, '.ask-state'), [ASK_UNAVAILABLE_TEXT]);
  // The failure stays in its own turn: the earlier answer and the analysis card are as they were.
  assert.equal(items(panel)[0], template);
  assert.equal(template.querySelector('.ask-answer-label')?.textContent, ASK_TEMPLATE_LABEL);
  assert.ok(screen.getByRole('heading', { name: SUMMARY }));
  assert.equal(model.prompts.length, 2);
  assert.deepEqual(logged, [
    'news_ask status=answered by=template reason=- calls=1 tools=0 note=digits',
    'news_ask status=unavailable by=- reason=error calls=1 tools=0 note=-',
  ]);
  assert.deepEqual(elsewhere, []);
});
