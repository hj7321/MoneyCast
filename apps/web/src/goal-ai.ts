import {
  isGoalAiAvailability, isGoalClarification, GOAL_CLARIFY_MAX_LENGTH, GOAL_CLARIFY_PROMPT_VERSION,
  type GoalAiAvailability, type GoalClarification,
} from '@moneycast/core';

export const GOAL_AI_OFF: GoalAiAvailability = { enabled: false, providers: [], promptVersion: GOAL_CLARIFY_PROMPT_VERSION, maxLength: GOAL_CLARIFY_MAX_LENGTH };

/** Any failure keeps the AI button hidden; the description rules work without the server. */
export async function loadGoalAiAvailability(): Promise<GoalAiAvailability> {
  try {
    const response = await fetch('/api/goals/clarify', { signal: AbortSignal.timeout(5_000) });
    const value: unknown = response.ok ? await response.json() : null;
    return isGoalAiAvailability(value) ? value : GOAL_AI_OFF;
  } catch {
    return GOAL_AI_OFF;
  }
}

/** Sends the description only; the answer is checked against it again before anything is shown. */
export async function clarifyGoalText(text: string): Promise<GoalClarification> {
  const failed = (status: GoalClarification['status']): GoalClarification => ({ status, promptVersion: GOAL_CLARIFY_PROMPT_VERSION });
  try {
    const response = await fetch('/api/goals/clarify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(12_000),
    });
    const value: unknown = await response.json().catch(() => null);
    return isGoalClarification(value, text, new Date()) ? value : failed('error');
  } catch (error) {
    return failed(error instanceof DOMException && error.name === 'TimeoutError' ? 'timeout' : 'error');
  }
}
