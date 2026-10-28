import {
  classifyNewsTopics, NEWS_TOPIC_KEYS, newsTopicLabel,
  type FactorBox, type FactorLine, type FactorSummary, type NewsArticle, type NewsTopicKey,
} from '../packages/core/src/index.js';

const HOUR = 3_600_000;
const RECENT_HOURS = 72;
const MAX_LINES = 3;
const LABEL = { positive: '긍정', negative: '부정' } as const;
type Direction = keyof typeof LABEL;

export const FACTOR_NOTE = '주제는 제목·설명의 키워드로 묶은 참고 분류입니다. 기사 분위기는 주가 방향이나 확률이 아닙니다.';
export const FACTOR_NOTE_WITH_AI = '주제는 제목·설명의 키워드로 묶고, 키워드가 없으면 AI가 고른 참고 분류를 씁니다. AI 판단은 두 모델이 같을 때만 집계하며, 기사 분위기는 주가 방향이나 확률이 아닙니다.';

/** Month/day in Seoul without depending on runtime locale data. */
function seoulDate(iso: string): string {
  const date = new Date(Date.parse(iso) + 9 * HOUR);
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
}

function shorten(value: string, max: number): string {
  const chars = [...value.trim()];
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 1).join('')}…`;
}

function sourceKey(article: NewsArticle): string {
  return article.source.trim().toLowerCase().replace(/^www\./, '');
}

function newestFirst(a: NewsArticle, b: NewsArticle): number {
  return Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || a.id.localeCompare(b.id);
}

export function articleTopic(article: NewsArticle): NewsTopicKey {
  return article.topics?.[0] ?? classifyNewsTopics(`${article.title} ${article.description ?? ''}`)[0]!;
}

function groupByTopic(articles: NewsArticle[]): Array<{ topic: NewsTopicKey; articles: NewsArticle[] }> {
  const groups = new Map<NewsTopicKey, NewsArticle[]>();
  for (const article of articles) {
    const topic = articleTopic(article);
    groups.set(topic, [...(groups.get(topic) ?? []), article]);
  }
  return [...groups].map(([topic, items]) => ({ topic, articles: items.sort(newestFirst) })).sort((a, b) =>
    b.articles.length - a.articles.length ||
    Date.parse(b.articles[0]!.publishedAt) - Date.parse(a.articles[0]!.publishedAt) ||
    NEWS_TOPIC_KEYS.indexOf(a.topic) - NEWS_TOPIC_KEYS.indexOf(b.topic));
}

/** "제공자 점수 n·AI 합의 m" whenever model agreement contributed to a sentence. */
function methodCounts(articles: NewsArticle[]): string {
  const agreed = articles.filter(article => article.classificationMethod === 'llm').length;
  return agreed === 0 ? '' : `제공자 점수 ${articles.length - agreed}·AI 합의 ${agreed}`;
}

/** Describes the article set only; quoted titles are the sole external wording. */
function factorLine(direction: Direction, topic: NewsTopicKey, articles: NewsArticle[], conflicting: number): FactorLine {
  const label = newsTopicLabel(topic);
  const sources = new Set(articles.map(sourceKey));
  const first = articles[0]!;
  const representative = `대표: 「${shorten(first.title, 40)}」`;
  const methods = methodCounts(articles);
  let text = articles.length === 1
    ? `'${label}' 관련 기사 1건만 ${LABEL[direction]}으로 분류돼${methods ? '(AI 합의)' : ''} 반복 확인되지 않았습니다. ${representative}`
    : sources.size === 1
      ? `'${label}' 관련 기사 ${articles.length}건이 ${LABEL[direction]}으로 분류됐지만 모두 같은 출처(${shorten(first.source, 30)})입니다${methods ? `(${methods})` : ''}. ${representative}`
      : `'${label}' 관련 기사 ${articles.length}건이 ${LABEL[direction]}으로 분류됐습니다(서로 다른 출처 ${sources.size}곳, 최근 ${seoulDate(first.publishedAt)}${methods ? `, ${methods}` : ''}). ${representative}`;
  if (conflicting > 0) {
    text += ` 같은 주제의 ${LABEL[direction === 'positive' ? 'negative' : 'positive']} 기사도 ${conflicting}건 있어 신호가 엇갈립니다.`;
  }
  return { text, topic, articleIds: articles.map(article => article.id) };
}

function factorBox(direction: Direction, articles: NewsArticle[], opposite: NewsArticle[], now: number): FactorBox {
  if (articles.length === 0) return { state: 'none', lines: [], chips: [] };
  const oppositeTopics = new Map<NewsTopicKey, number>();
  for (const article of opposite) oppositeTopics.set(articleTopic(article), (oppositeTopics.get(articleTopic(article)) ?? 0) + 1);
  const groups = groupByTopic(articles);
  const lines = groups.slice(0, MAX_LINES).map(group =>
    factorLine(direction, group.topic, group.articles, oppositeTopics.get(group.topic) ?? 0));
  const chips: string[] = [];
  if (articles.length === 1) chips.push('단일 근거');
  else if (new Set(articles.map(sourceKey)).size === 1) chips.push('단일 출처');
  if (opposite.length > 0) chips.push(`반대 방향 기사 ${opposite.length}건 · 신호 엇갈림`);
  const latest = Math.max(...articles.map(article => Date.parse(article.publishedAt)));
  if (now - latest > RECENT_HOURS * HOUR) chips.push('최근 72시간 내 해당 방향 기사 없음');
  if (groups.length > MAX_LINES) chips.push(`그 밖의 주제 ${groups.length - MAX_LINES}개`);
  // Repetition needs two different articles from two different sources.
  const repeated = groups.some(group => group.articles.length >= 2 && new Set(group.articles.map(sourceKey)).size >= 2);
  return { state: opposite.length > 0 ? 'mixed' : repeated ? 'repeated' : 'single', lines, chips };
}

/**
 * Summarizes classified articles by topic; article-level score wording stays on
 * the cards. Provisional, withheld and pending AI labels stay unclassified, so
 * only provider scores and two-model agreement reach the boxes.
 */
export function synthesizeFactors(articles: NewsArticle[], now: Date, options: { ai?: boolean; unrelated?: number } = {}): {
  factorSummary: FactorSummary; positiveFactors: string[]; negativeFactors: string[];
} {
  const positive = articles.filter(article => article.sentiment === 'positive');
  const negative = articles.filter(article => article.sentiment === 'negative');
  const neutral = articles.filter(article => article.sentiment === 'neutral').length;
  const unclassified = articles.filter(article => article.sentiment === 'unclassified');
  const waiting = unclassified.filter(article => article.aiConsensus === 'provisional' || article.aiConsensus === 'pending').length;
  const withheld = unclassified.filter(article => article.aiConsensus === 'withheld').length;
  const unscored = unclassified.length - waiting - withheld;
  const chips: string[] = [];
  if (positive.length + negative.length + neutral < 3) chips.push('분류된 기사 3건 미만');
  if (neutral > 0) chips.push(`중립 분류 ${neutral}건`);
  if (unscored > 0) chips.push(`감성 점수 없는 기사 ${unscored}건은 방향 집계 제외`);
  if (waiting > 0) chips.push(`AI 교차 확인 대기 ${waiting}건`);
  if (withheld > 0) chips.push(`AI 판단 유보 ${withheld}건`);
  if (options.unrelated) chips.push(`관련성 낮아 뺀 기사 ${options.unrelated}건`);
  const factorSummary: FactorSummary = {
    positive: factorBox('positive', positive, negative, now.getTime()),
    negative: factorBox('negative', negative, positive, now.getTime()),
    chips, note: options.ai ? FACTOR_NOTE_WITH_AI : FACTOR_NOTE,
  };
  return {
    factorSummary,
    positiveFactors: factorSummary.positive.lines.map(line => line.text),
    negativeFactors: factorSummary.negative.lines.map(line => line.text),
  };
}
