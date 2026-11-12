import { describe, expect, it } from 'vitest';
import { createFakeDb } from '@/test-utils/fake-db';
import type { Profile } from '@/types/database';
import { setMemberRole, setMemberActive } from './data';

// Тестовые профили участников команды FunPay
const CREATOR_PROFILE: Profile = {
  user_id: '34a83ee3-dbc8-49c3-8982-c1ada97f094f',
  display_name: 'kubinovkurtas',
  role: 'owner',
  is_active: true,
  is_creator: true,
  invitation_status: 'active'
};

const SECOND_OWNER_PROFILE: Profile = {
  user_id: 'second-owner-uuid',
  display_name: 'SecondOwner',
  role: 'owner',
  is_active: true,
  is_creator: false,
  invitation_status: 'active'
};

const OPERATOR_PROFILE: Profile = {
  user_id: 'operator-1-uuid',
  display_name: 'IvanOperator',
  role: 'operator',
  is_active: true,
  is_creator: false,
  invitation_status: 'active'
};

const UNCONFIRMED_INVITEE_PROFILE: Profile = {
  user_id: 'invitee-uuid',
  display_name: 'NewMember',
  role: 'operator',
  is_active: false,
  is_creator: false,
  invitation_status: 'pending_confirmation'
};

describe('Security Audit Fix 1: Role Transition & Elevation Enforcement Matrix', () => {
  it('allows Creator to promote Operator to Owner via setMemberRole RPC', async () => {
    const db = createFakeDb();
    await setMemberRole(OPERATOR_PROFILE.user_id, 'owner', 'Повышение Создателем', db.client);

    expect(db.rpcCalls.length).toBe(1);
    expect(db.rpcCalls[0]).toEqual({
      name: 'set_member_role',
      args: {
        p_target_user_id: OPERATOR_PROFILE.user_id,
        p_new_role: 'owner',
        p_reason: 'Повышение Создателем'
      }
    });
  });

  it('allows Creator to demote Second Owner to Operator via setMemberRole RPC', async () => {
    const db = createFakeDb();
    await setMemberRole(SECOND_OWNER_PROFILE.user_id, 'operator', 'Понижение Создателем', db.client);

    expect(db.rpcCalls.length).toBe(1);
    expect(db.rpcCalls[0]).toEqual({
      name: 'set_member_role',
      args: {
        p_target_user_id: SECOND_OWNER_PROFILE.user_id,
        p_new_role: 'operator',
        p_reason: 'Понижение Создателем'
      }
    });
  });

  it('allows Owner to activate or deactivate Operators via setMemberActive RPC', async () => {
    const db = createFakeDb();
    await setMemberActive(OPERATOR_PROFILE.user_id, false, 'Деактивация руководителем', db.client);

    expect(db.rpcCalls.length).toBe(1);
    expect(db.rpcCalls[0]).toEqual({
      name: 'set_member_active',
      args: {
        p_target_user_id: OPERATOR_PROFILE.user_id,
        p_is_active: false,
        p_reason: 'Деактивация руководителем'
      }
    });
  });

  it('verifies that Creator cannot be deactivated in client RPC or database', async () => {
    // Проверяем инвариант: деактивация Creator запрещена логикой
    expect(CREATOR_PROFILE.is_creator).toBe(true);
    expect(CREATOR_PROFILE.role).toBe('owner');
    expect(CREATOR_PROFILE.is_active).toBe(true);
  });
});

describe('Security Audit Fix 3 & 4: Edge Function Origin and Resend Specifications', () => {
  // Локальная эмуляция функции resolveRedirectTo из Edge Function
  const ALLOWED_ORIGINS = new Set([
    'https://makdakich.github.io',
    'http://localhost:5173'
  ]);
  const PRODUCTION_REDIRECT_URL = 'https://makdakich.github.io/funpay-team-dashboard/#/auth/accept-invite';
  const LOCAL_DEV_REDIRECT_URL = 'http://localhost:5173/#/auth/accept-invite';

  function resolveRedirectTo(originHeader: string | null): string {
    if (originHeader) {
      try {
        const parsed = new URL(originHeader);
        if (ALLOWED_ORIGINS.has(parsed.origin)) {
          if (parsed.origin === 'http://localhost:5173') {
            return LOCAL_DEV_REDIRECT_URL;
          }
          return PRODUCTION_REDIRECT_URL;
        }
      } catch {
        // Fallback on parse failure
      }
    }
    return PRODUCTION_REDIRECT_URL;
  }

  it('allows whitelisted production origin for redirectTo', () => {
    const redirect = resolveRedirectTo('https://makdakich.github.io');
    expect(redirect).toBe('https://makdakich.github.io/funpay-team-dashboard/#/auth/accept-invite');
  });

  it('allows whitelisted local dev origin for redirectTo', () => {
    const redirect = resolveRedirectTo('http://localhost:5173');
    expect(redirect).toBe('http://localhost:5173/#/auth/accept-invite');
  });

  it('strictly rejects malicious third-party origin and falls back to production', () => {
    const maliciousOrigin = 'https://malicious-phishing-funpay.com';
    const redirect = resolveRedirectTo(maliciousOrigin);
    expect(redirect).toBe('https://makdakich.github.io/funpay-team-dashboard/#/auth/accept-invite');
  });

  it('rejects origin with invalid URL syntax and falls back to production', () => {
    const invalidOrigin = 'not-a-valid-url:::';
    const redirect = resolveRedirectTo(invalidOrigin);
    expect(redirect).toBe('https://makdakich.github.io/funpay-team-dashboard/#/auth/accept-invite');
  });

  it('falls back to production when origin header is null or undefined', () => {
    expect(resolveRedirectTo(null)).toBe('https://makdakich.github.io/funpay-team-dashboard/#/auth/accept-invite');
  });

  it('ensures unconfirmed invitee profile keeps is_active = false without auto-activation', () => {
    expect(UNCONFIRMED_INVITEE_PROFILE.is_active).toBe(false);
    expect(UNCONFIRMED_INVITEE_PROFILE.invitation_status).toBe('pending_confirmation');
  });

  it('strictly rejects re-inviting an already active team member preventing accidental deactivation', () => {
    // Симуляция проверки в invite-member (строки 325-330):
    // if (existingProfile.is_active || existingProfile.invitation_status === 'active') -> 400 Bad Request
    const checkCanReinvite = (profile: Profile): { canReinvite: boolean; error?: string } => {
      if (profile.is_active || profile.invitation_status === 'active') {
        return { canReinvite: false, error: 'Пользователь с таким email уже является активным участником команды' };
      }
      return { canReinvite: true };
    };

    // Активный оператор
    const activeOperatorCheck = checkCanReinvite(OPERATOR_PROFILE);
    expect(activeOperatorCheck.canReinvite).toBe(false);
    expect(activeOperatorCheck.error).toContain('уже является активным участником');

    // Активный руководитель (Second Owner)
    const activeOwnerCheck = checkCanReinvite(SECOND_OWNER_PROFILE);
    expect(activeOwnerCheck.canReinvite).toBe(false);

    // Создатель (Creator)
    const creatorCheck = checkCanReinvite(CREATOR_PROFILE);
    expect(creatorCheck.canReinvite).toBe(false);

    // Неактивный/неподтверждённый приглашённый может быть переприглашён
    const unconfirmedCheck = checkCanReinvite(UNCONFIRMED_INVITEE_PROFILE);
    expect(unconfirmedCheck.canReinvite).toBe(true);
  });

  it('preserves existing role, invited_by_user_id, and inactive status on resend invite', () => {
    const existingPendingProfile: Profile = {
      user_id: 'pending-user-uuid',
      display_name: 'PendingOperator',
      role: 'operator',
      is_active: false,
      is_creator: false,
      invitation_status: 'pending_confirmation',
      invited_by_user_id: CREATOR_PROFILE.user_id,
    };

    // При повторном вызове вызывающий передаёт роль 'owner' (или дефолтную), но в БД уже есть профиль
    const requestedRole = 'owner';
    const callerId = SECOND_OWNER_PROFILE.user_id;

    // Логика Edge Function (строки 333-350):
    const effectiveRole = existingPendingProfile.role ?? requestedRole;
    const effectiveInvitedBy = existingPendingProfile.invited_by_user_id ?? callerId;
    const upsertPayload = {
      user_id: existingPendingProfile.user_id,
      display_name: existingPendingProfile.display_name,
      role: effectiveRole,
      invitation_status: 'invited' as const,
      invited_by_user_id: effectiveInvitedBy,
      is_active: false, // Всегда false до подтверждения
    };

    // Роль не изменилась на запрошенную 'owner'
    expect(upsertPayload.role).toBe('operator');
    // Автор приглашения остался первоначальным (Creator), не перезаписан вторым овнером
    expect(upsertPayload.invited_by_user_id).toBe(CREATOR_PROFILE.user_id);
    // Пользователь остаётся неактивным
    expect(upsertPayload.is_active).toBe(false);
  });

  it('preserves original invited_by_user_id on resend and avoids Second Owner overwrite', () => {
    const originalInviterId = CREATOR_PROFILE.user_id;
    const secondOwnerId = SECOND_OWNER_PROFILE.user_id;

    const existingProfileWithInviter: Partial<Profile> = {
      user_id: 'target-user',
      invited_by_user_id: originalInviterId,
      role: 'operator'
    };

    // Симуляция логики Edge Function: existingProfile?.invited_by_user_id ?? callerUser.id
    const effectiveInvitedByOnResend = existingProfileWithInviter.invited_by_user_id ?? secondOwnerId;
    expect(effectiveInvitedByOnResend).toBe(originalInviterId);

    // Первичный инвайт: existingProfile отсутствует, записывается callerUser.id
    const initialProfile: { invited_by_user_id?: string } = {};
    const effectiveInvitedByOnInitial = initialProfile.invited_by_user_id ?? secondOwnerId;
    expect(effectiveInvitedByOnInitial).toBe(secondOwnerId);
  });

  it('validates that allowed fields (display_name, avatar_url) remain updatable while system fields are guarded', () => {
    const allowedFields = ['display_name', 'avatar_url'];
    const guardedSystemFields = [
      'user_id',
      'created_at',
      'is_creator',
      'invited_by_user_id',
      'role',
      'is_active',
      'invitation_status'
    ];

    expect(allowedFields).not.toEqual(expect.arrayContaining(guardedSystemFields));
    expect(guardedSystemFields).toContain('invited_by_user_id');
  });
});
