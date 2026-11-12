import type { Profile, SellerAccount } from '@/types/database';
import { supabase } from './supabase';
import type { DbClient } from './db';
import { PROFILE_COLUMNS, SELLER_ACCOUNT_COLUMNS } from './columns';

export async function loadTeamProfiles(client: DbClient = supabase): Promise<Profile[]> {
  const { data, error } = await client
    .from('profiles')
    .select(PROFILE_COLUMNS)
    .eq('is_active', true)
    .order('display_name', { ascending: true });
  if (error) throw error;
  return (data ?? []) as Profile[];
}

export async function loadSellerAccounts(client: DbClient = supabase): Promise<SellerAccount[]> {
  const { data, error } = await client
    .from('team_seller_accounts')
    .select(SELLER_ACCOUNT_COLUMNS)
    .eq('is_active', true)
    .order('account_name', { ascending: true });
  if (error) throw error;
  return (data ?? []) as SellerAccount[];
}
