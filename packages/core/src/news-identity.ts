/**
 * Company identity rules for news sources. Marketaux matches provider entity
 * names; sources without entity tags must name the company in the title and
 * must not name a different issuer or share class.
 */
export interface CompanyNewsIdentity {
  /** Provider entity names accepted for this listed company. */
  entityNames: readonly string[];
  /** At least one must appear in a title from a name-matched source. */
  titleTerms: readonly string[];
  /** Any of these marks a different issuer, subsidiary listing or share class. */
  excludeTerms: readonly string[];
  /** English search expression; GDELT searches English machine translations. */
  searchQuery: string;
  /** A single word the article must repeat three times; GDELT's repeat operator takes one word. */
  repeatWord: string;
}

export const COMPANY_NEWS_IDENTITY: Readonly<Record<string, CompanyNewsIdentity>> = {
  'krx:005930': {
    entityNames: ['삼성전자', 'Samsung Electronics'],
    titleTerms: ['삼성전자', 'Samsung Electronics'],
    excludeTerms: ['삼성전자우', '삼성전자 우선주', 'Samsung Electronics preferred'],
    searchQuery: '"Samsung Electronics"',
    repeatWord: 'Samsung',
  },
  'krx:000660': {
    entityNames: ['SK하이닉스', '에스케이하이닉스', 'SK Hynix'],
    titleTerms: ['SK하이닉스', '하이닉스', 'SK Hynix', 'Hynix'],
    excludeTerms: [],
    searchQuery: '"SK Hynix"',
    repeatWord: 'Hynix',
  },
  'krx:035420': {
    entityNames: ['NAVER', '네이버'],
    titleTerms: ['네이버', 'Naver'],
    excludeTerms: [],
    searchQuery: '"Naver"',
    repeatWord: 'Naver',
  },
  'krx:005380': {
    entityNames: ['현대자동차', 'Hyundai Motor'],
    titleTerms: ['현대자동차', '현대차', 'Hyundai Motor'],
    excludeTerms: ['현대차증권', '현대모비스', '현대건설', '현대제철', 'Hyundai Mobis', 'Hyundai Steel', 'Hyundai Heavy'],
    searchQuery: '"Hyundai Motor"',
    repeatWord: 'Hyundai',
  },
  'nasdaq:AAPL': {
    entityNames: ['Apple'],
    titleTerms: ['Apple', '애플', 'AAPL'],
    excludeTerms: ['Apple Hospitality', 'Apple Bank', 'apple cider'],
    searchQuery: '("Apple Inc" OR "Apple shares" OR "Apple stock" OR "Apple iPhone" OR "Tim Cook")',
    repeatWord: 'Apple',
  },
  'nasdaq:NVDA': {
    entityNames: ['Nvidia'],
    titleTerms: ['Nvidia', '엔비디아', 'NVDA'],
    excludeTerms: [],
    searchQuery: '"Nvidia"',
    repeatWord: 'Nvidia',
  },
  'nasdaq:MSFT': {
    entityNames: ['Microsoft'],
    titleTerms: ['Microsoft', '마이크로소프트', 'MSFT'],
    excludeTerms: [],
    searchQuery: '"Microsoft"',
    repeatWord: 'Microsoft',
  },
  'nasdaq:TSLA': {
    entityNames: ['Tesla'],
    titleTerms: ['Tesla', '테슬라', 'TSLA'],
    excludeTerms: ['Nikola Tesla', 'Tesla coil'],
    searchQuery: '"Tesla"',
    repeatWord: 'Tesla',
  },
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Hangul terms match as substrings (particles attach directly); Latin terms match whole words. */
function containsTerm(text: string, term: string): boolean {
  if (/[가-힣]/.test(term)) return text.includes(term);
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(term).replace(/ /g, '\\s+')}(?=$|[^\\p{L}\\p{N}])`, 'iu').test(text);
}

/** Title-level identity check for sources that do not tag company entities. */
export function matchesCompanyTitle(companyId: string, title: string): boolean {
  const identity = COMPANY_NEWS_IDENTITY[companyId];
  if (!identity) return false;
  const text = title.normalize('NFKC');
  return identity.titleTerms.some(term => containsTerm(text, term)) &&
    !identity.excludeTerms.some(term => containsTerm(text, term));
}
