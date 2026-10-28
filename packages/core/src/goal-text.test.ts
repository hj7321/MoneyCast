import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  analyzeGoalText, classifyGoalText, findGoalPeriod, findKoreanAmounts, findTravelers, findTripLength, goalQuestionText,
  hasPersonalData, monthsUntil, parseKoreanAmount, planGoalQuestions,
} from './index.ts';

// 2026-10-28 in local time; relative months count from this calendar month.
const now = new Date(2026, 9, 28);

test('Korean amounts are read as written, including units, commas, decimals and spoken shorthand', () => {
  for (const [text, expected] of [
    ['3천만 원', 30_000_000], ['3천만원', 30_000_000], ['3,000만 원', 30_000_000], ['1억 5천', 150_000_000],
    ['1억5천만원', 150_000_000], ['1.5억', 150_000_000], ['50,000,000원', 50_000_000], ['오백만 원', 5_000_000],
    ['천만 원', 10_000_000], ['2만 5천원', 25_000], ['3억 2천5백', 325_000_000], ['일억', 100_000_000],
  ] as const) assert.equal(parseKoreanAmount(text), expected, text);
  for (const text of ['', '원', '0원', '삼성', '5만3억', 'abc']) assert.equal(parseKoreanAmount(text), null, text);
});

test('amounts in a sentence need a money unit and keep the word written before them', () => {
  assert.deepEqual(findKoreanAmounts('결혼 자금으로 3천만 원 정도 모으고 싶어요').map(item => [item.value, item.text]), [[30_000_000, '3천만 원']]);
  assert.deepEqual(findKoreanAmounts('예식 2천만 원, 신혼여행 500만 원').map(item => [item.label, item.value]),
    [['예식', 20_000_000], ['신혼여행', 5_000_000]]);
  assert.deepEqual(findKoreanAmounts('이사 비용 오백만 원이면 돼요').map(item => [item.label, item.value, item.text]), [['이사', 5_000_000, '오백만 원']]);
  assert.deepEqual(findKoreanAmounts('천천히 모아서 천만 원').map(item => item.value), [10_000_000]);
  assert.deepEqual(findKoreanAmounts('5천만이 필요해요').map(item => item.text), ['5천만']);
  for (const text of ['2027년 10월 3명이 3박 4일', '만약 차를 산다면', '삼성 주식', '이사 날짜 미정']) assert.deepEqual(findKoreanAmounts(text), [], text);
});

test('saving periods read durations and future calendar months but not years, ages or fund sizes', () => {
  for (const [text, months, quoted] of [
    ['2년 안에', 24, '2년'], ['18개월 동안', 18, '18개월'], ['1년 반', 18, '1년 반'], ['2년 6개월', 30, '2년 6개월'],
    ['두 달 뒤', 2, '두 달'], ['반년', 6, '반년'], ['1.5년', 18, '1.5년'], ['2027년 10월까지', 12, '2027년 10월'],
    ['내년 3월', 5, '내년 3월'], ['올해 12월', 2, '올해 12월'],
  ] as const) assert.deepEqual(findGoalPeriod(text, now), { value: months, text: quoted }, text);
  for (const text of ['2026년 5월', '결혼 3년차', '6개월치 생활비', '한 달 생활비 200만 원', '2027년', '3년 전부터']) {
    assert.equal(findGoalPeriod(text, now), null, text);
  }
  assert.equal(monthsUntil(2026, 10, now), null);
  assert.equal(monthsUntil(2026, 11, now), 1);
});

test('party size and trip length come from explicit counts', () => {
  assert.deepEqual(findTravelers('친구랑 2명이서'), { value: 2, text: '2명' });
  assert.deepEqual(findTravelers('4인 가족'), { value: 4, text: '4인' });
  assert.deepEqual(findTravelers('혼자 가는 여행'), { value: 1, text: '혼자' });
  for (const text of ['2인분', '1인실', '25명', '여행']) assert.equal(findTravelers(text), null, text);
  assert.deepEqual(findTripLength('3박 4일'), { nights: { value: 3, text: '3박 4일' }, days: { value: 4, text: '3박 4일' } });
  assert.deepEqual(findTripLength('5박 일정'), { nights: { value: 5, text: '5박' } });
  assert.deepEqual(findTripLength('당일치기'), { nights: { value: 0, text: '당일치기' }, days: { value: 1, text: '당일치기' } });
});

test('phone, resident, card and account numbers or e-mail addresses count as personal data, amounts do not', () => {
  for (const text of ['연락처 010-1234-5678', 'me@example.com', '900101-1234567', '1234-5678-9012-3456', '계좌 1002 345 678901']) {
    assert.equal(hasPersonalData(text), true, text);
  }
  for (const text of ['1000000000원', '2027-10-01까지', '3천만 원', '3박 4일 2명']) assert.equal(hasPersonalData(text), false, text);
});

test('descriptions are sorted into categories by their most frequent keywords', () => {
  for (const [text, category] of [
    ['전세 보증금 마련', 'housing'], ['내 집 마련', 'home'], ['아반떼 신차', 'car'], ['유럽 여행', 'travel'],
    ['결혼 자금', 'wedding'], ['대학원 학비', 'education'], ['비상금 6개월치', 'emergency'], ['노후 준비', 'retirement'],
    ['그냥 목돈', 'other'], ['신혼여행 경비', 'travel'], ['결혼 예정이라 예식이랑 신혼여행', 'wedding'],
  ] as const) assert.equal(classifyGoalText(text), category, text);
});

test('an analysis gathers every figure, and questions ask only for what is missing, at most two', () => {
  const wedding = analyzeGoalText('내년 10월 결혼 예정, 예식 2천만 원이랑 신혼여행 500만 원', now);
  assert.equal(wedding.category, 'wedding');
  assert.equal(wedding.facts.amount, undefined);
  assert.deepEqual(wedding.facts.items?.map(item => [item.label, item.value]), [['예식', 20_000_000], ['신혼여행', 5_000_000]]);
  assert.deepEqual(wedding.facts.months, { value: 12, text: '내년 10월' });
  assert.equal(wedding.personalData, false);
  assert.deepEqual(planGoalQuestions(wedding, { amountKnown: false }), []);

  const trip = analyzeGoalText('오사카 여행 2명 3박 4일', now);
  assert.deepEqual([trip.category, trip.facts.travelers?.value, trip.facts.nights?.value, trip.facts.days?.value], ['travel', 2, 3, 4]);
  assert.deepEqual(planGoalQuestions(trip, { amountKnown: false }), ['amount', 'switchType']);
  assert.deepEqual(planGoalQuestions(trip, { amountKnown: true }), ['switchType', 'period']);
  assert.deepEqual(planGoalQuestions(analyzeGoalText('비상금 모으기', now), { amountKnown: false }), ['livingCost', 'period']);
  assert.deepEqual(planGoalQuestions(analyzeGoalText('목돈 3천만 원 2년 안에', now), { amountKnown: false }), []);
  assert.deepEqual(planGoalQuestions(analyzeGoalText('목돈', now), { amountKnown: true, periodKnown: true }), []);
  assert.equal(goalQuestionText('switchType', 'travel'), '‘여행’ 목표로 바꿔서 자세히 입력할까요?');
  assert.equal(goalQuestionText('amount', 'other'), '모으려는 금액이 정해져 있나요?');
});
