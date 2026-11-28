import { useEffect, useRef, useState, type JSX, type KeyboardEvent, type MouseEvent } from 'react';
import {
  ASK_EMPTY_TEXT, ASK_EVIDENCE_TITLE, ASK_INPUT_LABEL, ASK_LABEL, ASK_LOADING_TEXT, ASK_MEMORY_NOTE, ASK_PERSONAL_DATA_TEXT,
  ASK_PLACEHOLDER, ASK_QUESTION_MAX_LENGTH, ASK_RATE_LIMITED_TEXTS, ASK_REFUSAL_LEAD, ASK_REFUSAL_TEXTS, ASK_SUBMIT_LABEL,
  ASK_SUGGESTIONS_LABEL, ASK_TEMPLATE_LABEL, ASK_TITLE, ASK_TOO_LONG_TEXT, ASK_UNAVAILABLE_TEXT, NEWS_ASK_VERSION,
  askEvidenceMeta, askIntro, askInvalidText, askPrivacyLine, askSuggestions, askHasPersonalData, parseAskAnswer, parseAskAvailability,
  type AskAnswer, type AskAvailability, type NewsAnalysis,
} from '@moneycast/core';

/** A slow availability answer must never hold the screen: past this the panel stays off for the page. */
export const ASK_AVAILABILITY_TIMEOUT_MS = 5_000;
/** The server gives one question at most 20 s of model time; this leaves room for the network around it. */
export const ASK_REQUEST_TIMEOUT_MS = 25_000;
/** Turns kept on screen; the oldest goes first. */
export const ASK_THREAD_MAX = 10;

const ENDPOINT = '/api/news/ask';
/** KST is UTC + 9 h all year (no daylight saving time), as formatKstTime assumes. */
const KST_OFFSET_MS = 9 * 3_600_000;
/** keyCode of the Enter that ends an IME composition in Safari, which already reports isComposing as false. */
const IME_KEY_CODE = 229;

function askOff(): AskAvailability {
  return { version: NEWS_ASK_VERSION, enabled: false, providers: [], maxLength: ASK_QUESTION_MAX_LENGTH };
}

function unavailable(reason: 'error' | 'timeout'): AskAnswer {
  return { version: NEWS_ASK_VERSION, status: 'unavailable', reason };
}

/** AbortSignal.timeout rejects with a TimeoutError (older engines say AbortError); nothing else aborts these requests. */
function isTimeout(error: unknown): boolean {
  const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined;
  return name === 'TimeoutError' || name === 'AbortError';
}

/**
 * Whether a suggestion moves focus to the question box: yes when it was pressed with Enter or Space (no click count,
 * detail 0) or clicked with a mouse, because the button stays disabled until the answer arrives. A touch or pen tap,
 * or a pointer the browser does not name, leaves focus where it is: on a phone, focusing the box would open the
 * on-screen keyboard over the answer that is about to appear.
 */
function suggestionFocusesBox(event: MouseEvent<HTMLButtonElement>): boolean {
  return event.detail === 0 || (event.nativeEvent as { pointerType?: unknown }).pointerType === 'mouse';
}

// Module state rather than component state: availability is asked once per page, and a panel
// remounted for another company reads the settled answer without asking again.
let availabilityRequest: Promise<AskAvailability> | null = null;
let availabilityValue: AskAvailability | null = null;
let generation = 0;

/** Tests only: forgets the availability answer and any request in flight. */
export function resetAskPanelCache(): void {
  availabilityRequest = null;
  availabilityValue = null;
  generation += 1;
}

/** Whether questions can be asked. Any failure counts as off, and stays off until the page is loaded again. */
export function loadAskAvailability(): Promise<AskAvailability> {
  if (availabilityRequest) return availabilityRequest;
  const round = generation;
  const request = (async (): Promise<AskAvailability> => {
    let value: AskAvailability;
    try {
      const response = await fetch(ENDPOINT, { signal: AbortSignal.timeout(ASK_AVAILABILITY_TIMEOUT_MS) });
      value = response.ok ? (parseAskAvailability(await response.json()) ?? askOff()) : askOff();
    } catch {
      value = askOff();
    }
    if (round === generation) availabilityValue = value;
    return value;
  })();
  availabilityRequest = request;
  return request;
}

/**
 * Sends the company and the question only, never earlier turns, so everyone asking the same question is answered
 * from the same data. Every reply carries an answer body whatever its HTTP status; a body that does not pass the
 * shared parser, a network error and a timeout all count as unavailable.
 */
export async function sendAskQuestion(companyId: string, question: string): Promise<AskAnswer> {
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyId, question }),
      signal: AbortSignal.timeout(ASK_REQUEST_TIMEOUT_MS),
    });
    return parseAskAnswer(await response.json(), companyId) ?? unavailable('error');
  } catch (error) {
    return unavailable(isTimeout(error) ? 'timeout' : 'error');
  }
}

interface Turn {
  id: number;
  question: string;
  /** null while the answer is on its way. */
  answer: AskAnswer | null;
}

type GroupName = { 'aria-label': string } | { 'aria-labelledby': string };

/**
 * Questions about the analysis on screen, below its card. Renders nothing until the server reports the feature on.
 * The conversation lives in this component only: nothing is stored, and picking another company remounts it empty.
 * A failure shows in its own turn and never touches the rest of the screen.
 */
export function AskPanel({ analysis }: { analysis: NewsAnalysis }): JSX.Element | null {
  const companyId = analysis.company.id;
  const [availability, setAvailability] = useState<AskAvailability | null>(() => availabilityValue);
  const [thread, setThread] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const mounted = useRef(true);
  const sending = useRef(false);
  const nextId = useRef(0);

  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    void loadAskAvailability().then(value => { if (!disposed) setAvailability(value); });
    return () => {
      disposed = true;
      mounted.current = false;
    };
  }, []);

  if (availability === null || !availability.enabled) return null;

  const loading = thread.some(turn => turn.answer === null);
  const suggestions = askSuggestions(analysis);
  const year = new Date(Date.now() + KST_OFFSET_MS).getUTCFullYear();

  /**
   * fromInput: the question is the box's text, and the box is emptied once it goes out. focusBox: focus moves to the
   * box, so a keyboard user is not left on a control that stays disabled until the answer arrives.
   */
  function send(text: string, fromInput: boolean, focusBox: boolean): void {
    if (sending.current) return;
    const question = text.trim();
    // The server's own input checks, so a question it would turn away never leaves this device.
    const problem = question === '' ? ASK_EMPTY_TEXT
      : question.length > ASK_QUESTION_MAX_LENGTH ? ASK_TOO_LONG_TEXT
        : askHasPersonalData(question) ? ASK_PERSONAL_DATA_TEXT : '';
    if (focusBox) input.current?.focus();
    if (problem) {
      // The text stays in the box for editing.
      setError(problem);
      return;
    }
    setError('');
    sending.current = true;
    const id = nextId.current;
    nextId.current += 1;
    setThread(current => [...current, { id, question, answer: null }].slice(-ASK_THREAD_MAX));
    // A suggestion leaves a question being typed in place.
    if (fromInput) setDraft('');
    void sendAskQuestion(companyId, question).then(answer => {
      sending.current = false;
      if (mounted.current) setThread(current => current.map(turn => turn.id === id ? { ...turn, answer } : turn));
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    // Enter sends and Shift+Enter starts a new line; the Enter that ends an IME (Korean) composition only ends it.
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === IME_KEY_CODE) return;
    event.preventDefault();
    send(draft, true, true);
  }

  function suggestionGroup(name: GroupName): JSX.Element {
    return <div className="ask-suggestions" role="group" {...name}>
      {suggestions.map(text => <button key={text} type="button" className="ask-suggestion" disabled={loading}
        onClick={event => send(text, false, suggestionFocusesBox(event))}>{text}</button>)}
    </div>;
  }

  function answerBlock(answer: AskAnswer, leadId: string): JSX.Element {
    switch (answer.status) {
      case 'answered':
        return <>
          <span className="ask-answer-label">{answer.by === 'ai' ? ASK_LABEL : ASK_TEMPLATE_LABEL}</span>
          <p className="ask-answer">{answer.text}</p>
          {answer.evidence.length > 0 && <div className="ask-evidence">
            <h3>{ASK_EVIDENCE_TITLE}</h3>
            <ul>{answer.evidence.map((item, index) => <li key={index}>
              <a href={item.url} target="_blank" rel="noopener noreferrer">{item.title}</a> <span>{askEvidenceMeta(item, year)}</span>
            </li>)}</ul>
          </div>}
          <ul className="ask-limits">{answer.limits.map((line, index) => <li key={index}>{line}</li>)}</ul>
        </>;
      case 'refused':
        return <>
          <p className="ask-state">{ASK_REFUSAL_TEXTS[answer.reason]}</p>
          <p className="ask-state" id={leadId}>{ASK_REFUSAL_LEAD}</p>
          {suggestionGroup({ 'aria-labelledby': leadId })}
        </>;
      case 'invalid_input':
        return <p className="ask-state">{askInvalidText(answer.reason)}</p>;
      case 'rate_limited':
        return <p className="ask-state">{ASK_RATE_LIMITED_TEXTS[answer.scope]}</p>;
      default:
        return <p className="ask-state">{ASK_UNAVAILABLE_TEXT}</p>;
    }
  }

  return <section className="card ask-card" aria-labelledby="ask-title">
    <h2 id="ask-title" className="ask-title">{ASK_TITLE}</h2>
    <p className="ask-intro">{askIntro(analysis.company.name)}</p>
    <ol className="ask-thread" aria-live="polite">
      {thread.map(turn => <li key={turn.id} className="ask-item" aria-busy={turn.answer === null ? true : undefined}>
        <p className="ask-question">{turn.question}</p>
        {turn.answer === null ? <p className="ask-state">{ASK_LOADING_TEXT}</p> : answerBlock(turn.answer, `ask-lead-${turn.id}`)}
      </li>)}
    </ol>
    {suggestionGroup({ 'aria-label': ASK_SUGGESTIONS_LABEL })}
    <form className="ask-form" onSubmit={event => { event.preventDefault(); send(draft, true, true); }}>
      <label htmlFor="ask-question">{ASK_INPUT_LABEL}</label>
      <textarea ref={input} id="ask-question" className="ask-input" value={draft} maxLength={ASK_QUESTION_MAX_LENGTH} rows={2}
        placeholder={ASK_PLACEHOLDER} enterKeyHint="send" aria-describedby="ask-privacy ask-count ask-error"
        aria-invalid={error ? true : undefined} onKeyDown={onKeyDown}
        onChange={event => { setDraft(event.target.value); setError(''); }}/>
      <span id="ask-count" className="ask-count">{`${draft.length}/${ASK_QUESTION_MAX_LENGTH}`}</span>
      <p id="ask-privacy" className="ask-privacy">{`${askPrivacyLine(availability.providers)} ${ASK_MEMORY_NOTE}`}</p>
      <p id="ask-error" className="ask-error" aria-live="polite">{error}</p>
      <button type="submit" className="ask-submit" disabled={draft.trim() === '' || loading}>{ASK_SUBMIT_LABEL}</button>
    </form>
  </section>;
}
