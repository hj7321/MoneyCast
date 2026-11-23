import { useEffect, useState, type JSX } from 'react';
import {
  BACKFILL_SAMPLE_NOTE, BASIS_SECTION_TITLE, CASE_BASIS_NOTE, CASE_DIRECTION_TITLES, CASE_WINDOW_NOTES, CASES_SECTION_TITLE,
  DIFFERENT_HORIZONS_NOTE, EVIDENCE_TITLE, EXPIRED_STATS_MESSAGE, GDELT_CREDIT, HISTORY_DISCLAIMER, HISTORY_LOADING_MESSAGE,
  HISTORY_RETRY_LABEL, HISTORY_SECTION_TITLE, HISTORY_UNAVAILABLE_MESSAGE, HORIZON_LABELS, IDENTITY_UNVERIFIED_MESSAGE,
  MARKETAUX_TOP_NOTE, NEWS_WINDOW_LABEL, NO_HISTORY_MESSAGE, PARTIAL_NEWS_NOTE, PRICE_UNAVAILABLE_MESSAGE, RESULT_DEFINITIONS,
  STALE_STATS_LABEL, STATS_NOT_PUBLIC_MESSAGE,
  caseListSummary, caseRefLine, caseStatsLines, coverageLine, deriveHistoryView, excludedLines, insufficientReasonLine,
  outlookSectionTitle, outlookSummaryLine, overnightEvidenceLine, parseCompanyHistory, sampleLine, sourcesLine, targetLine,
  topicCaseLines,
  type CompanyHistory, type HistoryView, type Horizon, type HorizonView, type NewsAnalysis, type NewsTopicKey,
  type ReadyCompanyHistory,
} from '@moneycast/core';

/** A slow history answer must never hold the news screen: past this it counts as failed. */
export const HISTORY_FETCH_TIMEOUT_MS = 8_000;
/** Answers are reused for at most ten minutes, and never past the end of the overnight news window. */
export const HISTORY_CACHE_TTL_MS = 10 * 60_000;

const HORIZONS: readonly Horizon[] = ['day', 'week'];
const EVIDENCE_ID = 'history-evidence';
const GDELT_URL = 'https://www.gdeltproject.org';

// Module state rather than component state: a request belongs to this module,
// so unmounting a card only ignores the answer, and a remount shares it.
const cache = new Map<string, { value: CompanyHistory; expiresAt: number }>();
const pending = new Map<string, Promise<CompanyHistory>>();
let generation = 0;

/** Tests only: forgets cached answers and requests in flight. */
export function resetHistoryInsightCache(): void {
  cache.clear();
  pending.clear();
  generation += 1;
}

// Same format as NewsPanel; importing it from there would be a circular import.
const formatTime = (value: string) => `${new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} KST`;

function cachedHistory(companyId: string): CompanyHistory | null {
  const entry = cache.get(companyId);
  if (!entry) return null;
  if (entry.expiresAt > Date.now()) return entry.value;
  cache.delete(companyId);
  return null;
}

/** Only 'off' and the ready family are kept. When the overnight window closes the target moves, so the answer expires with it. */
function cacheUntil(value: CompanyHistory, now: number): number | null {
  if (value.status === 'unavailable') return null;
  let until = now + HISTORY_CACHE_TTL_MS;
  if (value.status !== 'off') {
    const day = value.horizons.day;
    if (day.targetWindow.phase !== 'in_session' && day.newsWindow) until = Math.min(until, Date.parse(day.newsWindow.end));
  }
  return until > now ? until : null;
}

function load(companyId: string): Promise<CompanyHistory> {
  const inflight = pending.get(companyId);
  if (inflight) return inflight;
  const round = generation;
  const request: Promise<CompanyHistory> = (async () => {
    const response = await fetch(`/api/news/history?companyId=${encodeURIComponent(companyId)}`, {
      signal: AbortSignal.timeout(HISTORY_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`history request failed (${response.status})`);
    let body: unknown;
    try { body = await response.json(); } catch { throw new Error('history response is not JSON'); }
    const history = parseCompanyHistory(body);
    if (history === null || history.companyId !== companyId || history.status === 'unavailable') {
      throw new Error('history response rejected');
    }
    const until = cacheUntil(history, Date.now());
    if (until !== null && round === generation) cache.set(companyId, { value: history, expiresAt: until });
    return history;
  })().finally(() => {
    if (pending.get(companyId) === request) pending.delete(companyId);
  });
  pending.set(companyId, request);
  return request;
}

type LoadState = 'loading' | 'failed' | { history: CompanyHistory };

/**
 * Next-trading-day and next-week outlooks for the analysis on screen. The two
 * signals are derived here, from that analysis, so they always match it.
 * Renders nothing when the server reports the feature off.
 */
export function HistoryInsight({ analysis }: { analysis: NewsAnalysis }): JSX.Element | null {
  const companyId = analysis.company.id;
  const [state, setState] = useState<LoadState>(() => {
    const hit = cachedHistory(companyId);
    return hit ? { history: hit } : 'loading';
  });
  const [selected, setSelected] = useState<Horizon>('day');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let disposed = false;
    const hit = cachedHistory(companyId);
    if (hit) {
      setState(current => typeof current === 'object' && current.history === hit ? current : { history: hit });
      return;
    }
    setState('loading');
    load(companyId).then(
      history => { if (!disposed) setState({ history }); },
      () => { if (!disposed) setState('failed'); },
    );
    return () => { disposed = true; };
  }, [companyId, attempt]);

  if (typeof state === 'object' && state.history.status === 'off') return null;
  const waiting = typeof state !== 'object';
  // Live only while waiting: a failure is announced, switching horizons is not read out again.
  return <section className="history-insight" aria-labelledby="history-insight-title" aria-live={waiting ? 'polite' : undefined}>
    <h3 id="history-insight-title" className="history-insight-title">{HISTORY_SECTION_TITLE}</h3>
    {state === 'loading' ? <p className="history-loading">{HISTORY_LOADING_MESSAGE}</p>
      : state === 'failed' ? <>
        <p className="history-failure">{HISTORY_UNAVAILABLE_MESSAGE}</p>
        <button type="button" className="history-retry" onClick={() => { setState('loading'); setAttempt(n => n + 1); }}>{HISTORY_RETRY_LABEL}</button>
      </> : readyContent(analysis, state.history, selected, setSelected)}
  </section>;
}

function readyContent(analysis: NewsAnalysis, history: CompanyHistory, selected: Horizon, select: (horizon: Horizon) => void): JSX.Element {
  if (history.status === 'off' || history.status === 'unavailable') return <p className="history-failure">{HISTORY_UNAVAILABLE_MESSAGE}</p>;
  try {
    const view = deriveHistoryView(analysis, history, Date.now());
    return <>
      <div className="history-cards">{HORIZONS.map(horizon => card(view[horizon], horizon === selected, () => select(horizon)))}</div>
      <p className="history-note">{DIFFERENT_HORIZONS_NOTE}</p>
      <div className="history-evidence" id={EVIDENCE_ID}>
        <h4>{`${EVIDENCE_TITLE} · ${HORIZON_LABELS[selected]}`}</h4>
        {casesBlock(analysis, history, view, selected)}
        {outlookBlock(history, view, selected)}
        {basisBlock(analysis, history, view, selected)}
      </div>
      <p className="history-disclaimer">{HISTORY_DISCLAIMER}</p>
    </>;
  } catch {
    // A fault in this supplementary section must never take the current-news evidence down with it.
    return <p className="history-failure">{HISTORY_UNAVAILABLE_MESSAGE}</p>;
  }
}

function card(item: HorizonView, selected: boolean, onSelect: () => void): JSX.Element {
  // Spaces between the spans keep the button's accessible name readable without styles.
  return <button key={item.horizon} type="button" className={`history-card${selected ? ' selected' : ''}`} aria-pressed={selected}
    aria-controls={EVIDENCE_ID} onClick={onSelect}>
    <span className="history-card-title">{item.title}</span>{' '}
    <span className="history-card-badges">
      <span className={`history-signal history-signal-${item.integrated.signal}`}>{item.signalLabel}</span>{' '}
      <span className="history-validation">{item.validationLabel}</span>
    </span>{' '}
    <span className="history-card-line">{item.newsLine}</span>{' '}
    <span className="history-card-line">{item.pastLine}</span>
  </button>;
}

function caseMessage(history: ReadyCompanyHistory, view: HistoryView, horizon: Horizon): string | null {
  if (!view.statsPublic) return STATS_NOT_PUBLIC_MESSAGE;
  if (history.status === 'no_history') return NO_HISTORY_MESSAGE;
  if (history.status === 'identity_unverified') return IDENTITY_UNVERIFIED_MESSAGE;
  if (history.status === 'price_unavailable') return PRICE_UNAVAILABLE_MESSAGE;
  if (view.statsAge === 'expired') return EXPIRED_STATS_MESSAGE;
  // A ready answer always carries both directions; one without them has no cases to show.
  return history.horizons[horizon].directions === null ? NO_HISTORY_MESSAGE : null;
}

/** ② Past cases of the same company after news of the same direction. */
function casesBlock(analysis: NewsAnalysis, history: ReadyCompanyHistory, view: HistoryView, horizon: Horizon): JSX.Element {
  const { directions } = history.horizons[horizon];
  const message = caseMessage(history, view, horizon);
  const baseline = view[horizon].baseline;
  const shown: ReadonlyArray<'positive' | 'negative'> = baseline === 'withheld' ? ['positive', 'negative'] : [baseline];
  return <div>
    <h5>{CASES_SECTION_TITLE}</h5>
    {message !== null || directions === null ? <p>{message}</p> : <>
      {shown.map(direction => {
        const stats = directions[direction];
        const topics: NewsTopicKey[] = analysis.factorSummary?.[direction].lines.map(line => line.topic) ?? [];
        return <div key={direction}>
          <h6>{CASE_DIRECTION_TITLES[direction]}</h6>
          {caseStatsLines(stats.all).map((line, index) => <p key={`all-${index}`}>{line}</p>)}
          {topicCaseLines(stats, topics).map((line, index) => <p key={`topic-${index}`}>{line}</p>)}
          {stats.examples.length > 0 && <details className="history-cases">
            <summary>{caseListSummary(stats.examples.length)}</summary>
            <ul className="history-case-list">{stats.examples.map((ref, index) => <li key={index}>
              <a href={ref.url} target="_blank" rel="noopener noreferrer">{ref.title ?? '기사 보기'}</a> <span>{caseRefLine(ref)}</span>
            </li>)}</ul>
          </details>}
        </div>;
      })}
      <p>{CASE_WINDOW_NOTES[horizon]}</p>
      <p>{CASE_BASIS_NOTE}</p>
    </>}
  </div>;
}

/** ③ The baseline, lowered (never raised) by the past verdict, with its numbers and target. */
function outlookBlock(history: ReadyCompanyHistory, view: HistoryView, horizon: Horizon): JSX.Element {
  const item = view[horizon];
  const raw = history.horizons[horizon];
  const { direction } = item;
  return <div>
    <h5>{outlookSectionTitle(horizon)}</h5>
    <span className="history-validation">{item.validationLabel}</span>
    <p>{outlookSummaryLine(item, view.statsPublic)}</p>
    {item.changeLine !== null && <p>{item.changeLine}</p>}
    <p>{view.statsPublic ? item.integrationLine : STATS_NOT_PUBLIC_MESSAGE}</p>
    {item.verdict === 'insufficient' && direction !== null && direction.reason !== undefined && <p>{insufficientReasonLine(direction.reason)}</p>}
    {direction !== null && direction.sample !== null && <p>{sampleLine(direction.sample)}</p>}
    {view.statsPublic && raw.directions !== null && (!raw.sampleOrigin || raw.sampleOrigin.includesBackfill) && <p>{BACKFILL_SAMPLE_NOTE}</p>}
    {view.partialNews && <p>{PARTIAL_NEWS_NOTE}</p>}
    <p>{targetLine(horizon, raw.targetWindow)}</p>
    {horizon === 'day' && raw.newsWindow && <p>{`${NEWS_WINDOW_LABEL}: ${formatTime(raw.newsWindow.start)} ~ ${formatTime(raw.newsWindow.end)}`}</p>}
    {horizon === 'day' && view.day.overnight && <p>{overnightEvidenceLine(view.day.overnight)}</p>}
  </div>;
}

/** ④ Definitions, times and sources. A market without permission shows none of its numbers. */
function basisBlock(analysis: NewsAnalysis, history: ReadyCompanyHistory, view: HistoryView, horizon: Horizon): JSX.Element {
  const { coverage, dataAsOf, sources } = history;
  return <div>
    <h5>{BASIS_SECTION_TITLE}</h5>
    <p>{RESULT_DEFINITIONS[horizon]}</p>
    <p>{`기사 기준 ${formatTime(analysis.asOf)}`}</p>
    {!view.statsPublic ? <p>{STATS_NOT_PUBLIC_MESSAGE}</p> : <>
      <p>{`가격 기준일 ${dataAsOf.lastPriceDate ?? '없음'}`}</p>
      <p>{`통계 계산 ${formatTime(dataAsOf.computedAt)}${view.statsAge === 'fresh' ? '' : ` · ${STALE_STATS_LABEL}`}`}</p>
      {dataAsOf.ledgerFrom !== null && dataAsOf.ledgerTo !== null &&
        <p>{`기사 기록 기간 ${dataAsOf.ledgerFrom.slice(0, 10)} ~ ${dataAsOf.ledgerTo.slice(0, 10)}`}</p>}
      <p>{coverageLine(coverage)}</p>
      {excludedLines(coverage.excluded).map((line, index) => <p key={index}>{line}</p>)}
      <p>{sourcesLine(sources)}</p>
      {sources.news.some(name => /marketaux/i.test(name)) && <p>{MARKETAUX_TOP_NOTE}</p>}
      {sources.news.some(name => /gdelt/i.test(name)) &&
        <p><a href={GDELT_URL} target="_blank" rel="noopener noreferrer">{GDELT_CREDIT}</a></p>}
    </>}
  </div>;
}
