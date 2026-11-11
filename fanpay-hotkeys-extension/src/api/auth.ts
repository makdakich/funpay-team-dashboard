/**
 * Supabase Auth client for the FanPay Hotkeys extension (team backend v2.4).
 *
 * The v2.4 database exposes every write RPC to the `authenticated` role only and
 * derives the caller identity strictly from `auth.uid()`. The publishable (anon)
 * key alone therefore cannot call anything: the extension has to sign the operator
 * in and send the resulting access token as `Authorization: Bearer <token>`.
 *
 * This module talks to the Supabase Auth REST endpoints directly with `fetch`,
 * keeping the extension free of external npm dependencies.
 */

import { CloudAuthSession } from '../shared/types';

/** chrome.storage.local key holding the persisted operator session. */
export const AUTH_STORAGE_KEY = 'fphk_auth_session';

/** Refresh the token slightly before it actually expires. */
const EXPIRY_SKEW_MS = 60_000;

export interface AuthUserInfo {
  id: string;
  email?: string | null;
}

interface RawAuthResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  expires_at?: number;
  user?: { id?: string; email?: string | null };
  error?: string;
  error_code?: string;
  error_description?: string;
  msg?: string;
  message?: string;
}

export class SupabaseAuthError extends Error {
  public readonly status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = 'SupabaseAuthError';
    this.status = status;
  }
}

function normalizeAuthError(status: number, payload: RawAuthResponse | null, fallbackText?: string): string {
  const raw = payload?.error_description || payload?.error || payload?.msg || payload?.message || fallbackText || '';
  const lower = raw.toLowerCase();

  if (lower.includes('invalid login credentials')) {
    return 'Неверный email или пароль';
  }
  if (lower.includes('email not confirmed')) {
    return 'Email не подтверждён. Подтвердите адрес в письме от Supabase';
  }
  if (lower.includes('user already registered')) {
    return 'Пользователь с таким email уже зарегистрирован';
  }
  if (lower.includes('password should be at least')) {
    return 'Пароль слишком короткий (минимум 6 символов)';
  }
  if (lower.includes('refresh token') || lower.includes('token is expired') || lower.includes('invalid claim')) {
    return 'Сессия истекла, требуется повторный вход';
  }
  if (!raw) {
    return `Ошибка авторизации Supabase (HTTP ${status})`;
  }
  return raw;
}

function normalizeSession(raw: RawAuthResponse): CloudAuthSession | null {
  const accessToken = raw.access_token;
  const refreshToken = raw.refresh_token;
  const userId = raw.user?.id;

  if (!accessToken || !refreshToken || !userId) {
    return null;
  }

  const expiresAt = typeof raw.expires_at === 'number'
    ? raw.expires_at * 1000
    : Date.now() + (typeof raw.expires_in === 'number' ? raw.expires_in * 1000 : 3600_000);

  return {
    accessToken,
    refreshToken,
    expiresAt,
    userId,
    email: raw.user?.email ?? undefined,
    savedAt: Date.now()
  };
}

export class SupabaseAuth {
  private url: string;
  private anonKey: string;

  constructor(url: string, anonKey: string) {
    this.url = (url || '').replace(/\/+$/, '');
    this.anonKey = anonKey || '';
  }

  public updateConfig(url?: string, anonKey?: string) {
    if (url) this.url = url.replace(/\/+$/, '');
    if (anonKey) this.anonKey = anonKey;
  }

  private headers(accessToken?: string): Record<string, string> {
    const headers: Record<string, string> = {
      'apikey': this.anonKey,
      'Authorization': `Bearer ${accessToken || this.anonKey}`,
      'Content-Type': 'application/json'
    };
    return headers;
  }

  private async request(
    path: string,
    init: { method: string; body?: string; accessToken?: string }
  ): Promise<RawAuthResponse> {
    let res: Response;
    try {
      res = await fetch(`${this.url}${path}`, {
        method: init.method,
        headers: this.headers(init.accessToken),
        body: init.body
      });
    } catch (err) {
      throw new SupabaseAuthError(
        err instanceof Error ? `Нет связи с Supabase: ${err.message}` : 'Нет связи с Supabase'
      );
    }

    const text = await res.text();
    let payload: RawAuthResponse | null = null;
    if (text) {
      try {
        payload = JSON.parse(text) as RawAuthResponse;
      } catch {
        payload = null;
      }
    }

    if (!res.ok) {
      throw new SupabaseAuthError(normalizeAuthError(res.status, payload, text), res.status);
    }

    return payload || {};
  }

  /** Sign in with email + password (`grant_type=password`). */
  public async signInWithPassword(email: string, password: string): Promise<CloudAuthSession> {
    const trimmedEmail = (email || '').trim();
    if (!trimmedEmail || !password) {
      throw new SupabaseAuthError('Укажите email и пароль оператора');
    }

    const payload = await this.request('/auth/v1/token?grant_type=password', {
      method: 'POST',
      body: JSON.stringify({ email: trimmedEmail, password })
    });

    const session = normalizeSession(payload);
    if (!session) {
      throw new SupabaseAuthError('Supabase не вернул данные сессии');
    }
    return session;
  }

  /** Exchange a refresh token for a new access token. */
  public async refreshSession(refreshToken: string): Promise<CloudAuthSession> {
    if (!refreshToken) {
      throw new SupabaseAuthError('Отсутствует refresh token');
    }

    const payload = await this.request('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      body: JSON.stringify({ refresh_token: refreshToken })
    });

    const session = normalizeSession(payload);
    if (!session) {
      throw new SupabaseAuthError('Supabase не вернул обновлённую сессию');
    }
    return session;
  }

  /** Server-side logout. Failures are non-fatal: the local session is dropped anyway. */
  public async signOut(accessToken?: string): Promise<void> {
    if (!accessToken) return;
    try {
      await this.request('/auth/v1/logout', { method: 'POST', accessToken });
    } catch {
      // The local session is cleared regardless of the network outcome.
    }
  }

  /** Resolve the authenticated user behind an access token. */
  public async getUser(accessToken: string): Promise<AuthUserInfo> {
    const payload = (await this.request('/auth/v1/user', { method: 'GET', accessToken })) as AuthUserInfo;
    if (!payload?.id) {
      throw new SupabaseAuthError('Не удалось определить пользователя по токену');
    }
    return { id: payload.id, email: payload.email };
  }
}

// ---------------------------------------------------------------------------
// Session persistence (chrome.storage.local)
// ---------------------------------------------------------------------------

function hasChromeStorage(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.storage?.local;
}

export async function saveAuthSession(session: CloudAuthSession | null): Promise<void> {
  if (!hasChromeStorage()) return;
  if (!session) {
    await chrome.storage.local.remove([AUTH_STORAGE_KEY]);
    return;
  }
  await chrome.storage.local.set({ [AUTH_STORAGE_KEY]: session });
}

export async function loadAuthSession(): Promise<CloudAuthSession | null> {
  if (!hasChromeStorage()) return null;
  const stored = await chrome.storage.local.get([AUTH_STORAGE_KEY]);
  const session = stored[AUTH_STORAGE_KEY] as CloudAuthSession | undefined;
  if (!session?.accessToken || !session?.refreshToken || !session?.userId) {
    return null;
  }
  return session;
}

export async function clearAuthSession(): Promise<void> {
  await saveAuthSession(null);
}

export function isSessionExpired(session: CloudAuthSession, now: number = Date.now()): boolean {
  return !session.expiresAt || session.expiresAt - EXPIRY_SKEW_MS <= now;
}

/**
 * Load the stored session and silently refresh it when the access token is about to expire.
 * Returns null when there is no session or the refresh token is no longer accepted.
 */
export async function loadFreshSession(url: string, anonKey: string): Promise<CloudAuthSession | null> {
  const session = await loadAuthSession();
  if (!session) return null;

  if (!isSessionExpired(session)) {
    return session;
  }

  try {
    const refreshed = await new SupabaseAuth(url, anonKey).refreshSession(session.refreshToken);
    await saveAuthSession(refreshed);
    return refreshed;
  } catch {
    await clearAuthSession();
    return null;
  }
}
