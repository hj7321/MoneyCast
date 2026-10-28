import type { NewsArticle, NewsSourceState } from '../packages/core/src/index.js';
import { ProviderError, type NewsProvider, type NewsProviderResult } from './provider.js';

const TRACKING_PARAMETERS = /^(utm_.+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|cmpid|ocid|ref|ref_src|igshid|yclid|spm|_ga)$/i;
const SIMILAR_TITLE = 0.8;
const SIMILAR_WINDOW_MS = 48 * 3_600_000;
const MAX_ARTICLES = 20;
const MAX_ALSO_REPORTED = 10;

/** Comparison key only; links keep the publisher's original URL. */
export function urlKey(value: string): string {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^(www|m|amp)\./, '');
    const params = [...url.searchParams].filter(([name]) => !TRACKING_PARAMETERS.test(name))
      .sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
    const path = url.pathname.replace(/\/amp\/?$/i, '/').replace(/\/+$/, '') || '/';
    return `${host}${path}${params.length ? `?${new URLSearchParams(params)}` : ''}`;
  } catch {
    return value;
  }
}

/** Title key without wire tags, a trailing publisher name, spacing or punctuation. */
export function titleKey(title: string): string {
  return title.normalize('NFKC').toLowerCase()
    .replace(/[[【(〔<]\s*(속보|단독|종합|종합\d*보|\d+보|포토|영상|사진|exclusive|breaking|update|updated|video)\s*[\]】)〕>]/giu, ' ')
    .replace(/\s+[-–—|]\s+[^-–—|]{1,30}$/u, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function bigrams(value: string): Set<string> {
  const chars = [...value];
  const result = new Set<string>();
  for (let i = 0; i < chars.length - 1; i += 1) result.add(chars[i]! + chars[i + 1]!);
  return result;
}

export function titleSimilarity(a: string, b: string): number {
  const left = bigrams(titleKey(a));
  const right = bigrams(titleKey(b));
  if (!left.size || !right.size) return titleKey(a) === titleKey(b) ? 1 : 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return shared / (left.size + right.size - shared);
}

function sameStory(a: NewsArticle, b: NewsArticle): boolean {
  if (urlKey(a.url) === urlKey(b.url)) return true;
  const keyA = titleKey(a.title);
  if (keyA && keyA === titleKey(b.title)) return true;
  return Math.abs(Date.parse(a.publishedAt) - Date.parse(b.publishedAt)) <= SIMILAR_WINDOW_MS &&
    titleSimilarity(a.title, b.title) >= SIMILAR_TITLE;
}

function withMirror(primary: NewsArticle, other: NewsArticle): NewsArticle {
  const candidates = [...(primary.alsoReportedBy ?? []), ...(other.alsoReportedBy ?? [])];
  if (other.source.toLowerCase() !== primary.source.toLowerCase()) candidates.unshift({ source: other.source, url: other.url });
  const seen = new Set([urlKey(primary.url)]);
  const mirrors: Array<{ source: string; url: string }> = [];
  for (const item of candidates) {
    if (seen.has(urlKey(item.url))) continue;
    seen.add(urlKey(item.url));
    mirrors.push(item);
  }
  const { alsoReportedBy: _replaced, ...rest } = primary;
  return mirrors.length ? { ...rest, alsoReportedBy: mirrors.slice(0, MAX_ALSO_REPORTED) } : rest;
}

/**
 * Lists arrive in source priority order. A classified article represents its
 * story; other copies are listed as additional publishers, never re-counted.
 */
export function mergeArticles(lists: NewsArticle[][], limit = MAX_ARTICLES): NewsArticle[] {
  const stories: NewsArticle[] = [];
  for (const article of lists.flat()) {
    const index = stories.findIndex(story => sameStory(story, article));
    if (index < 0) { stories.push(article); continue; }
    const existing = stories[index]!;
    const promote = existing.sentiment === 'unclassified' && article.sentiment !== 'unclassified';
    stories[index] = promote ? withMirror(article, existing) : withMirror(existing, article);
  }
  return stories.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, limit);
}

export interface NewsSourceEntry {
  id: string;
  label: string;
  provider: NewsProvider;
}

function failureStatus(error: unknown): NewsSourceState['status'] {
  return error instanceof ProviderError && (error.code === 'not_configured' || error.code === 'rate_limited') ? error.code : 'error';
}

/** All failed: report the combined state while keeping every source outcome. */
function combinedFailure(errors: unknown[], sources: NewsSourceState[]): ProviderError {
  const statuses = sources.map(source => source.status);
  const retryDelays = errors.flatMap(error => error instanceof ProviderError && error.code === 'rate_limited' &&
    typeof error.retryAfterMs === 'number' ? [error.retryAfterMs] : []);
  const reason = errors.find((error): error is ProviderError => error instanceof ProviderError && error.reason !== undefined)?.reason;
  const failure = statuses.every(status => status === 'not_configured') ? new ProviderError('not_configured')
    // A transient error elsewhere must not be hidden behind a long quota wait.
    : statuses.every(status => status === 'rate_limited' || status === 'not_configured')
      ? new ProviderError('rate_limited', undefined, retryDelays.length ? Math.min(...retryDelays) : undefined)
      : new ProviderError('error', reason);
  failure.sources = sources;
  return failure;
}

/** Queries every source independently; one failure or exhausted quota never blocks the others. */
export function createMultiSourceProvider(entries: NewsSourceEntry[]): NewsProvider {
  const ttls = entries.map(entry => entry.provider.cacheTtlMs).filter((ttl): ttl is number => typeof ttl === 'number');
  return {
    name: entries.map(entry => entry.label).join(' · '),
    setupMessage: entries.map(entry => entry.provider.setupMessage).find(Boolean),
    ...(ttls.length ? { cacheTtlMs: Math.min(...ttls) } : {}),
    async getArticles(company, now, options): Promise<NewsProviderResult> {
      const settled = await Promise.allSettled(entries.map(entry => entry.provider.getArticles(company, now, options)));
      const sources: NewsSourceState[] = settled.map((outcome, i) => {
        const { id, label } = entries[i]!;
        if (outcome.status === 'fulfilled') {
          return { id, label, status: outcome.value.articles.length ? 'ok' : 'empty', articleCount: outcome.value.articles.length };
        }
        const status = failureStatus(outcome.reason);
        const delay = outcome.reason instanceof ProviderError ? outcome.reason.retryAfterMs : undefined;
        return { id, label, status, articleCount: 0,
          ...(status === 'rate_limited' && typeof delay === 'number' ? { retryAt: new Date(now.getTime() + delay).toISOString() } : {}) };
      });
      const succeeded = settled.flatMap((outcome, i) => outcome.status === 'fulfilled' ? [{ entry: entries[i]!, result: outcome.value }] : []);
      if (!succeeded.length) throw combinedFailure(settled.map(outcome => outcome.status === 'rejected' ? outcome.reason : undefined), sources);
      // Name the sources that actually contributed articles.
      const contributed = succeeded.filter(item => item.result.articles.length > 0);
      return {
        provider: (contributed.length ? contributed : succeeded).map(item => item.entry.label).join(' · '),
        articles: mergeArticles(succeeded.map(item => item.result.articles)),
        notes: [...new Set(succeeded.flatMap(item => item.result.notes ?? []))],
        sources,
      };
    },
  };
}
