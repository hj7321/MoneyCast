import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { after, afterEach, beforeEach, test } from 'node:test';
import {
  askEvidenceMeta, askIntro, askInvalidText, askNewsTimeLine, askSuggestions, companies,
  ASK_ANSWER_NOTE, ASK_EMPTY_TEXT, ASK_LABEL, ASK_LOADING_TEXT, ASK_PERSONAL_DATA_TEXT, ASK_PLACEHOLDER, ASK_RATE_LIMITED_TEXTS,
  ASK_REFUSAL_LEAD, ASK_REFUSAL_TEXTS, ASK_TEMPLATE_LABEL, ASK_TEMPLATE_NOTE, ASK_TOO_LONG_TEXT, ASK_UNAVAILABLE_TEXT,
  NEWS_ASK_VERSION, NEWS_CACHE_ANALYSIS_VERSION,
  type AskAnswer, type AskAvailability, type AskEvidence, type AskInvalidReason, type AskRefusalReason, type NewsAnalysis,
  type NewsArticle,
} from '@moneycast/core';

// "AI에게 물어보기" on the news screen. A separate file and companies that App.test.tsx does not use keep the
// module-level news, history and availability caches apart. Every request goes to a fake fetch; no model is involved.

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
// The repository-level tsx test runner excludes web files from its TS project;
// provide React for those files if its fallback uses the classic JSX transform.
Object.assign(globalThis, { React });
const { render, screen, fireEvent, cleanup, waitFor, within } = await import('@testing-library/react');
const { NewsPanel } = await import('./NewsPanel');
const { resetHistoryInsightCache } = await import('./HistoryInsight');
const { ASK_THREAD_MAX, loadAskAvailability, resetAskPanelCache, sendAskQuestion } = await import('./AskPanel');
const originalFetch = globalThis.fetch;

const HOUR = 3_600_000;
const DEFAULT_ID = companies[0]!.id;
const AAPL = 'nasdaq:AAPL';
const NAVER = 'krx:035420';
/** Only the fallback test uses Hyundai: its current-version result stays in the news cache's memory for the rest of the file. */
const HYUNDAI = 'krx:005380';
const TITLE = 'AI에게 물어보기';
const SUMMARY = '테스트 전용: 현재 기사 기반 요약입니다.';
const PRIVACY = '질문은 AI 제공사(Google)로 전송됩니다. 개인정보를 적지 마세요. 대화는 이 화면에만 남고 새로 고치면 사라집니다.';
const ENABLED: AskAvailability = { version: NEWS_ASK_VERSION, enabled: true, providers: [{ id: 'gemini', label: 'Google Gemini' }], maxLength: 300 };
const DISABLED: AskAvailability = { version: NEWS_ASK_VERSION, enabled: false, providers: [], maxLength: 300 };
const ANSWER_TEXT = '테스트 전용: 최근 7일 긍정 기사 2건이 같은 방향이라 이 판단이 나왔습니다.';
const ARTICLE_EVIDENCE: AskEvidence = {
  title: '테스트 전용 기사 a-1', source: 'publisher.example.test', url: 'https://publisher.example.test/a-1', publishedAt: '2026-11-23T12:00:00.000Z',
};
const CASE_EVIDENCE: AskEvidence = { title: '테스트 전용 과거 사례', source: 'Example News', url: 'https://example.com/case', publishedAt: '2026-10-01' };
const ANSWERED_AS_OF = '2026-11-27T06:00:00.000Z';
const FORBIDDEN = ['확정', '보장', '반드시', '적중', '승률', '정확도', '확률', '오릅니다', '내립니다', '매수 기회', '매도 기회'];
// Existing tests find these texts one at a time; the panel never renders an element that says only this.
const EXISTING_EXACT = ['중립', '긍정', '부정', '호출 제한', '이전 결과', '다시 시도'];

const kstYear = () => new Date(Date.now() + 9 * HOUR).getUTCFullYear();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function catalog(id: string) {
  const company = companies.find(item => item.id === id);
  assert.ok(company, id);
  return { ...company };
}

function article(id: string, sentiment: NewsArticle['sentiment']): NewsArticle {
  return {
    id, title: `테스트 전용 기사 ${id}`, source: 'publisher.example.test', publishedAt: '2026-11-23T12:00:00.000Z',
    url: `https://publisher.example.test/${id}`, sentiment, rationale: '테스트 전용 분류 근거입니다.',
  };
}

/** Seven hours old and of a version the news cache never keeps, so every pick asks the server again. */
function news(id: string, overrides: Partial<NewsAnalysis> = {}): NewsAnalysis {
  return {
    company: catalog(id), status: 'ready',
    articles: [article('a-1', 'positive'), article('a-2', 'positive')],
    asOf: new Date(Date.now() - 7 * HOUR).toISOString(),
    period: { start: '2026-11-30', end: '2026-12-04' }, evidence: 'moderate', summary: SUMMARY,
    positiveFactors: ['테스트 전용 긍정 요인'], negativeFactors: [], risks: ['테스트 전용: 미래 방향은 불확실합니다.'],
    provider: 'Marketaux', analysisVersion: 'news-evidence-test-v1', askAvailable: true,
    ...overrides,
  };
}

function notConfigured(id: string): NewsAnalysis {
  return {
    company: catalog(id), status: 'not_configured', articles: [], asOf: new Date(Date.now() - 7 * HOUR).toISOString(),
    period: { start: '2026-11-30', end: '2026-12-04' }, evidence: 'none', summary: '테스트 전용: 뉴스 제공자가 연결되지 않았습니다.',
    positiveFactors: [], negativeFactors: [], risks: [], provider: null, analysisVersion: 'news-evidence-test-v1',
  };
}

type Answered = Extract<AskAnswer, { status: 'answered' }>;

/** Shaped like the server's answer once it has filled the model's tokens. */
function answered(companyId: string, overrides: Partial<Answered> = {}): Answered {
  return {
    version: NEWS_ASK_VERSION, status: 'answered', companyId, by: 'ai', text: ANSWER_TEXT,
    evidence: [ARTICLE_EVIDENCE, CASE_EVIDENCE], limits: [ASK_ANSWER_NOTE, askNewsTimeLine(ANSWERED_AS_OF, kstYear())],
    asOf: ANSWERED_AS_OF,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fetch routing and screen helpers
// ---------------------------------------------------------------------------

type Reply = Response | Promise<Response>;
interface Posted { body: { companyId: string; question: string }; init: RequestInit | undefined }
interface Calls { news: string[]; askGet: Array<RequestInit | undefined>; askPost: Posted[]; history: string[] }
let calls: Calls = { news: [], askGet: [], askPost: [], history: [] };

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

interface Routes {
  news: (call: number, id: string) => Reply;
  askGet?: (call: number) => Reply;
  askPost?: (call: number, body: Posted['body']) => Reply;
}

/** The default company loaded on mount is always unconfigured; the other routes are the test's, and anything else fails. */
function serve(routes: Routes): void {
  calls = { news: [], askGet: [], askPost: [], history: [] };
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const id = url.searchParams.get('companyId') ?? '';
    if (url.pathname === '/api/news/ask') {
      // Recorded before answering, so a request still in flight already counts.
      if ((init?.method ?? 'GET') === 'GET') {
        calls.askGet.push(init);
        if (!routes.askGet) throw new Error('테스트 전용: 예상하지 않은 질문 기능 확인 요청');
        return routes.askGet(calls.askGet.length);
      }
      const body = JSON.parse(String(init?.body)) as Posted['body'];
      calls.askPost.push({ body, init });
      if (!routes.askPost) throw new Error('테스트 전용: 예상하지 않은 질문 요청');
      return routes.askPost(calls.askPost.length, body);
    }
    if (url.pathname === '/api/news/history') {
      // Only a fixture with the history hint gets here; the outlook then stays off.
      calls.history.push(id);
      return json({ version: 'news-history-v1', companyId: id, status: 'off' });
    }
    if (url.pathname === '/api/news' && id === DEFAULT_ID) return json(notConfigured(id));
    if (url.pathname === '/api/news') {
      calls.news.push(id);
      return routes.news(calls.news.length, id);
    }
    throw new Error(`테스트 전용: 예상하지 않은 요청 ${url.pathname}`);
  }) as typeof fetch;
}

async function openCompany(name: RegExp) {
  const view = render(React.createElement(NewsPanel));
  await screen.findByText('데이터 연동 대기');
  fireEvent.click(screen.getByRole('button', { name }));
  return view;
}

const findPanel = () => screen.findByRole('region', { name: TITLE });
const currentPanel = () => screen.getByRole('region', { name: TITLE });
const box = (panel: HTMLElement) => within(panel).getByLabelText('질문') as HTMLTextAreaElement;
const submitButton = (panel: HTMLElement) => within(panel).getByRole('button', { name: '질문하기' }) as HTMLButtonElement;
const mainSuggestions = (panel: HTMLElement) =>
  within(within(panel).getByRole('group', { name: '추천 질문' })).getAllByRole('button') as HTMLButtonElement[];
const items = (panel: HTMLElement) => Array.from(panel.querySelectorAll<HTMLElement>('.ask-item'));
const texts = (root: ParentNode, selector: string) => Array.from(root.querySelectorAll(selector)).map(node => node.textContent);
const errorText = (panel: HTMLElement) => panel.querySelector('#ask-error')?.textContent;

/** Types a question into the box and presses the send button. */
function ask(panel: HTMLElement, question: string): void {
  fireEvent.change(box(panel), { target: { value: question } });
  fireEvent.click(submitButton(panel));
}

/** Waits until the thread holds `count` turns and the newest one has its answer. */
async function settledTurn(panel: HTMLElement, count: number): Promise<HTMLElement> {
  let turn: HTMLElement | undefined;
  await waitFor(() => {
    const all = items(panel);
    assert.equal(all.length, count);
    turn = all.at(-1);
    assert.ok(turn);
    assert.equal(turn.getAttribute('aria-busy'), null);
  });
  return turn!;
}

/** Waits until the panel on screen belongs to the company of that name. */
async function panelFor(name: string): Promise<HTMLElement> {
  await waitFor(() => assert.equal(currentPanel().querySelector('.ask-intro')?.textContent, askIntro(name)));
  return currentPanel();
}

/** Lets effects and any stray request run before counting requests. */
const settle = () => new Promise(resolve => setTimeout(resolve, 30));

/** Nothing was sent. Asserted on a parameter, so the live call list keeps its type for the reads that follow. */
function assertNone(list: readonly unknown[], label?: string): void {
  assert.deepEqual(list, [], label);
}

/** The panel's own text: no arrow, no wording the plan rules out, no live role, no element that existing tests look for. */
function assertCleanText(panel: HTMLElement): void {
  const text = panel.textContent ?? '';
  assert.doesNotMatch(text, /[←-⇿▲▼]/);
  for (const word of FORBIDDEN) assert.equal(text.includes(word), false, `"${word}" in the panel`);
  assert.equal(panel.querySelector('[role="status"], [role="alert"]'), null);
  for (const element of Array.from(panel.querySelectorAll('*'))) {
    assert.equal(EXISTING_EXACT.includes((element.textContent ?? '').trim()), false, element.outerHTML);
  }
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  resetAskPanelCache();
  resetHistoryInsightCache();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
after(() => dom.window.close());

// ---------------------------------------------------------------------------
// When the panel asks the server at all
// ---------------------------------------------------------------------------

test('without the hint the screen renders as before and never asks the question service', async () => {
  const plain = news(AAPL);
  delete plain.askAvailable;
  const markup: string[] = [];
  for (const value of [plain, { ...plain, askAvailable: false }]) {
    serve({ news: () => json(value), askGet: () => json(ENABLED) });
    const view = await openCompany(/애플/);
    await screen.findByRole('heading', { name: SUMMARY });
    await settle();
    assertNone(calls.askGet);
    assertNone(calls.askPost);
    assert.equal(screen.queryByText(TITLE), null);
    assert.equal(document.querySelector('.ask-card'), null);
    markup.push(document.querySelector('.news-main')!.innerHTML);
    view.unmount();
  }
  assert.equal(markup[0], markup[1]);
});

test('a hint on an unconfigured, failed, rate-limited or stale analysis makes no question request', async () => {
  const failed = (status: NewsAnalysis['status']): Partial<NewsAnalysis> => ({
    status, articles: [], positiveFactors: [], evidence: 'none', message: `테스트 전용: ${status} 상태 안내`,
  });
  const cases: Array<[string, Partial<NewsAnalysis>, string]> = [
    ['not_configured', failed('not_configured'), '테스트 전용: not_configured 상태 안내'],
    ['error', failed('error'), '테스트 전용: error 상태 안내'],
    ['rate_limited', failed('rate_limited'), '테스트 전용: rate_limited 상태 안내'],
    ['stale', { servedFrom: 'stale', refreshAttemptedAt: new Date().toISOString(), message: '테스트 전용: 모든 출처가 응답하지 않았습니다.' }, '이전 결과'],
  ];
  for (const [label, overrides, shown] of cases) {
    serve({ news: () => json(news(AAPL, overrides)), askGet: () => json(ENABLED) });
    const view = await openCompany(/애플/);
    await screen.findByText(shown);
    await settle();
    assertNone(calls.askGet, label);
    assert.equal(document.querySelector('.ask-card'), null, label);
    view.unmount();
  }
});

test('an off, failed, timed-out or malformed availability answer renders nothing after one request, and no later company asks again', async () => {
  const replies: Array<[string, () => Reply]> = [
    ['off', () => json(DISABLED)],
    ['server error', () => json({ error: '테스트 전용 실패' }, 500)],
    ['network error', () => Promise.reject(new TypeError('테스트 전용 연결 실패'))],
    ['timeout', () => Promise.reject(new DOMException('timeout', 'TimeoutError'))],
    ['not JSON', () => new Response('<html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } })],
    ['another version', () => json({ ...ENABLED, version: 'news-ask-v0' })],
    ['on without a provider', () => json({ ...ENABLED, providers: [] })],
  ];
  for (const [label, reply] of replies) {
    resetAskPanelCache();
    serve({ news: (_call, id) => json(news(id)), askGet: reply });
    const view = await openCompany(/애플/);
    await screen.findByRole('heading', { name: SUMMARY });
    await waitFor(() => assert.equal(calls.askGet.length, 1, label));
    await settle();
    assert.equal(document.querySelector('.ask-card'), null, label);
    assert.ok(calls.askGet[0]?.signal instanceof AbortSignal, label);
    fireEvent.click(screen.getByRole('button', { name: /NAVER/ }));
    await waitFor(() => assert.deepEqual(calls.news, [AAPL, NAVER], label));
    await screen.findByRole('heading', { name: SUMMARY });
    await settle();
    assert.equal(calls.askGet.length, 1, label);
    assert.equal(document.querySelector('.ask-card'), null, label);
    view.unmount();
  }
});

test('loadAskAvailability asks once per page and keeps a failure as off', async () => {
  serve({ news: () => json(news(AAPL)), askGet: () => Promise.reject(new TypeError('테스트 전용 연결 실패')) });
  const first = loadAskAvailability();
  assert.equal(loadAskAvailability(), first, 'one request per page');
  assert.deepEqual(await first, DISABLED);
  assert.deepEqual(await loadAskAvailability(), DISABLED);
  assert.equal(calls.askGet.length, 1);
  resetAskPanelCache();
  serve({ news: () => json(news(AAPL)), askGet: () => json({ ...ENABLED, note: '테스트 전용 추가 필드' }) });
  assert.deepEqual(await loadAskAvailability(), ENABLED, 'rebuilt by the shared parser, without unknown fields');
  assert.equal(calls.askGet.length, 1);
});

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

test('an on answer shows the panel between the analysis card and the investment notice, with its intro, privacy line and four suggestions', async () => {
  serve({ news: (_call, id) => json(news(id)), askGet: () => json(ENABLED) });
  await openCompany(/애플/);
  const panel = await findPanel();
  assert.ok(panel.matches('section.card.ask-card'));
  assert.ok(panel.parentElement?.matches('.news-main'));
  assert.ok(panel.previousElementSibling?.matches('section.analysis-card'), 'below the analysis card');
  assert.ok(panel.nextElementSibling?.matches('.investment-notice'), 'above the investment notice');
  assert.ok(within(panel).getByRole('heading', { level: 2, name: TITLE }));
  assert.equal(panel.querySelector('.ask-intro')?.textContent, askIntro('애플'));
  assert.equal(panel.querySelector('#ask-privacy')?.textContent, PRIVACY);
  const suggestions = mainSuggestions(panel);
  assert.deepEqual(suggestions.map(button => button.textContent), askSuggestions(news(AAPL)));
  assert.equal(new Set(suggestions.map(button => button.textContent)).size, 4);
  for (const button of suggestions) assert.equal(button.type, 'button');
  assert.deepEqual(items(panel), []);
  assert.ok(screen.getByRole('heading', { name: SUMMARY }), 'the analysis card is in place');
  assertCleanText(panel);
  assert.equal(calls.askGet.length, 1);
  assert.equal(calls.askGet[0]?.method, undefined);
  assert.ok(calls.askGet[0]?.signal instanceof AbortSignal);

  // Every company remounts the panel for itself; availability is asked once per page.
  fireEvent.click(screen.getByRole('button', { name: /NAVER/ }));
  await panelFor('NAVER');
  fireEvent.click(screen.getByRole('button', { name: /애플/ }));
  await panelFor('애플');
  await settle();
  assert.deepEqual(calls.news, [AAPL, NAVER, AAPL]);
  assert.equal(calls.askGet.length, 1);
  assertNone(calls.askPost);
});

test('the four suggestions follow the analysis on screen: withheld or with a direction, with or without past cases', async () => {
  const variants: Array<[Partial<NewsAnalysis>, string[] | null]> = [
    [{}, ['이 판단은 어떤 기사에서 나왔나요?', '최근 기사는 주로 어떤 내용인가요?', "'근거 수준'은 무슨 뜻인가요?", '이 자료는 언제 기준이고 어떤 한계가 있나요?']],
    [{ status: 'insufficient', positiveFactors: [], historyAvailable: true },
      ['왜 판단 유보인가요?', '과거 비슷한 뉴스 뒤에는 어땠나요?', "'시장 대비'가 무슨 뜻인가요?", '이 자료는 언제 기준이고 어떤 한계가 있나요?']],
    [{ negativeFactors: ['테스트 전용 부정 요인'] }, null],
    [{ positiveFactors: [], negativeFactors: ['테스트 전용 부정 요인'], historyAvailable: true }, null],
  ];
  for (const [overrides, literal] of variants) {
    resetAskPanelCache();
    resetHistoryInsightCache();
    const analysis = news(AAPL, overrides);
    serve({ news: () => json(analysis), askGet: () => json(ENABLED) });
    const view = await openCompany(/애플/);
    const panel = await findPanel();
    const shown = mainSuggestions(panel).map(button => button.textContent);
    assert.deepEqual(shown, askSuggestions(analysis), JSON.stringify(overrides));
    if (literal) assert.deepEqual(shown, literal);
    assert.equal(new Set(shown).size, 4);
    view.unmount();
  }
});

test('a question goes out as the company and the trimmed question only, never with earlier turns, under a time limit', async () => {
  serve({ news: (_call, id) => json(news(id)), askGet: () => json(ENABLED), askPost: (_call, body) => json(answered(body.companyId)) });
  await openCompany(/애플/);
  const panel = await findPanel();
  ask(panel, '  최근 기사는 주로 어떤 내용인가요?\n');
  await settledTurn(panel, 1);
  ask(panel, '두 번째 질문입니다');
  await settledTurn(panel, 2);
  assert.deepEqual(calls.askPost.map(item => item.body), [
    { companyId: AAPL, question: '최근 기사는 주로 어떤 내용인가요?' },
    { companyId: AAPL, question: '두 번째 질문입니다' },
  ]);
  for (const { init } of calls.askPost) {
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('content-type'), 'application/json');
    assert.ok(init?.signal instanceof AbortSignal);
  }
  assert.equal(calls.askGet.length, 1);
});

test('a suggestion sends its own question at once, leaves a question being typed in the box and keeps focus there', async () => {
  serve({ news: () => json(news(AAPL)), askGet: () => json(ENABLED), askPost: (_call, body) => json(answered(body.companyId)) });
  await openCompany(/애플/);
  const panel = await findPanel();
  const input = box(panel);
  const draft = '테스트 전용 작성 중인 질문';
  fireEvent.change(input, { target: { value: draft } });
  fireEvent.click(mainSuggestions(panel)[2]!);
  const [pending] = items(panel);
  assert.equal(pending?.getAttribute('aria-busy'), 'true');
  assert.equal(document.activeElement, input);
  const turn = await settledTurn(panel, 1);
  assert.deepEqual(calls.askPost.map(item => item.body), [{ companyId: AAPL, question: askSuggestions(news(AAPL))[2] }]);
  assert.equal(turn.querySelector('.ask-question')?.textContent, askSuggestions(news(AAPL))[2]);
  assert.equal(input.value, draft);
  assert.equal(panel.querySelector('#ask-count')?.textContent, `${draft.length}/300`);
  assert.equal(errorText(panel), '');
});

/** A click as a pointer reports it: a click count in detail, and pointerType, which jsdom's MouseEvent lacks. */
function pointerClick(target: HTMLElement, pointerType: string): void {
  const event = new window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  fireEvent(target, event);
}

test('a tap on a suggestion leaves focus alone, so a phone keeps its on-screen keyboard closed, while a mouse click, Enter or Space moves focus into the box', async () => {
  serve({
    news: () => json(news(AAPL)), askGet: () => json(ENABLED),
    askPost: (call, body) => json(call === 1
      ? { version: NEWS_ASK_VERSION, status: 'refused', companyId: body.companyId, reason: 'off_topic' }
      : answered(body.companyId)),
  });
  await openCompany(/애플/);
  const panel = await findPanel();
  const input = box(panel);
  const suggestions = askSuggestions(news(AAPL));
  // A phone focuses the button it taps; the box must not take focus from it.
  const tapped = mainSuggestions(panel)[1]!;
  tapped.focus();
  pointerClick(tapped, 'touch');
  assert.equal(items(panel)[0]?.getAttribute('aria-busy'), 'true');
  assert.notEqual(document.activeElement, input, 'a tap does not focus the box');
  let turn = await settledTurn(panel, 1);
  assert.notEqual(document.activeElement, input);
  // The suggestions under a refusal follow the same rule, as does a click whose pointer the browser does not name.
  const offered = within(turn).getByRole('group', { name: ASK_REFUSAL_LEAD });
  fireEvent.click(within(offered).getAllByRole('button')[2]!, { detail: 1 });
  assert.notEqual(document.activeElement, input);
  turn = await settledTurn(panel, 2);
  assert.equal(turn.querySelector('.ask-answer')?.textContent, ANSWER_TEXT);
  // A mouse click, and Enter or Space on the button (no click count), move focus into the box.
  pointerClick(mainSuggestions(panel)[3]!, 'mouse');
  assert.equal(document.activeElement, input, 'a mouse click moves focus into the box');
  await settledTurn(panel, 3);
  const pressed = mainSuggestions(panel)[0]!;
  pressed.focus();
  fireEvent.click(pressed, { detail: 0 });
  assert.equal(document.activeElement, input, 'keyboard activation moves focus into the box');
  await settledTurn(panel, 4);
  assert.deepEqual(calls.askPost.map(item => item.body), [1, 2, 3, 0].map(index => ({ companyId: AAPL, question: suggestions[index] })));
});

test('an AI answer shows its label, the text, its evidence links with source and time, and the limits', async () => {
  const reply = answered(AAPL);
  serve({ news: () => json(news(AAPL)), askGet: () => json(ENABLED), askPost: () => json(reply) });
  await openCompany(/애플/);
  const panel = await findPanel();
  const question = askSuggestions(news(AAPL))[0]!;
  fireEvent.click(mainSuggestions(panel)[0]!);
  const turn = await settledTurn(panel, 1);
  assert.deepEqual(calls.askPost.map(item => item.body), [{ companyId: AAPL, question }]);
  assert.equal(turn.querySelector('.ask-question')?.textContent, question);
  assert.equal(turn.querySelector('.ask-answer-label')?.textContent, ASK_LABEL);
  assert.equal(turn.querySelector('.ask-answer')?.textContent, ANSWER_TEXT);
  const evidence = turn.querySelector<HTMLElement>('.ask-evidence');
  assert.ok(evidence);
  assert.ok(within(evidence).getByRole('heading', { level: 3, name: '근거 기사' }));
  assert.deepEqual(within(evidence).getAllByRole('link').map(link => [
    link.textContent, link.getAttribute('href'), link.getAttribute('target'), link.getAttribute('rel'),
  ]), [
    [ARTICLE_EVIDENCE.title, ARTICLE_EVIDENCE.url, '_blank', 'noopener noreferrer'],
    [CASE_EVIDENCE.title, CASE_EVIDENCE.url, '_blank', 'noopener noreferrer'],
  ]);
  const meta = texts(evidence, 'li > span');
  assert.deepEqual(meta, [askEvidenceMeta(ARTICLE_EVIDENCE, kstYear()), askEvidenceMeta(CASE_EVIDENCE, kstYear())]);
  // An article gives its KST time; a past case gives its session date only.
  assert.match(meta[0]!, /^publisher\.example\.test · .+ KST$/);
  assert.equal(meta[1], 'Example News · 10/1(목)');
  assert.deepEqual(texts(turn, '.ask-limits li'), reply.limits);
  assert.deepEqual(texts(turn, '.ask-state'), []);
  assert.equal(turn.getAttribute('aria-busy'), null);
});

test('a template answer is labelled as fixed text and has no evidence block when it cites nothing', async () => {
  const reply = answered(AAPL, {
    by: 'template', text: '테스트 전용: 정해진 문장으로 만든 답입니다.', evidence: [],
    limits: [ASK_TEMPLATE_NOTE, askNewsTimeLine(ANSWERED_AS_OF, kstYear())],
  });
  serve({ news: () => json(news(AAPL)), askGet: () => json(ENABLED), askPost: () => json(reply) });
  await openCompany(/애플/);
  const panel = await findPanel();
  ask(panel, '왜 이런 판단이 나왔나요?');
  const turn = await settledTurn(panel, 1);
  assert.equal(turn.querySelector('.ask-answer-label')?.textContent, ASK_TEMPLATE_LABEL);
  assert.equal(turn.querySelector('.ask-answer')?.textContent, '테스트 전용: 정해진 문장으로 만든 답입니다.');
  assert.equal(turn.querySelector('.ask-evidence'), null);
  assert.deepEqual(texts(turn, '.ask-limits li'), reply.limits);
  assert.equal(texts(turn, '.ask-limits li')[0], ASK_TEMPLATE_NOTE);
});

test('each refusal shows its fixed text, then what can be asked with the same four suggestions, which send at once', async () => {
  const reasons: AskRefusalReason[] = ['advice', 'target_price', 'personal', 'other_company', 'unlisted_company', 'off_topic'];
  serve({
    news: () => json(news(AAPL)), askGet: () => json(ENABLED),
    askPost: (call, body) => json(call <= reasons.length
      ? { version: NEWS_ASK_VERSION, status: 'refused', companyId: body.companyId, reason: reasons[call - 1] }
      : answered(body.companyId)),
  });
  await openCompany(/애플/);
  const panel = await findPanel();
  const suggestions = askSuggestions(news(AAPL));
  for (const [index, reason] of reasons.entries()) {
    ask(panel, `테스트 전용 질문: ${reason}`);
    const turn = await settledTurn(panel, index + 1);
    assert.deepEqual(texts(turn, '.ask-state'), [ASK_REFUSAL_TEXTS[reason], ASK_REFUSAL_LEAD], reason);
    const group = within(turn).getByRole('group', { name: ASK_REFUSAL_LEAD });
    assert.deepEqual(within(group).getAllByRole('button').map(button => button.textContent), suggestions, reason);
    assert.equal(turn.querySelector('.ask-answer, .ask-answer-label, .ask-evidence'), null, reason);
  }
  assertCleanText(panel);
  // A suggestion under a refusal sends that question at once.
  const group = within(items(panel).at(-1)!).getByRole('group', { name: ASK_REFUSAL_LEAD });
  fireEvent.click(within(group).getAllByRole('button')[1]!);
  const turn = await settledTurn(panel, reasons.length + 1);
  assert.equal(calls.askPost.at(-1)?.body.question, suggestions[1]);
  assert.equal(turn.querySelector('.ask-answer')?.textContent, ANSWER_TEXT);
});

test('an unavailable or unconfigured service, a malformed answer, a network error and a timeout show only the unavailable line in their own turn', async () => {
  const replies: Array<[string, () => Reply]> = [
    ['model limit', () => json({ version: NEWS_ASK_VERSION, status: 'unavailable', reason: 'model_limit' }, 503)],
    ['news unavailable', () => json({ version: NEWS_ASK_VERSION, status: 'unavailable', reason: 'news_unavailable' }, 503)],
    ['not configured', () => json({ version: NEWS_ASK_VERSION, status: 'not_configured' }, 503)],
    ['another company', () => json(answered(NAVER))],
    ['another version', () => json({ ...answered(AAPL), version: 'news-ask-v0' })],
    ['plain http link', () => json(answered(AAPL, { evidence: [{ ...ARTICLE_EVIDENCE, url: 'http://publisher.example.test/a-1' }] }))],
    ['unknown status', () => json({ version: NEWS_ASK_VERSION, status: 'guaranteed' })],
    ['not JSON', () => new Response('<html>Bad gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } })],
    ['network error', () => Promise.reject(new TypeError('테스트 전용 연결 실패'))],
    ['timeout', () => Promise.reject(new DOMException('timeout', 'TimeoutError'))],
  ];
  assert.ok(replies.length <= ASK_THREAD_MAX);
  serve({ news: () => json(news(AAPL)), askGet: () => json(ENABLED), askPost: call => replies[call - 1]![1]() });
  await openCompany(/애플/);
  const panel = await findPanel();
  for (const [index, [label]] of replies.entries()) {
    ask(panel, `테스트 전용 질문: ${label}`);
    const turn = await settledTurn(panel, index + 1);
    assert.deepEqual(texts(turn, '.ask-state'), [ASK_UNAVAILABLE_TEXT], label);
    assert.equal(turn.querySelector('.ask-answer, .ask-answer-label, .ask-evidence, .ask-limits'), null, label);
  }
  assert.equal(calls.askPost.length, replies.length);
  assert.ok(calls.askPost.every(item => item.init?.signal instanceof AbortSignal));
  // Nothing outside the panel changed, and the panel still takes questions.
  assert.ok(screen.getByRole('heading', { name: SUMMARY }));
  assert.equal(document.querySelector('.analysis-card .empty-state'), null);
  assert.equal(screen.queryByRole('alert'), null);
  assertCleanText(panel);
  fireEvent.change(box(panel), { target: { value: '다시 물어봅니다' } });
  assert.equal(submitButton(panel).disabled, false);
});

test('sendAskQuestion reads the body whatever the HTTP status and tells a timeout from other failures', async () => {
  const replies: Array<() => Reply> = [
    () => json({ version: NEWS_ASK_VERSION, status: 'rate_limited', scope: 'daily', retryAt: '2026-11-28T00:00:00.000Z', note: '테스트 전용 추가 필드' }, 429),
    () => json({ version: NEWS_ASK_VERSION, status: 'not_configured' }, 503),
    () => json({ version: NEWS_ASK_VERSION, status: 'refused', companyId: AAPL, reason: 'advice', text: '테스트 전용: 모델 문장은 버립니다' }),
    () => Promise.reject(new DOMException('timeout', 'TimeoutError')),
    () => Promise.reject(new TypeError('테스트 전용 연결 실패')),
    () => new Response('{"version":', { status: 200, headers: { 'Content-Type': 'application/json' } }),
  ];
  serve({ news: () => json(news(AAPL)), askPost: call => replies[call - 1]!() });
  const results: AskAnswer[] = [];
  for (let index = 0; index < replies.length; index += 1) results.push(await sendAskQuestion(AAPL, '테스트 전용 질문'));
  assert.deepEqual(results, [
    { version: NEWS_ASK_VERSION, status: 'rate_limited', scope: 'daily', retryAt: '2026-11-28T00:00:00.000Z' },
    { version: NEWS_ASK_VERSION, status: 'not_configured' },
    { version: NEWS_ASK_VERSION, status: 'refused', companyId: AAPL, reason: 'advice' },
    { version: NEWS_ASK_VERSION, status: 'unavailable', reason: 'timeout' },
    { version: NEWS_ASK_VERSION, status: 'unavailable', reason: 'error' },
    { version: NEWS_ASK_VERSION, status: 'unavailable', reason: 'error' },
  ]);
  assert.deepEqual(calls.askPost.map(item => item.body), Array.from({ length: replies.length }, () => ({ companyId: AAPL, question: '테스트 전용 질문' })));
});

test('the per-person and the daily limit each have their own line', async () => {
  const replies: Array<() => Reply> = [
    () => json({ version: NEWS_ASK_VERSION, status: 'rate_limited', scope: 'ip', retryAt: new Date(Date.now() + 10 * 60_000).toISOString() }, 429),
    () => json({ version: NEWS_ASK_VERSION, status: 'rate_limited', scope: 'daily', retryAt: '2026-11-28T00:00:00.000Z' }, 429),
  ];
  serve({ news: () => json(news(AAPL)), askGet: () => json(ENABLED), askPost: call => replies[call - 1]!() });
  await openCompany(/애플/);
  const panel = await findPanel();
  ask(panel, '테스트 전용 질문: 짧은 시간');
  assert.deepEqual(texts(await settledTurn(panel, 1), '.ask-state'), [ASK_RATE_LIMITED_TEXTS.ip]);
  ask(panel, '테스트 전용 질문: 하루');
  assert.deepEqual(texts(await settledTurn(panel, 2), '.ask-state'), [ASK_RATE_LIMITED_TEXTS.daily]);
  assert.notEqual(ASK_RATE_LIMITED_TEXTS.ip, ASK_RATE_LIMITED_TEXTS.daily);
  assertCleanText(panel);
});

// ---------------------------------------------------------------------------
// Input checks
// ---------------------------------------------------------------------------

test('the box holds 300 characters with a counter, an over-long question never leaves the device, and the server\'s input answers have their lines', async () => {
  const reasons: AskInvalidReason[] = ['too_long', 'empty', 'personal_data', 'too_large', 'bad_request', 'unknown_company'];
  const status = (reason: AskInvalidReason) => reason === 'too_large' ? 413 : reason === 'bad_request' || reason === 'unknown_company' ? 400 : 200;
  serve({
    news: () => json(news(AAPL)), askGet: () => json(ENABLED),
    askPost: call => json({ version: NEWS_ASK_VERSION, status: 'invalid_input', reason: reasons[call - 1] }, status(reasons[call - 1]!)),
  });
  await openCompany(/애플/);
  const panel = await findPanel();
  const input = box(panel);
  const count = () => panel.querySelector('#ask-count')?.textContent;
  assert.equal(input.tagName, 'TEXTAREA');
  assert.equal(input.maxLength, 300);
  assert.equal(input.rows, 2);
  assert.equal(input.placeholder, ASK_PLACEHOLDER);
  assert.equal(count(), '0/300');
  fireEvent.change(input, { target: { value: '가나다' } });
  assert.equal(count(), '3/300');
  // A value longer than the box takes, as a script could set one, is stopped before sending.
  fireEvent.change(input, { target: { value: '가'.repeat(301) } });
  assert.equal(count(), '301/300');
  fireEvent.click(submitButton(panel));
  assert.equal(errorText(panel), ASK_TOO_LONG_TEXT);
  assert.equal(input.value.length, 301);
  await settle();
  assertNone(calls.askPost);
  assert.deepEqual(items(panel), []);

  // Exactly 300 characters go out; the server's answer about the input is shown in the turn.
  ask(panel, '가'.repeat(300));
  assert.equal(errorText(panel), '');
  let turn = await settledTurn(panel, 1);
  assert.equal(calls.askPost[0]?.body.question.length, 300);
  assert.deepEqual(texts(turn, '.ask-state'), [ASK_TOO_LONG_TEXT]);
  for (const [index, reason] of reasons.entries()) {
    if (index === 0) continue;
    ask(panel, `테스트 전용 질문: ${reason}`);
    turn = await settledTurn(panel, index + 1);
    assert.deepEqual(texts(turn, '.ask-state'), [askInvalidText(reason)], reason);
  }
  assert.deepEqual(texts(panel, '.ask-state'), [
    ASK_TOO_LONG_TEXT, ASK_EMPTY_TEXT, ASK_PERSONAL_DATA_TEXT, ASK_TOO_LONG_TEXT, ASK_UNAVAILABLE_TEXT, ASK_UNAVAILABLE_TEXT,
  ]);
});

test('a phone number, an email address or an account number is caught on this device: no request, and the text stays for editing', async () => {
  serve({ news: () => json(news(AAPL)), askGet: () => json(ENABLED), askPost: (_call, body) => json(answered(body.companyId)) });
  await openCompany(/애플/);
  const panel = await findPanel();
  const input = box(panel);
  for (const text of ['제 번호 010-1234-5678로 알려 주세요', '제 번호 010.1234.5678로 알려 주세요', '답은 test.user@example.com 으로 보내 주세요', '계좌 110-123-456789 기준으로 알려 주세요']) {
    ask(panel, text);
    assert.equal(errorText(panel), ASK_PERSONAL_DATA_TEXT, text);
    assert.equal(input.value, text);
    assert.equal(input.getAttribute('aria-invalid'), 'true');
    assert.equal(document.activeElement, input);
  }
  await settle();
  assertNone(calls.askPost);
  assert.deepEqual(items(panel), []);
  // Editing clears the message, and a question without such details goes out.
  fireEvent.change(input, { target: { value: '번호를 지웠습니다. 최근 기사는 어떤가요?' } });
  assert.equal(errorText(panel), '');
  assert.equal(input.getAttribute('aria-invalid'), null);
  fireEvent.click(submitButton(panel));
  await settledTurn(panel, 1);
  assert.deepEqual(calls.askPost.map(item => item.body.question), ['번호를 지웠습니다. 최근 기사는 어떤가요?']);
});

// ---------------------------------------------------------------------------
// The conversation
// ---------------------------------------------------------------------------

test('turns stay in order on this screen only: at most ten, cleared when another company is picked, never written to storage', async () => {
  serve({
    news: (_call, id) => json(news(id)), askGet: () => json(ENABLED),
    askPost: (call, body) => json(answered(body.companyId, { text: `테스트 전용 답변 ${call}번` })),
  });
  await openCompany(/애플/);
  let panel = await findPanel();
  ask(panel, '테스트 전용 첫 질문');
  await settledTurn(panel, 1);
  ask(panel, '테스트 전용 둘째 질문');
  await settledTurn(panel, 2);
  assert.deepEqual(texts(panel, '.ask-question'), ['테스트 전용 첫 질문', '테스트 전용 둘째 질문']);
  assert.deepEqual(texts(panel, '.ask-answer'), ['테스트 전용 답변 1번', '테스트 전용 답변 2번']);
  for (const storage of [window.localStorage, window.sessionStorage]) {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index) ?? '';
      const value = `${key} ${storage.getItem(key) ?? ''}`;
      for (const word of ['테스트 전용 첫 질문', '테스트 전용 둘째 질문', '테스트 전용 답변', NEWS_ASK_VERSION]) assert.equal(value.includes(word), false, key);
    }
  }

  // Another company remounts the panel empty, and coming back does not bring the turns back.
  fireEvent.click(screen.getByRole('button', { name: /NAVER/ }));
  panel = await panelFor('NAVER');
  assert.deepEqual(items(panel), []);
  fireEvent.click(screen.getByRole('button', { name: /애플/ }));
  panel = await panelFor('애플');
  assert.deepEqual(items(panel), []);

  // At most ten turns: the oldest goes first.
  for (let index = 1; index <= ASK_THREAD_MAX + 1; index += 1) {
    ask(panel, `테스트 전용 질문 ${index}번`);
    await settledTurn(panel, Math.min(index, ASK_THREAD_MAX));
  }
  const questions = texts(panel, '.ask-question');
  assert.equal(questions.length, ASK_THREAD_MAX);
  assert.equal(questions[0], '테스트 전용 질문 2번');
  assert.equal(questions.at(-1), `테스트 전용 질문 ${ASK_THREAD_MAX + 1}번`);
});

test('an answer that lands after another company was picked is dropped with the old panel', async () => {
  let land: () => void = () => undefined;
  const landed = new Promise<void>(resolve => { land = resolve; });
  serve({
    news: (_call, id) => json(news(id)), askGet: () => json(ENABLED),
    askPost: async (call, body) => {
      if (call === 1) await landed;
      return json(answered(body.companyId));
    },
  });
  await openCompany(/애플/);
  const first = await findPanel();
  ask(first, '테스트 전용 느린 질문');
  assert.equal(items(first)[0]?.getAttribute('aria-busy'), 'true');
  fireEvent.click(screen.getByRole('button', { name: /NAVER/ }));
  const panel = await panelFor('NAVER');
  assert.deepEqual(items(panel), []);
  // The new panel is not held by the old request.
  ask(panel, '테스트 전용 새 질문');
  const turn = await settledTurn(panel, 1);
  assert.equal(turn.querySelector('.ask-answer')?.textContent, ANSWER_TEXT);
  land();
  await settle();
  assert.deepEqual(texts(currentPanel(), '.ask-question'), ['테스트 전용 새 질문']);
  assert.deepEqual(calls.askPost.map(item => item.body), [
    { companyId: AAPL, question: '테스트 전용 느린 질문' }, { companyId: NAVER, question: '테스트 전용 새 질문' },
  ]);
  fireEvent.click(screen.getByRole('button', { name: /애플/ }));
  assert.deepEqual(items(await panelFor('애플')), []);
});

test('a failed refresh that falls back to this browser\'s last result removes the panel', async () => {
  serve({
    news: call => call === 1
      ? json(news(HYUNDAI, { analysisVersion: NEWS_CACHE_ANALYSIS_VERSION }))
      : Promise.reject(new TypeError('테스트 전용 연결 실패')),
    askGet: () => json(ENABLED),
  });
  await openCompany(/현대자동차/);
  await findPanel();
  fireEvent.click(screen.getByRole('button', { name: '분석 다시 불러오기' }));
  await screen.findByText('이전 결과');
  assert.equal(calls.news.length, 2);
  assert.equal(document.querySelector('.ask-card'), null);
  assert.ok(screen.getByRole('heading', { name: SUMMARY }));
  await settle();
  assert.equal(calls.askGet.length, 1);
  assertNone(calls.askPost);
});

// ---------------------------------------------------------------------------
// Accessibility and keys
// ---------------------------------------------------------------------------

test('the box is labelled and described, the thread is a polite live region, and a pending turn is busy while sending stays off', async () => {
  let land: () => void = () => undefined;
  const landed = new Promise<void>(resolve => { land = resolve; });
  serve({
    news: () => json(news(AAPL)), askGet: () => json(ENABLED),
    askPost: async (_call, body) => { await landed; return json(answered(body.companyId)); },
  });
  await openCompany(/애플/);
  const panel = await findPanel();
  assert.equal(panel.getAttribute('aria-labelledby'), 'ask-title');
  const input = box(panel);
  assert.equal(input.id, 'ask-question');
  assert.equal(input.getAttribute('aria-describedby'), 'ask-privacy ask-count ask-error');
  for (const id of ['ask-title', 'ask-privacy', 'ask-count', 'ask-error']) assert.equal(document.querySelectorAll(`#${id}`).length, 1, id);
  assert.equal(panel.querySelector('ol.ask-thread')?.getAttribute('aria-live'), 'polite');
  assert.equal(panel.querySelector('#ask-error')?.getAttribute('aria-live'), 'polite');
  const send = submitButton(panel);
  assert.equal(send.type, 'submit');
  assert.equal(send.disabled, true, 'nothing to send yet');
  fireEvent.change(input, { target: { value: '   ' } });
  assert.equal(send.disabled, true, 'spaces only');
  fireEvent.change(input, { target: { value: '왜 이런 판단이 나왔나요?' } });
  assert.equal(send.disabled, false);
  fireEvent.click(send);

  const [turn] = items(panel);
  assert.ok(turn);
  assert.equal(turn.getAttribute('aria-busy'), 'true');
  assert.deepEqual(texts(turn, '.ask-question'), ['왜 이런 판단이 나왔나요?']);
  assert.deepEqual(texts(turn, '.ask-state'), [ASK_LOADING_TEXT]);
  assert.equal(input.value, '');
  assert.equal(document.activeElement, input, 'focus stays in the box');
  // While the answer is on its way nothing else is sent.
  fireEvent.change(input, { target: { value: '다음 질문입니다' } });
  assert.equal(send.disabled, true);
  for (const button of mainSuggestions(panel)) assert.equal(button.disabled, true);
  fireEvent.keyDown(input, { key: 'Enter' });
  fireEvent.click(mainSuggestions(panel)[0]!);
  await settle();
  assert.equal(calls.askPost.length, 1);
  assertCleanText(panel);

  land();
  await settledTurn(panel, 1);
  assert.equal(send.disabled, false);
  for (const button of mainSuggestions(panel)) assert.equal(button.disabled, false);
  assert.equal(input.value, '다음 질문입니다', 'the next question waits in the box');
});

test('Enter sends, while Shift+Enter and the Enter that ends a Korean composition do not', async () => {
  serve({ news: () => json(news(AAPL)), askGet: () => json(ENABLED), askPost: (_call, body) => json(answered(body.companyId)) });
  await openCompany(/애플/);
  const panel = await findPanel();
  const input = box(panel);
  fireEvent.change(input, { target: { value: '테스트 전용 엔터 질문' } });
  // Left to the browser: a new line, or the end of the composition.
  assert.equal(fireEvent.keyDown(input, { key: 'Enter', shiftKey: true }), true);
  assert.equal(fireEvent.keyDown(input, { key: 'Enter', isComposing: true }), true);
  assert.equal(fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 }), true);
  await settle();
  assertNone(calls.askPost);
  assert.equal(input.value, '테스트 전용 엔터 질문');
  assert.equal(fireEvent.keyDown(input, { key: 'Enter' }), false, 'a plain Enter is taken for sending');
  await settledTurn(panel, 1);
  assert.deepEqual(calls.askPost.map(item => item.body.question), ['테스트 전용 엔터 질문']);
  assert.equal(input.value, '');

  // Enter on an empty box asks for a question instead of sending one.
  fireEvent.keyDown(input, { key: 'Enter' });
  assert.equal(errorText(panel), ASK_EMPTY_TEXT);
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  await settle();
  assert.equal(calls.askPost.length, 1);

  // A line break typed with Shift+Enter stays in the question as typed.
  ask(panel, '첫 줄\n둘째 줄');
  const turn = await settledTurn(panel, 2);
  assert.equal(turn.querySelector('.ask-question')?.textContent, '첫 줄\n둘째 줄');
  assert.equal(calls.askPost[1]?.body.question, '첫 줄\n둘째 줄');
});

// ---------------------------------------------------------------------------
// Source and styles
// ---------------------------------------------------------------------------

test('the panel keeps every text in core, its turns in memory only, and clear of the article list hooks, live roles, arrows and stylesheet imports', () => {
  const source = readFileSync(new URL('./AskPanel.tsx', import.meta.url), 'utf8');
  for (const banned of [
    'article-list', 'unrelated-articles', 'news-article-', 'news-unrelated-', 'role="status"', 'role="alert"', "role='status'", "role='alert'",
    'localStorage', 'sessionStorage', 'indexedDB', 'document.cookie', 'dangerouslySetInnerHTML', '↑', '↓', '→', ".css'",
  ]) {
    assert.equal(source.includes(banned), false, banned);
  }
  assert.doesNotMatch(source, /[ㄱ-ㆎ가-힣]/, 'every Korean text comes from @moneycast/core');
});

function mediaBlocks(css: string, query: string): string[] {
  const blocks: string[] = [];
  let from = 0;
  for (;;) {
    const at = css.indexOf(`@media ${query}`, from);
    if (at < 0) return blocks;
    const open = css.indexOf('{', at);
    let depth = 0;
    let end = open;
    for (; end < css.length; end += 1) {
      if (css[end] === '{') depth += 1;
      else if (css[end] === '}' && --depth === 0) break;
    }
    blocks.push(css.slice(open + 1, end));
    from = end;
  }
}

/** Innermost rules (selector and body) that name a panel class; media wrappers are looked through. */
function askRules(css: string): Array<{ selectors: string[]; body: string }> {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(match => ({ selectors: match[1]!.split(',').map(selector => selector.trim()), body: match[2]! }))
    .filter(rule => rule.selectors.some(selector => selector.includes('.ask-')));
}

function declarations(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|[}\\n])\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(match, selector);
  return match[1]!;
}

test('both themes style the panel from theme tokens only: no colour literal or pixel width, long text wraps, narrow screens get their own padding', () => {
  const dark = readFileSync(new URL('./theme.css', import.meta.url), 'utf8');
  const light = readFileSync(new URL('./theme-light.css', import.meta.url), 'utf8');
  const source = readFileSync(new URL('./AskPanel.tsx', import.meta.url), 'utf8');
  const prefix = ':root[data-theme="light"] ';
  const darkRules = askRules(dark);
  const lightRules = askRules(light);

  // Every class the panel draws has a rule; the dark default is unprefixed and the light theme only adds prefixed overrides.
  const used = new Set([...source.matchAll(/className="([^"]+)"/g)].flatMap(match => match[1]!.split(/\s+/)).filter(name => name.startsWith('ask-')));
  assert.equal(used.size, 19);
  for (const name of used) {
    const own = new RegExp(`\\.${name}(?![\\w-])`);
    assert.ok(darkRules.some(rule => rule.selectors.some(selector => own.test(selector))), name);
  }
  for (const rule of darkRules) for (const selector of rule.selectors) assert.equal(selector.startsWith(':root'), false, selector);
  assert.ok(lightRules.length >= 1);
  for (const rule of lightRules) for (const selector of rule.selectors) assert.ok(selector.startsWith(prefix), selector);
  for (const rule of [...darkRules, ...lightRules]) {
    assert.doesNotMatch(rule.body, /#/, `a colour literal in ${rule.selectors.join(', ')}`);
    assert.doesNotMatch(rule.body, /(?:^|[;\s])(?:min-|max-)?width:\s*\d+px/, rule.selectors.join(', '));
  }

  for (const selector of ['.ask-title', '.ask-intro', '.ask-question', '.ask-answer', '.ask-evidence', '.ask-limits', '.ask-state', '.ask-privacy', '.ask-error']) {
    assert.match(declarations(dark, selector), /overflow-wrap: anywhere/, selector);
  }
  assert.match(declarations(dark, '.ask-question'), /white-space: pre-wrap/);
  for (const selector of ['.ask-card', '.ask-thread', '.ask-item', '.ask-form', '.ask-suggestions', '.ask-suggestion']) {
    assert.match(declarations(dark, selector), /min-width: 0/, selector);
  }
  const input = declarations(dark, '.ask-input');
  for (const rule of ['width: 100%', 'box-sizing: border-box', 'min-width: 0', 'font: inherit', 'resize: vertical', 'var(--surface-well)', 'var(--line-secondary)']) {
    assert.ok(input.includes(rule), rule);
  }
  assert.match(declarations(dark, '.ask-suggestions'), /display: flex; flex-wrap: wrap/);
  // On a phone a suggestion that needs two lines breaks between words and stays a rounded box; one line is a full pill.
  const suggestion = declarations(dark, '.ask-suggestion');
  for (const rule of ['word-break: keep-all', 'overflow-wrap: anywhere', 'min-height: 36px', 'border-radius: 18px']) assert.ok(suggestion.includes(rule), rule);
  for (const selector of ['.ask-input:focus-visible', '.ask-suggestion:focus-visible', '.ask-submit:focus-visible']) {
    assert.match(declarations(dark, selector), /outline: 2px solid var\(--accent\); outline-offset: 2px/, selector);
  }
  assert.ok(mediaBlocks(dark, '(max-width: 760px)').some(block => /\.ask-card \{ padding: [^}]+\}/.test(block)));
});
