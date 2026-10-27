import { createNewsCache } from '@moneycast/core';

/** Public backend address only; provider keys never belong in the native bundle. */
export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? '').replace(/\/$/, '');

// Module scope keeps successful results and pending requests across tab remounts.
// Core validation bounds the cache to six hours and never persists failures.
export const mobileNewsCache = createNewsCache({
  async load(companyId) {
    if (!API_URL) throw new Error('뉴스용 백엔드 주소를 먼저 설정해 주세요.');
    let endpoint: URL;
    try { endpoint = new URL(API_URL); }
    catch { throw new Error('설정한 API 주소 형식이 올바르지 않습니다.'); }
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
      throw new Error('설정한 API 주소 형식이 올바르지 않습니다.');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(`${API_URL}/api/news?companyId=${encodeURIComponent(companyId)}`, { signal: controller.signal });
      if (!response.ok) throw new Error(response.status === 429
        ? '요청이 많습니다. 잠시 후 다시 시도해 주세요.' : '뉴스 서버가 요청을 처리하지 못했습니다.');
      return await response.json() as unknown;
    } catch (reason) {
      if (controller.signal.aborted) throw new Error('응답 시간이 초과되었습니다. 서버 주소와 연결을 확인해 주세요.');
      if (reason instanceof SyntaxError) throw new Error('서버 응답 형식이 올바르지 않습니다.');
      if (reason instanceof TypeError || reason instanceof Error && reason.message === 'Network request failed') {
        throw new Error('서버에 연결할 수 없습니다. API 주소와 네트워크를 확인해 주세요.');
      }
      throw reason;
    } finally {
      clearTimeout(timer);
    }
  },
});
