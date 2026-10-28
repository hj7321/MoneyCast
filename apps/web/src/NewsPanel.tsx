import { useEffect, useState } from 'react';
import { companies, searchCompanies, INVESTMENT_NOTICE, type Company, type NewsAnalysis } from '@moneycast/core';
import { Icon } from './icons';
import { CompanyAvatar } from './CompanyAvatar';
import { loadCachedNews, peekCachedNews } from './news-cache';

const sentimentLabels = { positive: '긍정', negative: '부정', neutral: '중립', unclassified: '미분류' };
const formatTime = (value: string) => `${new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} KST`;
function languageLabel(code: string) {
  try { return new Intl.DisplayNames(['ko'], { type: 'language' }).of(code) || code; }
  catch { return code; }
}
function useRetryDelay(retryAt?: string) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    const remaining = retryAt ? Date.parse(retryAt) - Date.now() : 0;
    if (remaining <= 0) return;
    // Only unlock the control at the deadline; never fetch on a timer.
    const timer = setTimeout(() => setNow(Date.now()), Math.min(remaining + 20, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [retryAt]);
  return !!retryAt && Date.parse(retryAt) > now;
}

export function NewsPanel() {
  const [query, setQuery] = useState('');
  const [company, setCompany] = useState<Company>(companies[0]);
  const [analysis, setAnalysis] = useState<NewsAnalysis | null>(() => peekCachedNews(companies[0].id));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const results = searchCompanies(query);
  const retryDelayed = useRetryDelay(analysis?.retryAt);
  const refreshDisabled = loading || retryDelayed;
  useEffect(() => {
    let disposed = false;
    const cached = peekCachedNews(company.id);
    setError(''); setAnalysis(cached); setLoading(!cached);
    if (!cached) loadCachedNews(company.id)
      .then(data => { if (!disposed) setAnalysis(data); })
      .catch((err: unknown) => {
        if (!disposed) setError(err instanceof Error && err.name === 'TimeoutError'
          ? '요청 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.'
          : err instanceof TypeError ? '서버에 연결하지 못했습니다. API 서버 실행 상태를 확인해 주세요.'
            : err instanceof Error ? err.message : '뉴스를 불러오지 못했습니다. 다시 시도해 주세요.');
      }).finally(() => { if (!disposed) setLoading(false); });
    // The cache owns a shared in-flight request; leaving this screen only ignores its result.
    return () => { disposed = true; };
  }, [company.id, retry]);
  const pending = analysis?.status === 'not_configured';
  const failed = error || analysis?.status === 'error' || analysis?.status === 'rate_limited';
  const marketaux = /marketaux/i.test(`${analysis?.provider ?? ''} ${analysis?.message ?? ''}`);
  return <div className="news-layout">
    <section className="card company-picker">
      <div className="section-heading"><div><span className="eyebrow">FIND YOUR COMPANY</span><h2>어떤 회사가 궁금하세요?</h2></div><Icon name="search"/></div>
      <label className="search-input"><Icon name="search" size={18}/><input aria-label="회사명 또는 종목 코드 검색" placeholder="회사명 또는 종목 코드" value={query} onChange={e => setQuery(e.target.value)}/>{query && <button aria-label="검색어 지우기" onClick={() => setQuery('')}><Icon name="close" size={16}/></button>}</label>
      <p className="muted small">회사명과 시장을 함께 확인해 선택하세요.</p>
      <div className="company-list">{results.length ? results.map(c => <button key={c.id} className={`company-option ${c.id === company.id ? 'selected' : ''}`} onClick={() => setCompany(c)} aria-pressed={c.id === company.id}><CompanyAvatar company={c}/><span><strong>{c.name}</strong><small>{c.symbol} · {c.exchange} · {c.region === 'KR' ? '한국' : '미국'}</small></span>{c.id === company.id ? <Icon name="check" size={17}/> : <Icon name="chevron" size={15}/>}</button>) : <div className="search-empty">검색 결과가 없습니다.<br/><small>현재 제공되는 8개 회사에서 선택할 수 있습니다.</small></div>}</div>
      <div className="catalog-note"><Icon name="info" size={15}/><span>회사 식별용 정적 목록입니다.<br/>실시간 종목·시세 검색이 아닙니다.</span></div>
    </section>
    <div className="news-main">
      <section className="card analysis-card">
        <div className="analysis-header"><div><span className="eyebrow">NEWS EVIDENCE</span><h2>{company.name} <span className="company-symbol">{company.symbol} · {company.exchange}</span></h2></div><button className="icon-button" aria-label="분석 다시 불러오기" onClick={() => setRetry(n => n + 1)} disabled={refreshDisabled} title={retryDelayed ? '호출 제한이 끝난 후 다시 시도할 수 있습니다.' : undefined}><Icon name="refresh" className={loading ? 'spin' : ''}/></button></div>
        {loading ? <div className="empty-state" role="status"><div className="state-illustration"><Icon name="refresh" size={30} className="spin"/></div><h3>뉴스 근거를 확인하고 있어요</h3><p>출처와 게시 시각을 함께 살펴봅니다.</p></div>
          : failed ? <div className="empty-state" role="alert"><div className="state-illustration orange"><Icon name="info" size={30}/></div><span className="status-badge orange">{analysis?.status === 'rate_limited' ? '호출 제한' : '연결 오류'}</span><h3>뉴스를 불러오지 못했어요</h3><p>{error || analysis?.message || '뉴스 제공자 응답을 확인하지 못했습니다.'}</p>{analysis?.retryAt && <p>다시 요청 가능한 시각: {formatTime(analysis.retryAt)}</p>}<button className="primary-button" onClick={() => setRetry(n => n + 1)} disabled={refreshDisabled}>다시 시도 <Icon name="refresh" size={16}/></button></div>
            : pending ? <div className="empty-state"><div className="state-illustration"><Icon name="news" size={32}/><span className="illustration-dot"/></div><span className="status-badge">데이터 연동 대기</span><h3>좋은 판단은, 확인된 근거에서</h3><p>{analysis?.message || '아직 뉴스 제공자가 연결되지 않았습니다. 실제 기사가 연결되면 출처와 불확실성을 함께 보여드려요.'}</p><div className="connection-notice"><Icon name="shield" size={18}/><span>뉴스가 없으면 방향을 추측하지 않습니다.</span></div><details className="setup-details"><summary>뉴스 연동 설정 안내</summary><p><a href="https://www.marketaux.com/" target="_blank" rel="noopener noreferrer">Marketaux 무료 계정</a>에서 API 토큰을 발급한 뒤 프로젝트 루트의 <code>.env</code>에 <code>NEWS_PROVIDER=marketaux</code>와 서버 전용 <code>MARKETAUX_API_TOKEN</code>을 설정하고 API 서버를 재시작하세요. 키는 브라우저나 앱에 입력하지 않습니다. 기존 게이트웨이 설정은 서버 README를 확인해 주세요.</p></details></div>
              : analysis ? <>
                <div className="evidence-summary"><span className={`status-badge ${analysis.status === 'insufficient' ? 'orange' : ''}`}>{analysis.status === 'insufficient' ? '근거 부족 · 판단 유보' : '뉴스 참고 · 불확실성 존재'}</span><h3>{analysis.summary}</h3><p>근거 수준: {analysis.evidence === 'moderate' ? '보통' : analysis.evidence === 'low' ? '낮음' : '없음'} · 기사 {analysis.articles.length}건</p></div>
                <div className="factor-grid"><div className="factor-positive"><h4>긍정 요인<span className="factor-direction" aria-hidden="true">↑</span></h4>{analysis.positiveFactors.length ? analysis.positiveFactors.map((s, i) => <p key={i}>{s}</p>) : <p>확인된 요인 없음</p>}</div><div className="factor-negative"><h4>부정 요인<span className="factor-direction" aria-hidden="true">↓</span></h4>{analysis.negativeFactors.length ? analysis.negativeFactors.map((s, i) => <p key={i}>{s}</p>) : <p>확인된 요인 없음</p>}</div></div>
                {analysis.articles.length === 0 && <div className="article-empty">수집 기간에 확인된 기사가 없습니다.</div>}
                {analysis.articles.some(article => article.sentiment === 'unclassified') && <p className="news-provider-note">미분류 기사는 긍정·부정 요인 집계에서 제외합니다.</p>}
                <div className="article-list">{analysis.articles.map(article => <article key={article.id}>
                  <div className="article-meta"><span className={`sentiment ${article.sentiment}`}>{sentimentLabels[article.sentiment]}</span><span>{article.source} · 게시: {formatTime(article.publishedAt)}</span>{article.language && <span>원문 언어: {languageLabel(article.language)}</span>}</div>
                  <h3><a href={article.url} target="_blank" rel="noopener noreferrer">{article.title}<Icon name="external" size={15}/></a></h3>
                  <p>{article.rationale}</p>
                  {article.classificationMethod === 'provider' && <p className="article-provenance">{analysis.provider || '뉴스 제공자'} 제공자 분류{article.sentimentScore !== undefined ? ` · 기사 감성 점수 ${String(article.sentimentScore)} (−1~1)` : ''} · 주가 상승 확률이 아닙니다.</p>}
                  {article.classificationMethod === 'unavailable' && <p className="article-provenance">제공자 감성 점수가 없어 분류하지 않았습니다.</p>}
                  {article.providerEntity && <p className="article-provenance">제공자 기업 식별: {article.providerEntity.name} · {article.providerEntity.symbol} · {article.providerEntity.exchange || '거래소 정보 미제공'} · {article.providerEntity.country.toUpperCase()}</p>}
                </article>)}</div>
                <div className="risk-box"><h4>전망이 빗나갈 수 있는 이유</h4>{analysis.risks.map((s, i) => <p key={i}>{s}</p>)}</div>
              </> : null}
        {marketaux && <p className="news-provider-note">Marketaux 무료 연동은 요청당 최대 3개 기사를 확인합니다. 원문 언어를 제한하지 않아 해외 기사가 포함될 수 있으며, 기사 부족·상충 시 판단을 유보합니다.</p>}
        {analysis && <div className="analysis-footer">
          <span>데이터 기준: {formatTime(analysis.asOf)}</span>
          {analysis.newsWindow && <span>뉴스 수집 기간: {formatTime(analysis.newsWindow.start)} ~ {formatTime(analysis.newsWindow.end)}</span>}
          <span>다음 주 참고 기간: {analysis.period.start} ~ {analysis.period.end}</span>
          {analysis.cachedUntil && <span>캐시 만료: {formatTime(analysis.cachedUntil)} · 정상 뉴스는 최대 6시간 재사용하며, 이 시각 전에는 저장된 결과를 보여줍니다.</span>}
          <span>출처: {analysis.provider || '미연결'} · {analysis.analysisVersion}</span>
          <span>근거 수준은 최근 7일의 기사 수·분류 상충 여부에 따른 표시이며 예측 정확도가 아닙니다.</span>
          <span>주간은 달력상 월~금이며 거래소 휴장일은 반영하지 않습니다.</span>
        </div>}
      </section>
      <div className="investment-notice"><Icon name="info" size={19}/><p>{INVESTMENT_NOTICE}</p></div>
    </div>
  </div>;
}
