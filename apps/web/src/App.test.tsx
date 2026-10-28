import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, test } from 'node:test';
import { createRequire } from 'node:module';
import { NEWS_CACHE_ANALYSIS_VERSION, type NewsAnalysis } from '@moneycast/core';

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
const originalLocalStorage = Object.getOwnPropertyDescriptor(dom.window, 'localStorage')!;
const originalMatchMedia = Object.getOwnPropertyDescriptor(dom.window, 'matchMedia');

function mobileViewport() {
  const listeners = new Set<() => void>();
  const media = {
    matches: true,
    addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
  };
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => media });
  return (mobile: boolean) => {
    media.matches = mobile;
    act(() => listeners.forEach(listener => listener()));
  };
}

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
  Object.defineProperty(window, 'localStorage', originalLocalStorage);
  Object.defineProperty(window, 'sessionStorage', originalSessionStorage);
  if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
  else Reflect.deleteProperty(window, 'matchMedia');
  window.sessionStorage.clear();
  window.history.replaceState(null, '', 'http://localhost/#calculator');
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.removeProperty('color-scheme');
});
after(() => dom.window.close());

test('dark is the default and theme switching preserves calculator inputs and results', () => {
  open();
  assert.equal(document.documentElement.dataset.theme, 'dark');
  assert.equal(document.documentElement.style.colorScheme, 'dark');
  fireEvent.change(screen.getByLabelText('매월 저축·투자 금액'), { target: { value: '1000000' } });
  fireEvent.click(screen.getByRole('button', { name: '라이트 모드로 전환' }));
  assert.equal(document.documentElement.dataset.theme, 'light');
  assert.equal(document.documentElement.style.colorScheme, 'light');
  assert.equal(window.localStorage.getItem('moneycast.theme'), 'light');
  assert.equal((screen.getByLabelText('매월 저축·투자 금액') as HTMLInputElement).value, '1000000');
  assert.ok(screen.getAllByText('80,576,554원').length >= 1);
  fireEvent.click(screen.getByRole('button', { name: '다크 모드로 전환' }));
  assert.equal(document.documentElement.dataset.theme, 'dark');
  assert.equal(window.localStorage.getItem('moneycast.theme'), 'dark');
});

test('saved light mode survives navigation and recreating the app', () => {
  window.localStorage.setItem('moneycast.theme', 'light');
  const view = open();
  assert.equal(document.documentElement.dataset.theme, 'light');
  fireEvent.click(screen.getByRole('button', { name: '계산 및 데이터 안내 열기' }));
  assert.equal(window.location.hash, '#guide');
  assert.equal(document.documentElement.dataset.theme, 'light');
  view.unmount();
  open();
  assert.equal(document.documentElement.dataset.theme, 'light');
  assert.ok(screen.getByRole('button', { name: '다크 모드로 전환' }));
});

test('an invalid saved appearance falls back to dark mode', () => {
  window.localStorage.setItem('moneycast.theme', 'unrecognized');
  open();
  assert.equal(document.documentElement.dataset.theme, 'dark');
  assert.ok(screen.getByRole('button', { name: '라이트 모드로 전환' }));
});

test('blocked local storage does not prevent changing the theme', () => {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get() { throw new dom.window.DOMException('Storage blocked for test', 'SecurityError'); },
  });
  open();
  assert.equal(document.documentElement.dataset.theme, 'dark');
  fireEvent.click(screen.getByRole('button', { name: '라이트 모드로 전환' }));
  assert.equal(document.documentElement.dataset.theme, 'light');
  fireEvent.click(screen.getByRole('button', { name: '다크 모드로 전환' }));
  assert.equal(document.documentElement.dataset.theme, 'dark');
  assert.ok(screen.getByLabelText('현재 시드머니'));
});

test('calculator renders default assumption, final assets, principal and a labeled chart', () => {
  open();
  assert.equal((screen.getByLabelText('현재 시드머니') as HTMLInputElement).value, '10,000,000');
  assert.equal((screen.getByLabelText('목표 기간') as HTMLInputElement).value, '60');
  assert.ok(screen.getAllByText('46,669,685원').length >= 1);
  assert.ok(screen.getAllByText('40,000,000원').length >= 1);
  assert.ok(screen.getByText('목표보다 3,330,315원 부족합니다. 납입액이나 기간을 조정해 보세요.'));
  assert.match(screen.getByRole('img', { name: /5년 자산 추이/ }).getAttribute('aria-label')!, /목표 50,000,000원/);
  assert.ok(screen.getByText(/세금·수수료 미반영 · 물가상승은 목표 금액에만 선택 반영/));
  assert.ok(screen.getByText(/수익률은 사용자의 가정/));
  assert.equal(document.querySelector('.calculator-card .section-number'), null);
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

const targetInput = () => screen.getByLabelText('목표 금액') as HTMLInputElement;
const targetSource = () => document.getElementById('target-source')!.textContent;
const chartLabel = () => screen.getByRole('img', { name: /자산 추이/ }).getAttribute('aria-label')!;

test('each goal type starts from a labelled example and shows only the entries that set its amount', () => {
  open();
  assert.equal(targetSource(), '예시 금액');
  assert.ok(screen.getByLabelText('목표 이름'));
  assert.ok(screen.getByText('자유 목표 · 예시 금액 5,000만 원'));
  fireEvent.click(screen.getByRole('button', { name: '내 집 마련' }));
  assert.equal(screen.getByRole('button', { name: '내 집 마련' }).getAttribute('aria-pressed'), 'true');
  assert.equal((screen.getByLabelText('예상 매입 가격') as HTMLInputElement).value, '300,000,000');
  assert.equal(targetInput().value, '300,000,000');
  assert.equal(targetSource(), '예시 금액');
  assert.match(chartLabel(), /목표 300,000,000원/);
  assert.equal(screen.queryByLabelText('대출 예정 금액'), null);
  const more = screen.getByRole('button', { name: '더 자세히 입력(선택)' });
  assert.equal(more.getAttribute('aria-expanded'), 'false');
  assert.equal(document.getElementById('goal-more')!.hidden, true);
  fireEvent.click(more);
  assert.equal(document.getElementById('goal-more')!.hidden, false);
  assert.ok(screen.getByLabelText('지역(시·도)'));
  for (const [goal, label, value] of [['자동차', '예상 차량 가격', '40,000,000'], ['여행', '총 예산', '10,000,000']] as const) {
    fireEvent.click(screen.getByRole('button', { name: goal }));
    assert.equal((screen.getByLabelText(label) as HTMLInputElement).value, value);
    assert.equal(targetInput().value, value);
  }
  assert.ok(screen.getByText(/여행 경비 정보를 제공하지 않아요/));
});

test('home equity subtracts the planned loan, adds costs and stays undecided until the loan is entered', () => {
  open();
  fireEvent.click(screen.getByRole('button', { name: '내 집 마련' }));
  fireEvent.click(screen.getByRole('button', { name: '자기자본' }));
  assert.equal(targetInput().value, '');
  assert.equal(targetInput().placeholder, '미정');
  assert.equal(targetSource(), '미정');
  assert.ok(screen.getByText('목표 금액이 아직 정해지지 않았어요.'));
  assert.ok(screen.getByText('목표 상세의 빈 칸(대출 예정 금액)을 채우면 달성률을 보여 드려요.'));
  assert.doesNotMatch(chartLabel(), /목표/);
  fireEvent.change(screen.getByLabelText('대출 예정 금액'), { target: { value: '200000000' } });
  assert.equal(targetInput().value, '100,000,000');
  assert.equal(targetSource(), '상세 계산');
  assert.ok(screen.getByText('= 매입 가격 3억 원 − 대출 예정 금액 2억 원'));
  assert.match(chartLabel(), /목표 100,000,000원/);
  fireEvent.click(screen.getByRole('button', { name: '더 자세히 입력(선택)' }));
  fireEvent.click(screen.getByLabelText('부대비용 포함'));
  fireEvent.change(screen.getByLabelText('부대비용'), { target: { value: '15000000' } });
  assert.equal(targetInput().value, '115,000,000');
  assert.ok(screen.getByText('= 매입 가격 3억 원 − 대출 예정 금액 2억 원 + 부대비용 1,500만 원'));
  fireEvent.change(screen.getByLabelText('대출 예정 금액'), { target: { value: '400000000' } });
  assert.equal(screen.getByLabelText('대출 예정 금액').getAttribute('aria-invalid'), 'true');
  assert.ok(screen.getByText('대출 예정 금액이 매입 가격보다 클 수 없어요.'));
  assert.equal(screen.queryByRole('img', { name: /자산 추이/ }), null);
});

test('a typed target amount wins until the details are used again', () => {
  open();
  fireEvent.click(screen.getByRole('button', { name: '내 집 마련' }));
  fireEvent.change(targetInput(), { target: { value: '123456789' } });
  assert.equal(targetSource(), '직접 입력');
  assert.match(chartLabel(), /목표 123,456,789원/);
  fireEvent.blur(targetInput());
  assert.equal(targetInput().value, '123,456,789');
  fireEvent.change(screen.getByLabelText('예상 매입 가격'), { target: { value: '500000000' } });
  assert.equal(targetInput().value, '123,456,789');
  fireEvent.click(screen.getByRole('button', { name: '상세 입력으로 다시 계산' }));
  assert.equal(targetInput().value, '500,000,000');
  assert.equal(targetSource(), '상세 계산');
  assert.equal(screen.queryByRole('button', { name: '상세 입력으로 다시 계산' }), null);
});

test('switching goal types keeps each type\'s entries instead of overwriting the target', () => {
  open();
  fireEvent.change(targetInput(), { target: { value: '70000000' } });
  fireEvent.click(screen.getByRole('button', { name: '자동차' }));
  assert.equal(targetInput().value, '40,000,000');
  fireEvent.change(screen.getByLabelText('예상 차량 가격'), { target: { value: '35000000' } });
  fireEvent.click(screen.getByRole('button', { name: '자유 목표' }));
  assert.equal(targetInput().value, '70000000');
  assert.equal(targetSource(), '직접 입력');
  fireEvent.click(screen.getByRole('button', { name: '자동차' }));
  assert.equal(targetInput().value, '35,000,000');
  assert.equal((screen.getByLabelText('예상 차량 가격') as HTMLInputElement).value, '35000000');
});

test('a free goal takes a name, a sum of rows or no amount yet', async () => {
  open();
  fireEvent.change(screen.getByLabelText('목표 이름'), { target: { value: '결혼 자금' } });
  assert.ok(screen.getByText('결혼 자금 · 예시 금액 5,000만 원'));
  fireEvent.click(screen.getByRole('button', { name: '비상금' }));
  assert.equal((screen.getByLabelText('목표 이름') as HTMLInputElement).value, '비상금');
  assert.equal(targetInput().value, '50,000,000');
  fireEvent.click(screen.getByRole('button', { name: '아직 모름' }));
  assert.equal(targetSource(), '미정');
  assert.ok(screen.getByText('그래서 달성률은 계산하지 않았어요. 지금 조건이면 5년 후 예상 자산은 46,669,685원이에요.'));
  fireEvent.click(screen.getByRole('button', { name: '항목별로 나눠 보기' }));
  // Compare ids: a failed DOM-node comparison makes assert render the whole jsdom tree.
  await waitFor(() => assert.equal(document.activeElement?.id, 'goal-item-0-label'));
  assert.equal(screen.getByRole('button', { name: '항목 합산' }).getAttribute('aria-pressed'), 'true');
  fireEvent.change(screen.getByLabelText('항목 1 이름'), { target: { value: '예식' } });
  fireEvent.change(screen.getByLabelText('항목 1 금액'), { target: { value: '20000000' } });
  fireEvent.click(screen.getByRole('button', { name: '+ 항목 추가' }));
  fireEvent.change(screen.getByLabelText('항목 2 금액'), { target: { value: '8000000' } });
  assert.equal(targetInput().value, '28,000,000');
  assert.ok(screen.getByText('= 예식 2,000만 원 + 항목 2 800만 원'));
  fireEvent.click(screen.getByRole('button', { name: '항목 2 삭제' }));
  assert.equal(targetInput().value, '20,000,000');
  fireEvent.change(targetInput(), { target: { value: '30000000' } });
  assert.equal(screen.getByRole('button', { name: '직접 입력' }).getAttribute('aria-pressed'), 'true');
  assert.equal(targetSource(), '직접 입력');
});

test('travel items multiply by travelers, nights and days and name the trip in the result', () => {
  open();
  fireEvent.click(screen.getByRole('button', { name: '여행' }));
  fireEvent.change(screen.getByLabelText('여행지'), { target: { value: '오사카' } });
  fireEvent.click(screen.getByRole('button', { name: '항목별 계산' }));
  for (const [label, value] of [['인원', '2'], ['박 수', '3'], ['항공권(1인 왕복)', '600000'], ['숙박비(1박 전체)', '150000'], ['현지 경비(1인 1일)', '100000']] as const) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  }
  assert.equal((screen.getByLabelText('일 수') as HTMLInputElement).placeholder, '4');
  assert.equal(targetInput().value, '2,450,000');
  assert.ok(screen.getByText('= 항공권(1인 × 2명) 120만 원 + 숙박(3박) 45만 원 + 현지 경비(2명 × 4일) 80만 원'));
  assert.ok(screen.getByText('기타 비용: 입력하지 않아 0원으로 계산했어요.'));
  assert.ok(screen.getByText('여행(오사카, 2명, 3박 4일) · 상세 계산 245만 원'));
});

test('new calculation returns the goal planner to the free-goal example', () => {
  open();
  fireEvent.click(screen.getByRole('button', { name: '내 집 마련' }));
  fireEvent.click(screen.getByRole('button', { name: '자기자본' }));
  fireEvent.click(screen.getByRole('button', { name: '새로 계산하기' }));
  assert.equal(screen.getByRole('button', { name: '자유 목표' }).getAttribute('aria-pressed'), 'true');
  assert.equal(targetInput().value, '50,000,000');
  assert.equal(targetSource(), '예시 금액');
  fireEvent.click(screen.getByRole('button', { name: '내 집 마련' }));
  assert.equal(screen.getByRole('button', { name: '집값 전체' }).getAttribute('aria-pressed'), 'true');
});

const describe = (value: string) => {
  fireEvent.change(screen.getByLabelText('설명(선택)'), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: '설명에서 정보 찾기' }));
  return screen.getByRole('region', { name: '설명에서 찾은 정보' });
};
const aiOn = { enabled: true, providers: [{ id: 'cloudflare', label: 'Cloudflare Workers AI', model: '@cf/test' }], promptVersion: 'goal-clarify-v1', maxLength: 200 };

test('a free goal description is read on this device and applied only after it is ticked', () => {
  open();
  const card = describe('2년 안에 결혼, 예식 2천만 원이랑 신혼여행 500만 원');
  assert.match(card.textContent!, /이 기기에서 규칙으로 찾았어요/);
  assert.match(card.textContent!, /분류: 결혼/);
  assert.equal(targetInput().value, '50,000,000');
  assert.equal((within(card).getByLabelText('목표 이름: 결혼 자금') as HTMLInputElement).checked, true);
  assert.ok(within(card).getByLabelText('항목: 예식 2,000만 원 · 신혼여행 500만 원'));
  assert.ok(within(card).getByLabelText('목표 기간: 2년 (“2년”)'));
  fireEvent.click(within(card).getByRole('button', { name: '선택한 정보 적용' }));
  assert.equal((screen.getByLabelText('목표 이름') as HTMLInputElement).value, '결혼 자금');
  assert.equal(targetInput().value, '25,000,000');
  assert.equal((screen.getByLabelText('목표 기간') as HTMLInputElement).value, '24');
  assert.ok(screen.getByRole('img', { name: /^2년 자산 추이/ }));
  assert.equal(screen.getByRole('button', { name: '항목 합산' }).getAttribute('aria-pressed'), 'true');
});

test('fixed questions ask only for what the description lacks and can be answered or skipped', () => {
  open();
  const card = describe('비상금 모으기');
  assert.ok(within(card).getByText('설명에서 금액이나 기간을 찾지 못했어요.'));
  assert.ok(within(card).getByText('한 달 생활비와 몇 개월치를 모을지 알려 주세요.'));
  assert.ok(within(card).getByText('언제까지 모을까요?'));
  fireEvent.change(within(card).getByLabelText('한 달 생활비'), { target: { value: '2500000' } });
  fireEvent.change(within(card).getByLabelText('몇 개월치'), { target: { value: '6' } });
  fireEvent.click(within(card).getAllByRole('button', { name: '적용' })[0]!);
  assert.equal(targetInput().value, '15,000,000');
  assert.ok(screen.getByText('= 한 달 생활비 250만 원 × 6개월 1,500만 원'));
  fireEvent.change(within(card).getByLabelText('모을 기간'), { target: { value: '18' } });
  fireEvent.click(within(card).getByRole('button', { name: '적용' }));
  assert.equal((screen.getByLabelText('목표 기간') as HTMLInputElement).value, '18');
  assert.equal(within(card).queryByText('언제까지 모을까요?'), null);
  const again = describe('목돈 모으기');
  fireEvent.click(within(again).getAllByRole('button', { name: '건너뛰기' })[0]!);
  assert.equal(within(again).queryByText('모으려는 금액이 정해져 있나요?'), null);
});

test('a description that matches another goal type offers to move there with its figures filled in', () => {
  open();
  const card = describe('오사카 여행 2명 3박 4일');
  assert.ok(within(card).getByText('인원 2명, 3박, 4일을 채워 둘게요.'));
  fireEvent.click(within(card).getByRole('button', { name: '‘여행’ 목표로 바꾸기' }));
  assert.equal(screen.getByRole('button', { name: '여행' }).getAttribute('aria-pressed'), 'true');
  assert.equal((screen.getByLabelText('인원') as HTMLInputElement).value, '2');
  assert.equal((screen.getByLabelText('박 수') as HTMLInputElement).value, '3');
  assert.equal((screen.getByLabelText('일 수') as HTMLInputElement).value, '4');
  assert.equal(screen.queryByRole('region', { name: '설명에서 찾은 정보' }), null);
});

test('the AI reading is offered only when rules fall short, sends the description alone and is checked before use', async () => {
  const posts: string[] = [];
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'GET') return response(aiOn);
    posts.push(String(init!.body));
    return response({ status: 'ok', promptVersion: 'goal-clarify-v1', provider: aiOn.providers[0], category: 'wedding', title: '결혼 준비',
      facts: { months: { value: 18, text: '1년 반' } } });
  }) as typeof fetch;
  open();
  const text = '결혼 준비 예산은 3천 정도, 1년 반 뒤';
  const card = describe(text);
  const ask = await within(card).findByRole('button', { name: 'AI로 다시 정리하기' });
  assert.match(card.textContent!, /설명 문장만 MoneyCast 서버를 거쳐 Cloudflare Workers AI로 보내요/);
  fireEvent.click(ask);
  await waitFor(() => assert.match(card.textContent!, /AI\(Cloudflare Workers AI\)가 정리했어요/));
  assert.ok(within(card).getByLabelText('목표 이름: 결혼 준비'));
  assert.deepEqual(posts.map(body => JSON.parse(body)), [{ text }]);
  assert.equal(within(card).queryByRole('button', { name: 'AI로 다시 정리하기' }), null);
});

test('an unchecked AI answer or personal data falls back to the questions and never changes the goal', async () => {
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => (init?.method ?? 'GET') === 'GET'
    ? response(aiOn)
    : response({ status: 'ok', promptVersion: 'goal-clarify-v1', provider: aiOn.providers[0], category: 'wedding',
      facts: { amount: { value: 50_000_000, text: '5천만 원' } } })) as typeof fetch;
  open();
  const card = describe('결혼 준비');
  fireEvent.click(await within(card).findByRole('button', { name: 'AI로 다시 정리하기' }));
  assert.ok(await within(card).findByText('AI 답을 확인하지 못했어요. 아래 질문에 직접 답해 주세요.'));
  assert.equal(targetInput().value, '50,000,000');
  assert.ok(within(card).getByText('모으려는 금액이 정해져 있나요?'));
  assert.equal(within(card).queryByRole('button', { name: 'AI로 다시 정리하기' }), null);
  const personal = describe('결혼 준비, 연락처 010-1234-5678');
  assert.ok(within(personal).getByText(/주민등록번호·카드·계좌번호처럼 보이는 내용이 있어 AI로 보내지 않아요/));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(within(personal).queryByRole('button', { name: 'AI로 다시 정리하기' }), null);
});

const endMonth = (months: number) => {
  const now = new Date();
  const index = now.getFullYear() * 12 + now.getMonth() + months;
  return { year: Math.floor(index / 12), month: index % 12 + 1 };
};
const monthValue = ({ year, month }: { year: number; month: number }) => `${year}-${String(month).padStart(2, '0')}`;

test('a target month sets the saving period, and the period shows the month it ends', () => {
  open();
  const period = screen.getByLabelText('목표 기간') as HTMLInputElement;
  const month = screen.getByLabelText('목표 시점') as HTMLInputElement;
  assert.equal(month.value, monthValue(endMonth(60)));
  assert.ok(screen.getByText(`${endMonth(60).year}년 ${endMonth(60).month}월까지 모아요. 날짜를 고르면 목표 기간이 바뀌어요.`));
  fireEvent.change(month, { target: { value: monthValue(endMonth(18)) } });
  assert.equal(period.value, '18');
  assert.ok(screen.getByRole('img', { name: /^1년 6개월 자산 추이/ }));
  fireEvent.change(period, { target: { value: '24' } });
  assert.equal(month.value, monthValue(endMonth(24)));
  fireEvent.change(month, { target: { value: monthValue(endMonth(0)) } });
  assert.equal(month.getAttribute('aria-invalid'), 'true');
  assert.ok(screen.getByText('목표 시점은 다음 달 이후로 정해 주세요.'));
  assert.equal(period.value, '24');
  fireEvent.change(month, { target: { value: monthValue(endMonth(1)) } });
  assert.equal(period.value, '1');
  assert.equal(month.getAttribute('aria-invalid'), 'false');
});

test('an assumed price rise raises only the amount compared and reads as an assumption', () => {
  open();
  fireEvent.click(screen.getByLabelText('물가상승 반영(선택)'));
  assert.ok(screen.getByText('연 물가상승률을 입력하면 목표 금액에 반영해요.'));
  assert.match(chartLabel(), /목표 50,000,000원/);
  fireEvent.change(screen.getByLabelText('연 물가상승률'), { target: { value: '2' } });
  assert.equal(targetInput().value, '50,000,000');
  assert.ok(screen.getByText('오늘 5,000만 원이 연 2%씩 오르면 5년 뒤 5,520.4만 원이에요. 이 금액과 비교해요.'));
  assert.match(chartLabel(), /목표 55,204,040원/);
  assert.ok(screen.getByText('자유 목표 · 예시 금액 5,000만 원 → 물가 반영 5,520.4만 원'));
  assert.ok(screen.getByText('목표 5,520.4만 원(물가 반영)'));
  fireEvent.change(screen.getByLabelText('연 물가상승률'), { target: { value: '25' } });
  assert.equal(screen.getByLabelText('연 물가상승률').getAttribute('aria-invalid'), 'true');
  assert.ok(screen.getByText('물가상승률은 0~20% 사이로 입력해 주세요.'));
  assert.equal(screen.queryByRole('img', { name: /자산 추이/ }), null);
  assert.equal(targetInput().getAttribute('aria-invalid'), 'false', 'the target itself is fine');
  fireEvent.click(screen.getByLabelText('물가상승 반영(선택)'));
  assert.match(chartLabel(), /목표 50,000,000원/);
  assert.ok(screen.getByText('자유 목표 · 예시 금액 5,000만 원'));
});

test('a home district labels the goal without changing its amount', () => {
  open();
  fireEvent.click(screen.getByRole('button', { name: '내 집 마련' }));
  fireEvent.click(screen.getByRole('button', { name: '더 자세히 입력(선택)' }));
  fireEvent.change(screen.getByLabelText('지역(시·도)'), { target: { value: '서울' } });
  fireEvent.change(screen.getByLabelText('시·군·구'), { target: { value: '마포구' } });
  assert.ok(screen.getByText('내 집 마련(서울 마포구) · 집값 전체 기준 · 예시 금액 3억 원'));
  assert.equal(targetInput().value, '300,000,000');
});

const savedRegion = () => screen.getByRole('region', { name: /^저장한 목표/ });

test('a goal is kept in this browser only when saved, without its description, and loads back with the calculator fields', () => {
  open();
  assert.equal(window.localStorage.getItem('moneycast.goals.v1'), null);
  fireEvent.change(screen.getByLabelText('목표 이름'), { target: { value: '결혼 자금' } });
  fireEvent.change(screen.getByLabelText('설명(선택)'), { target: { value: '예식 2천만 원' } });
  fireEvent.change(screen.getByLabelText('목표 기간'), { target: { value: '24' } });
  assert.equal(window.localStorage.getItem('moneycast.goals.v1'), null, 'typing alone stores nothing');
  fireEvent.click(screen.getByRole('button', { name: '현재 목표 저장' }));
  assert.doesNotMatch(window.localStorage.getItem('moneycast.goals.v1')!, /예식/);
  assert.ok(within(savedRegion()).getByText('결혼 자금 · 예시 금액 5,000만 원'));
  assert.ok(within(savedRegion()).getByText(/^기간 2년 · 매월 50만 원 · .+ 저장$/));
  // Remounting, as a reload does, starts the inputs over and reads the list back.
  cleanup();
  open();
  assert.equal((screen.getByLabelText('목표 기간') as HTMLInputElement).value, '60');
  assert.equal((screen.getByLabelText('목표 이름') as HTMLInputElement).value, '');
  fireEvent.click(within(savedRegion()).getByRole('button', { name: '결혼 자금 · 예시 금액 5,000만 원 불러오기' }));
  assert.equal((screen.getByLabelText('목표 이름') as HTMLInputElement).value, '결혼 자금');
  assert.equal((screen.getByLabelText('설명(선택)') as HTMLTextAreaElement).value, '');
  assert.equal((screen.getByLabelText('목표 기간') as HTMLInputElement).value, '24');
  assert.ok(screen.getByText('저장한 목표를 불러왔어요.'));
  fireEvent.click(within(savedRegion()).getByRole('button', { name: '결혼 자금 · 예시 금액 5,000만 원 삭제' }));
  assert.equal(within(savedRegion()).queryByRole('list'), null);
  assert.equal(window.localStorage.getItem('moneycast.goals.v1'), null);
});

test('saving stops at five goals, ignores unreadable storage and is not offered when storage is blocked', () => {
  window.localStorage.setItem('moneycast.goals.v1', JSON.stringify({ version: 1, goals: [{ id: 'x', goal: 'boat' }] }));
  open();
  assert.equal(within(savedRegion()).queryByRole('list'), null);
  for (let index = 0; index < 5; index += 1) fireEvent.click(screen.getByRole('button', { name: '현재 목표 저장' }));
  assert.equal(within(savedRegion()).getAllByRole('listitem').length, 5);
  assert.equal((screen.getByRole('button', { name: '현재 목표 저장' }) as HTMLButtonElement).disabled, true);
  assert.ok(screen.getByText('최대 5개까지 저장할 수 있어요. 하나를 지운 뒤 저장해 주세요.'));
  cleanup();
  const original = Object.getOwnPropertyDescriptor(dom.window, 'localStorage')!;
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get() { throw new dom.window.DOMException('Storage blocked for test', 'SecurityError'); },
  });
  try {
    open();
    assert.equal((screen.getByRole('button', { name: '현재 목표 저장' }) as HTMLButtonElement).disabled, true);
    assert.ok(screen.getByText('이 브라우저에서는 목표를 저장할 수 없어요.'));
    assert.ok(screen.getByRole('img', { name: /자산 추이/ }));
  } finally {
    cleanup();
    Object.defineProperty(window, 'localStorage', original);
  }
});

test('the CSV export starts with the goal and its assumptions, then the monthly rows', async () => {
  const blobs: Blob[] = [];
  const { createObjectURL, revokeObjectURL } = URL;
  const click = dom.window.HTMLAnchorElement.prototype.click;
  URL.createObjectURL = (blob: Blob) => { blobs.push(blob); return 'blob:test'; };
  URL.revokeObjectURL = () => undefined;
  dom.window.HTMLAnchorElement.prototype.click = () => undefined;
  try {
    open();
    fireEvent.change(screen.getByLabelText('목표 이름'), { target: { value: '=결혼 자금' } });
    fireEvent.click(screen.getByRole('button', { name: '계산 결과 CSV 저장' }));
    const lines = (await blobs[0]!.text()).replace(/^﻿/, '').split('\r\n');
    assert.deepEqual(lines.slice(0, 4), ['항목,값', "목표,'=결혼 자금", '목표 금액 출처,예시 금액', '목표 금액(원),50000000']);
    assert.ok(lines.includes('목표 기간(개월),60'));
    assert.ok(lines.includes('예상 목표 달성률(%),93.3'));
    assert.ok(lines.includes('개월,납입 원금(원),예상 자산(원),예상 수익(원)'));
    assert.equal(lines.at(-1), '60,40000000,46669685,6669685');
  } finally {
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    dom.window.HTMLAnchorElement.prototype.click = click;
  }
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

test('factor boxes show synthesized sentences that jump to cards holding the summary and score rationale', async () => {
  const fixture = marketauxFixture();
  fixture.articles = [
    { ...fixture.articles[0]!, description: '테스트 전용: 매체가 제공한 짧은 설명입니다.', rationaleLines: [
      "Marketaux가 이 기사에서 '삼성전자' 언급 문맥에 매긴 감성 점수 +0.625 (−1~1, 0보다 크면 긍정·작으면 부정)",
      '기사 분위기 지표이며 주가 방향이나 확률을 뜻하지 않습니다.',
    ] },
    { ...fixture.articles[0]!, id: 'test-second', url: 'https://publisher.example.test/second', title: 'Test fixture: second article',
      rationaleLines: ['테스트 전용 두 번째 근거'] },
  ];
  fixture.positiveFactors = ['테스트 전용: 실적 관련 기사 1건만 긍정으로 분류됐습니다.'];
  fixture.factorSummary = {
    positive: { state: 'single', chips: ['단일 근거'], lines: [{ text: fixture.positiveFactors[0]!, topic: 'earnings', articleIds: ['test-second'] }] },
    negative: { state: 'none', lines: [], chips: [] },
    chips: ['분류된 기사 3건 미만'], note: '테스트 전용: 주제는 키워드로 묶은 참고 분류입니다.',
  };
  globalThis.fetch = (async () => response(fixture)) as typeof fetch;
  open('news');
  const sentence = await screen.findByText(/테스트 전용: 실적 관련 기사 1건만/);
  const positiveBox = sentence.closest('.factor-grid > div') as HTMLElement;
  assert.equal(within(positiveBox).queryByText(/감성 점수/), null);
  assert.ok(within(positiveBox).getByText('단일 근거'));
  assert.ok(screen.getByText('분류된 기사 3건 미만'));
  assert.ok(screen.getByText('테스트 전용: 주제는 키워드로 묶은 참고 분류입니다.'));
  assert.ok(screen.getByText('확인된 요인 없음'));
  fireEvent.click(within(positiveBox).getByRole('button', { name: '근거 기사 1건' }));
  assert.equal(document.activeElement?.id, 'news-article-1');
  assert.equal(window.location.hash, '#news');
  const [first, second] = Array.from(document.querySelectorAll<HTMLElement>('.article-list article'));
  assert.ok(within(first!).getByText('핵심 요약 · 매체 설명(원문)'));
  assert.ok(within(first!).getByText('테스트 전용: 매체가 제공한 짧은 설명입니다.'));
  assert.equal(within(first!).getAllByRole('listitem').length, 2);
  assert.ok(within(first!).getByText(/감성 점수 \+0.625/));
  assert.ok(within(second!).getByText('요약 정보 없음 — 원문에서 확인하세요.'));
  assert.ok(within(second!).getByText('테스트 전용 두 번째 근거'));
  assert.equal(within(second!).queryByText(/제공자 분류 ·/), null);
});

test('combined sources show per-source states, GDELT attribution, first-seen times and other publishers', async () => {
  const fixture = marketauxFixture();
  fixture.provider = 'Marketaux · GDELT';
  fixture.sources = [
    { id: 'marketaux', label: 'Marketaux', status: 'rate_limited', articleCount: 0, retryAt: '2026-10-27T00:15:00.000Z' },
    { id: 'gdelt', label: 'GDELT', status: 'ok', articleCount: 1 },
  ];
  fixture.articles = [{ ...fixture.articles[0]!, id: 'gdelt-test', sentiment: 'unclassified', classificationMethod: 'unavailable', sentimentScore: undefined,
    providerEntity: undefined, sourceProvider: 'GDELT', timeKind: 'seen', identity: 'name_match',
    alsoReportedBy: [{ source: 'b.example.test', url: 'https://b.example.test/a' }, { source: 'c.example.test', url: 'https://c.example.test/a' }] }];
  delete fixture.articles[0]!.sentimentScore;
  delete fixture.articles[0]!.providerEntity;
  globalThis.fetch = (async () => response(fixture)) as typeof fetch;
  open('news');
  assert.ok(await screen.findByText(/출처 상태: Marketaux 호출 제한\(재시도 .*\) · GDELT 정상 1건/));
  assert.ok(screen.getByRole('link', { name: 'GDELT Project' }));
  const card = document.querySelector('.article-list article') as HTMLElement;
  assert.ok(within(card).getByText(/GDELT 확인:/));
  assert.equal(within(card).queryByText(/게시:/), null);
  assert.ok(within(card).getByText('수집: GDELT'));
  assert.ok(within(card).getByText('같은 내용 다른 출처 2곳: b.example.test, c.example.test'));
});

test('AI labels show agreement, provisional and withheld states with model status, AI summaries and an AI notice', async () => {
  const fixture = marketauxFixture();
  fixture.provider = 'Marketaux · GDELT';
  const { sentimentScore: _score, providerEntity: _entity, language: _language, ...base } = fixture.articles[0]!;
  const judgedAt = '2026-10-26T21:00:00.000Z';
  const gdelt = { ...base, sourceProvider: 'GDELT', timeKind: 'seen' as const, identity: 'name_match' as const };
  fixture.articles = [
    { ...gdelt, id: 'ai-confirmed', url: 'https://a.example.test/1', title: '테스트 전용: 일부 제품 리콜 대상 확대', sentiment: 'negative',
      classificationMethod: 'llm', aiConsensus: 'confirmed',
      aiJudgements: [{ provider: 'gemini', model: 'g', relevant: true, sentiment: 'negative', evidence: '리콜 대상 확대', judgedAt },
        { provider: 'cloudflare', model: 'c', relevant: true, sentiment: 'negative', evidence: '리콜 대상 확대', judgedAt }],
      summary: { text: '테스트 전용: 리콜 대상을 넓힌다는 내용입니다.', basis: 'title_only', generatedBy: 'Gemini' },
      rationaleLines: ["AI 두 모델이 따로 판단: Gemini '부정' · Cloudflare '부정' → 일치해 확정", '기사 분위기 판단이며 주가 방향·확률이 아닙니다.'] },
    { ...gdelt, id: 'ai-provisional', url: 'https://a.example.test/2', title: '테스트 전용: 영업이익 개선', sentiment: 'unclassified',
      classificationMethod: 'unavailable', aiConsensus: 'provisional',
      aiJudgements: [{ provider: 'gemini', model: 'g', relevant: true, sentiment: 'positive', evidence: '영업이익 개선', judgedAt }],
      rationaleLines: ["Gemini만 판단('긍정'). Cloudflare는 무료 한도에 도달해 다음 갱신 때 교차 확인합니다."] },
    { ...gdelt, id: 'ai-withheld', url: 'https://a.example.test/3', title: '테스트 전용: 수주 확대 기대 속 검토 단계', sentiment: 'unclassified',
      classificationMethod: 'unavailable', aiConsensus: 'withheld',
      aiJudgements: [{ provider: 'gemini', model: 'g', relevant: true, sentiment: 'positive', evidence: '수주 확대 기대', judgedAt },
        { provider: 'cloudflare', model: 'c', relevant: true, sentiment: 'neutral', judgedAt }],
      rationaleLines: ["Gemini '긍정' · Cloudflare '중립' → 판단이 달라 유보합니다."] },
    { ...gdelt, id: 'ai-unrelated', url: 'https://a.example.test/4', title: '테스트 전용: 다른 회사의 신제품 소식', sentiment: 'unclassified',
      classificationMethod: 'unavailable', aiRelevance: 'unrelated',
      aiJudgements: [{ provider: 'gemini', model: 'g', relevant: false, sentiment: 'uncertain', judgedAt },
        { provider: 'cloudflare', model: 'c', relevant: false, sentiment: 'uncertain', judgedAt }],
      rationaleLines: ["AI 두 모델이 따로 판단: Gemini '관련 없음' · Cloudflare '관련 없음' → 이 회사 기사가 아니라고 보고 요인 집계에서 뺐습니다."] },
  ];
  fixture.ai = { promptVersion: 'news-judge-v1', unrelatedCount: 1, providers: [
    { id: 'gemini', label: 'Gemini', model: 'gemini-test', status: 'ok', judgedCount: 3 },
    { id: 'cloudflare', label: 'Cloudflare', model: '@cf/test/model', status: 'rate_limited', judgedCount: 0, retryAt: '2026-10-28T00:00:00.000Z' },
  ] };
  globalThis.fetch = (async () => response(fixture)) as typeof fetch;
  open('news');
  assert.ok(await screen.findByText(/AI 판단: Gemini 정상 3건 · Cloudflare 한도 도달\(재시도 .*\) · 관련성 낮은 기사 1건은 아래에 접어 둠/));
  assert.ok(screen.getByText(/기사 3건 · 관련성 낮음 1건/));
  const [main, folded] = Array.from(document.querySelectorAll<HTMLElement>('.article-list'));
  const [confirmed, provisional, withheld, ...rest] = Array.from(main!.querySelectorAll<HTMLElement>('article'));
  assert.equal(rest.length, 0);
  assert.ok(within(confirmed!).getByText('부정 · AI 합의'));
  assert.ok(within(confirmed!).getByText('핵심 요약 · AI 요약(제목만 기준, 본문 미확인)'));
  assert.ok(within(confirmed!).getByText('테스트 전용: 리콜 대상을 넓힌다는 내용입니다.'));
  assert.ok(within(confirmed!).getByText(/일치해 확정/));
  assert.ok(within(provisional!).getByText('긍정 · 잠정'));
  assert.ok(within(provisional!).getByText('요약 정보 없음 — 원문에서 확인하세요.'));
  assert.ok(within(withheld!).getByText('판단 유보'));
  // Set apart, not hidden: folded below the list with its own badge and reason.
  const details = document.querySelector('details.unrelated-articles') as HTMLDetailsElement;
  assert.equal(details.open, false);
  assert.ok(within(details).getByText('관련성 낮은 기사 1건 — 두 AI가 모두 이 회사 기사가 아니라고 판단해 요인에서 뺐습니다'));
  assert.equal(folded!.closest('details'), details);
  const card = within(folded!).getByRole('article');
  assert.ok(within(card).getByText('관련성 낮음'));
  assert.ok(within(card).getByText('테스트 전용: 다른 회사의 신제품 소식'));
  assert.ok(within(card).getByText(/이 회사 기사가 아니라고 보고 요인 집계에서 뺐습니다/));
  assert.equal(card.id, 'news-unrelated-0');
  assert.ok(screen.getByText(/미분류·잠정·판단 유보 기사는 긍정·부정 요인 집계에서 제외합니다/));
  assert.ok(screen.getByText(/일부 요약·분류는 AI\(Gemini·Cloudflare Workers AI\)가 기사 제목과 매체 설명만 보고 생성했으며 틀릴 수 있습니다/));
});

test('long article lists show eight cards first and expand on request or when evidence points further down', async () => {
  const fixture = marketauxFixture();
  const judgedAt = '2026-10-26T21:00:00.000Z';
  // A folded article ahead of the list must not shift where evidence links land.
  const unrelated = { ...fixture.articles[0]!, id: 'many-unrelated', url: 'https://publisher.example.test/other', title: 'Test fixture: another company',
    aiRelevance: 'unrelated' as const, aiJudgements: [{ provider: 'gemini' as const, model: 'g', relevant: false, sentiment: 'uncertain' as const, judgedAt },
      { provider: 'cloudflare' as const, model: 'c', relevant: false, sentiment: 'uncertain' as const, judgedAt }] };
  fixture.articles = [unrelated, ...Array.from({ length: 10 }, (_, index) => ({ ...fixture.articles[0]!, id: `many-${index}`,
    url: `https://publisher.example.test/many-${index}`, title: `Test fixture: article ${index}` }))];
  fixture.positiveFactors = ['테스트 전용: 마지막 기사만 근거로 든 문장입니다.'];
  fixture.factorSummary = {
    positive: { state: 'single', chips: [], lines: [{ text: fixture.positiveFactors[0]!, topic: 'other', articleIds: ['many-9'] }] },
    negative: { state: 'none', lines: [], chips: [] }, chips: [], note: '테스트 전용 주제 안내',
  };
  globalThis.fetch = (async () => response(fixture)) as typeof fetch;
  open('news');
  await screen.findByText('테스트 전용: 마지막 기사만 근거로 든 문장입니다.');
  const cards = () => document.querySelector('.article-list')!.querySelectorAll('article').length;
  assert.equal(cards(), 8);
  assert.equal(document.querySelectorAll('details.unrelated-articles article').length, 1);
  fireEvent.click(screen.getByRole('button', { name: '기사 2건 더 보기' }));
  assert.equal(cards(), 10);
  fireEvent.click(screen.getByRole('button', { name: '기사 접기' }));
  assert.equal(cards(), 8);
  fireEvent.click(screen.getByRole('button', { name: '근거 기사 1건' }));
  await waitFor(() => assert.equal(document.activeElement?.id, 'news-article-9'));
  assert.equal(cards(), 10);
});

test('a stale server result and a failed refresh with a saved result both show an explicit old-result banner', async () => {
  const stale = marketauxFixture();
  stale.servedFrom = 'stale';
  stale.refreshAttemptedAt = new Date().toISOString();
  stale.asOf = new Date(Date.now() - 3 * 3_600_000).toISOString();
  stale.message = '테스트 전용: 모든 출처가 응답하지 않았습니다.';
  globalThis.fetch = (async () => response(stale)) as typeof fetch;
  let view = open('news');
  // The loading state also uses role="status"; wait for the banner itself.
  const banner = (await screen.findByText('이전 결과')).closest('.stale-banner') as HTMLElement;
  assert.equal(banner.getAttribute('role'), 'status');
  assert.ok(within(banner).getByText(/기준 결과\(3시간 전\)를 보여드립니다\. 테스트 전용: 모든 출처가 응답하지 않았습니다\./));
  assert.ok(screen.getByRole('link', { name: 'Test fixture: Samsung research update' }));
  view.unmount();

  // A successful result saved in this browser covers a later failed refresh. Tesla keeps the
  // module-level last-good copy away from the default company used by other tests.
  window.localStorage.clear();
  const now = Date.now();
  const tesla = { id: 'nasdaq:TSLA', name: '테슬라', symbol: 'TSLA', exchange: 'NASDAQ', region: 'US' };
  const good: NewsAnalysis = { ...marketauxFixture(), company: tesla, analysisVersion: NEWS_CACHE_ANALYSIS_VERSION,
    asOf: new Date(now - 60_000).toISOString(), cachedUntil: new Date(now + 1).toISOString() };
  let teslaCalls = 0;
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0]) => {
    if (!String(url).includes('nasdaq%3ATSLA')) return response(newsFixture());
    teslaCalls++;
    if (teslaCalls === 1) return response(good);
    throw new Error('테스트 전용 연결 실패');
  }) as typeof fetch;
  const pickTesla = async () => {
    await screen.findByText('데이터 연동 대기');
    fireEvent.click(screen.getByRole('button', { name: /테슬라.*TSLA.*NASDAQ/ }));
  };
  view = open('news');
  await pickTesla();
  await screen.findByRole('link', { name: 'Test fixture: Samsung research update' });
  view.unmount();
  await new Promise(resolve => setTimeout(resolve, 5));
  open('news');
  await pickTesla();
  const fallback = (await screen.findByText('이전 결과')).closest('.stale-banner') as HTMLElement;
  assert.ok(within(fallback).getByText(/테스트 전용 연결 실패/));
  assert.ok(screen.getByRole('link', { name: 'Test fixture: Samsung research update' }));
  assert.equal(screen.queryByText('뉴스를 불러오지 못했어요'), null);
  fireEvent.click(within(fallback).getByRole('button', { name: '다시 시도' }));
  await waitFor(() => assert.equal(teslaCalls, 3));
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
  assert.equal(sidebar.getAttribute('aria-hidden'), 'false');
  const close = screen.getByRole('button', { name: '사이드바 닫기' });
  assert.equal(close.getAttribute('aria-expanded'), 'true');
  assert.equal(close.getAttribute('aria-controls'), sidebar.id);
  fireEvent.click(close);
  assert.equal(sidebar.getAttribute('aria-hidden'), 'true');
  assert.equal(sidebar.hasAttribute('inert'), true);
  assert.equal(screen.queryByRole('navigation', { name: '주 메뉴' }), null);
  const reopen = screen.getByRole('button', { name: '사이드바 열기' });
  assert.equal(reopen.getAttribute('aria-expanded'), 'false');
  assert.equal(reopen.getAttribute('aria-controls'), sidebar.id);
  assert.equal(window.sessionStorage.getItem('moneycast.sidebar'), 'closed');
  assert.ok(screen.getByLabelText('현재 시드머니'));
  fireEvent.click(reopen);
  assert.equal(sidebar.getAttribute('aria-hidden'), 'false');
  assert.equal(sidebar.hasAttribute('inert'), false);
  assert.equal(window.sessionStorage.getItem('moneycast.sidebar'), 'open');
  assert.ok(screen.getByRole('navigation', { name: '주 메뉴' }));
});

test('sidebar restores a collapsed session after remount and clearing the session restores the open default', () => {
  const first = open();
  fireEvent.click(screen.getByRole('button', { name: '사이드바 닫기' }));
  first.unmount();
  const restored = open();
  assert.equal(document.getElementById('moneycast-sidebar')!.getAttribute('aria-hidden'), 'true');
  assert.equal(screen.getByRole('button', { name: '사이드바 열기' }).getAttribute('aria-expanded'), 'false');
  restored.unmount();
  window.sessionStorage.clear();
  open();
  assert.equal(document.getElementById('moneycast-sidebar')!.getAttribute('aria-hidden'), 'false');
  assert.ok(screen.getByRole('button', { name: '사이드바 닫기' }));
});

test('desktop sidebar keyboard dismissal returns focus and preserves calculator edits', () => {
  open();
  fireEvent.change(screen.getByLabelText('현재 시드머니'), { target: { value: '20000000' } });
  fireEvent.click(screen.getByRole('button', { name: '사이드바 닫기' }));
  fireEvent.click(screen.getByRole('button', { name: '사이드바 열기' }));
  const menu = screen.getByRole('navigation', { name: '주 메뉴' });
  assert.equal(document.activeElement, within(menu).getByRole('button', { name: '목표 자금 계산기' }));
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  assert.equal(document.getElementById('moneycast-sidebar')!.getAttribute('aria-hidden'), 'true');
  assert.equal(document.activeElement, screen.getByRole('button', { name: '사이드바 열기' }));
  assert.equal((screen.getByLabelText('현재 시드머니') as HTMLInputElement).value, '20000000');
});

test('mobile drawer traps both keyboard boundaries and Escape restores focus and scrolling', () => {
  mobileViewport();
  open();
  assert.equal(document.getElementById('moneycast-sidebar')!.getAttribute('aria-hidden'), 'true');
  fireEvent.click(screen.getByRole('button', { name: '사이드바 열기' }));
  const sidebar = screen.getByRole('complementary', { name: 'MoneyCast 사이드바' });
  const close = screen.getByRole('button', { name: '사이드바 닫기' });
  assert.equal(document.activeElement, within(sidebar).getByRole('button', { name: '목표 자금 계산기' }));
  assert.equal(document.body.style.overflow, 'hidden');
  assert.ok(document.getElementById('main')!.hasAttribute('inert'));
  const home = within(sidebar).getByRole('link', { name: 'MoneyCast 홈' });
  close.focus();
  fireEvent.keyDown(close, { key: 'Tab' });
  assert.equal(document.activeElement, home);
  fireEvent.keyDown(home, { key: 'Tab', shiftKey: true });
  assert.equal(document.activeElement, close);
  fireEvent.keyDown(close, { key: 'Escape' });
  assert.equal(document.activeElement, screen.getByRole('button', { name: '사이드바 열기' }));
  assert.equal(sidebar.getAttribute('aria-hidden'), 'true');
  assert.equal(document.body.style.overflow, '');
  assert.equal(document.getElementById('main')!.hasAttribute('inert'), false);
});

test('reopening the sidebar focuses the current introduction instead of the first menu item', () => {
  mobileViewport();
  open('news-intro');
  fireEvent.click(screen.getByRole('button', { name: '사이드바 열기' }));
  const sidebar = screen.getByRole('complementary', { name: 'MoneyCast 사이드바' });
  assert.equal(document.activeElement, within(sidebar).getByRole('button', { name: '인사이트 사용법' }));
});

test('mobile backdrop and navigation dismiss the drawer without changing the desktop session preference', () => {
  mobileViewport();
  window.sessionStorage.setItem('moneycast.sidebar', 'closed');
  open();
  fireEvent.click(screen.getByRole('button', { name: '사이드바 열기' }));
  fireEvent.click(document.querySelector('.sidebar-backdrop')!);
  assert.equal(document.getElementById('moneycast-sidebar')!.getAttribute('aria-hidden'), 'true');
  fireEvent.click(screen.getByRole('button', { name: '사이드바 열기' }));
  fireEvent.click(within(screen.getByRole('navigation', { name: '주 메뉴' })).getByRole('button', { name: '계산기 사용법' }));
  assert.equal(window.location.hash, '#calculator-intro');
  assert.equal(document.getElementById('moneycast-sidebar')!.getAttribute('aria-hidden'), 'true');
  assert.equal(document.body.style.overflow, '');
  assert.equal(document.activeElement, screen.getByRole('button', { name: '사이드바 열기' }));
  assert.equal(window.sessionStorage.getItem('moneycast.sidebar'), 'closed');
});

test('resizing an open mobile drawer restores desktop preference and clears the background lock', () => {
  const resize = mobileViewport();
  window.sessionStorage.setItem('moneycast.sidebar', 'closed');
  open();
  fireEvent.click(screen.getByRole('button', { name: '사이드바 열기' }));
  resize(false);
  assert.equal(document.getElementById('moneycast-sidebar')!.getAttribute('aria-hidden'), 'true');
  assert.equal(document.body.style.overflow, '');
  assert.equal(document.getElementById('main')!.hasAttribute('inert'), false);
  assert.equal(document.activeElement, screen.getByRole('button', { name: '사이드바 열기' }));
  resize(true);
  assert.equal(document.getElementById('moneycast-sidebar')!.getAttribute('aria-hidden'), 'true');
});

test('blocked session storage gracefully keeps sidebar controls and calculator usable', () => {
  Object.defineProperty(window, 'sessionStorage', {
    configurable: true,
    get() { throw new dom.window.DOMException('Storage blocked for test', 'SecurityError'); },
  });
  open();
  assert.equal(document.getElementById('moneycast-sidebar')!.getAttribute('aria-hidden'), 'false');
  fireEvent.click(screen.getByRole('button', { name: '사이드바 닫기' }));
  assert.equal(document.getElementById('moneycast-sidebar')!.getAttribute('aria-hidden'), 'true');
  fireEvent.click(screen.getByRole('button', { name: '사이드바 열기' }));
  assert.equal(document.getElementById('moneycast-sidebar')!.getAttribute('aria-hidden'), 'false');
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
  assert.equal(document.getElementById('moneycast-sidebar')!.getAttribute('aria-hidden'), 'true');
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
    ...newsFixture(), status: 'insufficient', provider: 'Marketaux', analysisVersion: NEWS_CACHE_ANALYSIS_VERSION,
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
  assert.ok(Array.from({ length: window.localStorage.length }, (_, index) => window.localStorage.key(index))
    .some(key => key?.startsWith('moneycast.news.v1.')));
  view.unmount();
  open('news');
  await screen.findByText(fixture.summary);
  assert.equal(calls, 1);
});
