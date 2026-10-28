import {
  isGoalAiAvailability, isGoalClarification, GOAL_CLARIFY_MAX_LENGTH, GOAL_CLARIFY_PROMPT_VERSION,
  type GoalAiAvailability, type GoalClarification,
} from '@moneycast/core';
import { API_URL } from './news-cache';

export const GOAL_AI_OFF: GoalAiAvailability = { enabled: false, providers: [], promptVersion: GOAL_CLARIFY_PROMPT_VERSION, maxLength: GOAL_CLARIFY_MAX_LENGTH };

/** Without a server address or on any failure the AI reading is simply not offered. */
export async function loadGoalAiAvailability(): Promise<GoalAiAvailability> {
  if (!API_URL) return GOAL_AI_OFF;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${API_URL}/api/goals/clarify`, { signal: controller.signal });
    const value: unknown = response.ok ? await response.json() : null;
    return isGoalAiAvailability(value) ? value : GOAL_AI_OFF;
  } catch {
    return GOAL_AI_OFF;
  } finally {
    clearTimeout(timer);
  }
}

/** Sends the description only; the answer is checked against it again before anything is shown. */
export async function clarifyGoalText(text: string): Promise<GoalClarification> {
  const failed = (status: GoalClarification['status']): GoalClarification => ({ status, promptVersion: GOAL_CLARIFY_PROMPT_VERSION });
  if (!API_URL) return failed('not_configured');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(`${API_URL}/api/goals/clarify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal: controller.signal,
    });
    const value: unknown = await response.json().catch(() => null);
    return isGoalClarification(value, text, new Date()) ? value : failed('error');
  } catch {
    return failed(controller.signal.aborted ? 'timeout' : 'error');
  } finally {
    clearTimeout(timer);
  }
}
