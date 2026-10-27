import { createNewsCache } from '@moneycast/core';

// The promise belongs to the cache, not a mounted screen. Navigating away must
// not abort a request that another screen instance is already waiting for.
const cache = createNewsCache({
  storage: () => typeof window === 'undefined' ? undefined : window.localStorage,
  load: async companyId => {
    const response = await fetch(`/api/news?companyId=${encodeURIComponent(companyId)}`, {
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error(`뉴스 요청을 처리하지 못했습니다. (${response.status})`);
    try { return await response.json(); }
    catch { throw new Error('뉴스 응답 형식이 올바르지 않습니다.'); }
  },
});

export const loadCachedNews = cache.getAnalysis;
export const peekCachedNews = cache.peek;
