import { describe, expect, it } from 'vitest';
import { createFakeDb, findCall } from '@/test-utils/fake-db';
import type { Profile } from '@/types/database';
import { loadProfileAudit, loadTeam, setMemberActive, setMemberRole, inviteMember } from './data';

const CREATOR_PROFILE: Profile = {
  user_id: '34a83ee3-dbc8-49c3-8982-c1ada97f094f',
  display_name: 'kubinovkurtas',
  role: 'owner',
  is_active: true,
  is_creator: true,
  invitation_status: 'active'
};

const SECOND_OWNER_PROFILE: Profile = {
  user_id: 'owner-2-uuid',
  display_name: 'SecondOwner',
  role: 'owner',
  is_active: true,
  is_creator: false,
  invitation_status: 'active'
};

const OPERATOR_PROFILE: Profile = {
  user_id: 'op-1-uuid',
  display_name: 'IvanOperator',
  role: 'operator',
  is_active: true,
  is_creator: false,
  invitation_status: 'active'
};

const INACTIVE_PROFILE: Profile = {
  user_id: 'pending-uuid',
  display_name: 'NewInvitee',
  role: 'operator',
  is_active: false,
  is_creator: false,
  invitation_status: 'pending_confirmation'
};

describe('loadTeam', () => {
  it('loads active team members only when includeInactive is false', async () => {
    const db = createFakeDb({
      profiles: { data: [CREATOR_PROFILE, SECOND_OWNER_PROFILE, OPERATOR_PROFILE], error: null },
      operator_status: { data: [], error: null },
      shifts: { data: [], error: null }
    });

    const result = await loadTeam(false, db.client);
    expect(result.length).toBe(3);

    const calls = db.tableCalls('profiles');
    const eqCall = findCall(calls, 'eq');
    expect(eqCall?.args).toEqual(['is_active', true]);
  });

  it('loads all members including inactive when includeInactive is true (owner view)', async () => {
    const db = createFakeDb({
      profiles: { data: [CREATOR_PROFILE, SECOND_OWNER_PROFILE, OPERATOR_PROFILE, INACTIVE_PROFILE], error: null },
      operator_status: { data: [], error: null },
      shifts: { data: [], error: null }
    });

    const result = await loadTeam(true, db.client);
    expect(result.length).toBe(4);

    const calls = db.tableCalls('profiles');
    const eqCall = findCall(calls, 'eq');
    expect(eqCall).toBeUndefined(); // Нет фильтра .eq('is_active', true)
  });
});

describe('setMemberActive', () => {
  it('calls set_member_active RPC with valid arguments', async () => {
    const db = createFakeDb();
    await setMemberActive('op-1-uuid', false, 'Тестовая деактивация', db.client);

    expect(db.rpcCalls.length).toBe(1);
    expect(db.rpcCalls[0]).toEqual({
      name: 'set_member_active',
      args: {
        p_target_user_id: 'op-1-uuid',
        p_is_active: false,
        p_reason: 'Тестовая деактивация'
      }
    });
  });
});

describe('setMemberRole', () => {
  it('calls set_member_role RPC with valid arguments', async () => {
    const db = createFakeDb();
    await setMemberRole('op-1-uuid', 'owner', 'Повышение до руководителя Создателем', db.client);

    expect(db.rpcCalls.length).toBe(1);
    expect(db.rpcCalls[0]).toEqual({
      name: 'set_member_role',
      args: {
        p_target_user_id: 'op-1-uuid',
        p_new_role: 'owner',
        p_reason: 'Повышение до руководителя Создателем'
      }
    });
  });
});

describe('loadProfileAudit', () => {
  it('queries profile_audit_logs with order and limit', async () => {
    const db = createFakeDb({
      profile_audit_logs: { data: [], error: null }
    });

    await loadProfileAudit('target-user-uuid', db.client);

    const calls = db.tableCalls('profile_audit_logs');
    expect(findCall(calls, 'eq')?.args).toEqual(['target_user_id', 'target-user-uuid']);
    expect(findCall(calls, 'limit')?.args).toEqual([50]);
  });
});

describe('inviteMember', () => {
  it('invokes edge function and surfaces action_link when returned', async () => {
    const db = createFakeDb();
    db.setFunctionResponse({
      data: {
        success: true,
        message: 'Приглашение отправлено повторно',
        user_id: 'new-user-123',
        action_link: 'https://makdakich.github.io/funpay-team-dashboard/#/auth/accept-invite#access_token=xyz'
      },
      error: null
    });

    const result = await inviteMember(
      {
        email: 'newoperator@test.com',
        displayName: 'New Operator',
        role: 'operator',
        resend: true
      },
      db.client
    );

    expect(db.functionCalls.length).toBe(1);
    expect(db.functionCalls[0]).toEqual({
      name: 'invite-member',
      options: {
        body: {
          email: 'newoperator@test.com',
          displayName: 'New Operator',
          role: 'operator',
          resend: true
        }
      }
    });

    expect(result.success).toBe(true);
    expect(result.message).toBe('Приглашение отправлено повторно');
    expect(result.action_link).toBe('https://makdakich.github.io/funpay-team-dashboard/#/auth/accept-invite#access_token=xyz');
    expect(result.user_id).toBe('new-user-123');
  });

  it('handles standard invite without action_link gracefully', async () => {
    const db = createFakeDb();
    db.setFunctionResponse({
      data: {
        success: true,
        message: 'Приглашение успешно отправлено на почту',
        user_id: 'new-user-456'
      },
      error: null
    });

    const result = await inviteMember(
      {
        email: 'regular@test.com',
        role: 'operator'
      },
      db.client
    );

    expect(db.functionCalls.length).toBe(1);
    expect(result.success).toBe(true);
    expect(result.action_link).toBeNull();
    expect(result.user_id).toBe('new-user-456');
  });
});
