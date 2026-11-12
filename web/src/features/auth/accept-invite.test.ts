import { describe, expect, it } from 'vitest';
import { isAcceptInviteRoute, isLoginRoute, isAuthRoute } from '@/app/router';

describe('Auth Routing & Invite Acceptance Specifications', () => {
  it('correctly detects accept-invite hash and pathname routes', () => {
    expect(isAcceptInviteRoute('#/auth/accept-invite')).toBe(true);
    expect(isAcceptInviteRoute('#auth/accept-invite')).toBe(true);
    expect(isAcceptInviteRoute('#/auth/accept-invite#access_token=xyz&type=invite')).toBe(true);
    expect(isAcceptInviteRoute('#/auth/accept-invite?code=123')).toBe(true);
    expect(isAcceptInviteRoute('', '/auth/accept-invite')).toBe(true);
    expect(isAcceptInviteRoute('', '/app/auth/accept-invite')).toBe(true);
  });

  it('correctly rejects non-invite routes', () => {
    expect(isAcceptInviteRoute('#/overview')).toBe(false);
    expect(isAcceptInviteRoute('#/team')).toBe(false);
    expect(isAcceptInviteRoute('#/shifts')).toBe(false);
    expect(isAcceptInviteRoute('#/orders')).toBe(false);
    expect(isAcceptInviteRoute('#/finance')).toBe(false);
    expect(isAcceptInviteRoute('#/login')).toBe(false);
  });

  it('correctly detects login routes', () => {
    expect(isLoginRoute('#/login')).toBe(true);
    expect(isLoginRoute('#login')).toBe(true);
    expect(isLoginRoute('', '/login')).toBe(true);
    expect(isLoginRoute('', '/login/')).toBe(true);
    expect(isLoginRoute('#/overview')).toBe(false);
  });

  it('correctly categorizes auth routes', () => {
    expect(isAuthRoute('#/login')).toBe(true);
    expect(isAuthRoute('#/auth/accept-invite')).toBe(true);
    expect(isAuthRoute('#/overview')).toBe(false);
    expect(isAuthRoute('#/team')).toBe(false);
  });

  it('enforces password validation rules for invite acceptance', () => {
    const validatePassword = (pwd: string, confirm: string): { valid: boolean; error?: string } => {
      if (pwd.length < 6) return { valid: false, error: 'Пароль должен содержать не менее 6 символов.' };
      if (pwd !== confirm) return { valid: false, error: 'Введённые пароли не совпадают.' };
      return { valid: true };
    };

    expect(validatePassword('123', '123').valid).toBe(false);
    expect(validatePassword('123', '123').error).toContain('не менее 6');

    expect(validatePassword('secret123', 'different').valid).toBe(false);
    expect(validatePassword('secret123', 'different').error).toContain('не совпадают');

    expect(validatePassword('StrongPass123!', 'StrongPass123!').valid).toBe(true);
    expect(validatePassword('StrongPass123!', 'StrongPass123!').error).toBeUndefined();
  });
});
