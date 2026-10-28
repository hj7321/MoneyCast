import { useEffect, useMemo, useState } from 'react';
import { companies, searchCompanies, INVESTMENT_NOTICE, type AiProviderState, type Company, type NewsAnalysis, type NewsArticle, type NewsSourceState } from '@moneycast/core';
import { Icon } from './icons';
import { CompanyAvatar } from './CompanyAvatar';
import { loadCachedNews, peekCachedNews, peekLastGoodNews } from './news-cache';

const sentimentLabels = { positive: '긍정', negative: '부정', neutral: '중립', unclassified: '미분류' };
const VISIBLE_ARTICLES = 8;

/** Card badge: provider or agreed labels as is; a single model's view is marked provisional. */
function badge(article: NewsArticle): { label: string; className: string } {
  if (article.aiRelevance === 'unrelated') return { label: '관련성 낮음', className: 'unrelated' };
  if (article.aiConsensus === 'confirmed') return { label: `${sentimentLabels[article.sentiment]} · AI 합의`, className: article.sentiment };
  if (article.aiConsensus === 'withheld') return { label: '판단 유보', className: 'withheld' };
  if (article.aiConsensus === 'provisional') {
    const only = article.aiJudgements?.[0];
    if (!only || !only.relevant || only.sentiment === 'uncertain') return { label: '관련성 확인 대기', className: 'unclassified' };
    return { label: `${sentimentLabels[only.sentiment]} · 잠정`, className: `provisional ${only.sentiment}` };
  }
  return { label: sentimentLabels[article.sentiment], className: article.sentiment };
}

function aiStatusLabel(model: AiProviderState) {
  if (model.status === 'ok') return `${model.label} 정상 ${model.judgedCount}건`;
  if (model.status === 'idle') return `${model.label} 새로 판단할 기사 없음`;
  if (model.status === 'not_configured') return `${model.label} 미설정`;
  if (model.status === 'rate_limited') return `${model.label} 한도 도달${model.retryAt ? `(재시도 ${formatTime(model.retryAt)})` : ''}`;
  if (model.status === 'timeout') return `${model.label} 시간 초과`;
  return `${model.label} 응답 없음`;
}
const formatTime = (value: string) => `${new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} KST`;
const articleAnchor = (index: number) => `news-article-${index}`;
const unrelatedAnchor = (index: number) => `news-unrelated-${index}`;
const isRelated = (article: NewsArticle) => article.aiRelevance !== 'unrelated';
function shorten(value: string, max: number) {
  const chars = [...value];
  return chars.length <= max ? value : `${chars.slice(0, max - 1).join('')}…`;
}

function sourceStatusLabel(source: NewsSourceState) {
  if (source.status === 'ok') return `${source.label} 정상 ${source.articleCount}건`;
  if (source.status === 'empty') return `${source.label} 기사 없음`;
  if (source.status === 'skipped') return `${source.label} 예약 수집 때만 조회`;
  if (source.status === 'not_configured') return `${source.label} 미설정`;
  if (source.status === 'rate_limited') return `${source.label} 호출 제한${source.retryAt ? `(재시도 ${formatTime(source.retryAt)})` : ''}`;
  return `${source.label} 실패`;
}
function elapsedLabel(from: string, now = Date.now()) {
  const minutes = Math.max(0, Math.round((now - Date.parse(from)) / 60_000));
  return minutes < 60 ? `${minutes}분 전` : minutes < 48 * 60 ? `${Math.round(minutes / 60)}시간 전` : `${Math.round(minutes / 1440)}일 전`;
}

/** Synthesized sentences when the server provides them; plain factor strings otherwise. */
function FactorGrid({ analysis, onEvidence }: { analysis: NewsAnalysis; onEvidence: (articleId: string) => void }) {
  const boxes = [['positive', '긍정 요인', analysis.positiveFactors], ['negative', '부정 요인', analysis.negativeFactors]] as const;
  return <>
    <div className="factor-grid">{boxes.map(([direction, title, legacy]) => {
      const box = analysis.factorSummary?.[direction];
      return <div key={direction}><h4>{title}</h4>
        {box ? box.lines.length ? box.lines.map((line, i) => <p key={i} className="factor-line">{line.text} <button type="button" className="evidence-link" onClick={() => onEvidence(line.articleIds[0]!)}>근거 기사 {line.articleIds.length}건</button></p>) : <p>확인된 요인 없음</p>
          : legacy.length ? legacy.map((s, i) => <p key={i}>{s}</p>) : <p>확인된 요인 없음</p>}
        {box && box.chips.length > 0 && <ul className="factor-chips" aria-label={`${title} 주의 사항`}>{box.chips.map(chip => <li key={chip}>{chip}</li>)}</ul>}
      </div>;
    })}</div>
    {analysis.factorSummary && <>
      {analysis.factorSummary.chips.length > 0 && <ul className="factor-chips overall" aria-label="종합 주의 사항">{analysis.factorSummary.chips.map(chip => <li key={chip}>{chip}</li>)}</ul>}
      <p className="news-provider-note">{analysis.factorSummary.note}</p>
    </>}
  </>;
}

/** What the article is about (summary) and why it carries its label (rationale). */
function ArticleCard({ article, anchor, provider }: { article: NewsArticle; anchor: string; provider: string | null }) {
  const label = badge(article);
  return <article id={anchor} tabIndex={-1}>
    <div className="article-meta"><span className={`sentiment ${label.className}`}>{label.label}</span><span>{article.source} · {article.timeKind === 'seen' ? `${article.sourceProvider ?? '수집기'} 확인` : '게시'}: {formatTime(article.publishedAt)}</span>{article.language && <span>원문 언어: {languageLabel(article.language)}</span>}{article.sourceProvider && <span>수집: {article.sourceProvider}</span>}</div>
    <h3><a href={article.url} target="_blank" rel="noopener noreferrer">{article.title}<Icon name="external" size={15}/></a></h3>
    <div className="article-summary">{article.summary ? <>
      <span className="article-block-label">핵심 요약 · AI 요약({article.summary.basis === 'title_only' ? '제목만 기준, 본문 미확인' : '제목·설명 기준'})</span>
      <p>{article.summary.text}</p></> : <>
      <span className="article-block-label">핵심 요약{article.description ? ' · 매체 설명(원문)' : ''}</span>
      <p>{article.description ? shorten(article.description, 160) : '요약 정보 없음 — 원문에서 확인하세요.'}</p></>}</div>
    {article.alsoReportedBy && article.alsoReportedBy.length > 0 && <p className="article-provenance">같은 내용 다른 출처 {article.alsoReportedBy.length}곳: {article.alsoReportedBy.slice(0, 3).map(item => item.source).join(', ')}{article.alsoReportedBy.length > 3 ? ' 외' : ''}</p>}
    {article.rationaleLines ? <div className="article-rationale"><span className="article-block-label">분류 근거</span>
      <ol>{article.rationaleLines.slice(0, 5).map((line, i) => <li key={i}>{line}</li>)}</ol></div> : <>
      <p>{article.rationale}</p>
      {article.classificationMethod === 'provider' && <p className="article-provenance">{provider || '뉴스 제공자'} 제공자 분류{article.sentimentScore !== undefined ? ` · 기사 감성 점수 ${String(article.sentimentScore)} (−1~1)` : ''} · 주가 상승 확률이 아닙니다.</p>}
      {article.classificationMethod === 'unavailable' && <p className="article-provenance">제공자 감성 점수가 없어 분류하지 않았습니다.</p>}
      {article.providerEntity && <p className="article-provenance">제공자 기업 식별: {article.providerEntity.name} · {article.providerEntity.symbol} · {article.providerEntity.exchange || '거래소 정보 미제공'} · {article.providerEntity.country.toUpperCase()}</p>}
    </>}
  </article>;
}
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
  const [expanded, setExpanded] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const results = searchCompanies(query);
  const retryDelayed = useRetryDelay(analysis?.retryAt);
  const refreshDisabled = loading || retryDelayed;
  useEffect(() => {
    let disposed = false;
    const cached = peekCachedNews(company.id);
    setError(''); setAnalysis(cached); setLoading(!cached); setExpanded(false);
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
  // A failed refresh shows this browser's last successful result, clearly labelled as old.
  const fallback = useMemo(() => failed ? peekLastGoodNews(company.id) : null, [failed, company.id, analysis]);
  const shown = failed && fallback ? fallback : analysis;
  const stale = shown && (shown.servedFrom === 'stale' || shown === fallback)
    ? { asOf: shown.asOf, reason: shown === fallback ? error || analysis?.message : shown.message } : null;
  const marketaux = /marketaux/i.test(`${shown?.provider ?? ''} ${shown?.message ?? ''}`);
  const aiOutput = !!shown?.articles.some(article => article.summary || article.aiJudgements);
  // Articles both models judged unrelated are folded below the list; factors never point at them.
  const related = shown?.articles.filter(isRelated) ?? [];
  const unrelated = shown?.articles.filter(article => !isRelated(article)) ?? [];
  useEffect(() => {
    if (!focusId || !shown) return;
    // Hash links would change the app route; move focus to the card instead.
    const target = document.getElementById(articleAnchor(shown.articles.filter(isRelated).findIndex(article => article.id === focusId)));
    target?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    target?.focus({ preventScroll: true });
    setFocusId(null);
  }, [focusId, expanded, shown]);
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
          : failed && !fallback ? <div className="empty-state" role="alert"><div className="state-illustration orange"><Icon name="info" size={30}/></div><span className="status-badge orange">{analysis?.status === 'rate_limited' ? '호출 제한' : '연결 오류'}</span><h3>뉴스를 불러오지 못했어요</h3><p>{error || analysis?.message || '뉴스 제공자 응답을 확인하지 못했습니다.'}</p>{analysis?.retryAt && <p>다시 요청 가능한 시각: {formatTime(analysis.retryAt)}</p>}<button className="primary-button" onClick={() => setRetry(n => n + 1)} disabled={refreshDisabled}>다시 시도 <Icon name="refresh" size={16}/></button></div>
            : pending ? <div className="empty-state"><div className="state-illustration"><Icon name="news" size={32}/><span className="illustration-dot"/></div><span className="status-badge">데이터 연동 대기</span><h3>좋은 판단은, 확인된 근거에서</h3><p>{analysis?.message || '아직 뉴스 제공자가 연결되지 않았습니다. 실제 기사가 연결되면 출처와 불확실성을 함께 보여드려요.'}</p><div className="connection-notice"><Icon name="shield" size={18}/><span>뉴스가 없으면 방향을 추측하지 않습니다.</span></div><details className="setup-details"><summary>뉴스 연동 설정 안내</summary><p><a href="https://www.marketaux.com/" target="_blank" rel="noopener noreferrer">Marketaux 무료 계정</a>에서 API 토큰을 발급한 뒤 프로젝트 루트의 <code>.env</code>에 <code>NEWS_PROVIDER=marketaux</code>와 서버 전용 <code>MARKETAUX_API_TOKEN</code>을 설정하고 API 서버를 재시작하세요. 키는 브라우저나 앱에 입력하지 않습니다. 기존 게이트웨이 설정은 서버 README를 확인해 주세요.</p></details></div>
              : shown ? <>
                {stale && <div className="stale-banner" role="status"><strong>이전 결과</strong><p>새 기사를 불러오지 못해 {formatTime(stale.asOf)} 기준 결과({elapsedLabel(stale.asOf)})를 보여드립니다.{stale.reason ? ` ${stale.reason}` : ''}</p><button className="stale-retry" onClick={() => setRetry(n => n + 1)} disabled={refreshDisabled}>다시 시도</button></div>}
                <div className="evidence-summary"><span className={`status-badge ${shown.status === 'insufficient' ? 'orange' : ''}`}>{shown.status === 'insufficient' ? '근거 부족 · 판단 유보' : '뉴스 참고 · 불확실성 존재'}</span><h3>{shown.summary}</h3><p>근거 수준: {shown.evidence === 'moderate' ? '보통' : shown.evidence === 'low' ? '낮음' : '없음'} · 기사 {related.length}건{unrelated.length ? ` · 관련성 낮음 ${unrelated.length}건` : ''}</p>
                  {shown.sources && <p className="source-status">출처 상태: {shown.sources.map(sourceStatusLabel).join(' · ')}</p>}
                  {shown.ai && <p className="source-status">AI 판단: {shown.ai.providers.map(aiStatusLabel).join(' · ')}{shown.ai.unrelatedCount > 0 ? ` · 관련성 낮은 기사 ${shown.ai.unrelatedCount}건은 아래에 접어 둠` : ''}</p>}</div>
                <FactorGrid analysis={shown} onEvidence={id => {
                  if (related.findIndex(article => article.id === id) >= VISIBLE_ARTICLES) setExpanded(true);
                  setFocusId(id);
                }}/>
                {related.length === 0 && <div className="article-empty">{unrelated.length ? '이 회사와 관련성이 높은 기사가 없습니다.' : '수집 기간에 확인된 기사가 없습니다.'}</div>}
                {related.some(article => article.sentiment === 'unclassified') && <p className="news-provider-note">{shown.ai ? '미분류·잠정·판단 유보 기사는 긍정·부정 요인 집계에서 제외합니다.' : '미분류 기사는 긍정·부정 요인 집계에서 제외합니다.'}</p>}
                <div className="article-list">{(expanded ? related : related.slice(0, VISIBLE_ARTICLES)).map((article, index) => <ArticleCard key={article.id} article={article} anchor={articleAnchor(index)} provider={shown.provider}/>)}</div>
                {related.length > VISIBLE_ARTICLES && <button type="button" className="article-more" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? '기사 접기' : `기사 ${related.length - VISIBLE_ARTICLES}건 더 보기`}</button>}
                {unrelated.length > 0 && <details className="unrelated-articles"><summary>관련성 낮은 기사 {unrelated.length}건 — 두 AI가 모두 이 회사 기사가 아니라고 판단해 요인에서 뺐습니다</summary>
                  <div className="article-list">{unrelated.map((article, index) => <ArticleCard key={article.id} article={article} anchor={unrelatedAnchor(index)} provider={shown.provider}/>)}</div></details>}
                <div className="risk-box"><h4>전망이 빗나갈 수 있는 이유</h4>{shown.risks.map((s, i) => <p key={i}>{s}</p>)}</div>
              </> : null}
        {marketaux && <p className="news-provider-note">Marketaux 무료 연동은 요청당 최대 3개 기사를 확인합니다. 영어·한국어 기사만 조회하며, 기사 부족·상충 시 판단을 유보합니다.</p>}
        {aiOutput && <p className="news-provider-note">일부 요약·분류는 AI(Gemini·Cloudflare Workers AI)가 기사 제목과 매체 설명만 보고 생성했으며 틀릴 수 있습니다. 원문에서 확인하세요.</p>}
        {shown?.articles.some(article => article.sourceProvider === 'GDELT') && <p className="news-provider-note">일부 기사 목록은 <a href="https://www.gdeltproject.org" target="_blank" rel="noopener noreferrer">GDELT Project</a> 검색 결과입니다. GDELT 시각은 기사를 처음 확인한 시각이며 게시 시각과 다를 수 있습니다.</p>}
        {shown && <div className="analysis-footer">
          <span>데이터 기준: {formatTime(shown.asOf)}</span>
          {shown.newsWindow && <span>뉴스 수집 기간: {formatTime(shown.newsWindow.start)} ~ {formatTime(shown.newsWindow.end)}</span>}
          <span>다음 주 참고 기간: {shown.period.start} ~ {shown.period.end}</span>
          {shown.cachedUntil && !stale && <span>캐시 만료: {formatTime(shown.cachedUntil)} · 정상 뉴스는 최대 6시간 재사용하며, 이 시각 전에는 저장된 결과를 보여줍니다.</span>}
          <span>출처: {shown.provider || '미연결'} · {shown.analysisVersion}</span>
          <span>근거 수준은 최근 7일의 기사 수·분류 상충 여부에 따른 표시이며 예측 정확도가 아닙니다.</span>
          <span>주간은 달력상 월~금이며 거래소 휴장일은 반영하지 않습니다.</span>
        </div>}
      </section>
      <div className="investment-notice"><Icon name="info" size={19}/><p>{INVESTMENT_NOTICE}</p></div>
    </div>
  </div>;
}
