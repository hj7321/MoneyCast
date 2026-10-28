import 'dotenv/config';
import {
  COMPANY_NEWS_IDENTITY, companies, matchesCompanyTitle,
  type AiJudgement, type AiProviderId, type Company, type NewsArticle,
} from '../packages/core/src/index.js';
import { decideConsensus, LlmError, MAX_LLM_ITEMS, validateJudgements, type JudgeRequest, type LlmJudge, type ValidJudgement, type ValidationNote } from '../server/llm.js';
import { createLlmJudges } from '../server/llm-judges.js';
import { createNewsProvider } from '../server/news-provider.js';
import { ProviderError } from '../server/provider.js';
import { terminalText } from './terminal-text.js';

/**
 * Evaluation only: asks both models about every article of 1–4 companies,
 * including articles that already carry a Marketaux score, so their agreement
 * with each other, with Marketaux and with a person can be measured. Nothing
 * here changes what the app shows. Keys come from .env and are never printed.
 */

const SOURCE_WAIT_MS = 35_000;
const MODEL_WAIT_MS = 25_000;
const GDELT_SPACING_MS = 6_000;
const VERDICTS = { positive: '긍정', negative: '부정', neutral: '중립', uncertain: '판단 불가' } as const;
const RESULTS = { confirmed: '합의', provisional: '잠정', withheld: '유보', pending: '대기', irrelevant: '관련 없음 합의' } as const;
/** `repeat` takes one word, so each company gets the single word its articles repeat. */
const REPEAT_WORDS: Record<string, string> = {
  'krx:005930': 'Samsung', 'krx:000660': 'Hynix', 'krx:035420': 'Naver', 'krx:005380': 'Hyundai',
  'nasdaq:AAPL': 'Apple', 'nasdaq:NVDA': 'Nvidia', 'nasdaq:MSFT': 'Microsoft', 'nasdaq:TSLA': 'Tesla',
};

const seconds = (ms: number) => (ms / 1000).toFixed(1);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const verdict = (judgement: Pick<AiJudgement, 'relevant' | 'sentiment'> | undefined) =>
  !judgement ? '없음' : judgement.relevant ? VERDICTS[judgement.sentiment] : '관련 없음';

interface Answer { judge: LlmJudge; ms: number; valid?: Map<string, ValidJudgement>; error?: string; notes: Map<ValidationNote, number> }
interface Sample { article: NewsArticle; byModel: Map<AiProviderId, ValidJudgement> }

async function ask(judge: LlmJudge, request: JudgeRequest): Promise<Answer> {
  const notes = new Map<ValidationNote, number>();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_WAIT_MS);
  const started = Date.now();
  try {
    const raw = await judge.judge(request, controller.signal);
    return { judge, ms: Date.now() - started, valid: validateJudgements(raw, request, notes), notes };
  } catch (error) {
    return { judge, ms: Date.now() - started, error: controller.signal.aborted ? 'timeout' : error instanceof LlmError ? error.code : 'error', notes };
  } finally {
    clearTimeout(timer);
  }
}

/** One extra GDELT request with `repeat3:` added, to compare how many titles name the company. */
async function gdeltRepeatTest(company: Company): Promise<string> {
  const identity = COMPANY_NEWS_IDENTITY[company.id];
  const word = REPEAT_WORDS[company.id];
  if (!identity || !word) return 'repeat3 비교: 대상 아님';
  const now = new Date();
  const time = (date: Date) => date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const url = new URL('https://api.gdeltproject.org/api/v2/doc/doc');
  for (const [key, value] of Object.entries({
    query: `repeat3:"${word}" ${identity.searchQuery}`, mode: 'artlist', format: 'json', maxrecords: '50', sort: 'datedesc',
    startdatetime: time(new Date(now.getTime() - 7 * 86_400_000)), enddatetime: time(now),
  })) url.searchParams.set(key, value);
  const started = Date.now();
  try {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { Accept: 'application/json' } });
    const elapsed = seconds(Date.now() - started);
    if (!response.ok || !response.headers.get('content-type')?.includes('json')) return `repeat3 비교: 실패(HTTP ${response.status}, ${elapsed}초)`;
    const payload = await response.json() as { articles?: Array<{ title?: unknown }> };
    const rows = Array.isArray(payload.articles) ? payload.articles : [];
    const named = rows.filter(row => typeof row.title === 'string' && matchesCompanyTitle(company.id, row.title)).length;
    return `repeat3 비교: 받은 ${rows.length}건 중 제목에 회사명 ${named}건 · ${elapsed}초`;
  } catch {
    return `repeat3 비교: 실패(시간 초과 또는 연결 오류, ${seconds(Date.now() - started)}초)`;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flags = args.filter(arg => arg.startsWith('--'));
  const ids = args.filter(arg => !arg.startsWith('--'));
  const targets = (ids.length ? ids : ['nasdaq:AAPL', 'krx:005930']).map(id => companies.find(company => company.id === id));
  if (targets.some(company => !company) || targets.length > 4 || flags.some(flag => flag !== '--gdelt-test')) {
    console.error('회사 ID를 1~4개 적어 주세요. 예: npm run ai:check -- nasdaq:AAPL krx:005930 --gdelt-test');
    process.exitCode = 1;
    return;
  }
  const judges = createLlmJudges(process.env).filter(judge => !judge.unavailable());
  if (!judges.length) {
    console.error('AI 키를 찾지 못했습니다. 루트 .env의 GEMINI_API_KEY와 CLOUDFLARE_ACCOUNT_ID·CLOUDFLARE_API_TOKEN을 확인하세요.');
    process.exitCode = 1;
    return;
  }
  if (judges.length < 2) console.log('주의: 모델 하나만 설정되어 두 모델 일치율은 계산하지 않습니다.');
  const provider = createNewsProvider(process.env);
  const samples: Sample[] = [];
  const totals = new Map<AiProviderId, Map<ValidationNote, number>>();

  for (const [index, company] of (targets as Company[]).entries()) {
    console.log(`\n== ${company.name} · ${company.symbol} · ${company.exchange}`);
    const started = Date.now();
    let articles: NewsArticle[] = [];
    try {
      const result = await provider.getArticles(company, new Date(), { deadline: Date.now() + SOURCE_WAIT_MS });
      console.log(`출처 ${seconds(Date.now() - started)}초 · ${(result.sources ?? []).map(source => `${source.label} ${source.status} ${source.articleCount}건`).join(' · ') || result.provider}`);
      for (const note of result.notes ?? []) if (/GDELT 기사 \d+건/.test(note)) console.log(`  ${note}`);
      articles = result.articles.slice(0, MAX_LLM_ITEMS);
    } catch (error) {
      const sources = error instanceof ProviderError ? error.sources ?? [] : [];
      console.log(`출처 실패(${error instanceof ProviderError ? error.code : 'error'}) · ${sources.map(source => `${source.label} ${source.status}`).join(' · ')}`);
    }
    if (flags.includes('--gdelt-test')) {
      await sleep(GDELT_SPACING_MS);
      console.log(`  ${await gdeltRepeatTest(company)}`);
    }
    if (articles.length) {
      const items = articles.map((article, i) => ({
        key: `a${i + 1}`, title: article.title, ...(article.description ? { description: article.description } : {}),
        source: article.source, ...(article.language ? { language: article.language } : {}), summarize: false, judge: true,
      }));
      // The same requests as production: Gemini also labels topics and writes summaries.
      const answers = await Promise.all(judges.map(judge => ask(judge, {
        company, topics: judge.id === 'gemini', items: items.map(item => ({ ...item, summarize: judge.id === 'gemini' })),
      })));
      for (const answer of answers) {
        const notes = [...answer.notes].map(([reason, count]) => `${reason} ${count}`).join(', ');
        console.log(`${answer.judge.label}: ${answer.error ? `실패(${answer.error})` : `유효 답 ${answer.valid!.size}/${items.length}건`} · ${seconds(answer.ms)}초${notes ? ` · 버림·자름: ${notes}` : ''}`);
        const sum = totals.get(answer.judge.id) ?? new Map<ValidationNote, number>();
        for (const [reason, count] of answer.notes) sum.set(reason, (sum.get(reason) ?? 0) + count);
        totals.set(answer.judge.id, sum);
      }
      articles.forEach((article, i) => {
        const byModel = new Map<AiProviderId, ValidJudgement>();
        for (const answer of answers) {
          const valid = answer.valid?.get(`a${i + 1}`);
          if (valid) byModel.set(answer.judge.id, valid);
        }
        samples.push({ article, byModel });
        const judgements = [...byModel].map(([id, value]): AiJudgement => ({ provider: id, model: id, relevant: value.relevant, sentiment: value.sentiment, judgedAt: new Date().toISOString() }));
        const result = RESULTS[decideConsensus(judgements).consensus];
        const reference = article.classificationMethod === 'provider'
          ? `Marketaux ${VERDICTS[article.sentiment as 'positive' | 'negative' | 'neutral']}${article.sentimentScore !== undefined ? `(${article.sentimentScore > 0 ? '+' : ''}${article.sentimentScore})` : ''}`
          : `${article.sourceProvider ?? '출처'} 점수 없음`;
        const evidence = byModel.get('gemini')?.evidence ?? byModel.get('cloudflare')?.evidence;
        console.log(`${samples.length}. [${reference}] Gemini ${verdict(byModel.get('gemini'))} · Cloudflare ${verdict(byModel.get('cloudflare'))} → ${result}` +
          `${evidence ? ` | 근거 「${terminalText(evidence, 40)}」` : ''} | ${terminalText(article.title, 70)}`);
        const summary = byModel.get('gemini')?.summary;
        if (summary) console.log(`   요약: ${terminalText(summary, 160)}`);
      });
    } else {
      console.log('판단할 기사가 없습니다.');
    }
    if (index < targets.length - 1) await sleep(GDELT_SPACING_MS);
  }

  console.log('\n== 집계');
  const scored = samples.filter(sample => sample.article.classificationMethod === 'provider');
  console.log(`표본 ${samples.length}건 · Marketaux 점수 있음 ${scored.length}건 · 점수 없음 ${samples.length - scored.length}건`);
  const pairs = samples.filter(sample => sample.byModel.size === 2);
  const same = pairs.filter(sample => verdict(sample.byModel.get('gemini')) === verdict(sample.byModel.get('cloudflare'))).length;
  if (judges.length === 2) console.log(`두 모델 모두 답한 ${pairs.length}건 중 같은 판단 ${same}건${pairs.length ? `(${Math.round(same / pairs.length * 100)}%)` : ''}`);
  for (const judge of judges) {
    const matches = scored.filter(sample => {
      const value = sample.byModel.get(judge.id);
      return value?.relevant && value.sentiment === sample.article.sentiment;
    }).length;
    const notes = [...(totals.get(judge.id) ?? [])].map(([reason, count]) => `${reason} ${count}`).join(', ');
    console.log(`${judge.label}: Marketaux 점수와 같은 방향 ${matches}/${scored.length}건 · 버림·자름 ${notes || '없음'}`);
  }
  console.log('번호마다 직접 읽은 판단(긍정·부정·중립·판단 불가·관련 없음)을 적어 주시면 사람 판단과의 일치율을 계산합니다.');
}

void main().catch(() => {
  console.error('AI 점검 중 오류가 발생했습니다. .env 설정과 네트워크 연결을 확인하세요.');
  process.exitCode = 1;
});
