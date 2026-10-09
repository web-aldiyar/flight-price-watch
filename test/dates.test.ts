import { describe, expect, it } from 'vitest';
import { formatDate, parseDate, parsePrice, upcomingMonths } from '../src/dates.ts';

const TODAY = '2026-10-09';

describe('parseDate', () => {
  it.each([
    ['20.11', '2026-11-20'],
    ['20/11/2026', '2026-11-20'],
    ['05.01', '2027-01-05'],
    ['5.1.27', '2027-01-05'],
    ['20 ноября', '2026-11-20'],
    ['1 мая 2027', '2027-05-01'],
    ['ноябрь', '2026-11'],
    ['в ноябре', '2026-11'],
    ['Октябрь', '2026-10'],
    ['март', '2027-03'],
    ['в мае', '2027-05'],
    ['2026-12-20', '2026-12-20'],
    ['2026-12', '2026-12'],
  ])('%s → %s', (input, expected) => {
    expect(parseDate(input, TODAY)).toBe(expected);
  });

  it.each(['вчера', '31.02', '1.10.2026', 'сентябрь 2026', '13.13', 'Астана', '20'])('rejects %s', (input) => {
    expect(parseDate(input, TODAY)).toBeNull();
  });
});

describe('parsePrice', () => {
  it.each([
    ['30000', 30000],
    ['30 000', 30000],
    ['30к', 30000],
    ['30k', 30000],
    ['1,5к', 1500],
    ['до 45000 тг', 45000],
    ['50 тыс', 50000],
  ])('%s → %d', (input, expected) => {
    expect(parsePrice(input)).toBe(expected);
  });

  it.each(['дешево', '0', '-5'])('rejects %s', (input) => {
    expect(parsePrice(input)).toBeNull();
  });
});

describe('formatting', () => {
  it('formats months and days in Russian', () => {
    expect(formatDate('2026-11')).toBe('ноябрь 2026');
    expect(formatDate('2026-11-20')).toBe('20 ноября 2026');
  });

  it('offers the next months, with the year only when it changes', () => {
    expect(upcomingMonths('2026-11-15', 3)).toEqual([
      { value: '2026-11', label: 'Ноябрь' },
      { value: '2026-12', label: 'Декабрь' },
      { value: '2027-01', label: 'Январь 2027' },
    ]);
  });
});
