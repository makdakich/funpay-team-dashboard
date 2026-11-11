import type { CurrencyTotals, OrderStatus, Shift } from '@/types/database';
import { addAmountCents, centsToTotals, emptyCents, shareCents } from '@/lib/money';

export interface ShiftTurnover {
  count: number;
  turnover: CurrencyTotals;
  share: CurrencyTotals;
}

export interface ShiftOrderLike {
  shift_id: string | null;
  amount: string | number;
  currency: string;
  status: string;
}

export function emptyShiftTurnover(): ShiftTurnover {
  return { count: 0, turnover: centsToTotals(emptyCents()), share: centsToTotals(emptyCents()) };
}

/**
 * Оборот по сменам считается строго по закрытым заказам и по связи orders.shift_id.
 * Один заказ ссылается максимум на одну смену (составной ключ + FK), поэтому
 * двойной учёт невозможен; заказы без смены (unassigned/ambiguous/manual) сюда не попадают.
 */
export function groupOrdersByShift(rows: readonly ShiftOrderLike[]): Map<string, ShiftTurnover> {
  const cents = new Map<string, ReturnType<typeof emptyCents>>();
  const counts = new Map<string, number>();

  for (const row of rows) {
    if (row.status !== 'closed' || !row.shift_id) continue;
    const bucket = cents.get(row.shift_id) ?? emptyCents();
    addAmountCents(bucket, row.amount, row.currency);
    cents.set(row.shift_id, bucket);
    counts.set(row.shift_id, (counts.get(row.shift_id) ?? 0) + 1);
  }

  const result = new Map<string, ShiftTurnover>();
  for (const [shiftId, bucket] of cents) {
    result.set(shiftId, {
      count: counts.get(shiftId) ?? 0,
      turnover: centsToTotals(bucket),
      share: centsToTotals(shareCents(bucket))
    });
  }
  return result;
}

/**
 * Продолжительность смены: для активной смены считается от текущего момента,
 * для завершённой — от end_time, с откатом на сохранённое duration_seconds.
 */
export function shiftDurationSeconds(
  shift: Pick<Shift, 'start_time' | 'end_time' | 'duration_seconds' | 'status'>,
  now: number = Date.now()
): number {
  const start = Date.parse(shift.start_time);
  if (!Number.isFinite(start)) return 0;

  if (shift.status === 'active') {
    return Math.max(0, Math.floor((now - start) / 1000));
  }

  if (shift.end_time) {
    const end = Date.parse(shift.end_time);
    if (!Number.isFinite(end)) return Math.max(0, shift.duration_seconds ?? 0);
    return Math.max(0, Math.floor((end - start) / 1000));
  }

  return Math.max(0, shift.duration_seconds ?? 0);
}

export function isClosedStatus(status: string): status is OrderStatus {
  return status === 'closed';
}
