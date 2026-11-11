import type { Order, OrderAuditLog } from '@/types/database';
import { supabase } from '@/lib/supabase';
import type { DbClient } from '@/lib/db';
import { AUDIT_COLUMNS, ORDER_COLUMNS } from '@/lib/columns';
import { clampPage, pageCount, sliceRange } from '@/lib/paging';
import { UNASSIGNED_OPERATOR, buildSearchFilter, resolveDateBounds, type OrderQuery } from './filters';

export interface OrderPageResult {
  rows: Order[];
  total: number;
  page: number;
  pages: number;
  pageSize: number;
  clamped: boolean;
}

interface RawResult {
  data: unknown;
  error: unknown;
  count?: number | null;
}

/**
 * Серверная пагинация: за один запрос приходит максимум `pageSize` строк,
 * общее количество берётся из count (head-запрос PostgREST).
 */
export async function loadOrders(query: OrderQuery, client: DbClient = supabase): Promise<OrderPageResult> {
  const bounds = resolveDateBounds(query);
  const pageSize = Math.max(1, query.pageSize);

  const buildQuery = (page: number) => {
    const [from, to] = sliceRange(page, pageSize);
    const builder = client.from('orders').select(ORDER_COLUMNS, { count: 'exact' });

    if (query.sellerAccountId) builder.eq('seller_account_id', query.sellerAccountId);
    if (query.operatorId === UNASSIGNED_OPERATOR) builder.is('operator_id', null);
    else if (query.operatorId) builder.eq('operator_id', query.operatorId);
    if (query.status) builder.eq('status', query.status);
    if (query.currency) builder.eq('currency', query.currency);
    if (bounds.fromIso) builder.gte('funpay_created_at', bounds.fromIso);
    if (bounds.toIso) builder.lt('funpay_created_at', bounds.toIso);

    const search = buildSearchFilter(query.search);
    if (search) builder.or(search);

    return builder
      .order(query.sortBy, { ascending: query.sortDirection === 'asc' })
      .order('order_id', { ascending: true })
      .range(from, to);
  };

  let page = Math.max(1, Math.floor(query.page));
  let result = (await buildQuery(page)) as unknown as RawResult;
  if (result.error) throw result.error;

  const total = typeof result.count === 'number' ? result.count : (result.data as unknown[] | null)?.length ?? 0;
  const lastPage = pageCount(total, pageSize);
  const clamped = page > lastPage;
  if (clamped) {
    page = clampPage(page, total, pageSize);
    result = (await buildQuery(page)) as unknown as RawResult;
    if (result.error) throw result.error;
  }

  return {
    rows: (result.data ?? []) as unknown as Order[],
    total,
    page,
    pages: lastPage,
    pageSize,
    clamped
  };
}

export async function loadOrder(sellerAccountId: string, orderId: string, client: DbClient = supabase): Promise<Order | null> {
  const { data, error } = await client
    .from('orders')
    .select(ORDER_COLUMNS)
    .eq('seller_account_id', sellerAccountId)
    .eq('order_id', orderId)
    .maybeSingle();
  if (error) throw error;
  return (data as unknown as Order | null) ?? null;
}

export async function loadOrderAudit(sellerAccountId: string, orderId: string, client: DbClient = supabase): Promise<OrderAuditLog[]> {
  const { data, error } = await client
    .from('order_audit_logs')
    .select(AUDIT_COLUMNS)
    .eq('seller_account_id', sellerAccountId)
    .eq('order_id', orderId)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data ?? []) as unknown as OrderAuditLog[];
}

export interface ReassignInput {
  sellerAccountId: string;
  orderId: string;
  newOperatorId: string | null;
  reason: string;
}

/**
 * Переназначение выполняется ТОЛЬКО через RPC: прямое изменение orders запрещено
 * политиками и отозванными правами. Финансовые поля заказа не затрагиваются.
 */
export async function reassignOrderOperator(input: ReassignInput, client: DbClient = supabase): Promise<void> {
  const reason = input.reason.trim();
  if (!reason) throw new Error('Укажите причину переназначения — RPC отклонит пустое значение.');

  const { error } = await client.rpc('reassign_order_operator', {
    p_seller_account_id: input.sellerAccountId,
    p_order_id: input.orderId,
    p_new_operator_id: input.newOperatorId,
    p_reason: reason
  });
  if (error) throw error;
}
