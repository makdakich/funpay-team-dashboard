import type { CurrencyTotals, Order, Shift } from '@/types/database';
import { supabase } from '@/lib/supabase';
import type { DbClient } from '@/lib/db';
import { ORDER_COLUMNS, PROFILE_COLUMNS, SHIFT_COLUMNS } from '@/lib/columns';
import { addAmountCents, centsToTotals, emptyCents } from '@/lib/money';
import { groupOrdersByShift, type ShiftOrderLike } from './metrics';

export const SHIFT_HISTORY_LIMIT = 200;
const FETCH_PAGE = 1000;
const MAX_FETCH_PAGES = 10;
const IN_CHUNK = 50;

export interface ShiftFilters {
  operatorId: string;
  status: 'all' | 'active' | 'completed';
  from: string | null;
  to: string | null;
}

export interface ShiftHistoryItem {
  shift: Shift;
  operatorName: string;
  turnover: CurrencyTotals;
  share: CurrencyTotals;
  orderCount: number;
}

export interface UnlinkedShiftOrders {
  closedCount: number;
  ambiguousCount: number;
  turnover: CurrencyTotals;
}

export interface ShiftHistory {
  items: ShiftHistoryItem[];
  unlinked: UnlinkedShiftOrders;
  truncated: boolean;
}

interface ShiftTotalsRow extends ShiftOrderLike {
  shift_id: string | null;
}

export async function loadShiftHistory(filters: ShiftFilters, client: DbClient = supabase): Promise<ShiftHistory> {
  const builder = client.from('shifts').select(SHIFT_COLUMNS);
  if (filters.operatorId) builder.eq('user_id', filters.operatorId);
  if (filters.status !== 'all') builder.eq('status', filters.status);
  if (filters.from) builder.gte('start_time', filters.from);
  if (filters.to) builder.lt('start_time', filters.to);

  const shiftsResult = await builder
    .order('start_time', { ascending: false })
    .limit(SHIFT_HISTORY_LIMIT + 1);
  if (shiftsResult.error) throw shiftsResult.error;

  const fetched = (shiftsResult.data ?? []) as unknown as Shift[];
  const truncated = fetched.length > SHIFT_HISTORY_LIMIT;
  const shifts = truncated ? fetched.slice(0, SHIFT_HISTORY_LIMIT) : fetched;

  const [profilesResult, orderRows, unlinked] = await Promise.all([
    client.from('profiles').select(PROFILE_COLUMNS),
    loadClosedOrdersForShifts(shifts.map(shift => shift.id), client),
    loadUnlinkedClosedOrders(filters, client)
  ]);
  if (profilesResult.error) throw profilesResult.error;

  const names = new Map<string, string>();
  for (const row of (profilesResult.data ?? []) as unknown as Array<{ user_id: string; display_name: string }>) {
    names.set(row.user_id, row.display_name);
  }

  const grouped = groupOrdersByShift(orderRows);
  const items: ShiftHistoryItem[] = shifts.map(shift => {
    const totals = grouped.get(shift.id);
    return {
      shift,
      operatorName: names.get(shift.user_id) ?? 'Участник команды',
      turnover: totals?.turnover ?? centsToTotals(emptyCents()),
      share: totals?.share ?? centsToTotals(emptyCents()),
      orderCount: totals?.count ?? 0
    };
  });

  return { items, unlinked, truncated };
}

async function loadClosedOrdersForShifts(shiftIds: readonly string[], client: DbClient): Promise<ShiftTotalsRow[]> {
  const rows: ShiftTotalsRow[] = [];
  if (shiftIds.length === 0) return rows;

  for (let index = 0; index < shiftIds.length; index += IN_CHUNK) {
    const chunk = shiftIds.slice(index, index + IN_CHUNK);
    for (let page = 0; page < MAX_FETCH_PAGES; page += 1) {
      const { data, error } = await client
        .from('orders')
        .select('shift_id,amount,currency,status')
        .in('shift_id', chunk)
        .eq('status', 'closed')
        .order('order_id', { ascending: true })
        .range(page * FETCH_PAGE, page * FETCH_PAGE + FETCH_PAGE - 1);
      if (error) throw error;
      const batch = (data ?? []) as unknown as ShiftTotalsRow[];
      rows.push(...batch);
      if (batch.length < FETCH_PAGE) break;
    }
  }
  return rows;
}

async function loadUnlinkedClosedOrders(filters: ShiftFilters, client: DbClient): Promise<UnlinkedShiftOrders> {
  const cents = emptyCents();
  let closedCount = 0;
  let ambiguousCount = 0;

  for (let page = 0; page < MAX_FETCH_PAGES; page += 1) {
    const builder = client
      .from('orders')
      .select('shift_id,amount,currency,status,attribution_status')
      .eq('status', 'closed')
      .is('shift_id', null);
    if (filters.from) builder.gte('funpay_created_at', filters.from);
    if (filters.to) builder.lt('funpay_created_at', filters.to);

    const { data, error } = await builder
      .order('funpay_created_at', { ascending: true })
      .range(page * FETCH_PAGE, page * FETCH_PAGE + FETCH_PAGE - 1);
    if (error) throw error;

    const batch = (data ?? []) as unknown as Array<ShiftTotalsRow & { attribution_status: string }>;
    for (const row of batch) {
      closedCount += 1;
      if (row.attribution_status === 'ambiguous') ambiguousCount += 1;
      addAmountCents(cents, row.amount, row.currency);
    }
    if (batch.length < FETCH_PAGE) break;
  }

  return { closedCount, ambiguousCount, turnover: centsToTotals(cents) };
}

export async function loadShiftOrders(shiftId: string, client: DbClient = supabase): Promise<Order[]> {
  const { data, error } = await client
    .from('orders')
    .select(ORDER_COLUMNS)
    .eq('shift_id', shiftId)
    .order('funpay_created_at', { ascending: true })
    .limit(500);
  if (error) throw error;
  return (data ?? []) as unknown as Order[];
}

export async function loadShiftById(shiftId: string, client: DbClient = supabase): Promise<Shift | null> {
  const { data, error } = await client.from('shifts').select(SHIFT_COLUMNS).eq('id', shiftId).maybeSingle();
  if (error) throw error;
  return (data as unknown as Shift | null) ?? null;
}
