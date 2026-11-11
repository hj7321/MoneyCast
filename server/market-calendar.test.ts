import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARTICLE_DELAY_MS, CALENDAR_UNVERIFIED, CALENDAR_VERIFIED, EXCHANGE_CALENDARS, addDays, classifyArticleTime, closesEarly, dayTargetWindow,
  inOvernightWindow, lastClosedSession, localDate, overnightWindow, sessionOn, sessionsAfter, sessionsBefore, sessionsFrom,
  targetSession, weekSessions, weekTargetWindow, weeklyAsOfAtOrBefore, weeklyAsOfsBetween, weeklyWindows, zonedTimeToUtc,
  type ArticleTiming, type Exchange, type OvernightWindow, type Session, type TargetSession,
} from './market-calendar.js';

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();
const MINUTE = 60_000;

function timing(exchange: Exchange, published: string): ArticleTiming {
  const value = classifyArticleTime(exchange, at(published));
  assert.notEqual(value, CALENDAR_UNVERIFIED, `${published} should be inside coverage`);
  return value as ArticleTiming;
}
function session(exchange: Exchange, date: string): Session {
  const value = sessionOn(exchange, date);
  assert.ok(value && value !== CALENDAR_UNVERIFIED, `${date} should be a ${exchange} session`);
  return value as Session;
}
function target(exchange: Exchange, now: string): TargetSession {
  const value = targetSession(exchange, at(now));
  assert.notEqual(value, CALENDAR_UNVERIFIED);
  return value as TargetSession;
}
const dates = (sessions: Session[] | typeof CALENDAR_UNVERIFIED) => {
  assert.notEqual(sessions, CALENDAR_UNVERIFIED);
  return (sessions as Session[]).map(item => item.date);
};

test('the tables are flagged verified (checked 2026-11-11 against official schedules and observed dates)', () => {
  assert.equal(CALENDAR_VERIFIED, true);
});

test('holiday and changed-hours tables are weekdays inside their declared coverage and never overlap', () => {
  for (const [exchange, calendar] of Object.entries(EXCHANGE_CALENDARS)) {
    for (const date of [...calendar.holidays, ...calendar.changedHours.keys()]) {
      const day = new Date(`${date}T00:00:00Z`).getUTCDay();
      assert.ok(day !== 0 && day !== 6, `${exchange} ${date} is a weekend`);
      assert.ok(date >= calendar.coverage.from && date <= calendar.coverage.to, `${exchange} ${date} is outside coverage`);
    }
    for (const [date, hours] of calendar.changedHours) {
      assert.ok(!calendar.holidays.has(date), `${exchange} ${date} is both`);
      assert.ok(/^\d{2}:\d{2}$/.test(hours.open) && /^\d{2}:\d{2}$/.test(hours.close) && hours.open < hours.close, `${exchange} ${date} hours`);
      assert.ok(hours.open !== calendar.open || hours.close !== calendar.close, `${exchange} ${date} repeats the regular hours`);
    }
  }
});

test('2026-07-17 (제헌절) is a KRX closure, so that week has four sessions', () => {
  assert.equal(sessionOn('KRX', '2026-07-17'), null);
  assert.ok(session('NASDAQ', '2026-07-17'));
  assert.deepEqual(dates(sessionsAfter('KRX', '2026-07-16', 1)), ['2026-07-20']);
  assert.deepEqual(dates(weekSessions('KRX', at('2026-07-12T23:50:00Z'))), ['2026-07-13', '2026-07-14', '2026-07-15', '2026-07-16', '2026-07-20']);
  // Thursday evening targets Monday against Thursday's close.
  const evening = target('KRX', '2026-07-16T09:00:00Z');
  assert.deepEqual([evening.phase, evening.session.date, evening.previous.date], ['after_close', '2026-07-20', '2026-07-16']);
});

test('KRX changed hours: opening days run 10:00-15:30 and CSAT days 10:00-16:30 KST', () => {
  for (const date of ['2023-01-02', '2024-01-02', '2025-01-02', '2026-01-02']) {
    const day = session('KRX', date);
    assert.deepEqual([iso(day.openMs), iso(day.closeMs)], [`${date}T01:00:00.000Z`, `${date}T06:30:00.000Z`], date);
  }
  for (const date of ['2023-11-16', '2024-11-14', '2025-11-13', '2026-11-19']) {
    const day = session('KRX', date);
    assert.deepEqual([iso(day.openMs), iso(day.closeMs)], [`${date}T01:00:00.000Z`, `${date}T07:30:00.000Z`], date);
  }
  // The next day keeps the regular 09:00-15:30.
  const regular = session('KRX', '2026-11-20');
  assert.deepEqual([iso(regular.openMs), iso(regular.closeMs)], ['2026-11-20T00:00:00.000Z', '2026-11-20T06:30:00.000Z']);
  // A 16:30 close is late, not early; only Nasdaq half days close early.
  assert.equal(closesEarly('KRX', '2026-11-19'), false);
  assert.equal(closesEarly('KRX', '2026-01-02'), false);
  assert.equal(closesEarly('NASDAQ', '2026-11-27'), true);
  assert.equal(closesEarly('NASDAQ', '2026-11-25'), false);
});

test('articles around a changed open or close are classified by that day\'s hours', () => {
  // 09:30 KST on 2026-01-02 (+5 min = 09:35) is before the 10:00 open: entry at that open.
  const opening = timing('KRX', '2026-01-02T00:30:00Z');
  assert.deepEqual(pick(opening), { kind: 'out_of_session', date: '2026-01-02' });
  assert.equal(iso(opening.session.openMs), '2026-01-02T01:00:00.000Z');
  // 09:57 KST + 5 minutes = 10:02, in session.
  assert.deepEqual(pick(timing('KRX', '2026-01-02T00:57:00Z')), { kind: 'in_session', date: '2026-01-02' });
  // 15:50 KST on the CSAT day is in session (16:30 close); 16:25 + 5 = 16:30 still is; 16:27 + 5 = 16:32 is not.
  assert.deepEqual(pick(timing('KRX', '2026-11-19T06:50:00Z')), { kind: 'in_session', date: '2026-11-19' });
  assert.deepEqual(pick(timing('KRX', '2026-11-19T07:25:00Z')), { kind: 'in_session', date: '2026-11-19' });
  assert.deepEqual(pick(timing('KRX', '2026-11-19T07:27:00Z')), { kind: 'out_of_session', date: '2026-11-20' });
  // 09:30 KST on the CSAT day is before its 10:00 open.
  assert.deepEqual(pick(timing('KRX', '2026-11-19T00:30:00Z')), { kind: 'out_of_session', date: '2026-11-19' });
  // The same times on a regular day: 09:30 is in session and 15:50 is after the 15:30 close.
  assert.deepEqual(pick(timing('KRX', '2026-11-18T00:30:00Z')), { kind: 'in_session', date: '2026-11-18' });
  assert.deepEqual(pick(timing('KRX', '2026-11-18T06:50:00Z')), { kind: 'out_of_session', date: '2026-11-19' });
  // The overnight window into the CSAT day ends at its 10:00 open, and the next one starts at its 16:30 close.
  const csat = overnightWindow('KRX', session('KRX', '2026-11-19')) as OvernightWindow;
  assert.deepEqual([iso(csat.startMs), iso(csat.endMs)], ['2026-11-18T06:30:00.000Z', '2026-11-19T01:00:00.000Z']);
  const after = overnightWindow('KRX', session('KRX', '2026-11-20')) as OvernightWindow;
  assert.equal(iso(after.startMs), '2026-11-19T07:30:00.000Z');
});

test('during the extra CSAT hour the day is not yet closed', () => {
  const closed = (now: string) => (lastClosedSession('KRX', at(now)) as Session).date;
  // 16:00 KST on 2026-11-19: the close is not final until 16:30.
  assert.equal(closed('2026-11-19T07:00:00Z'), '2026-11-18');
  assert.equal(closed('2026-11-19T07:30:00Z'), '2026-11-19');
  assert.equal(closed('2025-11-13T07:00:00Z'), '2025-11-12');
  const live = target('KRX', '2026-11-19T07:00:00Z');
  assert.deepEqual([live.phase, live.session.date, live.previous.date], ['in_session', '2026-11-19', '2026-11-18']);
  // Before the 10:00 open the phase is still before_open.
  assert.equal(target('KRX', '2026-11-19T00:30:00Z').phase, 'before_open');
});

test('local wall time converts through the zone database, so US daylight saving moves the open by an hour', () => {
  assert.equal(iso(zonedTimeToUtc('2026-03-06', '09:30', 'America/New_York')), '2026-03-06T14:30:00.000Z');
  assert.equal(iso(zonedTimeToUtc('2026-03-09', '09:30', 'America/New_York')), '2026-03-09T13:30:00.000Z');
  assert.equal(iso(zonedTimeToUtc('2026-10-30', '16:00', 'America/New_York')), '2026-10-30T20:00:00.000Z');
  assert.equal(iso(zonedTimeToUtc('2026-11-02', '16:00', 'America/New_York')), '2026-11-02T21:00:00.000Z');
  // Seoul has no DST: the same UTC hours in winter and summer.
  assert.equal(iso(zonedTimeToUtc('2026-01-15', '09:00', 'Asia/Seoul')), '2026-01-15T00:00:00.000Z');
  assert.equal(iso(zonedTimeToUtc('2026-07-15', '15:30', 'Asia/Seoul')), '2026-07-15T06:30:00.000Z');
});

test('DST weekdays: 14:00Z is 10:00 EDT in session after the March change and 09:00 EST before the open after the November change', () => {
  const march = timing('NASDAQ', '2026-03-09T14:00:00Z');
  assert.equal(march.kind, 'in_session');
  assert.equal(march.session.date, '2026-03-09');
  const november = timing('NASDAQ', '2026-11-02T14:00:00Z');
  assert.equal(november.kind, 'out_of_session');
  assert.equal(november.session.date, '2026-11-02');
  assert.equal(iso(november.session.openMs), '2026-11-02T14:30:00.000Z');
});

test('Seoul times use a fixed +09:00 and the exchange-local date, not the UTC date', () => {
  assert.equal(timing('KRX', '2026-01-15T00:30:00Z').kind, 'in_session');
  assert.equal(timing('KRX', '2026-07-15T00:30:00Z').kind, 'in_session');
  // 08:30 KST on the 10th is still the 9th in UTC.
  const early = timing('KRX', '2026-11-09T23:30:00Z');
  assert.deepEqual([early.kind, early.session.date], ['out_of_session', '2026-11-10']);
  // 22:00 EST on the 9th is the 10th in UTC.
  const late = timing('NASDAQ', '2026-11-10T03:00:00Z');
  assert.deepEqual([late.kind, late.session.date], ['out_of_session', '2026-11-10']);
  assert.equal(localDate('NASDAQ', at('2026-11-10T03:00:00Z')), '2026-11-09');
});

test('the five-minute margin decides the open and close boundaries', () => {
  // 08:57 KST + 5 minutes = 09:02, in session: D close.
  const beforeOpen = timing('KRX', '2026-11-09T23:57:00Z');
  assert.deepEqual(pick(beforeOpen), { kind: 'in_session', date: '2026-11-10' });
  // 15:27 KST + 5 minutes = 15:32, after the close: next open.
  assert.deepEqual(pick(timing('KRX', '2026-11-10T06:27:00Z')), { kind: 'out_of_session', date: '2026-11-11' });
  // t′ exactly at the open is not inside (open < t′), so entry is that open, which is still not before t′.
  const atOpen = timing('KRX', '2026-11-09T23:55:00Z');
  assert.deepEqual(pick(atOpen), { kind: 'out_of_session', date: '2026-11-10' });
  assert.equal(atOpen.session.openMs, atOpen.tPrimeMs);
  // t′ exactly at the close is inside (t′ ≤ close): D close.
  assert.deepEqual(pick(timing('KRX', '2026-11-10T06:25:00Z')), { kind: 'in_session', date: '2026-11-10' });
  // Nasdaq: 3 minutes before the 09:30 EST open, and 3 minutes before the 16:00 close.
  assert.deepEqual(pick(timing('NASDAQ', '2026-11-10T14:27:00Z')), { kind: 'in_session', date: '2026-11-10' });
  assert.deepEqual(pick(timing('NASDAQ', '2026-11-10T20:57:00Z')), { kind: 'out_of_session', date: '2026-11-11' });
});
function pick(value: ArticleTiming) { return { kind: value.kind, date: value.session.date }; }

test('worked examples: weekends, a half day and Thanksgiving give the plan table sessions', () => {
  const cases: Array<[string, ArticleTiming['kind'], string, string[]]> = [
    ['2026-11-07T15:00:00Z', 'out_of_session', '2026-11-09', ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13']],
    ['2026-11-09T17:00:00Z', 'in_session', '2026-11-09', ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-16']],
    ['2026-11-27T19:00:00Z', 'out_of_session', '2026-11-30', ['2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04']],
    ['2026-11-25T17:00:00Z', 'in_session', '2026-11-25', ['2026-11-27', '2026-11-30', '2026-12-01', '2026-12-02', '2026-12-03']],
    ['2026-11-21T15:00:00Z', 'out_of_session', '2026-11-23', ['2026-11-24', '2026-11-25', '2026-11-27', '2026-11-30']],
  ];
  for (const [published, kind, date, following] of cases) {
    const value = timing('NASDAQ', published);
    assert.deepEqual(pick(value), { kind, date }, published);
    assert.deepEqual(dates(sessionsAfter('NASDAQ', date, following.length)), following, published);
  }
});

test('a half day closes at 13:00 ET, so a 14:00 ET article is out of session', () => {
  const halfDay = session('NASDAQ', '2026-11-27');
  assert.equal(iso(halfDay.closeMs), '2026-11-27T18:00:00.000Z');
  assert.equal(sessionOn('NASDAQ', '2026-11-26'), null);
  assert.deepEqual(pick(timing('NASDAQ', '2026-11-27T19:00:00Z')), { kind: 'out_of_session', date: '2026-11-30' });
  assert.deepEqual(pick(timing('NASDAQ', '2026-11-27T17:00:00Z')), { kind: 'in_session', date: '2026-11-27' });
});

test('anything that needs a date outside the declared coverage is calendar_unverified, never a weekday guess', () => {
  // Before coverage.
  assert.equal(classifyArticleTime('KRX', at('2022-12-29T02:00:00Z')), CALENDAR_UNVERIFIED);
  assert.equal(classifyArticleTime('NASDAQ', at('2022-12-30T17:00:00Z')), CALENDAR_UNVERIFIED);
  // After coverage: the next KRX session after 2026-12-30 falls in 2027.
  assert.equal(classifyArticleTime('KRX', at('2026-12-30T07:00:00Z')), CALENDAR_UNVERIFIED);
  assert.equal(sessionOn('KRX', '2027-01-04'), CALENDAR_UNVERIFIED);
  const lastDay = timing('KRX', '2026-12-30T02:00:00Z');
  assert.equal(lastDay.kind, 'in_session');
  assert.equal(sessionsAfter('KRX', lastDay.session.date, 5), CALENDAR_UNVERIFIED);
  assert.equal(classifyArticleTime('NASDAQ', at('2027-12-31T22:00:00Z')), CALENDAR_UNVERIFIED);
  assert.equal(sessionsBefore('KRX', '2023-01-02', 1), CALENDAR_UNVERIFIED);
  // The display-only basis still answers.
  const weekday = sessionOn('KRX', '2027-01-04', 'weekdays_only');
  assert.ok(weekday && weekday !== CALENDAR_UNVERIFIED);
  assert.equal(iso(weekday.openMs), '2027-01-04T00:00:00.000Z');
});

test('Korean holidays close the market and a sequence of sessions skips them', () => {
  assert.equal(sessionOn('KRX', '2026-09-24'), null);
  assert.equal(sessionOn('KRX', '2026-09-25'), null);
  assert.deepEqual(dates(sessionsAfter('KRX', '2026-09-23', 3)), ['2026-09-28', '2026-09-29', '2026-09-30']);
  assert.deepEqual(dates(sessionsBefore('KRX', '2026-09-28', 2)), ['2026-09-22', '2026-09-23']);
  assert.deepEqual(dates(sessionsFrom('KRX', at('2026-09-23T07:00:00Z'), 1)), ['2026-09-28']);
});

test('the last closed session is the one whose close is at or before the instant', () => {
  const closed = (exchange: Exchange, now: string) => (lastClosedSession(exchange, at(now)) as Session).date;
  assert.equal(closed('KRX', '2026-11-10T06:27:00Z'), '2026-11-09');
  assert.equal(closed('KRX', '2026-11-10T06:30:00Z'), '2026-11-10');
  assert.equal(closed('NASDAQ', '2026-11-28T15:00:00Z'), '2026-11-27');
});

test('target session phases: before the open, in session, at and after the close, Friday night, before a holiday, a half day', () => {
  const check = (exchange: Exchange, now: string, phase: string, date: string, previous: string) => {
    const value = target(exchange, now);
    assert.deepEqual({ phase: value.phase, date: value.session.date, previous: value.previous.date }, { phase, date, previous }, now);
  };
  check('NASDAQ', '2026-11-10T13:00:00Z', 'before_open', '2026-11-10', '2026-11-09');
  check('NASDAQ', '2026-11-10T14:30:00Z', 'in_session', '2026-11-10', '2026-11-09');
  check('NASDAQ', '2026-11-10T20:59:00Z', 'in_session', '2026-11-10', '2026-11-09');
  check('NASDAQ', '2026-11-10T21:00:00Z', 'after_close', '2026-11-11', '2026-11-10');
  check('NASDAQ', '2026-11-13T23:00:00Z', 'after_close', '2026-11-16', '2026-11-13');
  check('NASDAQ', '2026-11-15T12:00:00Z', 'after_close', '2026-11-16', '2026-11-13');
  check('NASDAQ', '2026-11-25T22:00:00Z', 'after_close', '2026-11-27', '2026-11-25');
  check('NASDAQ', '2026-11-26T15:00:00Z', 'after_close', '2026-11-27', '2026-11-25');
  check('NASDAQ', '2026-11-27T17:30:00Z', 'in_session', '2026-11-27', '2026-11-25');
  check('NASDAQ', '2026-11-27T18:30:00Z', 'after_close', '2026-11-30', '2026-11-27');
  // Plan example 1: Monday 18:00 KST targets Tuesday against Monday's close.
  check('KRX', '2026-11-09T09:00:00Z', 'after_close', '2026-11-10', '2026-11-09');
  check('KRX', '2026-11-09T22:00:00Z', 'before_open', '2026-11-10', '2026-11-09');
  check('KRX', '2026-09-24T01:00:00Z', 'after_close', '2026-09-28', '2026-09-23');
  assert.equal(targetSession('KRX', at('2026-12-30T07:00:00Z')), CALENDAR_UNVERIFIED);
});

test('overnight window is (previous close, open] on t′: three minutes before a close is in, three minutes before the open is out', () => {
  const window = overnightWindow('NASDAQ', session('NASDAQ', '2026-11-30')) as OvernightWindow;
  assert.equal(iso(window.startMs), '2026-11-27T18:00:00.000Z');
  assert.equal(iso(window.endMs), '2026-11-30T14:30:00.000Z');
  assert.equal(inOvernightWindow(window, at('2026-11-27T17:57:00Z')), true);
  assert.equal(inOvernightWindow(window, at('2026-11-27T17:55:00Z')), false);
  assert.equal(inOvernightWindow(window, at('2026-11-28T12:00:00Z')), true);
  assert.equal(inOvernightWindow(window, at('2026-11-30T14:25:00Z')), true);
  assert.equal(inOvernightWindow(window, at('2026-11-30T14:27:00Z')), false);
  assert.equal(inOvernightWindow(window, at('2026-11-27T16:00:00Z')), false);
  // A midnight stamp counts only when its whole day fits.
  assert.equal(inOvernightWindow(window, at('2026-11-28T05:00:00Z'), 'day'), true);
  assert.equal(inOvernightWindow(window, at('2026-11-29T15:00:00Z'), 'day'), false);
  // Friday-close articles land in Monday's window.
  const monday = overnightWindow('KRX', session('KRX', '2026-11-16')) as OvernightWindow;
  assert.equal(inOvernightWindow(monday, at('2026-11-13T07:00:00Z')), true);
});

test('window membership agrees with article classification for every minute around a session', () => {
  const window = overnightWindow('NASDAQ', session('NASDAQ', '2026-11-10')) as OvernightWindow;
  for (let ms = at('2026-11-09T20:40:00Z'); ms <= at('2026-11-10T14:50:00Z'); ms += MINUTE) {
    const value = classifyArticleTime('NASDAQ', ms) as ArticleTiming;
    const expected = value.kind === 'out_of_session' && value.session.date === '2026-11-10';
    assert.equal(inOvernightWindow(window, ms), expected, iso(ms));
  }
});

test('weekly asOf is Sunday 23:50 UTC and both markets then enter at Monday open', () => {
  assert.equal(iso(weeklyAsOfAtOrBefore(at('2026-11-10T00:00:00Z'))), '2026-11-08T23:50:00.000Z');
  assert.equal(iso(weeklyAsOfAtOrBefore(at('2026-11-08T23:50:00Z'))), '2026-11-08T23:50:00.000Z');
  assert.equal(iso(weeklyAsOfAtOrBefore(at('2026-11-08T23:49:00Z'))), '2026-11-01T23:50:00.000Z');
  assert.deepEqual(weeklyAsOfsBetween(at('2026-11-01T00:00:00Z'), at('2026-11-16T00:00:00Z')).map(iso),
    ['2026-11-01T23:50:00.000Z', '2026-11-08T23:50:00.000Z', '2026-11-15T23:50:00.000Z']);
  for (const exchange of ['KRX', 'NASDAQ'] as const) {
    const asOf = at('2026-11-08T23:50:00Z');
    const sessions = weekSessions(exchange, asOf) as Session[];
    assert.deepEqual(sessions.map(item => item.date), ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13']);
    assert.ok(sessions[0]!.openMs >= asOf + ARTICLE_DELAY_MS);
  }
  // Summer: 19:50 EDT, still before the open.
  assert.equal((weekSessions('NASDAQ', at('2026-07-12T23:50:00Z')) as Session[])[0]!.date, '2026-07-13');
});

test('a holiday week whose window would overlap the previous kept window is skipped', () => {
  const asOfs = weeklyAsOfsBetween(at('2025-09-28T00:00:00Z'), at('2025-10-13T00:00:00Z'));
  const windows = weeklyWindows('KRX', asOfs);
  assert.deepEqual(windows.map(item => item.skip), [null, 'overlap', null]);
  assert.deepEqual(windows[0]!.sessions!.map(item => item.date), ['2025-09-29', '2025-09-30', '2025-10-01', '2025-10-02', '2025-10-10']);
  assert.equal(windows[1]!.sessions![0]!.date, '2025-10-10');
  assert.equal(windows[2]!.sessions![0]!.date, '2025-10-13');
  assert.equal(weeklyWindows('KRX', [at('2026-12-27T23:50:00Z')])[0]!.skip, CALENDAR_UNVERIFIED);
});

test('target windows are computed from the request time and fall back to weekdays only past coverage', () => {
  assert.deepEqual(weekTargetWindow('NASDAQ', at('2026-11-10T15:00:00Z')),
    { start: '2026-11-11', end: '2026-11-17', basis: 'exchange_calendar', exchange: 'NASDAQ', phase: 'in_session' });
  assert.deepEqual(weekTargetWindow('NASDAQ', at('2026-11-21T15:00:00Z')),
    { start: '2026-11-23', end: '2026-11-30', basis: 'exchange_calendar', exchange: 'NASDAQ', phase: 'after_close' });
  assert.deepEqual(weekTargetWindow('KRX', at('2026-12-28T01:00:00Z')),
    { start: '2026-12-29', end: '2027-01-04', basis: 'weekdays_only', exchange: 'KRX', phase: 'in_session' });
  assert.deepEqual(dayTargetWindow('NASDAQ', at('2026-11-25T22:00:00Z')), {
    targetWindow: { start: '2026-11-27', end: '2026-11-27', basis: 'exchange_calendar', exchange: 'NASDAQ', phase: 'after_close' },
    newsWindow: { start: '2026-11-25T21:00:00.000Z', end: '2026-11-27T14:30:00.000Z' },
  });
  assert.equal(dayTargetWindow('KRX', at('2026-12-30T07:00:00Z')).targetWindow.basis, 'weekdays_only');
});

test('day-precision stamps enter at the first open after the end of that day', () => {
  // Midnight KST on 11-10: the day ends at 11-11 00:00 KST.
  const kst = classifyArticleTime('KRX', at('2026-11-09T15:00:00Z'), { precision: 'day' }) as ArticleTiming;
  assert.deepEqual(pick(kst), { kind: 'out_of_session', date: '2026-11-11' });
  // Midnight UTC: the day ends at 09:00 KST, so the margin pushes entry to the following open.
  const utc = classifyArticleTime('KRX', at('2026-11-10T00:00:00Z'), { precision: 'day' }) as ArticleTiming;
  assert.deepEqual(pick(utc), { kind: 'out_of_session', date: '2026-11-12' });
  assert.ok(utc.session.openMs >= at('2026-11-11T00:00:00Z') + ARTICLE_DELAY_MS);
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

// --- Memoised calendar (step 4): equal to a direct Intl computation ------------------

const HOUR_MS = 60 * MINUTE;
const DAY_MS = 24 * HOUR_MS;
const ZONES: Record<Exchange, string> = { KRX: 'Asia/Seoul', NASDAQ: 'America/New_York' };
const referenceFormats = new Map<string, Intl.DateTimeFormat>();
function referenceWall(ms: number, timeZone: string) {
  let format = referenceFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit' });
    referenceFormats.set(timeZone, format);
  }
  const parts: Record<string, number> = {};
  for (const part of format.formatToParts(new Date(ms))) if (part.type !== 'literal') parts[part.type] = Number(part.value);
  return parts as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}
const pad2 = (value: number) => String(value).padStart(2, '0');
function referenceDate(ms: number, timeZone: string): string {
  const wall = referenceWall(ms, timeZone);
  return `${wall.year}-${pad2(wall.month)}-${pad2(wall.day)}`;
}
function referenceOffset(ms: number, timeZone: string): number {
  const wall = referenceWall(ms, timeZone);
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour % 24, wall.minute, wall.second) - Math.floor(ms / 1000) * 1000;
}
function referenceZoned(date: string, time: string, timeZone: string): number {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  return wall - referenceOffset(wall - referenceOffset(wall, timeZone), timeZone);
}
function referenceSession(exchange: Exchange, date: string): Session | null | typeof CALENDAR_UNVERIFIED {
  const calendar = EXCHANGE_CALENDARS[exchange];
  if (date < calendar.coverage.from || date > calendar.coverage.to) return CALENDAR_UNVERIFIED;
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (weekday === 0 || weekday === 6 || calendar.holidays.has(date)) return null;
  const hours = calendar.changedHours.get(date) ?? calendar;
  return { date, openMs: referenceZoned(date, hours.open, calendar.timeZone), closeMs: referenceZoned(date, hours.close, calendar.timeZone) };
}
/** The reference sessions, computed once per date (the reference itself is direct Intl, never the module's caches). */
const referenceSessions = new Map<string, Session | null | typeof CALENDAR_UNVERIFIED>();
function referenceSessionOnce(exchange: Exchange, date: string) {
  const key = `${exchange} ${date}`;
  if (!referenceSessions.has(key)) referenceSessions.set(key, referenceSession(exchange, date));
  return referenceSessions.get(key)!;
}
/** Day-by-day scan over the reference sessions, the step-2 algorithm. */
function referenceScan(exchange: Exchange, start: string, step: 1 | -1, count: number, accept: (session: Session) => boolean) {
  const found: Session[] = [];
  for (let date = start, days = 0; found.length < count; date = addDays(date, step), days += 1) {
    if (days > 400 + count * 2) return CALENDAR_UNVERIFIED;
    const value = referenceSessionOnce(exchange, date);
    if (value === CALENDAR_UNVERIFIED) return CALENDAR_UNVERIFIED;
    if (value && accept(value)) found.push(value);
  }
  return step === 1 ? found : found.reverse();
}
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

test('memoised localDate and zone conversion equal Intl on 20,000 seeded instants from 2023 to 2027, DST weeks included', () => {
  const next = seededRandom(2023);
  const from = at('2023-01-01T00:00:00Z');
  const to = at('2028-01-01T00:00:00Z');
  // US changes: second Sunday of March 07:00Z and first Sunday of November 06:00Z.
  const changes: number[] = [];
  for (let year = 2023; year <= 2027; year += 1) {
    const march = Array.from({ length: 7 }, (_, i) => Date.UTC(year, 2, 8 + i, 7)).find(ms => new Date(ms).getUTCDay() === 0)!;
    const november = Array.from({ length: 7 }, (_, i) => Date.UTC(year, 10, 1 + i, 6)).find(ms => new Date(ms).getUTCDay() === 0)!;
    changes.push(march, november);
  }
  let checked = 0;
  for (let i = 0; i < 20_000; i += 1) {
    const near = i % 3 === 0;
    // Near a change: within ±3 days, a third of them within ±2 hours at whole and odd minutes.
    const base = near ? changes[i % changes.length]! : from;
    const span = near ? (i % 9 === 0 ? 4 * HOUR_MS : 6 * DAY_MS) : to - from;
    const ms = Math.floor(near ? base - span / 2 + next() * span : base + next() * span);
    for (const exchange of ['KRX', 'NASDAQ'] as const) {
      assert.equal(localDate(exchange, ms), referenceDate(ms, ZONES[exchange]), `${exchange} ${iso(ms)}`);
    }
    checked += 1;
    // Wall time → instant on every fourth one (the reference costs four Intl calls per zone).
    if (i % 4 !== 0) continue;
    const wall = referenceWall(ms, 'America/New_York');
    const date = `${wall.year}-${pad2(wall.month)}-${pad2(wall.day)}`;
    const time = `${pad2(wall.hour)}:${pad2(wall.minute)}`;
    for (const zone of Object.values(ZONES)) assert.equal(zonedTimeToUtc(date, time, zone), referenceZoned(date, time, zone), `${zone} ${date} ${time}`);
  }
  assert.equal(checked, 20_000);
  // The exact instants of the changes and the minutes around them.
  for (const change of changes) {
    for (let ms = change - 2 * HOUR_MS; ms <= change + 2 * HOUR_MS; ms += 60_000) {
      assert.equal(localDate('NASDAQ', ms), referenceDate(ms, 'America/New_York'), iso(ms));
      assert.equal(localDate('NASDAQ', ms + 59_999), referenceDate(ms + 59_999, 'America/New_York'), iso(ms + 59_999));
    }
  }
});

test('memoised sessions and session scans equal the day-by-day reference on every date 2022-12-20..2028-01-10', () => {
  for (const exchange of ['KRX', 'NASDAQ'] as const) {
    for (let date = '2022-12-20'; date <= '2028-01-10'; date = addDays(date, 1)) {
      assert.deepEqual(sessionOn(exchange, date), referenceSessionOnce(exchange, date), `${exchange} ${date}`);
    }
  }
  const next = seededRandom(7);
  const first = at('2022-12-20T00:00:00Z');
  const last = at('2028-01-10T00:00:00Z');
  for (let i = 0; i < 3_000; i += 1) {
    const exchange = i % 2 === 0 ? 'KRX' : 'NASDAQ';
    const ms = Math.floor(first + next() * (last - first));
    const date = localDate(exchange, ms);
    const count = 1 + Math.floor(next() * 70);
    const message = `${exchange} ${iso(ms)} ${count}`;
    assert.deepEqual(sessionsAfter(exchange, date, count), referenceScan(exchange, addDays(date, 1), 1, count, () => true), message);
    assert.deepEqual(sessionsBefore(exchange, date, count), referenceScan(exchange, addDays(date, -1), -1, count, () => true), message);
    assert.deepEqual(sessionsFrom(exchange, ms, count), referenceScan(exchange, date, 1, count, session => session.openMs >= ms), message);
    const closed = referenceScan(exchange, date, -1, 1, session => session.closeMs <= ms);
    assert.deepEqual(lastClosedSession(exchange, ms), closed === CALENDAR_UNVERIFIED ? closed : closed[0], message);
  }
  // Coverage edges, both ends.
  assert.equal(sessionsAfter('KRX', '2026-12-29', 2), CALENDAR_UNVERIFIED);
  assert.deepEqual(dates(sessionsAfter('KRX', '2026-12-28', 2)), ['2026-12-29', '2026-12-30']);
  assert.equal(sessionsBefore('NASDAQ', '2023-01-03', 1), CALENDAR_UNVERIFIED);
  assert.deepEqual(dates(sessionsBefore('NASDAQ', '2023-01-04', 1)), ['2023-01-03']);
  assert.equal(sessionsFrom('KRX', at('2027-01-04T00:00:00Z'), 1), CALENDAR_UNVERIFIED);
  assert.equal(lastClosedSession('KRX', at('2023-01-02T05:00:00Z')), CALENDAR_UNVERIFIED);
  assert.throws(() => sessionsAfter('KRX', '2026-1-2', 1), RangeError);
});

test('cached sessions are frozen and the arrays holding them are fresh', () => {
  const session = sessionOn('NASDAQ', '2026-11-10') as Session;
  assert.equal(session, sessionOn('NASDAQ', '2026-11-10'));
  assert.ok(Object.isFrozen(session));
  assert.throws(() => { (session as { openMs: number }).openMs = 0; }, TypeError);
  const one = sessionsAfter('NASDAQ', '2026-11-09', 3) as Session[];
  const two = sessionsAfter('NASDAQ', '2026-11-09', 3) as Session[];
  assert.notEqual(one, two);
  assert.ok(one.every(item => Object.isFrozen(item)));
  one.pop();
  assert.equal((sessionsAfter('NASDAQ', '2026-11-09', 3) as Session[]).length, 3);
  assert.ok(Object.isFrozen(lastClosedSession('KRX', at('2026-11-10T08:00:00Z'))));
});
