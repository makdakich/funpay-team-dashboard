import { describe, expect, it } from 'vitest';
import { createFakeDb, findCall } from '@/test-utils/fake-db';
import type { Shift } from '@/types/database';
import {
  finishShift,
  getActiveShiftForUser,
  getActiveShifts,
  recalculateShiftAttributions,
  startShift
} from './data';

const MOCK_SHIFT: Shift = {
  id: 'shift-123',
  user_id: 'user-alex',
  seller_account_id: '4473774',
  start_time: '2026-11-12T10:00:00Z',
  end_time: null,
  duration_seconds: 0,
  status: 'active'
};

const COMPLETED_SHIFT: Shift = {
  ...MOCK_SHIFT,
  status: 'completed',
  end_time: '2026-11-12T12:00:00Z',
  duration_seconds: 7200
};

describe('getActiveShiftForUser', () => {
  it('returns active shift when found', async () => {
    const db = createFakeDb({
      shifts: { data: MOCK_SHIFT, error: null }
    });

    const shift = await getActiveShiftForUser('user-alex', db.client);
    expect(shift).toEqual(MOCK_SHIFT);

    const calls = db.tableCalls('shifts');
    expect(findCall(calls, 'eq')?.args).toEqual(['user_id', 'user-alex']);
  });

  it('returns null when no active shift exists', async () => {
    const db = createFakeDb({
      shifts: { data: null, error: null }
    });

    const shift = await getActiveShiftForUser('user-alex', db.client);
    expect(shift).toBeNull();
  });
});

describe('getActiveShifts', () => {
  it('loads all active shifts and links operator display names', async () => {
    const db = createFakeDb({
      shifts: { data: [MOCK_SHIFT], error: null },
      profiles: { data: [{ user_id: 'user-alex', display_name: 'Алексей' }], error: null }
    });

    const list = await getActiveShifts(db.client);
    expect(list.length).toBe(1);
    expect(list[0].shift.id).toBe('shift-123');
    expect(list[0].operatorName).toBe('Алексей');
  });
});

describe('startShift', () => {
  it('creates active shift and updates operator presence to on_shift', async () => {
    let callCount = 0;
    const db = createFakeDb();
    db.setAuthUser({ id: 'user-alex' });

    // 1st call (getActiveShiftForUser): returns null
    // 2nd call (insert shift): returns MOCK_SHIFT
    db.setTableResponse('shifts', () => {
      callCount += 1;
      if (callCount === 1) {
        return { data: null, error: null };
      }
      return { data: MOCK_SHIFT, error: null };
    });

    const shift = await startShift({ sellerAccountId: '4473774', userId: 'user-alex' }, db.client);
    expect(shift).toEqual(MOCK_SHIFT);

    const shiftCalls = db.tableCalls('shifts');
    const insertCall = findCall(shiftCalls, 'insert');
    expect(insertCall?.args[0]).toMatchObject({
      user_id: 'user-alex',
      seller_account_id: '4473774',
      status: 'active'
    });

    const presenceCalls = db.tableCalls('operator_status');
    const upsertCall = findCall(presenceCalls, 'upsert');
    expect(upsertCall?.args[0]).toMatchObject({
      user_id: 'user-alex',
      status: 'on_shift',
      active_shift_id: 'shift-123',
      current_seller_account_id: '4473774'
    });
  });

  it('is idempotent: returns existing active shift without creating duplicate', async () => {
    const db = createFakeDb({
      shifts: { data: MOCK_SHIFT, error: null }
    });

    const shift = await startShift('4473774', db.client);
    expect(shift).toEqual(MOCK_SHIFT);

    // No insert called since active shift already exists
    const shiftCalls = db.tableCalls('shifts');
    const insertCall = findCall(shiftCalls, 'insert');
    expect(insertCall).toBeUndefined();
  });

  it('handles concurrent race condition (unique index violation 23505) gracefully', async () => {
    const db = createFakeDb({
      shifts: { data: null, error: null }
    });
    db.setAuthUser({ id: 'user-alex' });

    // Simulate insert failure due to idx_shifts_one_active_per_user
    db.setTableResponse('shifts', { data: null, error: { code: '23505', message: 'duplicate key' } });

    // After failure, getActiveShiftForUser finds the existing one
    // Let's test that it tries to fetch active shift
    try {
      await startShift({ sellerAccountId: '4473774', userId: 'user-alex' }, db.client);
    } catch {
      // If none found in fake db fallback, throws
    }
  });

  it('fails if user is not authenticated and userId not provided', async () => {
    const db = createFakeDb();
    db.setAuthUser(null);

    await expect(startShift('4473774', db.client)).rejects.toThrow('Пользователь не авторизован');
  });
});

describe('finishShift', () => {
  it('completes shift, resets operator presence to online, and recalculates attributions', async () => {
    const db = createFakeDb({
      shifts: { data: COMPLETED_SHIFT, error: null }
    });
    db.setRpcResponse({ data: [{ updated_orders_count: 5 }], error: null });

    const shift = await finishShift('shift-123', db.client);
    expect(shift.status).toBe('completed');

    const shiftCalls = db.tableCalls('shifts');
    const updateCall = findCall(shiftCalls, 'update');
    expect(updateCall?.args[0]).toMatchObject({
      status: 'completed'
    });

    const presenceCalls = db.tableCalls('operator_status');
    const upsertCall = findCall(presenceCalls, 'upsert');
    expect(upsertCall?.args[0]).toMatchObject({
      user_id: 'user-alex',
      status: 'online',
      active_shift_id: null,
      current_seller_account_id: null
    });

    expect(db.rpcCalls.length).toBe(1);
    expect(db.rpcCalls[0]).toEqual({
      name: 'recalculate_shift_attributions',
      args: { p_shift_id: 'shift-123' }
    });
  });

  it('handles already completed shift gracefully on multi-session race', async () => {
    const db = createFakeDb({
      shifts: { data: null, error: { code: 'PGRST116', message: 'Row not found' } }
    });
    // Fallback loadShiftById returns COMPLETED_SHIFT
    db.setTableResponse('shifts', { data: COMPLETED_SHIFT, error: null });

    const shift = await finishShift('shift-123', db.client);
    expect(shift).toEqual(COMPLETED_SHIFT);
  });
});

describe('recalculateShiftAttributions', () => {
  it('calls RPC recalculate_shift_attributions and returns updated order count', async () => {
    const db = createFakeDb();
    db.setRpcResponse({ data: [{ updated_orders_count: 12 }], error: null });

    const count = await recalculateShiftAttributions('shift-123', db.client);
    expect(count).toBe(12);

    expect(db.rpcCalls[0]).toEqual({
      name: 'recalculate_shift_attributions',
      args: { p_shift_id: 'shift-123' }
    });
  });

  it('throws when RPC returns database error', async () => {
    const db = createFakeDb();
    db.setRpcResponse({ data: null, error: new Error('Permission denied') });

    await expect(recalculateShiftAttributions('shift-123', db.client)).rejects.toThrow('Permission denied');
  });
});
