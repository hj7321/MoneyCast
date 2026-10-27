import type { CSSProperties } from 'react';
export type IconName = 'grid' | 'chart' | 'news' | 'arrow' | 'info' | 'check' | 'search' | 'chevron' | 'refresh' | 'target' | 'wallet' | 'trend' | 'external' | 'spark' | 'close' | 'download' | 'shield' | 'menu';
const paths: Record<IconName, React.ReactNode> = {
  grid: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
  chart: <><path d="M4 3v17h17M8 14l4-5 4 3 5-7"/></>,
  news: <><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8M8 11h3M8 15h8M8 18h8M15 11h1"/></>,
  arrow: <path d="M4 12h16m-6-6 6 6-6 6"/>,
  info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/></>,
  check: <path d="m5 12 4 4L19 6"/>,
  search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
  chevron: <path d="m9 5 7 7-7 7"/>,
  refresh: <><path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5"/></>,
  target: <><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/></>,
  wallet: <><path d="M20 8V5a2 2 0 0 0-2-2H6a3 3 0 0 0 0 6h15v11H6a3 3 0 0 1-3-3V6"/><path d="M21 12h-6v5h6"/></>,
  trend: <><path d="m3 17 6-6 4 4 8-11m-7 0h7v7"/></>,
  external: <><path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/></>,
  spark: <><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/></>,
  close: <path d="m6 6 12 12M18 6 6 18"/>,
  download: <><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/></>,
  shield: <><path d="m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6l8-4Z"/><path d="m8 11 3 3 5-5"/></>,
  menu: <path d="M4 6h16M4 12h16M4 18h16"/>,
};
export function Icon({ name, size = 20, style, className = '' }: { name: IconName; size?: number; style?: CSSProperties; className?: string }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" style={style} className={className}>{paths[name]}</svg>;
}
export function Brand({ compact = false }: { compact?: boolean }) {
  return <span className="brand"><svg aria-hidden="true" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="10" fill="#b8eac2"/><path d="M8 23V12l6 6 7-10v15M21 8h5" fill="none" stroke="#193b3b" strokeWidth="2.6" strokeLinejoin="round" strokeLinecap="round"/></svg>{!compact && <span>Money<span className="brand-light">Cast</span><span className="brand-dot">.</span></span>}</span>;
}
