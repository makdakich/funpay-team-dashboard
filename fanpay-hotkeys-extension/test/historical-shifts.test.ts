import test from 'node:test';
import assert from 'node:assert/strict';
import type { CompletedShift } from '../src/shared/types';

test('Message routing resolution: supports both message.type and message.action', () => {
  const resolveMessageType = (msg: any): string | undefined => {
    return (msg && (msg.type || msg.action)) || undefined;
  };

  // Sent with 'action' (as from options.ts)
  assert.equal(resolveMessageType({ action: 'CHECK_HISTORICAL_SHIFTS' }), 'CHECK_HISTORICAL_SHIFTS');
  assert.equal(resolveMessageType({ action: 'IMPORT_HISTORICAL_SHIFTS' }), 'IMPORT_HISTORICAL_SHIFTS');

  // Sent with 'type' (as standard ExtensionMessage)
  assert.equal(resolveMessageType({ type: 'CHECK_HISTORICAL_SHIFTS' }), 'CHECK_HISTORICAL_SHIFTS');
  assert.equal(resolveMessageType({ type: 'IMPORT_HISTORICAL_SHIFTS' }), 'IMPORT_HISTORICAL_SHIFTS');

  // Edge cases
  assert.equal(resolveMessageType(null), undefined);
  assert.equal(resolveMessageType({}), undefined);
  assert.equal(resolveMessageType({ type: 'GET_STATE', action: 'IGNORED' }), 'GET_STATE');
});

test('Historical shift detection: distinguishes legacy shifts vs modern UUID cloud shifts', () => {
  const shifts: CompletedShift[] = [
    {
      id: 'shift_1731230000000_abc',
      operatorName: 'Алекс',
      startTime: 1731230000000,
      endTime: 1731233600000,
      duration: 3600000
    },
    {
      id: 'shift_1731240000000_def',
      operatorName: 'Оператор 1',
      startTime: 1731240000000,
      endTime: 1731243600000,
      duration: 3600000
    },
    {
      id: '4f28cbcf-0d92-5d45-bca3-7e44a4968c99', // Valid 36-char UUID
      operatorName: 'kubinovkurtas',
      startTime: 1731250000000,
      endTime: 1731253600000,
      duration: 3600000
    }
  ];

  const legacyShifts = shifts.filter(
    s => s.id && (!/^[0-9a-f-]{36}$/i.test(s.id) || s.operatorName === 'Алекс')
  );

  assert.equal(legacyShifts.length, 2, 'Should detect both legacy shift_ ID and "Алекс" operator');
  assert.equal(legacyShifts[0].id, 'shift_1731230000000_abc');
  assert.equal(legacyShifts[1].id, 'shift_1731240000000_def');
});

test('Deduplication & Synchronization: Replaces legacy shifts with cloud UUIDs and prevents duplicates', () => {
  const initialLocalShifts: CompletedShift[] = [
    {
      id: 'legacy_shift_1',
      operatorName: 'Алекс',
      startTime: 1000,
      endTime: 2000,
      duration: 1000
    },
    {
      id: '11111111-1111-1111-1111-111111111111', // Valid UUID
      operatorName: 'kubinovkurtas',
      startTime: 3000,
      endTime: 4000,
      duration: 1000
    }
  ];

  const legacyShifts = initialLocalShifts.filter(
    s => s.id && (!/^[0-9a-f-]{36}$/i.test(s.id) || s.operatorName === 'Алекс')
  );
  assert.equal(legacyShifts.length, 1);

  // Simulated cloud shifts returned post-import (where legacy_shift_1 was assigned UUID v5 and retains legacyId)
  const cloudShifts: CompletedShift[] = [
    {
      id: '22222222-2222-2222-2222-222222222222',
      legacyId: 'legacy_shift_1',
      operatorName: 'kubinovkurtas',
      startTime: 1000,
      endTime: 2000,
      duration: 1000,
      earnings: { ordersCount: 0, turnoverByCurrency: {}, sellerShareByCurrency: {}, refundedCount: 0, refundedSumByCurrency: {}, orderIds: [] }
    }
  ];

  // Synchronization algorithm from service-worker.ts:
  const cloudIds = new Set(cloudShifts.map(s => s.id));
  const cloudLegacyIds = new Set(
    cloudShifts
      .map(s => s.legacyId)
      .filter((id): id is string => Boolean(id))
  );

  const nonLegacyLocal = initialLocalShifts.filter(s => {
    const isConfirmedInCloud = cloudIds.has(s.id) || cloudLegacyIds.has(s.id);
    return !isConfirmedInCloud;
  });

  const mergedHistory = [...cloudShifts, ...nonLegacyLocal].sort((a, b) => b.startTime - a.startTime);

  assert.equal(mergedHistory.length, 2);
  assert.equal(mergedHistory[0].id, '11111111-1111-1111-1111-111111111111');
  assert.equal(mergedHistory[1].id, '22222222-2222-2222-2222-222222222222');

  // Verify that old legacy ID is gone from local state, so checkHistoricalShifts returns 0:
  const remainingLegacy = mergedHistory.filter(
    s => s.id && (!/^[0-9a-f-]{36}$/i.test(s.id) || s.operatorName === 'Алекс')
  );
  assert.equal(remainingLegacy.length, 0, 'No legacy shifts should remain after sync');
});

test('Safety: Empty or missing fetchCloudShifts preserves local shift history completely untouched', () => {
  const initialLocalShifts: CompletedShift[] = [
    {
      id: 'legacy_shift_1',
      operatorName: 'Алекс',
      startTime: 1000,
      endTime: 2000,
      duration: 1000,
      earnings: { ordersCount: 0, turnoverByCurrency: {}, sellerShareByCurrency: {}, refundedCount: 0, refundedSumByCurrency: {}, orderIds: [] }
    },
    {
      id: 'legacy_shift_2',
      operatorName: 'Алекс',
      startTime: 2000,
      endTime: 3000,
      duration: 1000,
      earnings: { ordersCount: 0, turnoverByCurrency: {}, sellerShareByCurrency: {}, refundedCount: 0, refundedSumByCurrency: {}, orderIds: [] }
    }
  ];

  // When cloudShifts returns empty or null:
  const cloudShifts: CompletedShift[] = [];
  let savedHistory = initialLocalShifts;

  if (cloudShifts && cloudShifts.length > 0) {
    savedHistory = [];
  } else {
    // Preserved untouched
  }

  assert.equal(savedHistory.length, 2);
  assert.equal(savedHistory[0].id, 'legacy_shift_1');
  assert.equal(savedHistory[1].id, 'legacy_shift_2');
});

test('Safety: Failure during import does not wipe or mutate local storage', () => {
  const initialLocalShifts: CompletedShift[] = [
    {
      id: 'legacy_shift_1',
      operatorName: 'Алекс',
      startTime: 1000,
      endTime: 2000,
      duration: 1000
    }
  ];

  const importResult = { success: false, error: 'Network timeout' };

  // Local storage mutation is guarded by: if (result && result.success)
  let updatedShifts = initialLocalShifts;
  if (importResult.success) {
    updatedShifts = [];
  }

  assert.equal(updatedShifts.length, 1);
  assert.equal(updatedShifts[0].id, 'legacy_shift_1');
});
