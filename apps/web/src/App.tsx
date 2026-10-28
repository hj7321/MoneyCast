import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { calculateProjection, calculateScenarios, validateCalculatorInput, DEFAULT_CALCULATOR_INPUT, formatKRW, formatCompactKRW, formatDurationMonths, type CalculatorInput, type Projection, type ProjectionScenario } from '@moneycast/core';
import { Brand, GoalIcon, Icon, type IconName } from './icons';
import { GrowthChart } from './GrowthChart';
import { NewsPanel } from './NewsPanel';
import { FeatureIntro } from './FeatureIntro';
import { applyTheme, getTheme, saveTheme } from './appearance';

type Page = 'calculator' | 'news' | 'guide' | 'calculator-intro' | 'news-intro';
const nav: { id: Page; label: string; icon: IconName }[] = [
  { id: 'calculator', label: '목표 자금 계산기', icon: 'chart' }, { id: 'news', label: '뉴스 인사이트', icon: 'news' },
];
const pageLabels: Record<Page, string> = {
  calculator: '목표 자금 계산기', news: '뉴스 인사이트', guide: '계산 및 데이터 안내',
  'calculator-intro': '계산기 사용법', 'news-intro': '인사이트 사용법',
};
const SIDEBAR_SESSION_KEY = 'moneycast.sidebar';
const goals: { id: string; name: string; icon: IconName; amount: number }[] = [{ id: 'free', name: '자유 목표', icon: 'spark', amount: 50000000 }, { id: 'home', name: '내 집 마련', icon: 'home', amount: 300000000 }, { id: 'car', name: '자동차', icon: 'car', amount: 40000000 }, { id: 'travel', name: '여행', icon: 'plane', amount: 10000000 }];
const fieldKeys = ['initial', 'monthly', 'annualRate', 'months', 'target'] as const;
type Field = typeof fieldKeys[number];
const defaults = () => Object.fromEntries(fieldKeys.map(key => {
  const value = key === 'months' ? DEFAULT_CALCULATOR_INPUT.years * 12 : DEFAULT_CALCULATOR_INPUT[key];
  return [key, ['initial', 'monthly', 'target'].includes(key) ? value.toLocaleString('en-US') : String(value)];
})) as Record<Field, string>;
function getPage(): Page {
  const hash = window.location.hash.slice(1);
  return Object.hasOwn(pageLabels, hash) ? hash as Page : 'calculator';
}
function getSidebarOpen(): boolean {
  try { return window.sessionStorage.getItem(SIDEBAR_SESSION_KEY) !== 'closed'; }
  catch { return true; }
}
function exportCSV(projection: Projection) {
  const rows = ['개월,납입 원금(원),예상 자산(원),예상 수익(원)', ...projection.points.map(p => `${p.month},${p.principal},${p.balance},${p.profit}`)];
  const url = URL.createObjectURL(new Blob(['\uFEFF' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = 'MoneyCast-자산시뮬레이션.csv'; a.click(); URL.revokeObjectURL(url);
}
export default function App() {
  const [theme, setTheme] = useState(getTheme);
  const themeSwitchLabel = theme === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환';
  const [page, setPage] = useState<Page>(getPage);
  const [sidebarOpen, setSidebarOpen] = useState(getSidebarOpen);
  const [isMobile, setIsMobile] = useState(() => window.matchMedia?.('(max-width: 760px)').matches ?? false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  const focusSidebarOnOpen = useRef(false);
  const visibleSidebarOpen = isMobile ? mobileSidebarOpen : sidebarOpen;
  const mobileDrawerOpen = isMobile && mobileSidebarOpen;
  const closeSidebar = () => {
    if (isMobile) setMobileSidebarOpen(false);
    else setSidebarOpen(false);
    sidebarToggleRef.current?.focus({ preventScroll: true });
  };
  const [raw, setRaw] = useState(defaults);
  const [goal, setGoal] = useState('free');
  const [showScenarios, setShowScenarios] = useState(false);
  useLayoutEffect(() => {
    applyTheme(theme);
    saveTheme(theme);
  }, [theme]);
  useEffect(() => {
    const listener = () => {
      const next = getPage();
      setPage(next);
      if (window.location.hash !== `#${next}`) window.history.replaceState(null, '', `#${next}`);
    };
    listener();
    window.addEventListener('hashchange', listener);
    return () => window.removeEventListener('hashchange', listener);
  }, []);
  useEffect(() => {
    try { window.sessionStorage.setItem(SIDEBAR_SESSION_KEY, sidebarOpen ? 'open' : 'closed'); }
    catch { /* The toggle still works if browser storage is unavailable. */ }
  }, [sidebarOpen]);
  useEffect(() => {
    const media = window.matchMedia?.('(max-width: 760px)');
    if (!media) return;
    const onChange = () => {
      if (sidebarRef.current?.contains(document.activeElement)) sidebarToggleRef.current?.focus({ preventScroll: true });
      setIsMobile(media.matches);
      setMobileSidebarOpen(false);
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  useEffect(() => {
    if (!visibleSidebarOpen || !focusSidebarOnOpen.current) return;
    focusSidebarOnOpen.current = false;
    const destination = sidebarRef.current?.querySelector<HTMLElement>('[aria-current="page"]')
      ?? sidebarRef.current?.querySelector<HTMLElement>('nav button');
    destination?.focus({ preventScroll: true });
  }, [visibleSidebarOpen]);
  useEffect(() => {
    if (!mobileDrawerOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previousOverflow; };
  }, [mobileDrawerOpen]);
  useEffect(() => {
    if (!visibleSidebarOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const sidebar = sidebarRef.current;
      const toggle = sidebarToggleRef.current;
      if (!sidebar || !toggle) return;
      if (event.key === 'Escape' && (isMobile || sidebar.contains(document.activeElement) || document.activeElement === toggle)) {
        event.preventDefault();
        closeSidebar();
      }
      if (event.key !== 'Tab' || !mobileDrawerOpen) return;
      const controls = [...Array.from(sidebar.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')), toggle].filter(element => {
        for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
          if (parent.hidden || window.getComputedStyle(parent).display === 'none') return false;
        }
        return true;
      });
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || !controls.includes(document.activeElement as HTMLElement))) {
        event.preventDefault();
        last?.focus({ preventScroll: true });
      } else if (!event.shiftKey && (document.activeElement === last || !controls.includes(document.activeElement as HTMLElement))) {
        event.preventDefault();
        first?.focus({ preventScroll: true });
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [visibleSidebarOpen, mobileDrawerOpen, isMobile]);
  const toggleSidebar = () => {
    if (visibleSidebarOpen) closeSidebar();
    else {
      focusSidebarOnOpen.current = true;
      if (isMobile) setMobileSidebarOpen(true);
      else setSidebarOpen(true);
    }
  };
  const navigate = (next: Page) => { if (mobileDrawerOpen) closeSidebar(); setPage(next); window.location.hash = next; window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const values = useMemo(() => Object.fromEntries(fieldKeys.map(k => [k, raw[k].trim() === '' ? NaN : Number(raw[k].replace(/,/g, ''))])) as Record<Field, number>, [raw]);
  const input = useMemo<CalculatorInput>(() => ({ initial: values.initial, monthly: values.monthly, annualRate: values.annualRate, years: values.months / 12, target: values.target }), [values]);
  const errors = useMemo(() => {
    const { years: durationError, ...otherErrors } = validateCalculatorInput(input);
    const monthError = Number.isFinite(values.months) && !Number.isInteger(values.months)
      ? '목표 기간은 1개월 단위의 정수로 입력해 주세요.' : durationError;
    return monthError ? { ...otherErrors, months: monthError } : otherErrors;
  }, [input, values.months]);
  const durationLabel = Number.isInteger(values.months) && values.months >= 1 && values.months <= 600 ? formatDurationMonths(values.months) : '—';
  const projection = useMemo(() => Object.keys(errors).length ? null : calculateProjection(input), [input, errors]);
  const scenarios = useMemo(() => { if (!projection || !showScenarios) return []; try { return calculateScenarios(input); } catch { return []; } }, [input, projection, showScenarios]);
  const update = (key: Field, value: string) => setRaw(old => ({ ...old, [key]: value }));
  const reset = () => { setRaw(defaults()); setGoal('free'); setShowScenarios(false); };
  const targetSet = projection !== null && input.target > 0;
  const percent = targetSet ? projection.finalBalance / input.target * 100 : 0;
  const growth = projection && projection.totalPrincipal > 0 ? projection.totalProfit / projection.totalPrincipal * 100 : 0;
  const field = (key: Field, label: string, unit: string, hint?: string) => <div className="field" key={key}>
    <label htmlFor={key}>{label}{key === 'annualRate' && <span className="field-tag">가정</span>}</label>
    <div className={`input-wrap ${errors[key] ? 'invalid' : ''}`}><input id={key} inputMode={key === 'annualRate' ? 'decimal' : 'numeric'} autoComplete="off" value={raw[key]} onChange={e => update(key, e.target.value)} onBlur={() => { if (['initial', 'monthly', 'target'].includes(key) && !errors[key]) update(key, Number(raw[key].replace(/,/g, '')).toLocaleString('en-US', {maximumFractionDigits: 2})); }} aria-invalid={Boolean(errors[key])} aria-describedby={`${key}-hint`}/><span>{unit}</span></div>
    <span id={`${key}-hint`} className={`field-hint ${errors[key] ? 'error-text' : ''}`}>{errors[key] || hint || (Number.isFinite(values[key]) ? formatCompactKRW(values[key]) : '금액을 입력해 주세요')}</span>
  </div>;
  const isIntro = page === 'calculator-intro' || page === 'news-intro';
  const usageLabel = page === 'news' ? '인사이트 사용법' : '계산기 사용법';
  return <div className={`app-shell ${visibleSidebarOpen ? 'sidebar-expanded' : 'sidebar-collapsed'}`}>
    <a className="skip-link" href="#main" inert={mobileDrawerOpen} onClick={event => { event.preventDefault(); document.getElementById('main')?.focus(); }}>본문으로 바로가기</a>
    <div className={`sidebar-backdrop ${mobileDrawerOpen ? 'is-visible' : ''}`} aria-hidden="true" onClick={closeSidebar}/>
    <div className="sidebar-rail"><aside ref={sidebarRef} id="moneycast-sidebar" className="sidebar" aria-label="MoneyCast 사이드바" aria-hidden={!visibleSidebarOpen} inert={!visibleSidebarOpen}><a className="brand-link" href="#calculator" aria-label="MoneyCast 홈" onClick={() => navigate('calculator')}><Brand/></a><div className="workspace-label">나의 금융 내비게이터</div>
      <nav aria-label="주 메뉴">{nav.map(item => {
        const intro = `${item.id}-intro` as Page;
        return <div key={item.id} className="nav-feature-group"><button className={`nav-item ${page === item.id || page === intro ? 'active' : ''}`} onClick={() => navigate(item.id)} aria-current={page === item.id ? 'page' : undefined}><Icon name={item.icon}/><span>{item.label}</span>{page === item.id && <span className="nav-active-dot"/>}</button><button className={`nav-intro-link ${page === intro ? 'active' : ''}`} onClick={() => navigate(intro)} aria-label={pageLabels[intro]} aria-current={page === intro ? 'page' : undefined}><Icon name="info" size={14}/>{item.id === 'calculator' ? '계산기 사용법' : '인사이트 사용법'}<Icon name="chevron" size={12}/></button></div>;
      })}</nav>
      <div className="sidebar-journey"><div className="journey-bars" aria-hidden="true"><span/><span/><span/><span/><svg viewBox="0 0 140 80"><path d="m8 65 38-18 33-5 50-33m-21 0h21v21" fill="none" stroke="#b6e8bf" strokeWidth="2"/></svg></div><span className="eyebrow">YOUR NEXT CHAPTER</span><h3>오늘의 계획이<br/>내일의 가능성으로.</h3><p>나만의 속도로,<br/>목표에 한 걸음 더 가까이.</p><button onClick={() => navigate('calculator')}>목표 그려보기 <Icon name="arrow" size={16}/></button></div>
      <div className="sidebar-bottom"><button className={`nav-item ${page === 'guide' ? 'active' : ''}`} onClick={() => navigate('guide')}><Icon name="info"/><span>계산 및 데이터 안내</span></button><div className="sidebar-footer"><span className="tiny-brand">MC</span><div><strong>나의 MoneyCast</strong><span>로그인 없이 가볍게 시작</span></div></div></div>
    </aside></div>
    <div className="main-shell"><header className="topbar"><div className="topbar-start"><button ref={sidebarToggleRef} className="sidebar-toggle icon-button" onClick={toggleSidebar} aria-label={visibleSidebarOpen ? '사이드바 닫기' : '사이드바 열기'} title={visibleSidebarOpen ? '사이드바 닫기' : '사이드바 열기'} aria-expanded={visibleSidebarOpen} aria-controls="moneycast-sidebar"><Icon name={visibleSidebarOpen ? 'close' : 'menu'} size={21}/></button><a className="mobile-brand" inert={mobileDrawerOpen} href="#calculator" aria-label="MoneyCast 홈" onClick={() => navigate('calculator')}><Brand/></a><div className="breadcrumb" inert={mobileDrawerOpen}><span>나의 워크스페이스</span><Icon name="chevron" size={12}/><strong>{pageLabels[page]}</strong></div></div><div className="topbar-right" inert={mobileDrawerOpen}><span className="local-status"><i/>내 기기에서 계산</span><button className="theme-toggle icon-button" onClick={() => setTheme(current => current === 'dark' ? 'light' : 'dark')} aria-label={themeSwitchLabel} title={themeSwitchLabel}><Icon name={theme === 'dark' ? 'sun' : 'moon'} size={19}/><span>{theme === 'dark' ? '라이트 모드' : '다크 모드'}</span></button><button className="avatar" aria-label="계산 및 데이터 안내 열기" onClick={() => navigate('guide')}>M</button></div></header>
      <main id="main" tabIndex={-1} inert={mobileDrawerOpen}>
        <div className="page-heading"><div><div className="page-kicker">{isIntro ? 'GET TO KNOW MONEYCAST' : 'MAKE ROOM FOR YOUR FUTURE'}</div><h1>{page === 'calculator-intro' ? <>목표 자금 계산기, <span>이렇게 활용하세요.</span></> : page === 'news-intro' ? <>뉴스 인사이트, <span>근거부터 살펴보세요.</span></> : page === 'news' ? <>뉴스 너머의 <span>근거를 읽다.</span></> : page === 'guide' ? <>숫자는 투명하게, <span>판단은 신중하게.</span></> : <>나의 자산, <span>어디까지 자랄까요?</span></>}</h1><p>{page === 'calculator-intro' ? '지금의 저축과 투자가 목표에 얼마나 가까워지는지 알아보세요.' : page === 'news-intro' ? '출처가 있는 소식과 그 소식만으로 알 수 없는 것을 함께 확인하세요.' : page === 'news' ? '회사의 소식을 살펴보고, 다음 주를 바라보는 다양한 근거를 확인하세요.' : page === 'guide' ? 'MoneyCast의 계산 기준과 데이터 사용 방식을 확인하세요.' : '막연했던 목표를 구체적인 숫자로. 오늘부터 나만의 미래를 그려보세요.'}</p></div><div className="page-heading-actions">{(page === 'calculator' || page === 'news') && <button className="outline-button feature-help-button" aria-label={usageLabel} onClick={() => navigate(`${page}-intro` as Page)}><Icon name="info" size={16}/>{usageLabel}</button>}{page === 'calculator' && <button className="outline-button" onClick={reset}><Icon name="refresh" size={15}/>새로 계산하기</button>}</div></div>
        {isIntro ? <FeatureIntro feature={page === 'calculator-intro' ? 'calculator' : 'news'} onStart={() => navigate(page === 'calculator-intro' ? 'calculator' : 'news')} onGuide={() => navigate('guide')}/> : page === 'news' ? <NewsPanel/> : page === 'guide' ? <Guide/> : <>
        <div className="calculator-layout"><section className="card calculator-card" aria-labelledby="calculator-title"><span className="surface-label">내 조건 입력</span><div className="section-heading"><div><span className="eyebrow">MY FINANCIAL GOAL</span><h2 id="calculator-title">어떤 미래를 준비하나요?</h2></div></div>
          <fieldset className="goal-picker"><legend>목표 유형 <span>예시 금액이 적용됩니다</span></legend><div>{goals.map(g => <button key={g.id} className={goal === g.id ? 'chosen' : ''} onClick={() => { setGoal(g.id); update('target', String(g.amount)); }} aria-pressed={goal === g.id}><span className="goal-type-icon" aria-hidden="true">{g.icon === 'home' || g.icon === 'car' || g.icon === 'plane' ? <GoalIcon name={g.icon}/> : <Icon name={g.icon} size={18}/>}</span><span className="goal-type-label">{g.name}</span></button>)}</div></fieldset>
          <div className="calculator-fields">{field('initial', '현재 시드머니', '원')}{field('monthly', '매월 저축·투자 금액', '원')}{field('annualRate', '연간 예상 수익률', '%', '보장된 수익률이 아닌, 나의 가정이에요.')}
          <div className="period-field">{field('months', '목표 기간', '개월', `${durationLabel} · 1~600개월, 1개월 단위 입력`)}<input className="period-slider" aria-label="목표 기간 슬라이더" aria-valuetext={durationLabel} type="range" min={1} max={600} step={1} value={Number.isFinite(values.months) ? Math.min(600, Math.max(1, Math.round(values.months))) : 60} onChange={e => update('months', e.target.value)}/><div className="range-labels"><span>1개월</span><span>25년</span><span>50년</span></div></div>{field('target', '목표 금액', '원', input.target === 0 ? '0원은 목표 없이 자산 추이만 계산합니다.' : undefined)}</div>
          <div className="form-note"><Icon name="check" size={16}/><span>입력하는 즉시 결과에 반영됩니다.</span></div>
        </section>
        <div className="results-column"><span className="surface-label result-label">계산 결과</span><div className="stat-grid" aria-label="계산 결과 요약"><Stat icon="wallet" label={`${durationLabel} 후 예상 자산`} value={projection ? formatKRW(projection.finalBalance) : '—'} note="원금과 예상 수익의 합계" featured/><Stat icon="trend" label="예상 수익" value={projection ? `${projection.totalProfit < 0 ? '−' : '+'}${formatKRW(Math.abs(projection.totalProfit))}` : '—'} note={projection ? `원금 대비 ${growth >= 0 ? '+' : ''}${growth.toFixed(1)}%` : '입력값을 확인해 주세요'}/><Stat icon="target" label="예상 목표 달성률" value={targetSet ? `${percent.toLocaleString('ko-KR', {maximumFractionDigits: 1})}%` : '—'} note={targetSet ? `목표 ${formatCompactKRW(input.target)}` : '목표를 설정해 주세요'}/></div>
          <section className="card chart-card" aria-labelledby="chart-title"><div className="section-heading"><div><span className="eyebrow">THE BIGGER PICTURE</span><h2 id="chart-title">시간이 만드는 자산의 변화</h2></div><button className="icon-button" aria-label="계산 결과 CSV 저장" title="계산 결과 CSV 저장" disabled={!projection} onClick={() => projection && exportCSV(projection)}><Icon name="download" size={18}/></button></div>
          <div className="chart-toolbar"><span>매월 꾸준히 쌓아가는 나의 미래</span><label className="scenario-toggle"><input type="checkbox" checked={showScenarios} onChange={e => setShowScenarios(e.target.checked)}/><span className="switch"/>시나리오 비교</label></div>
          {projection ? <GrowthChart projection={projection} target={input.target} scenarios={scenarios}/> : <div className="chart-invalid" role="status"><Icon name="info" size={30}/><h3>입력값을 확인해 주세요</h3><p>{errors.projection || '왼쪽 입력란의 안내에 따라 수정하면 차트가 표시됩니다.'}</p></div>}
          {showScenarios && projection && <div className="scenario-results">{scenarios.length ? scenarios.map(s => <Scenario key={s.key} scenario={s}/>) : <p className="error-text">일부 시나리오가 계산 가능한 범위를 넘었습니다.</p>}<p>연 수익률 ±2%p를 적용한 가정 비교입니다. 확률이나 예측이 아닙니다.</p></div>}
          <div className="principal-summary"><span>총 납입 원금 <strong>{projection ? formatKRW(projection.totalPrincipal) : '—'}</strong></span><span>예상 {projection && projection.totalProfit < 0 ? '손실' : '수익'} <strong>{projection ? formatKRW(Math.abs(projection.totalProfit)) : '—'}</strong></span></div></section>
          {projection && <section className={`goal-result ${targetSet && !projection.achieved ? 'not-yet' : ''}`} aria-live="polite"><div><span className="eyebrow">YOUR GOAL, A LITTLE CLOSER</span><h3>{!targetSet ? '나의 자산 계획이 시작되었어요.' : projection.achieved ? <>현재 가정대로라면, 목표를 달성해요.</> : <>목표까지 <strong>{formatCompactKRW(Math.abs(projection.gap))}</strong> 더 필요해요.</>}</h3><p>{!targetSet ? '목표 금액을 입력하면 예상 자산과의 차이를 확인할 수 있어요.' : projection.achieved ? `목표보다 ${formatKRW(projection.gap)} 여유가 있는 계산 결과입니다.` : `목표보다 ${formatKRW(Math.abs(projection.gap))} 부족합니다. 납입액이나 기간을 조정해 보세요.`}</p></div></section>}
        </div></div>
        <div className="bottom-grid"><div className="assumptions-note"><span className="note-icon"><Icon name="info" size={18}/></span><div><h4>계획을 위한 계산, 약속된 미래는 아니에요.</h4><p>월말 납입 · 월 복리 · 세금·수수료·물가상승률 미반영<br/>수익률은 사용자의 가정이며, 실제 수익을 보장하지 않습니다.</p><button onClick={() => navigate('guide')}>자세한 계산 방식 <Icon name="arrow" size={13}/></button></div></div><button className="news-promo" onClick={() => navigate('news')}><span className="news-promo-icon"><Icon name="news" size={24}/></span><span><small>숫자 다음에는, 근거를</small><strong>회사의 소식도 함께 살펴보세요</strong><span>뉴스 인사이트 확인하기 <Icon name="arrow" size={14}/></span></span><span className="promo-decoration" aria-hidden="true">↗</span></button></div>
        </>}
        <footer className="page-footer"><span><strong>MoneyCast.</strong> 내일을 그리는 오늘의 계획</span><span>참고용 시뮬레이션 · 투자 권유 아님</span></footer>
      </main>
    </div>
    <nav className="mobile-nav" aria-label="모바일 주 메뉴" inert={mobileDrawerOpen}>{[...nav, { id:'guide' as Page, label:'이용 안내', icon:'info' as IconName }].map(n => <button key={n.id} onClick={() => navigate(n.id)} className={page === n.id || page === `${n.id}-intro` ? 'active' : ''} aria-current={page === n.id ? 'page' : undefined}><Icon name={n.icon} size={20}/><span>{n.label}</span></button>)}</nav>
  </div>;
}
function Stat({icon, label, value, note, featured = false}: {icon:IconName;label:string;value:string;note:string;featured?:boolean}) { return <section className={`stat-card ${featured ? 'featured' : ''}`}><div className="stat-label"><span>{label}</span><Icon name={icon} size={17}/></div><strong className="stat-value">{value}</strong><span className="stat-note">{note}</span>{featured && <svg className="stat-decoration" aria-hidden="true" viewBox="0 0 100 65"><path d="m0 60 24-15 20 6 28-24 28-22" fill="none" stroke="#a7cdb1" strokeWidth="1.5"/><path d="m0 60 24-15 20 6 28-24 28-22v60H0Z" fill="#d5e9d8" opacity=".3"/></svg>}</section>; }
function Scenario({scenario}: {scenario:ProjectionScenario}) { return <div className={`scenario ${scenario.key}`}><span>{scenario.label} <small>{scenario.annualRate}%</small></span><strong>{formatCompactKRW(scenario.projection.finalBalance)}</strong></div>; }
function Guide() { return <div className="guide-grid"><section className="card guide-card"><span className="eyebrow">CALCULATION RULES</span><h2>계산의 기준</h2><p>웹과 iOS·Android 앱은 동일한 공용 계산 모듈을 사용합니다. 기본 입력은 시드머니 1,000만 원, 월 50만 원, 연 5%, 5년, 목표 5,000만 원입니다. 모두 계산을 위한 예시 가정입니다.</p><dl><dt>월 납입 시점</dt><dd>매월 말. 이전 달 잔액에 수익률을 적용한 뒤 월 납입액을 더합니다.</dd><dt>연 수익률 환산</dt><dd>연 수익률을 실효 연 수익률로 보고 월 수익률을 계산합니다.<code>월 수익률 = (1 + 연 수익률 / 100)^(1/12) − 1</code></dd><dt>월별 자산</dt><dd><code>이번 달 자산 = 지난달 자산 × (1 + 월 수익률) + 월 납입액</code></dd><dt>반올림</dt><dd>계산 중에는 소수 정밀도를 유지합니다. 표시 시 원 단위로 반올림하고, 표시 수익은 표시 자산에서 표시 원금을 뺀 값입니다.</dd><dt>입력 범위</dt><dd>금액 0~1조 원, 수익률 -100% 초과~100% 이하, 기간은 1~600개월을 정수로 입력합니다. 기본 60개월은 5년이며, 13개월은 1년 1개월로 표시합니다. 0원 목표는 목표 미설정입니다. 정밀도 범위를 넘으면 계산을 중단합니다.</dd><dt>제외 항목</dt><dd>세금, 수수료, 물가상승률, 납입액 변동, 실제 시장 변동을 반영하지 않습니다. 손실이 발생할 수 있습니다.</dd><dt>시나리오</dt><dd>입력한 수익률에서 ±2%p를 적용합니다(-100% 초과~100% 이하에서 조정). 예측이나 발생 확률을 의미하지 않습니다.</dd></dl></section><section className="card guide-card"><span className="eyebrow">EVIDENCE & PRIVACY</span><h2>뉴스와 개인정보</h2><p>뉴스는 금융시장의 여러 정보 중 하나입니다. 뉴스의 분위기와 다음 주 주가는 다를 수 있으며, 과거에 알려진 소식이 이미 가격에 반영되었을 수 있습니다.</p><dl><dt>뉴스 연동</dt><dd>서버가 Marketaux(영어·한국어 기사)와 GDELT(하루 한 번 예약 수집 때만)의 기사를 함께 쓰고, 같은 기사는 하나로 합쳐 출처별 상태를 표시합니다. 연결된 출처가 없으면 기사와 방향을 만들지 않습니다. 회사 목록은 식별을 위한 정적 목록이며 실시간 상장 정보가 아닙니다.</dd><dt>AI 요약·분류</dt><dd>서버에 Gemini와 Cloudflare Workers AI 키가 있으면, 감성 점수가 없는 기사를 두 모델이 따로 판단하고 두 판단이 같을 때만 분류를 확정합니다. 한 모델만 답하면 잠정, 판단이 엇갈리면 유보로 표시하며 집계하지 않습니다. 감성 점수가 있는 기사도 두 모델이 확인해, 모두 관련 없다고 본 기사는 집계에서 빼고 목록 아래에 접어 둡니다. 두 모델이 점수와 정반대 방향으로 합의하면 두 모델의 판단을 따르고, 점수와 엇갈리면 유보합니다. 요약과 판단은 기사 제목과 매체 설명만 보고 만들며 틀릴 수 있습니다.</dd><dt>근거 수준</dt><dd>기사 수, 7일 이내 최신성, 긍정·부정 의견의 상충을 확인합니다. 기사 부족·오래된 기사·상충은 판단 유보로 표시합니다. 정확도 수치나 상승·하락 확률을 제시하지 않습니다.</dd><dt>분석 대상 주간</dt><dd>한국 시간 기준 다음 달력 주의 월요일~금요일입니다. 국가·거래소별 휴장일과 실제 거래일은 아직 연동되지 않았습니다.</dd><dt>출처와 분석 기록</dt><dd>제공자, 원문 링크, 기사 시각, 기준 시각, 분석 버전을 보존합니다. 하루 한 번 예약 수집한 결과와 최근 7일 기사 목록은 서버의 비공개 저장소에 보관하며, 새 기사를 불러오지 못하면 이전 결과임을 표시해 보여줍니다. 영구 성과 추적은 제공하지 않습니다.</dd><dt>나의 입력 정보</dt><dd>계산기 입력은 현재 기기 메모리에서만 처리하며 서버로 전송하지 않습니다. 새로고침하면 기본값으로 돌아갑니다. 뉴스 요청에는 선택한 회사 식별자만 전달합니다.</dd></dl><div className="risk-box"><h4>투자 유의</h4><p>이 서비스는 계획과 정보 확인을 위한 참고 도구입니다. 미래 수익을 보장하거나 개인 맞춤형 매수·매도를 지시하지 않습니다. 뉴스는 주가의 원인이나 미래 방향을 증명하지 않습니다.</p></div></section></div>; }
