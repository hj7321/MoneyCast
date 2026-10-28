import React, { useEffect, useMemo, useRef, useState } from 'react';
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
  calculateProjection,
  companies,
  DEFAULT_CALCULATOR_INPUT,
  formatCompactKRW,
  formatDurationMonths,
  formatKRW,
  searchCompanies,
  validateCalculatorInput,
  type CalculatorInput,
  type Company,
  type NewsAnalysis,
  type NewsArticle,
} from '@moneycast/core';
import { CompanyAvatar } from './CompanyAvatar';
import { useFonts } from 'expo-font';
import { MONEYCAST_FONTS } from './fonts';
import { PlexFontProvider, Text, TextInput } from './Typography';
import { API_URL, mobileNewsCache } from './news-cache';

type Field = Exclude<keyof CalculatorInput, 'years'> | 'months';
type Tab = 'calculator' | 'news';
type Projection = ReturnType<typeof calculateProjection>;
const INITIAL_FORM: Record<Field, string> = {
  initial: String(DEFAULT_CALCULATOR_INPUT.initial),
  monthly: String(DEFAULT_CALCULATOR_INPUT.monthly),
  annualRate: String(DEFAULT_CALCULATOR_INPUT.annualRate),
  months: String(DEFAULT_CALCULATOR_INPUT.years * 12),
  target: String(DEFAULT_CALCULATOR_INPUT.target),
};
const fields: { key: Field; label: string; unit: string; hint: string }[] = [
  { key: 'initial', label: '현재 시드머니', unit: '원', hint: '현재 보유 자산을 원 단위로 입력하세요.' },
  { key: 'monthly', label: '매월 모으는 금액', unit: '원', hint: '매월 말에 납입할 금액을 입력하세요.' },
  { key: 'annualRate', label: '연간 예상 수익률', unit: '%', hint: '보장되지 않는 가정입니다. 음수도 입력할 수 있습니다.' },
  { key: 'months', label: '목표 기간', unit: '개월', hint: '1개월부터 600개월(50년)까지 1개월 단위로 입력하세요.' },
  { key: 'target', label: '목표 금액', unit: '원', hint: '0원을 입력하면 목표 비교 없이 예상 자산을 계산합니다.' },
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
    { title: '나의 목표를 골라요', body: '내 집 마련, 자동차, 여행 중 목표를 고르거나 금액을 직접 정하세요. 목표 금액을 0원으로 입력하면 목표 비교 없이 예상 자산만 볼 수 있어요.' },
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
                ? '세금·수수료·물가상승률은 반영하지 않아요. 수익률은 입력한 가정이며 실제 수익을 보장하지 않아요. 원금 손실이 발생할 수 있어요.'
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

function CalculatorScreen() {
  const [form, setForm] = useState(INITIAL_FORM);
  const [preset, setPreset] = useState('직접 설정');
  const { width } = useWindowDimensions();
  const months = form.months.trim() === '' ? Number.NaN : Number(form.months);
  const input = useMemo(() => {
    const values = Object.fromEntries(Object.entries(form).map(([key, value]) =>
      [key, value.trim() === '' ? Number.NaN : Number(value)])) as Record<Field, number>;
    const { months: durationMonths, ...amounts } = values;
    return { ...amounts, years: durationMonths / 12 } satisfies CalculatorInput;
  }, [form]);
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
  return <ScrollView contentContainerStyle={[styles.content, width > 700 && styles.tabletContent]} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
    <View style={styles.eyebrow}><View style={styles.greenDot} /><Text style={styles.eyebrowText}>목표가 있는 돈의 여정</Text></View>
    <Text style={styles.pageTitle}>작은 시작이{ '\n' }어떤 미래가 될까요?</Text>
    <Text style={styles.pageDescription}>나의 속도로 모으고, 숫자로 그려보세요.</Text>
    <UsageHelp feature="calculator" />
    <View style={styles.card}>
      <View style={styles.rowBetween}><Text style={styles.cardTitle}>나의 목표 설정</Text><Text style={styles.stepLabel}>01 / PLAN</Text></View>
      <Text style={styles.bodyMuted}>목표를 골라도 금액은 자유롭게 바꿀 수 있어요.</Text>
      <View style={styles.chips}>
        {[['직접 설정', '50000000'], ['내 집 마련', '300000000'], ['자동차', '40000000'], ['여행', '10000000']].map(([label, amount]) =>
          <Chip key={label!} label={label!} selected={preset === label} onPress={() => {
            setPreset(label!); if (amount) change('target', amount);
          }} />)}
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
          : field.key === 'months' ? <Text style={styles.fieldHint}>{formatDurationMonths(months)} · 1~600개월, 1개월 단위</Text>
            : field.unit === '원' && form[field.key] !== '' && Number.isFinite(Number(form[field.key]))
              ? <Text style={styles.fieldHint}>{formatCompactKRW(Number(form[field.key]))}</Text> : null}
      </View>)}
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
      <Text style={styles.assumptionsText}>세금·수수료·물가상승률은 반영하지 않습니다. 실제 수익은 달라질 수 있고 원금 손실이 발생할 수 있습니다.</Text>
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
  const retryDelayed = useNewsRetryDelay(analysis?.retryAt);
  const requestId = useRef(0);
  const results = useMemo(() => searchCompanies(query), [query]);
  const { width } = useWindowDimensions();
  useEffect(() => {
    const current = ++requestId.current;
    if (!active) { setLoading(false); return () => { ++requestId.current; }; }
    const cached = mobileNewsCache.peek(company.id);
    setAnalysis(cached); setError('');
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
              {marketaux && <Text style={[styles.bodyMuted, styles.secondaryText]}>Marketaux 무료 연동은 요청당 최대 3개 기사를 확인합니다. 원문 언어를 제한하지 않아 해외 기사가 포함될 수 있으며, 기사 부족·상충 시 판단을 유보합니다.</Text>}
              <View style={styles.metadata}><Text style={styles.tiny}>데이터 기준: {formatNewsTime(shown.asOf)}</Text>
                {shown.newsWindow ? <Text style={styles.tiny}>뉴스 수집 기간: {formatNewsTime(shown.newsWindow.start)} ~ {formatNewsTime(shown.newsWindow.end)}</Text> : null}
                <Text style={styles.tiny}>다음 주 참고 기간: {shown.period.start} ~ {shown.period.end}</Text>
                {shown.cachedUntil ? <Text style={styles.tiny}>서버 캐시 만료: {formatNewsTime(shown.cachedUntil)} · 그전에는 저장된 결과를 다시 보여줄 수 있습니다.</Text> : null}
                <Text style={styles.tiny}>근거 수준: {({ none: '없음', low: '낮음', moderate: '보통' })[shown.evidence]} · 뉴스 {shown.articles.length}건</Text>
                <Text style={styles.tiny}>근거 수준은 최근 7일의 기사 수와 상충 여부를 기준으로 하며, 예측 정확도가 아닙니다.</Text>
                <Text style={styles.tiny}>제공자: {shown.provider ?? '미설정'} · 분석 버전 {shown.analysisVersion}</Text>
                {shown.sources ? <Text style={styles.tiny}>출처 상태: {shown.sources.map(source => `${source.label} ${({ ok: `정상 ${source.articleCount}건`, empty: '기사 없음', not_configured: '미설정', rate_limited: '호출 제한', error: '실패' })[source.status]}`).join(' · ')}</Text> : null}
                {shown.ai ? <Text style={styles.tiny}>AI 판단: {shown.ai.providers.map(model => `${model.label} ${aiLabels[model.status]}${model.status === 'ok' ? ` ${model.judgedCount}건` : ''}`).join(' · ')}{shown.ai.hiddenCount > 0 ? ` · 관련 없는 기사 ${shown.ai.hiddenCount}건 숨김` : ''}</Text> : null}
                {shown.articles.some(article => article.sourceProvider === 'GDELT') ? <Text style={styles.tiny}>일부 기사 목록은 GDELT Project(gdeltproject.org) 검색 결과이며, GDELT 시각은 기사를 처음 확인한 시각입니다.</Text> : null}
                {shown.articles.some(article => article.summary || article.aiJudgements) ? <Text style={styles.tiny}>일부 요약·분류는 AI(Gemini·Cloudflare Workers AI)가 기사 제목과 매체 설명만 보고 생성했으며 틀릴 수 있습니다.</Text> : null}
              </View>
              {shown.articles.length === 0 && <Text style={styles.noResults}>표시할 실제 뉴스가 없습니다. 설정되지 않은 데이터나 예시 기사는 표시하지 않습니다.</Text>}
              {shown.articles.some(article => article.sentiment === 'unclassified') && <Text style={styles.bodyMuted}>{shown.ai ? '미분류·잠정·판단 유보 기사는 긍정·부정 요인 집계에서 제외합니다.' : '미분류 기사는 긍정·부정 요인 집계에서 제외합니다.'}</Text>}
              {shown.articles.map(article => <Pressable key={article.id} accessibilityRole="link" accessibilityLabel={`${article.title}, 원문 열기`}
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
                {!article.rationaleLines && article.classificationMethod === 'provider' ? <Text style={[styles.tiny, styles.blackText]}>{shown.provider || '뉴스 제공자'} 제공자 분류{article.sentimentScore !== undefined ? ` · 기사 감성 점수 ${String(article.sentimentScore)} (−1~1)` : ''} · 주가 상승 확률이 아닙니다.</Text> : null}
                {!article.rationaleLines && article.classificationMethod === 'unavailable' ? <Text style={[styles.tiny, styles.blackText]}>제공자 감성 점수가 없어 분류하지 않았습니다.</Text> : null}
                {!article.rationaleLines && article.providerEntity ? <Text style={[styles.tiny, styles.blackText]}>제공자 기업 식별: {article.providerEntity.name} · {article.providerEntity.symbol} · {article.providerEntity.exchange || '거래소 정보 미제공'} · {article.providerEntity.country.toUpperCase()}</Text> : null}
              </Pressable>)}
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
