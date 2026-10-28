/**
 * Fixed topic list shared by the rule-based factor summary and (later) model
 * labels. Topics describe what an article set is about, never a price outlook.
 * Earlier entries win when a title matches several topics.
 */
export const NEWS_TOPICS = [
  { key: 'earnings', label: '실적·가이던스',
    ko: ['실적', '영업이익', '매출', '순이익', '분기', '어닝', '가이던스', '흑자', '적자'],
    en: ['earnings', 'revenue', 'revenues', 'profit', 'profits', 'quarter', 'quarterly', 'guidance', 'results', 'eps', 'margin', 'margins'] },
  { key: 'analyst', label: '증권가 평가',
    ko: ['목표가', '목표주가', '투자의견', '애널리스트', '증권사'],
    en: ['analyst', 'analysts', 'price target', 'upgrade', 'upgrades', 'downgrade', 'downgrades', 'rating', 'outperform', 'overweight', 'underweight'] },
  { key: 'regulation', label: '규제·법률',
    ko: ['규제', '소송', '제재', '과징금', '반독점', '당국', '법원', '판결', '관세'],
    en: ['lawsuit', 'lawsuits', 'sue', 'sued', 'court', 'antitrust', 'regulator', 'regulators', 'regulatory', 'probe', 'investigation', 'fined', 'tariff', 'tariffs', 'ban', 'sanction', 'sanctions', 'ruling', 'settlement'] },
  { key: 'product', label: '제품·기술',
    ko: ['출시', '신제품', '기술', '개발', '반도체', '메모리', '파운드리', '인공지능', '스마트폰', '갤럭시', '아이폰', '전기차', '자율주행', '배터리', '리콜', '결함'],
    en: ['launch', 'launches', 'unveil', 'unveils', 'product', 'products', 'chip', 'chips', 'ai', 'iphone', 'gpu', 'gpus', 'hbm', 'foundry', 'semiconductor', 'semiconductors', 'ev', 'evs', 'robotaxi', 'autopilot', 'software', 'recall', 'defect'] },
  { key: 'demand', label: '수요·공급망',
    ko: ['수요', '공급', '수주', '주문', '판매량', '재고', '생산', '공장', '출하'],
    en: ['demand', 'supply', 'supplier', 'suppliers', 'orders', 'shipments', 'deliveries', 'inventory', 'production', 'factory', 'plant', 'sales'] },
  { key: 'deal', label: '투자·인수·제휴',
    ko: ['인수', '합병', '제휴', '협력', '계약', '투자', '지분', '파트너십', '협약'],
    en: ['acquisition', 'acquire', 'acquires', 'merger', 'deal', 'partnership', 'partner', 'partners', 'invest', 'investment', 'stake', 'contract', 'agreement'] },
  { key: 'shareholder', label: '주주환원',
    ko: ['배당', '자사주', '주주환원', '소각', '액면분할'],
    en: ['dividend', 'dividends', 'buyback', 'buybacks', 'repurchase', 'split'] },
  { key: 'management', label: '경영·지배구조',
    ko: ['대표이사', '회장', '사장', '임원', '경영', '지배구조', '사임', '선임', '노조', '파업'],
    en: ['ceo', 'chief executive', 'executive', 'executives', 'board', 'resign', 'resigns', 'appoint', 'appoints', 'layoff', 'layoffs', 'union', 'strike'] },
  { key: 'macro', label: '시장·거시',
    ko: ['금리', '환율', '물가', '경기 둔화', '경기 침체', '경기 회복', '증시', '코스피', '연준', '인플레이션'],
    en: ['rate', 'rates', 'fed', 'inflation', 'economy', 'treasury', 'yields', 'recession'] },
  { key: 'other', label: '기타 이슈', ko: [], en: [] },
] as const;

export type NewsTopicKey = typeof NEWS_TOPICS[number]['key'];

export const NEWS_TOPIC_KEYS: readonly NewsTopicKey[] = NEWS_TOPICS.map(topic => topic.key);

export function isNewsTopicKey(value: unknown): value is NewsTopicKey {
  return typeof value === 'string' && (NEWS_TOPIC_KEYS as readonly string[]).includes(value);
}

export function newsTopicLabel(key: NewsTopicKey): string {
  return NEWS_TOPICS.find(topic => topic.key === key)!.label;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const ENGLISH_PATTERNS = new Map(NEWS_TOPICS.map(topic => [topic.key, topic.en.map(word =>
  new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(word).replace(/ /g, '\\s+')}(?=$|[^\\p{L}\\p{N}])`, 'iu'))]));

/** Keyword topics in priority order; 'other' only when nothing matches. */
export function classifyNewsTopics(text: string): NewsTopicKey[] {
  const normalized = text.normalize('NFKC');
  const matches = NEWS_TOPICS.filter(topic => topic.key !== 'other' && (
    topic.ko.some(word => normalized.includes(word)) ||
    ENGLISH_PATTERNS.get(topic.key)!.some(pattern => pattern.test(normalized))
  )).map(topic => topic.key);
  return matches.length ? matches.slice(0, 3) : ['other'];
}
