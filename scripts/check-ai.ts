import 'dotenv/config';
import { companies, type AiJudgement, type AiProviderId, type Company, type NewsArticle } from '../packages/core/src/index.js';
import { checkScore, decideConsensus, LlmError, MAX_LLM_ITEMS, validateJudgements, type JudgeRequest, type LlmJudge, type ScoreCheck, type ValidJudgement, type ValidationNote } from '../server/llm.js';
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
// GDELT asks for one request every five seconds; companies are spaced a little wider.
const GDELT_SPACING_MS = 6_000;
const VERDICTS = { positive: '긍정', negative: '부정', neutral: '중립', uncertain: '판단 불가' } as const;
const RESULTS = { confirmed: '합의', provisional: '잠정', withheld: '유보', pending: '대기', irrelevant: '관련 없음 합의' } as const;
// What the app does with a scored article, by the same rule the server applies.
const SCORE_RESULTS: Record<ScoreCheck, string> = {
  kept: '점수 유지', unrelated: '관련 없음 합의(요인 제외)', opposite: 'AI 판단으로 집계(점수와 반대)', withheld: '판단 유보(점수와 엇갈림)',
};

const seconds = (ms: number) => (ms / 1000).toFixed(1);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const verdict = (judgement: Pick<AiJudgement, 'relevant' | 'sentiment'> | undefined) =>
  !judgement ? '없음' : judgement.relevant ? VERDICTS[judgement.sentiment] : '관련 없음';

interface Answer { judge: LlmJudge; ms: number; valid?: Map<string, ValidJudgement>; error?: string; notes: Map<ValidationNote, number> }
interface Sample { article: NewsArticle; byModel: Map<AiProviderId, ValidJudgement>; check?: ScoreCheck }

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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flags = args.filter(arg => arg.startsWith('--'));
  const ids = args.filter(arg => !arg.startsWith('--'));
  const targets = (ids.length ? ids : ['nasdaq:AAPL', 'krx:005930']).map(id => companies.find(company => company.id === id));
  if (targets.some(company => !company) || targets.length > 4 || flags.length > 0) {
    console.error('회사 ID를 1~4개 적어 주세요. 예: npm run ai:check -- nasdaq:AAPL krx:005930');
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
      // The scheduled path, so GDELT is asked as in the daily collection.
      const result = await provider.getArticles(company, new Date(), { deadline: Date.now() + SOURCE_WAIT_MS, scheduled: true });
      console.log(`출처 ${seconds(Date.now() - started)}초 · ${(result.sources ?? []).map(source => `${source.label} ${source.status} ${source.articleCount}건`).join(' · ') || result.provider}`);
      for (const note of result.notes ?? []) if (/GDELT 기사 \d+건/.test(note)) console.log(`  ${note}`);
      articles = result.articles.slice(0, MAX_LLM_ITEMS);
    } catch (error) {
      const sources = error instanceof ProviderError ? error.sources ?? [] : [];
      console.log(`출처 실패(${error instanceof ProviderError ? error.code : 'error'}) · ${sources.map(source => `${source.label} ${source.status}`).join(' · ')}`);
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
        const judgements = [...byModel].map(([id, value]): AiJudgement => ({ provider: id, model: id, relevant: value.relevant, sentiment: value.sentiment, judgedAt: new Date().toISOString() }));
        const check = article.classificationMethod === 'provider' ? checkScore(article.sentiment, judgements) : undefined;
        samples.push({ article, byModel, ...(check ? { check } : {}) });
        const result = check ? SCORE_RESULTS[check] : RESULTS[decideConsensus(judgements).consensus];
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
  if (scored.length) {
    const tally = (check: ScoreCheck) => scored.filter(sample => sample.check === check).length;
    console.log(`점수 기사 결과: 점수 유지 ${tally('kept')}건 · AI 판단으로 집계 ${tally('opposite')}건 · 판단 유보 ${tally('withheld')}건 · 관련 없음 ${tally('unrelated')}건`);
  }
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
