import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, test } from 'node:test';
import { createRequire } from 'node:module';
import type { NewsAnalysis } from '@moneycast/core';

// jsdom is a test-only dependency. Install its browser globals before importing
// React DOM and Testing Library, which capture document at module initialization.
const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => {
    window: Window & typeof globalThis & { close(): void };
  };
};
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/#calculator' });
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
// Vite and the web TypeScript project use the automatic JSX runtime.
Object.assign(globalThis, { React });
const { render, screen, fireEvent, cleanup, waitFor, within, act } = await import('@testing-library/react');
const { default: App } = await import('./App');
const originalFetch = globalThis.fetch;
const originalSessionStorage = Object.getOwnPropertyDescriptor(dom.window, 'sessionStorage')!;

function open(page = 'calculator') {
  window.history.replaceState(null, '', `http://localhost/#${page}`);
  return render(React.createElement(App));
}

function newsFixture(companyId = 'krx:005930'): NewsAnalysis {
  const nvidia = companyId === 'nasdaq:NVDA';
  return {
    company: nvidia
      ? { id: companyId, name: '엔비디아', symbol: 'NVDA', exchange: 'NASDAQ', region: 'US' }
      : { id: companyId, name: '삼성전자', symbol: '005930', exchange: 'KOSPI', region: 'KR' },
    status: 'not_configured', articles: [], asOf: '2026-10-27T00:00:00.000Z',
    period: { start: '2026-11-02', end: '2026-11-06' },
    evidence: 'none', summary: '테스트 전용: 근거 부족으로 판단을 유보합니다.',
    positiveFactors: [], negativeFactors: [], risks: ['테스트 전용: 미래 방향은 불확실합니다.'],
    provider: null, analysisVersion: 'news-evidence-test-v1',
  };
}

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.history.replaceState(null, '', 'http://localhost/#calculator');
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  Object.defineProperty(window, 'sessionStorage', originalSessionStorage);
  window.sessionStorage.clear();
  window.history.replaceState(null, '', 'http://localhost/#calculator');
});
after(() => dom.window.close());

test('calculator renders default assumption, final assets, principal and a labeled chart', () => {
  open();
  assert.equal((screen.getByLabelText('현재 시드머니') as HTMLInputElement).value, '10,000,000');
  assert.equal((screen.getByLabelText('목표 기간') as HTMLInputElement).value, '60');
  assert.ok(screen.getAllByText('46,669,685원').length >= 1);
  assert.ok(screen.getAllByText('40,000,000원').length >= 1);
  assert.ok(screen.getByText('목표보다 3,330,315원 부족합니다. 납입액이나 기간을 조정해 보세요.'));
  assert.match(screen.getByRole('img', { name: /5년 자산 추이/ }).getAttribute('aria-label')!, /목표 50,000,000원/);
  assert.ok(screen.getByText(/세금·수수료·물가상승률 미반영/));
  assert.ok(screen.getByText(/수익률은 사용자의 가정/));
});

test('changing monthly contribution immediately updates results, chart and goal message', () => {
  open();
  fireEvent.change(screen.getByLabelText('매월 저축·투자 금액'), { target: { value: '1000000' } });
  assert.ok(screen.getAllByText('80,576,554원').length >= 1);
  assert.match(screen.getByRole('img').getAttribute('aria-label')!, /80,576,554원/);
  assert.ok(screen.getByText('현재 가정대로라면, 목표를 달성해요.'));
  assert.ok(screen.getByText('목표보다 30,576,554원 여유가 있는 계산 결과입니다.'));
});

test('missing, negative and nonnumeric values show errors and remove the stale chart', () => {
  open();
  const seed = screen.getByLabelText('현재 시드머니');
  for (const value of ['', '-1', '금액 아님']) {
    fireEvent.change(seed, { target: { value } });
    assert.equal(seed.getAttribute('aria-invalid'), 'true');
    assert.equal(screen.queryByRole('img', { name: /자산 추이/ }), null);
    assert.ok(screen.getByRole('status'));
    assert.equal((screen.getByRole('button', { name: '계산 결과 CSV 저장' }) as HTMLButtonElement).disabled, true);
  }
  fireEvent.change(seed, { target: { value: '10000000' } });
  assert.equal(seed.getAttribute('aria-invalid'), 'false');
  assert.ok(screen.getByRole('img', { name: /자산 추이/ }));
});

test('zero return shows exactly principal, and boundary errors recover after correction', () => {
  open();
  fireEvent.change(screen.getByLabelText(/연간 예상 수익률/), { target: { value: '0' } });
  assert.ok(screen.getAllByText('40,000,000원').length >= 1);
  assert.ok(screen.getByText('+0원'));
  assert.match(screen.getByRole('img').getAttribute('aria-label')!, /예상 자산 40,000,000원, 납입 원금 40,000,000원/);
  const period = screen.getByLabelText('목표 기간');
  fireEvent.change(period, { target: { value: '0' } });
  assert.equal(period.getAttribute('aria-invalid'), 'true');
  assert.ok(screen.getByText('목표 기간은 1개월 이상, 50년 이하로 입력해 주세요.'));
  fireEvent.change(period, { target: { value: '12' } });
  assert.ok(screen.getByRole('img', { name: /1년 자산 추이/ }));
  assert.ok(screen.getAllByText('16,000,000원').length >= 1);
});

test('zero money and an unset goal remain a valid calculation', () => {
  open();
  for (const label of ['현재 시드머니', '매월 저축·투자 금액', '목표 금액']) {
    fireEvent.change(screen.getByLabelText(label), { target: { value: '0' } });
  }
  assert.ok(screen.getByRole('img', { name: /예상 자산 0원, 납입 원금 0원/ }));
  assert.ok(screen.getByText('나의 자산 계획이 시작되었어요.'));
  assert.ok(screen.getByText('0원은 목표 없이 자산 추이만 계산합니다.'));
});

test('scenario toggle exposes labeled hypothetical rates and hides them when disabled', () => {
  open();
  const toggle = screen.getByRole('checkbox', { name: '시나리오 비교' });
  assert.equal(screen.queryByText('보수'), null);
  fireEvent.click(toggle);
  assert.ok(screen.getByText('보수'));
  assert.ok(screen.getByText('기준'));
  assert.ok(screen.getByText('낙관'));
  assert.ok(screen.getByText('3%'));
  assert.ok(screen.getByText('7%'));
  assert.ok(screen.getByText(/확률이나 예측이 아닙니다/));
  fireEvent.click(toggle);
  assert.equal(screen.queryByText('보수'), null);
});

test('month slider gives keyboard-accessible values from initial to final assets', () => {
  open();
  const slider = screen.getByRole('slider', { name: '월별 자산 확인' });
  fireEvent.change(slider, { target: { value: '0' } });
  assert.equal(slider.getAttribute('aria-valuetext'), '0개월, 예상 자산 10,000,000원, 원금 10,000,000원');
  assert.ok(screen.getByText('시작 시점 예상 자산'));
  fireEvent.change(slider, { target: { value: '60' } });
  assert.equal(slider.getAttribute('aria-valuetext'), '60개월, 예상 자산 46,669,685원, 원금 40,000,000원');
});

test('duration input calculates whole months from one month through fifty years', () => {
  open();
  fireEvent.change(screen.getByLabelText(/연간 예상 수익률/), { target: { value: '0' } });
  const period = screen.getByLabelText('목표 기간') as HTMLInputElement;
  for (const [months, label, expected] of [
    [1, '1개월', '10,500,000원'], [12, '1년', '16,000,000원'],
    [13, '1년 1개월', '16,500,000원'], [600, '50년', '310,000,000원'],
  ] as const) {
    fireEvent.change(period, { target: { value: String(months) } });
    assert.equal(period.getAttribute('aria-invalid'), 'false');
    const chart = screen.getByRole('img', { name: new RegExp(`^${label} 자산 추이`) });
    assert.ok(chart.getAttribute('aria-label')!.includes(`예상 자산 ${expected}, 납입 원금 ${expected}`));
    assert.ok(screen.getAllByText(`${label} 후 예상 자산`).length >= 1);
    assert.equal(screen.getByRole('slider', { name: '월별 자산 확인' }).getAttribute('max'), String(months));
  }
});

test('duration slider starts at one month and changes the input and chart in single-month steps', () => {
  open();
  const slider = screen.getByRole('slider', { name: '목표 기간 슬라이더' });
  assert.equal(slider.getAttribute('min'), '1');
  assert.equal(slider.getAttribute('max'), '600');
  assert.equal(slider.getAttribute('step'), '1');
  for (const months of [1, 2, 13]) {
    fireEvent.change(slider, { target: { value: String(months) } });
    assert.equal((screen.getByLabelText('목표 기간') as HTMLInputElement).value, String(months));
    assert.equal(screen.getByRole('slider', { name: '월별 자산 확인' }).getAttribute('max'), String(months));
  }
  assert.equal(slider.getAttribute('aria-valuetext'), '1년 1개월');
  assert.ok(screen.getByRole('img', { name: /^1년 1개월 자산 추이/ }));
});

test('month duration rejects missing, fractional and out-of-range values and recovers on correction', () => {
  open();
  const period = screen.getByLabelText('목표 기간');
  for (const value of ['', '0', '-1', '0.5', '1.0000000001', '601', '개월']) {
    fireEvent.change(period, { target: { value } });
    assert.equal(period.getAttribute('aria-invalid'), 'true', value);
    assert.equal(screen.queryByRole('img', { name: /자산 추이/ }), null);
    assert.equal((screen.getByRole('button', { name: '계산 결과 CSV 저장' }) as HTMLButtonElement).disabled, true);
  }
  fireEvent.change(period, { target: { value: '1' } });
  assert.equal(period.getAttribute('aria-invalid'), 'false');
  assert.ok(screen.getByRole('img', { name: /^1개월 자산 추이/ }));
});

test('malformed news data shows an error instead of crashing the news screen', async () => {
  globalThis.fetch = (async () => response({ ...newsFixture(), status: ['ready'], positiveFactors: null })) as typeof fetch;
  open('news');
  assert.ok(await screen.findByText('뉴스 응답 형식이 올바르지 않습니다.'));
  assert.equal(document.querySelectorAll('.article-list article').length, 0);
  assert.ok(screen.getByRole('button', { name: /다시 시도/ }));
});

test('news navigation shows loading then an explicit configuration state without invented articles', async () => {
  let resolveRequest!: (value: Response) => void;
  globalThis.fetch = (() => new Promise<Response>(resolve => { resolveRequest = resolve; })) as typeof fetch;
  open();
  fireEvent.click(within(screen.getByRole('navigation', { name: '주 메뉴' })).getByRole('button', { name: '뉴스 인사이트' }));
  assert.ok(screen.getByRole('status'));
  assert.ok(screen.getByText('뉴스 근거를 확인하고 있어요'));
  await waitFor(() => assert.equal(typeof resolveRequest, 'function'));
  await act(async () => resolveRequest(response(newsFixture())));
  assert.ok(await screen.findByText('데이터 연동 대기'));
  assert.ok(screen.getByText('뉴스가 없으면 방향을 추측하지 않습니다.'));
  assert.equal(document.querySelectorAll('.article-list article').length, 0);
  assert.ok(screen.getByText(/2026-11-02 ~ 2026-11-06/));
  assert.ok(screen.getByText(/뉴스는 미래 주가의 방향이나 원인을 증명하지 않습니다/));
});

test('company search keeps ticker and exchange identity through selection, and handles no matches', async () => {
  const requests: string[] = [];
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0]) => {
    requests.push(String(url));
    const id = new URL(String(url), 'http://localhost').searchParams.get('companyId')!;
    return response(newsFixture(id));
  }) as typeof fetch;
  open('news');
  await screen.findByText('데이터 연동 대기');
  const search = screen.getByRole('textbox', { name: '회사명 또는 종목 코드 검색' });
  fireEvent.change(search, { target: { value: 'nvda' } });
  const nvidia = screen.getByRole('button', { name: /엔비디아.*NVDA.*NASDAQ/ });
  fireEvent.click(nvidia);
  await waitFor(() => assert.equal(nvidia.getAttribute('aria-pressed'), 'true'));
  await screen.findByText('데이터 연동 대기');
  assert.ok(requests.some(url => url.includes('nasdaq%3ANVDA')));
  assert.ok(screen.getByRole('heading', { name: /엔비디아 NVDA · NASDAQ/ }));
  fireEvent.change(search, { target: { value: '존재하지않는회사' } });
  assert.ok(screen.getByText('검색 결과가 없습니다.'));
  fireEvent.click(screen.getByRole('button', { name: '검색어 지우기' }));
  assert.ok(screen.getByRole('button', { name: /삼성전자.*005930.*KOSPI/ }));
});

test('company icons use local official assets and a failed image preserves the company identity', async () => {
  globalThis.fetch = (async () => response(newsFixture())) as typeof fetch;
  open('news');
  await screen.findByText('데이터 연동 대기');
  const expected = ['samsung', 'sk-hynix', 'naver', 'hyundai', 'apple', 'nvidia', 'microsoft', 'tesla'];
  const icons = Array.from(document.querySelectorAll<HTMLImageElement>('.company-logo img'));
  assert.equal(icons.length, 8);
  assert.deepEqual(icons.map(icon => icon.getAttribute('src')), expected.map(name => `/company-icons/${name}.png`));
  for (const icon of icons) {
    assert.equal(icon.alt, '');
    assert.equal(icon.parentElement!.getAttribute('aria-hidden'), 'true');
  }
  const samsung = screen.getByRole('button', { name: /삼성전자.*005930.*KOSPI/ });
  fireEvent.error(samsung.querySelector('img')!);
  assert.equal(samsung.querySelector('img'), null);
  assert.equal(samsung.querySelector('.company-logo')!.textContent, '삼');
  assert.equal(samsung.getAttribute('aria-pressed'), 'true');
  assert.equal(document.querySelectorAll('.company-logo img').length, 7);
  assert.ok(screen.getByRole('button', { name: /삼성전자.*005930.*KOSPI/ }));
});

test('news network failure is visible and retry recovers', async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) throw new Error('테스트 연결 실패');
    return response(newsFixture());
  }) as typeof fetch;
  open('news');
  const alert = await screen.findByRole('alert');
  assert.ok(within(alert).getByText('뉴스를 불러오지 못했어요'));
  assert.ok(within(alert).getByText('테스트 연결 실패'));
  fireEvent.click(within(alert).getByRole('button', { name: /다시 시도/ }));
  assert.ok(await screen.findByText('데이터 연동 대기'));
  assert.equal(calls, 2);
});

test('a response for a different company produces an error instead of displaying mismatched evidence', async () => {
  globalThis.fetch = (async () => response(newsFixture('nasdaq:NVDA'))) as typeof fetch;
  open('news');
  const alert = await screen.findByRole('alert');
  assert.ok(within(alert).getByText('뉴스 응답 형식이 올바르지 않습니다.'));
  assert.equal(screen.queryByText('데이터 연동 대기'), null);
});

test('insufficient evidence preserves article source, classification, original link and uncertainty', async () => {
  const fixture = newsFixture();
  fixture.status = 'insufficient';
  fixture.provider = '테스트 전용 제공자';
  fixture.evidence = 'low';
  fixture.articles = [{
    id: 'test-only-article', title: '테스트 전용 기사 (실제 뉴스 아님)', source: '테스트 전용 출처',
    publishedAt: '2026-10-26T00:00:00Z', url: 'https://example.test/test-only-article',
    sentiment: 'neutral', rationale: '테스트 전용: 방향을 정하기에 충분하지 않습니다.',
  }];
  globalThis.fetch = (async () => response(fixture)) as typeof fetch;
  open('news');
  assert.ok(await screen.findByText('근거 부족 · 판단 유보'));
  assert.ok(screen.getByText('중립'));
  assert.ok(screen.getByText(/근거 수준: 낮음 · 기사 1건/));
  const link = screen.getByRole('link', { name: '테스트 전용 기사 (실제 뉴스 아님)' });
  assert.equal(link.getAttribute('href'), 'https://example.test/test-only-article');
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
  assert.ok(screen.getByText(/테스트 전용 출처/));
  assert.ok(screen.getByText('전망이 빗나갈 수 있는 이유'));
  assert.ok(screen.getByText(/출처: 테스트 전용 제공자 · news-evidence-test-v1/));
});

function marketauxFixture(): NewsAnalysis {
  return {
    ...newsFixture(), status: 'insufficient', provider: 'Marketaux', evidence: 'low',
    newsWindow: { start: '2026-10-20T00:00:00.000Z', end: '2026-10-27T00:00:00.000Z' },
    cachedUntil: '2026-10-27T00:05:00.000Z',
    articles: [{
      id: 'test-marketaux-article', title: 'Test fixture: Samsung research update', source: 'publisher.example.test',
      publishedAt: '2026-10-26T10:00:00Z', url: 'https://publisher.example.test/test-fixture',
      sentiment: 'positive', rationale: '테스트 전용: 제공자 감성 점수에 따른 분류입니다.',
      language: 'en', sentimentScore: 0.625, classificationMethod: 'provider',
      providerEntity: { symbol: '005930.KS', name: 'Samsung Electronics Co., Ltd.', exchange: null, country: 'kr' },
    }],
  };
}

test('Marketaux metadata keeps the original title, language, provider classification and distinct time windows', async () => {
  globalThis.fetch = (async () => response(marketauxFixture())) as typeof fetch;
  open('news');
  const link = await screen.findByRole('link', { name: 'Test fixture: Samsung research update' });
  assert.equal(link.getAttribute('href'), 'https://publisher.example.test/test-fixture');
  assert.ok(screen.getByText('원문 언어: 영어'));
  assert.ok(screen.getByText(/Marketaux 제공자 분류 · 기사 감성 점수 0.625/));
  assert.ok(screen.getByText(/주가 상승 확률이 아닙니다/));
  assert.ok(screen.getByText(/제공자 기업 식별: Samsung Electronics Co., Ltd. · 005930.KS · 거래소 정보 미제공 · KR/));
  assert.ok(screen.getByText(/뉴스 수집 기간:/));
  assert.ok(screen.getByText(/다음 주 참고 기간: 2026-11-02 ~ 2026-11-06/));
  assert.ok(screen.getByText(/캐시 만료:/));
  assert.ok(screen.getByText(/무료 연동은 요청당 최대 3개 기사/));
});

test('missing provider sentiment stays unclassified with no invented neutral label or score', async () => {
  const fixture = marketauxFixture();
  delete fixture.articles[0]!.sentimentScore;
  fixture.articles[0]!.sentiment = 'unclassified';
  fixture.articles[0]!.classificationMethod = 'unavailable';
  globalThis.fetch = (async () => response(fixture)) as typeof fetch;
  open('news');
  assert.ok(await screen.findByText('미분류'));
  const article = document.querySelector('.article-list article') as HTMLElement;
  assert.equal(within(article).queryByText('중립'), null);
  assert.equal(within(article).queryByText(/기사 감성 점수/), null);
  assert.ok(within(article).getByText('제공자 감성 점수가 없어 분류하지 않았습니다.'));
  assert.ok(screen.getByText('미분류 기사는 긍정·부정 요인 집계에서 제외합니다.'));
});

test('a small positive provider score retains its sign instead of rounding to a neutral-looking zero', async () => {
  const fixture = marketauxFixture();
  fixture.articles[0]!.sentimentScore = 0.00001;
  globalThis.fetch = (async () => response(fixture)) as typeof fetch;
  open('news');
  assert.ok(await screen.findByText(/기사 감성 점수 0.00001 /));
  assert.ok(screen.getByText('긍정'));
});

test('invalid provider sentiment metadata is rejected before articles render', async () => {
  const fixture = marketauxFixture();
  fixture.articles[0]!.sentimentScore = 2;
  globalThis.fetch = (async () => response(fixture)) as typeof fetch;
  open('news');
  assert.ok(await screen.findByText('뉴스 응답 형식이 올바르지 않습니다.'));
  assert.equal(screen.queryByRole('link', { name: 'Test fixture: Samsung research update' }), null);
});

test('a provider retry deadline is visible and blocks repeated refresh requests', async () => {
  const fixture = marketauxFixture();
  fixture.status = 'rate_limited'; fixture.evidence = 'none'; fixture.articles = [];
  fixture.retryAt = new Date(Date.now() + 60000).toISOString();
  fixture.message = '테스트 전용: Marketaux 호출 한도에 도달했습니다.';
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return response(fixture); }) as typeof fetch;
  open('news');
  await screen.findByText('호출 제한');
  assert.ok(screen.getByText(/다시 요청 가능한 시각:/));
  const refresh = screen.getByRole('button', { name: '분석 다시 불러오기' }) as HTMLButtonElement;
  const retry = screen.getByRole('button', { name: /다시 시도/ }) as HTMLButtonElement;
  assert.equal(refresh.disabled, true);
  assert.equal(retry.disabled, true);
  fireEvent.click(refresh); fireEvent.click(retry);
  assert.equal(calls, 1);
});

test('an elapsed retry deadline allows a manual retry without automatic fetching', async () => {
  const fixture = marketauxFixture();
  fixture.status = 'rate_limited'; fixture.evidence = 'none'; fixture.articles = [];
  fixture.retryAt = new Date(Date.now() - 1000).toISOString();
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return response(calls === 1 ? fixture : marketauxFixture()); }) as typeof fetch;
  open('news');
  await screen.findByText('호출 제한');
  assert.equal(calls, 1);
  const retry = screen.getByRole('button', { name: /다시 시도/ }) as HTMLButtonElement;
  assert.equal(retry.disabled, false);
  fireEvent.click(retry);
  await screen.findByRole('link', { name: 'Test fixture: Samsung research update' });
  assert.equal(calls, 2);
});

test('calculator is the default destination and feature navigation has no dashboard or duplicate calculator tabs', () => {
  open('');
  assert.ok(screen.getByLabelText('현재 시드머니'));
  const desktop = screen.getByRole('navigation', { name: '주 메뉴' });
  const mobile = screen.getByRole('navigation', { name: '모바일 주 메뉴' });
  for (const menu of [desktop, mobile]) {
    assert.equal(within(menu).queryByRole('button', { name: '대시보드' }), null);
    assert.equal(within(menu).getByRole('button', { name: '목표 자금 계산기' }).getAttribute('aria-current'), 'page');
    assert.ok(within(menu).getByRole('button', { name: '뉴스 인사이트' }));
  }
  assert.equal(document.querySelector('.dashboard-tabs'), null);
  assert.equal(screen.queryByRole('button', { name: '자산 시뮬레이터' }), null);
});

test('sidebar starts open, exposes its controlled region and can close and reopen without losing the calculator', () => {
  open();
  const sidebar = document.getElementById('moneycast-sidebar')!;
  assert.ok(sidebar);
  assert.equal(sidebar.hidden, false);
  const close = screen.getByRole('button', { name: '사이드바 닫기' });
  assert.equal(close.getAttribute('aria-expanded'), 'true');
  assert.equal(close.getAttribute('aria-controls'), sidebar.id);
  fireEvent.click(close);
  assert.equal(sidebar.hidden, true);
  assert.equal(screen.queryByRole('navigation', { name: '주 메뉴' }), null);
  const reopen = screen.getByRole('button', { name: '사이드바 열기' });
  assert.equal(reopen.getAttribute('aria-expanded'), 'false');
  assert.equal(reopen.getAttribute('aria-controls'), sidebar.id);
  assert.equal(window.sessionStorage.getItem('moneycast.sidebar'), 'closed');
  assert.ok(screen.getByLabelText('현재 시드머니'));
  fireEvent.click(reopen);
  assert.equal(sidebar.hidden, false);
  assert.equal(window.sessionStorage.getItem('moneycast.sidebar'), 'open');
  assert.ok(screen.getByRole('navigation', { name: '주 메뉴' }));
});

test('sidebar restores a collapsed session after remount and clearing the session restores the open default', () => {
  const first = open();
  fireEvent.click(screen.getByRole('button', { name: '사이드바 닫기' }));
  first.unmount();
  const restored = open();
  assert.equal(document.getElementById('moneycast-sidebar')!.hidden, true);
  assert.equal(screen.getByRole('button', { name: '사이드바 열기' }).getAttribute('aria-expanded'), 'false');
  restored.unmount();
  window.sessionStorage.clear();
  open();
  assert.equal(document.getElementById('moneycast-sidebar')!.hidden, false);
  assert.ok(screen.getByRole('button', { name: '사이드바 닫기' }));
});

test('blocked session storage gracefully keeps sidebar controls and calculator usable', () => {
  Object.defineProperty(window, 'sessionStorage', {
    configurable: true,
    get() { throw new dom.window.DOMException('Storage blocked for test', 'SecurityError'); },
  });
  open();
  assert.equal(document.getElementById('moneycast-sidebar')!.hidden, false);
  fireEvent.click(screen.getByRole('button', { name: '사이드바 닫기' }));
  assert.equal(document.getElementById('moneycast-sidebar')!.hidden, true);
  fireEvent.click(screen.getByRole('button', { name: '사이드바 열기' }));
  assert.equal(document.getElementById('moneycast-sidebar')!.hidden, false);
  assert.ok(screen.getByLabelText('현재 시드머니'));
});

test('both sidebar introductions explain the feature before their CTAs open the working tools', async () => {
  let requests = 0;
  globalThis.fetch = (async () => { requests += 1; return response(newsFixture()); }) as typeof fetch;
  open();
  const sidebar = document.getElementById('moneycast-sidebar')!;
  fireEvent.click(within(sidebar).getByRole('button', { name: '계산기 사용법' }));
  assert.equal(window.location.hash, '#calculator-intro');
  assert.equal(screen.queryByLabelText('현재 시드머니'), null);
  fireEvent.click(within(screen.getByRole('main')).getByRole('button', { name: '목표 자금 계산 시작하기' }));
  assert.equal(window.location.hash, '#calculator');
  assert.ok(screen.getByLabelText('현재 시드머니'));
  fireEvent.click(within(sidebar).getByRole('button', { name: '인사이트 사용법' }));
  assert.equal(window.location.hash, '#news-intro');
  assert.equal(requests, 0);
  assert.equal(screen.queryByRole('textbox', { name: '회사명 또는 종목 코드 검색' }), null);
  fireEvent.click(within(screen.getByRole('main')).getByRole('button', { name: '회사 뉴스 살펴보기' }));
  assert.equal(window.location.hash, '#news');
  assert.ok(await screen.findByText('데이터 연동 대기'));
  assert.ok(screen.getByRole('textbox', { name: '회사명 또는 종목 코드 검색' }));
  assert.equal(requests, 1);
});

test('feature introductions remain reachable from the main page heading when the sidebar is closed', async () => {
  globalThis.fetch = (async () => response(newsFixture())) as typeof fetch;
  open();
  fireEvent.click(screen.getByRole('button', { name: '사이드바 닫기' }));
  fireEvent.click(within(screen.getByRole('main')).getByRole('button', { name: '계산기 사용법' }));
  assert.equal(window.location.hash, '#calculator-intro');
  fireEvent.click(screen.getByRole('button', { name: '목표 자금 계산 시작하기' }));
  const mobile = screen.getByRole('navigation', { name: '모바일 주 메뉴' });
  fireEvent.click(within(mobile).getByRole('button', { name: '뉴스 인사이트' }));
  assert.ok(await screen.findByText('데이터 연동 대기'));
  fireEvent.click(within(screen.getByRole('main')).getByRole('button', { name: '인사이트 사용법' }));
  assert.equal(window.location.hash, '#news-intro');
  assert.ok(screen.getByRole('button', { name: '회사 뉴스 살펴보기' }));
  assert.equal(document.getElementById('moneycast-sidebar')!.hidden, true);
});

test('introduction deep links and browser back/forward restore the correct feature screen', async () => {
  open('calculator-intro');
  fireEvent.click(screen.getByRole('button', { name: '목표 자금 계산 시작하기' }));
  assert.ok(screen.getByLabelText('현재 시드머니'));
  await act(async () => window.history.back());
  await waitFor(() => assert.equal(window.location.hash, '#calculator-intro'));
  assert.ok(await screen.findByRole('button', { name: '목표 자금 계산 시작하기' }));
  await act(async () => window.history.forward());
  await waitFor(() => assert.equal(window.location.hash, '#calculator'));
  assert.ok(await screen.findByLabelText('현재 시드머니'));
  await act(async () => {
    window.history.replaceState(null, '', 'http://localhost/#news-intro');
    window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));
  });
  assert.ok(screen.getByRole('button', { name: '회사 뉴스 살펴보기' }));
  assert.equal(screen.queryByLabelText('현재 시드머니'), null);
});

test('legacy dashboard and unknown hash routes both resolve to the calculator', () => {
  for (const hash of ['dashboard', 'not-a-moneycast-route']) {
    const view = open(hash);
    assert.ok(screen.getByLabelText('현재 시드머니'));
    assert.equal(within(screen.getByRole('navigation', { name: '주 메뉴' })).getByRole('button', { name: '목표 자금 계산기' }).getAttribute('aria-current'), 'page');
    assert.equal(screen.queryByRole('button', { name: '대시보드' }), null);
    view.unmount();
  }
});

test('reopening news and remounting the app reuse a valid six-hour company analysis', async () => {
  let calls = 0;
  const now = Date.now();
  const fixture: NewsAnalysis = {
    ...newsFixture(), status: 'insufficient', provider: 'Marketaux', analysisVersion: 'news-evidence-v2',
    asOf: new Date(now).toISOString(), cachedUntil: new Date(now + 6 * 60 * 60 * 1000).toISOString(),
    summary: '메뉴 이동 후에도 보존하는 실제 형식의 테스트 캐시입니다.',
  };
  globalThis.fetch = (async () => { calls++; return response(fixture); }) as typeof fetch;
  const view = open('news');
  await screen.findByText(fixture.summary);
  fireEvent.click(within(screen.getByRole('navigation', { name: '주 메뉴' })).getByRole('button', { name: '목표 자금 계산기' }));
  assert.ok(screen.getByLabelText('현재 시드머니'));
  fireEvent.click(within(screen.getByRole('navigation', { name: '주 메뉴' })).getByRole('button', { name: '뉴스 인사이트' }));
  await screen.findByText(fixture.summary);
  assert.equal(calls, 1);
  assert.ok(window.localStorage.length > 0);
  view.unmount();
  open('news');
  await screen.findByText(fixture.summary);
  assert.equal(calls, 1);
});
