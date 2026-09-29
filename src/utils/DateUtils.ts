/** Date helpers shared by data factories, date pickers and report formatting. */

const pad = (value: number): string => String(value).padStart(2, '0');

/** `YYYY-MM-DD` in local time (the format the application's date fields use). */
export function toIsoDate(date: Date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `YYYY-MM-DD HH:mm:ss` for human-readable report cells. */
export function toDisplayDateTime(date: Date = new Date()): string {
  return `${toIsoDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Timestamp safe for file and folder names. */
export function toFileStamp(date: Date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

export function addDays(date: Date, days: number): Date {
  const copy = new Date(date.getTime());
  copy.setDate(copy.getDate() + days);
  return copy;
}

export function addMonths(date: Date, months: number): Date {
  const copy = new Date(date.getTime());
  copy.setMonth(copy.getMonth() + months);
  return copy;
}

export function addYears(date: Date, years: number): Date {
  return addMonths(date, years * 12);
}

export function daysBetween(from: Date, to: Date): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((to.setHours(0, 0, 0, 0) - from.setHours(0, 0, 0, 0)) / msPerDay);
}

export function isWeekend(date: Date): boolean {
  return date.getDay() === 0 || date.getDay() === 6;
}

/** Parses `YYYY-MM-DD` strictly, rejecting impossible calendar dates. */
export function parseIsoDate(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new RangeError(`parseIsoDate: "${value}" is not in YYYY-MM-DD format`);
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new RangeError(`parseIsoDate: "${value}" is not a real calendar date`);
  }
  return date;
}

/** Splits an ISO date into the parts a date-picker component needs. */
export function toDateParts(value: string): { year: number; monthIndex: number; day: number } {
  const date = parseIsoDate(value);
  return { year: date.getFullYear(), monthIndex: date.getMonth(), day: date.getDate() };
}

export function humanDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
  const totalSeconds = Math.round(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m ${seconds}s`;
  return `${hours}h ${minutes % 60}m ${seconds}s`;
}

export const MONTH_NAMES: readonly string[] = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
