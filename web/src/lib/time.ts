/**
 * Работа с датами и периодами для разделов «История смен» и «Финансы».
 * Все границы — локальное время браузера, диапазон задаётся как полуинтервал [from, to).
 */

export interface DateRange {
  from: Date;
  to: Date;
}

export type PeriodPreset = 'today' | 'yesterday' | 'last7' | 'last30' | 'month' | 'custom';

export const PERIOD_PRESETS: ReadonlyArray<{ key: PeriodPreset; label: string }> = [
  { key: 'today', label: 'Сегодня' },
  { key: 'yesterday', label: 'Вчера' },
  { key: 'last7', label: 'Последние 7 дней' },
  { key: 'last30', label: 'Последние 30 дней' },
  { key: 'month', label: 'Текущий месяц' },
  { key: 'custom', label: 'Произвольный период' }
];

const DAY_MS = 86_400_000;

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

export function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function startOfNextMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 1);
}

export function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return String(date.getFullYear()) + '-' + month + '-' + day;
}

export function dayKeyFromIso(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : dayKey(date);
}

export function parseDayKeyInput(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function resolvePreset(preset: PeriodPreset, now: Date, custom?: { from: string; to: string }): DateRange {
  const today = startOfDay(now);
  switch (preset) {
    case 'today':
      return { from: today, to: addDays(today, 1) };
    case 'yesterday':
      return { from: addDays(today, -1), to: today };
    case 'last7':
      return { from: addDays(today, -6), to: addDays(today, 1) };
    case 'last30':
      return { from: addDays(today, -29), to: addDays(today, 1) };
    case 'month':
      return { from: startOfMonth(now), to: startOfNextMonth(now) };
    case 'custom': {
      const from = custom ? parseDayKeyInput(custom.from) : null;
      const to = custom ? parseDayKeyInput(custom.to) : null;
      const safeFrom = from ?? today;
      const safeTo = to ?? addDays(safeFrom, 1);
      return safeTo > safeFrom ? { from: safeFrom, to: addDays(safeTo, 1) } : { from: safeFrom, to: addDays(safeFrom, 1) };
    }
    default:
      return { from: today, to: addDays(today, 1) };
  }
}

/** Предыдущий период той же длины — база для сравнения динамики. */
export function previousRange(range: DateRange): DateRange {
  const span = Math.max(DAY_MS, range.to.getTime() - range.from.getTime());
  return { from: new Date(range.from.getTime() - span), to: new Date(range.from.getTime()) };
}

export function rangeLengthDays(range: DateRange): number {
  return Math.max(1, Math.round((range.to.getTime() - range.from.getTime()) / DAY_MS));
}

/** Список локальных дат (YYYY-MM-DD) внутри полуинтервала [from, to). */
export function eachDayKey(range: DateRange): string[] {
  const keys: string[] = [];
  let cursor = startOfDay(range.from);
  while (cursor < range.to && keys.length < 400) {
    keys.push(dayKey(cursor));
    cursor = addDays(cursor, 1);
  }
  return keys;
}

export function formatDayLabel(key: string): string {
  const date = parseDayKeyInput(key);
  if (!date) return key;
  return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: 'short' }).format(date);
}

export function formatDurationSeconds(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '—';
  const minutes = Math.floor(totalSeconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return hours + ' ч ' + String(minutes % 60).padStart(2, '0') + ' мин';
  return minutes + ' мин';
}
