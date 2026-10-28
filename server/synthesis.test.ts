import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyNewsTopics, companies, isNewsAnalysis, type NewsAnalysis, type NewsArticle } from '@moneycast/core';
import { FACTOR_NOTE, synthesizeFactors } from './synthesis.js';

const now = new Date('2026-10-27T00:00:00Z');
function article(id: string, sentiment: NewsArticle['sentiment'], title: string, source = 'a.example', publishedAt = '2026-10-26T01:00:00Z'): NewsArticle {
  return { id, title, source, publishedAt, url: `https://example.test/${id}`, sentiment, rationale: `테스트 근거 ${id}` };
}
// Template wording only: quoted article titles are the sole external text.
const templateText = (line: string) => line.replace(/「[^」]*」/g, '');
const BANNED = /상승할|하락할|오를 것|내릴 것|확률|매수|매도|추천|전망입니다|예상됩니다/;

test('topic keywords cover Korean and English titles in priority order with an explicit fallback', () => {
  assert.deepEqual(classifyNewsTopics('삼성전자 3분기 영업이익 개선'), ['earnings']);
  assert.deepEqual(classifyNewsTopics('Analysts raise Apple price target after strong quarter')[0], 'earnings');
  assert.deepEqual(classifyNewsTopics('Analysts raise Apple price target'), ['analyst']);
  assert.deepEqual(classifyNewsTopics('Tesla faces antitrust probe'), ['regulation']);
  assert.deepEqual(classifyNewsTopics('Nvidia unveils new AI chips'), ['product']);
  assert.deepEqual(classifyNewsTopics('Fine-tuned models arrive'), ['other']);
  assert.deepEqual(classifyNewsTopics('경기도 평택 캠퍼스 방문'), ['other']);
  assert.deepEqual(classifyNewsTopics('Marketing chief joins'), ['other']);
});

test('repeated, single-source and single-article evidence produce distinct cautious sentences', () => {
  const { factorSummary, positiveFactors } = synthesizeFactors([
    article('p1', 'positive', '삼성전자 3분기 영업이익 개선', 'a.example', '2026-10-26T03:00:00Z'),
    article('p2', 'positive', 'Samsung quarterly profit beats', 'b.example', '2026-10-25T03:00:00Z'),
    article('p3', 'positive', '삼성전자 신제품 출시', 'a.example'),
  ], now);
  assert.equal(factorSummary.positive.state, 'repeated');
  assert.deepEqual(factorSummary.positive.lines.map(line => [line.topic, line.articleIds]), [
    ['earnings', ['p1', 'p2']], ['product', ['p3']],
  ]);
  assert.match(positiveFactors[0]!, /'실적·가이던스' 관련 기사 2건이 긍정으로 분류됐습니다\(서로 다른 출처 2곳, 최근 10\/26\)/);
  assert.match(positiveFactors[0]!, /대표: 「삼성전자 3분기 영업이익 개선」/);
  assert.match(positiveFactors[1]!, /1건만 긍정으로 분류돼 반복 확인되지 않았습니다/);
  assert.equal(factorSummary.negative.state, 'none');
  assert.deepEqual(factorSummary.negative.lines, []);
  assert.equal(factorSummary.note, FACTOR_NOTE);

  const sameSource = synthesizeFactors([
    article('n1', 'negative', 'Tesla recall widens', 'x.example'),
    article('n2', 'negative', 'Tesla recall expands', 'www.X.example'),
  ], now).factorSummary.negative;
  assert.equal(sameSource.state, 'single');
  assert.match(sameSource.lines[0]!.text, /2건이 부정으로 분류됐지만 모두 같은 출처\(x\.example\)입니다/);
  assert.ok(sameSource.chips.includes('단일 출처'));
  assert.ok(synthesizeFactors([article('one', 'negative', '단일 기사')], now).factorSummary.negative.chips.includes('단일 근거'));
});

test('conflicting directions are flagged per topic and per box rather than resolved', () => {
  const { factorSummary } = synthesizeFactors([
    article('p1', 'positive', 'Apple earnings beat', 'a.example'),
    article('n1', 'negative', 'Apple earnings miss in China', 'b.example'),
    article('n2', 'negative', 'Apple faces antitrust probe', 'c.example'),
  ], now);
  assert.equal(factorSummary.positive.state, 'mixed');
  assert.equal(factorSummary.negative.state, 'mixed');
  assert.match(factorSummary.positive.lines[0]!.text, /같은 주제의 부정 기사도 1건 있어 신호가 엇갈립니다/);
  assert.ok(factorSummary.positive.chips.includes('반대 방향 기사 2건 · 신호 엇갈림'));
  assert.ok(factorSummary.negative.chips.includes('반대 방향 기사 1건 · 신호 엇갈림'));
  assert.ok(!factorSummary.negative.lines.find(line => line.topic === 'regulation')!.text.includes('엇갈립니다'));
});

test('stale, crowded, neutral and unclassified evidence adds explicit caution chips', () => {
  const titles = ['실적 개선', '신제품 출시', '소송 합의', '배당 확대', '공장 증설'];
  const { factorSummary } = synthesizeFactors([
    ...titles.map((title, i) => article(`p${i}`, 'positive', title, `s${i}.example`, '2026-10-22T00:00:00Z')),
    article('z', 'neutral', '중립 기사'), article('u', 'unclassified', '미분류 기사'),
  ], now);
  assert.equal(factorSummary.positive.lines.length, 3);
  assert.ok(factorSummary.positive.chips.includes('최근 72시간 내 해당 방향 기사 없음'));
  assert.ok(factorSummary.positive.chips.includes('그 밖의 주제 2개'));
  assert.deepEqual(factorSummary.chips, ['중립 분류 1건', '감성 점수 없는 기사 1건은 방향 집계 제외']);
  assert.deepEqual(synthesizeFactors([article('x', 'positive', '실적')], now).factorSummary.chips, ['분류된 기사 3건 미만']);
});

test('sentences cite existing same-direction articles, avoid forecast wording and are order independent', () => {
  const articles = [
    article('p1', 'positive', '주가 상승 기대 속 실적 개선', 'a.example'),
    article('p2', 'positive', 'Strong quarter lifts outlook', 'b.example'),
    article('n1', 'negative', '반독점 소송 제기', 'c.example'),
    article('n2', 'negative', 'A very long headline that keeps going well past the forty character display limit', 'd.example'),
  ];
  const first = synthesizeFactors(articles, now);
  assert.deepEqual(synthesizeFactors([...articles].reverse(), now), first);
  const byId = new Map(articles.map(item => [item.id, item]));
  for (const [direction, box] of [['positive', first.factorSummary.positive], ['negative', first.factorSummary.negative]] as const) {
    for (const line of box.lines) {
      assert.ok(line.articleIds.every(id => byId.get(id)?.sentiment === direction), line.text);
      assert.doesNotMatch(templateText(line.text), BANNED, line.text);
      assert.doesNotMatch(line.text, /감성 점수/);
    }
  }
  assert.ok(first.negativeFactors.some(line => line.includes('「A very long headline that keeps going w…」')));
});

test('a synthesized summary passes the shared response validator only when its evidence is rendered', () => {
  const articles = [article('p1', 'positive', '실적 개선', 'a.example'), article('n1', 'negative', '소송', 'b.example')];
  const { factorSummary, positiveFactors, negativeFactors } = synthesizeFactors(articles, now);
  const analysis: NewsAnalysis = {
    company: companies[0]!, status: 'insufficient', articles, asOf: now.toISOString(),
    period: { start: '2026-11-02', end: '2026-11-06' }, evidence: 'low', summary: '테스트 전용 요약',
    positiveFactors, negativeFactors, risks: [], provider: 'Test', analysisVersion: 'test', factorSummary,
  };
  assert.equal(isNewsAnalysis(analysis), true);
  assert.equal(isNewsAnalysis({ ...analysis, articles: articles.slice(1) }), false);
});
