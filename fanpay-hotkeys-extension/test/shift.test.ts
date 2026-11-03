import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration, formatTimeOnly } from '../src/shared/datetime.ts';
import {
  loadShiftState,
  startShift,
  stopShift,
  loadShiftHistory,
  saveShift,
  deleteShift,
  recalculateShifts
} from '../src/storage/storage.ts';
import { calculateShiftEarnings } from '../src/shared/utils.ts';
import { FunPayOrder, CompletedShift } from '../src/shared/types.ts';

// 1. Tests for formatDuration
test('formatDuration formats zero and sub-second durations to 00:00:00', () => {
  assert.equal(formatDuration(0), '00:00:00');
  assert.equal(formatDuration(500), '00:00:00');
  assert.equal(formatDuration(999), '00:00:00');
});

test('formatDuration formats seconds, minutes and hours accurately', () => {
  assert.equal(formatDuration(1000), '00:00:01');
  assert.equal(formatDuration(59000), '00:00:59');
  assert.equal(formatDuration(60000), '00:01:00');
  assert.equal(formatDuration(65000), '00:01:05');
  assert.equal(formatDuration(3600000), '01:00:00');
  assert.equal(formatDuration(3661000), '01:01:01');
  // 1 hour 42 minutes 37 seconds = (1*3600 + 42*60 + 37) * 1000 = 6157000 ms
  assert.equal(formatDuration(6157000), '01:42:37');
});

test('formatDuration handles negative numbers safely by clamping to 00:00:00', () => {
  assert.equal(formatDuration(-10000), '00:00:00');
});

// 2. Tests for formatTimeOnly
test('formatTimeOnly formats timestamps into HH:MM:SS', () => {
  const d = new Date(2026, 9, 8, 17, 54, 21);
  const formatted = formatTimeOnly(d.getTime());
  assert.equal(formatted, '17:54:21');
});

// 3. Mock chrome.storage.local for Storage & Persistence Lifecycle tests
function setupChromeStorageMock() {
  const store: Record<string, unknown> = {};

  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: (keys: string[], cb: (res: Record<string, unknown>) => void) => {
          const res: Record<string, unknown> = {};
          for (const k of keys) {
            if (k in store) {
              res[k] = store[k];
            }
          }
          cb(res);
        },
        set: (items: Record<string, unknown>, cb?: () => void) => {
          for (const [k, v] of Object.entries(items)) {
            store[k] = v;
          }
          if (cb) cb();
        }
      }
    }
  };

  return store;
}

test('Work shift lifecycle: start, persist timestamp, calculate elapsed, stop and accumulate history newest-first', async () => {
  setupChromeStorageMock();

  // 1. Initial state
  const initial = await loadShiftState();
  assert.equal(initial.shiftActive, false);
  assert.equal(initial.shiftStartTime, null);

  const initialHistory = await loadShiftHistory();
  assert.deepEqual(initialHistory, []);

  // 2. Start shift with operator
  const beforeStart = Date.now();
  const started = await startShift('Оператор Иван', 'Старт смены');
  const afterStart = Date.now();

  assert.equal(started.shiftActive, true);
  assert.equal(started.currentOperator, 'Оператор Иван');
  assert.equal(started.note, 'Старт смены');
  assert.ok(typeof started.shiftStartTime === 'number');
  assert.ok(started.shiftStartTime! >= beforeStart);
  assert.ok(started.shiftStartTime! <= afterStart);

  // 3. Load state after reload (simulates popup closed and reopened)
  const reloaded = await loadShiftState();
  assert.equal(reloaded.shiftActive, true);
  assert.equal(reloaded.shiftStartTime, started.shiftStartTime);
  assert.equal(reloaded.currentOperator, 'Оператор Иван');

  // 4. Elapsed calculation from Date.now() - shiftStartTime
  const elapsed = Date.now() - reloaded.shiftStartTime!;
  assert.ok(elapsed >= 0);
  assert.match(formatDuration(elapsed), /^\d{2}:\d{2}:\d{2}$/);

  // 5. Stop shift
  const stopResult = await stopShift('Успешно завершена');
  assert.equal(stopResult.shiftState.shiftActive, false);
  assert.equal(stopResult.shiftState.shiftStartTime, null);
  assert.ok(stopResult.completedShift !== null);
  assert.equal(stopResult.completedShift!.operatorName, 'Оператор Иван');
  assert.equal(stopResult.completedShift!.note, 'Успешно завершена');
  assert.equal(stopResult.completedShift!.startTime, started.shiftStartTime);
  assert.ok(stopResult.completedShift!.endTime >= started.shiftStartTime!);
  assert.equal(
    stopResult.completedShift!.duration,
    stopResult.completedShift!.endTime - stopResult.completedShift!.startTime
  );

  // 6. Check history contains the completed shift
  const historyAfter1 = await loadShiftHistory();
  assert.equal(historyAfter1.length, 1);
  assert.equal(historyAfter1[0].id, stopResult.completedShift!.id);
  assert.equal(historyAfter1[0].duration, stopResult.completedShift!.duration);

  // 7. Start second shift and stop it (verifying history is newest-first)
  // Wait a small delta so start time is strictly greater
  await new Promise((r) => setTimeout(r, 10));
  const shift2 = await startShift('Оператор Анна');
  assert.equal(shift2.shiftActive, true);
  assert.equal(shift2.currentOperator, 'Оператор Анна');

  await new Promise((r) => setTimeout(r, 10));
  const stopResult2 = await stopShift();
  assert.equal(stopResult2.shiftState.shiftActive, false);

  const historyAfter2 = await loadShiftHistory();
  assert.equal(historyAfter2.length, 2);
  // Newest shift first:
  assert.equal(historyAfter2[0].id, stopResult2.completedShift!.id);
  assert.equal(historyAfter2[1].id, stopResult.completedShift!.id);
  assert.notEqual(historyAfter2[0].id, historyAfter2[1].id);

  // 8. Calling stopShift when already inactive handles gracefully
  const redundantStop = await stopShift();
  assert.equal(redundantStop.completedShift, null);
  assert.equal(redundantStop.shiftState.shiftActive, false);
  const historyAfterRedundant = await loadShiftHistory();
  assert.equal(historyAfterRedundant.length, 2);
});

// 4. Tests for calculateShiftEarnings
test('calculateShiftEarnings isolates currencies, separates closed vs refunded, and respects interval', () => {
  const shiftStart = 1000000;
  const shiftEnd = 2000000;
  const sellerPercent = 70; // 70% share

  const mockOrders: FunPayOrder[] = [
    // 1. Inside interval, closed, RUB
    {
      id: 'ord-1',
      description: 'Gold 100k',
      price: 1000,
      currency: '₽',
      buyerUsername: 'User1',
      buyerId: 101,
      chatId: 'chat-1',
      status: 'closed',
      dateStr: '10:00',
      timestamp: 1200000
    },
    // 2. Inside interval, closed, USD
    {
      id: 'ord-2',
      description: 'Account',
      price: 50,
      currency: '$',
      buyerUsername: 'User2',
      buyerId: 102,
      chatId: 'chat-2',
      status: 'closed',
      dateStr: '11:00',
      timestamp: 1500000
    },
    // 3. Inside interval, refunded, RUB
    {
      id: 'ord-3',
      description: 'Refunded item',
      price: 300,
      currency: '₽',
      buyerUsername: 'User3',
      buyerId: 103,
      chatId: 'chat-3',
      status: 'refunded',
      dateStr: '12:00',
      timestamp: 1700000
    },
    // 4. Outside interval (too early), closed
    {
      id: 'ord-4',
      description: 'Old order',
      price: 500,
      currency: '₽',
      buyerUsername: 'User4',
      buyerId: 104,
      chatId: 'chat-4',
      status: 'closed',
      dateStr: '08:00',
      timestamp: 500000
    },
    // 5. Outside interval (too late), closed
    {
      id: 'ord-5',
      description: 'Future order',
      price: 800,
      currency: '₽',
      buyerUsername: 'User5',
      buyerId: 105,
      chatId: 'chat-5',
      status: 'closed',
      dateStr: '14:00',
      timestamp: 2500000
    }
  ];

  const earnings = calculateShiftEarnings(shiftStart, shiftEnd, mockOrders, sellerPercent);

  assert.equal(earnings.ordersCount, 2); // 2 closed orders (1 RUB, 1 USD)
  assert.equal(earnings.refundedCount, 1); // 1 refunded order
  assert.deepEqual(earnings.orderIds, ['ord-1', 'ord-2', 'ord-3']);

  // Turnover: 1000 RUB, 50 USD
  assert.equal(earnings.turnoverByCurrency['₽'], 1000);
  assert.equal(earnings.turnoverByCurrency['$'], 50);

  // Seller share (70%): 700 RUB, 35 USD
  assert.equal(earnings.sellerShareByCurrency['₽'], 700);
  assert.equal(earnings.sellerShareByCurrency['$'], 35);

  // Refunded sums: 300 RUB
  assert.equal(earnings.refundedSumByCurrency['₽'], 300);
});

// 5. Tests for saveShift, deleteShift, and recalculateShifts
test('saveShift allows manual addition, update, and deleteShift removes record', async () => {
  setupChromeStorageMock();

  const customShift: CompletedShift = {
    id: 'manual-shift-1',
    startTime: 1700000000000,
    endTime: 1700028800000,
    duration: 28800000, // 8 hours
    operatorName: 'Оператор Максим',
    note: 'Ручная смена',
    earnings: {
      ordersCount: 2,
      turnoverByCurrency: { '₽': 1500 },
      sellerShareByCurrency: { '₽': 1500 },
      refundedCount: 0,
      refundedSumByCurrency: {},
      orderIds: ['ord-10', 'ord-11']
    }
  };

  // Add shift
  await saveShift(customShift);
  let history = await loadShiftHistory();
  assert.equal(history.length, 1);
  assert.equal(history[0].id, 'manual-shift-1');
  assert.equal(history[0].operatorName, 'Оператор Максим');

  // Update existing shift
  const updatedShift: CompletedShift = {
    ...customShift,
    operatorName: 'Оператор Максим (старший)',
    note: 'Обновленная смена'
  };
  await saveShift(updatedShift);
  history = await loadShiftHistory();
  assert.equal(history.length, 1);
  assert.equal(history[0].operatorName, 'Оператор Максим (старший)');
  assert.equal(history[0].note, 'Обновленная смена');

  // Delete shift
  await deleteShift('manual-shift-1');
  history = await loadShiftHistory();
  assert.equal(history.length, 0);
});

test('recalculateShifts updates earnings across all historical shifts using cached orders and percent', async () => {
  setupChromeStorageMock();

  // Create two shifts
  const shift1: CompletedShift = {
    id: 'shift-1',
    startTime: 1000,
    endTime: 2000,
    duration: 1000,
    operatorName: 'Алексей'
  } as CompletedShift;
  const shift2: CompletedShift = {
    id: 'shift-2',
    startTime: 3000,
    endTime: 4000,
    duration: 1000,
    operatorName: 'Иван'
  } as CompletedShift;

  await saveShift(shift1);
  await saveShift(shift2);

  const orders: FunPayOrder[] = [
    {
      id: 'o-1',
      description: 'Key',
      price: 200,
      currency: '₽',
      buyerUsername: 'B1',
      buyerId: 1,
      chatId: 'c1',
      status: 'closed',
      dateStr: '01:00',
      timestamp: 1500
    },
    {
      id: 'o-2',
      description: 'Account',
      price: 500,
      currency: '₽',
      buyerUsername: 'B2',
      buyerId: 2,
      chatId: 'c2',
      status: 'closed',
      dateStr: '02:00',
      timestamp: 3500
    }
  ];

  // Recalculate with 50% seller share
  const updated = await recalculateShifts(orders, 50);
  assert.equal(updated.length, 2);

  // Shift 2 (newest)
  const resShift2 = updated.find((s) => s.id === 'shift-2');
  assert.ok(resShift2);
  assert.equal(resShift2.earnings?.turnoverByCurrency['₽'], 500);
  assert.equal(resShift2.earnings?.sellerShareByCurrency['₽'], 250);

  // Shift 1
  const resShift1 = updated.find((s) => s.id === 'shift-1');
  assert.ok(resShift1);
  assert.equal(resShift1.earnings?.turnoverByCurrency['₽'], 200);
  assert.equal(resShift1.earnings?.sellerShareByCurrency['₽'], 100);
});

// 6. Protection tests against forgotten shifts and double start/stop
test('Protection against double start preserves original shiftStartTime', async () => {
  setupChromeStorageMock();

  // First start
  const first = await startShift('Иван', 'Первый запуск');
  assert.equal(first.shiftActive, true);
  const originalStartTime = first.shiftStartTime;
  assert.ok(typeof originalStartTime === 'number');

  // Small delay
  await new Promise((r) => setTimeout(r, 20));

  // Accidental second start call while already active
  const second = await startShift('Иван (повтор)', 'Случайный запуск');
  assert.equal(second.shiftActive, true);
  // Must preserve the original startTime:
  assert.equal(second.shiftStartTime, originalStartTime);

  // Stop shift
  const stopRes = await stopShift();
  assert.equal(stopRes.shiftState.shiftActive, false);
  assert.equal(stopRes.completedShift?.startTime, originalStartTime);

  // Redundant second stop does not create duplicate entries
  const redundantStop = await stopShift();
  assert.equal(redundantStop.completedShift, null);
  const history = await loadShiftHistory();
  assert.equal(history.length, 1);
});

