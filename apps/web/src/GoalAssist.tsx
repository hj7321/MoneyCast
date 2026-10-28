import { useState } from 'react';
import {
  analyzeGoalText, categoryGoalName, categoryGoalType, categoryLabel, describeSwitchPrefill, formatCompactKRW, formatDurationMonths,
  goalAiFailure, goalAiNotice, goalFactActions, goalFoundSource, goalQuestionText, goalSwitchActions, goalTypeName, livingCostActions,
  parseGoalNumber, planGoalQuestions, GOAL_PERSONAL_DATA_NOTICE,
  type GoalAiAvailability, type GoalAiProvider, type GoalCategory, type GoalQuestionId, type GoalTextFacts,
} from '@moneycast/core';
import { clarifyGoalText, GOAL_AI_OFF, loadGoalAiAvailability } from './goal-ai';
import type { GoalPlannerControls } from './GoalPlanner';
import { Icon } from './icons';

type FactKey = 'name' | 'amount' | 'items' | 'months';
interface Found {
  text: string;
  category: GoalCategory;
  title: string;
  facts: GoalTextFacts;
  personalData: boolean;
  provider?: GoalAiProvider;
}

const ALL_CHOSEN: Record<FactKey, boolean> = { name: true, amount: true, items: true, months: true };
const formatTime = (value: string) => `${new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} KST`;
const focusLater = (id: string) => window.setTimeout(() => document.getElementById(id)?.focus(), 0);
const positive = (text: string) => {
  const value = parseGoalNumber(text);
  return value !== null && Number.isFinite(value) && value > 0 ? value : null;
};
const wholeMonths = (text: string) => {
  const value = positive(text);
  return value !== null && Number.isInteger(value) && value <= 600 ? value : null;
};

function SmallNumber({ id, label, unit, value, onChange }: { id: string; label: string; unit: string; value: string; onChange: (text: string) => void }) {
  return <div className="field">
    <label htmlFor={id}>{label}</label>
    <div className="input-wrap"><input id={id} inputMode="numeric" autoComplete="off" value={value} onChange={event => onChange(event.target.value)}/><span>{unit}</span></div>
  </div>;
}

/**
 * Reads the free goal's description on this device first. Found facts are
 * only suggestions until ticked and applied; at most two fixed questions ask
 * for the rest, and the optional AI reading is offered only when rules fall short.
 */
export function GoalAssist({ planner, onPeriod }: { planner: GoalPlannerControls; onPeriod: (months: number) => void }) {
  const note = planner.drafts.free.note;
  const [found, setFound] = useState<Found | null>(null);
  const [chosen, setChosen] = useState(ALL_CHOSEN);
  const [answered, setAnswered] = useState<GoalQuestionId[]>([]);
  const [ai, setAi] = useState<GoalAiAvailability>(GOAL_AI_OFF);
  const [asking, setAsking] = useState(false);
  const [sent, setSent] = useState('');
  const [notice, setNotice] = useState('');
  const [living, setLiving] = useState({ monthly: '', months: '' });
  const [period, setPeriod] = useState('');

  const analyze = () => {
    const analysis = analyzeGoalText(note, new Date());
    setFound({ text: note, category: analysis.category, title: categoryGoalName(analysis.category), facts: analysis.facts, personalData: analysis.personalData });
    setChosen(ALL_CHOSEN);
    setAnswered([]);
    setNotice('');
    void loadGoalAiAvailability().then(setAi);
  };
  const askAi = async () => {
    const text = note;
    setAsking(true);
    setSent(text);
    setNotice('');
    const result = await clarifyGoalText(text);
    setAsking(false);
    if (result.status !== 'ok' || !result.category) {
      setNotice(goalAiFailure(result, formatTime));
      return;
    }
    const category = result.category;
    setFound(current => current && current.text === text ? {
      ...current, category, title: result.title ?? categoryGoalName(category), provider: result.provider, facts: { ...current.facts, ...result.facts },
    } : current);
    setChosen(ALL_CHOSEN);
    setAnswered([]);
  };

  const answer = (question: GoalQuestionId) => setAnswered(old => [...old, question]);
  const button = <button type="button" className="goal-assist-open goal-wide" disabled={!note.trim()} onClick={analyze}><Icon name="search" size={15}/>설명에서 정보 찾기</button>;
  if (!found) return button;

  const { facts, category } = found;
  const name = found.title && found.title !== planner.drafts.free.name.trim() ? found.title : '';
  const options: Array<{ key: FactKey; label: string }> = [
    ...(name ? [{ key: 'name' as const, label: `목표 이름: ${name}` }] : []),
    ...(facts.amount ? [{ key: 'amount' as const, label: `목표 금액: ${formatCompactKRW(facts.amount.value)} (“${facts.amount.text}”)` }] : []),
    ...(facts.items ? [{ key: 'items' as const, label: `항목: ${facts.items.map(item => `${item.label || '항목'} ${formatCompactKRW(item.value)}`).join(' · ')}` }] : []),
    ...(facts.months ? [{ key: 'months' as const, label: `목표 기간: ${formatDurationMonths(facts.months.value)} (“${facts.months.text}”)` }] : []),
  ];
  const picked = (key: FactKey) => chosen[key] && options.some(option => option.key === key);
  const apply = () => {
    planner.apply(goalFactActions({
      ...(picked('name') ? { name } : {}),
      ...(picked('amount') && facts.amount ? { amount: facts.amount.value } : {}),
      ...(picked('items') && facts.items ? { items: facts.items } : {}),
    }, planner.formatAmount));
    if (picked('months') && facts.months) onPeriod(facts.months.value);
    setNotice('선택한 정보를 적용했어요. 위아래 칸에서 언제든 고칠 수 있어요.');
    setAnswered(old => [...old, ...(picked('months') ? ['period' as const] : [])]);
  };
  const free = planner.drafts.free;
  const amountKnown = planner.override !== undefined || (free.method === 'items' && planner.resolution.source === 'details');
  const questions = planGoalQuestions(found, { amountKnown }).filter(question => !answered.includes(question));
  const type = categoryGoalType(category);
  const monthly = positive(living.monthly);
  const livingMonths = wholeMonths(living.months);
  const periodMonths = wholeMonths(period);
  const offerAi = ai.enabled && !found.provider && !found.personalData && note.trim() !== '' && note.length <= ai.maxLength &&
    (!facts.amount && !facts.items || category === 'other') && sent !== note;

  return <>
    {button}
    <section className="goal-assist goal-wide" aria-labelledby="goal-assist-title">
      <div className="goal-assist-head">
        <h4 id="goal-assist-title">설명에서 찾은 정보</h4>
        <button type="button" className="goal-assist-close" aria-label="찾은 정보 닫기" onClick={() => setFound(null)}><Icon name="close" size={14}/></button>
      </div>
      <p className="field-hint">{goalFoundSource(found.provider)} 분류: {categoryLabel(category)}</p>
      {found.text !== note && <p className="field-hint">설명이 바뀌었어요. 다시 찾으려면 ‘설명에서 정보 찾기’를 눌러 주세요.</p>}
      {!facts.amount && !facts.items && !facts.months && <p className="field-hint">설명에서 금액이나 기간을 찾지 못했어요.</p>}
      {options.length > 0 && <>
        <fieldset className="goal-assist-facts"><legend>적용할 정보</legend>
          {options.map(option => <label key={option.key} className="goal-check">
            <input type="checkbox" checked={chosen[option.key]} onChange={event => setChosen(old => ({ ...old, [option.key]: event.target.checked }))}/>{option.label}
          </label>)}
        </fieldset>
        <button type="button" className="goal-assist-apply" disabled={!options.some(option => chosen[option.key])} onClick={apply}>선택한 정보 적용</button>
      </>}
      {notice && <p className="goal-assist-notice">{notice}</p>}
      {found.personalData && <p className="goal-assist-notice">{GOAL_PERSONAL_DATA_NOTICE}</p>}
      {questions.map(question => <div key={question} className="goal-question">
        <p className="goal-question-text">{goalQuestionText(question, category)}</p>
        {question === 'amount' && <div className="goal-question-actions">
          <button type="button" onClick={() => { planner.setFreeMethod('direct'); answer('amount'); focusLater('target'); }}>금액 직접 입력</button>
          <button type="button" onClick={() => { planner.setFreeMethod('items'); answer('amount'); focusLater('goal-item-0-label'); }}>항목별로 나눠 보기</button>
          <button type="button" onClick={() => { planner.setFreeMethod('undecided'); answer('amount'); }}>아직 몰라요</button>
        </div>}
        {question === 'livingCost' && <div className="goal-question-fields">
          <SmallNumber id="goal-living-monthly" label="한 달 생활비" unit="원" value={living.monthly} onChange={value => setLiving(old => ({ ...old, monthly: value }))}/>
          <SmallNumber id="goal-living-months" label="몇 개월치" unit="개월" value={living.months} onChange={value => setLiving(old => ({ ...old, months: value }))}/>
          <button type="button" disabled={monthly === null || livingMonths === null}
            onClick={() => { planner.apply(livingCostActions(monthly!, livingMonths!, planner.formatAmount)); answer('livingCost'); }}>적용</button>
        </div>}
        {question === 'switchType' && type && <div className="goal-question-actions">
          {describeSwitchPrefill(category, facts) && <p className="field-hint">{describeSwitchPrefill(category, facts)}</p>}
          <button type="button" onClick={() => planner.apply(goalSwitchActions(category, facts, planner.formatAmount))}>‘{goalTypeName(type)}’ 목표로 바꾸기</button>
        </div>}
        {question === 'period' && <div className="goal-question-fields">
          <SmallNumber id="goal-period-months" label="모을 기간" unit="개월" value={period} onChange={setPeriod}/>
          <button type="button" disabled={periodMonths === null} onClick={() => { onPeriod(periodMonths!); answer('period'); }}>적용</button>
        </div>}
        <button type="button" className="goal-link" onClick={() => answer(question)}>건너뛰기</button>
      </div>)}
      {offerAi && <div className="goal-assist-ai">
        <p className="field-hint">{goalAiNotice(ai.providers)}</p>
        <button type="button" disabled={asking} onClick={() => void askAi()}>{asking ? 'AI가 정리하고 있어요…' : 'AI로 다시 정리하기'}</button>
      </div>}
    </section>
  </>;
}
