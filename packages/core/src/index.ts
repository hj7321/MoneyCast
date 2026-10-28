import { isNewsTopicKey, type NewsTopicKey } from './news-topics.js';

/** Shared calculation rules used unchanged by the web, native app and API. */
export interface CalculatorInput {
  initial: number;
  monthly: number;
  annualRate: number;
  years: number;
  /** Zero means that the user has not set a goal. */
  target: number;
}

export interface ProjectionPoint {
  month: number;
  year: number;
  principal: number;
  balance: number;
  profit: number;
}

export interface Projection {
  points: ProjectionPoint[];
  finalBalance: number;
  totalPrincipal: number;
  totalProfit: number;
  /** Positive: above the goal. Negative: below the goal. */
  gap: number;
  achieved: boolean;
  months: number;
}

export const CALCULATION_ASSUMPTIONS = {
  contributionTiming: '매월 말 납입',
  monthlyRate: '(1 + 연 수익률 / 100)^(1/12) - 1',
  rounding: '계산 중 반올림하지 않고 표시할 때 원 단위 반올림',
  exclusions: '세금, 수수료, 물가상승률 미반영',
  disclaimer: '수익률은 사용자가 입력한 가정이며 실제 수익을 보장하지 않습니다.',
} as const;

export const DEFAULT_CALCULATOR_INPUT: CalculatorInput = {
  initial: 10_000_000,
  monthly: 500_000,
  annualRate: 5,
  years: 5,
  target: 50_000_000,
};

export class CalculatorValidationError extends Error {
  readonly errors: Record<string, string>;

  constructor(errors: Record<string, string>) {
    super(Object.values(errors)[0] ?? '입력값을 확인해 주세요.');
    this.name = 'CalculatorValidationError';
    this.errors = errors;
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function rawFinalBalance(input: CalculatorInput): number {
  const months = Math.round(input.years * 12);
  const rate = Math.expm1(Math.log1p(input.annualRate / 100) / 12);
  let balance = input.initial;
  for (let month = 1; month <= months; month += 1) {
    balance = balance * (1 + rate) + input.monthly;
  }
  return balance;
}

/**
 * Missing values and strings are rejected instead of silently becoming zero.
 * Amounts may include fractions of a won; rounding is deferred until output.
 * A duration must correspond to a whole number of months (1–600).
 */
export function validateCalculatorInput(value: unknown): Record<string, string> {
  const input = value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
  const errors: Record<string, string> = {};
  const amountLabels = { initial: '시드머니', monthly: '월 납입액', target: '목표 금액' };

  for (const [field, label] of Object.entries(amountLabels)) {
    const amount = input[field];
    if (!isFiniteNumber(amount)) errors[field] = `${label}을 숫자로 입력해 주세요.`;
    else if (amount < 0) errors[field] = `${label}은 0원 이상이어야 합니다.`;
    else if (amount > 1_000_000_000_000) errors[field] = `${label}은 1조 원 이하로 입력해 주세요.`;
  }

  if (!isFiniteNumber(input.annualRate)) {
    errors.annualRate = '연간 예상 수익률을 숫자로 입력해 주세요.';
  } else if (input.annualRate <= -100 || input.annualRate > 100) {
    errors.annualRate = '수익률은 -100% 초과, 100% 이하로 입력해 주세요.';
  }

  if (!isFiniteNumber(input.years)) {
    errors.years = '목표 기간을 숫자로 입력해 주세요.';
  } else if (input.years < 1 / 12 || input.years > 50) {
    errors.years = '목표 기간은 1개월 이상, 50년 이하로 입력해 주세요.';
  } else if (Math.abs(input.years * 12 - Math.round(input.years * 12)) > 1e-7) {
    errors.years = '목표 기간은 1개월 단위로 입력해 주세요.';
  }

  if (Object.keys(errors).length === 0) {
    const finalBalance = rawFinalBalance(input as unknown as CalculatorInput);
    if (!Number.isFinite(finalBalance) || finalBalance > Number.MAX_SAFE_INTEGER) {
      errors.projection = '예상 자산이 정확하게 표시할 수 있는 범위를 넘습니다. 금액, 수익률 또는 기간을 줄여 주세요.';
    }
  }
  return errors;
}

/**
 * Effective annual rate is converted to an effective monthly rate. Each month
 * accrues interest on the previous balance, then receives the monthly deposit.
 * Internal balances retain floating-point precision. Returned monetary values
 * are rounded once to won; profit is the rounded balance less rounded principal
 * so the visible components always add up. Negative returns are supported.
 */
export function calculateProjection(input: CalculatorInput): Projection {
  const errors = validateCalculatorInput(input);
  if (Object.keys(errors).length > 0) throw new CalculatorValidationError(errors);

  const months = Math.round(input.years * 12);
  const monthlyRate = Math.expm1(Math.log1p(input.annualRate / 100) / 12);
  let rawBalance = input.initial;
  const points: ProjectionPoint[] = [];

  for (let month = 0; month <= months; month += 1) {
    if (month > 0) rawBalance = rawBalance * (1 + monthlyRate) + input.monthly;
    const principal = Math.round(input.initial + input.monthly * month);
    const balance = Math.round(rawBalance);
    points.push({ month, year: month / 12, principal, balance, profit: balance - principal });
  }

  const last = points[points.length - 1]!;
  return {
    points,
    finalBalance: last.balance,
    totalPrincipal: last.principal,
    totalProfit: last.profit,
    gap: last.balance - Math.round(input.target),
    achieved: last.balance >= Math.round(input.target),
    months,
  };
}

export interface ProjectionScenario {
  key: 'conservative' | 'base' | 'optimistic';
  label: string;
  annualRate: number;
  projection: Projection;
}

/** Illustrative rates only; these labels are not predictions or probabilities. */
export function calculateScenarios(input: CalculatorInput, spread = 2): ProjectionScenario[] {
  if (!Number.isFinite(spread) || spread < 0 || spread > 100) {
    throw new RangeError('시나리오 수익률 차이는 0~100%p이어야 합니다.');
  }
  const variants = [
    { key: 'conservative', label: '보수', annualRate: Math.min(input.annualRate, Math.max(-99.99, input.annualRate - spread)) },
    { key: 'base', label: '기준', annualRate: input.annualRate },
    { key: 'optimistic', label: '낙관', annualRate: Math.min(100, input.annualRate + spread) },
  ] as const;
  return variants.map((scenario) => ({
    ...scenario,
    projection: calculateProjection({ ...input, annualRate: scenario.annualRate }),
  }));
}

export function formatKRW(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return `${Math.round(value).toLocaleString('ko-KR')}원`;
}

/** Display whole-month durations without exposing fractional years. */
export function formatDurationMonths(months: number): string {
  if (!Number.isSafeInteger(months) || months < 0) return '—';
  const years = Math.floor(months / 12);
  const remainder = months % 12;
  return years === 0 ? `${months}개월` : remainder === 0 ? `${years}년` : `${years}년 ${remainder}개월`;
}

export function formatCompactKRW(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const absolute = Math.abs(value);
  if (absolute >= 100_000_000) {
    return `${(value / 100_000_000).toLocaleString('ko-KR', { maximumFractionDigits: 2 })}억 원`;
  }
  if (absolute >= 10_000) {
    return `${(value / 10_000).toLocaleString('ko-KR', { maximumFractionDigits: 1 })}만 원`;
  }
  return formatKRW(value);
}

export interface Company {
  id: string;
  name: string;
  symbol: string;
  exchange: string;
  region: string;
}

/** Curated identification metadata, not live market data or a complete listing. */
export const COMPANIES: readonly Company[] = [
  { id: 'krx:005930', name: '삼성전자', symbol: '005930', exchange: 'KOSPI', region: 'KR' },
  { id: 'krx:000660', name: 'SK하이닉스', symbol: '000660', exchange: 'KOSPI', region: 'KR' },
  { id: 'krx:035420', name: 'NAVER', symbol: '035420', exchange: 'KOSPI', region: 'KR' },
  { id: 'krx:005380', name: '현대자동차', symbol: '005380', exchange: 'KOSPI', region: 'KR' },
  { id: 'nasdaq:AAPL', name: '애플', symbol: 'AAPL', exchange: 'NASDAQ', region: 'US' },
  { id: 'nasdaq:NVDA', name: '엔비디아', symbol: 'NVDA', exchange: 'NASDAQ', region: 'US' },
  { id: 'nasdaq:MSFT', name: '마이크로소프트', symbol: 'MSFT', exchange: 'NASDAQ', region: 'US' },
  { id: 'nasdaq:TSLA', name: '테슬라', symbol: 'TSLA', exchange: 'NASDAQ', region: 'US' },
];

/** Lowercase alias for service consumers. */
export const companies = COMPANIES;

const COMPANY_ALIASES: Record<string, string> = {
  'krx:005930': 'Samsung Electronics 삼성',
  'krx:000660': 'SK Hynix 에스케이하이닉스',
  'krx:035420': '네이버 Naver',
  'krx:005380': 'Hyundai Motor 현대차',
  'nasdaq:AAPL': 'Apple',
  'nasdaq:NVDA': 'Nvidia NVIDIA',
  'nasdaq:MSFT': 'Microsoft',
  'nasdaq:TSLA': 'Tesla',
};

function normalizeSearch(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g, '');
}

export function searchCompanies(query: string): Company[] {
  const normalized = normalizeSearch(query.trim());
  return COMPANIES.filter((company) => normalizeSearch([
    company.id, company.name, company.symbol, company.exchange,
    company.region, COMPANY_ALIASES[company.id] ?? '',
  ].join(' ')).includes(normalized));
}

export type NewsSentiment = 'positive' | 'negative' | 'neutral' | 'unclassified';
export type AiProviderId = 'gemini' | 'cloudflare';
export type AiSentiment = 'positive' | 'negative' | 'neutral' | 'uncertain';
/** One model's own judgement of one article, kept only after server-side validation. */
export interface AiJudgement {
  provider: AiProviderId;
  model: string;
  relevant: boolean;
  sentiment: AiSentiment;
  /** Phrase copied verbatim from the title or the publisher description. */
  evidence?: string;
  reason?: string;
  topic?: NewsTopicKey;
  judgedAt: string;
}
/**
 * confirmed: both models agree. provisional: only one model answered so far.
 * withheld: the models disagree or one could not judge. pending: no answer yet.
 * Only confirmed articles carry a direction; the others stay unclassified.
 */
export type AiConsensus = 'confirmed' | 'provisional' | 'withheld' | 'pending';
/** What the article is about, generated from the title and description only. */
export interface ArticleSummary {
  text: string;
  basis: 'title_description' | 'title_only';
  generatedBy: string;
}
export interface AiProviderState {
  id: AiProviderId;
  label: string;
  model: string;
  /** idle: nothing needed this model during the refresh. */
  status: 'ok' | 'idle' | 'not_configured' | 'rate_limited' | 'error' | 'timeout';
  judgedCount: number;
  retryAt?: string;
}
export interface AiStatus {
  providers: AiProviderState[];
  /** Articles both models judged unrelated to the company; folded below the list and left out of counts. */
  unrelatedCount: number;
  promptVersion: string;
}
export interface NewsArticle {
  id: string;
  title: string;
  source: string;
  publishedAt: string;
  url: string;
  sentiment: NewsSentiment;
  /** Single-string explanation kept for clients that predate `rationaleLines`. */
  rationale: string;
  language?: string;
  sentimentScore?: number;
  classificationMethod?: 'provider' | 'unavailable' | 'llm';
  providerEntity?: { symbol: string; name: string; exchange: string | null; country: string };
  /** Publisher meta description supplied by the provider; never article body text. */
  description?: string;
  /** One to five short lines explaining why the article carries its label. */
  rationaleLines?: string[];
  /** Fixed topic keys used to group the factor summary. */
  topics?: NewsTopicKey[];
  /** The API that delivered the article, distinct from the publisher in `source`. */
  sourceProvider?: string;
  /** 'seen' is a crawler's first-seen time, not the publisher's timestamp. */
  timeKind?: 'published' | 'seen';
  /** Company match: provider entity tags, or the company name in the title. */
  identity?: 'entity_verified' | 'name_match';
  /** Other publishers carrying the same story after URL/title de-duplication. */
  alsoReportedBy?: Array<{ source: string; url: string }>;
  summary?: ArticleSummary;
  aiJudgements?: AiJudgement[];
  aiConsensus?: AiConsensus;
  /**
   * Both models judged the article not to be about the company. It stays
   * visible, folded below the list, but no count or factor uses it; a
   * provider score is shown for reference only.
   */
  aiRelevance?: 'unrelated';
}

/** skipped: not queried in this refresh, as GDELT outside scheduled collection. */
export type NewsSourceStatus = 'ok' | 'empty' | 'skipped' | 'not_configured' | 'rate_limited' | 'error';
/** Per-source outcome of one refresh, shown so partial failures stay visible. */
export interface NewsSourceState {
  id: string;
  label: string;
  status: NewsSourceStatus;
  articleCount: number;
  retryAt?: string;
}

export type FactorBoxState = 'none' | 'single' | 'repeated' | 'mixed';
/** One synthesized sentence and the articles that support it. */
export interface FactorLine {
  text: string;
  topic: NewsTopicKey;
  articleIds: string[];
}
export interface FactorBox {
  state: FactorBoxState;
  lines: FactorLine[];
  chips: string[];
}
/** Rule-based summary of classified articles; describes coverage, not prices. */
export interface FactorSummary {
  positive: FactorBox;
  negative: FactorBox;
  chips: string[];
  note: string;
}

export interface NewsAnalysis {
  company: Company;
  status: 'not_configured' | 'insufficient' | 'ready' | 'error' | 'rate_limited';
  articles: NewsArticle[];
  asOf: string;
  period: { start: string; end: string };
  evidence: 'none' | 'low' | 'moderate';
  summary: string;
  positiveFactors: string[];
  negativeFactors: string[];
  risks: string[];
  provider: string | null;
  message?: string;
  analysisVersion: string;
  newsWindow?: { start: string; end: string };
  cachedUntil?: string;
  retryAt?: string;
  factorSummary?: FactorSummary;
  sources?: NewsSourceState[];
  /** 'stale': every source failed, so the last successful result is shown instead. */
  servedFrom?: 'live' | 'stale';
  /** When the failed refresh behind a stale result was attempted. */
  refreshAttemptedAt?: string;
  ai?: AiStatus;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!;
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  return match !== null && isCalendarDate(value.slice(0, 10)) &&
    Number(match[1]) < 24 && Number(match[2]) < 60 && Number(match[3]) < 60 &&
    Number.isFinite(Date.parse(value));
}

function isSafeHttpsUrl(value: unknown): value is string {
  if (!isNonemptyString(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isBoundedText(value: unknown, max: number): value is string {
  return isNonemptyString(value) && value.length <= max;
}

function isBoundedTextArray(value: unknown, min: number, max: number, maxLength: number): value is string[] {
  return Array.isArray(value) && value.length >= min && value.length <= max && value.every(item => isBoundedText(item, maxLength));
}

function hasValidArticleMetadata(article: Record<string, unknown>): boolean {
  if (article.language !== undefined && !isNonemptyString(article.language)) return false;
  if (article.classificationMethod !== undefined && article.classificationMethod !== 'provider' &&
      article.classificationMethod !== 'unavailable' && article.classificationMethod !== 'llm') return false;
  if (article.classificationMethod === 'unavailable' &&
      (article.sentiment !== 'unclassified' || article.sentimentScore !== undefined)) return false;
  if (article.classificationMethod === 'provider' && article.sentiment === 'unclassified') return false;
  // A model-derived direction needs both models to agree and never carries a provider score.
  if ((article.classificationMethod === 'llm') !== (article.aiConsensus === 'confirmed')) return false;
  if (article.classificationMethod === 'llm' && (article.sentiment === 'unclassified' || article.sentimentScore !== undefined)) return false;
  if (article.aiConsensus !== undefined && !['confirmed', 'provisional', 'withheld', 'pending'].includes(String(article.aiConsensus))) return false;
  if (article.aiConsensus !== undefined && article.aiConsensus !== 'confirmed' && article.sentiment !== 'unclassified') return false;
  if (article.aiJudgements !== undefined && !(Array.isArray(article.aiJudgements) && article.aiJudgements.length >= 1 &&
      article.aiJudgements.length <= 2 && article.aiJudgements.every(isAiJudgement) &&
      new Set(article.aiJudgements.map(item => (item as AiJudgement).provider)).size === article.aiJudgements.length)) return false;
  if (article.aiRelevance !== undefined && !(article.aiRelevance === 'unrelated' && article.classificationMethod !== 'llm' &&
      Array.isArray(article.aiJudgements) && article.aiJudgements.length === 2 &&
      article.aiJudgements.every(item => isRecord(item) && item.relevant === false))) return false;
  if (article.summary !== undefined && !(isRecord(article.summary) && isBoundedText(article.summary.text, 200) &&
      (article.summary.basis === 'title_description' || article.summary.basis === 'title_only') &&
      isBoundedText(article.summary.generatedBy, 40))) return false;
  if (article.sentimentScore !== undefined) {
    const score = article.sentimentScore;
    if (typeof score !== 'number' || !Number.isFinite(score) || score < -1 || score > 1 ||
        article.sentiment !== (score > 0 ? 'positive' : score < 0 ? 'negative' : 'neutral')) return false;
  }
  if (article.providerEntity !== undefined) {
    const entity = article.providerEntity;
    if (!isRecord(entity) || !['symbol', 'name', 'country'].every(key => isNonemptyString(entity[key])) ||
        !(entity.exchange === null || isNonemptyString(entity.exchange))) return false;
  }
  if (article.description !== undefined && !isBoundedText(article.description, 300)) return false;
  if (article.rationaleLines !== undefined && !isBoundedTextArray(article.rationaleLines, 1, 5, 300)) return false;
  if (article.topics !== undefined && !(Array.isArray(article.topics) && article.topics.length >= 1 &&
      article.topics.length <= 3 && article.topics.every(isNewsTopicKey))) return false;
  if (article.sourceProvider !== undefined && !isBoundedText(article.sourceProvider, 40)) return false;
  if (article.timeKind !== undefined && article.timeKind !== 'published' && article.timeKind !== 'seen') return false;
  if (article.identity !== undefined && article.identity !== 'entity_verified' && article.identity !== 'name_match') return false;
  if (article.alsoReportedBy !== undefined && !(Array.isArray(article.alsoReportedBy) && article.alsoReportedBy.length <= 10 &&
      article.alsoReportedBy.every(item => isRecord(item) && isBoundedText(item.source, 100) && isSafeHttpsUrl(item.url)))) return false;
  return true;
}

const AI_PROVIDERS = ['gemini', 'cloudflare'];

function isAiJudgement(value: unknown): boolean {
  return isRecord(value) && typeof value.provider === 'string' && AI_PROVIDERS.includes(value.provider) &&
    isBoundedText(value.model, 80) && typeof value.relevant === 'boolean' &&
    typeof value.sentiment === 'string' && ['positive', 'negative', 'neutral', 'uncertain'].includes(value.sentiment) &&
    (value.evidence === undefined || isBoundedText(value.evidence, 120)) &&
    (value.reason === undefined || isBoundedText(value.reason, 200)) &&
    (value.topic === undefined || isNewsTopicKey(value.topic)) && isTimestamp(value.judgedAt);
}

function isAiStatus(value: unknown): boolean {
  return isRecord(value) && Array.isArray(value.providers) && value.providers.length >= 1 && value.providers.length <= 2 &&
    value.providers.every(item => isRecord(item) && typeof item.id === 'string' && AI_PROVIDERS.includes(item.id) &&
      isBoundedText(item.label, 40) && isBoundedText(item.model, 80) && typeof item.status === 'string' &&
      ['ok', 'idle', 'not_configured', 'rate_limited', 'error', 'timeout'].includes(item.status) &&
      typeof item.judgedCount === 'number' && Number.isSafeInteger(item.judgedCount) && item.judgedCount >= 0 &&
      (item.retryAt === undefined || isTimestamp(item.retryAt))) &&
    typeof value.unrelatedCount === 'number' && Number.isSafeInteger(value.unrelatedCount) && value.unrelatedCount >= 0 &&
    isBoundedText(value.promptVersion, 40);
}

function isSourceState(value: unknown): boolean {
  return isRecord(value) && isBoundedText(value.id, 40) && isBoundedText(value.label, 60) &&
    typeof value.status === 'string' && ['ok', 'empty', 'skipped', 'not_configured', 'rate_limited', 'error'].includes(value.status) &&
    typeof value.articleCount === 'number' && Number.isSafeInteger(value.articleCount) && value.articleCount >= 0 &&
    (value.retryAt === undefined || isTimestamp(value.retryAt));
}

function isFactorBox(value: unknown, articleIds: ReadonlySet<string>): boolean {
  if (!isRecord(value) || typeof value.state !== 'string' || !['none', 'single', 'repeated', 'mixed'].includes(value.state) ||
      !Array.isArray(value.lines) || value.lines.length > 3 || !isBoundedTextArray(value.chips, 0, 6, 120)) return false;
  // An empty box must say so, and every sentence must point at rendered articles.
  return (value.state === 'none') === (value.lines.length === 0) && value.lines.every(line =>
    isRecord(line) && isBoundedText(line.text, 300) && isNewsTopicKey(line.topic) &&
    Array.isArray(line.articleIds) && line.articleIds.length >= 1 &&
    line.articleIds.every(id => typeof id === 'string' && articleIds.has(id)));
}

function isFactorSummary(value: unknown, articles: readonly NewsArticle[]): boolean {
  // Articles both models judged unrelated stay listed but are never cited as evidence.
  const ids = new Set(articles.filter(article => article.aiRelevance !== 'unrelated').map(article => article.id));
  return isRecord(value) && isFactorBox(value.positive, ids) && isFactorBox(value.negative, ids) &&
    isBoundedTextArray(value.chips, 0, 8, 120) && isBoundedText(value.note, 300);
}

/** Shared validation for provider adapters and both clients. */
export function isNewsArticle(value: unknown): value is NewsArticle {
  return isRecord(value) &&
    ['id', 'title', 'source', 'rationale'].every(key => isNonemptyString(value[key])) &&
    isTimestamp(value.publishedAt) && isSafeHttpsUrl(value.url) &&
    typeof value.sentiment === 'string' && ['positive', 'negative', 'neutral', 'unclassified'].includes(value.sentiment) &&
    hasValidArticleMetadata(value);
}

/**
 * Validate the entire network envelope before either client renders it. Type
 * assertions alone do not protect map(), date formatting, links or enum labels
 * from malformed JSON. Empty article/factor arrays are valid; absent fields are
 * not. A caller selecting a company should always pass its expected identifier.
 */
export function isNewsAnalysis(value: unknown, expectedCompanyId?: string): value is NewsAnalysis {
  if (!isRecord(value) || !isRecord(value.company) || !isRecord(value.period)) return false;
  const company = value.company;
  if (!['id', 'name', 'symbol', 'exchange', 'region'].every(key => isNonemptyString(company[key])) ||
      (expectedCompanyId !== undefined && company.id !== expectedCompanyId)) return false;
  if (typeof value.status !== 'string' || !['not_configured', 'insufficient', 'ready', 'error', 'rate_limited'].includes(value.status) ||
      typeof value.evidence !== 'string' || !['none', 'low', 'moderate'].includes(value.evidence)) return false;
  if (!isTimestamp(value.asOf) || !isNonemptyString(value.summary) || !isNonemptyString(value.analysisVersion) ||
      !isCalendarDate(value.period.start) || !isCalendarDate(value.period.end) || value.period.start > value.period.end ||
      !isStringArray(value.positiveFactors) || !isStringArray(value.negativeFactors) || !isStringArray(value.risks) ||
      !(value.provider === null || isNonemptyString(value.provider)) ||
      (value.message !== undefined && typeof value.message !== 'string') || !Array.isArray(value.articles)) return false;
  if ((value.cachedUntil !== undefined && !isTimestamp(value.cachedUntil)) ||
      (value.retryAt !== undefined && !isTimestamp(value.retryAt))) return false;
  if (value.newsWindow !== undefined && (!isRecord(value.newsWindow) ||
      !isTimestamp(value.newsWindow.start) || !isTimestamp(value.newsWindow.end) ||
      Date.parse(value.newsWindow.start) > Date.parse(value.newsWindow.end))) return false;
  if (value.sources !== undefined && !(Array.isArray(value.sources) && value.sources.length <= 8 && value.sources.every(isSourceState))) return false;
  if (value.servedFrom !== undefined && value.servedFrom !== 'live' && value.servedFrom !== 'stale') return false;
  if (value.refreshAttemptedAt !== undefined && !isTimestamp(value.refreshAttemptedAt)) return false;
  if (value.ai !== undefined && !isAiStatus(value.ai)) return false;
  if (!value.articles.every(isNewsArticle)) return false;
  return value.factorSummary === undefined || isFactorSummary(value.factorSummary, value.articles);
}

export const INVESTMENT_NOTICE = '뉴스는 미래 주가의 방향이나 원인을 증명하지 않습니다. 이 정보는 투자 참고용이며 개인 맞춤형 매수·매도 권유가 아닙니다. 투자 판단과 손실의 책임은 투자자 본인에게 있습니다.';

export { createNewsCache, NEWS_CACHE_TTL_MS, NEWS_CACHE_ANALYSIS_VERSION, NEWS_LAST_GOOD_MAX_AGE_MS, type NewsCacheStorage } from './news-cache.js';
export { NEWS_TOPICS, NEWS_TOPIC_KEYS, classifyNewsTopics, isNewsTopicKey, newsTopicLabel, type NewsTopicKey } from './news-topics.js';
export { COMPANY_NEWS_IDENTITY, matchesCompanyTitle, type CompanyNewsIdentity } from './news-identity.js';
export {
  GOAL_TYPES, GOAL_NAME_MAX_LENGTH, GOAL_LABEL_MAX_LENGTH, GOAL_NOTE_MAX_LENGTH, GOAL_ITEM_LIMIT, TRAVELERS_LIMIT, TRIP_NIGHTS_LIMIT,
  FREE_GOAL_NAME_SUGGESTIONS, HOME_REGIONS, HOUSING_TYPES, CAR_CONDITIONS, HOME_SCOPE_LABELS, CAR_SCOPE_LABELS, GOAL_SOURCE_LABELS,
  GOAL_SOURCE_NOTES, HOME_SCOPE_NOTES, CAR_SCOPE_NOTES,
  goalTypeName, createGoalDrafts, parseGoalNumber, resolveGoalTarget, formatGoalFormula, describeGoal, describeGoalTarget, describeGoalResult,
  createGoalPlanner, updateGoalPlanner,
  type GoalType, type GoalTypeDefinition, type GoalDrafts, type FreeGoalDraft, type HomeGoalDraft, type CarGoalDraft,
  type TravelGoalDraft, type GoalItemDraft, type HousingType, type CarCondition, type GoalTargetSource,
  type GoalFormulaLine, type GoalTargetResolution, type GoalPlannerState, type GoalPlannerAction,
} from './goals.js';
