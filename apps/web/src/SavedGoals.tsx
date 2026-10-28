import { useState } from 'react';
import {
  createSavedGoal, describeSavedGoal, formatCompactKRW, formatDurationMonths, parseGoalNumber, parseSavedGoals, serializeSavedGoals,
  SAVED_GOAL_LIMIT, SAVED_GOALS_KEY, type SavedCalculatorFields, type SavedGoal,
} from '@moneycast/core';
import type { GoalPlannerControls } from './GoalPlanner';

/** null when this browser does not allow storage, so saving is not offered. */
function readSavedGoals(): SavedGoal[] | null {
  try { return parseSavedGoals(window.localStorage.getItem(SAVED_GOALS_KEY)); }
  catch { return null; }
}

function writeSavedGoals(goals: readonly SavedGoal[]): boolean {
  try {
    if (goals.length) window.localStorage.setItem(SAVED_GOALS_KEY, serializeSavedGoals(goals));
    else window.localStorage.removeItem(SAVED_GOALS_KEY);
    return true;
  } catch { return false; }
}

const newId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

function savedDetails(saved: SavedGoal): string {
  const months = parseGoalNumber(saved.calculator.months);
  const monthly = parseGoalNumber(saved.calculator.monthly);
  const savedAt = new Date(saved.savedAt).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' });
  return [
    months !== null && Number.isInteger(months) && months >= 1 ? `기간 ${formatDurationMonths(months)}` : '',
    monthly !== null && Number.isFinite(monthly) && monthly >= 0 ? `매월 ${formatCompactKRW(monthly)}` : '',
    saved.inflation.on && saved.inflation.rate.trim() ? `물가상승 연 ${saved.inflation.rate.trim()}% 가정` : '',
    `${savedAt} 저장`,
  ].filter(Boolean).join(' · ');
}

/**
 * Goals kept in this browser only when the person saves them; nothing is
 * sent anywhere, and the free goal's description is never kept.
 */
export function SavedGoals({ planner, calculator, onLoad }: {
  planner: GoalPlannerControls; calculator: SavedCalculatorFields; onLoad: (calculator: SavedCalculatorFields) => void;
}) {
  const [goals, setGoals] = useState(readSavedGoals);
  const [notice, setNotice] = useState('');
  const list = goals ?? [];
  const full = list.length >= SAVED_GOAL_LIMIT;
  const store = (next: SavedGoal[], message: string) => {
    if (writeSavedGoals(next)) {
      setGoals(next);
      setNotice(message);
    } else setNotice('이 브라우저에서는 저장할 수 없어요. 개인 정보 보호 모드나 사이트 데이터 설정을 확인해 주세요.');
  };
  const save = () => store([createSavedGoal(planner.state, calculator, newId(), new Date()), ...list], '현재 목표와 계산 조건을 저장했어요.');
  const load = (saved: SavedGoal) => {
    planner.load(saved);
    onLoad(saved.calculator);
    setNotice('저장한 목표를 불러왔어요.');
  };

  return <section className="saved-goals" aria-labelledby="saved-goals-title">
    <div className="saved-goals-head">
      <h3 id="saved-goals-title">저장한 목표 <span>{list.length}/{SAVED_GOAL_LIMIT}</span></h3>
      <button type="button" className="outline-button" disabled={goals === null || full} onClick={save}>현재 목표 저장</button>
    </div>
    <p className="field-hint">{goals === null ? '이 브라우저에서는 목표를 저장할 수 없어요.'
      : full ? `최대 ${SAVED_GOAL_LIMIT}개까지 저장할 수 있어요. 하나를 지운 뒤 저장해 주세요.`
        : '저장을 누를 때만 이 브라우저에 보관하고 서버로 보내지 않아요. 자유 목표 설명은 저장하지 않아요.'}</p>
    {list.length > 0 && <ul className="saved-goal-list">{list.map(saved => {
      const title = describeSavedGoal(saved, formatCompactKRW);
      return <li key={saved.id}>
        <div><strong>{title}</strong><span>{savedDetails(saved)}</span></div>
        <div className="saved-goal-actions">
          <button type="button" aria-label={`${title} 불러오기`} onClick={() => load(saved)}>불러오기</button>
          <button type="button" aria-label={`${title} 삭제`} onClick={() => store(list.filter(goal => goal.id !== saved.id), '저장한 목표를 지웠어요.')}>삭제</button>
        </div>
      </li>;
    })}</ul>}
    <p className="saved-goals-notice" aria-live="polite">{notice}</p>
  </section>;
}
