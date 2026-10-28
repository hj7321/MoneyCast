import { useMemo, useReducer, useState, type ReactNode } from 'react';
import {
  createGoalDrafts, createGoalPlanner, describeGoalResult, describeGoalTarget, describeInflation, formatCompactKRW, formatGoalFormula, goalTypeName,
  loadSavedGoalAction, parseGoalNumber, resolveGoalTarget, updateGoalPlanner,
  CAR_CONDITIONS, CAR_SCOPE_LABELS, CAR_SCOPE_NOTES, FREE_GOAL_NAME_SUGGESTIONS, GOAL_DISTRICT_MAX_LENGTH, GOAL_ITEM_LIMIT, GOAL_LABEL_MAX_LENGTH,
  GOAL_NAME_MAX_LENGTH, GOAL_NOTE_MAX_LENGTH, GOAL_SOURCE_LABELS, GOAL_SOURCE_NOTES, GOAL_TYPES, HOME_REGIONS, HOME_SCOPE_LABELS, HOME_SCOPE_NOTES,
  HOUSING_TYPES,
  type FreeGoalDraft, type GoalComparison, type GoalDrafts, type GoalInflationDraft, type GoalItemDraft, type GoalPlannerAction, type GoalType,
  type SavedGoal,
} from '@moneycast/core';
import { GoalAssist } from './GoalAssist';
import { GoalIcon, Icon } from './icons';

const formatAmount = (amount: number) => amount.toLocaleString('en-US', { maximumFractionDigits: 2 });
const isAmount = (value: number | null): value is number => value !== null && Number.isFinite(value) && value >= 0;
export type GoalPlannerControls = ReturnType<typeof useGoalPlanner>;

/** The goal type, its details and any amount typed into the target field; kept in memory only unless the person saves the goal. */
export function useGoalPlanner() {
  const [state, dispatch] = useReducer(updateGoalPlanner, undefined, () => createGoalPlanner(formatAmount));
  const { goal, drafts, inflation } = state;
  const override = state.overrides[goal];
  const resolution = useMemo(() => resolveGoalTarget(goal, drafts, override), [goal, drafts, override]);
  return {
    state, goal, drafts, override, resolution, inflation,
    /** The goal and its target in one line for the result area, with the amount compared against when a price rise is assumed. */
    describeResult: (inflated?: number) => describeGoalResult(goal, drafts, resolution, formatCompactKRW, inflated),
    select: (next: GoalType) => dispatch({ type: 'select', goal: next }),
    update: <T extends GoalType>(type: T, patch: Partial<GoalDrafts[T]>) => dispatch({ type: 'update', goal: type, patch } as GoalPlannerAction),
    setFreeMethod: (method: FreeGoalDraft['method']) => dispatch({ type: 'freeMethod', method }),
    typeTarget: (text: string) => dispatch({ type: 'typeTarget', text }),
    formatTarget() {
      const value = override === undefined ? null : parseGoalNumber(override);
      if (isAmount(value)) dispatch({ type: 'typeTarget', text: formatAmount(value) });
    },
    followDetails: () => dispatch({ type: 'followDetails' }),
    setInflation: (patch: Partial<GoalInflationDraft>) => dispatch({ type: 'inflation', patch }),
    load: (saved: SavedGoal) => dispatch(loadSavedGoalAction(saved)),
    reset: () => dispatch({ type: 'reset', drafts: createGoalDrafts(formatAmount) }),
    /** Applies information the person chose from the description card. */
    apply: (actions: readonly GoalPlannerAction[]) => actions.forEach(dispatch),
    formatAmount,
  };
}

/** Same markup as the calculator's own fields, so their styles and hints apply. */
function NumberField({ id, label, value, onChange, error, hint, unit = '원', placeholder }: {
  id: string; label: string; value: string; onChange: (text: string) => void; error?: string; hint?: string; unit?: string; placeholder?: string;
}) {
  const parsed = parseGoalNumber(value);
  const money = unit === '원';
  const note = error || [money && isAmount(parsed) ? formatCompactKRW(parsed) : '', hint].filter(Boolean).join(' · ');
  return <div className="field">
    <label htmlFor={id}>{label}</label>
    <div className={`input-wrap ${error ? 'invalid' : ''}`}><input id={id} inputMode={unit === '%' ? 'decimal' : 'numeric'} autoComplete="off" value={value} placeholder={placeholder}
      onChange={event => onChange(event.target.value)} onBlur={() => { if (money && isAmount(parsed)) onChange(formatAmount(parsed)); }}
      aria-invalid={Boolean(error)} aria-describedby={`${id}-hint`}/><span>{unit}</span></div>
    <span id={`${id}-hint`} className={`field-hint ${error ? 'error-text' : ''}`}>{note}</span>
  </div>;
}

function TextField({ id, label, value, onChange, maxLength, placeholder, hint, wide = true }: {
  id: string; label: string; value: string; onChange: (text: string) => void; maxLength: number; placeholder?: string; hint?: string; wide?: boolean;
}) {
  return <div className={`field ${wide ? 'goal-wide' : ''}`}>
    <label htmlFor={id}>{label}</label>
    <div className="input-wrap goal-text-input"><input id={id} type="text" autoComplete="off" value={value} maxLength={maxLength} placeholder={placeholder}
      onChange={event => onChange(event.target.value)} aria-describedby={hint ? `${id}-hint` : undefined}/></div>
    {hint && <span id={`${id}-hint`} className="field-hint">{hint}</span>}
  </div>;
}

function SelectField({ id, label, value, options, onChange }: {
  id: string; label: string; value: string; options: readonly (readonly [string, string])[]; onChange: (value: string) => void;
}) {
  return <div className="field">
    <label htmlFor={id}>{label}</label>
    <div className="input-wrap goal-text-input"><select id={id} value={value} onChange={event => onChange(event.target.value)}>
      <option value="">선택 안 함</option>{options.map(([option, text]) => <option key={option} value={option}>{text}</option>)}
    </select></div>
  </div>;
}

function Choice<T extends string>({ legend, value, options, onChange, note }: {
  legend: string; value: T; options: readonly (readonly [T, string])[]; onChange: (value: T) => void; note?: string;
}) {
  return <fieldset className="goal-choice goal-wide"><legend>{legend}</legend>
    <div>{options.map(([option, text]) => <button key={option} type="button" className={value === option ? 'chosen' : ''} aria-pressed={value === option} onClick={() => onChange(option)}>{text}</button>)}</div>
    {note && <p className="field-hint">{note}</p>}
  </fieldset>;
}

function CostsField({ id, checked, value, error, hint, onToggle, onChange }: {
  id: string; checked: boolean; value: string; error?: string; hint: string; onToggle: (checked: boolean) => void; onChange: (text: string) => void;
}) {
  return <>
    <label className="goal-check goal-wide"><input type="checkbox" checked={checked} onChange={event => onToggle(event.target.checked)}/>부대비용 포함</label>
    {checked && <NumberField id={id} label="부대비용" value={value} error={error} hint={hint} onChange={onChange}/>}
  </>;
}

export function GoalPlanner({ planner, comparison, targetError, onPeriod }: {
  planner: GoalPlannerControls; comparison: GoalComparison; targetError?: string; onPeriod: (months: number) => void;
}) {
  const { goal, drafts, override, resolution, inflation, update } = planner;
  const [moreOpen, setMoreOpen] = useState(false);
  const { errors } = resolution;
  const updateItem = (index: number, patch: Partial<GoalItemDraft>) =>
    update('free', { items: drafts.free.items.map((item, position) => position === index ? { ...item, ...patch } : item) });

  let main: ReactNode;
  let more: ReactNode = null;
  if (goal === 'free') {
    const free = drafts.free;
    main = <>
      <TextField id="goal-free-name" label="목표 이름" value={free.name} maxLength={GOAL_NAME_MAX_LENGTH} placeholder="예: 결혼 자금"
        hint="결과에 이 이름으로 표시돼요. 예시를 눌러도 금액은 바뀌지 않아요." onChange={value => update('free', { name: value })}/>
      <div className="goal-suggestions goal-wide" role="group" aria-label="목표 이름 예시">{FREE_GOAL_NAME_SUGGESTIONS.map(suggestion =>
        <button key={suggestion} type="button" onClick={() => update('free', { name: suggestion })}>{suggestion}</button>)}</div>
      <div className="field goal-wide">
        <label htmlFor="goal-free-note">설명(선택)</label>
        <textarea id="goal-free-note" rows={2} maxLength={GOAL_NOTE_MAX_LENGTH} value={free.note} placeholder="예: 내년 10월 결혼, 예식 2천만 원이랑 신혼여행 500만 원"
          onChange={event => update('free', { note: event.target.value })} aria-describedby="goal-free-note-hint"/>
        <span id="goal-free-note-hint" className="field-hint">이 기기에서 먼저 정리하고, 새로고침하면 지워져요.</span>
      </div>
      <GoalAssist planner={planner} onPeriod={onPeriod}/>
      <Choice legend="금액 정하는 방법" value={free.method} onChange={planner.setFreeMethod}
        options={[['direct', '직접 입력'], ['items', '항목 합산'], ['undecided', '아직 모름']]}
        note={free.method === 'direct' ? '아래 목표 금액 칸에 입력해요.' : free.method === 'items' ? '항목 금액을 더해 목표 금액을 정해요.' : '목표 금액 없이 자산 추이만 계산해요. 정해지면 다른 방법을 골라 주세요.'}/>
      {free.method === 'items' && <div className="goal-items goal-wide">
        {free.items.map((item, index) => <div className="goal-item-row" key={index}>
          <TextField id={`goal-item-${index}-label`} label={`항목 ${index + 1} 이름`} value={item.label} maxLength={GOAL_LABEL_MAX_LENGTH} placeholder="예: 예식장"
            onChange={label => updateItem(index, { label })}/>
          <NumberField id={`goal-item-${index}-amount`} label={`항목 ${index + 1} 금액`} value={item.amount} error={errors[`items.${index}.amount`]}
            onChange={amount => updateItem(index, { amount })}/>
          {free.items.length > 1 && <button type="button" className="goal-item-remove" aria-label={`항목 ${index + 1} 삭제`}
            onClick={() => update('free', { items: free.items.filter((_, position) => position !== index) })}><Icon name="close" size={16}/></button>}
        </div>)}
        {free.items.length < GOAL_ITEM_LIMIT && <button type="button" className="goal-link" onClick={() => update('free', { items: [...free.items, { label: '', amount: '' }] })}>+ 항목 추가</button>}
      </div>}
    </>;
  } else if (goal === 'home' || goal === 'car') {
    const home = goal === 'home';
    const draft = home ? drafts.home : drafts.car;
    const set = (patch: Partial<GoalDrafts['home'] & GoalDrafts['car']>) => update(goal, patch);
    main = <>
      {home
        ? <Choice legend="모으려는 금액" value={drafts.home.scope} note={HOME_SCOPE_NOTES[drafts.home.scope]} onChange={scope => update('home', { scope })}
          options={[['full', HOME_SCOPE_LABELS.full], ['equity', HOME_SCOPE_LABELS.equity], ['initial', HOME_SCOPE_LABELS.initial]]}/>
        : <Choice legend="모으려는 금액" value={drafts.car.scope} note={CAR_SCOPE_NOTES[drafts.car.scope]} onChange={scope => update('car', { scope })}
          options={[['full', CAR_SCOPE_LABELS.full], ['initial', CAR_SCOPE_LABELS.initial]]}/>}
      <NumberField id={`goal-${goal}-price`} label={home ? '예상 매입 가격' : '예상 차량 가격'} value={draft.price} error={errors.price}
        hint={home ? undefined : '트림·옵션을 포함한 금액'} onChange={price => set({ price })}/>
      {home && drafts.home.scope === 'equity' && <NumberField id="goal-home-loan" label="대출 예정 금액" value={drafts.home.loan} error={errors.loan} onChange={loan => set({ loan })}/>}
      {draft.scope === 'initial' && <>
        <Choice legend="초기 자금 입력 방식" value={draft.initialBy} onChange={initialBy => set({ initialBy })} options={[['rate', '가격의 비율로'], ['amount', '금액으로']]}/>
        {draft.initialBy === 'rate'
          ? <NumberField id={`goal-${goal}-rate`} label="초기 자금 비율" unit="%" value={draft.initialRate} error={errors.initialRate} onChange={initialRate => set({ initialRate })}/>
          : <NumberField id={`goal-${goal}-initial`} label="초기 자금" value={draft.initialAmount} error={errors.initialAmount} onChange={initialAmount => set({ initialAmount })}/>}
      </>}
    </>;
    const costsHint = home ? '취득세·중개보수·등기·이사비 등의 합계. 세금은 자동 계산하지 않아요.'
      : drafts.car.condition === 'used' ? '이전등록비·보험료 등의 합계. 세금은 자동 계산하지 않아요.' : '취득세·공채·등록·탁송·첫해 보험료 등의 합계. 세금은 자동 계산하지 않아요.';
    more = <>
      {home ? <>
        <SelectField id="goal-home-region" label="지역(시·도)" value={drafts.home.region} options={HOME_REGIONS.map(region => [region, region] as const)} onChange={region => set({ region })}/>
        <TextField id="goal-home-district" label="시·군·구" value={drafts.home.district} maxLength={GOAL_DISTRICT_MAX_LENGTH} placeholder="예: 마포구" wide={false}
          onChange={district => set({ district })}/>
        <SelectField id="goal-home-housing" label="주택 유형" value={drafts.home.housing} options={HOUSING_TYPES.map(type => [type.id, type.label] as const)}
          onChange={housing => update('home', { housing: housing as GoalDrafts['home']['housing'] })}/>
      </> : <>
        <TextField id="goal-car-model" label="차종·모델" value={drafts.car.model} maxLength={GOAL_LABEL_MAX_LENGTH} placeholder="예: 아반떼 하이브리드" onChange={model => set({ model })}/>
        <SelectField id="goal-car-condition" label="신차·중고차" value={drafts.car.condition} options={CAR_CONDITIONS.map(condition => [condition.id, condition.label] as const)}
          onChange={condition => update('car', { condition: condition as GoalDrafts['car']['condition'] })}/>
      </>}
      <CostsField id={`goal-${goal}-costs`} checked={draft.includeCosts} value={draft.costs} error={errors.costs} hint={costsHint}
        onToggle={includeCosts => set({ includeCosts })} onChange={costs => set({ costs })}/>
    </>;
  } else {
    const trip = drafts.travel;
    const set = (patch: Partial<GoalDrafts['travel']>) => update('travel', patch);
    const nights = parseGoalNumber(trip.nights);
    main = <>
      <TextField id="goal-travel-destination" label="여행지" value={trip.destination} maxLength={GOAL_LABEL_MAX_LENGTH} placeholder="예: 오사카" onChange={destination => set({ destination })}/>
      <Choice legend="예산 정하는 방법" value={trip.method} onChange={method => set({ method })} options={[['total', '총액 입력'], ['items', '항목별 계산']]}
        note={trip.method === 'items' ? '항목 금액에 인원·박 수·일 수를 곱해 더해요. 비운 항목은 0원으로 계산해요.' : undefined}/>
      {trip.method === 'total'
        ? <NumberField id="goal-travel-total" label="총 예산" value={trip.total} error={errors.total} onChange={total => set({ total })}/>
        : <>
          <NumberField id="goal-travel-travelers" label="인원" unit="명" value={trip.travelers} error={errors.travelers} onChange={travelers => set({ travelers })}/>
          <NumberField id="goal-travel-nights" label="박 수" unit="박" value={trip.nights} error={errors.nights} onChange={value => set({ nights: value })}/>
          <NumberField id="goal-travel-days" label="일 수" unit="일" value={trip.days} error={errors.days} hint="비우면 박 수 + 1일"
            placeholder={nights !== null && Number.isInteger(nights) && nights >= 0 ? String(nights + 1) : undefined} onChange={days => set({ days })}/>
          <NumberField id="goal-travel-flight" label="항공권(1인 왕복)" value={trip.flight} error={errors.flight} onChange={flight => set({ flight })}/>
          <NumberField id="goal-travel-lodging" label="숙박비(1박 전체)" value={trip.lodging} error={errors.lodging} onChange={lodging => set({ lodging })}/>
          <NumberField id="goal-travel-daily" label="현지 경비(1인 1일)" value={trip.daily} error={errors.daily} onChange={daily => set({ daily })}/>
          <NumberField id="goal-travel-other" label="기타 비용" value={trip.other} error={errors.other} hint="보험·비자·쇼핑 등" onChange={other => set({ other })}/>
        </>}
    </>;
  }

  const { source, amount, lines, zeroed } = resolution;
  const detailErrors = Object.keys(errors).length > 0;
  const targetText = override ?? (amount !== null && Number.isFinite(amount) ? formatAmount(amount) : '');
  const invalid = Boolean(targetError) || detailErrors;
  const targetHint = source === 'manual' && targetError ? targetError : describeGoalTarget(resolution, formatCompactKRW);
  const followable = override !== undefined && (goal !== 'free' || drafts.free.method !== 'direct');

  return <div className="goal-planner">
    <fieldset className="goal-picker"><legend>목표 유형 <span>예시 금액으로 시작하고, 아래에서 바꿀 수 있어요</span></legend><div>{GOAL_TYPES.map(type =>
      <button key={type.id} type="button" className={goal === type.id ? 'chosen' : ''} onClick={() => planner.select(type.id)} aria-pressed={goal === type.id}>
        <span className="goal-type-icon" aria-hidden="true">{type.id === 'free' ? <Icon name="spark" size={18}/> : <GoalIcon name={type.id === 'travel' ? 'plane' : type.id}/>}</span>
        <span className="goal-type-label">{type.name}</span>
      </button>)}</div></fieldset>
    <section className="goal-details" aria-labelledby="goal-details-title">
      <div className="goal-details-heading"><h3 id="goal-details-title">{goalTypeName(goal)} 정보</h3><p>{GOAL_SOURCE_NOTES[goal]}</p></div>
      <div className="goal-details-fields">{main}</div>
      {more && <>
        <button type="button" className="goal-more-toggle" aria-expanded={moreOpen} aria-controls="goal-more" onClick={() => setMoreOpen(open => !open)}>
          {moreOpen ? '선택 항목 접기' : '더 자세히 입력(선택)'}<Icon name="chevron" size={14}/></button>
        <div id="goal-more" className="goal-details-fields" hidden={!moreOpen}>{more}</div>
      </>}
    </section>
    <div className="field goal-target-field">
      <div className="goal-target-head"><label htmlFor="target">목표 금액</label><span id="target-source" className={`goal-source-badge ${source}`}>{GOAL_SOURCE_LABELS[source]}</span></div>
      <div className={`input-wrap ${invalid ? 'invalid' : ''}`}><input id="target" inputMode="numeric" autoComplete="off" value={targetText} placeholder={source === 'undecided' ? '미정' : undefined}
        onChange={event => planner.typeTarget(event.target.value)} onBlur={planner.formatTarget} aria-invalid={invalid} aria-describedby="target-source target-hint"/><span>원</span></div>
      <span id="target-hint" className={`field-hint ${invalid ? 'error-text' : ''}`}>{targetHint}</span>
      {source === 'details' && lines.length > 0 && !detailErrors && <p className="goal-formula">= {formatGoalFormula(lines, formatCompactKRW)}</p>}
      {source === 'details' && zeroed.length > 0 && <p className="goal-formula">{zeroed.join(', ')}: 입력하지 않아 0원으로 계산했어요.</p>}
      {followable && <button type="button" className="goal-link" onClick={planner.followDetails}>상세 입력으로 다시 계산</button>}
      <div className="goal-inflation">
        <label className="goal-check"><input type="checkbox" checked={inflation.on} onChange={event => planner.setInflation({ on: event.target.checked })}/>물가상승 반영(선택)</label>
        {inflation.on && <>
          <p className="field-hint">목표 금액을 오늘 가격으로 보고, 목표 기간 동안 매년 이 비율로 오른다고 가정해 비교해요. 예측이 아닌 나의 가정이에요.</p>
          <NumberField id="goal-inflation-rate" label="연 물가상승률" unit="%" value={inflation.rate} error={comparison.error}
            hint={describeInflation(comparison, formatCompactKRW)} onChange={rate => planner.setInflation({ rate })}/>
        </>}
      </div>
    </div>
  </div>;
}
