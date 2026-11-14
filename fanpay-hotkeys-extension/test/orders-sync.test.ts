import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCurrency,
  formatAmount,
  toIsoTimestamp,
  mapOrderToBatchItem,
  buildBatch,
  chunk,
  applyRpcRow,
  createEmptyReport,
  syncOrdersWithRpc,
  SYNC_BATCH_LIMIT,
  RpcOrderResult
} from '../src/api/orders-sync.ts';
import { DEFAULT_SUPABASE_CONFIG, SupabaseClient } from '../src/api/supabase.ts';
import {
  isSessionExpired,
  saveAuthSession,
  loadAuthSession,
  clearAuthSession,
  loadFreshSession,
  saveCloudCredentials
} from '../src/api/auth.ts';
import { FunPayOrder, CloudAuthSession } from '../src/shared/types.ts';

// ---------------------------------------------------------------------------
// 1. Currency Normalization Tests
// ---------------------------------------------------------------------------
test('normalizeCurrency handles symbols, abbreviations, and casing for all supported currencies', () => {
  // RUB
  assert.equal(normalizeCurrency('₽'), 'RUB');
  assert.equal(normalizeCurrency('руб'), 'RUB');
  assert.equal(normalizeCurrency('руб.'), 'RUB');
  assert.equal(normalizeCurrency('rub'), 'RUB');
  assert.equal(normalizeCurrency('RUB'), 'RUB');
  assert.equal(normalizeCurrency('rur'), 'RUB');

  // USD
  assert.equal(normalizeCurrency('$'), 'USD');
  assert.equal(normalizeCurrency('usd'), 'USD');
  assert.equal(normalizeCurrency('USD'), 'USD');
  assert.equal(normalizeCurrency('долл'), 'USD');
  assert.equal(normalizeCurrency('долл.'), 'USD');

  // EUR
  assert.equal(normalizeCurrency('€'), 'EUR');
  assert.equal(normalizeCurrency('eur'), 'EUR');
  assert.equal(normalizeCurrency('EUR'), 'EUR');
  assert.equal(normalizeCurrency('евро'), 'EUR');

  // KZT
  assert.equal(normalizeCurrency('₸'), 'KZT');
  assert.equal(normalizeCurrency('kzt'), 'KZT');
  assert.equal(normalizeCurrency('KZT'), 'KZT');
  assert.equal(normalizeCurrency('тенге'), 'KZT');
  assert.equal(normalizeCurrency('тг'), 'KZT');
  assert.equal(normalizeCurrency('тнг'), 'KZT');

  // Unsupported or invalid
  assert.equal(normalizeCurrency('GBP'), null);
  assert.equal(normalizeCurrency('BTC'), null);
  assert.equal(normalizeCurrency(''), null);
  assert.equal(normalizeCurrency(null), null);
  assert.equal(normalizeCurrency(undefined), null);
});

// ---------------------------------------------------------------------------
// 2. Amount Formatting and Boundary Tests
// ---------------------------------------------------------------------------
test('formatAmount enforces regex ^[0-9]+(\\.[0-9]{1,2})?$ and bounds (0 < amount <= 99999999.99)', () => {
  // Valid amounts
  assert.equal(formatAmount(100), '100.00');
  assert.equal(formatAmount(15.5), '15.50');
  assert.equal(formatAmount(0.01), '0.01');
  assert.equal(formatAmount(99999999.99), '99999999.99');
  assert.equal(formatAmount(12345.67), '12345.67');

  // Invalid / out-of-bounds amounts
  assert.equal(formatAmount(0), null);
  assert.equal(formatAmount(-5), null);
  assert.equal(formatAmount(-0.01), null);
  assert.equal(formatAmount(100000000), null);
  assert.equal(formatAmount(NaN), null);
  assert.equal(formatAmount(Infinity), null);
  assert.equal(formatAmount(-Infinity), null);
  assert.equal(formatAmount(null), null);
  assert.equal(formatAmount(undefined), null);
});

// ---------------------------------------------------------------------------
// 3. ISO Timestamp Parsing and Boundary Tests
// ---------------------------------------------------------------------------
test('toIsoTimestamp validates dates within [2020-01-01, now + 15m]', () => {
  const validMs = Date.parse('2024-06-15T10:30:00.000Z');
  assert.equal(toIsoTimestamp(validMs), '2024-06-15T10:30:00.000Z');

  // Before 2020
  const ancientMs = Date.parse('2019-12-31T23:59:59.000Z');
  assert.equal(toIsoTimestamp(ancientMs), null);

  // Far future (beyond 15 minutes ahead)
  const farFutureMs = Date.now() + 2 * 3600 * 1000;
  assert.equal(toIsoTimestamp(farFutureMs), null);

  // Near future (within 5 minutes ahead) is valid
  const nearFutureMs = Date.now() + 5 * 60 * 1000;
  assert.ok(toIsoTimestamp(nearFutureMs) !== null);

  // Non-numeric / NaN
  assert.equal(toIsoTimestamp(NaN), null);
  assert.equal(toIsoTimestamp(null), null);
  assert.equal(toIsoTimestamp(undefined), null);
});

// ---------------------------------------------------------------------------
// 4. Batch Mapping and Deduplication Tests
// ---------------------------------------------------------------------------
test('buildBatch deduplicates orders by order ID using status rank hierarchy and handles invalid orders', () => {
  const now = Date.now();
  const sampleOrders: FunPayOrder[] = [
    // Order 1: Paid initially
    {
      id: 'ORD-101',
      buyer: 'Buyer1',
      buyerId: 'B-1',
      itemTitle: 'Item A',
      price: 150.00,
      currency: '₽',
      status: 'paid',
      timestamp: now - 3600000
    },
    // Order 1 duplicate with higher status: Closed
    {
      id: 'ORD-101',
      buyer: 'Buyer1',
      buyerId: 'B-1',
      itemTitle: 'Item A',
      price: 150.00,
      currency: '₽',
      status: 'closed',
      timestamp: now - 3600000
    },
    // Order 2: Closed initially
    {
      id: 'ORD-102',
      buyer: 'Buyer2',
      buyerId: 'B-2',
      itemTitle: 'Item B',
      price: 25.00,
      currency: '$',
      status: 'closed',
      timestamp: now - 1800000
    },
    // Order 2 duplicate with downgrade attempt: Paid (must be ignored, keep Closed)
    {
      id: 'ORD-102',
      buyer: 'Buyer2',
      buyerId: 'B-2',
      itemTitle: 'Item B',
      price: 25.00,
      currency: '$',
      status: 'paid',
      timestamp: now - 1800000
    },
    // Order 3: Duplicate with Refunded status (highest rank)
    {
      id: 'ORD-103',
      buyer: 'Buyer3',
      buyerId: 'B-3',
      itemTitle: 'Item C',
      price: 500,
      currency: '₸',
      status: 'paid',
      timestamp: now - 900000
    },
    {
      id: 'ORD-103',
      buyer: 'Buyer3',
      buyerId: 'B-3',
      itemTitle: 'Item C',
      price: 500,
      currency: '₸',
      status: 'refunded',
      timestamp: now - 900000
    },
    // Order 4: Invalid price (0) -> should be skipped locally
    {
      id: 'ORD-INVALID-PRICE',
      buyer: 'Buyer4',
      buyerId: 'B-4',
      itemTitle: 'Zero Item',
      price: 0,
      currency: '₽',
      status: 'closed',
      timestamp: now - 500000
    },
    // Order 5: Unsupported currency (GBP) -> should be skipped locally
    {
      id: 'ORD-INVALID-CURR',
      buyer: 'Buyer5',
      buyerId: 'B-5',
      itemTitle: 'GBP Item',
      price: 50,
      currency: 'GBP',
      status: 'closed',
      timestamp: now - 400000
    }
  ];

  const result = buildBatch(sampleOrders);

  // Check deduplication count: ORD-101 (+1), ORD-102 (+1), ORD-103 (+1) = 3 duplicates
  assert.equal(result.deduplicated, 3);

  // Check valid items: ORD-101, ORD-102, ORD-103
  assert.equal(result.items.length, 3);

  const ord101 = result.items.find(i => i.order_id === 'ORD-101');
  assert.ok(ord101);
  assert.equal(ord101.status, 'closed'); // Upgraded from paid to closed
  assert.equal(ord101.currency, 'RUB');
  assert.equal(ord101.amount, '150.00');

  const ord102 = result.items.find(i => i.order_id === 'ORD-102');
  assert.ok(ord102);
  assert.equal(ord102.status, 'closed'); // Kept closed despite downgrade
  assert.equal(ord102.currency, 'USD');
  assert.equal(ord102.amount, '25.00');

  const ord103 = result.items.find(i => i.order_id === 'ORD-103');
  assert.ok(ord103);
  assert.equal(ord103.status, 'refunded'); // Upgraded from paid to refunded
  assert.equal(ord103.currency, 'KZT');
  assert.equal(ord103.amount, '500.00');

  // Check skipped items: ORD-INVALID-PRICE, ORD-INVALID-CURR
  assert.equal(result.skipped.length, 2);
  assert.ok(result.skipped.some(s => s.orderId === 'ORD-INVALID-PRICE'));
  assert.ok(result.skipped.some(s => s.orderId === 'ORD-INVALID-CURR'));
});

// ---------------------------------------------------------------------------
// 5. Chunking Tests
// ---------------------------------------------------------------------------
test('chunk splits items into batches of SYNC_BATCH_LIMIT (50)', () => {
  const items = Array.from({ length: 125 }, (_, i) => `item-${i}`);
  const chunks = chunk(items, SYNC_BATCH_LIMIT);

  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].length, 50);
  assert.equal(chunks[1].length, 50);
  assert.equal(chunks[2].length, 25);
});

// ---------------------------------------------------------------------------
// 6. RPC Result Aggregation Tests
// ---------------------------------------------------------------------------
test('applyRpcRow tracks inserted, updated, discrepancies, and errors properly', () => {
  const report = createEmptyReport('seller-123');

  applyRpcRow(report, { order_id: 'O-1', action: 'inserted' });
  applyRpcRow(report, { order_id: 'O-2', action: 'updated' });
  applyRpcRow(report, { order_id: 'O-3', action: 'financial_discrepancy_logged' });
  applyRpcRow(report, { order_id: 'O-4', action: 'created_at_discrepancy_logged' });
  applyRpcRow(report, { order_id: 'O-5', action: 'ignored_status_downgrade' });
  applyRpcRow(report, { order_id: 'O-6', action: 'error', message: 'invalid currency' });

  assert.equal(report.inserted, 1);
  assert.equal(report.updated, 1);
  assert.equal(report.financialDiscrepancies, 1);
  assert.equal(report.createdTimeDiscrepancies, 1);
  assert.equal(report.ignoredStatusDowngrades, 1);
  assert.equal(report.rejected, 1);
  assert.equal(report.errors.length, 1);
  assert.match(report.errors[0], /invalid currency/);
});

// ---------------------------------------------------------------------------
// 7. syncOrdersWithRpc: Network Retry and Resilience Tests
// ---------------------------------------------------------------------------
test('syncOrdersWithRpc retries on transient network errors and succeeds upon retry', async () => {
  const now = Date.now();
  const orders: FunPayOrder[] = [
    { id: 'ORD-RETRY-1', buyer: 'Buyer', buyerId: '1', itemTitle: 'Item', price: 100, currency: '₽', status: 'closed', timestamp: now - 1000 }
  ];

  let attemptCount = 0;
  const mockRpc = async (_fn: string, _args: Record<string, unknown>) => {
    attemptCount += 1;
    if (attemptCount === 1) {
      throw new Error('Нет связи с Supabase: Failed to fetch (transient network error)');
    }
    return [
      { order_id: 'ORD-RETRY-1', action: 'inserted' }
    ];
  };

  const report = await syncOrdersWithRpc(mockRpc, 'seller-shop-1', orders, { maxRetries: 2, retryDelayMs: 20 });

  assert.equal(attemptCount, 2);
  assert.equal(report.sentOrders, 1);
  assert.equal(report.inserted, 1);
  assert.equal(report.errors.length, 0);
});

test('syncOrdersWithRpc exhausts retries on permanent network outage without crashing', async () => {
  const now = Date.now();
  const orders: FunPayOrder[] = [
    { id: 'ORD-FAIL-1', buyer: 'Buyer', buyerId: '1', itemTitle: 'Item', price: 100, currency: '₽', status: 'closed', timestamp: now - 1000 }
  ];

  let attemptCount = 0;
  const mockRpc = async () => {
    attemptCount += 1;
    throw new Error('Нет связи с Supabase: Network timeout');
  };

  const report = await syncOrdersWithRpc(mockRpc, 'seller-shop-1', orders, { maxRetries: 2, retryDelayMs: 10 });

  assert.equal(attemptCount, 3); // initial + 2 retries
  assert.equal(report.sentOrders, 0);
  assert.equal(report.errors.length, 1);
  assert.match(report.errors[0], /Network timeout/);
});

test('syncOrdersWithRpc does not retry on 401/403/400 fatal errors', async () => {
  const now = Date.now();
  const orders: FunPayOrder[] = [
    { id: 'ORD-AUTH-1', buyer: 'Buyer', buyerId: '1', itemTitle: 'Item', price: 100, currency: '₽', status: 'closed', timestamp: now - 1000 }
  ];

  let attemptCount = 0;
  const mockRpc = async () => {
    attemptCount += 1;
    throw new Error('HTTP 401: Нет прав на операцию в облаке');
  };

  const report = await syncOrdersWithRpc(mockRpc, 'seller-shop-1', orders, { maxRetries: 3, retryDelayMs: 10 });

  assert.equal(attemptCount, 1); // Immediate stop without useless retries
  assert.equal(report.errors.length, 1);
  assert.match(report.errors[0], /401/);
});

// ---------------------------------------------------------------------------
// 8. Authentication and Session Storage Tests
// ---------------------------------------------------------------------------
test('Supabase session expiry check and session storage work correctly', async () => {
  // Mock chrome storage
  const mockStore: Record<string, unknown> = {};
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: (keys: string[], cb?: (res: Record<string, unknown>) => void) => {
          const res: Record<string, unknown> = {};
          for (const k of keys) {
            if (k in mockStore) res[k] = mockStore[k];
          }
          if (typeof cb === 'function') cb(res);
          return Promise.resolve(res);
        },
        set: (items: Record<string, unknown>, cb?: () => void) => {
          Object.assign(mockStore, items);
          if (typeof cb === 'function') cb();
          return Promise.resolve();
        },
        remove: (keys: string[], cb?: () => void) => {
          for (const k of keys) delete mockStore[k];
          if (typeof cb === 'function') cb();
          return Promise.resolve();
        }
      }
    }
  };

  const validSession: CloudAuthSession = {
    accessToken: 'valid-jwt-token',
    refreshToken: 'valid-refresh-token',
    expiresAt: Date.now() + 3600000, // 1 hour ahead
    userId: 'user-uuid-1',
    email: 'operator@funpay.local',
    savedAt: Date.now()
  };

  assert.equal(isSessionExpired(validSession), false);

  const expiredSession: CloudAuthSession = {
    accessToken: 'expired-jwt-token',
    refreshToken: 'expired-refresh-token',
    expiresAt: Date.now() - 10000, // Already expired
    userId: 'user-uuid-1',
    savedAt: Date.now() - 3600000
  };

  assert.equal(isSessionExpired(expiredSession), true);

  // Persist session
  await saveAuthSession(validSession);
  const loaded = await loadAuthSession();
  assert.deepEqual(loaded, validSession);

  // Clear session
  await clearAuthSession();
  const cleared = await loadAuthSession();
  assert.equal(cleared, null);
});

test('loadFreshSession returns unexpired session without fetch and deduplicates concurrent calls', async () => {
  const validSession: CloudAuthSession = {
    accessToken: 'valid-jwt-token',
    refreshToken: 'valid-refresh-token',
    expiresAt: Date.now() + 3600000,
    userId: 'user-uuid-1',
    email: 'operator@funpay.local',
    savedAt: Date.now()
  };
  await saveAuthSession(validSession);

  let fetchCallCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCallCount++;
    return new Response(JSON.stringify({}), { status: 200 });
  }) as typeof fetch;

  try {
    const [res1, res2] = await Promise.all([
      loadFreshSession('https://test.supabase.co', 'test-key'),
      loadFreshSession('https://test.supabase.co', 'test-key')
    ]);
    assert.deepEqual(res1, validSession);
    assert.deepEqual(res2, validSession);
    assert.equal(fetchCallCount, 0, 'No network requests when session is valid');
  } finally {
    globalThis.fetch = originalFetch;
    await clearAuthSession();
  }
});

test('loadFreshSession silently falls back to stored credentials when refresh token is fatal/expired', async () => {
  const expiredSession: CloudAuthSession = {
    accessToken: 'expired-jwt',
    refreshToken: 'dead-refresh-token',
    expiresAt: Date.now() - 5000,
    userId: 'user-uuid-1',
    email: 'operator@funpay.local',
    savedAt: Date.now() - 3600000
  };
  await saveAuthSession(expiredSession);
  await saveCloudCredentials({ email: 'operator@funpay.local', password: 'secretpassword' });

  const originalFetch = globalThis.fetch;
  const requests: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);

    if (url.includes('grant_type=refresh_token')) {
      // Simulating GoTrue error on expired/revoked refresh token
      return new Response(
        JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid Refresh Token: Refresh Token Not Found' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (url.includes('grant_type=password')) {
      return new Response(
        JSON.stringify({
          access_token: 'new-fresh-access-token',
          refresh_token: 'new-fresh-refresh-token',
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          user: { id: 'user-uuid-1', email: 'operator@funpay.local' }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response('Not found', { status: 404 });
  }) as typeof fetch;

  try {
    const session = await loadFreshSession('https://test.supabase.co', 'test-key');
    assert.ok(session);
    assert.equal(session.accessToken, 'new-fresh-access-token');
    assert.equal(session.refreshToken, 'new-fresh-refresh-token');
    assert.equal(isSessionExpired(session), false);

    assert.ok(requests.some(u => u.includes('grant_type=refresh_token')), 'Tried refresh token first');
    assert.ok(requests.some(u => u.includes('grant_type=password')), 'Fell back to password re-auth');

    // Stored session updated
    const persisted = await loadAuthSession();
    assert.equal(persisted?.accessToken, 'new-fresh-access-token');
  } finally {
    globalThis.fetch = originalFetch;
    await clearAuthSession();
    await saveCloudCredentials(null);
  }
});

// ---------------------------------------------------------------------------
// 9. Zero Administrative Secrets in Bundle Verification
// ---------------------------------------------------------------------------
test('Ensure DEFAULT_SUPABASE_CONFIG only packs anonymous publishable key, never service_role', () => {
  assert.ok(DEFAULT_SUPABASE_CONFIG.anonKey);
  assert.match(DEFAULT_SUPABASE_CONFIG.anonKey, /^sb_publishable_/);
  assert.doesNotMatch(DEFAULT_SUPABASE_CONFIG.anonKey, /service_role/i);
  assert.doesNotMatch(DEFAULT_SUPABASE_CONFIG.anonKey, /secret/i);
});
