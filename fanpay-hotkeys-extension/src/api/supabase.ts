/**
 * Supabase cloud client for the FunPay Hotkeys extension - team backend v2.4.
 *
 * The v2.4 schema is relational and strictly server-driven:
 *   - public.shifts holds no financial aggregates at all. Money is derived from
 *     public.orders (status = 'closed') by the dashboard, never written by a client.
 *   - public.shifts is keyed by user_id / seller_account_id, uses ISO timestamptz values
 *     and expects a real UUID in `id`.
 *   - public.operator_status tracks presence through `status` + `last_heartbeat_at`.
 *   - every write path goes through a SECURITY DEFINER RPC or an RLS policy and requires
 *     the caller JWT (auth.uid()), so the publishable key alone is never enough.
 *
 * Requests use the PostgREST endpoints directly with fetch, keeping the extension
 * dependency-free.
 */

import {
  CloudShop,
  CompletedShift,
  FunPayOrder,
  OrderSyncReport,
  ShiftEarnings,
  TeamMemberStatus
} from '../shared/types';
import { calculateShiftEarnings, generateUuid } from '../shared/utils';
import { syncOrdersWithRpc } from './orders-sync';

export const DEFAULT_SUPABASE_CONFIG = {
  url: 'https://zlpbywengymnvrpbcxvh.supabase.co',
  anonKey: 'sb_publishable_bNZgLYmEol6FzzqvfXOHtA_d-mzoaKR'
};

/** Raw row of public.shifts with the embedded profile display name. */
export interface RemoteShiftRecord {
  id: string;
  user_id: string;
  seller_account_id: string;
  start_time: string;
  end_time?: string | null;
  duration_seconds?: number | null;
  status: 'active' | 'completed';
  profiles?: { display_name?: string | null } | null;
}

/** Raw row of public.operator_status joined with profiles. */
export interface RemoteOperatorStatusRecord {
  user_id: string;
  status: 'offline' | 'online' | 'on_shift' | 'break';
  active_shift_id?: string | null;
  current_seller_account_id?: string | null;
  app_version?: string | null;
  last_heartbeat_at?: string | null;
  profiles?: { display_name?: string | null; role?: string | null } | null;
}

/** Raw row of public.team_seller_accounts. */
export interface RemoteSellerAccountRecord {
  seller_account_id: string;
  account_name: string;
  is_active?: boolean;
}

export interface SupabaseResult {
  success: boolean;
  error?: string;
}

export interface ConnectionCheck extends SupabaseResult {
  authenticated: boolean;
}

interface PostgrestErrorPayload {
  message?: string;
  details?: string;
  hint?: string;
  code?: string;
}

interface RequestOutcome<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error?: string;
}

const EMPTY_EARNINGS: ShiftEarnings = {
  ordersCount: 0,
  turnoverByCurrency: {},
  sellerShareByCurrency: {},
  refundedCount: 0,
  refundedSumByCurrency: {},
  orderIds: []
};

/** Shift lifecycle payload for public.shifts. */
export interface StartShiftInput {
  shiftId?: string;
  userId: string;
  sellerAccountId: string;
  startTimeMs: number;
}

export interface FinishShiftInput {
  shiftId: string;
  endTimeMs?: number;
}

/** Presence payload for public.operator_status. */
export interface OperatorStatusInput {
  userId: string;
  status: 'offline' | 'online' | 'on_shift' | 'break';
  activeShiftId?: string | null;
  sellerAccountId?: string | null;
  appVersion?: string | null;
}

export interface FetchShiftsOptions {
  localOrders?: FunPayOrder[];
  sellerSharePercent?: number;
  currentUserId?: string;
}

export class SupabaseClient {
  private url: string;
  private key: string;
  private accessToken: string | null = null;

  constructor(url: string = DEFAULT_SUPABASE_CONFIG.url, key: string = DEFAULT_SUPABASE_CONFIG.anonKey) {
    this.url = (url || DEFAULT_SUPABASE_CONFIG.url).replace(/\/+$/, '');
    this.key = key || DEFAULT_SUPABASE_CONFIG.anonKey;
  }

  public updateConfig(url?: string, key?: string) {
    if (url) this.url = url.replace(/\/+$/, '');
    if (key) this.key = key;
  }

  /** Attach the Supabase Auth access token of the signed-in operator. */
  public setAccessToken(token: string | null) {
    this.accessToken = token && token.length > 0 ? token : null;
  }

  public hasAccessToken(): boolean {
    return this.accessToken !== null;
  }

  private get headers(): Record<string, string> {
    return {
      'apikey': this.key,
      'Authorization': 'Bearer ' + (this.accessToken || this.key),
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    };
  }

  private async request<T>(
    path: string,
    init: { method: string; body?: string; prefer?: string } = { method: 'GET' }
  ): Promise<RequestOutcome<T>> {
    const headers = this.headers;
    if (init.prefer) {
      headers['Prefer'] = init.prefer;
    }

    try {
      const res = await fetch(this.url + path, {
        method: init.method,
        headers,
        body: init.body
      });

      const text = await res.text();
      let data: T | null = null;
      if (text) {
        try {
          data = JSON.parse(text) as T;
        } catch {
          data = null;
        }
      }

      if (!res.ok) {
        const payload = (data || {}) as PostgrestErrorPayload;
        const detail = payload.message || payload.details || text;
        let message = 'HTTP ' + res.status + (detail ? ': ' + detail : '');
        if (res.status === 401 || res.status === 403) {
          message = 'Нет прав на операцию в облаке (HTTP ' + res.status + '). Проверьте вход оператора.';
        }
        return { ok: false, status: res.status, data: null, error: message };
      }

      return { ok: true, status: res.status, data };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        data: null,
        error: err instanceof Error ? 'Нет связи с Supabase: ' + err.message : 'Нет связи с Supabase'
      };
    }
  }

  /**
   * Probe the REST endpoint. An anonymous key still receives HTTP 200 with zero rows
   * because of RLS, so `authenticated` reports whether a JWT is attached.
   */
  public async testConnection(): Promise<ConnectionCheck> {
    const outcome = await this.request<unknown[]>('/rest/v1/profiles?select=user_id&limit=1');
    return {
      success: outcome.ok,
      authenticated: this.hasAccessToken(),
      error: outcome.error
    };
  }

  // -------------------------------------------------------------------------
  // Shifts (public.shifts, schema v2.4)
  // -------------------------------------------------------------------------

  /** Open a shift row. The v2.4 trigger forces status = 'active' for operators. */
  public async startShift(input: StartShiftInput): Promise<SupabaseResult> {
    if (!input?.userId) {
      return { success: false, error: 'Не определён пользователь Supabase (user_id)' };
    }
    if (!input?.sellerAccountId) {
      return { success: false, error: 'Не указан ID магазина продавца (seller_account_id)' };
    }

    const shiftId = input.shiftId && /^[0-9a-f-]{36}$/i.test(input.shiftId) ? input.shiftId : generateUuid();
    const startTime = new Date(input.startTimeMs || Date.now()).toISOString();

    const outcome = await this.request<RemoteShiftRecord[]>('/rest/v1/shifts', {
      method: 'POST',
      body: JSON.stringify({
        id: shiftId,
        user_id: input.userId,
        seller_account_id: input.sellerAccountId,
        start_time: startTime,
        status: 'active',
        duration_seconds: 0
      }),
      prefer: 'return=representation'
    });

    return { success: outcome.ok, error: outcome.error };
  }

  /** Close a shift row. The trigger recomputes duration_seconds and pins end_time. */
  public async finishShift(input: FinishShiftInput): Promise<SupabaseResult> {
    if (!input?.shiftId) {
      return { success: false, error: 'Не указан ID смены' };
    }

    const endTime = new Date(input.endTimeMs || Date.now()).toISOString();
    const path = '/rest/v1/shifts?id=eq.' + encodeURIComponent(input.shiftId);

    const outcome = await this.request<RemoteShiftRecord[]>(path, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'completed', end_time: endTime }),
      prefer: 'return=representation'
    });

    return { success: outcome.ok, error: outcome.error };
  }

  /**
   * Fetch cloud shifts and adapt them to the local CompletedShift shape.
   * v2.4 stores no aggregates, so earnings are recomputed from the local order cache
   * for the signed-in operator only; shifts of other operators carry empty earnings.
   */
  public async fetchCloudShifts(limit: number = 150, options: FetchShiftsOptions = {}): Promise<CompletedShift[]> {
    const query =
      '/rest/v1/shifts?select=id,user_id,seller_account_id,start_time,end_time,duration_seconds,status,profiles(display_name)' +
      '&order=start_time.desc&limit=' + encodeURIComponent(String(limit));

    const outcome = await this.request<RemoteShiftRecord[]>(query);
    if (!outcome.ok || !Array.isArray(outcome.data)) {
      return [];
    }

    const settings = { localOrders: options.localOrders || [], sellerSharePercent: options.sellerSharePercent ?? 10 };

    return outcome.data.map((row) => {
      const parsedStart = Date.parse(row.start_time);
      const startTime = Number.isNaN(parsedStart) ? 0 : parsedStart;
      const durationMs = (row.duration_seconds || 0) * 1000;
      const parsedEnd = row.end_time ? Date.parse(row.end_time) : NaN;
      const endTime = Number.isNaN(parsedEnd) ? startTime + durationMs : parsedEnd;

      const isOwnShift = !!options.currentUserId && row.user_id === options.currentUserId;
      const earnings = isOwnShift && startTime > 0 && settings.localOrders.length > 0
        ? calculateShiftEarnings(startTime, endTime, settings.localOrders, settings.sellerSharePercent)
        : { ...EMPTY_EARNINGS };

      return {
        id: row.id,
        operatorName: row.profiles?.display_name || 'Оператор',
        startTime,
        endTime,
        duration: durationMs,
        sellerSharePercent: options.sellerSharePercent,
        earnings,
        note: row.status === 'active'
          ? '🟢 В процессе'
          : isOwnShift
            ? undefined
            : 'Облачная смена другого оператора'
      } as CompletedShift;
    });
  }

  // -------------------------------------------------------------------------
  // Presence (public.operator_status, schema v2.4)
  // -------------------------------------------------------------------------

  /** Upsert the operator heartbeat row (PK user_id). */
  public async upsertOperatorStatus(input: OperatorStatusInput): Promise<SupabaseResult> {
    if (!input?.userId) {
      return { success: false, error: 'Не определён пользователь Supabase (user_id)' };
    }

    const outcome = await this.request<unknown>('/rest/v1/operator_status', {
      method: 'POST',
      body: JSON.stringify({
        user_id: input.userId,
        status: input.status,
        active_shift_id: input.activeShiftId ?? null,
        current_seller_account_id: input.sellerAccountId ?? null,
        app_version: input.appVersion ?? null,
        last_heartbeat_at: new Date().toISOString()
      }),
      prefer: 'resolution=merge-duplicates,return=minimal'
    });

    return { success: outcome.ok, error: outcome.error };
  }

  /** Team presence board, newest heartbeat first. */
  public async fetchTeamOnlineStatus(): Promise<TeamMemberStatus[]> {
    const query =
      '/rest/v1/operator_status?select=user_id,status,active_shift_id,current_seller_account_id,app_version,last_heartbeat_at,profiles(display_name,role)' +
      '&order=last_heartbeat_at.desc';

    const outcome = await this.request<RemoteOperatorStatusRecord[]>(query);
    if (!outcome.ok || !Array.isArray(outcome.data)) {
      return [];
    }

    return outcome.data.map((row) => ({
      userId: row.user_id,
      displayName: row.profiles?.display_name || 'Оператор',
      role: row.profiles?.role || 'operator',
      status: row.status,
      activeShiftId: row.active_shift_id ?? null,
      sellerAccountId: row.current_seller_account_id ?? null,
      appVersion: row.app_version ?? null,
      lastHeartbeatAt: row.last_heartbeat_at ?? null
    }));
  }

  /** Shops the owner registered for the team (team_seller_accounts, is_active = true). */
  public async fetchAuthorizedShops(): Promise<CloudShop[]> {
    const query =
      '/rest/v1/team_seller_accounts?select=seller_account_id,account_name,is_active' +
      '&is_active=eq.true&order=account_name.asc';

    const outcome = await this.request<RemoteSellerAccountRecord[]>(query);
    if (!outcome.ok || !Array.isArray(outcome.data)) {
      return [];
    }

    return outcome.data.map((row) => ({
      sellerAccountId: row.seller_account_id,
      accountName: row.account_name
    }));
  }

  // -------------------------------------------------------------------------
  // RPC bridge
  // -------------------------------------------------------------------------

  /** Call any public RPC exposed by PostgREST (/rest/v1/rpc/<fn>). */
  public async callRpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T> {
    const outcome = await this.request<T>('/rest/v1/rpc/' + encodeURIComponent(fn), {
      method: 'POST',
      body: JSON.stringify(args || {}),
      prefer: 'return=representation'
    });

    if (!outcome.ok) {
      throw new Error(outcome.error || 'Ошибка вызова RPC ' + fn);
    }

    return outcome.data as T;
  }

  /** Push locally cached orders through sync_orders_batch in chunks of 50. */
  public async syncOrdersBatch(sellerAccountId: string, orders: FunPayOrder[]): Promise<OrderSyncReport> {
    const rpc = <T>(fn: string, args: Record<string, unknown>) => this.callRpc<T>(fn, args);
    return syncOrdersWithRpc(rpc, sellerAccountId, orders);
  }

  /**
   * Import historical shifts from legacy storage directly into public.shifts.
   * Executed via secure SECURITY DEFINER RPC import_legacy_shifts, tied to Creator's JWT.
   */
  public async importHistoricalShifts(shifts: CompletedShift[]): Promise<{
    success: boolean;
    totalReceived?: number;
    importedCount?: number;
    skippedCount?: number;
    error?: string;
  }> {
    if (!this.hasAccessToken()) {
      return { success: false, error: 'Требуется активная сессия Создателя в Supabase' };
    }

    try {
      const outcome = await this.callRpc<{
        success: boolean;
        total_received: number;
        imported_count: number;
        skipped_count: number;
        error?: string;
      }>('import_legacy_shifts', { p_shifts: shifts });

      return {
        success: outcome.success,
        totalReceived: outcome.total_received,
        importedCount: outcome.imported_count,
        skippedCount: outcome.skipped_count,
        error: outcome.error
      };
    } catch (err: unknown) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Ошибка при вызове import_legacy_shifts'
      };
    }
  }
}

export const supabase = new SupabaseClient();

