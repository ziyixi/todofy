import { describe, expect, it } from 'vitest';
import { HOUR, MINUTE } from '../src/limits.ts';
import {
  addDays,
  arxivEligible,
  currentRound,
  cutoffOf,
  dayLength,
  issueKind,
  lastLearnSlot,
  localInstant,
  localTime,
  nextRound,
  nextScheduled,
  previousCutoffDate,
  previousWeekdayDate,
  sendCutoffOf,
  sendTimeOf,
} from '../src/schedule.ts';

describe('the schedule in America/Los_Angeles', () => {
  it('places every slot at its local time on both sides of both DST changes', () => {
    expect(new Date(localInstant('2026-10-30', '03:30')).toISOString()).toBe('2026-10-30T10:30:00.000Z');
    expect(new Date(localInstant('2026-11-02', '03:30')).toISOString()).toBe('2026-11-02T11:30:00.000Z');
    expect(new Date(localInstant('2026-03-06', '06:30')).toISOString()).toBe('2026-03-06T14:30:00.000Z');
    expect(new Date(localInstant('2026-03-09', '06:30')).toISOString()).toBe('2026-03-09T13:30:00.000Z');
    // The change days themselves: every slot is outside 01:00-03:00.
    expect(new Date(localInstant('2026-11-01', '12:30')).toISOString()).toBe('2026-11-01T20:30:00.000Z');
    expect(new Date(localInstant('2026-03-08', '12:30')).toISOString()).toBe('2026-03-08T19:30:00.000Z');
    expect(dayLength('2026-10-31')).toBe(25 * HOUR);
    expect(dayLength('2026-03-07')).toBe(23 * HOUR);
    expect(dayLength('2026-10-12')).toBe(24 * HOUR);
    for (const date of ['2026-03-07', '2026-03-08', '2026-03-09', '2026-10-31', '2026-11-01', '2026-11-02']) {
      for (const time of ['03:30', '06:30', '07:30', '12:00', '12:30', '18:30', '23:30']) {
        const local = localTime(localInstant(date, time));
        expect(`${local.date} ${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')}`).toBe(`${date} ${time}`);
      }
    }
  });

  it('knows the issue days and the cutoffs', () => {
    expect(issueKind('2026-10-12')).toBe('weekday');
    expect(issueKind('2026-10-17')).toBe('deep_read');
    expect(issueKind('2026-10-18')).toBeNull();
    expect(previousCutoffDate('2026-10-12')).toBe('2026-10-10');
    expect(previousCutoffDate('2026-10-13')).toBe('2026-10-12');
    expect(previousWeekdayDate('2026-10-12')).toBe('2026-10-09');
    expect(previousWeekdayDate('2026-10-13')).toBe('2026-10-12');
    expect(sendTimeOf('2026-10-12') - cutoffOf('2026-10-12')).toBe(3 * HOUR);
    expect(sendTimeOf('2026-10-17') - cutoffOf('2026-10-17')).toBe(4 * HOUR);
    expect(sendCutoffOf('2026-10-12') - sendTimeOf('2026-10-12')).toBe(5 * HOUR + 30 * MINUTE);
  });

  it('finds the current and next rounds, with no cutoff on Sunday', () => {
    const mondayEarly = localInstant('2026-10-12', '03:45');
    expect(currentRound(mondayEarly)).toMatchObject({ key: '2026-10-12T03:30', kind: 'cutoff' });
    expect(nextRound(mondayEarly)).toMatchObject({ key: '2026-10-12T12:30', kind: 'fetch' });
    const sundayEarly = localInstant('2026-10-11', '05:00');
    expect(currentRound(sundayEarly)).toMatchObject({ key: '2026-10-10T23:30', kind: 'fetch' });
    expect(nextRound(sundayEarly)).toMatchObject({ key: '2026-10-11T12:30' });
    const sundayNight = localInstant('2026-10-11', '23:45');
    expect(nextRound(sundayNight)).toMatchObject({ key: '2026-10-12T03:30', kind: 'cutoff' });
    expect(currentRound(localInstant('2026-11-01', '04:00'))).toMatchObject({ key: '2026-10-31T23:30' });
  });

  it('holds an arXiv paper until the second cutoff after it was fetched', () => {
    const sundayEvening = localInstant('2026-10-11', '18:30') + MINUTE;
    expect(arxivEligible(sundayEvening, '2026-10-12')).toBe(false);
    expect(arxivEligible(sundayEvening, '2026-10-13')).toBe(true);
    const thursdayEvening = localInstant('2026-10-08', '18:31');
    expect(arxivEligible(thursdayEvening, '2026-10-09')).toBe(false);
    expect(arxivEligible(thursdayEvening, '2026-10-10')).toBe(true);
    expect(arxivEligible(thursdayEvening, '2026-10-12')).toBe(true);
  });

  it('schedules the next wake-up and the weekly learning', () => {
    const saturdayAfterCutoff = localInstant('2026-10-17', '04:00');
    expect(nextScheduled(saturdayAfterCutoff)).toBe(localInstant('2026-10-17', '07:30'));
    const sundayMorning = localInstant('2026-10-18', '10:00');
    expect(nextScheduled(sundayMorning)).toBe(localInstant('2026-10-18', '12:00'));
    expect(lastLearnSlot(localInstant('2026-10-18', '12:30'))).toBe(localInstant('2026-10-18', '12:00'));
    expect(lastLearnSlot(localInstant('2026-10-20', '12:30'))).toBe(localInstant('2026-10-18', '12:00'));
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});
