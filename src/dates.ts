/** Russian-language date and price input for the bot: "20.11", "20 ноября", "ноябрь", "30к" ... */

const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const MONTHS_GENITIVE = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
// Matches any case form: "ноябрь", "ноября", "ноябре"; "май", "мая", "мае".
const MONTH_PATTERNS = [/^янв/, /^фев/, /^мар/, /^апр/, /^ма[йяе]$/, /^июн/, /^июл/, /^авг/, /^сен/, /^окт/, /^ноя/, /^дек/];

const pad = (n: number): string => String(n).padStart(2, '0');
const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export function monthIndex(word: string): number {
  return MONTH_PATTERNS.findIndex((pattern) => pattern.test(word));
}

/** "2026-11" → "ноябрь 2026", "2026-11-20" → "20 ноября 2026". */
export function formatDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const index = (month ?? 1) - 1;
  return day ? `${day} ${MONTHS_GENITIVE[index]} ${year}` : `${MONTHS[index]} ${year}`;
}

/** The current month and the following ones, as button options. */
export function upcomingMonths(today: string, count = 6): { value: string; label: string }[] {
  const [year, month] = today.split('-').map(Number) as [number, number];
  return Array.from({ length: count }, (_, i) => {
    const y = year + Math.floor((month - 1 + i) / 12);
    const m = ((month - 1 + i) % 12) + 1;
    const label = capitalize(MONTHS[m - 1]!) + (y === year ? '' : ` ${y}`);
    return { value: `${y}-${pad(m)}`, label };
  });
}

/**
 * Parses a departure/return date. Returns "YYYY-MM-DD", "YYYY-MM" for a whole month,
 * or null if the input is not a date or is in the past. Without a year, picks the nearest future one.
 */
export function parseDate(input: string, today: string): string | null {
  const s = input
    .trim()
    .toLowerCase()
    .replace(/^(в|во)\s+/, '')
    .replace(/\s*(г\.?|года?)$/, '');
  const todayYear = Number(today.slice(0, 4));

  let year: number | undefined;
  let month: number;
  let day: number | undefined;

  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/))) {
    [year, month, day] = [Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : undefined];
  } else if ((m = s.match(/^(\d{1,2})[./](\d{1,2})(?:[./](\d{2}|\d{4}))?$/))) {
    [day, month] = [Number(m[1]), Number(m[2])];
    if (m[3]) year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  } else if ((m = s.match(/^(\d{1,2})\s+([а-яё]+)(?:\s+(\d{4}))?$/))) {
    [day, month] = [Number(m[1]), monthIndex(m[2]!) + 1];
    if (m[3]) year = Number(m[3]);
  } else if ((m = s.match(/^([а-яё]+)(?:\s+(\d{4}))?$/))) {
    month = monthIndex(m[1]!) + 1;
    if (m[2]) year = Number(m[2]);
  } else {
    return null;
  }

  if (month < 1 || month > 12) return null;
  const build = (y: number) => (day === undefined ? `${y}-${pad(month)}` : `${y}-${pad(month)}-${pad(day)}`);
  // A month counts as past only once it has ended; a day once it has passed.
  const isPast = (date: string) => date < today.slice(0, date.length);

  let date = build(year ?? todayYear);
  if (year === undefined && isPast(date)) date = build(todayYear + 1);
  if (isPast(date)) return null;

  if (day !== undefined) {
    const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
    if (new Date(Date.UTC(y, mo - 1, d)).getUTCDate() !== d) return null;
  }
  return date;
}

/** "30000", "30 000", "30к", "30k", "30 тыс", "до 30000 тг" → 30000. */
export function parsePrice(input: string): number | null {
  const s = input
    .toLowerCase()
    .replace(/^до\s*/, '')
    .replace(/\s+/g, '')
    .replace(/(₸|тг|тенге|kzt|руб(лей)?|₽|\$|usd)\.?$/, '');
  const m = s.match(/^(\d+(?:[.,]\d+)?)(к|k|тыс\.?)?$/);
  if (!m) return null;
  const value = Math.round(Number(m[1]!.replace(',', '.')) * (m[2] ? 1000 : 1));
  return value > 0 ? value : null;
}
