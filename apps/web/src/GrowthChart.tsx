import { useEffect, useId, useRef, useState } from 'react';
import { formatCompactKRW, formatKRW, formatDurationMonths, type Projection, type ProjectionScenario } from '@moneycast/core';

export function GrowthChart({ projection, target, scenarios }: { projection: Projection; target: number; scenarios: ProjectionScenario[] }) {
  const id = useId().replace(/:/g, '');
  const container = useRef<HTMLDivElement>(null);
  const [chartWidth, setChartWidth] = useState(760);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const updateWidth = (width: number) => {
      // Keep the initial viewBox when layout measurements are unavailable
      // (for example in jsdom); never divide by a zero-width chart.
      if (Number.isFinite(width) && width > 0) setChartWidth(Math.round(width));
    };
    const measure = () => updateWidth(element.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(entries => {
      if (entries[0]) updateWidth(entries[0].contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const [hover, setHover] = useState<number | null>(null);
  const index = Math.min(hover ?? projection.months, projection.months);
  const point = projection.points[index];
  const compact = chartWidth < 520;
  const w = chartWidth, h = compact ? 260 : 320, left = compact ? 80 : 90, right = compact ? 16 : 24, top = 36, bottom = 44;
  const cw = w - left - right, ch = h - top - bottom;
  const max = Math.max(target, ...scenarios.map(s => s.projection.finalBalance), ...projection.points.map(p => Math.max(p.balance, p.principal)), 10000) * 1.16;
  const x = (month: number) => left + month / projection.months * cw;
  const y = (amount: number) => top + ch - amount / max * ch;
  const path = (p: Projection, key: 'balance' | 'principal') => p.points.map((pt, i) => `${i ? 'L' : 'M'}${x(pt.month).toFixed(2)},${y(pt[key]).toFixed(2)}`).join(' ');
  const line = path(projection, 'balance');
  const area = `${line} L${x(projection.months)},${y(0)} L${left},${y(0)} Z`;
  const tickIntervals = w < 380 ? 2 : w < 620 ? 3 : 5;
  const tickMonths = [...new Set(Array.from({ length: tickIntervals + 1 }, (_, i) => Math.round(projection.months * i / tickIntervals)))];
  const axisAmount = (amount: number) => {
    if (amount >= 1_000_000_000_000) return `${(amount / 1_000_000_000_000).toLocaleString('ko-KR', { maximumFractionDigits: 1 })}조`;
    if (amount >= 100_000_000) return `${(amount / 100_000_000).toLocaleString('ko-KR', { maximumFractionDigits: 1 })}억`;
    if (amount >= 10_000) return `${(amount / 10_000).toLocaleString('ko-KR', { maximumFractionDigits: 0 })}만`;
    return amount.toLocaleString('ko-KR', { maximumFractionDigits: 0 });
  };
  const targetLabelWidth = Math.min(160, cw);
  const handlePosition = (event: React.PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 0) return;
    setHover(Math.max(0, Math.min(projection.months, Math.round(((event.clientX - bounds.left) / bounds.width * w - left) / cw * projection.months))));
  };
  return <div className="growth-chart" ref={container}>
    <div className="chart-current"><span>{point.month === 0 ? '시작 시점' : `${formatDurationMonths(point.month)} 후`} 예상 자산</span><strong>{formatKRW(point.balance)}</strong></div>
    <svg className="chart-svg" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`${formatDurationMonths(projection.months)} 자산 추이. 예상 자산 ${formatKRW(projection.finalBalance)}, 납입 원금 ${formatKRW(projection.totalPrincipal)}${target ? `, 목표 ${formatKRW(target)}` : ''}. 아래 슬라이더로 월별 수치를 확인할 수 있습니다.`} onPointerMove={handlePosition} onPointerLeave={() => setHover(null)}>
      <defs><linearGradient id={`area-${id}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#79c991" stopOpacity=".29"/><stop offset="100%" stopColor="#a9dfbb" stopOpacity=".025"/></linearGradient></defs>
      {[0, 1, 2, 3, 4].map(t => { const amount = max * t / 4; return <g key={t}><line x1={left} x2={w - right} y1={y(amount)} y2={y(amount)} stroke="#e9eeeb" strokeDasharray={t ? '3 5' : undefined}/><text x={left - 12} y={y(amount) + 5} textAnchor="end" fill="#6a7e64" fontSize="14">{axisAmount(amount)}</text></g>; })}
      <path d={area} fill={`url(#area-${id})`}/>
      <path d={`${path(projection, 'principal')} L${x(projection.months)},${y(0)} L${left},${y(0)} Z`} fill="#e9eeec" opacity=".5"/>
      {scenarios.filter(s => s.key !== 'base').map(s => <path key={s.key} d={path(s.projection, 'balance')} stroke={s.key === 'optimistic' ? '#a4b8e3' : '#c2a78d'} strokeWidth="1.8" strokeDasharray="5 5" fill="none"/>)}
      <path d={path(projection, 'principal')} stroke="#a3b3ab" strokeWidth="1.7" fill="none"/>
      {target > 0 && <g><line x1={left} x2={w - right} y1={y(target)} y2={y(target)} stroke="#cf9965" strokeWidth="1.3" strokeDasharray="6 5"/><rect x={w - right - targetLabelWidth} y={y(target) - 35} width={targetLabelWidth} height="28" rx="6" fill="#fcf0e0"/><text x={w - right - 10} y={y(target) - 15} textAnchor="end" fill="#946335" fontSize="14">목표 {formatCompactKRW(target)}</text></g>}
      <path d={line} stroke="#398660" strokeWidth="3" strokeLinejoin="round" fill="none"/>
      {tickMonths.map(month => <text key={month} x={x(month)} y={h - 15} textAnchor={month === projection.months ? 'end' : 'middle'} fill="#6a7e64" fontSize="14">{month === 0 ? '현재' : month % 12 === 0 ? `${month / 12}년` : `${month}개월`}</text>)}
      <line x1={x(point.month)} x2={x(point.month)} y1={y(point.balance)} y2={y(0)} stroke="#6d9b7a" strokeDasharray="3 5" opacity=".6"/>
      <circle cx={x(point.month)} cy={y(point.balance)} r="8" fill="#398660" opacity=".13"/><circle cx={x(point.month)} cy={y(point.balance)} r="4.5" fill="#398660" stroke="white" strokeWidth="2"/>
    </svg>
    <div className="chart-bottom"><div className="legend"><span><i className="legend-green"/>예상 자산</span><span><i className="legend-gray"/>납입 원금</span>{target > 0 && <span><i className="legend-dash"/>목표 금액</span>}</div><span className="chart-hint">차트 위에서 월별 자산을 확인하세요</span></div>
    <label className="chart-slider"><span>월별 상세 <strong>{point.month}개월</strong></span><input type="range" min={0} max={projection.months} value={index} onChange={e => setHover(Number(e.target.value))} aria-label="월별 자산 확인" aria-valuetext={`${point.month}개월, 예상 자산 ${formatKRW(point.balance)}, 원금 ${formatKRW(point.principal)}`}/></label>
    <p className="chart-detail">납입 원금 {formatKRW(point.principal)}<span>·</span>예상 {point.profit < 0 ? '손실' : '수익'} {formatKRW(Math.abs(point.profit))}</p>
  </div>;
}
