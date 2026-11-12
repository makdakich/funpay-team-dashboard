import type { OperatorStatus, Profile, ProfileAuditLog, Shift, TeamMemberRow } from '@/types/database';
import { supabase } from '@/lib/supabase';
import { PROFILE_COLUMNS } from '@/lib/columns';
import type { DbClient } from '@/lib/db';

export async function loadTeam(includeInactive = false, client: DbClient = supabase): Promise<TeamMemberRow[]> {
  let profileQuery = client
    .from('profiles')
    .select(PROFILE_COLUMNS)
    .order('display_name', { ascending: true });

  if (!includeInactive) {
    profileQuery = profileQuery.eq('is_active', true);
  }

  const [profilesResult, presenceResult, shiftsResult] = await Promise.all([
    profileQuery,
    client
      .from('operator_status')
      .select('user_id,status,active_shift_id,current_seller_account_id,last_heartbeat_at,app_version'),
    client
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

export async function setMemberActive(
  targetUserId: string,
  isActive: boolean,
  reason = 'Изменение активности через панель управления',
  client: DbClient = supabase
): Promise<void> {
  const { error } = await client.rpc('set_member_active', {
    p_target_user_id: targetUserId,
    p_is_active: isActive,
    p_reason: reason
  });
  if (error) throw error;
}

export async function setMemberRole(
  targetUserId: string,
  newRole: 'owner' | 'operator',
  reason = 'Смена роли через панель управления',
  client: DbClient = supabase
): Promise<void> {
  const { error } = await client.rpc('set_member_role', {
    p_target_user_id: targetUserId,
    p_new_role: newRole,
    p_reason: reason
  });
  if (error) throw error;
}

export interface InviteInput {
  email: string;
  displayName?: string;
  role: 'owner' | 'operator';
  resend?: boolean;
}

export interface InviteResult {
  success: boolean;
  message: string;
  action_link?: string | null;
  user_id?: string;
  email?: string;
  role?: string;
}

export async function inviteMember(
  input: InviteInput,
  client: DbClient = supabase
): Promise<InviteResult> {
  const { data, error } = await client.functions.invoke('invite-member', {
    body: input
  });

  if (error) throw error;
  if (data?.error) throw new Error(data.error);

  return {
    success: true,
    message: data?.message || 'Приглашение успешно отправлено',
    action_link: data?.action_link ?? null,
    user_id: data?.user_id,
    email: data?.email,
    role: data?.role
  };
}

export async function loadProfileAudit(targetUserId?: string, client: DbClient = supabase): Promise<ProfileAuditLog[]> {
  let query = client
    .from('profile_audit_logs')
    .select('id,target_user_id,target_display_name,changed_by_user_id,changed_by_display_name,action,old_role,new_role,old_active_status,new_active_status,reason,created_at')
    .order('created_at', { ascending: false })
    .limit(50);

  if (targetUserId) {
    query = query.eq('target_user_id', targetUserId);
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as ProfileAuditLog[];
}
