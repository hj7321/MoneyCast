import { useState } from 'react';
import { formatYearMonth, monthInputValue, monthsFromTargetMonth, periodEndMonth } from '@moneycast/core';

/**
 * Another way to enter the saving period: the month the goal is due. The
 * period field stays the one value the calculator reads; this field shows its
 * end month and rewrites it when a month is picked.
 */
export function TargetMonthField({ months, onMonths }: { months: number; onMonths: (months: number) => void }) {
  // Text that does not make a valid month yet, kept while it is being typed.
  const [draft, setDraft] = useState<string | null>(null);
  const now = new Date();
  const valid = Number.isInteger(months) && months >= 1 && months <= 600;
  const read = draft ? monthsFromTargetMonth(draft, now) : null;
  const error = read && 'error' in read ? read.error : '';
  const hint = error || (valid ? `${formatYearMonth(periodEndMonth(months, now))}까지 모아요. 날짜를 고르면 목표 기간이 바뀌어요.` : '목표 기간을 먼저 확인해 주세요.');
  return <div className="field target-month-field">
    <label htmlFor="target-month">목표 시점</label>
    <div className={`input-wrap ${error ? 'invalid' : ''}`}>
      <input id="target-month" type="month" autoComplete="off" placeholder="2028-03" value={draft ?? (valid ? monthInputValue(periodEndMonth(months, now)) : '')}
        min={monthInputValue(periodEndMonth(1, now))} max={monthInputValue(periodEndMonth(600, now))}
        onChange={event => {
          const next = event.target.value;
          const result = monthsFromTargetMonth(next, now);
          if ('months' in result) {
            setDraft(null);
            onMonths(result.months);
          } else setDraft(next);
        }}
        onBlur={() => { if (draft === '') setDraft(null); }}
        aria-invalid={Boolean(error)} aria-describedby="target-month-hint"/>
    </div>
    <span id="target-month-hint" className={`field-hint ${error ? 'error-text' : ''}`}>{hint}</span>
  </div>;
}
