import type { Company, NewsAnalysis } from '../packages/core/src/index.js';

/**
 * No company starts after this, so the run ends inside the function's
 * 300-second maxDuration even when the last refresh waits on both models.
 */
export const COLLECT_BUDGET_MS = 200_000;

export interface CollectSummary {
  refreshed: string[];
  failed: string[];
  skipped: string[];
}

/**
 * Refreshes companies one at a time: sources rate-limit per process, and a run
 * that would exceed the budget leaves the rest to on-demand refreshes. Running
 * twice is harmless: each refresh only replaces that company's snapshot.
 */
export async function collectNews(
  service: { refresh(company: Company): Promise<NewsAnalysis> },
  targets: readonly Company[],
  clock: () => number = Date.now,
  budgetMs = COLLECT_BUDGET_MS,
): Promise<CollectSummary> {
  const started = clock();
  const summary: CollectSummary = { refreshed: [], failed: [], skipped: [] };
  for (const company of targets) {
    if (clock() - started >= budgetMs) { summary.skipped.push(company.id); continue; }
    try {
      const result = await service.refresh(company);
      const live = (result.status === 'ready' || result.status === 'insufficient') && result.servedFrom !== 'stale';
      (live ? summary.refreshed : summary.failed).push(company.id);
    } catch {
      summary.failed.push(company.id);
    }
  }
  return summary;
}
