import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as core from './index.ts';
import type { NewsAnalysis } from './index.ts';
import {
  ASK_ANSWER_NOTE, ASK_BODY_LIMIT_BYTES, ASK_EMPTY_TEXT, ASK_EVIDENCE_MAX, ASK_EVIDENCE_TITLE, ASK_INPUT_LABEL, ASK_INVALID_REASONS, ASK_LABEL,
  ASK_LIMITS_MAX, ASK_LOADING_TEXT, ASK_MEMORY_NOTE, ASK_PERSONAL_DATA_TEXT, ASK_PLACEHOLDER, ASK_QUESTION_MAX_LENGTH, ASK_RATE_LIMITED_TEXTS,
  ASK_RAW_TEXT_MAX_LENGTH, ASK_REFUSAL_LEAD, ASK_REFUSAL_REASONS, ASK_REFUSAL_TEXTS, ASK_SUBMIT_LABEL, ASK_SUGGESTIONS_LABEL, ASK_TEMPLATE_LABEL,
  ASK_TEMPLATE_NOTE, ASK_TERM_IDS, ASK_TERMS, ASK_TEXT_MAX_LENGTH, ASK_TITLE, ASK_TOO_LONG_TEXT, ASK_UNAVAILABLE_REASONS, ASK_UNAVAILABLE_TEXT,
  NEWS_ASK_VERSION,
  askEvidenceMeta, askHasPersonalData, askIntro, askInvalidText, askNewsTimeLine, askPrivacyLine, askSuggestions, parseAskAnswer, parseAskAvailability,
  parseAskEvidence,
  type AskAnswer, type AskEvidence,
} from './news-ask.ts';

const COMPANY_ID = 'krx:005930';
const ARTICLE: AskEvidence = { title: '삼성전자, 3분기 실적 발표', source: '연합뉴스', url: 'https://news.example/a1', publishedAt: '2026-11-27T00:30:00.000Z' };
const CASE: AskEvidence = { title: 'Example case', source: 'Example News', url: 'https://example.com/case', publishedAt: '2026-10-01' };
const ANSWERED: AskAnswer = {
  version: NEWS_ASK_VERSION, status: 'answered', companyId: COMPANY_ID, by: 'ai', text: '관련 기사는 4건이고 근거 수준은 보통입니다.',
  evidence: [ARTICLE, CASE], limits: [ASK_ANSWER_NOTE, '뉴스 기준 11/27(금) 09:30 KST'], asOf: '2026-11-27T00:30:00.000Z',
};

/** The wording rules for fixed text: no promise, hit rate, accuracy or arrow, and no recommendation to buy or sell. */
const WORDING = /확정|보장|반드시|적중|승률|정확도|[↑↓→←⇧⇩▲▼⇒⟶➔➜]|사세요|파세요|매수하|매도하|(매수|매도|종목)\s*추천|추천\s*종목/;
/** ASK_EXTRA_FORBIDDEN in server/news-ask.ts, copied so the dictionary can never carry what the model may not write. */
const ASK_EXTRA_FORBIDDEN = /기대|승률|적중|유망|보장|확정|반드시|정확도|틀림없|[↑↓→←⇧⇩▲▼]|%|퍼센트/;

function analysis(overrides: Partial<NewsAnalysis> = {}): Pick<NewsAnalysis, 'status' | 'positiveFactors' | 'negativeFactors' | 'historyAvailable'> {
  return { status: 'ready', positiveFactors: [], negativeFactors: [], ...overrides };
}

test('the limits and the version are the plan values (A-16)', () => {
  assert.equal(NEWS_ASK_VERSION, 'news-ask-v1');
  assert.deepEqual([ASK_QUESTION_MAX_LENGTH, ASK_BODY_LIMIT_BYTES, ASK_RAW_TEXT_MAX_LENGTH, ASK_TEXT_MAX_LENGTH, ASK_EVIDENCE_MAX, ASK_LIMITS_MAX],
    [300, 4096, 300, 800, 3, 5]);
  // The core entry re-exports the contract, and NewsAnalysis gains the hint without changing its validator.
  assert.equal(core.parseAskAnswer, parseAskAnswer);
  assert.equal(core.ASK_TERMS, ASK_TERMS);
  const valid: NewsAnalysis = {
    company: core.COMPANIES[0]!, status: 'ready', articles: [], asOf: '2026-11-27T00:30:00.000Z', period: { start: '2026-11-30', end: '2026-12-04' },
    evidence: 'low', summary: '요약', positiveFactors: [], negativeFactors: [], risks: [], provider: 'Marketaux', analysisVersion: 'test',
  };
  assert.equal(core.isNewsAnalysis(valid), true);
  assert.equal(core.isNewsAnalysis({ ...valid, askAvailable: true }), true);
});

test('parseAskAnswer accepts each status and rebuilds it, dropping unknown keys at every level', () => {
  const answers: AskAnswer[] = [
    ANSWERED,
    { ...ANSWERED, by: 'template', evidence: [], limits: [ASK_TEMPLATE_NOTE] },
    { version: NEWS_ASK_VERSION, status: 'refused', companyId: COMPANY_ID, reason: 'unlisted_company' },
    { version: NEWS_ASK_VERSION, status: 'invalid_input', reason: 'personal_data' },
    { version: NEWS_ASK_VERSION, status: 'rate_limited', scope: 'ip', retryAt: '2026-11-27T08:45:00.000Z' },
    { version: NEWS_ASK_VERSION, status: 'rate_limited', scope: 'daily' },
    { version: NEWS_ASK_VERSION, status: 'not_configured' },
    { version: NEWS_ASK_VERSION, status: 'unavailable', reason: 'model_limit' },
  ];
  for (const answer of answers) {
    const extra = answer.status === 'answered'
      ? { ...answer, debug: 'x', evidence: answer.evidence.map(item => ({ ...item, raw: 'y' })), message: '모델 문장' }
      : { ...answer, debug: 'x', message: '모델 문장' };
    assert.deepEqual(parseAskAnswer(extra, COMPANY_ID), answer, answer.status);
  }
  for (const reason of ASK_REFUSAL_REASONS) assert.ok(parseAskAnswer({ version: NEWS_ASK_VERSION, status: 'refused', companyId: COMPANY_ID, reason }, COMPANY_ID));
  for (const reason of ASK_INVALID_REASONS) assert.ok(parseAskAnswer({ version: NEWS_ASK_VERSION, status: 'invalid_input', reason }, COMPANY_ID));
  for (const reason of ASK_UNAVAILABLE_REASONS) assert.ok(parseAskAnswer({ version: NEWS_ASK_VERSION, status: 'unavailable', reason }, COMPANY_ID));
  // Exactly the limits: three links, five limit lines, 800 characters.
  const full = { ...ANSWERED, evidence: [ARTICLE, CASE, ARTICLE], limits: ['a', 'b', 'c', 'd', 'e'], text: '가'.repeat(800) };
  assert.deepEqual(parseAskAnswer(full, COMPANY_ID), full);
});

test('parseAskAnswer rejects a wrong version, another company, unsafe links, too many links, long text and bad codes', () => {
  const rejected: Array<[string, unknown, string?]> = [
    ['not an object', null], ['an array', [ANSWERED]], ['text', 'answered'],
    ['wrong version', { ...ANSWERED, version: 'news-ask-v0' }],
    ['unknown status', { ...ANSWERED, status: 'done' }],
    ['wrong company', ANSWERED, 'krx:000660'],
    ['refusal for another company', { version: NEWS_ASK_VERSION, status: 'refused', companyId: 'krx:000660', reason: 'advice' }],
    ['http link', { ...ANSWERED, evidence: [{ ...ARTICLE, url: 'http://news.example/a1' }] }],
    ['credentialed link', { ...ANSWERED, evidence: [{ ...ARTICLE, url: 'https://user:secret@news.example/a1' }] }],
    ['javascript link', { ...ANSWERED, evidence: [{ ...ARTICLE, url: 'javascript:alert(1)' }] }],
    ['link too long', { ...ANSWERED, evidence: [{ ...ARTICLE, url: `https://news.example/${'a'.repeat(2000)}` }] }],
    ['four links', { ...ANSWERED, evidence: [ARTICLE, CASE, ARTICLE, CASE] }],
    ['link without title', { ...ANSWERED, evidence: [{ ...ARTICLE, title: ' ' }] }],
    ['title too long', { ...ANSWERED, evidence: [{ ...ARTICLE, title: 'x'.repeat(301) }] }],
    ['source too long', { ...ANSWERED, evidence: [{ ...ARTICLE, source: 'x'.repeat(101) }] }],
    ['date that is no date', { ...ANSWERED, evidence: [{ ...ARTICLE, publishedAt: '2026-02-30' }] }],
    ['time without zone', { ...ANSWERED, evidence: [{ ...ARTICLE, publishedAt: '2026-11-27T00:30:00' }] }],
    ['text over 800', { ...ANSWERED, text: '가'.repeat(801) }],
    ['empty text', { ...ANSWERED, text: '   ' }],
    ['missing limits', { ...ANSWERED, limits: undefined }],
    ['no limit line', { ...ANSWERED, limits: [] }],
    ['six limit lines', { ...ANSWERED, limits: ['a', 'b', 'c', 'd', 'e', 'f'] }],
    ['empty limit line', { ...ANSWERED, limits: [''] }],
    ['unknown author', { ...ANSWERED, by: 'model' }],
    ['asOf without zone', { ...ANSWERED, asOf: '2026-11-27T00:30:00' }],
    ['bad refusal', { version: NEWS_ASK_VERSION, status: 'refused', companyId: COMPANY_ID, reason: 'other' }],
    ['bad invalid reason', { version: NEWS_ASK_VERSION, status: 'invalid_input', reason: 'nope' }],
    ['bad unavailable reason', { version: NEWS_ASK_VERSION, status: 'unavailable', reason: 'quota' }],
    ['bad scope', { version: NEWS_ASK_VERSION, status: 'rate_limited', scope: 'user' }],
    ['bad retryAt', { version: NEWS_ASK_VERSION, status: 'rate_limited', scope: 'ip', retryAt: 'soon' }],
  ];
  for (const [name, value, companyId] of rejected) assert.equal(parseAskAnswer(value, companyId ?? COMPANY_ID), null, name);
  assert.equal(parseAskEvidence({ ...ARTICLE, url: 'https://news.example/a1', extra: 1 })?.url, ARTICLE.url);
});

test('parseAskAvailability rebuilds an on or off value and refuses an enabled one without a provider', () => {
  const on = { version: NEWS_ASK_VERSION, enabled: true, providers: [{ id: 'gemini', label: 'Google Gemini', model: 'm' }], maxLength: 300, key: 'x' };
  assert.deepEqual(parseAskAvailability(on), { version: NEWS_ASK_VERSION, enabled: true, providers: [{ id: 'gemini', label: 'Google Gemini' }], maxLength: 300 });
  const off = { version: NEWS_ASK_VERSION, enabled: false, providers: [], maxLength: 300 };
  assert.deepEqual(parseAskAvailability(off), off);
  const rejected: unknown[] = [
    null, [], 'on', { ...off, version: 'news-ask-v0' }, { ...off, enabled: 'false' }, { ...on, providers: [] },
    { ...on, providers: [on.providers[0], on.providers[0], on.providers[0]] }, { ...on, providers: [{ id: 'cloudflare', label: 'Cloudflare' }] },
    { ...on, providers: [{ id: 'gemini', label: 'x'.repeat(41) }] }, { ...on, providers: [{ id: 'gemini', label: '' }] }, { ...on, providers: 'gemini' },
    { ...off, maxLength: 0 }, { ...off, maxLength: 2.5 }, { ...off, maxLength: '300' }, { ...off, maxLength: undefined },
  ];
  for (const value of rejected) assert.equal(parseAskAvailability(value), null, JSON.stringify(value));
});

test('the fixed screen texts are the plan wording', () => {
  assert.equal(ASK_TITLE, 'AI에게 물어보기');
  assert.equal(ASK_LABEL, 'AI 답변 · 수치는 코드 계산');
  assert.equal(ASK_TEMPLATE_LABEL, '정해진 문장 · 수치는 코드 계산');
  assert.equal(askIntro('삼성전자'), '삼성전자의 뉴스, 과거 사례, 전망의 근거, 용어를 화면의 자료로 설명합니다. 사거나 팔지는 답하지 않습니다.');
  assert.equal(askPrivacyLine([{ id: 'gemini', label: 'Google Gemini' }]), '질문은 AI 제공사(Google)로 전송됩니다. 개인정보를 적지 마세요.');
  assert.equal(askPrivacyLine([{ id: 'gemini', label: 'Google Gemini' }, { id: 'gemini', label: 'Gemini' }]), '질문은 AI 제공사(Google)로 전송됩니다. 개인정보를 적지 마세요.');
  assert.equal(askPrivacyLine([]), '질문은 AI 제공사로 전송됩니다. 개인정보를 적지 마세요.');
  assert.equal(ASK_UNAVAILABLE_TEXT, '지금은 질문 기능을 쓸 수 없습니다');
  assert.equal(ASK_ANSWER_NOTE, 'AI가 화면의 자료로 쓴 설명이며 틀릴 수 있습니다. 매수·매도 권유가 아닙니다.');
  assert.equal(ASK_TEMPLATE_NOTE, 'AI 답을 쓰지 않고 화면의 자료로 만든 정해진 문장입니다. 매수·매도 권유가 아닙니다.');
  assert.equal(ASK_REFUSAL_TEXTS.advice, '사거나 팔지, 언제 얼마나 투자할지는 답하지 않습니다. 이 기능은 화면에 있는 뉴스와 과거 사례, 전망의 근거를 설명합니다.');
  assert.deepEqual(Object.keys(ASK_REFUSAL_TEXTS), [...ASK_REFUSAL_REASONS]);
  assert.deepEqual(Object.keys(ASK_RATE_LIMITED_TEXTS), ['ip', 'daily']);
});

test('invalid input codes map to the fixed texts; a request the client should never send reads as unavailable', () => {
  assert.deepEqual(ASK_INVALID_REASONS.map(askInvalidText), [
    ASK_EMPTY_TEXT, ASK_TOO_LONG_TEXT, ASK_PERSONAL_DATA_TEXT, ASK_TOO_LONG_TEXT, ASK_UNAVAILABLE_TEXT, ASK_UNAVAILABLE_TEXT,
  ]);
  assert.equal(ASK_TOO_LONG_TEXT, '질문은 300자 이내로 적어 주세요.');
});

test('times are Korean wall-clock time: an article by its instant, a past case by its date', () => {
  assert.equal(askNewsTimeLine('2026-11-27T00:30:00.000Z', 2026), '뉴스 기준 11/27(금) 09:30 KST');
  assert.equal(askNewsTimeLine('2026-11-27T00:30:00.000Z', 2025), '뉴스 기준 2026/11/27(금) 09:30 KST');
  assert.equal(askEvidenceMeta(ARTICLE, 2026), '연합뉴스 · 11/27(금) 09:30 KST');
  assert.equal(askEvidenceMeta(CASE, 2026), 'Example News · 10/1(목)');
});

test('four distinct suggested questions for each situation', () => {
  const situations: Array<[string, ReturnType<typeof analysis>, string, string]> = [
    ['withheld, no history', analysis({ positiveFactors: ['a'], negativeFactors: ['b'] }), '왜 판단 유보인가요?', '최근 기사는 주로 어떤 내용인가요?'],
    ['insufficient with history', analysis({ status: 'insufficient', historyAvailable: true }), '왜 판단 유보인가요?', '과거 비슷한 뉴스 뒤에는 어땠나요?'],
    ['directional, no history', analysis({ positiveFactors: ['a'] }), '이 판단은 어떤 기사에서 나왔나요?', '최근 기사는 주로 어떤 내용인가요?'],
    ['directional with history', analysis({ negativeFactors: ['b'], historyAvailable: true }), '이 판단은 어떤 기사에서 나왔나요?', '과거 비슷한 뉴스 뒤에는 어땠나요?'],
  ];
  for (const [name, value, first, second] of situations) {
    const suggestions = askSuggestions(value);
    assert.equal(suggestions.length, 4, name);
    assert.equal(new Set(suggestions).size, 4, name);
    assert.deepEqual(suggestions.slice(0, 2), [first, second], name);
    assert.equal(suggestions[2], value.historyAvailable ? "'시장 대비'가 무슨 뜻인가요?" : "'근거 수준'은 무슨 뜻인가요?", name);
    assert.equal(suggestions[3], '이 자료는 언제 기준이고 어떤 한계가 있나요?', name);
  }
});

test('the term dictionary: unique ids in order, no digit and nothing the model may not write', () => {
  assert.deepEqual(Object.keys(ASK_TERMS), [...ASK_TERM_IDS]);
  assert.equal(new Set(ASK_TERM_IDS).size, ASK_TERM_IDS.length);
  assert.equal(ASK_TERM_IDS.length, 26);
  assert.equal(new Set(Object.values(ASK_TERMS).map(entry => entry.label)).size, ASK_TERM_IDS.length);
  for (const id of ASK_TERM_IDS) {
    const { label, text } = ASK_TERMS[id];
    for (const value of [label, text]) {
      assert.ok(value.trim().length > 0, id);
      assert.doesNotMatch(value, /\p{Nd}/u, id);
      assert.doesNotMatch(value, ASK_EXTRA_FORBIDDEN, id);
    }
  }
  assert.deepEqual(ASK_TERMS.past_up_share, { label: '과거 상승 비중(미래 확률 아님)', text: '과거 사례 가운데 오른 사례의 비중입니다. 앞으로 오를지를 뜻하지 않습니다.' });
  assert.ok(Object.isFrozen(ASK_TERMS) && Object.isFrozen(ASK_TERMS.median));
});

test('every fixed text follows the wording rules', () => {
  const texts = [
    ASK_TITLE, ASK_LABEL, ASK_TEMPLATE_LABEL, askIntro('삼성전자'), ASK_INPUT_LABEL, ASK_PLACEHOLDER, ASK_SUBMIT_LABEL, ASK_SUGGESTIONS_LABEL,
    ASK_REFUSAL_LEAD, ASK_EVIDENCE_TITLE, ASK_MEMORY_NOTE, ASK_LOADING_TEXT, ASK_UNAVAILABLE_TEXT, ASK_EMPTY_TEXT, ASK_TOO_LONG_TEXT,
    ASK_PERSONAL_DATA_TEXT, ...Object.values(ASK_RATE_LIMITED_TEXTS), ...Object.values(ASK_REFUSAL_TEXTS), ASK_ANSWER_NOTE, ASK_TEMPLATE_NOTE,
    askNewsTimeLine('2026-11-27T00:30:00.000Z', 2026), askPrivacyLine([{ id: 'gemini', label: 'Google Gemini' }]),
    ...ASK_INVALID_REASONS.map(askInvalidText), askEvidenceMeta(ARTICLE, 2026),
    ...askSuggestions(analysis()), ...askSuggestions(analysis({ positiveFactors: ['a'], historyAvailable: true })),
    ...Object.values(ASK_TERMS).flatMap(entry => [entry.label, entry.text]),
  ];
  for (const text of texts) {
    assert.doesNotMatch(text, WORDING, text);
    // A probability is named only to say it is not one.
    assert.doesNotMatch(text.split('미래 확률 아님').join(''), /확률/, text);
    // Buying and selling appear only in the notice that this is not a recommendation.
    if (/권유/.test(text)) assert.match(text, /매수·매도 권유가 아닙니다/, text);
  }
});

test('askHasPersonalData: phone and account numbers through dots, dashes, brackets and invisible characters; dates and figures pass', () => {
  const personal = [
    '010-1234-5678', '010.1234.5678', '010–1234–5678', '010\u200B1234\u200B5678', '(010)1234-5678', '010·1234·5678', '010/1234/5678',
    '02-123-4567', '02.123.4567', '900101-1234567', 'someone@example.com', '０１０-１２３４-５６７８',
  ];
  for (const text of personal) assert.equal(askHasPersonalData(text), true, text);
  // hasPersonalData misses the dotted, dashed and nine-digit forms; askHasPersonalData is its superset.
  assert.equal(core.hasPersonalData('010.1234.5678'), false);
  for (const text of personal) if (core.hasPersonalData(text)) assert.equal(askHasPersonalData(text), true, text);
  for (const text of ['2026.11.27 기사', '3.5% 오른 날', '11/27(금) 18:30 기사', '1,234,567원', '0.5%', '삼성전자 3분기 실적', '왜 판단 유보인가요?']) {
    assert.equal(askHasPersonalData(text), false, text);
  }
});
