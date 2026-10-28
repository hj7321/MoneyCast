import React, { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AccessibilityInfo,
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  View,
  findNodeHandle,
  useWindowDimensions,
} from 'react-native';
import {
  analyzeGoalText,
  calculateProjection,
  CAR_SCOPE_LABELS,
  CAR_SCOPE_NOTES,
  categoryGoalName,
  categoryGoalType,
  categoryLabel,
  companies,
  compareGoalTarget,
  createGoalPlanner,
  DEFAULT_CALCULATOR_INPUT,
  describeGoalResult,
  describeGoalTarget,
  describeInflation,
  describeSwitchPrefill,
  formatCompactKRW,
  formatDurationMonths,
  formatGoalFormula,
  formatYearMonth,
  formatKRW,
  GOAL_ITEM_LIMIT,
  GOAL_LABEL_MAX_LENGTH,
  GOAL_NAME_MAX_LENGTH,
  GOAL_NOTE_MAX_LENGTH,
  GOAL_PERSONAL_DATA_NOTICE,
  GOAL_SOURCE_LABELS,
  GOAL_SOURCE_NOTES,
  GOAL_TYPES,
  goalAiFailure,
  goalAiNotice,
  goalFactActions,
  goalFoundSource,
  goalQuestionText,
  goalSwitchActions,
  goalTypeName,
  HOME_SCOPE_LABELS,
  HOME_SCOPE_NOTES,
  livingCostActions,
  monthInputValue,
  monthsFromTargetMonth,
  parseGoalNumber,
  periodEndMonth,
  planGoalQuestions,
  resolveGoalTarget,
  searchCompanies,
  updateGoalPlanner,
  validateCalculatorInput,
  type CalculatorInput,
  type Company,
  type GoalAiAvailability,
  type GoalAiProvider,
  type GoalCategory,
  type GoalDrafts,
  type GoalPlannerAction,
  type GoalPlannerState,
  type GoalQuestionId,
  type GoalTargetResolution,
  type GoalTextFacts,
  type NewsAnalysis,
  type NewsArticle,
} from '@moneycast/core';
import { CompanyAvatar } from './CompanyAvatar';
import { useFonts } from 'expo-font';
import { MONEYCAST_FONTS } from './fonts';
import { PlexFontProvider, Text, TextInput } from './Typography';
import { API_URL, mobileNewsCache } from './news-cache';
import { clarifyGoalText, GOAL_AI_OFF, loadGoalAiAvailability } from './goal-ai';

// The target amount comes from the goal details below the goal chips.
type Field = Exclude<keyof CalculatorInput, 'years' | 'target'> | 'months';
type Tab = 'calculator' | 'news';
type Projection = ReturnType<typeof calculateProjection>;
const INITIAL_FORM: Record<Field, string> = {
  initial: String(DEFAULT_CALCULATOR_INPUT.initial),
  monthly: String(DEFAULT_CALCULATOR_INPUT.monthly),
  annualRate: String(DEFAULT_CALCULATOR_INPUT.annualRate),
  months: String(DEFAULT_CALCULATOR_INPUT.years * 12),
};
const fields: { key: Field; label: string; unit: string; hint: string }[] = [
  { key: 'initial', label: '현재 시드머니', unit: '원', hint: '현재 보유 자산을 원 단위로 입력하세요.' },
  { key: 'monthly', label: '매월 모으는 금액', unit: '원', hint: '매월 말에 납입할 금액을 입력하세요.' },
  { key: 'annualRate', label: '연간 예상 수익률', unit: '%', hint: '보장되지 않는 가정입니다. 음수도 입력할 수 있습니다.' },
  { key: 'months', label: '목표 기간', unit: '개월', hint: '1개월부터 600개월(50년)까지 1개월 단위로 입력하세요.' },
];

function Chip({ label, selected, onPress }: { label: string; selected?: boolean; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ selected: !!selected }} onPress={onPress}
    style={({ pressed }) => [styles.chip, selected && styles.chipSelected, pressed && styles.pressed]}>
    <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text>
  </Pressable>;
}

function UsageHelp({ feature }: { feature: Tab }) {
  const [visible, setVisible] = useState(false);
  const titleRef = useRef<React.ElementRef<typeof Text>>(null);
  const calculator = feature === 'calculator';
  const title = calculator ? '계산기 사용법' : '인사이트 사용법';
  const steps = calculator ? [
    { title: '나의 목표를 골라요', body: '자유 목표, 내 집 마련, 자동차, 여행 중 목표를 고르고 필요한 칸만 채우면 목표 금액이 계산돼요. 금액을 직접 입력해도 되고, 0원이거나 아직 모르면 목표 비교 없이 예상 자산만 볼 수 있어요.' },
    { title: '금액과 기간을 입력해요', body: '현재 시드머니와 매월 모으는 금액을 입력하고, 목표 기간은 1~600개월 사이에서 정하세요. 기본값 60개월은 5년이에요. 연간 예상 수익률은 보장된 전망이 아니라 직접 정하는 가정이에요.' },
    { title: '결과와 차트를 비교해요', body: '입력할 때마다 예상 자산, 납입 원금, 예상 수익과 목표 차액이 바로 달라져요. 차트의 막대를 누르면 선택한 시점의 금액을 확인할 수 있어요.' },
  ] : [
    { title: '기업과 시장을 확인해요', body: '회사명이나 종목 코드로 검색하고 상장 시장까지 확인해 선택하세요. 비슷한 이름의 회사나 다른 시장의 종목과 혼동하지 않도록 해요.' },
    { title: '기사의 근거를 읽어요', body: '뉴스가 연결되면 제목, 매체, 게시 시각과 긍정·부정·중립 분류의 근거를 살펴보세요. 뉴스 화면의 각 기사를 누르면 원문을 확인할 수 있어요.' },
    { title: '불확실성을 함께 살펴요', body: '기준 시각과 대상 주간을 확인하세요. 최근 7일의 기사 수와 상충 여부에 따라 근거 수준이 달라지고, 뉴스가 적거나 오래되거나 서로 충돌하면 판단을 유보해요.' },
  ];
  const focusTitle = () => {
    const node = findNodeHandle(titleRef.current);
    if (node) AccessibilityInfo.setAccessibilityFocus(node);
  };
  return <>
    <Pressable accessibilityRole="button" accessibilityLabel={title}
      accessibilityHint="세 단계 사용 안내를 엽니다."
      onPress={() => { Keyboard.dismiss(); setVisible(true); }}
      style={({ pressed }) => [styles.helpButton, pressed && styles.pressed]}>
      <Text style={styles.helpButtonIcon} aria-hidden>?</Text><Text style={styles.helpButtonText}>{title}</Text>
    </Pressable>
    <Modal visible={visible} transparent animationType="fade" presentationStyle="overFullScreen"
      onRequestClose={() => setVisible(false)} onShow={focusTitle}>
      <View style={styles.helpOverlay}>
        <View style={styles.helpSheet} accessibilityViewIsModal importantForAccessibility="yes">
          <View style={styles.helpHeader}>
            <View style={styles.flex}><Text style={styles.helpEyebrow}>MONEYCAST GUIDE</Text>
              <Text ref={titleRef} accessible accessibilityRole="header" style={styles.helpTitle}>{title}</Text></View>
            <Pressable accessibilityRole="button" accessibilityLabel={`${title} 닫기`} onPress={() => setVisible(false)}
              style={({ pressed }) => [styles.helpClose, pressed && styles.pressed]}>
              <Text style={styles.helpCloseText}>닫기</Text>
            </Pressable>
          </View>
          <ScrollView style={styles.helpScroll} contentContainerStyle={styles.helpBody} keyboardShouldPersistTaps="handled">
            <Text style={styles.helpIntroduction}>{calculator ? '세 단계로 나의 목표 자산을 그려보세요.' : '뉴스의 맥락과 근거를 차분하게 확인하세요.'}</Text>
            {steps.map((step, index) => <View key={step.title} style={styles.helpStep}>
              <Text style={styles.helpStepNumber}>{String(index + 1).padStart(2, '0')}</Text>
              <View style={styles.flex}><Text accessibilityRole="header" style={styles.helpStepTitle}>{step.title}</Text>
                <Text style={styles.helpStepBody}>{step.body}</Text></View>
            </View>)}
            <View style={styles.helpNotice}>
              <Text accessibilityRole="header" style={styles.helpNoticeTitle}>{calculator ? '계산 가정을 확인하세요' : '실제 뉴스 연결과 투자 유의 사항'}</Text>
              <Text style={styles.helpNoticeBody}>{calculator
                ? '월 수익률은 (1 + 연 수익률 / 100)^(1/12) − 1로 변환하며, 월 복리·월말 납입으로 계산해요. 계산 중에는 반올림하지 않고 표시할 때 원 단위로 반올림해요.'
                : '실제 뉴스는 제공자 연동 후 표시돼요. 연동 대기 중에는 기사나 방향 전망을 만들어 보여주지 않아요. 서버 연결이나 제공자 설정이 필요하면 뉴스 화면에 안내해요.'}</Text>
              <Text style={styles.helpNoticeBody}>{calculator
                ? '세금·수수료는 반영하지 않아요. 물가상승은 켠 경우 목표 금액에만 가정으로 반영해요. 수익률은 입력한 가정이며 실제 수익을 보장하지 않아요. 원금 손실이 발생할 수 있어요.'
                : '근거 수준은 예측 정확도가 아니에요. 뉴스는 미래 주가의 원인이나 방향을 증명하지 않으며, 이 정보는 개인 맞춤형 매수·매도 지시가 아니에요. 투자에는 원금 손실 위험이 있어요.'}</Text>
            </View>
          </ScrollView>
          <View style={styles.helpFooter}><Pressable accessibilityRole="button" onPress={() => setVisible(false)}
            style={({ pressed }) => [styles.helpConfirm, pressed && styles.pressed]}><Text style={styles.helpConfirmText}>알겠어요</Text></Pressable></View>
        </View>
      </View>
    </Modal>
  </>;
}

function GrowthChart({ projection, target }: { projection: Projection; target: number }) {
  const [selected, setSelected] = useState(0);
  const samples = useMemo(() => {
    const length = projection.points.length;
    const count = Math.min(9, length);
    return Array.from({ length: count }, (_, index) => projection.points[Math.round(index * (length - 1) / (count - 1))]);
  }, [projection]);
  useEffect(() => { setSelected(samples.length - 1); }, [samples]);
  const point = samples[Math.min(selected, samples.length - 1)];
  const maximum = Math.max(...samples.map(item => Math.max(item.balance, item.principal)), target, 1) * 1.15;
  const chartHeight = 164;
  const targetPercent = target / maximum * 100;
  return <View style={styles.card}>
    <View style={styles.rowBetween}><Text style={styles.cardTitle}>자산이 자라는 시간</Text><Text style={styles.tiny}>월 복리 · 월말 납입</Text></View>
    <Text style={styles.bodyMuted}>막대를 눌러 시점별 예상 자산을 확인하세요.</Text>
    <View style={styles.chartSelection} accessibilityLiveRegion="polite">
      <Text style={styles.tiny}>{point.month === 0 ? '지금' : `${formatDurationMonths(point.month)} 후`}</Text>
      <Text style={styles.selectedAmount}>{formatKRW(point.balance)}</Text>
      <Text style={styles.tiny}>납입 원금 {formatCompactKRW(point.principal)} · 예상 수익 {formatCompactKRW(point.profit)}</Text>
    </View>
    <View style={[styles.plot, { height: chartHeight }]}>
      {target > 0 && <View pointerEvents="none" style={[styles.targetLine, { bottom: `${targetPercent}%` }]}>
        <Text style={styles.targetLabel}>목표 {formatCompactKRW(target)}</Text>
      </View>}
      <View style={styles.bars}>
        {samples.map((item, index) => <Pressable key={item.month} accessibilityRole="button"
          accessibilityLabel={`${item.month}개월, 예상 자산 ${formatKRW(item.balance)}, 원금 ${formatKRW(item.principal)}`}
          accessibilityState={{ selected: index === selected }} onPress={() => setSelected(index)} style={styles.barTouch}>
          <View style={[styles.barPrincipal, { height: Math.max(3, item.principal / maximum * chartHeight) }]} />
          <View style={[styles.barBalance, index === selected && styles.barActive,
            { height: Math.max(3, item.balance / maximum * chartHeight) }]} />
        </Pressable>)}
      </View>
    </View>
    <View style={styles.rowBetween}><Text style={styles.tiny}>현재</Text><Text style={styles.tiny}>{formatDurationMonths(projection.months)} 후</Text></View>
    <View style={styles.legend}><View style={[styles.legendDot, { backgroundColor: '#b8c8c5' }]} /><Text style={styles.tiny}>납입 원금</Text>
      <View style={[styles.legendDot, { backgroundColor: '#319b80' }]} /><Text style={styles.tiny}>예상 자산</Text></View>
  </View>;
}

/** One goal entry, with the calculator fields' look; amounts are kept without commas like the other fields. */
function GoalInput({ label, value, onChange, unit = '원', error, hint, placeholder, text = false, maxLength = 22, multiline = false }: {
  label: string; value: string; onChange: (value: string) => void; unit?: string; error?: string; hint?: string;
  placeholder?: string; text?: boolean; maxLength?: number; multiline?: boolean;
}) {
  const parsed = text ? null : parseGoalNumber(value);
  const amount = unit === '원' && parsed !== null && Number.isFinite(parsed) && parsed >= 0 ? formatCompactKRW(parsed) : '';
  const note = [amount, hint].filter(Boolean).join(' · ');
  return <View style={styles.field}>
    <Text style={styles.fieldLabel}>{label}</Text>
    <View style={[styles.inputWrap, error ? styles.inputError : null]}>
      <TextInput value={value} onChangeText={next => onChange(text ? next : next.replace(/,/g, ''))}
        accessibilityLabel={text ? label : `${label}, ${unit}`} accessibilityHint={hint} placeholder={placeholder} placeholderTextColor="#8b9897"
        keyboardType={text ? 'default' : unit === '원' || unit === '%' ? 'decimal-pad' : 'number-pad'}
        style={[styles.input, multiline && styles.inputMultiline]} selectTextOnFocus={!text} returnKeyType={multiline ? 'default' : 'done'} maxLength={maxLength} multiline={multiline} />
      {text ? null : <Text style={styles.inputUnit}>{unit}</Text>}
    </View>
    {error ? <Text accessibilityRole="alert" style={styles.errorText}>{error}</Text> : note ? <Text style={styles.fieldHint}>{note}</Text> : null}
  </View>;
}

function GoalChoice<T extends string>({ label, value, options, onChange, note }: {
  label: string; value: T; options: readonly (readonly [T, string])[]; onChange: (value: T) => void; note?: string;
}) {
  return <View style={styles.field}>
    <Text style={styles.fieldLabel}>{label}</Text>
    <View style={styles.chips}>{options.map(([option, text]) => <Chip key={option} label={text} selected={value === option} onPress={() => onChange(option)} />)}</View>
    {note ? <Text style={styles.fieldHint}>{note}</Text> : null}
  </View>;
}

function GoalLink({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.goalLink, (pressed || disabled) && styles.pressed]}>
    <Text style={styles.goalLinkText}>{label}</Text>
  </Pressable>;
}

/** Another way to enter the saving period: the month the goal is due, applied to the period field. */
function TargetMonthInput({ months, onMonths }: { months: number; onMonths: (months: number) => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const now = new Date();
  const valid = Number.isInteger(months) && months >= 1 && months <= 600;
  const apply = () => {
    const result = monthsFromTargetMonth(text, now);
    if ('months' in result) {
      onMonths(result.months);
      setText('');
      setError('');
    } else setError(result.error);
  };
  return <>
    <GoalInput text label="목표 시점으로 정하기(선택)" value={text} maxLength={10} error={error}
      placeholder={valid ? monthInputValue(periodEndMonth(months, now)) : '2028-03'} hint="2028-03처럼 연도와 월을 입력하고 적용을 누르면 목표 기간이 바뀌어요."
      onChange={value => { setText(value); setError(''); }} />
    <GoalLink label="목표 시점 적용" disabled={!text.trim()} onPress={apply} />
  </>;
}

type FactKey = 'name' | 'amount' | 'items' | 'months';
const ALL_CHOSEN: Record<FactKey, boolean> = { name: true, amount: true, items: true, months: true };
const positiveNumber = (text: string) => {
  const value = parseGoalNumber(text);
  return value !== null && Number.isFinite(value) && value > 0 ? value : null;
};
const wholeMonths = (text: string) => {
  const value = positiveNumber(text);
  return value !== null && Number.isInteger(value) && value <= 600 ? value : null;
};

/**
 * Reads the free goal's description on the device first; found facts apply
 * only when ticked, at most two fixed questions ask for the rest, and the
 * optional AI reading is offered only when the rules fall short.
 */
function GoalAssist({ state, dispatch, onPeriod }: {
  state: GoalPlannerState; dispatch: React.Dispatch<GoalPlannerAction>; onPeriod: (months: number) => void;
}) {
  const note = state.drafts.free.note;
  const [found, setFound] = useState<{ text: string; category: GoalCategory; title: string; facts: GoalTextFacts; personalData: boolean; provider?: GoalAiProvider } | null>(null);
  const [chosen, setChosen] = useState(ALL_CHOSEN);
  const [answered, setAnswered] = useState<GoalQuestionId[]>([]);
  const [ai, setAi] = useState<GoalAiAvailability>(GOAL_AI_OFF);
  const [asking, setAsking] = useState(false);
  const [sent, setSent] = useState('');
  const [notice, setNotice] = useState('');
  const [living, setLiving] = useState({ monthly: '', months: '' });
  const [period, setPeriod] = useState('');
  const apply = (actions: readonly GoalPlannerAction[]) => actions.forEach(dispatch);
  const analyze = () => {
    const analysis = analyzeGoalText(note, new Date());
    setFound({ text: note, category: analysis.category, title: categoryGoalName(analysis.category), facts: analysis.facts, personalData: analysis.personalData });
    setChosen(ALL_CHOSEN);
    setAnswered([]);
    setNotice('');
    void loadGoalAiAvailability().then(setAi);
  };
  const askAi = async () => {
    const text = note;
    setAsking(true);
    setSent(text);
    setNotice('');
    const result = await clarifyGoalText(text);
    setAsking(false);
    if (result.status !== 'ok' || !result.category) {
      setNotice(goalAiFailure(result, formatNewsTime));
      return;
    }
    const category = result.category;
    setFound(current => current && current.text === text ? {
      ...current, category, title: result.title ?? categoryGoalName(category), provider: result.provider, facts: { ...current.facts, ...result.facts },
    } : current);
    setChosen(ALL_CHOSEN);
    setAnswered([]);
  };
  const answer = (question: GoalQuestionId) => setAnswered(old => [...old, question]);
  const findButton = <GoalLink label="설명에서 정보 찾기" disabled={!note.trim()} onPress={analyze} />;
  if (!found) return findButton;

  const { facts, category } = found;
  const name = found.title && found.title !== state.drafts.free.name.trim() ? found.title : '';
  const options: Array<{ key: FactKey; label: string }> = [
    ...(name ? [{ key: 'name' as const, label: `목표 이름: ${name}` }] : []),
    ...(facts.amount ? [{ key: 'amount' as const, label: `목표 금액: ${formatCompactKRW(facts.amount.value)} (“${facts.amount.text}”)` }] : []),
    ...(facts.items ? [{ key: 'items' as const, label: `항목: ${facts.items.map(item => `${item.label || '항목'} ${formatCompactKRW(item.value)}`).join(' · ')}` }] : []),
    ...(facts.months ? [{ key: 'months' as const, label: `목표 기간: ${formatDurationMonths(facts.months.value)} (“${facts.months.text}”)` }] : []),
  ];
  const picked = (key: FactKey) => chosen[key] && options.some(option => option.key === key);
  const applyFound = () => {
    apply(goalFactActions({
      ...(picked('name') ? { name } : {}),
      ...(picked('amount') && facts.amount ? { amount: facts.amount.value } : {}),
      ...(picked('items') && facts.items ? { items: facts.items } : {}),
    }, String));
    if (picked('months') && facts.months) onPeriod(facts.months.value);
    setNotice('선택한 정보를 적용했어요. 각 칸에서 언제든 고칠 수 있어요.');
    if (picked('months')) answer('period');
  };
  const resolution = resolveGoalTarget('free', state.drafts, state.overrides.free);
  const amountKnown = state.overrides.free !== undefined || (state.drafts.free.method === 'items' && resolution.source === 'details');
  const questions = planGoalQuestions(found, { amountKnown }).filter(question => !answered.includes(question));
  const type = categoryGoalType(category);
  const prefill = describeSwitchPrefill(category, facts);
  const monthly = positiveNumber(living.monthly);
  const livingMonths = wholeMonths(living.months);
  const periodMonths = wholeMonths(period);
  const offerAi = ai.enabled && !found.provider && !found.personalData && note.trim() !== '' && note.length <= ai.maxLength &&
    (!facts.amount && !facts.items || category === 'other') && sent !== note;

  return <>
    {findButton}
    <View style={styles.goalAssist}>
      <View style={styles.rowBetween}>
        <Text accessibilityRole="header" style={styles.goalDetailsTitle}>설명에서 찾은 정보</Text>
        <GoalLink label="닫기" onPress={() => setFound(null)} />
      </View>
      <Text style={styles.fieldHint}>{goalFoundSource(found.provider)} 분류: {categoryLabel(category)}</Text>
      {found.text !== note ? <Text style={styles.fieldHint}>설명이 바뀌었어요. 다시 찾으려면 ‘설명에서 정보 찾기’를 눌러 주세요.</Text> : null}
      {!facts.amount && !facts.items && !facts.months ? <Text style={styles.fieldHint}>설명에서 금액이나 기간을 찾지 못했어요.</Text> : null}
      {options.length > 0 && <>
        <View style={styles.chips}>{options.map(option => <Chip key={option.key} label={option.label} selected={chosen[option.key]}
          onPress={() => setChosen(old => ({ ...old, [option.key]: !old[option.key] }))} />)}</View>
        <GoalLink label="선택한 정보 적용" disabled={!options.some(option => chosen[option.key])} onPress={applyFound} />
      </>}
      {notice ? <Text style={styles.goalNotice}>{notice}</Text> : null}
      {found.personalData ? <Text style={styles.goalNotice}>{GOAL_PERSONAL_DATA_NOTICE}</Text> : null}
      {questions.map(question => <View key={question} style={styles.goalQuestion}>
        <Text style={styles.fieldLabel}>{goalQuestionText(question, category)}</Text>
        {question === 'amount' && <View style={styles.chips}>
          <Chip label="금액 직접 입력" onPress={() => { dispatch({ type: 'freeMethod', method: 'direct' }); answer('amount'); }} />
          <Chip label="항목별로 나눠 보기" onPress={() => { dispatch({ type: 'freeMethod', method: 'items' }); answer('amount'); }} />
          <Chip label="아직 몰라요" onPress={() => { dispatch({ type: 'freeMethod', method: 'undecided' }); answer('amount'); }} />
        </View>}
        {question === 'livingCost' && <>
          <GoalInput label="한 달 생활비" value={living.monthly} onChange={value => setLiving(old => ({ ...old, monthly: value }))} />
          <GoalInput label="몇 개월치" unit="개월" value={living.months} onChange={value => setLiving(old => ({ ...old, months: value }))} />
          <GoalLink label="적용" disabled={monthly === null || livingMonths === null}
            onPress={() => { apply(livingCostActions(monthly!, livingMonths!, String)); answer('livingCost'); }} />
        </>}
        {question === 'switchType' && type && <>
          {prefill ? <Text style={styles.fieldHint}>{prefill}</Text> : null}
          <GoalLink label={`‘${goalTypeName(type)}’ 목표로 바꾸기`} onPress={() => apply(goalSwitchActions(category, facts, String))} />
        </>}
        {question === 'period' && <>
          <GoalInput label="모을 기간" unit="개월" value={period} onChange={setPeriod} />
          <GoalLink label="적용" disabled={periodMonths === null} onPress={() => { onPeriod(periodMonths!); answer('period'); }} />
        </>}
        <GoalLink label="건너뛰기" onPress={() => answer(question)} />
      </View>)}
      {offerAi && <View style={styles.goalQuestion}>
        <Text style={styles.fieldHint}>{goalAiNotice(ai.providers)}</Text>
        <GoalLink label={asking ? 'AI가 정리하고 있어요…' : 'AI로 다시 정리하기'} disabled={asking} onPress={() => void askAi()} />
      </View>}
    </View>
  </>;
}

/** The selected type's required entries; the web also offers optional labels, costs and a memo. */
function GoalDetails({ state, resolution, dispatch, onPeriod }: {
  state: GoalPlannerState; resolution: GoalTargetResolution; dispatch: React.Dispatch<GoalPlannerAction>; onPeriod: (months: number) => void;
}) {
  const { goal, drafts } = state;
  const { errors } = resolution;
  if (goal === 'free') {
    const free = drafts.free;
    const setItems = (items: GoalDrafts['free']['items']) => dispatch({ type: 'update', goal: 'free', patch: { items } });
    const setItem = (index: number, patch: Partial<GoalDrafts['free']['items'][number]>) =>
      setItems(free.items.map((item, position) => position === index ? { ...item, ...patch } : item));
    return <>
      <GoalInput text label="목표 이름" value={free.name} maxLength={GOAL_NAME_MAX_LENGTH} placeholder="예: 결혼 자금" hint="결과에 이 이름으로 표시돼요."
        onChange={name => dispatch({ type: 'update', goal: 'free', patch: { name } })} />
      <GoalInput text multiline label="설명(선택)" value={free.note} maxLength={GOAL_NOTE_MAX_LENGTH} placeholder="예: 2년 안에 결혼, 예식 2천만 원이랑 신혼여행 500만 원"
        hint="이 기기에서 먼저 정리하고, 앱을 닫으면 지워져요." onChange={note => dispatch({ type: 'update', goal: 'free', patch: { note } })} />
      <GoalAssist state={state} dispatch={dispatch} onPeriod={onPeriod} />
      <GoalChoice label="금액 정하는 방법" value={free.method} onChange={method => dispatch({ type: 'freeMethod', method })}
        options={[['direct', '직접 입력'], ['items', '항목 합산'], ['undecided', '아직 모름']]} />
      {free.method === 'items' && <>
        {free.items.map((item, index) => <View key={index} style={styles.goalItem}>
          <GoalInput text label={`항목 ${index + 1} 이름`} value={item.label} maxLength={GOAL_LABEL_MAX_LENGTH} placeholder="예: 예식장" onChange={label => setItem(index, { label })} />
          <GoalInput label={`항목 ${index + 1} 금액`} value={item.amount} error={errors[`items.${index}.amount`]} onChange={amount => setItem(index, { amount })} />
          {free.items.length > 1 && <GoalLink label={`항목 ${index + 1} 삭제`} onPress={() => setItems(free.items.filter((_, position) => position !== index))} />}
        </View>)}
        {free.items.length < GOAL_ITEM_LIMIT && <GoalLink label="+ 항목 추가" onPress={() => setItems([...free.items, { label: '', amount: '' }])} />}
      </>}
    </>;
  }
  if (goal === 'home' || goal === 'car') {
    const home = goal === 'home';
    const draft = home ? drafts.home : drafts.car;
    const set = (patch: Partial<GoalDrafts['home'] & GoalDrafts['car']>) => dispatch({ type: 'update', goal, patch } as GoalPlannerAction);
    return <>
      {home
        ? <GoalChoice label="모으려는 금액" value={drafts.home.scope} note={HOME_SCOPE_NOTES[drafts.home.scope]}
          onChange={scope => dispatch({ type: 'update', goal: 'home', patch: { scope } })}
          options={[['full', HOME_SCOPE_LABELS.full], ['equity', HOME_SCOPE_LABELS.equity], ['initial', HOME_SCOPE_LABELS.initial]]} />
        : <GoalChoice label="모으려는 금액" value={drafts.car.scope} note={CAR_SCOPE_NOTES[drafts.car.scope]}
          onChange={scope => dispatch({ type: 'update', goal: 'car', patch: { scope } })}
          options={[['full', CAR_SCOPE_LABELS.full], ['initial', CAR_SCOPE_LABELS.initial]]} />}
      <GoalInput label={home ? '예상 매입 가격' : '예상 차량 가격'} value={draft.price} error={errors.price} hint={home ? undefined : '트림·옵션을 포함한 금액'}
        onChange={price => set({ price })} />
      {home && drafts.home.scope === 'equity' && <GoalInput label="대출 예정 금액" value={drafts.home.loan} error={errors.loan} onChange={loan => set({ loan })} />}
      {draft.scope === 'initial' && <>
        <GoalChoice label="초기 자금 입력 방식" value={draft.initialBy} onChange={initialBy => set({ initialBy })} options={[['rate', '가격의 비율로'], ['amount', '금액으로']]} />
        {draft.initialBy === 'rate'
          ? <GoalInput label="초기 자금 비율" unit="%" value={draft.initialRate} error={errors.initialRate} onChange={initialRate => set({ initialRate })} />
          : <GoalInput label="초기 자금" value={draft.initialAmount} error={errors.initialAmount} onChange={initialAmount => set({ initialAmount })} />}
      </>}
    </>;
  }
  const trip = drafts.travel;
  const set = (patch: Partial<GoalDrafts['travel']>) => dispatch({ type: 'update', goal: 'travel', patch });
  const nights = parseGoalNumber(trip.nights);
  return <>
    <GoalInput text label="여행지" value={trip.destination} maxLength={GOAL_LABEL_MAX_LENGTH} placeholder="예: 오사카" onChange={destination => set({ destination })} />
    <GoalChoice label="예산 정하는 방법" value={trip.method} onChange={method => set({ method })} options={[['total', '총액 입력'], ['items', '항목별 계산']]}
      note={trip.method === 'items' ? '항목 금액에 인원·박 수·일 수를 곱해 더해요. 비운 항목은 0원으로 계산해요.' : undefined} />
    {trip.method === 'total'
      ? <GoalInput label="총 예산" value={trip.total} error={errors.total} onChange={total => set({ total })} />
      : <>
        <GoalInput label="인원" unit="명" value={trip.travelers} error={errors.travelers} onChange={travelers => set({ travelers })} />
        <GoalInput label="박 수" unit="박" value={trip.nights} error={errors.nights} onChange={value => set({ nights: value })} />
        <GoalInput label="일 수" unit="일" value={trip.days} error={errors.days} hint="비우면 박 수 + 1일"
          placeholder={nights !== null && Number.isInteger(nights) && nights >= 0 ? String(nights + 1) : undefined} onChange={days => set({ days })} />
        <GoalInput label="항공권(1인 왕복)" value={trip.flight} error={errors.flight} onChange={flight => set({ flight })} />
        <GoalInput label="숙박비(1박 전체)" value={trip.lodging} error={errors.lodging} onChange={lodging => set({ lodging })} />
        <GoalInput label="현지 경비(1인 1일)" value={trip.daily} error={errors.daily} onChange={daily => set({ daily })} />
        <GoalInput label="기타 비용" value={trip.other} error={errors.other} hint="보험·비자·쇼핑 등" onChange={other => set({ other })} />
      </>}
  </>;
}

function CalculatorScreen() {
  const [form, setForm] = useState(INITIAL_FORM);
  const [goalState, dispatchGoal] = useReducer(updateGoalPlanner, undefined, () => createGoalPlanner());
  const override = goalState.overrides[goalState.goal];
  const resolution = useMemo(() => resolveGoalTarget(goalState.goal, goalState.drafts, override), [goalState, override]);
  const { width } = useWindowDimensions();
  const months = form.months.trim() === '' ? Number.NaN : Number(form.months);
  // Undecided goals compare against no target, like an explicit 0; an assumed price rise raises the amount compared.
  const comparison = useMemo(() => compareGoalTarget(resolution, goalState.inflation, months), [resolution, goalState.inflation, months]);
  const input = useMemo(() => {
    const values = Object.fromEntries(Object.entries(form).map(([key, value]) =>
      [key, value.trim() === '' ? Number.NaN : Number(value)])) as Record<Field, number>;
    const { months: durationMonths, ...amounts } = values;
    return { ...amounts, years: durationMonths / 12, target: comparison.target } satisfies CalculatorInput;
  }, [form, comparison.target]);
  const errors = useMemo(() => {
    const result = validateCalculatorInput(input);
    if (result.years) { result.months = result.years; delete result.years; }
    if (Number.isFinite(months) && !Number.isInteger(months)) result.months = '목표 기간은 1개월 단위의 정수로 입력해 주세요.';
    return result;
  }, [input, months]);
  const projection = useMemo(() => {
    if (Object.keys(errors).length) return null;
    try { return calculateProjection(input); } catch { return null; }
  }, [input, errors]);
  const change = (field: Field, text: string) => setForm(previous => ({ ...previous, [field]: text.replace(/,/g, '') }));
  const targetText = override ?? (resolution.amount !== null && Number.isFinite(resolution.amount) ? String(resolution.amount) : '');
  // A rejected price-rise rate is reported on its own field, not as a target error.
  const targetError = comparison.error ? undefined : errors.target;
  const targetInvalid = Boolean(targetError) || Object.keys(resolution.errors).length > 0;
  const targetNote = resolution.source === 'manual' && targetError ? targetError : describeGoalTarget(resolution, formatCompactKRW);
  const followable = override !== undefined && (goalState.goal !== 'free' || goalState.drafts.free.method !== 'direct');
  return <ScrollView contentContainerStyle={[styles.content, width > 700 && styles.tabletContent]} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
    <View style={styles.eyebrow}><View style={styles.greenDot} /><Text style={styles.eyebrowText}>목표가 있는 돈의 여정</Text></View>
    <Text style={styles.pageTitle}>작은 시작이{ '\n' }어떤 미래가 될까요?</Text>
    <Text style={styles.pageDescription}>나의 속도로 모으고, 숫자로 그려보세요.</Text>
    <UsageHelp feature="calculator" />
    <View style={styles.card}>
      <View style={styles.rowBetween}><Text style={styles.cardTitle}>나의 목표 설정</Text><Text style={styles.stepLabel}>01 / PLAN</Text></View>
      <Text style={styles.bodyMuted}>예시 금액으로 시작하고, 필요한 칸만 채우면 목표 금액이 계산돼요.</Text>
      <View style={styles.chips}>
        {GOAL_TYPES.map(type => <Chip key={type.id} label={type.name} selected={goalState.goal === type.id}
          onPress={() => dispatchGoal({ type: 'select', goal: type.id })} />)}
      </View>
      <View style={styles.goalDetails}>
        <Text accessibilityRole="header" style={styles.goalDetailsTitle}>{goalTypeName(goalState.goal)} 정보</Text>
        <Text style={styles.fieldHint}>{GOAL_SOURCE_NOTES[goalState.goal]}</Text>
        <GoalDetails state={goalState} resolution={resolution} dispatch={dispatchGoal} onPeriod={months => change('months', String(months))} />
      </View>
      <View style={styles.field}>
        <View style={styles.rowBetween}>
          <Text style={styles.fieldLabel}>목표 금액</Text>
          <Text style={[styles.goalBadge, GOAL_BADGE_COLORS[resolution.source]]}>{GOAL_SOURCE_LABELS[resolution.source]}</Text>
        </View>
        <View style={[styles.inputWrap, targetInvalid ? styles.inputError : null]}>
          <TextInput value={targetText} onChangeText={text => dispatchGoal({ type: 'typeTarget', text: text.replace(/,/g, '') })}
            accessibilityLabel={`목표 금액, 원, ${GOAL_SOURCE_LABELS[resolution.source]}`} accessibilityHint={targetNote}
            placeholder={resolution.source === 'undecided' ? '미정' : undefined} placeholderTextColor="#8b9897"
            keyboardType="decimal-pad" style={styles.input} selectTextOnFocus returnKeyType="done" maxLength={22} />
          <Text style={styles.inputUnit}>원</Text>
        </View>
        {targetInvalid ? <Text accessibilityRole="alert" style={styles.errorText}>{targetNote}</Text> : <Text style={styles.fieldHint}>{targetNote}</Text>}
        {resolution.source === 'details' && resolution.lines.length > 0
          ? <Text style={styles.fieldHint}>= {formatGoalFormula(resolution.lines, formatCompactKRW)}</Text> : null}
        {resolution.source === 'details' && resolution.zeroed.length > 0
          ? <Text style={styles.fieldHint}>{resolution.zeroed.join(', ')}: 입력하지 않아 0원으로 계산했어요.</Text> : null}
        {followable ? <GoalLink label="상세 입력으로 다시 계산" onPress={() => dispatchGoal({ type: 'followDetails' })} /> : null}
        <View style={styles.chips}>
          <Chip label="물가상승 반영(선택)" selected={goalState.inflation.on} onPress={() => dispatchGoal({ type: 'inflation', patch: { on: !goalState.inflation.on } })} />
        </View>
        {goalState.inflation.on ? <>
          <Text style={styles.fieldHint}>목표 금액을 오늘 가격으로 보고, 목표 기간 동안 매년 이 비율로 오른다고 가정해 비교해요. 예측이 아닌 나의 가정이에요.</Text>
          <GoalInput label="연 물가상승률" unit="%" value={goalState.inflation.rate} error={comparison.error} hint={describeInflation(comparison, formatCompactKRW)}
            onChange={rate => dispatchGoal({ type: 'inflation', patch: { rate } })} />
        </> : null}
      </View>
      {fields.map(field => <View key={field.key} style={styles.field}>
        <Text style={styles.fieldLabel} nativeID={`label-${field.key}`}>{field.label}</Text>
        <View style={[styles.inputWrap, errors[field.key] ? styles.inputError : null]}>
          <TextInput value={form[field.key]} onChangeText={text => change(field.key, text)}
            accessibilityLabel={`${field.label}, ${field.unit}`} accessibilityHint={field.hint}
            accessibilityLabelledBy={`label-${field.key}`}
            keyboardType={field.key === 'months' ? 'number-pad' : field.key === 'annualRate' ? 'numbers-and-punctuation' : 'decimal-pad'}
            style={styles.input} selectTextOnFocus returnKeyType="done" maxLength={22} />
          <Text style={styles.inputUnit}>{field.unit}</Text>
        </View>
        {errors[field.key] ? <Text accessibilityRole="alert" style={styles.errorText}>{errors[field.key]}</Text>
          : field.key === 'months' ? <Text style={styles.fieldHint}>{formatDurationMonths(months)} · {formatYearMonth(periodEndMonth(months, new Date()))}까지 · 1~600개월, 1개월 단위</Text>
            : field.unit === '원' && form[field.key] !== '' && Number.isFinite(Number(form[field.key]))
              ? <Text style={styles.fieldHint}>{formatCompactKRW(Number(form[field.key]))}</Text> : null}
      </View>)}
      <TargetMonthInput months={months} onMonths={value => change('months', String(value))} />
      <View style={styles.inlineNotice}><Text style={styles.noticeSymbol}>i</Text><Text style={styles.noticeText}>입력을 바꾸면 결과가 바로 달라집니다. 수익률은 확정 전망이 아닌 나의 가정입니다.</Text></View>
    </View>

    {projection ? <>
      <View style={styles.resultCard} accessibilityLiveRegion="polite">
        <View style={styles.rowBetween}><Text style={styles.resultLabel}>{formatDurationMonths(projection.months)} 후 예상 자산</Text><Text style={styles.resultPill}>MY FORECAST</Text></View>
        <Text style={styles.resultAmount}>{formatCompactKRW(projection.finalBalance)}</Text>
        <Text style={styles.resultExact}>{formatKRW(projection.finalBalance)}</Text>
        <View style={styles.resultDivider} />
        <View style={styles.rowBetween}><Text style={styles.resultSecondary}>총 납입 원금</Text><Text style={styles.resultValue}>{formatKRW(projection.totalPrincipal)}</Text></View>
        <View style={styles.rowBetween}><Text style={styles.resultSecondary}>예상 수익</Text><Text style={styles.resultValue}>{projection.totalProfit >= 0 ? '+' : ''}{formatKRW(projection.totalProfit)}</Text></View>
        <Text style={styles.goalResult}>{describeGoalResult(goalState.goal, goalState.drafts, resolution, formatCompactKRW, comparison.inflation?.amount)}</Text>
        {resolution.source === 'undecided' && <View style={styles.achievement}>
          <Text style={styles.achievementTitle}>목표 금액이 아직 정해지지 않았어요</Text>
          <Text style={styles.achievementBody}>{resolution.missing.length
            ? `목표 상세의 빈 칸(${resolution.missing.join(', ')})을 채우면 달성률을 보여 드려요.`
            : '그래서 달성률은 계산하지 않았어요. 금액이 정해지면 직접 입력하거나 항목 합산을 골라 주세요.'}</Text>
        </View>}
        {input.target > 0 && <View style={styles.achievement}>
          <Text style={styles.achievementTitle}>{projection.achieved ? '목표에 닿을 수 있는 가정이에요' : '목표까지 조금 더 모아볼까요?'}</Text>
          <Text style={styles.achievementBody}>{projection.achieved
            ? `입력한 가정에서는 목표보다 ${formatKRW(Math.abs(projection.gap))} 많아요.`
            : `입력한 가정에서는 목표보다 ${formatKRW(Math.abs(projection.gap))} 부족해요.`}</Text>
        </View>}
      </View>
      <GrowthChart projection={projection} target={input.target} />
    </> : <View style={styles.emptyCard} accessibilityRole="alert"><Text style={styles.emptyTitle}>입력값을 확인해 주세요</Text><Text style={styles.bodyMuted}>{errors.projection ?? '표시된 오류를 수정하면 예상 자산과 차트가 갱신됩니다.'}</Text></View>}
    <View style={styles.assumptions}>
      <Text style={styles.assumptionsTitle}>계산을 읽기 전에</Text>
      <Text style={styles.assumptionsText}>연 유효수익률을 월 수익률로 변환해 매월 복리로 계산합니다. 월말에 납입하고, 계산 중에는 반올림하지 않으며 표시할 때 원 단위로 반올림합니다.</Text>
      <Text style={styles.assumptionsText}>세금·수수료는 반영하지 않습니다. 물가상승은 켠 경우 목표 금액에만 가정으로 반영합니다. 실제 수익은 달라질 수 있고 원금 손실이 발생할 수 있습니다.</Text>
    </View>
  </ScrollView>;
}

async function openArticle(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') throw new Error('unsafe');
    await Linking.openURL(parsed.toString());
  } catch { Alert.alert('링크를 열 수 없습니다', '올바른 HTTPS 원문 주소인지 확인해 주세요.'); }
}

function CompanyOption({ company, selected, onPress }: { company: Company; selected: boolean; onPress: () => void }) {
  return <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ selected }}
    accessibilityLabel={`${company.name}, ${company.symbol}, ${company.exchange}`}
    style={({ pressed }) => [styles.companyOption, selected && styles.companySelected, pressed && styles.pressed]}>
    <CompanyAvatar company={company} />
    <View style={styles.flex}><Text style={styles.companyName}>{company.name}</Text><Text style={styles.tiny}>{company.symbol} · {company.exchange} · {company.region}</Text></View>
    <Text style={[styles.selectionCircle, selected && styles.selectionCircleActive]}>{selected ? '✓' : '○'}</Text>
  </Pressable>;
}

const formatNewsTime = (value: string) => `${new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} KST`;
function newsLanguageLabel(code: string) {
  const labels: Record<string, string> = { ko: '한국어', en: '영어', ja: '일본어', zh: '중국어', de: '독일어', fr: '프랑스어', es: '스페인어' };
  return labels[code.toLowerCase()] || code;
}
function useNewsRetryDelay(retryAt?: string) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    const remaining = retryAt ? Date.parse(retryAt) - Date.now() : 0;
    if (remaining <= 0) return;
    // Updating this clock unlocks the button without requesting news.
    const timer = setTimeout(() => setNow(Date.now()), Math.min(remaining + 20, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [retryAt]);
  return !!retryAt && Date.parse(retryAt) > now;
}

function NewsScreen({ active }: { active: boolean }) {
  const [query, setQuery] = useState('');
  const [company, setCompany] = useState<Company>(companies[0]);
  const [analysis, setAnalysis] = useState<NewsAnalysis | null>(() => mobileNewsCache.peek(company.id));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [showUnrelated, setShowUnrelated] = useState(false);
  const retryDelayed = useNewsRetryDelay(analysis?.retryAt);
  const requestId = useRef(0);
  const results = useMemo(() => searchCompanies(query), [query]);
  const { width } = useWindowDimensions();
  useEffect(() => {
    const current = ++requestId.current;
    if (!active) { setLoading(false); return () => { ++requestId.current; }; }
    const cached = mobileNewsCache.peek(company.id);
    setAnalysis(cached); setError(''); setShowUnrelated(false);
    if (!API_URL || cached) { setLoading(false); return () => { ++requestId.current; }; }
    setLoading(true);
    void (async () => {
      try {
        const data = await mobileNewsCache.getAnalysis(company.id);
        if (current === requestId.current) setAnalysis(data);
      } catch (reason) {
        if (current === requestId.current) {
          setError(reason instanceof Error ? reason.message : '서버에 연결할 수 없습니다. API 주소와 네트워크를 확인해 주세요.');
        }
      } finally {
        if (current === requestId.current) setLoading(false);
      }
    })();
    // A departing screen ignores its result but never aborts a shared request.
    return () => { ++requestId.current; };
  }, [company.id, retry, active]);
  const sentimentLabels = { positive: '긍정', negative: '부정', neutral: '중립', unclassified: '미분류' };
  // Agreed AI labels keep their direction; one model's view is provisional and never aggregated.
  const articleLabel = (article: NewsArticle) => {
    if (article.aiRelevance === 'unrelated') return '관련성 낮음';
    if (article.aiConsensus === 'confirmed') return `${sentimentLabels[article.sentiment]} · AI 합의`;
    if (article.aiConsensus === 'withheld') return '판단 유보';
    const only = article.aiConsensus === 'provisional' ? article.aiJudgements?.[0] : undefined;
    if (article.aiConsensus === 'provisional') return only?.relevant && only.sentiment !== 'uncertain' ? `${sentimentLabels[only.sentiment]} · 잠정` : '관련성 확인 대기';
    return sentimentLabels[article.sentiment];
  };
  const aiLabels = { ok: '정상', idle: '새 판단 없음', not_configured: '미설정', rate_limited: '한도 도달', error: '응답 없음', timeout: '시간 초과' } as const;
  // A failed refresh shows the last successful result of this app session, labelled as old.
  const failed = !!error || analysis?.status === 'error' || analysis?.status === 'rate_limited';
  const fallback = failed ? mobileNewsCache.peekLastGood(company.id) : null;
  const shown = fallback ?? analysis;
  const stale = !!fallback || shown?.servedFrom === 'stale';
  const staleReason = fallback ? error || analysis?.message : shown?.message;
  const unavailable = shown && ['not_configured', 'error', 'rate_limited'].includes(shown.status);
  const marketaux = /marketaux/i.test(`${shown?.provider ?? ''} ${shown?.message ?? ''}`);
  // Articles both models judged unrelated are folded away and never counted.
  const related = shown?.articles.filter(article => article.aiRelevance !== 'unrelated') ?? [];
  const unrelated = shown?.articles.filter(article => article.aiRelevance === 'unrelated') ?? [];
  const articleCard = (article: NewsArticle) => <Pressable key={article.id} accessibilityRole="link" accessibilityLabel={`${article.title}, 원문 열기`}
                onPress={() => void openArticle(article.url)} style={styles.article}>
                <View style={styles.rowBetween}><Text style={styles.articleSource}>{article.source}</Text><Text style={styles.sentiment}>{articleLabel(article)}</Text></View>
                <Text style={styles.articleTitle}>{article.title} ↗</Text>
                <Text style={[styles.tiny, styles.blackText]}>핵심 요약{article.summary ? ` · AI 요약(${article.summary.basis === 'title_only' ? '제목만 기준, 본문 미확인' : '제목·설명 기준'})` : article.description ? ' · 매체 설명(원문)' : ''}</Text>
                <Text numberOfLines={3} style={styles.bodyMuted}>{article.summary?.text ?? article.description ?? '요약 정보 없음 — 원문에서 확인하세요.'}</Text>
                {article.rationaleLines ? <>
                  <Text style={[styles.tiny, styles.blackText]}>분류 근거</Text>
                  {article.rationaleLines.slice(0, 5).map((line, index) => <Text key={index} style={styles.bodyMuted}>{index + 1}. {line}</Text>)}
                </> : <Text style={styles.bodyMuted}>{article.rationale}</Text>}
                <Text style={[styles.tiny, styles.blackText]}>{article.timeKind === 'seen' ? `${article.sourceProvider ?? '수집기'} 확인` : '게시'}: {formatNewsTime(article.publishedAt)}{article.language ? ` · 원문 언어: ${newsLanguageLabel(article.language)}` : ''}</Text>
                {!article.rationaleLines && article.classificationMethod === 'provider' ? <Text style={[styles.tiny, styles.blackText]}>{shown?.provider || '뉴스 제공자'} 제공자 분류{article.sentimentScore !== undefined ? ` · 기사 감성 점수 ${String(article.sentimentScore)} (−1~1)` : ''} · 주가 상승 확률이 아닙니다.</Text> : null}
                {!article.rationaleLines && article.classificationMethod === 'unavailable' ? <Text style={[styles.tiny, styles.blackText]}>제공자 감성 점수가 없어 분류하지 않았습니다.</Text> : null}
                {!article.rationaleLines && article.providerEntity ? <Text style={[styles.tiny, styles.blackText]}>제공자 기업 식별: {article.providerEntity.name} · {article.providerEntity.symbol} · {article.providerEntity.exchange || '거래소 정보 미제공'} · {article.providerEntity.country.toUpperCase()}</Text> : null}
              </Pressable>;
  return <ScrollView contentContainerStyle={[styles.content, width > 700 && styles.tabletContent]} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
    <View style={styles.eyebrow}><View style={styles.greenDot} /><Text style={styles.eyebrowText}>뉴스의 맥락을 읽다</Text></View>
    <Text style={styles.pageTitle}>기업의 소식,{ '\n' }차분하게 살펴보기</Text>
    <Text style={styles.pageDescription}>뉴스의 근거와 불확실성을 함께 확인하세요.</Text>
    <UsageHelp feature="news" />
    <View style={styles.card}>
      <Text style={styles.cardTitle}>어떤 기업이 궁금하세요?</Text>
      <TextInput value={query} onChangeText={setQuery} accessibilityLabel="회사명 또는 종목 코드 검색"
        placeholder="회사명 또는 종목 코드" placeholderTextColor="#8b9897" autoCapitalize="none" style={styles.searchInput} />
      <Text style={styles.fieldHint}>정적 종목 목록입니다. 종목 코드와 시장을 확인하세요.</Text>
      {results.length ? results.map(item => <CompanyOption key={item.id} company={item} selected={item.id === company.id} onPress={() => setCompany(item)} />)
        : <Text accessibilityLiveRegion="polite" style={styles.noResults}>일치하는 종목이 없습니다. 회사명 또는 정확한 코드를 입력해 주세요.</Text>}
    </View>
    <View style={styles.card}>
      <View style={styles.rowBetween}><Text style={styles.cardTitle}>{company.name}</Text><Text style={styles.exchangeBadge}>{company.exchange}</Text></View>
      <Text style={styles.bodyMuted}>{company.symbol} · {company.region} · 뉴스 참고 정보</Text>
      {loading ? <View style={styles.emptyState}><ActivityIndicator size="large" color="#20795e" /><Text style={styles.bodyMuted}>뉴스 근거를 확인하고 있어요.</Text></View>
        : !API_URL ? <View style={styles.emptyState}>
          <Text style={styles.emptyIcon}>↗</Text><Text style={styles.emptyTitle}>서버 연결을 설정해 주세요</Text>
          <Text style={styles.emptyDescription}>뉴스용 백엔드 주소가 아직 없습니다. 앱의 EXPO_PUBLIC_API_URL을 설정하고 다시 실행하면 서버의 연동 상태를 확인할 수 있습니다.</Text>
          <Text style={styles.fieldHint}>계산기는 별도 연결 없이 사용할 수 있습니다.</Text>
        </View>
          : error && !fallback ? <View style={styles.emptyState} accessibilityRole="alert"><Text style={styles.emptyIcon}>!</Text><Text style={styles.emptyTitle}>연결을 확인해 주세요</Text><Text style={styles.emptyDescription}>{error}</Text>
            <Pressable accessibilityRole="button" onPress={() => setRetry(value => value + 1)} style={styles.primaryButton}><Text style={styles.primaryButtonText}>다시 시도</Text></Pressable>
          </View>
            : shown ? <>
              {stale ? <View style={styles.staleBanner} accessibilityRole="summary"><Text style={styles.staleTitle}>이전 결과</Text>
                <Text style={styles.bodyMuted}>새 기사를 불러오지 못해 {formatNewsTime(shown.asOf)} 기준 결과를 보여드립니다.{staleReason ? ` ${staleReason}` : ''}</Text></View> : null}
              <View style={[styles.analysisStatus, unavailable && styles.analysisUnavailable]}>
                <Text style={styles.analysisStatusTitle}>{shown.status === 'not_configured' ? '뉴스 제공자 연동 대기' : shown.status === 'error' ? '뉴스 요청 실패' : shown.status === 'rate_limited' ? '호출 제한 · 잠시 후 재시도' : shown.status === 'insufficient' ? '근거 부족 · 판단 유보' : '뉴스 기반 참고 정보'}</Text>
                <Text style={styles.analysisSummary}>{shown.summary}</Text>
                {shown.message && !stale ? <Text style={styles.bodyMuted}>{shown.message}</Text> : null}
                {shown.retryAt ? <Text style={styles.bodyMuted}>다시 요청 가능한 시각: {formatNewsTime(shown.retryAt)}</Text> : null}
              </View>
              {shown.status === 'not_configured' && <View style={styles.metadata}>
                <Text style={styles.bodyMuted}>프로젝트 루트 .env에 NEWS_PROVIDER=marketaux와 서버 전용 MARKETAUX_API_TOKEN을 설정하고 API 서버를 재시작하세요. 키는 앱이나 브라우저에 입력하지 않습니다. 기존 게이트웨이 설정은 서버 README를 확인하세요.</Text>
                <Pressable accessibilityRole="link" onPress={() => void openArticle('https://www.marketaux.com/')} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>Marketaux 계정 안내 열기 ↗</Text></Pressable>
              </View>}
              {marketaux && <Text style={[styles.bodyMuted, styles.secondaryText]}>Marketaux 무료 연동은 요청당 최대 3개 기사를 확인합니다. 최근 7일의 영어·한국어 기사 중 이 회사와 가장 강하게 연결된 기사를 고르며, 기사 부족·상충 시 판단을 유보합니다.</Text>}
              <View style={styles.metadata}><Text style={styles.tiny}>데이터 기준: {formatNewsTime(shown.asOf)}</Text>
                {shown.newsWindow ? <Text style={styles.tiny}>뉴스 수집 기간: {formatNewsTime(shown.newsWindow.start)} ~ {formatNewsTime(shown.newsWindow.end)}</Text> : null}
                <Text style={styles.tiny}>다음 주 참고 기간: {shown.period.start} ~ {shown.period.end}</Text>
                {shown.cachedUntil ? <Text style={styles.tiny}>서버 캐시 만료: {formatNewsTime(shown.cachedUntil)} · 그전에는 저장된 결과를 다시 보여줄 수 있습니다.</Text> : null}
                <Text style={styles.tiny}>근거 수준: {({ none: '없음', low: '낮음', moderate: '보통' })[shown.evidence]} · 뉴스 {related.length}건{unrelated.length ? ` · 관련성 낮음 ${unrelated.length}건` : ''}</Text>
                <Text style={styles.tiny}>근거 수준은 최근 7일의 기사 수와 상충 여부를 기준으로 하며, 예측 정확도가 아닙니다.</Text>
                <Text style={styles.tiny}>제공자: {shown.provider ?? '미설정'} · 분석 버전 {shown.analysisVersion}</Text>
                {shown.sources ? <Text style={styles.tiny}>출처 상태: {shown.sources.map(source => `${source.label} ${({ ok: `정상 ${source.articleCount}건`, empty: '기사 없음', skipped: '예약 수집 때만 조회', not_configured: '미설정', rate_limited: '호출 제한', error: '실패' })[source.status]}`).join(' · ')}</Text> : null}
                {shown.ai ? <Text style={styles.tiny}>AI 판단: {shown.ai.providers.map(model => `${model.label} ${aiLabels[model.status]}${model.status === 'ok' ? ` ${model.judgedCount}건` : ''}`).join(' · ')}{shown.ai.unrelatedCount > 0 ? ` · 관련성 낮은 기사 ${shown.ai.unrelatedCount}건은 목록 아래에 접어 둠` : ''}</Text> : null}
                {shown.articles.some(article => article.sourceProvider === 'GDELT') ? <Text style={styles.tiny}>일부 기사 목록은 GDELT Project(gdeltproject.org) 검색 결과이며, GDELT 시각은 기사를 처음 확인한 시각입니다.</Text> : null}
                {shown.articles.some(article => article.summary || article.aiJudgements) ? <Text style={styles.tiny}>일부 요약·분류는 AI(Gemini·Cloudflare Workers AI)가 기사 제목과 매체 설명만 보고 생성했으며 틀릴 수 있습니다.</Text> : null}
              </View>
              {related.length === 0 && <Text style={styles.noResults}>{unrelated.length ? '이 회사와 관련성이 높은 기사가 없습니다.' : '표시할 실제 뉴스가 없습니다. 설정되지 않은 데이터나 예시 기사는 표시하지 않습니다.'}</Text>}
              {related.some(article => article.sentiment === 'unclassified') && <Text style={styles.bodyMuted}>{shown.ai ? '미분류·잠정·판단 유보 기사는 긍정·부정 요인 집계에서 제외합니다.' : '미분류 기사는 긍정·부정 요인 집계에서 제외합니다.'}</Text>}
              {related.map(articleCard)}
              {unrelated.length > 0 && <>
                <Text style={styles.bodyMuted}>두 AI가 모두 이 회사 기사가 아니라고 판단한 기사 {unrelated.length}건은 요인 집계에서 뺐습니다.</Text>
                <Pressable accessibilityRole="button" accessibilityState={{ expanded: showUnrelated }} onPress={() => setShowUnrelated(value => !value)} style={styles.secondaryButton}>
                  <Text style={styles.secondaryButtonText}>{showUnrelated ? '관련성 낮은 기사 접기' : `관련성 낮은 기사 ${unrelated.length}건 보기`}</Text>
                </Pressable>
                {showUnrelated ? unrelated.map(articleCard) : null}
              </>}
              {[['긍정 요인', shown.positiveFactors], ['부정 요인', shown.negativeFactors], ['전망이 빗나갈 수 있는 이유', shown.risks]].map(([title, factors]) =>
                (factors as string[]).length > 0 && <View key={title as string} style={styles.factorSection}><Text style={styles.factorTitle}>{title as string}</Text>
                  {(factors as string[]).map((factor, index) => <Text key={index} style={styles.bodyMuted}>• {factor}</Text>)}</View>)}
              {shown.factorSummary ? <Text style={styles.tiny}>{[...shown.factorSummary.chips, shown.factorSummary.note].join(' · ')}</Text> : null}
              <Pressable accessibilityRole="button" accessibilityState={{ disabled: loading || retryDelayed }} disabled={loading || retryDelayed} onPress={() => setRetry(value => value + 1)} style={[styles.secondaryButton, (loading || retryDelayed) && styles.pressed]}><Text style={styles.secondaryButtonText}>연동 상태 새로고침</Text></Pressable>
            </> : null}
    </View>
    <View style={styles.assumptions}><Text style={styles.assumptionsTitle}>투자 전, 꼭 읽어 주세요</Text>
      <Text style={styles.assumptionsText}>뉴스의 긍정·부정 분류는 주가의 원인이나 미래 방향을 증명하지 않습니다. 기사 수가 적거나 오래되었거나 내용이 상충하면 판단을 유보합니다.</Text>
      <Text style={styles.assumptionsText}>이 정보는 개인 맞춤형 매수·매도 지시가 아닙니다. 투자에는 원금 손실 위험이 있으며 결정과 책임은 투자자 본인에게 있습니다. 대상 주간은 다음 달력 주의 월~금이며 거래소 휴장일은 반영하지 않습니다.</Text>
    </View>
  </ScrollView>;
}

export default function App() {
  const [fontsLoaded, fontError] = useFonts(MONEYCAST_FONTS);
  const [tab, setTab] = useState<Tab>('calculator');
  const [hasOpenedNews, setHasOpenedNews] = useState(false);
  if (!fontsLoaded && !fontError) return <SafeAreaView style={[styles.app, styles.fontLoading]}>
    <ActivityIndicator accessibilityLabel="글꼴을 준비하고 있습니다" size="large" color="#20795e" />
  </SafeAreaView>;
  return <PlexFontProvider loaded={fontsLoaded}><SafeAreaView style={styles.app}>
    <StatusBar barStyle="dark-content" backgroundColor="#f5f7f8" />
    <View style={styles.header}><View style={styles.brandMark}><Text style={styles.brandMarkText}>m</Text></View><Text style={styles.brand}>MoneyCast<Text style={styles.brandDot}>.</Text></Text><View style={styles.headerTag}><Text style={styles.headerTagText}>내일을 그리는 금융</Text></View></View>
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
      <View style={[styles.flex, tab !== 'calculator' && styles.hidden]}><CalculatorScreen /></View>
      <View style={[styles.flex, tab !== 'news' && styles.hidden]}>{hasOpenedNews && <NewsScreen active={tab === 'news'} />}</View>
    </KeyboardAvoidingView>
    <View style={styles.tabBar} accessibilityRole="tablist">
      <Pressable accessibilityRole="tab" accessibilityState={{ selected: tab === 'calculator' }} onPress={() => { Keyboard.dismiss(); setTab('calculator'); }} style={[styles.tab, tab === 'calculator' && styles.tabActive]}><Text style={[styles.tabIcon, tab === 'calculator' && styles.tabTextActive]}>↗</Text><Text style={[styles.tabText, tab === 'calculator' && styles.tabTextActive]}>목표 자금 계산기</Text></Pressable>
      <Pressable accessibilityRole="tab" accessibilityState={{ selected: tab === 'news' }} onPress={() => { Keyboard.dismiss(); setHasOpenedNews(true); setTab('news'); }} style={[styles.tab, tab === 'news' && styles.tabActive]}><Text style={[styles.tabIcon, tab === 'news' && styles.tabTextActive]}>▤</Text><Text style={[styles.tabText, tab === 'news' && styles.tabTextActive]}>뉴스 인사이트</Text></Pressable>
    </View>
  </SafeAreaView></PlexFontProvider>;
}

const GOAL_BADGE_COLORS: Record<GoalTargetResolution['source'], { backgroundColor: string; color: string }> = {
  example: { backgroundColor: '#fcf0e0', color: '#8a5a2b' }, manual: { backgroundColor: '#eef2ee', color: '#45524a' },
  details: { backgroundColor: '#e3f1e6', color: '#2f6b4b' }, undecided: { backgroundColor: '#f1f2f4', color: '#5d646b' },
};

const styles = StyleSheet.create({
  fontLoading: { alignItems: 'center', justifyContent: 'center' },
  app: { flex: 1, backgroundColor: '#f5f7f8', paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight : 0 },
  flex: { flex: 1 }, hidden: { display: 'none' }, pressed: { opacity: .7 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 22, paddingVertical: 18, borderBottomWidth: 1, borderBottomColor: '#e4eae8' },
  brandMark: { height: 31, width: 31, borderRadius: 9, backgroundColor: '#184f42', alignItems: 'center', justifyContent: 'center' },
  brandMarkText: { color: '#c3efd0', fontWeight: '800', fontSize: 25, marginTop: -5 },
  brand: { fontSize: 23, fontWeight: '800', color: '#152e2a', letterSpacing: -.9 }, brandDot: { color: '#319b80' },
  headerTag: { marginLeft: 'auto', padding: 6, flexShrink: 1 }, headerTagText: { color: '#62736e', fontSize: 10, fontWeight: '600' },
  content: { padding: 20, paddingTop: 29, paddingBottom: 36, gap: 18 }, tabletContent: { width: '100%', maxWidth: 760, alignSelf: 'center', paddingHorizontal: 34 },
  eyebrow: { flexDirection: 'row', gap: 7, alignItems: 'center', marginBottom: -5 }, greenDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#319b80' },
  eyebrowText: { fontSize: 12, fontWeight: '600', color: '#4d7868' }, pageTitle: { fontSize: 31, lineHeight: 43, letterSpacing: -1.2, fontWeight: '700', color: '#192f2a' },
  pageDescription: { fontSize: 14, lineHeight: 23, color: '#697b74', marginTop: -8, marginBottom: 3 },
  helpButton: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 8, minHeight: 46, paddingVertical: 10, paddingHorizontal: 13, borderWidth: 1, borderColor: '#cbdcd1', borderRadius: 11, backgroundColor: '#edf5ef', marginTop: -5 },
  helpButtonIcon: { color: '#35614b', width: 20, height: 20, lineHeight: 19, textAlign: 'center', borderRadius: 10, borderWidth: 1, borderColor: '#91b09a', fontSize: 13, fontWeight: '700' },
  helpButtonText: { color: '#28573f', fontSize: 14, fontWeight: '600' },
  helpOverlay: { flex: 1, backgroundColor: 'rgba(10, 28, 22, 0.6)', justifyContent: 'center', alignItems: 'center', padding: 20, paddingVertical: 36 },
  helpSheet: { width: '100%', maxWidth: 560, maxHeight: '100%', borderRadius: 23, backgroundColor: '#fff', overflow: 'hidden' },
  helpHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 22, backgroundColor: '#173e34' },
  helpEyebrow: { fontSize: 10, letterSpacing: 1.7, color: '#a9c8b4', fontWeight: '700', marginBottom: 9 },
  helpTitle: { color: '#f1f7ee', fontSize: 24, fontWeight: '700', lineHeight: 34, letterSpacing: -.5 },
  helpClose: { minHeight: 44, minWidth: 48, borderRadius: 10, padding: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: '#2e5546' },
  helpCloseText: { color: '#eef7e8', fontSize: 13, fontWeight: '600' },
  helpScroll: { flexGrow: 0, flexShrink: 1 }, helpBody: { padding: 22, gap: 24 },
  helpIntroduction: { fontSize: 15, lineHeight: 25, color: '#54715f' },
  helpStep: { flexDirection: 'row', gap: 14, alignItems: 'flex-start' },
  helpStepNumber: { minWidth: 30, color: '#47845e', fontSize: 19, fontWeight: '700', lineHeight: 27 },
  helpStepTitle: { fontSize: 17, fontWeight: '700', color: '#294d38', lineHeight: 27, marginBottom: 7 },
  helpStepBody: { fontSize: 15, color: '#61765f', lineHeight: 26 },
  helpNotice: { backgroundColor: '#f1f6ed', borderRadius: 13, padding: 17, gap: 11 },
  helpNoticeTitle: { color: '#3f633e', fontSize: 15, fontWeight: '700', lineHeight: 25 },
  helpNoticeBody: { color: '#667c59', fontSize: 14, lineHeight: 25 },
  helpFooter: { borderTopWidth: 1, borderTopColor: '#e8eee3', padding: 16 },
  helpConfirm: { backgroundColor: '#245c42', borderRadius: 12, minHeight: 50, padding: 14, alignItems: 'center', justifyContent: 'center' },
  helpConfirmText: { color: '#f4f8ee', fontSize: 16, fontWeight: '700' },
  card: { backgroundColor: '#fff', borderRadius: 21, borderWidth: 1, borderColor: '#e4eae6', padding: 20, gap: 12 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  cardTitle: { fontSize: 18, fontWeight: '700', color: '#21352e' }, stepLabel: { fontSize: 10, letterSpacing: 1.1, color: '#788b81', fontWeight: '700' },
  bodyMuted: { fontSize: 12, color: '#111111', lineHeight: 21 }, tiny: { fontSize: 10, color: '#68717a', lineHeight: 18 },
  blackText: { color: '#111111' }, secondaryText: { color: '#68717a' },
  staleBanner: { backgroundColor: '#fff8e6', borderColor: '#ecd9a8', borderWidth: 1, borderRadius: 10, padding: 12, gap: 4 },
  staleTitle: { fontSize: 13, fontWeight: '700', color: '#7a5a12' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginVertical: 5 }, chip: { paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, backgroundColor: '#f4f6f4', minHeight: 42, justifyContent: 'center', borderWidth: 1, borderColor: '#edf0ec' },
  chipSelected: { backgroundColor: '#eaf5ee', borderColor: '#afd3bf' }, chipText: { fontSize: 12, color: '#69796e', fontWeight: '600' }, chipTextSelected: { color: '#246244' },
  field: { marginTop: 7, gap: 7 }, fieldLabel: { fontSize: 13, fontWeight: '600', color: '#43584c' },
  inputWrap: { flexDirection: 'row', alignItems: 'center', borderRadius: 11, borderWidth: 1, borderColor: '#dce4dd', backgroundColor: '#fcfdfb', paddingHorizontal: 14, minHeight: 52 },
  inputError: { borderColor: '#b7554c', backgroundColor: '#fffafa' }, input: { flex: 1, fontSize: 18, fontWeight: '600', color: '#21382c', paddingVertical: 12, minWidth: 0 },
  inputUnit: { fontSize: 13, color: '#7d8b7e', marginLeft: 8 }, fieldHint: { fontSize: 11, color: '#748578', lineHeight: 19 },
  errorText: { fontSize: 12, color: '#ad413b', lineHeight: 19 },
  goalDetails: { backgroundColor: '#f6f9f4', borderRadius: 14, borderWidth: 1, borderColor: '#e1e9e0', padding: 14, gap: 4, marginTop: 4 },
  goalDetailsTitle: { fontSize: 14, fontWeight: '700', color: '#2f4a37' },
  goalBadge: { fontSize: 11, fontWeight: '600', borderRadius: 999, paddingVertical: 2, paddingHorizontal: 8, overflow: 'hidden' },
  goalItem: { borderTopWidth: 1, borderTopColor: '#e1e9e0', marginTop: 6, paddingTop: 2 },
  goalLink: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center' },
  goalLinkText: { color: '#2f6b4b', fontSize: 13, fontWeight: '600', textDecorationLine: 'underline' },
  goalResult: { color: '#111111', fontSize: 12, fontWeight: '600', lineHeight: 19 },
  inputMultiline: { minHeight: 64, textAlignVertical: 'top' },
  goalAssist: { backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: '#cfe0d2', padding: 12, gap: 6, marginTop: 4 },
  goalQuestion: { borderTopWidth: 1, borderTopColor: '#e1eadf', paddingTop: 8, marginTop: 4, gap: 4 },
  goalNotice: { fontSize: 12, lineHeight: 19, color: '#6b4b1f', backgroundColor: '#fff7e8', borderRadius: 8, padding: 8 },
  inlineNotice: { flexDirection: 'row', gap: 9, backgroundColor: '#f4f7f2', borderRadius: 10, padding: 12, marginTop: 8 }, noticeSymbol: { fontSize: 14, color: '#5a7d5e' }, noticeText: { flex: 1, fontSize: 11, color: '#647963', lineHeight: 19 },
  resultCard: { backgroundColor: '#edf4e8', borderRadius: 22, padding: 23, gap: 13 }, resultLabel: { color: '#111111', fontSize: 13, fontWeight: '500' },
  resultPill: { fontSize: 8, fontWeight: '700', letterSpacing: 1.1, color: '#111111', borderWidth: 1, borderColor: '#557761', borderRadius: 5, padding: 5 },
  resultAmount: { fontSize: 35, fontWeight: '700', color: '#111111', letterSpacing: -1, marginTop: 4 }, resultExact: { fontSize: 12, color: '#111111', marginTop: -6 },
  resultDivider: { height: 1, backgroundColor: '#d7e3d7', marginVertical: 5 }, resultSecondary: { color: '#111111', fontSize: 12 }, resultValue: { color: '#111111', fontSize: 13, fontWeight: '600' },
  achievement: { backgroundColor: '#244f40', borderRadius: 12, padding: 14, gap: 6, marginTop: 7 }, achievementTitle: { color: '#d8eec6', fontSize: 14, fontWeight: '600' }, achievementBody: { color: '#bdd2bb', fontSize: 11, lineHeight: 19 },
  chartSelection: { paddingVertical: 11, gap: 3 }, selectedAmount: { fontSize: 23, fontWeight: '700', letterSpacing: -.4, color: '#214737' },
  plot: { borderBottomWidth: 1, borderBottomColor: '#dce5dd', marginTop: 20, marginBottom: 1 }, bars: { flexDirection: 'row', height: '100%', alignItems: 'flex-end', justifyContent: 'space-around', gap: 8 },
  barTouch: { flex: 1, height: '100%', justifyContent: 'flex-end', minWidth: 20 }, barPrincipal: { position: 'absolute', bottom: 0, left: '8%', right: '8%', backgroundColor: '#b8c8c5', borderTopLeftRadius: 4, borderTopRightRadius: 4 },
  barBalance: { width: '60%', alignSelf: 'center', backgroundColor: '#319b80', borderTopLeftRadius: 4, borderTopRightRadius: 4, opacity: .65 }, barActive: { backgroundColor: '#1e6c53', opacity: 1 },
  targetLine: { position: 'absolute', left: 0, right: 0, borderTopWidth: 1, borderTopColor: '#b18d46', borderStyle: 'dashed', zIndex: 1 }, targetLabel: { position: 'absolute', right: 0, top: -19, fontSize: 10, color: '#9b7b37', backgroundColor: '#fff', paddingHorizontal: 3 },
  legend: { flexDirection: 'row', gap: 7, alignItems: 'center', justifyContent: 'center', marginTop: 2 }, legendDot: { width: 7, height: 7, borderRadius: 2, marginLeft: 6 },
  emptyCard: { backgroundColor: '#fff', borderRadius: 18, padding: 24, borderWidth: 1, borderColor: '#e5e9e3', gap: 9 },
  assumptions: { padding: 4, gap: 8 }, assumptionsTitle: { fontSize: 12, color: '#68717a', fontWeight: '700' }, assumptionsText: { fontSize: 11, lineHeight: 20, color: '#68717a' },
  searchInput: { borderRadius: 11, borderWidth: 1, borderColor: '#dce4dd', padding: 14, color: '#21382c', fontSize: 14, minHeight: 48, backgroundColor: '#fcfdfb', marginTop: 5 },
  companyOption: { flexDirection: 'row', alignItems: 'center', gap: 11, padding: 12, borderRadius: 11, borderWidth: 1, borderColor: '#eaf0e9', minHeight: 65 },
  companySelected: { backgroundColor: '#f0f7ee', borderColor: '#bed5b7' }, companyName: { fontSize: 14, fontWeight: '600', color: '#2b4131' },
  selectionCircle: { color: '#a4b2a1', fontSize: 20 }, selectionCircleActive: { color: '#3c7f48' }, noResults: { color: '#7e897a', fontSize: 12, lineHeight: 22, paddingVertical: 15 },
  exchangeBadge: { color: '#638369', fontSize: 10, backgroundColor: '#edf4e9', borderRadius: 5, paddingVertical: 5, paddingHorizontal: 7, fontWeight: '700' },
  emptyState: { paddingVertical: 25, alignItems: 'center', gap: 14 }, emptyIcon: { fontSize: 30, color: '#547b60', backgroundColor: '#eef4eb', width: 57, height: 57, textAlign: 'center', lineHeight: 57, borderRadius: 18 },
  emptyTitle: { fontSize: 17, color: '#38523d', fontWeight: '700' }, emptyDescription: { fontSize: 12, lineHeight: 23, color: '#778470', textAlign: 'center', maxWidth: 470 },
  primaryButton: { backgroundColor: '#245c42', borderRadius: 10, paddingVertical: 13, paddingHorizontal: 24, minHeight: 46 }, primaryButtonText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  secondaryButton: { backgroundColor: '#f0f5ed', borderRadius: 10, padding: 14, alignItems: 'center', minHeight: 46, marginTop: 6 }, secondaryButtonText: { color: '#52734c', fontSize: 12, fontWeight: '600' },
  analysisStatus: { backgroundColor: '#eff5e9', padding: 16, borderRadius: 12, gap: 10 }, analysisUnavailable: { backgroundColor: '#f5f3ec' }, analysisStatusTitle: { fontSize: 15, fontWeight: '700', color: '#111111' }, analysisSummary: { fontSize: 13, lineHeight: 23, color: '#111111' }, metadata: { gap: 3, paddingVertical: 3 },
  article: { borderTopWidth: 1, borderTopColor: '#e8ede2', paddingVertical: 16, gap: 8 }, articleSource: { fontSize: 11, color: '#111111', fontWeight: '600' }, articleTitle: { fontSize: 15, lineHeight: 24, fontWeight: '600', color: '#111111' }, sentiment: { color: '#111111', fontSize: 11, backgroundColor: '#eff3e9', paddingVertical: 4, paddingHorizontal: 8, borderRadius: 5 }, factorSection: { gap: 7, paddingVertical: 8 }, factorTitle: { fontSize: 13, fontWeight: '700', color: '#111111' },
  tabBar: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: '#e3e9e2', paddingHorizontal: 20, paddingTop: 10, paddingBottom: Platform.OS === 'android' ? 26 : 10, gap: 10, backgroundColor: '#fff' },
  tab: { flex: 1, minHeight: 52, borderRadius: 13, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 }, tabActive: { backgroundColor: '#eef5eb' }, tabText: { fontSize: 13, color: '#8a9784', fontWeight: '600' }, tabIcon: { fontSize: 21, color: '#8a9784' }, tabTextActive: { color: '#356645' },
});
