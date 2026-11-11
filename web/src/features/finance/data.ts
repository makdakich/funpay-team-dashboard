import { supabase } from '@/lib/supabase';
import type { DbClient } from '@/lib/db';
import type { FinanceOrderRow } from './metrics';

const FETCH_PAGE = 1000;
const MAX_FETCH_PAGES = 20;
const FINANCE_COLUMNS = 'seller_account_id,order_id,amount,currency,status,operator_id,attribution_status,funpay_created_at';

export interface FinanceWindow {
  fromIso: string;
  toIso: string;
}

export interface FinanceDataset {
  rows: FinanceOrderRow[];
  paidCount: number;
  refundedCount: number;
  truncated: boolean;
}

/**
 * Загружает закрытые заказы периода страницами (никогда не тянет всю таблицу)
 * и отдельно считает объёмы paid/refunded для честной сводки «вне оборота».
 */
export async function loadFinanceOrders(window: FinanceWindow, client: DbClient = supabase): Promise<FinanceDataset> {
  const rows: FinanceOrderRow[] = [];
  let truncated = false;

  for (let page = 0; page < MAX_FETCH_PAGES; page += 1) {
    const { data, error } = await client
      .from('orders')
      .select(FINANCE_COLUMNS)
      .eq('status', 'closed')
      .gte('funpay_created_at', window.fromIso)
      .lt('funpay_created_at', window.toIso)
      .order('funpay_created_at', { ascending: true })
      .range(page * FETCH_PAGE, page * FETCH_PAGE + FETCH_PAGE - 1);
    if (error) throw error;

    const batch = (data ?? []) as unknown as FinanceOrderRow[];
    rows.push(...batch);
    if (batch.length < FETCH_PAGE) break;
    if (page === MAX_FETCH_PAGES - 1) truncated = true;
  }

  const [paidCount, refundedCount] = await Promise.all([
    countByStatus('paid', window, client),
    countByStatus('refunded', window, client)
  ]);

  return { rows, paidCount, refundedCount, truncated };
}

async function countByStatus(status: string, window: FinanceWindow, client: DbClient): Promise<number> {
  const { count, error } = await client
    .from('orders')
    .select('order_id', { count: 'exact', head: true })
    .eq('status', status)
    .gte('funpay_created_at', window.fromIso)
    .lt('funpay_created_at', window.toIso);
  if (error) throw error;
  return typeof count === 'number' ? count : 0;
}
