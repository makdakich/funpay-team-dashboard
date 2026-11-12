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

export interface StartShiftInput {
  sellerAccountId: string;
  userId?: string;
}

export interface ActiveTeamShift {
  shift: Shift;
  operatorName: string;
}

/** Получить все текущие активные смены команды (для обзора руководителя). */
export async function getActiveShifts(client: DbClient = supabase): Promise<ActiveTeamShift[]> {
  const [shiftsRes, profilesRes] = await Promise.all([
    client
      .from('shifts')
      .select(SHIFT_COLUMNS)
      .eq('status', 'active')
      .order('start_time', { ascending: false }),
    client
      .from('profiles')
      .select(PROFILE_COLUMNS)
  ]);
  if (shiftsRes.error) throw shiftsRes.error;
  if (profilesRes.error) throw profilesRes.error;

  const names = new Map<string, string>();
  for (const p of (profilesRes.data ?? []) as unknown as Array<{ user_id: string; display_name: string }>) {
    names.set(p.user_id, p.display_name);
  }

  return ((shiftsRes.data ?? []) as unknown as Shift[]).map(shift => ({
    shift,
    operatorName: names.get(shift.user_id) ?? 'Участник команды'
  }));
}

/** Получить текущую открытую смену пользователя (если есть). */
export async function getActiveShiftForUser(userId: string, client: DbClient = supabase): Promise<Shift | null> {
  const { data, error } = await client
    .from('shifts')
    .select(SHIFT_COLUMNS)
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle();
  if (error) throw error;
  return (data as unknown as Shift | null) ?? null;
}

/**
 * Открыть новую смену оператора.
 * Защищена от гонок и повторных отправок: если активная смена уже существует,
 * возвращает её вместо выброса ошибки дублирования.
 */
export async function startShift(
  inputOrSellerAccountId: string | StartShiftInput,
  client: DbClient = supabase
): Promise<Shift> {
  const sellerAccountId =
    typeof inputOrSellerAccountId === 'string'
      ? inputOrSellerAccountId
      : inputOrSellerAccountId.sellerAccountId;
  let userId =
    typeof inputOrSellerAccountId === 'object'
      ? inputOrSellerAccountId.userId
      : undefined;

  if (!userId) {
    const authRes = await client.auth.getUser();
    userId = authRes.data?.user?.id;
    if (!userId) {
      throw new Error('Пользователь не авторизован');
    }
  }

  // Проверка существующей активной смены (идемпотентность)
  const existing = await getActiveShiftForUser(userId, client);
  if (existing) {
    return existing;
  }

  const newShiftPayload = {
    user_id: userId,
    seller_account_id: sellerAccountId,
    status: 'active',
    start_time: new Date().toISOString()
  };

  const { data, error } = await client
    .from('shifts')
    .insert(newShiftPayload)
    .select(SHIFT_COLUMNS)
    .single();

  if (error) {
    // Если произошла гонка между вкладками/расширением и сработал idx_shifts_one_active_per_user (23505)
    if ((error as { code?: string })?.code === '23505') {
      const active = await getActiveShiftForUser(userId, client);
      if (active) return active;
    }
    throw error;
  }

  const shift = data as unknown as Shift;

  // Синхронизация статуса присутствия: переход в on_shift
  await client
    .from('operator_status')
    .upsert({
      user_id: userId,
      status: 'on_shift',
      active_shift_id: shift.id,
      current_seller_account_id: sellerAccountId,
      last_heartbeat_at: new Date().toISOString()
    });

  return shift;
}

/**
 * Закрыть смену оператора.
 * Триггер trg_protect_shift_fields на стороне БД автоматически зафиксирует
 * end_time и рассчитает duration_seconds.
 * Функция обновляет статус оператора в 'online' и запускает пересчёт атрибуции заказов.
 */
export async function finishShift(shiftId: string, client: DbClient = supabase): Promise<Shift> {
  const { data, error } = await client
    .from('shifts')
    .update({
      status: 'completed',
      end_time: new Date().toISOString()
    })
    .eq('id', shiftId)
    .select(SHIFT_COLUMNS)
    .single();

  let shift: Shift;

  if (error) {
    // Обработка гонки: если смена уже закрыта параллельным сеансом (например, расширением)
    const existing = await loadShiftById(shiftId, client);
    if (existing && existing.status === 'completed') {
      shift = existing;
    } else {
      throw error;
    }
  } else {
    shift = data as unknown as Shift;
  }

  // Сброс статуса присутствия оператора в 'online'
  await client
    .from('operator_status')
    .upsert({
      user_id: shift.user_id,
      status: 'online',
      active_shift_id: null,
      current_seller_account_id: null,
      last_heartbeat_at: new Date().toISOString()
    });

  // Запуск пересчёта атрибуции заказов для закрытой смены
  try {
    await recalculateShiftAttributions(shiftId, client);
  } catch (err) {
    console.warn('Failed to recalculate shift attributions on finish:', err);
  }

  return shift;
}

/**
 * Вызов RPC recalculate_shift_attributions для пересчёта заказов смены.
 */
export async function recalculateShiftAttributions(
  shiftId: string,
  client: DbClient = supabase
): Promise<number> {
  const { data, error } = await client.rpc('recalculate_shift_attributions', {
    p_shift_id: shiftId
  });
  if (error) throw error;
  if (Array.isArray(data) && data.length > 0) {
    return Number((data[0] as { updated_orders_count?: number }).updated_orders_count ?? 0);
  }
  return Number(data ?? 0);
}
