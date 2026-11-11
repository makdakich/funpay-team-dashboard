import type { CurrencyCode, CurrencyTotals, OverviewData, Profile, RecentActivity, Shift } from '@/types/database';
import { aggregateClosedOrders } from './metrics';
import { supabase } from '@/lib/supabase';

const PAGE_SIZE = 1000;
const EMPTY_CURRENCIES: CurrencyTotals = { RUB: 0, USD: 0, EUR: 0, KZT: 0 };

export async function loadOverview(): Promise<OverviewData> {
  const [profilesResult, activeShiftsResult, recentShiftsResult, totalOrdersResult] = await Promise.all([
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
    supabase.from('orders').select('order_id', { count: 'exact', head: true })
  ]);

  for (const result of [profilesResult, activeShiftsResult, recentShiftsResult, totalOrdersResult]) {
    if (result.error) throw result.error;
  }

  const profiles = (profilesResult.data ?? []) as Profile[];
  const activeShifts = (activeShiftsResult.data ?? []) as Shift[];
  const recentShifts = (recentShiftsResult.data ?? []) as Shift[];
  const profileNames = new Map(profiles.map(profile => [profile.user_id, profile.display_name]));
  const recentActivity: RecentActivity[] = recentShifts.map(shift => ({
    shift,
    displayName: profileNames.get(shift.user_id) ?? 'Участник команды'
  }));

  const financials = await loadClosedOrderMetrics();

  return {
    activeMembers: profiles.length,
    activeShifts: activeShifts.length,
    totalOrders: totalOrdersResult.count ?? 0,
    closedOrders: financials.count,
    turnoverByCurrency: financials.turnoverByCurrency ?? EMPTY_CURRENCIES,
    operatorShareByCurrency: financials.operatorShareByCurrency ?? EMPTY_CURRENCIES,
    recentActivity
  };
}

async function loadClosedOrderMetrics() {
  const rows: { amount: string; currency: CurrencyCode }[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from('orders')
      .select('seller_account_id,order_id,amount,currency')
      .eq('status', 'closed')
      .order('seller_account_id', { ascending: true })
      .order('order_id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) throw error;
    const page = data ?? [];
    rows.push(...page.map(row => ({ amount: String(row.amount), currency: row.currency as CurrencyCode })));
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return aggregateClosedOrders(rows);
}
