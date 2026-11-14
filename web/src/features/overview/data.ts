import type { CurrencyCode, CurrencyTotals, OrderStatus, OverviewData, OverviewOrderPoint, Profile, RecentActivity, Shift } from '@/types/database';
import { aggregateClosedOrders } from './metrics';
import { supabase } from '@/lib/supabase';

const PAGE_SIZE = 1000;
const EMPTY_CURRENCIES: CurrencyTotals = { RUB: 0, USD: 0, EUR: 0, KZT: 0 };

export async function loadOverview(): Promise<OverviewData> {
  const [profilesResult, activeShiftsResult, recentShiftsResult, totalOrdersResult, sellerAccountsResult] = await Promise.all([
    supabase.from('profiles').select('user_id,display_name,role,is_active').eq('is_active', true),
    supabase
      .from('shifts')
      .select('id,user_id,seller_account_id,start_time,end_time,duration_seconds,status')
      .eq('status', 'active')
      .order('start_time', { ascending: false }),
    supabase
      .from('shifts')
      .select('id,user_id,seller_account_id,start_time,end_time,duration_seconds,status')
      .order('start_time', { ascending: false })
      .limit(6),
    supabase.from('orders').select('order_id', { count: 'exact', head: true }).eq('seller_account_id', '4473774'),
    supabase
      .from('team_seller_accounts')
      .select('seller_account_id,account_name,total_balance,balances,balance_currency,balance_updated_at')
      .eq('is_active', true)
  ]);

  for (const result of [profilesResult, activeShiftsResult, recentShiftsResult, totalOrdersResult, sellerAccountsResult]) {
    if (result.error) throw result.error;
  }

  const profiles = (profilesResult.data ?? []) as Profile[];
  const activeShifts = (activeShiftsResult.data ?? []) as Shift[];
  const recentShifts = (recentShiftsResult.data ?? []) as Shift[];
  const sellerAccounts = (sellerAccountsResult.data ?? []) as {
    seller_account_id: string;
    account_name: string;
    total_balance: number;
    balances: Record<string, number>;
    balance_currency: string;
    balance_updated_at?: string;
  }[];

  const targetAccount = sellerAccounts.find(a => a.seller_account_id === '4473774') || sellerAccounts[0];
  const totalBalance = typeof targetAccount?.total_balance === 'number' ? targetAccount.total_balance : 0;
  const balancesByCurrency: Record<string, number> =
    targetAccount?.balances && Object.keys(targetAccount.balances).length > 0
      ? targetAccount.balances
      : { [targetAccount?.balance_currency || 'RUB']: totalBalance };
  const storeName = targetAccount?.account_name || 'Hopeoflove';

  const profileNames = new Map(profiles.map(profile => [profile.user_id, profile.display_name]));
  const recentActivity: RecentActivity[] = recentShifts.map(shift => ({
    shift,
    displayName: profileNames.get(shift.user_id) ?? 'Участник команды'
  }));

  const targetSellerId = targetAccount?.seller_account_id || '4473774';
  const { orders, sellerAccountId } = await loadAllOrders(targetSellerId);
  const closedRows = orders
    .filter(o => o.status === 'closed')
    .map(o => ({ amount: String(o.amount), currency: o.currency }));

  const financials = aggregateClosedOrders(closedRows);

  return {
    activeMembers: profiles.length,
    activeShifts: activeShifts.length,
    totalOrders: totalOrdersResult.count ?? orders.length,
    closedOrders: financials.count,
    turnoverByCurrency: financials.turnoverByCurrency ?? EMPTY_CURRENCIES,
    operatorShareByCurrency: financials.operatorShareByCurrency ?? EMPTY_CURRENCIES,
    recentActivity,
    orders,
    sellerAccountId: sellerAccountId || targetSellerId,
    storeName,
    balancesByCurrency,
    totalBalance,
    balanceCurrency: targetAccount?.balance_currency || 'RUB',
    balanceUpdatedAt: targetAccount?.balance_updated_at
  };
}

async function loadAllOrders(targetSellerAccountId: string = '4473774'): Promise<{ orders: OverviewOrderPoint[]; sellerAccountId?: string }> {
  const orders: OverviewOrderPoint[] = [];
  let offset = 0;
  let sellerAccountId: string | undefined = targetSellerAccountId;

  while (true) {
    const { data, error } = await supabase
      .from('orders')
      .select('seller_account_id,order_id,amount,currency,status,funpay_created_at')
      .eq('seller_account_id', targetSellerAccountId)
      .order('order_id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) throw error;
    const page = data ?? [];
    for (const row of page) {
      if (!sellerAccountId && row.seller_account_id) {
        sellerAccountId = row.seller_account_id;
      }
      const rawDate = row.funpay_created_at;
      const ts = rawDate ? new Date(rawDate).getTime() : 0;
      orders.push({
        orderId: row.order_id,
        amount: Number(row.amount) || 0,
        currency: row.currency as CurrencyCode,
        status: row.status as OrderStatus,
        timestamp: isNaN(ts) ? 0 : ts,
        funpayCreatedAt: rawDate || ''
      });
    }

    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return { orders, sellerAccountId };
}
