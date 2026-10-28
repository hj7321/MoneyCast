import 'dotenv/config';
import { companies, isNewsAnalysis, type AiJudgement, type AiProviderId, type NewsAnalysis } from '@moneycast/core';
import { terminalText } from './terminal-text.js';

const messages = {
  not_configured: '연결 미완료: 서버에 뉴스 제공자 설정이 필요합니다.',
  rate_limited: '연결 확인 보류: 뉴스 제공자의 호출 한도에 도달했습니다. 잠시 후 다시 확인하세요.',
  error: '연결 실패: 서버의 뉴스 제공자 설정과 응답 형식을 확인하세요.',
  ready: '연결 정상: 뉴스 응답을 확인했습니다. 근거 수준은 주가 예측의 정확도를 뜻하지 않습니다.',
  insufficient: '연결 정상: 제공자 응답을 확인했습니다. 기사 부족·중립·상충 등으로 방향 판단을 유보합니다.',
} as const;

function providerLabel(value: string | null): string {
  if (!value) return '미연결';
  // Diagnostic output never includes arbitrary URLs, query strings or control characters.
  return /^[\p{L}\p{N} ._()·\-]{1,100}$/u.test(value) ? value : '연결됨 (표시명 생략)';
}

/** Model ids such as `@cf/qwen/qwen3-30b-a3b-fp8`; anything else is withheld. */
function modelLabel(value: string): string {
  return /^@?[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+){0,2}$/.test(value) && value.length <= 80 ? value : '모델명 생략';
}

const VERDICTS = { positive: '긍정', negative: '부정', neutral: '중립', uncertain: '판단 불가' } as const;
const CONSENSUS = { confirmed: '합의', provisional: '잠정', withheld: '유보', pending: '대기' } as const;

const verdict = (judgement: AiJudgement | undefined) =>
  !judgement ? '없음' : judgement.relevant ? VERDICTS[judgement.sentiment] : '관련 없음';

/** One numbered line per AI-judged article, for comparing the two models with a person's own reading. */
function printAiSample(analysis: NewsAnalysis): void {
  if (!analysis.ai) {
    console.log('AI 판단 표본: 서버에 AI 키가 없어 표본이 없습니다.');
    return;
  }
  // Provider-scored articles appear too: the models check that they are about the company.
  const sampled = analysis.articles.filter(article => article.aiConsensus || article.aiJudgements);
  const tag = (article: NewsAnalysis['articles'][number]) => article.aiRelevance === 'unrelated' ? '관련 없음'
    : article.aiConsensus ? CONSENSUS[article.aiConsensus] : '점수 유지';
  console.log(`AI 판단 표본 ${sampled.length}건 · 번호마다 직접 읽은 판단(긍정·부정·중립·판단 불가·관련 없음)을 적어 주세요.`);
  sampled.forEach((article, index) => {
    const by = (id: AiProviderId) => article.aiJudgements?.find(item => item.provider === id);
    const evidence = article.aiJudgements?.find(item => item.evidence)?.evidence;
    console.log(`${index + 1}. [${tag(article)}] Gemini ${verdict(by('gemini'))} · Cloudflare ${verdict(by('cloudflare'))}` +
      `${evidence ? ` | 근거 「${terminalText(evidence, 40)}」` : ''} | ${terminalText(article.title, 70)}`);
  });
  const pairs = sampled.filter(article => article.aiJudgements?.length === 2);
  const same = pairs.filter(article => verdict(article.aiJudgements![0]) === verdict(article.aiJudgements![1])).length;
  const count = (consensus: keyof typeof CONSENSUS) => sampled.filter(article => article.aiConsensus === consensus).length;
  console.log(`두 모델 모두 답한 ${pairs.length}건 중 같은 판단 ${same}건${pairs.length ? `(${Math.round(same / pairs.length * 100)}%)` : ''}` +
    ` · 관련성 낮음 ${analysis.ai.unrelatedCount}건 · 잠정 ${count('provisional')}건 · 대기 ${count('pending')}건`);
}

async function readJson(endpoint: string): Promise<unknown> {
  const response = await fetch(endpoint, {
    signal: AbortSignal.timeout(20000), redirect: 'error', headers: { Accept: 'application/json' },
  });
  if (!response.ok || !response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    throw new Error('invalid_response');
  }
  return response.json();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const ids = args.filter(arg => !arg.startsWith('--'));
  const flags = args.filter(arg => arg.startsWith('--'));
  const company = companies.find(item => item.id === (ids[0] ?? 'krx:005930'));
  if (!company || ids.length > 1 || flags.some(flag => flag !== '--ai')) {
    console.error('회사 ID를 확인하세요. 예: npm run news:check -- nasdaq:AAPL (AI 판단 표본은 끝에 --ai)');
    process.exitCode = 1;
    return;
  }
  const port = Number(process.env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('서버의 PORT 설정은 1~65535 정수여야 합니다.');
    process.exitCode = 1;
    return;
  }
  const base = `http://127.0.0.1:${port}`;
  let health: unknown;
  try {
    health = await readJson(`${base}/api/health`);
  } catch {
    console.error('API 연결 실패: 로컬 API 서버 실행 상태와 PORT 설정을 확인하세요. 서버는 자동으로 시작하지 않습니다.');
    process.exitCode = 1;
    return;
  }
  if (!health || typeof health !== 'object' ||
      (health as Record<string, unknown>).status !== 'ok' ||
      (health as Record<string, unknown>).service !== 'MoneyCast API') {
    console.error('API 확인 실패: MoneyCast 상태 응답이 올바르지 않습니다.');
    process.exitCode = 1;
    return;
  }
  let analysis: unknown;
  try {
    analysis = await readJson(`${base}/api/news?companyId=${encodeURIComponent(company.id)}`);
  } catch {
    console.error('뉴스 확인 실패: API 응답을 읽지 못했습니다. 서버 연결과 요청 제한 시간을 확인하세요.');
    process.exitCode = 1;
    return;
  }
  if (!isNewsAnalysis(analysis, company.id)) {
    console.error('뉴스 확인 실패: 응답 형식이나 회사 식별자가 올바르지 않습니다.');
    process.exitCode = 1;
    return;
  }
  console.log(`회사: ${company.name} · ${company.symbol} · ${company.exchange} · ${company.region}`);
  console.log(`상태: ${analysis.status}`);
  console.log(`제공자: ${providerLabel(analysis.provider)}`);
  console.log(`기사: ${analysis.articles.length}건`);
  console.log(`기준 시각: ${analysis.asOf}`);
  if (analysis.newsWindow) console.log(`뉴스 수집 기간: ${analysis.newsWindow.start} ~ ${analysis.newsWindow.end}`);
  console.log(`다음 주 참고 기간: ${analysis.period.start} ~ ${analysis.period.end}`);
  if (analysis.cachedUntil) console.log(`캐시 만료: ${analysis.cachedUntil}`);
  if (analysis.retryAt) console.log(`재시도 가능 시각: ${analysis.retryAt}`);
  // An article both models judged unrelated keeps its provider score for reference only.
  const related = analysis.articles.filter(article => article.aiRelevance !== 'unrelated');
  console.log(`분류된 기사: ${related.filter(article => article.sentiment !== 'unclassified').length}건` +
    `${related.length < analysis.articles.length ? ` (관련성 낮은 기사 ${analysis.articles.length - related.length}건 제외)` : ''}`);
  for (const source of analysis.sources ?? []) {
    console.log(`출처 ${providerLabel(source.label)}: ${source.status}${source.status === 'skipped' ? '(예약 수집 때만 조회)' : ''} · 기사 ${source.articleCount}건${source.retryAt ? ` · 재시도 ${source.retryAt}` : ''}`);
  }
  for (const model of analysis.ai?.providers ?? []) {
    console.log(`AI ${providerLabel(model.label)} (${modelLabel(model.model)}): ${model.status} · 판단 ${model.judgedCount}건${model.retryAt ? ` · 재시도 ${model.retryAt}` : ''}`);
  }
  if (analysis.ai) {
    const count = (consensus: string) => analysis.articles.filter(article => article.aiConsensus === consensus).length;
    console.log(`AI 합의 ${count('confirmed')}건 · 잠정 ${count('provisional')}건 · 유보 ${count('withheld')}건 · 대기 ${count('pending')}건 · 관련성 낮아 집계 제외 ${analysis.ai.unrelatedCount}건`);
    console.log(`AI 요약: ${analysis.articles.filter(article => article.summary).length}건 · 프롬프트 ${providerLabel(analysis.ai.promptVersion)}`);
  }
  if (flags.includes('--ai')) printAiSample(analysis);
  const mirrored = analysis.articles.reduce((sum, article) => sum + (article.alsoReportedBy?.length ?? 0), 0);
  if (mirrored) console.log(`중복 제거로 합친 다른 출처: ${mirrored}건`);
  if (analysis.servedFrom === 'stale') console.log(`새로 고침 실패: ${analysis.refreshAttemptedAt ?? '시각 미상'} 시도, 이전 결과를 표시합니다.`);
  console.log(messages[analysis.status]);
  if (analysis.status === 'insufficient' && analysis.articles.length === 0) {
    console.log('표시할 기사는 없습니다. 빈 결과 수신과 분석 근거 확보는 서로 다른 상태입니다.');
  }
  if (!['ready', 'insufficient'].includes(analysis.status)) process.exitCode = 1;
}

void main().catch(() => {
  console.error('뉴스 확인 중 오류가 발생했습니다. 서버 실행 상태와 설정을 확인하세요.');
  process.exitCode = 1;
});
