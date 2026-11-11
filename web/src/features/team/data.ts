import type { OperatorStatus, Profile, Shift, TeamMemberRow } from '@/types/database';
import { supabase } from '@/lib/supabase';

export async function loadTeam(): Promise<TeamMemberRow[]> {
  const [profilesResult, presenceResult, shiftsResult] = await Promise.all([
    supabase
      .from('profiles')
      .select('user_id,display_name,role,is_active')
      .eq('is_active', true)
      .order('display_name', { ascending: true }),
    supabase
      .from('operator_status')
      .select('user_id,status,active_shift_id,current_seller_account_id,last_heartbeat_at,app_version'),
    supabase
      .from('shifts')
      .select('id,user_id,seller_account_id,start_time,end_time,duration_seconds,status')
      .eq('status', 'active')
  ]);

  if (profilesResult.error) throw profilesResult.error;
  if (presenceResult.error) throw presenceResult.error;
  if (shiftsResult.error) throw shiftsResult.error;

  const presenceByUser = new Map(
    ((presenceResult.data ?? []) as OperatorStatus[]).map(status => [status.user_id, status])
  );
  const activeShiftByUser = new Map(
    ((shiftsResult.data ?? []) as Shift[]).map(shift => [shift.user_id, shift])
  );

  return ((profilesResult.data ?? []) as Profile[]).map(profile => ({
    profile,
    presence: presenceByUser.get(profile.user_id) ?? null,
    activeShift: activeShiftByUser.get(profile.user_id) ?? null
  }));
}
