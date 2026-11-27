import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { after, afterEach, beforeEach, test } from 'node:test';
import {
  caseListSummary, caseRefLine, caseStatsLines, companies, coverageLine, excludedLines, integrationMessage, parseCompanyHistory, sampleLine,
  sourcesLine, topicCaseLines,
  BACKFILL_SAMPLE_NOTE, CASE_BASIS_NOTE, CASE_WINDOW_NOTES, DIFFERENT_HORIZONS_NOTE, EXPIRED_STATS_MESSAGE, HISTORY_DISCLAIMER,
  IDENTITY_UNVERIFIED_MESSAGE, MARKETAUX_TOP_NOTE, NEWS_CACHE_ANALYSIS_VERSION, NO_HISTORY_MESSAGE, PARTIAL_NEWS_NOTE,
  PRICE_UNAVAILABLE_MESSAGE, RESULT_DEFINITIONS, STATS_NOT_PUBLIC_MESSAGE,
  type CaseStats, type CompanyHistory, type DirectionStats, type HistoryReadyStatus, type HistoryValidation, type HorizonHistory,
  type NewsAnalysis, type NewsArticle, type ReadyCompanyHistory, type Verdict,
} from '@moneycast/core';

// Two-horizon outlook on the news screen. A separate file and companies that
// App.test.tsx does not use keep the module-level news and history caches apart.

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
// The repository-level tsx test runner excludes web files from its TS project;
// provide React for those files if its fallback uses the classic JSX transform.
Object.assign(globalThis, { React });
const { render, screen, fireEvent, cleanup, waitFor, within } = await import('@testing-library/react');
const { NewsPanel } = await import('./NewsPanel');
const { resetHistoryInsightCache } = await import('./HistoryInsight');
const originalFetch = globalThis.fetch;

const HOUR = 3_600_000;
const DEFAULT_ID = companies[0]!.id;
const HYNIX = 'krx:000660';
const MSFT = 'nasdaq:MSFT';
const SECTION = '전망 한눈에 보기';
const SUMMARY = '테스트 전용: 현재 기사 기반 요약입니다.';
const FAILURE = '과거 사례를 불러오지 못했습니다';
const FORBIDDEN = ['오릅니다', '내립니다', '반드시', '확정', '적중', '승률', '정확도', '확률', '우세', '매수 기회', '매도 기회', '추천', '보장', '권유'];
// The disclaimer names these ideas only to deny them.
const NEGATED = ['보장하지 않습니다', '권유가 아니고', '미래 확률 아님'];
// Existing tests find these texts one at a time; the outlook never renders an element that says only this.
const EXISTING_EXACT = ['중립', '긍정', '부정', '호출 제한', '이전 결과', '다시 시도'];

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function catalog(id: string) {
  const company = companies.find(item => item.id === id);
  assert.ok(company, id);
  return { ...company };
}

function article(id: string, sentiment: NewsArticle['sentiment'], publishedAt = '2026-11-23T12:00:00.000Z'): NewsArticle {
  return {
    id, title: `테스트 전용 기사 ${id}`, source: 'publisher.example.test', publishedAt,
    url: `https://publisher.example.test/${id}`, sentiment, rationale: '테스트 전용 분류 근거입니다.',
  };
}

/** Seven hours old and without cachedUntil, so the news cache never reuses it and every test fetches afresh. */
function news(id: string, overrides: Partial<NewsAnalysis> = {}): NewsAnalysis {
  return {
    company: catalog(id), status: 'ready',
    articles: [article('day-1', 'positive'), article('day-2', 'positive')],
    asOf: new Date(Date.now() - 7 * HOUR).toISOString(),
    period: { start: '2026-11-24', end: '2026-11-28' }, evidence: 'moderate', summary: SUMMARY,
    positiveFactors: ['테스트 전용 긍정 요인'], negativeFactors: [], risks: ['테스트 전용: 미래 방향은 불확실합니다.'],
    provider: 'Marketaux', analysisVersion: 'news-evidence-test-v1', historyAvailable: true,
    ...overrides,
  };
}

function notConfigured(id: string): NewsAnalysis {
  return {
    company: catalog(id), status: 'not_configured', articles: [], asOf: new Date(Date.now() - 7 * HOUR).toISOString(),
    period: { start: '2026-11-24', end: '2026-11-28' }, evidence: 'none', summary: '테스트 전용: 뉴스 제공자가 연결되지 않았습니다.',
    positiveFactors: [], negativeFactors: [], risks: [], provider: null, analysisVersion: 'news-evidence-test-v1',
  };
}

interface Calendar {
  exchange: string;
  phase: HorizonHistory['targetWindow']['phase'];
  day: string;
  week: [string, string];
  newsWindow: { start: string; end: string };
}
// What the server computes at 2026-11-23T10:00Z (KRX after the close, NASDAQ before the open) and at 2026-11-24T00:30Z (KRX open).
const KRX_AFTER_CLOSE: Calendar = { exchange: 'KRX', phase: 'after_close', day: '2026-11-24', week: ['2026-11-24', '2026-11-30'],
  newsWindow: { start: '2026-11-23T06:30:00.000Z', end: '2026-11-24T00:00:00.000Z' } };
const KRX_IN_SESSION: Calendar = { exchange: 'KRX', phase: 'in_session', day: '2026-11-24', week: ['2026-11-25', '2026-12-01'],
  newsWindow: { start: '2026-11-23T06:30:00.000Z', end: '2026-11-24T00:00:00.000Z' } };
const NASDAQ_BEFORE_OPEN: Calendar = { exchange: 'NASDAQ', phase: 'before_open', day: '2026-11-23', week: ['2026-11-23', '2026-11-30'],
  newsWindow: { start: '2026-11-20T21:00:00.000Z', end: '2026-11-23T14:30:00.000Z' } };

function caseStats(): CaseStats {
  return {
    cases: 12, nEff: 10, up: 6, neutral: 2, down: 4,
    returns: { median: 0.012, q1: -0.01, q3: 0.03, min: -0.05, max: 0.08, relativeMedian: 0.004 },
    period: { from: '2025-01-02', to: '2026-11-20' }, entryType: 'close', allWindows: { up: 0.48, down: 0.42 },
  };
}

function directionStats(verdict: Verdict, unit: 'day' | 'week', extra: Partial<DirectionStats> = {}): DirectionStats {
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
    ...extra,
  };
}

interface HistoryOptions {
  status?: HistoryReadyStatus;
  calendar?: Calendar;
  /** Verdict of the positive direction per horizon; supports by default. */
  verdicts?: Partial<Record<'day' | 'week', Verdict>>;
  negative?: Partial<Record<'day' | 'week', DirectionStats>>;
  validation?: HistoryValidation;
  sampleOrigin?: HorizonHistory['sampleOrigin'];
  computedAt?: string;
  companyId?: string;
}

/** Shaped like the server's answer; stats_not_public carries no number of any kind. */
function history(id: string, options: HistoryOptions = {}): CompanyHistory {
  const status = options.status ?? 'ready';
  const calendar = options.calendar ?? (id.startsWith('nasdaq:') ? NASDAQ_BEFORE_OPEN : KRX_AFTER_CLOSE);
  const withStats = status === 'ready';
  const horizon = (h: 'day' | 'week'): HorizonHistory => {
    const [start, end] = h === 'day' ? [calendar.day, calendar.day] : calendar.week;
    const origin = options.sampleOrigin ?? { backfillUnits: 0, includesBackfill: false, pointInTimeGuaranteed: true };
    const validation = options.validation ?? { status: 'not_evaluated', directions: [], markets: [], evaluatedAt: null };
    return {
      validation: { ...validation, directions: [...validation.directions], markets: [...validation.markets] },
      targetWindow: { start, end, basis: 'exchange_calendar', exchange: calendar.exchange, phase: calendar.phase },
      newsWindow: h === 'day' ? { ...calendar.newsWindow } : null,
      directions: withStats ? {
        positive: directionStats(options.verdicts?.[h] ?? 'supports', h),
        negative: options.negative?.[h] ?? directionStats('no_clear_difference', h),
      } : null,
      ...(withStats ? { sampleOrigin: { ...origin } } : {}),
    };
  };
  const companyId = options.companyId ?? id;
  const horizons = { day: horizon('day'), week: horizon('week') };
  const value: CompanyHistory = status === 'stats_not_public' ? {
    version: 'news-history-v1', companyId, status, horizons,
    coverage: { articles: 0, events: 0, usable: 0, excluded: {}, observationGaps: 0 },
    dataAsOf: { computedAt: new Date().toISOString(), lastPriceDate: null, ledgerFrom: null, ledgerTo: null },
    sources: { news: [], price: null },
  } : {
    version: 'news-history-v1', companyId, status, horizons,
    coverage: { articles: 120, events: 80, usable: 90, excluded: { day_overlap: 3, week_pending: 1, case_recent: 5 }, observationGaps: 2 },
    dataAsOf: {
      computedAt: options.computedAt ?? new Date(Date.now() - HOUR).toISOString(), lastPriceDate: '2026-11-20',
      ledgerFrom: '2025-01-02T03:00:00.000Z', ledgerTo: '2026-11-23T01:00:00.000Z',
    },
    sources: {
      news: ['GDELT', 'Marketaux'],
      price: calendar.exchange === 'KRX'
        ? { label: '금융위원회 주식시세정보·증권상품시세정보(공공데이터포털)', adjustment: 'raw' }
        : { label: 'Massive(구 Polygon) 일봉', adjustment: 'split' },
    },
  };
  assert.ok(parseCompanyHistory(JSON.parse(JSON.stringify(value))), 'the history fixture must pass the shared parser');
  return value;
}

const off = (id: string) => ({ version: 'news-history-v1', companyId: id, status: 'off' });

function readyOf(value: CompanyHistory): ReadyCompanyHistory {
  if (value.status === 'off' || value.status === 'unavailable') throw new Error('not a ready-family fixture');
  return value;
}

// ---------------------------------------------------------------------------
// Fetch routing and screen helpers
// ---------------------------------------------------------------------------

type Reply = Response | Promise<Response>;
interface Calls { news: string[]; history: string[]; historyUrls: string[]; historyInit: Array<RequestInit | undefined> }
let calls: Calls = { news: [], history: [], historyUrls: [], historyInit: [] };

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

/** The default company loaded on mount is always unconfigured; the test company and the history route are the test's. */
function serve(routes: { news: (call: number, id: string) => Reply; history?: (call: number, id: string) => Reply }): void {
  calls = { news: [], history: [], historyUrls: [], historyInit: [] };
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const id = url.searchParams.get('companyId') ?? '';
    if (url.pathname === '/api/news/history') {
      calls.history.push(id);
      calls.historyUrls.push(String(input));
      calls.historyInit.push(init);
      if (!routes.history) throw new Error('테스트 전용: 예상하지 않은 과거 기록 요청');
      return routes.history(calls.history.length, id);
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

/** The outlook region once both cards are drawn. */
async function readyOutlook(): Promise<HTMLElement> {
  const section = await screen.findByRole('region', { name: SECTION });
  await waitFor(() => assert.equal(section.querySelectorAll('.history-card').length, 2));
  return section;
}

function cards(section: HTMLElement): { day: HTMLButtonElement; week: HTMLButtonElement } {
  const [day, week] = Array.from(section.querySelectorAll<HTMLButtonElement>('.history-card'));
  assert.ok(day && week);
  return { day, week };
}

function evidence(section: HTMLElement): HTMLElement {
  const block = section.querySelector<HTMLElement>('.history-evidence');
  assert.ok(block);
  return block;
}

/** Lets effects and any stray request run before counting requests. */
const settle = () => new Promise(resolve => setTimeout(resolve, 30));

function assertCleanText(section: HTMLElement): void {
  let text = section.textContent ?? '';
  assert.doesNotMatch(text, /[\u2191\u2193\u2192]/);
  for (const phrase of NEGATED) text = text.split(phrase).join('');
  for (const word of FORBIDDEN) assert.equal(text.includes(word), false, `"${word}" in the outlook`);
  assert.equal(section.querySelector('[role]'), null);
  for (const element of Array.from(section.querySelectorAll('*'))) {
    assert.equal(EXISTING_EXACT.includes((element.textContent ?? '').trim()), false, element.outerHTML);
  }
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  resetHistoryInsightCache();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
after(() => dom.window.close());

// ---------------------------------------------------------------------------
// When the outlook asks for history at all
// ---------------------------------------------------------------------------

test('without the hint the analysis card renders as before and makes no history request', async () => {
  const plain = news(HYNIX);
  delete plain.historyAvailable;
  const markup: string[] = [];
  for (const value of [plain, { ...plain, historyAvailable: false }]) {
    serve({ news: () => json(value), history: () => json(history(HYNIX)) });
    const view = await openCompany(/SK하이닉스/);
    await screen.findByRole('heading', { name: SUMMARY });
    await settle();
    assert.equal(calls.history.length, 0);
    assert.equal(document.querySelector('.history-insight'), null);
    markup.push(document.querySelector('.analysis-card')!.innerHTML);
    view.unmount();
  }
  assert.equal(markup[0], markup[1]);
});

test('a hint on an unconfigured, failed or rate-limited analysis makes no history request', async () => {
  for (const status of ['not_configured', 'error', 'rate_limited'] as const) {
    const message = `테스트 전용: ${status} 상태 안내`;
    serve({
      news: () => json(news(HYNIX, { status, articles: [], positiveFactors: [], evidence: 'none', message })),
      history: () => json(history(HYNIX)),
    });
    const view = await openCompany(/SK하이닉스/);
    await screen.findByText(message);
    await settle();
    assert.equal(calls.history.length, 0, status);
    assert.equal(document.querySelector('.history-insight'), null, status);
    view.unmount();
  }
});

test('an off answer renders nothing after exactly one history request, and is reused when the company is picked again', async () => {
  serve({ news: () => json(news(HYNIX)), history: () => json(off(HYNIX)) });
  await openCompany(/SK하이닉스/);
  await screen.findByRole('heading', { name: SUMMARY });
  await waitFor(() => assert.equal(calls.history.length, 1));
  await waitFor(() => assert.equal(screen.queryByRole('region', { name: SECTION }), null));
  assert.equal(calls.historyUrls[0], '/api/news/history?companyId=krx%3A000660');
  fireEvent.click(screen.getByRole('button', { name: /삼성전자/ }));
  await screen.findByText('데이터 연동 대기');
  fireEvent.click(screen.getByRole('button', { name: /SK하이닉스/ }));
  await screen.findByRole('heading', { name: SUMMARY });
  await settle();
  assert.equal(calls.news.length, 2);
  assert.equal(calls.history.length, 1);
  assert.equal(document.querySelector('.history-insight'), null);
});

// ---------------------------------------------------------------------------
// Cards and evidence
// ---------------------------------------------------------------------------

test('a ready answer shows both horizon cards above the existing summary, with the evidence of the next trading day', async () => {
  const analysis = news(HYNIX, {
    factorSummary: {
      positive: { state: 'repeated', chips: [], lines: [{ text: '테스트 전용 긍정 요인', topic: 'earnings', articleIds: ['day-1', 'day-2'] }] },
      negative: { state: 'none', chips: [], lines: [] },
      chips: [], note: '테스트 전용 주제 안내',
    },
  });
  const value = history(HYNIX);
  serve({ news: () => json(analysis), history: () => json(value) });
  await openCompany(/SK하이닉스/);
  const section = await readyOutlook();
  assert.ok(section.matches('section.history-insight'));
  assert.ok(section.nextElementSibling?.classList.contains('evidence-summary'), 'the outlook sits above the existing summary');
  assert.ok(screen.getByRole('heading', { level: 3, name: SUMMARY }));
  assert.ok(within(section).getByRole('heading', { level: 3, name: SECTION }));

  const { day, week } = cards(section);
  assert.ok(within(day).getByText('다음 거래일 · 11/24(화)'));
  assert.ok(within(week).getByText('다음 주 · 11/24(화)~11/30(월)'));
  assert.ok(within(day).getByText('상승 전망'));
  assert.ok(day.querySelector('.history-signal.history-signal-positive'));
  assert.ok(within(day).getByText('검증 전 · 참고 정보'));
  assert.ok(within(day).getByText('밤사이 긍정 기사 2건'));
  assert.ok(within(day).getByText('과거 비슷한 날: 지지'));
  assert.ok(within(week).getByText('상승 전망'));
  assert.ok(within(week).getByText('최근 7일 긍정 기사 2건'));
  assert.ok(within(week).getByText('과거 비슷한 주: 지지'));
  assert.equal(day.querySelector('h1, h2, h3, h4, h5, h6'), null, 'no headings inside a button');
  assert.ok(within(section).getByText(DIFFERENT_HORIZONS_NOTE));
  assert.ok(within(section).getByText(HISTORY_DISCLAIMER));

  // ② past cases of the baseline's direction, with the factor topic and the example list.
  const block = evidence(section);
  const ready = readyOf(value);
  const stats = ready.horizons.day.directions!.positive;
  assert.ok(within(block).getByRole('heading', { name: '② 과거 유사 기사와 이후 실제 주가' }));
  assert.ok(within(block).getByText('긍정 뉴스 뒤 과거 사례'));
  assert.equal(within(block).queryByText('부정 뉴스 뒤 과거 사례'), null);
  for (const line of [...caseStatsLines(stats.all), ...topicCaseLines(stats, ['earnings'])]) assert.ok(within(block).getByText(line), line);
  assert.ok(within(block).getByText(caseListSummary(1)));
  const link = within(block).getByRole('link', { name: 'Example' });
  assert.equal(link.getAttribute('href'), 'https://example.com/a');
  assert.equal(link.getAttribute('target'), '_blank');
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
  assert.ok(within(block).getByText(caseRefLine(stats.examples[0]!)));
  assert.ok(within(block).getByText(CASE_WINDOW_NOTES.day));
  assert.ok(within(block).getByText(CASE_BASIS_NOTE));

  // ③ the integrated outlook and its numbers.
  assert.ok(within(block).getByText('기준선 상승 전망 · 통합 상승 전망 · 판정 지지'));
  assert.ok(within(block).getByText(sampleLine(stats.sample!)));
  assert.equal(within(block).queryByText(BACKFILL_SAMPLE_NOTE), null);
  assert.equal(within(block).queryByText(PARTIAL_NEWS_NOTE), null);
  assert.ok(within(block).getByText('대상: 11/24(화) 한국거래소 종가(전일 종가 대비)'));
  assert.ok(within(block).getByText(/^밤사이 뉴스 기준: .+ KST ~ .+ KST$/));
  assert.ok(within(block).getByText('밤사이 기사 근거 수준: 보통'));

  // ④ definitions, times and sources.
  assert.ok(within(block).getByText(RESULT_DEFINITIONS.day));
  assert.ok(within(block).getByText(/^기사 기준 .+ KST$/));
  assert.ok(within(block).getByText('가격 기준일 2026-11-20'));
  assert.ok(within(block).getByText(/^통계 계산 .+ KST$/));
  assert.ok(within(block).getByText('기사 기록 기간 2025-01-02 ~ 2026-11-23'));
  assert.ok(within(block).getByText(coverageLine(ready.coverage)));
  assert.equal(excludedLines(ready.coverage.excluded).length, 3);
  for (const line of excludedLines(ready.coverage.excluded)) assert.ok(within(block).getByText(line), line);
  assert.ok(within(block).getByText(sourcesLine(ready.sources)));
  assert.ok(within(block).getByText(MARKETAUX_TOP_NOTE));
  const credit = within(block).getByRole('link', { name: 'GDELT Project 검색 결과 포함' });
  assert.equal(credit.getAttribute('href'), 'https://www.gdeltproject.org');
  assert.equal(credit.getAttribute('rel'), 'noopener noreferrer');
  assertCleanText(section);
});

test('the day card is chosen first and choosing the week card switches the evidence to the next five trading days', async () => {
  serve({ news: () => json(news(HYNIX)), history: () => json(history(HYNIX)) });
  await openCompany(/SK하이닉스/);
  const section = await readyOutlook();
  const { day, week } = cards(section);
  assert.equal(day.getAttribute('aria-pressed'), 'true');
  assert.equal(week.getAttribute('aria-pressed'), 'false');
  assert.ok(day.classList.contains('selected'));
  assert.equal(day.type, 'button');
  assert.ok(within(section).getByRole('heading', { name: '근거 보기 · 다음 거래일' }));
  assert.ok(within(section).getByRole('heading', { name: '③ 다음 거래일 참고 전망(통합)' }));
  assert.ok(within(section).getByText(RESULT_DEFINITIONS.day));

  fireEvent.click(week);
  assert.equal(week.getAttribute('aria-pressed'), 'true');
  assert.equal(day.getAttribute('aria-pressed'), 'false');
  assert.ok(week.classList.contains('selected'));
  assert.equal(day.classList.contains('selected'), false);
  assert.ok(within(section).getByRole('heading', { name: '근거 보기 · 다음 주' }));
  assert.ok(within(section).getByRole('heading', { name: '③ 다음 주 참고 전망(통합)' }));
  assert.equal(within(section).queryByRole('heading', { name: '③ 다음 거래일 참고 전망(통합)' }), null);
  assert.ok(within(section).getByText(CASE_WINDOW_NOTES.week));
  assert.ok(within(section).getByText(RESULT_DEFINITIONS.week));
  assert.ok(within(section).getByText("대상: 11/24(화)~11/30(월) 한국거래소 5거래일 · 화면 아래 '다음 주 참고 기간'과 다름"));
  assert.equal(within(section).queryByText(/^밤사이 뉴스 기준:/), null);
  assert.equal(within(section).queryByText(/^밤사이 기사 근거 수준:/), null);
  assertCleanText(section);

  fireEvent.click(day);
  assert.ok(within(section).getByRole('heading', { name: '근거 보기 · 다음 거래일' }));
});

test('a contradicting verdict lowers the day card to withheld and says what it changed', async () => {
  serve({ news: () => json(news(HYNIX)), history: () => json(history(HYNIX, { verdicts: { day: 'contradicts' } })) });
  await openCompany(/SK하이닉스/);
  const section = await readyOutlook();
  const { day, week } = cards(section);
  assert.ok(within(day).getByText('판단 유보'));
  assert.ok(day.querySelector('.history-signal-withheld'));
  assert.ok(within(day).getByText('과거 비슷한 날: 상충'));
  assert.ok(within(section).getByText('기준선 상승 전망에서 판단 유보로 낮췄습니다.'));
  assert.ok(within(section).getByText('기준선 상승 전망 · 통합 판단 유보 · 판정 상충'));
  // The week's own verdict supports its baseline, so that card keeps it.
  assert.ok(within(week).getByText('상승 전망'));
  assert.ok(within(week).getByText('과거 비슷한 주: 지지'));
});

test('weakening and no-clear-difference verdicts keep the baseline, say so, and wear the badge of their validation', async () => {
  const validation: HistoryValidation = {
    status: 'no_evidence_of_improvement', directions: ['positive', 'negative'], markets: ['KR'], evaluatedAt: '2026-11-01T00:00:00.000Z',
  };
  serve({ news: () => json(news(HYNIX)), history: () => json(history(HYNIX, { validation, verdicts: { day: 'weakens', week: 'no_clear_difference' } })) });
  await openCompany(/SK하이닉스/);
  const section = await readyOutlook();
  const { day, week } = cards(section);
  for (const card of [day, week]) {
    assert.ok(within(card).getByText('상승 전망'));
    assert.ok(card.querySelector('.history-signal-positive'));
    assert.ok(within(card).getByText('개선 근거 없음 · 참고 정보'));
  }
  assert.ok(within(day).getByText('과거 비슷한 날: 약화'));
  assert.ok(within(week).getByText('과거 비슷한 주: 뚜렷한 차이 없음'));
  let block = evidence(section);
  assert.ok(within(block).getByText('기준선 상승 전망 · 통합 상승 전망 · 판정 약화'));
  assert.ok(within(block).getByText(integrationMessage('weakens', 'day')));
  assert.ok(within(block).getByText('개선 근거 없음 · 참고 정보'));
  assert.equal(within(section).queryByText(/에서 판단 유보로 낮췄습니다\.$/), null);

  fireEvent.click(week);
  block = evidence(section);
  assert.ok(within(block).getByText('기준선 상승 전망 · 통합 상승 전망 · 판정 뚜렷한 차이 없음'));
  assert.ok(within(block).getByText(integrationMessage('no_clear_difference', 'week')));
  assertCleanText(section);
});

test('a market without permission shows the news signals but no statistic, price, date or source of the past cases', async () => {
  serve({ news: () => json(news(MSFT)), history: () => json(history(MSFT, { status: 'stats_not_public' })) });
  await openCompany(/마이크로소프트/);
  const section = await readyOutlook();
  const { day, week } = cards(section);
  assert.ok(within(day).getByText('다음 거래일 · 11/23(월)'));
  assert.ok(within(day).getByText('상승 전망'));
  assert.ok(within(day).getByText('밤사이 긍정 기사 2건'));
  assert.ok(within(day).getByText('과거 사례 통계는 데이터 이용 허가 확인 뒤 공개'));
  assert.ok(within(day).getByText('검증 전 · 참고 정보'));
  assert.ok(within(week).getByText('상승 전망'));
  assert.ok(within(week).getByText('과거 사례 통계는 데이터 이용 허가 확인 뒤 공개'));
  for (const card of [day, week]) {
    fireEvent.click(card);
    const block = evidence(section);
    assert.ok(within(block).getAllByText(STATS_NOT_PUBLIC_MESSAGE).length >= 3, 'in ②, ③ and ④');
    assert.ok(within(block).getByText('기준선 상승 전망 · 통합 상승 전망 · 판정 공개 전'));
    const text = section.textContent ?? '';
    assert.doesNotMatch(text, /\d+(\.\d+)?%/);
    assert.equal(text.includes('수익률'), false);
    assert.equal(text.includes('통계 계산'), false);
    assert.equal(text.includes('가격 기준일'), false);
    assert.equal(text.includes('출처:'), false);
    assert.equal(section.querySelector('.history-cases'), null);
    assertCleanText(section);
  }
});

test('overnight articles that are all neutral read differently from an overnight window without articles', async () => {
  serve({
    news: () => json(news(HYNIX, { status: 'insufficient', positiveFactors: [], articles: [article('day-1', 'neutral'), article('day-2', 'neutral')] })),
    history: () => json(history(HYNIX)),
  });
  const view = await openCompany(/SK하이닉스/);
  let section = await readyOutlook();
  let { day, week } = cards(section);
  assert.ok(within(day).getByText('판단 유보 · 밤사이 뉴스는 방향이 뚜렷하지 않음'));
  assert.ok(within(day).getByText('판단 유보'));
  assert.ok(day.querySelector('.history-signal-withheld'));
  assert.ok(within(day).getByText('과거 비슷한 날: 현재 방향이 없어 비교하지 않음'));
  assert.ok(within(week).getByText('최근 7일 뉴스는 방향이 뚜렷하지 않음'));
  // Without a direction both directions' cases are shown for reference.
  assert.ok(within(section).getByText('긍정 뉴스 뒤 과거 사례'));
  assert.ok(within(section).getByText('부정 뉴스 뒤 과거 사례'));
  assert.ok(within(section).getByText('기존 판단 유보 유지. 사례는 참고로 표시합니다.'));
  assert.ok(within(section).getByText('기준선 판단 유보 · 통합 판단 유보 · 판정 해당 없음'));
  assert.ok(within(section).getByText('밤사이 기사 근거 수준: 없음'));
  view.unmount();

  resetHistoryInsightCache();
  serve({ news: () => json(news(HYNIX, { articles: [article('earlier-1', 'positive', '2026-11-22T12:00:00.000Z')] })), history: () => json(history(HYNIX)) });
  await openCompany(/SK하이닉스/);
  section = await readyOutlook();
  ({ day, week } = cards(section));
  assert.ok(within(day).getByText('판단 유보 · 밤사이 새 뉴스 없음'));
  assert.equal(within(day).queryByText('판단 유보 · 밤사이 뉴스는 방향이 뚜렷하지 않음'), null);
  assert.ok(within(week).getByText('상승 전망'));
});

test('during the session the day card is the outlook for today from before the open', async () => {
  serve({ news: () => json(news(HYNIX)), history: () => json(history(HYNIX, { calendar: KRX_IN_SESSION })) });
  await openCompany(/SK하이닉스/);
  const section = await readyOutlook();
  const { day, week } = cards(section);
  assert.equal(day.querySelector('.history-card-title')?.textContent, '오늘 장 전망 · 장 시작 전 기준');
  assert.equal(week.querySelector('.history-card-title')?.textContent, '다음 주 · 11/25(수)~12/1(화)');
  assert.ok(within(day).getByText('상승 전망'));
});

test('past cases without data, identity or prices name the reason and keep the baseline', async () => {
  const cases = [
    ['no_history', NO_HISTORY_MESSAGE],
    ['identity_unverified', IDENTITY_UNVERIFIED_MESSAGE],
    ['price_unavailable', PRICE_UNAVAILABLE_MESSAGE],
  ] as const;
  for (const [status, message] of cases) {
    resetHistoryInsightCache();
    serve({ news: () => json(news(HYNIX)), history: () => json(history(HYNIX, { status })) });
    const view = await openCompany(/SK하이닉스/);
    const section = await readyOutlook();
    const { day, week } = cards(section);
    assert.ok(within(day).getByText(message), status);
    assert.ok(within(week).getByText(message), status);
    assert.ok(within(day).getByText('상승 전망'), status);
    const block = evidence(section);
    assert.ok(within(block).getByText(message), status);
    assert.ok(within(block).getByText('기준선 상승 전망 · 통합 상승 전망 · 판정 해당 없음'), status);
    assert.ok(within(block).getByText('추가 근거 부족, 기존 판단 유지'), status);
    assert.equal(within(block).queryByText(BACKFILL_SAMPLE_NOTE), null, status);
    assert.ok(within(block).getByText('가격 기준일 2026-11-20'), status);
    view.unmount();
  }
});

test('old statistics are labelled and statistics older than fourteen days are not used', async () => {
  serve({ news: () => json(news(HYNIX)), history: () => json(history(HYNIX, { computedAt: new Date(Date.now() - 73 * HOUR).toISOString() })) });
  const view = await openCompany(/SK하이닉스/);
  let section = await readyOutlook();
  assert.ok(within(section).getByText(/^통계 계산 .+ KST · 오래된 통계$/));
  assert.ok(within(cards(section).day).getByText('과거 비슷한 날: 지지'));
  view.unmount();

  resetHistoryInsightCache();
  serve({ news: () => json(news(HYNIX)), history: () => json(history(HYNIX, { computedAt: new Date(Date.now() - 15 * 24 * HOUR).toISOString() })) });
  await openCompany(/SK하이닉스/);
  section = await readyOutlook();
  const { day } = cards(section);
  assert.ok(within(day).getByText('과거 비슷한 날: 근거 부족'));
  assert.ok(within(day).getByText('상승 전망'));
  const block = evidence(section);
  assert.ok(within(block).getByText(EXPIRED_STATS_MESSAGE));
  assert.equal(within(block).queryByText(/^사례 \d+건/), null);
  assert.equal(within(block).queryByText(/^사건 일 /), null);
  assert.ok(within(block).getByText('기준선 상승 전망 · 통합 상승 전망 · 판정 근거 부족'));
  assert.ok(within(block).getByText(/^통계 계산 .+ KST · 오래된 통계$/));
});

test('validation scope, partial news, backfilled samples and the reason for an insufficient verdict appear in the outlook', async () => {
  const validation: HistoryValidation = { status: 'improvement_observed', directions: ['positive'], markets: ['KR'], evaluatedAt: '2026-11-01T00:00:00.000Z' };
  const value = history(HYNIX, {
    validation,
    sampleOrigin: { backfillUnits: 3, includesBackfill: true, pointInTimeGuaranteed: false },
    negative: { week: directionStats('insufficient', 'week', { reason: 'few_event_units', sample: null }) },
  });
  serve({
    news: () => json(news(HYNIX, {
      positiveFactors: [], negativeFactors: ['테스트 전용 부정 요인'],
      articles: [article('day-1', 'positive'), article('day-2', 'positive'), article('week-1', 'negative', '2026-11-20T03:00:00.000Z')],
      sources: [
        { id: 'marketaux', label: 'Marketaux', status: 'rate_limited', articleCount: 0 },
        { id: 'gdelt', label: 'GDELT', status: 'ok', articleCount: 3 },
      ],
    })),
    history: () => json(value),
  });
  await openCompany(/SK하이닉스/);
  const section = await readyOutlook();
  const { day, week } = cards(section);
  // Only the evaluated direction and market get the improvement badge.
  assert.ok(within(day).getByText('범위·기간을 밝힌 개선 관찰 · 참고 정보'));
  assert.ok(within(week).getByText('하락 전망'));
  assert.ok(week.querySelector('.history-signal-negative'));
  assert.ok(within(week).getByText('검증 전 · 참고 정보'));
  assert.ok(within(week).getByText('최근 7일 부정 기사 1건'));
  assert.ok(within(week).getByText('과거 비슷한 주: 근거 부족'));
  let block = evidence(section);
  assert.ok(within(block).getByText(PARTIAL_NEWS_NOTE));
  assert.ok(within(block).getByText(BACKFILL_SAMPLE_NOTE));

  fireEvent.click(week);
  block = evidence(section);
  assert.ok(within(block).getByText('부정 뉴스 뒤 과거 사례'));
  assert.equal(within(block).queryByText('긍정 뉴스 뒤 과거 사례'), null);
  assert.ok(within(block).getByText('기준선 하락 전망 · 통합 하락 전망 · 판정 근거 부족'));
  assert.ok(within(block).getByText('추가 근거 부족, 기존 판단 유지'));
  assert.ok(within(block).getByText('근거 부족 이유: 사건 표본 20개 미만'));
  assert.equal(within(block).queryByText(/^사건 주 /), null);
  assert.ok(within(block).getByText(BACKFILL_SAMPLE_NOTE));
  assert.ok(within(block).getByText(PARTIAL_NEWS_NOTE));
  assertCleanText(section);
});

// ---------------------------------------------------------------------------
// Failures and old results
// ---------------------------------------------------------------------------

test('a failed history request shows a retry that recovers, while the news summary stays in place', async () => {
  serve({ news: () => json(news(HYNIX)), history: call => call === 1 ? json({ error: '테스트 전용 실패' }, 500) : json(history(HYNIX)) });
  await openCompany(/SK하이닉스/);
  const section = await screen.findByRole('region', { name: SECTION });
  await within(section).findByText(FAILURE);
  assert.ok(screen.getByRole('heading', { name: SUMMARY }));
  assert.equal(screen.queryByRole('alert'), null);
  assert.equal(section.querySelector('.history-cards'), null);
  fireEvent.click(within(section).getByRole('button', { name: '과거 사례 다시 불러오기' }));
  await within(section).findByText('다음 거래일 · 11/24(화)');
  assert.equal(calls.history.length, 2);
  assert.equal(within(section).queryByText(FAILURE), null);
  assert.ok(screen.getByRole('heading', { name: SUMMARY }));
});

test('unreadable JSON, another company, an unavailable status and a broken shape all count as failures', async () => {
  const replies: Array<() => Response> = [
    () => new Response('{"version":', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    () => json(history(HYNIX, { companyId: 'krx:035420' })),
    () => json({ version: 'news-history-v1', companyId: HYNIX, status: 'unavailable' }),
    () => json({ ...history(HYNIX), status: 'guaranteed_up' }),
  ];
  for (const [index, reply] of replies.entries()) {
    resetHistoryInsightCache();
    serve({ news: () => json(news(HYNIX)), history: reply });
    const view = await openCompany(/SK하이닉스/);
    const section = await screen.findByRole('region', { name: SECTION });
    await within(section).findByText(FAILURE);
    assert.equal(section.querySelector('.history-cards'), null, String(index));
    assert.ok(within(section).getByRole('button', { name: '과거 사례 다시 불러오기' }), String(index));
    assert.ok(screen.getByRole('heading', { name: SUMMARY }), String(index));
    view.unmount();
  }
});

test('a timed-out history request fails visibly and was given an abort signal', async () => {
  serve({ news: () => json(news(HYNIX)), history: () => Promise.reject(new DOMException('timeout', 'TimeoutError')) });
  await openCompany(/SK하이닉스/);
  const section = await screen.findByRole('region', { name: SECTION });
  await within(section).findByText(FAILURE);
  assert.ok(calls.historyInit[0]?.signal instanceof AbortSignal);
  assert.ok(screen.getByRole('heading', { name: SUMMARY }));
});

test('a stale server result never asks for history', async () => {
  serve({
    news: () => json(news(HYNIX, { servedFrom: 'stale', refreshAttemptedAt: new Date().toISOString(), message: '테스트 전용: 모든 출처가 응답하지 않았습니다.' })),
    history: () => json(history(HYNIX)),
  });
  await openCompany(/SK하이닉스/);
  await screen.findByText('이전 결과');
  assert.ok(screen.getByRole('heading', { name: SUMMARY }));
  await settle();
  assert.equal(calls.history.length, 0);
  assert.equal(document.querySelector('.history-insight'), null);
});

test('a failed refresh that falls back to this browser\'s last result removes the outlook', async () => {
  // The current-version fixture stays in the news cache module's memory as HYNIX's last good result for the
  // rest of this file, so no later test may let that company's news request fail.
  serve({
    news: call => call === 1
      ? json(news(HYNIX, { analysisVersion: NEWS_CACHE_ANALYSIS_VERSION }))
      : Promise.reject(new TypeError('테스트 전용 연결 실패')),
    history: () => json(history(HYNIX)),
  });
  await openCompany(/SK하이닉스/);
  await readyOutlook();
  assert.equal(calls.history.length, 1);
  fireEvent.click(screen.getByRole('button', { name: '분석 다시 불러오기' }));
  const banner = (await screen.findByText('이전 결과')).closest('.stale-banner');
  assert.ok(banner);
  assert.equal(calls.news.length, 2);
  assert.equal(document.querySelector('.history-insight'), null);
  assert.ok(screen.getByRole('heading', { name: SUMMARY }));
  await settle();
  assert.equal(calls.history.length, 1);
});

test('an answer is reused while its overnight window is open and fetched again once the window has closed', async () => {
  const now = Date.now();
  const start = new Date(now - 10 * HOUR).toISOString();
  const open: Calendar = { ...KRX_AFTER_CLOSE, newsWindow: { start, end: new Date(now + HOUR).toISOString() } };
  const closed: Calendar = { ...KRX_AFTER_CLOSE, newsWindow: { start, end: new Date(now - 60_000).toISOString() } };
  for (const [calendar, expected] of [[open, 1], [closed, 2]] as const) {
    resetHistoryInsightCache();
    serve({ news: () => json(news(HYNIX)), history: () => json(history(HYNIX, { calendar })) });
    const view = await openCompany(/SK하이닉스/);
    await readyOutlook();
    fireEvent.click(screen.getByRole('button', { name: /삼성전자/ }));
    await screen.findByText('데이터 연동 대기');
    fireEvent.click(screen.getByRole('button', { name: /SK하이닉스/ }));
    await readyOutlook();
    await settle();
    assert.equal(calls.news.length, 2);
    assert.equal(calls.history.length, expected);
    view.unmount();
  }
});

test('an answer that lands after another company was picked is kept for its own company and never drawn for the other', async () => {
  const now = Date.now();
  // A window around the real clock, so the late answer may still be reused once it lands.
  const calendar: Calendar = { ...KRX_AFTER_CLOSE, newsWindow: { start: new Date(now - 10 * HOUR).toISOString(), end: new Date(now + HOUR).toISOString() } };
  let land: () => void = () => undefined;
  const landed = new Promise<void>(resolve => { land = resolve; });
  // Overnight articles inside that window too, so the day card has a direction whatever day the test runs.
  const overnight = new Date(now - 8 * HOUR).toISOString();
  serve({
    news: (_call, id) => json(news(id, { articles: [article('day-1', 'positive', overnight), article('day-2', 'positive', overnight)] })),
    history: async (_call, id) => {
      if (id !== HYNIX) return json(history(id, { status: 'stats_not_public' }));
      await landed;
      return json(history(HYNIX, { calendar }));
    },
  });
  await openCompany(/SK하이닉스/);
  const waiting = await screen.findByRole('region', { name: SECTION });
  assert.ok(within(waiting).getByText('두 기간 전망을 준비하고 있습니다'));
  fireEvent.click(screen.getByRole('button', { name: /마이크로소프트/ }));
  let section = await readyOutlook();
  assert.ok(within(cards(section).day).getByText('다음 거래일 · 11/23(월)'));

  land();
  await settle();
  section = screen.getByRole('region', { name: SECTION });
  assert.ok(within(cards(section).day).getByText('다음 거래일 · 11/23(월)'));
  assert.ok(within(cards(section).day).getByText(STATS_NOT_PUBLIC_MESSAGE));
  assert.deepEqual(calls.history, [HYNIX, MSFT]);

  // Picking the first company again uses the answer that landed meanwhile.
  fireEvent.click(screen.getByRole('button', { name: /SK하이닉스/ }));
  section = await readyOutlook();
  assert.ok(within(cards(section).day).getByText('다음 거래일 · 11/24(화)'));
  assert.ok(within(cards(section).day).getByText('과거 비슷한 날: 지지'));
  await settle();
  assert.deepEqual(calls.news, [HYNIX, MSFT, HYNIX]);
  assert.deepEqual(calls.history, [HYNIX, MSFT]);
});

// ---------------------------------------------------------------------------
// Step 6 follow-ups: news not checked yet, in-session labels, compact KST times
// ---------------------------------------------------------------------------

/** KRX near New Year: the next session is in 2027 while the overnight window opens in 2026. */
const KRX_YEAR_END: Calendar = { exchange: 'KRX', phase: 'after_close', day: '2027-01-04', week: ['2027-01-04', '2027-01-08'],
  newsWindow: { start: '2026-12-30T06:30:00.000Z', end: '2027-01-04T00:00:00.000Z' } };
/** Old enough that the statistics always read as old, so the times below never depend on the day the test runs. */
const FIXED_COMPUTED_AT = '2026-11-23T06:31:00.000Z';
const cardLines = (card: HTMLElement) => Array.from(card.querySelectorAll('.history-card-line')).map(node => node.textContent);

test('news gathered before the overnight window opened: the day card says it is not checked yet and when the news was last checked', async () => {
  // 14:00 KST, before KRX closed at 15:30 KST (06:30Z) and the window opened; its articles are older still.
  const early = news(HYNIX, {
    asOf: '2026-11-23T05:00:00.000Z',
    articles: [article('day-1', 'positive', '2026-11-23T03:00:00.000Z'), article('day-2', 'positive', '2026-11-23T04:00:00.000Z')],
  });
  serve({ news: () => json(early), history: () => json(history(HYNIX)) });
  const view = await openCompany(/SK하이닉스/);
  let section = await readyOutlook();
  let { day, week } = cards(section);
  assert.ok(within(day).getByText('판단 유보'));
  assert.ok(day.querySelector('.history-signal-withheld'));
  assert.deepEqual(cardLines(day), ['판단 유보 · 밤사이 뉴스 아직 확인 전', '마지막 뉴스 확인 11/23(월) 14:00 KST', '과거 비슷한 날: 현재 방향이 없어 비교하지 않음']);
  assert.equal(within(day).queryByText('판단 유보 · 밤사이 새 뉴스 없음'), null);
  // The button's name reads the lines in order.
  assert.ok(screen.getByRole('button', { name: /밤사이 뉴스 아직 확인 전 마지막 뉴스 확인 11\/23\(월\) 14:00 KST 과거 비슷한 날/ }));
  // The week keeps the seven-day rule and gets no check line.
  assert.ok(within(week).getByText('상승 전망'));
  assert.deepEqual(cardLines(week), ['최근 7일 긍정 기사 2건', '과거 비슷한 주: 지지']);
  assert.ok(within(section).getByText('밤사이 기사 근거 수준: 없음'));
  assert.ok(within(section).getByText('기준선 판단 유보 · 통합 판단 유보 · 판정 해당 없음'));
  assertCleanText(section);
  view.unmount();

  // Gathered at the window's opening instant: checked, and with nothing in the window yet it is "no news", without a check line.
  resetHistoryInsightCache();
  serve({ news: () => json(news(HYNIX, { asOf: '2026-11-23T06:30:00.000Z', articles: early.articles })), history: () => json(history(HYNIX)) });
  await openCompany(/SK하이닉스/);
  section = await readyOutlook();
  ({ day } = cards(section));
  assert.deepEqual(cardLines(day), ['판단 유보 · 밤사이 새 뉴스 없음', '과거 비슷한 날: 현재 방향이 없어 비교하지 않음']);
  assert.equal(within(section).queryByText(/^마지막 뉴스 확인/), null);
});

test('during the session the evidence names today\'s session like the day card; the week, before the open and after the close keep their labels', async () => {
  serve({ news: () => json(news(HYNIX)), history: () => json(history(HYNIX, { calendar: KRX_IN_SESSION })) });
  const view = await openCompany(/SK하이닉스/);
  let section = await readyOutlook();
  let { day, week } = cards(section);
  assert.equal(day.querySelector('.history-card-title')?.textContent, '오늘 장 전망 · 장 시작 전 기준');
  assert.ok(within(section).getByRole('heading', { name: '근거 보기 · 오늘 장' }));
  assert.ok(within(section).getByRole('heading', { name: '③ 오늘 장 참고 전망(통합)' }));
  assert.equal(within(section).queryByRole('heading', { name: '근거 보기 · 다음 거래일' }), null);
  assert.equal(within(section).queryByRole('heading', { name: '③ 다음 거래일 참고 전망(통합)' }), null);
  fireEvent.click(week);
  assert.ok(within(section).getByRole('heading', { name: '근거 보기 · 다음 주' }));
  assert.ok(within(section).getByRole('heading', { name: '③ 다음 주 참고 전망(통합)' }));
  assert.equal(within(section).queryByRole('heading', { name: /오늘 장/ }), null);
  fireEvent.click(day);
  assert.ok(within(section).getByRole('heading', { name: '근거 보기 · 오늘 장' }));
  assertCleanText(section);
  view.unmount();

  // After the KRX close and before the NASDAQ open the day horizon is the next trading day.
  for (const [id, name] of [[HYNIX, /SK하이닉스/], [MSFT, /마이크로소프트/]] as const) {
    resetHistoryInsightCache();
    serve({ news: () => json(news(id)), history: () => json(history(id)) });
    const next = await openCompany(name);
    section = await readyOutlook();
    ({ day, week } = cards(section));
    assert.ok(within(section).getByRole('heading', { name: '근거 보기 · 다음 거래일' }), id);
    assert.ok(within(section).getByRole('heading', { name: '③ 다음 거래일 참고 전망(통합)' }), id);
    fireEvent.click(week);
    assert.ok(within(section).getByRole('heading', { name: '근거 보기 · 다음 주' }), id);
    assert.ok(within(section).getByRole('heading', { name: '③ 다음 주 참고 전망(통합)' }), id);
    assert.equal(within(section).queryByRole('heading', { name: /오늘 장/ }), null, id);
    next.unmount();
  }
});

test('every time in the outlook is compact KST, with the year only when it is not the target window\'s year', async () => {
  serve({ news: () => json(news(HYNIX, { asOf: '2026-11-23T13:00:00.000Z' })), history: () => json(history(HYNIX, { computedAt: FIXED_COMPUTED_AT })) });
  const view = await openCompany(/SK하이닉스/);
  let section = await readyOutlook();
  let block = evidence(section);
  assert.ok(within(block).getByText('밤사이 뉴스 기준: 11/23(월) 15:30 KST ~ 11/24(화) 09:00 KST'));
  assert.ok(within(block).getByText('기사 기준 11/23(월) 22:00 KST'));
  assert.ok(within(block).getByText('통계 계산 11/23(월) 15:31 KST · 오래된 통계'));
  fireEvent.click(cards(section).week);
  assert.ok(within(evidence(section)).getByText('기사 기준 11/23(월) 22:00 KST'));
  // No locale clock (오전·오후), no seconds, and the browser's own formatting never shows up.
  assert.doesNotMatch(section.textContent ?? '', /오전|오후|\d{1,2}:\d{2}:\d{2}|\d{4}\. \d{1,2}\. /);
  view.unmount();

  // Around New Year: times in 2026 carry the year when the target is in 2027; those in 2027 do not.
  resetHistoryInsightCache();
  serve({
    news: () => json(news(HYNIX, { asOf: '2026-12-30T05:00:00.000Z', articles: [article('day-1', 'positive', '2026-12-30T03:00:00.000Z')] })),
    history: () => json(history(HYNIX, { calendar: KRX_YEAR_END, computedAt: FIXED_COMPUTED_AT })),
  });
  await openCompany(/SK하이닉스/);
  section = await readyOutlook();
  const { day, week } = cards(section);
  assert.ok(within(day).getByText('다음 거래일 · 1/4(월)'));
  assert.deepEqual(cardLines(day), ['판단 유보 · 밤사이 뉴스 아직 확인 전', '마지막 뉴스 확인 2026/12/30(수) 14:00 KST', '과거 비슷한 날: 현재 방향이 없어 비교하지 않음']);
  assert.ok(within(week).getByText('다음 주 · 1/4(월)~1/8(금)'));
  block = evidence(section);
  assert.ok(within(block).getByText('밤사이 뉴스 기준: 2026/12/30(수) 15:30 KST ~ 1/4(월) 09:00 KST'));
  assert.ok(within(block).getByText('기사 기준 2026/12/30(수) 14:00 KST'));
  assert.ok(within(block).getByText('통계 계산 2026/11/23(월) 15:31 KST · 오래된 통계'));
  assertCleanText(section);
});

// ---------------------------------------------------------------------------
// Step 6 follow-ups, review: both exchanges, every phase, Korean dates of the article record
// ---------------------------------------------------------------------------

// What the server computes at 2026-11-22T23:00Z (08:00 KST, before the KRX open), on Saturday 2026-11-28 (KRX weekend),
// at 2026-11-23T15:00Z (10:00 EST, NASDAQ open), at 2026-11-23T22:00Z (17:00 EST, after the NASDAQ close) and on
// Thanksgiving, 2026-11-26 (NASDAQ closed; the next session is the short Friday).
const KRX_BEFORE_OPEN: Calendar = { exchange: 'KRX', phase: 'before_open', day: '2026-11-23', week: ['2026-11-23', '2026-11-27'],
  newsWindow: { start: '2026-11-20T06:30:00.000Z', end: '2026-11-23T00:00:00.000Z' } };
const KRX_WEEKEND: Calendar = { exchange: 'KRX', phase: 'after_close', day: '2026-11-30', week: ['2026-11-30', '2026-12-04'],
  newsWindow: { start: '2026-11-27T06:30:00.000Z', end: '2026-11-30T00:00:00.000Z' } };
const NASDAQ_IN_SESSION: Calendar = { exchange: 'NASDAQ', phase: 'in_session', day: '2026-11-23', week: ['2026-11-24', '2026-12-01'],
  newsWindow: { start: '2026-11-20T21:00:00.000Z', end: '2026-11-23T14:30:00.000Z' } };
const NASDAQ_AFTER_CLOSE: Calendar = { exchange: 'NASDAQ', phase: 'after_close', day: '2026-11-24', week: ['2026-11-24', '2026-12-01'],
  newsWindow: { start: '2026-11-23T21:00:00.000Z', end: '2026-11-24T14:30:00.000Z' } };
const NASDAQ_HOLIDAY: Calendar = { exchange: 'NASDAQ', phase: 'after_close', day: '2026-11-27', week: ['2026-11-27', '2026-12-03'],
  newsWindow: { start: '2026-11-25T21:00:00.000Z', end: '2026-11-27T14:30:00.000Z' } };
// And on Hangul Day, Friday 2026-10-09 (KRX closed), and on Saturday 2026-11-28 for NASDAQ, whose window opens at
// the 13:00 EST close of the short Friday.
const KRX_HOLIDAY: Calendar = { exchange: 'KRX', phase: 'after_close', day: '2026-10-12', week: ['2026-10-12', '2026-10-16'],
  newsWindow: { start: '2026-10-08T06:30:00.000Z', end: '2026-10-12T00:00:00.000Z' } };
const NASDAQ_WEEKEND: Calendar = { exchange: 'NASDAQ', phase: 'after_close', day: '2026-11-30', week: ['2026-11-30', '2026-12-04'],
  newsWindow: { start: '2026-11-27T18:00:00.000Z', end: '2026-11-30T14:30:00.000Z' } };

test('on NASDAQ, news gathered before the US close has not checked the overnight window, and the card says when it was gathered in KST', async () => {
  // 05:00 KST on 11/24 (20:00Z on 11/23), before the NASDAQ close at 06:00 KST that opens the window for the 11/24 session.
  const early = news(MSFT, { asOf: '2026-11-23T20:00:00.000Z', articles: [article('day-1', 'positive', '2026-11-23T19:00:00.000Z')] });
  const notPublic = () => json(history(MSFT, { status: 'stats_not_public', calendar: NASDAQ_AFTER_CLOSE }));
  serve({ news: () => json(early), history: notPublic });
  const view = await openCompany(/마이크로소프트/);
  let section = await readyOutlook();
  const { day, week } = cards(section);
  assert.equal(day.querySelector('.history-card-title')?.textContent, '다음 거래일 · 11/24(화)');
  assert.ok(day.querySelector('.history-signal-withheld'));
  assert.deepEqual(cardLines(day), ['판단 유보 · 밤사이 뉴스 아직 확인 전', '마지막 뉴스 확인 11/24(화) 05:00 KST', STATS_NOT_PUBLIC_MESSAGE]);
  assert.deepEqual(cardLines(week), ['최근 7일 긍정 기사 1건', STATS_NOT_PUBLIC_MESSAGE]);
  const block = evidence(section);
  assert.ok(within(block).getByText('밤사이 뉴스 기준: 11/24(화) 06:00 KST ~ 11/24(화) 23:30 KST'));
  assert.ok(within(block).getByText('기사 기준 11/24(화) 05:00 KST'));
  assertCleanText(section);
  view.unmount();

  // Gathered after the close: checked, and its article from before the close is not overnight news.
  resetHistoryInsightCache();
  serve({ news: () => json(news(MSFT, { asOf: '2026-11-23T22:00:00.000Z', articles: early.articles })), history: notPublic });
  await openCompany(/마이크로소프트/);
  section = await readyOutlook();
  assert.deepEqual(cardLines(cards(section).day), ['판단 유보 · 밤사이 새 뉴스 없음', STATS_NOT_PUBLIC_MESSAGE]);
});

test('in every phase on both exchanges the day horizon has one name on its card and in its evidence, and the week is always the next week', async () => {
  const phases = [
    [HYNIX, /SK하이닉스/, KRX_BEFORE_OPEN, '다음 거래일 · 11/23(월)', '다음 주 · 11/23(월)~11/27(금)'],
    [HYNIX, /SK하이닉스/, KRX_IN_SESSION, '오늘 장 전망 · 장 시작 전 기준', '다음 주 · 11/25(수)~12/1(화)'],
    [HYNIX, /SK하이닉스/, KRX_AFTER_CLOSE, '다음 거래일 · 11/24(화)', '다음 주 · 11/24(화)~11/30(월)'],
    [HYNIX, /SK하이닉스/, KRX_WEEKEND, '다음 거래일 · 11/30(월)', '다음 주 · 11/30(월)~12/4(금)'],
    [HYNIX, /SK하이닉스/, KRX_HOLIDAY, '다음 거래일 · 10/12(월)', '다음 주 · 10/12(월)~10/16(금)'],
    [MSFT, /마이크로소프트/, NASDAQ_BEFORE_OPEN, '다음 거래일 · 11/23(월)', '다음 주 · 11/23(월)~11/30(월)'],
    [MSFT, /마이크로소프트/, NASDAQ_IN_SESSION, '오늘 장 전망 · 장 시작 전 기준', '다음 주 · 11/24(화)~12/1(화)'],
    [MSFT, /마이크로소프트/, NASDAQ_AFTER_CLOSE, '다음 거래일 · 11/24(화)', '다음 주 · 11/24(화)~12/1(화)'],
    [MSFT, /마이크로소프트/, NASDAQ_HOLIDAY, '다음 거래일 · 11/27(금)', '다음 주 · 11/27(금)~12/3(목)'],
    [MSFT, /마이크로소프트/, NASDAQ_WEEKEND, '다음 거래일 · 11/30(월)', '다음 주 · 11/30(월)~12/4(금)'],
  ] as const;
  for (const [id, name, calendar, dayTitle, weekTitle] of phases) {
    const where = `${calendar.exchange} ${calendar.phase} ${calendar.day}`;
    const label = calendar.phase === 'in_session' ? '오늘 장' : '다음 거래일';
    resetHistoryInsightCache();
    serve({ news: () => json(news(id)), history: () => json(history(id, { calendar })) });
    const view = await openCompany(name);
    const section = await readyOutlook();
    const { day, week } = cards(section);
    assert.equal(day.querySelector('.history-card-title')?.textContent, dayTitle, where);
    assert.equal(week.querySelector('.history-card-title')?.textContent, weekTitle, where);
    assert.ok(within(section).getByRole('heading', { name: `근거 보기 · ${label}` }), where);
    assert.ok(within(section).getByRole('heading', { name: `③ ${label} 참고 전망(통합)` }), where);
    fireEvent.click(week);
    assert.ok(within(section).getByRole('heading', { name: '근거 보기 · 다음 주' }), where);
    assert.ok(within(section).getByRole('heading', { name: '③ 다음 주 참고 전망(통합)' }), where);
    assert.equal(within(section).queryByRole('heading', { name: /오늘 장|다음 거래일/ }), null, where);
    assertCleanText(section);
    view.unmount();
  }
});

test('the article record period gives Korean dates, so a bound published before 09:00 KST is not shown as the day before', async () => {
  // 08:35 KST on 11/14 and 07:30 KST on 11/24 are still 11/13 and 11/23 in UTC.
  const value = readyOf(history(HYNIX));
  value.dataAsOf = { ...value.dataAsOf, ledgerFrom: '2026-11-13T23:35:00.000Z', ledgerTo: '2026-11-23T22:30:00.000Z' };
  assert.ok(parseCompanyHistory(JSON.parse(JSON.stringify(value))));
  serve({ news: () => json(news(HYNIX)), history: () => json(value) });
  const view = await openCompany(/SK하이닉스/);
  let section = await readyOutlook();
  assert.ok(within(evidence(section)).getByText('기사 기록 기간 2026-11-14 ~ 2026-11-24'));
  fireEvent.click(cards(section).week);
  assert.ok(within(evidence(section)).getByText('기사 기록 기간 2026-11-14 ~ 2026-11-24'));
  view.unmount();

  // A calendar date is shown as sent, and the last instant of a KST day keeps that day.
  resetHistoryInsightCache();
  const dated = readyOf(history(MSFT));
  dated.dataAsOf = { ...dated.dataAsOf, ledgerFrom: '2025-01-02', ledgerTo: '2026-11-23T14:59:59.999Z' };
  assert.ok(parseCompanyHistory(JSON.parse(JSON.stringify(dated))));
  serve({ news: () => json(news(MSFT)), history: () => json(dated) });
  await openCompany(/마이크로소프트/);
  section = await readyOutlook();
  assert.ok(within(evidence(section)).getByText('기사 기록 기간 2025-01-02 ~ 2026-11-23'));
});

// ---------------------------------------------------------------------------
// Source and styles
// ---------------------------------------------------------------------------

test('the outlook component stays clear of the article list hooks, live roles, arrows and stylesheet imports', () => {
  const source = readFileSync(new URL('./HistoryInsight.tsx', import.meta.url), 'utf8');
  for (const banned of ['article-list', 'unrelated-articles', 'news-article-', 'news-unrelated-', 'role=', '\u2191', '\u2193', '\u2192', ".css'"]) {
    assert.equal(source.includes(banned), false, banned);
  }
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

/** Innermost rules (selector and body) that name an outlook class; media wrappers are looked through. */
function historyRules(css: string): Array<{ selectors: string[]; body: string }> {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(match => ({ selectors: match[1]!.split(',').map(selector => selector.trim()), body: match[2]! }))
    .filter(rule => rule.selectors.some(selector => selector.includes('.history-')));
}

function historySelectors(css: string): string[] {
  return historyRules(css).flatMap(rule => rule.selectors);
}

function declarations(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|[}\\n])\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(match, selector);
  return match[1]!;
}

test('both themes style the outlook cards, stack them on narrow screens and colour the signals with the house palette', () => {
  const dark = readFileSync(new URL('./theme.css', import.meta.url), 'utf8');
  const light = readFileSync(new URL('./theme-light.css', import.meta.url), 'utf8');
  const prefix = ':root[data-theme="light"] ';
  for (const [css, scope] of [[dark, ''], [light, prefix]] as const) {
    assert.ok(css.includes(`${scope}.history-signal-withheld`));
    assert.ok(css.includes(`${scope}.history-cards`));
    assert.ok(mediaBlocks(css, '(max-width: 760px)').some(block => block.includes(`${scope}.history-cards { grid-template-columns: 1fr; }`)));
  }
  // The dark default is unprefixed; every light outlook rule carries the light prefix.
  assert.ok(historySelectors(dark).length >= 10);
  for (const selector of historySelectors(dark)) assert.equal(selector.startsWith(':root'), false, selector);
  assert.ok(historySelectors(light).length >= 4);
  for (const selector of historySelectors(light)) assert.ok(selector.startsWith(prefix), selector);
  const palette = [
    ['positive', '#512f34', '#ffb1b4', '#fceced', '#b62d32'],
    ['negative', '#243d5c', '#aecbff', '#edf3ff', '#245bb7'],
    ['withheld', '#3a4645', '#d5dcd9', '#eef0ef', '#4f5755'],
  ] as const;
  for (const [signal, darkBackground, darkText, lightBackground, lightText] of palette) {
    const darkRule = declarations(dark, `.history-signal-${signal}`);
    assert.match(darkRule, new RegExp(`background: ${darkBackground};`));
    assert.match(darkRule, new RegExp(`color: ${darkText};`));
    const lightRule = declarations(light, `${prefix}.history-signal-${signal}`);
    assert.match(lightRule, new RegExp(`background: ${lightBackground};`));
    assert.match(lightRule, new RegExp(`color: ${lightText};`));
  }
  const card = declarations(dark, '.history-card');
  for (const rule of ['width: 100%', 'min-width: 0', 'text-align: left', 'overflow-wrap: anywhere', 'var(--surface-secondary)', 'var(--line-secondary)']) {
    assert.ok(card.includes(rule), rule);
  }
  assert.match(declarations(dark, '.history-card.selected'), /border-color: var\(--accent\)/);
  assert.match(declarations(dark, '.history-card:focus-visible'), /outline: 2px solid var\(--accent\); outline-offset: 2px/);
  // No fixed widths: nothing in the outlook rules sets a pixel width, so 360 px screens never scroll sideways.
  for (const css of [dark, light]) {
    for (const rule of historyRules(css)) assert.doesNotMatch(rule.body, /(?:^|[;\s])(?:min-|max-)?width:\s*\d+px/, rule.selectors.join(', '));
  }
});
