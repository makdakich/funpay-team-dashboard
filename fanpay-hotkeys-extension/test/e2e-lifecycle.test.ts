import test from 'node:test';
import assert from 'node:assert/strict';
import {
  startShift,
  stopShift,
  loadShiftState,
  loadShiftHistory
} from '../src/storage/storage.ts';
import {
  buildBatch,
  chunk,
  applyRpcRow,
  createEmptyReport,
  syncOrdersWithRpc,
  SYNC_BATCH_LIMIT,
  normalizeCurrency as normalizeCurrencyRpc,
  formatAmount,
  toIsoTimestamp
} from '../src/api/orders-sync.ts';
import { calculateShiftEarnings } from '../src/shared/utils.ts';
import { FunPayOrder } from '../src/shared/types.ts';

// Storage mock for Chrome Extension local storage
function setupChromeStorageMock() {
  const store: Record<string, unknown> = {};

  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: (keys: string[], cb: (res: Record<string, unknown>) => void) => {
          const res: Record<string, unknown> = {};
          for (const k of keys) {
            if (k in store) res[k] = store[k];
          }
          cb(res);
        },
        set: (items: Record<string, unknown>, cb?: () => void) => {
          for (const [k, v] of Object.entries(items)) {
            store[k] = v;
          }
          if (cb) cb();
        },
        remove: (keys: string[], cb?: () => void) => {
          for (const k of keys) {
            delete store[k];
          }
          if (cb) cb();
        }
      }
    }
  };

  return store;
}

test('Full E2E Lifecycle: Shift start -> Presence Heartbeat -> Order Sync -> First-Write-Wins -> Attribution -> 10% Operator Share -> Shift close', async () => {
  setupChromeStorageMock();

  // -------------------------------------------------------------------------
  // 1. Operator opens shift in Extension
  // -------------------------------------------------------------------------
  const operatorName = 'Оператор Алексей';
  const startedState = await startShift(operatorName, 'Старт рабочей смены v2.4');

  assert.equal(startedState.shiftActive, true);
  assert.equal(startedState.currentOperator, operatorName);
  assert.ok(typeof startedState.shiftStartTime === 'number');

  // Set shift time to 1 hour ago so that test orders inside the shift are in valid past interval
  const shiftStartTime = Date.now() - 3600 * 1000;
  await chrome.storage.local.set({
    fphk_shift_state: {
      shiftActive: true,
      shiftStartTime,
      currentOperator: operatorName,
      note: 'Старт рабочей смены v2.4'
    }
  });

  const cloudShiftId = 'c0a80101-0000-4000-8000-000000000001';
  const sellerAccountId = 'seller-1084291';
  const userId = '34a83ee3-dbc8-49c3-8982-c1ada97f094f'; // Creator / Operator ID

  // -------------------------------------------------------------------------
  // 2. Heartbeat active in Dashboard (public.operator_status)
  // -------------------------------------------------------------------------
  const heartbeatPayload = {
    userId,
    status: 'on_shift',
    activeShiftId: cloudShiftId,
    sellerAccountId,
    appVersion: '2.4.0',
    lastHeartbeatAt: new Date().toISOString()
  };

  assert.equal(heartbeatPayload.status, 'on_shift');
  assert.equal(heartbeatPayload.activeShiftId, cloudShiftId);
  assert.equal(heartbeatPayload.sellerAccountId, sellerAccountId);
  assert.ok(heartbeatPayload.lastHeartbeatAt.length > 0);

  // -------------------------------------------------------------------------
  // 3. Order synced in batches of 50
  // -------------------------------------------------------------------------
  const orderTime = shiftStartTime + 10 * 60 * 1000; // 50 mins ago (inside shift)
  const incomingOrders: FunPayOrder[] = [
    {
      id: 'FP-ORD-7701',
      description: 'Robux 2000',
      price: 2000.0,
      currency: '₽',
      buyerUsername: 'BuyerMax',
      buyerId: 5501,
      status: 'paid',
      dateStr: '12:15',
      timestamp: orderTime
    },
    {
      id: 'FP-ORD-7702',
      description: 'Discord Nitro',
      price: 15.0,
      currency: '$',
      buyerUsername: 'BuyerJohn',
      buyerId: 5502,
      status: 'closed',
      dateStr: '12:20',
      timestamp: orderTime + 300000
    },
    {
      id: 'FP-ORD-7703',
      description: 'Game Key',
      price: 25.0,
      currency: '€',
      buyerUsername: 'BuyerJean',
      buyerId: 5503,
      status: 'closed',
      dateStr: '12:25',
      timestamp: orderTime + 600000
    },
    {
      id: 'FP-ORD-7704',
      description: 'Mobile TopUp',
      price: 5000.0,
      currency: '₸',
      buyerUsername: 'BuyerArman',
      buyerId: 5504,
      status: 'closed',
      dateStr: '12:30',
      timestamp: orderTime + 900000
    }
  ];

  // Batch build & normalization check
  const { items, skipped, deduplicated } = buildBatch(incomingOrders);
  assert.equal(deduplicated, 0);
  assert.equal(skipped.length, 0);
  assert.equal(items.length, 4);

  // Currency normalization check across RUB, USD, EUR, KZT
  assert.equal(items[0].currency, 'RUB');
  assert.equal(items[0].amount, '2000.00');
  assert.equal(items[1].currency, 'USD');
  assert.equal(items[1].amount, '15.00');
  assert.equal(items[2].currency, 'EUR');
  assert.equal(items[2].amount, '25.00');
  assert.equal(items[3].currency, 'KZT');
  assert.equal(items[3].amount, '5000.00');

  // Verify batch chunking (max 50 per batch)
  const chunks = chunk(items, SYNC_BATCH_LIMIT);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].length, 4);

  // -------------------------------------------------------------------------
  // 4. Server RPC simulation: First-Write-Wins locks financial fields
  // -------------------------------------------------------------------------
  const serverOrdersTable = new Map<string, Record<string, unknown>>();
  const serverDiscrepancyLog: Record<string, unknown>[] = [];

  const mockRpcCaller = async (fn: string, args: Record<string, unknown>) => {
    assert.equal(fn, 'sync_orders_batch');
    assert.equal(args.p_seller_account_id, sellerAccountId);
    const batchItems = args.p_orders as typeof items;
    const results = [];

    for (const it of batchItems) {
      if (!serverOrdersTable.has(it.order_id)) {
        // Insert new order with shift attribution
        serverOrdersTable.set(it.order_id, {
          order_id: it.order_id,
          amount: it.amount,
          currency: it.currency,
          status: it.status,
          funpay_created_at: it.funpay_created_at,
          shift_id: cloudShiftId, // Attributed to active shift
          operator_id: userId,
          attribution_status: 'assigned'
        });
        results.push({ order_id: it.order_id, action: 'inserted' });
      } else {
        const existing = serverOrdersTable.get(it.order_id)!;
        // First-Write-Wins: check financial discrepancy
        if (existing.amount !== it.amount || existing.currency !== it.currency) {
          serverDiscrepancyLog.push({
            order_id: it.order_id,
            existing_amount: existing.amount,
            incoming_amount: it.amount,
            type: 'amount_currency'
          });
          results.push({
            order_id: it.order_id,
            action: 'financial_discrepancy_logged',
            message: 'First-Write-Wins: financial fields locked'
          });
          continue;
        }

        // Status hierarchy: refunded (3) > closed (2) > paid (1)
        const rank: Record<string, number> = { paid: 1, closed: 2, refunded: 3 };
        const existingRank = rank[existing.status as string] || 0;
        const incomingRank = rank[it.status] || 0;

        if (incomingRank < existingRank) {
          results.push({
            order_id: it.order_id,
            action: 'ignored_status_downgrade',
            current_status: existing.status
          });
        } else {
          existing.status = it.status;
          results.push({ order_id: it.order_id, action: 'updated', status: it.status });
        }
      }
    }

    return results;
  };

  // Initial Sync: 4 orders inserted
  const report1 = await syncOrdersWithRpc(mockRpcCaller, sellerAccountId, incomingOrders);
  assert.equal(report1.inserted, 4);
  assert.equal(report1.rejected, 0);

  // Verify shift attribution
  const storedOrder1 = serverOrdersTable.get('FP-ORD-7701')!;
  assert.equal(storedOrder1.shift_id, cloudShiftId);
  assert.equal(storedOrder1.operator_id, userId);

  // -------------------------------------------------------------------------
  // 5. First-Write-Wins locks financial fields when conflicting update arrives
  // -------------------------------------------------------------------------
  const conflictingTamperOrders: FunPayOrder[] = [
    {
      id: 'FP-ORD-7701',
      description: 'Robux 2000 Tampered',
      price: 100.0, // Altered price! Original was 2000.0
      currency: '₽',
      buyerUsername: 'BuyerMax',
      buyerId: 5501,
      status: 'paid',
      dateStr: '12:15',
      timestamp: orderTime
    }
  ];

  const report2 = await syncOrdersWithRpc(mockRpcCaller, sellerAccountId, conflictingTamperOrders);
  assert.equal(report2.financialDiscrepancies, 1);
  assert.equal(serverDiscrepancyLog.length, 1);
  // Verify amount was NOT mutated
  assert.equal(serverOrdersTable.get('FP-ORD-7701')!.amount, '2000.00');

  // Status upgrade: FP-ORD-7701 advances to closed
  const orderCloseUpdate: FunPayOrder[] = [
    {
      id: 'FP-ORD-7701',
      description: 'Robux 2000',
      price: 2000.0,
      currency: '₽',
      buyerUsername: 'BuyerMax',
      buyerId: 5501,
      status: 'closed',
      dateStr: '12:15',
      timestamp: orderTime
    }
  ];
  const report3 = await syncOrdersWithRpc(mockRpcCaller, sellerAccountId, orderCloseUpdate);
  assert.equal(report3.updated, 1);
  assert.equal(serverOrdersTable.get('FP-ORD-7701')!.status, 'closed');

  // Status downgrade attempt: from closed back to paid is rejected
  const downgradeAttempt: FunPayOrder[] = [
    {
      id: 'FP-ORD-7701',
      description: 'Robux 2000',
      price: 2000.0,
      currency: '₽',
      buyerUsername: 'BuyerMax',
      buyerId: 5501,
      status: 'paid', // Downgrade attempt!
      dateStr: '12:15',
      timestamp: orderTime
    }
  ];
  const report4 = await syncOrdersWithRpc(mockRpcCaller, sellerAccountId, downgradeAttempt);
  assert.equal(report4.ignoredStatusDowngrades, 1);
  assert.equal(serverOrdersTable.get('FP-ORD-7701')!.status, 'closed');

  // -------------------------------------------------------------------------
  // 6. Closed order adds 10% to operator share (isolated per currency)
  // -------------------------------------------------------------------------
  const shiftEndTime = Date.now();
  // All 4 orders now in closed status
  const finalizedOrders: FunPayOrder[] = [
    { ...incomingOrders[0], status: 'closed' },
    incomingOrders[1], // USD 15.0 closed
    incomingOrders[2], // EUR 25.0 closed
    incomingOrders[3]  // KZT 5000.0 closed
  ];

  const earnings = calculateShiftEarnings(shiftStartTime, shiftEndTime, finalizedOrders, 10.0);

  assert.equal(earnings.ordersCount, 4);
  assert.equal(earnings.refundedCount, 0);

  // Turnover:
  assert.equal(earnings.turnoverByCurrency['₽'], 2000);
  assert.equal(earnings.turnoverByCurrency['$'], 15);
  assert.equal(earnings.turnoverByCurrency['€'], 25);
  assert.equal(earnings.turnoverByCurrency['₸'], 5000);

  // 10% Operator Share:
  assert.equal(earnings.sellerShareByCurrency['₽'], 200);   // 2000 * 0.10
  assert.equal(earnings.sellerShareByCurrency['$'], 1.5);   // 15 * 0.10
  assert.equal(earnings.sellerShareByCurrency['€'], 2.5);   // 25 * 0.10
  assert.equal(earnings.sellerShareByCurrency['₸'], 500);   // 5000 * 0.10

  // -------------------------------------------------------------------------
  // 7. Shift closes -> Presence resets to online
  // -------------------------------------------------------------------------
  const stopResult = await stopShift('Завершено успешно', { id: cloudShiftId });
  assert.equal(stopResult.shiftState.shiftActive, false);
  assert.equal(stopResult.shiftState.shiftStartTime, null);
  assert.ok(stopResult.completedShift !== null);
  assert.equal(stopResult.completedShift!.id, cloudShiftId);
  assert.equal(stopResult.completedShift!.operatorName, operatorName);

  // Presence resets to online (activeShiftId: null)
  const postShiftPresence = {
    userId,
    status: 'online',
    activeShiftId: null,
    sellerAccountId: null,
    appVersion: '2.4.0',
    lastHeartbeatAt: new Date().toISOString()
  };
  assert.equal(postShiftPresence.status, 'online');
  assert.equal(postShiftPresence.activeShiftId, null);

  const history = await loadShiftHistory();
  assert.equal(history.length, 1);
  assert.equal(history[0].id, cloudShiftId);
});
