import { describe, expect, it } from 'vitest';
import { createFakeDb, findCall } from '@/test-utils/fake-db';
import type { Order } from '@/types/database';
import { loadOrder, loadOrderAudit, loadOrders, reassignOrderOperator } from './data';
import { DEFAULT_ORDER_QUERY, UNASSIGNED_OPERATOR } from './filters';

const ORDER: Order = {
  seller_account_id: 'SELLER_MAIN',
  order_id: 'TEST_ORD_001',
  buyer_id: 'BUYER_101',
  buyer_username: 'ClientAlpha',
  title: 'Robux 1000',
  description: null,
  subcategory: 'Robux',
  amount: '1500.00',
  currency: 'RUB',
  status: 'closed',
  funpay_created_at: '2026-11-10T05:31:59.865Z',
  operator_id: '34a83ee3-dbc8-49c3-8982-c1ada97f094f',
  shift_id: '363b47af-e8bf-4474-b2ee-ccba1ed2fe5f',
  attribution_status: 'assigned',
  attribution_source: 'automatic',
  synced_by_user_id: '34a83ee3-dbc8-49c3-8982-c1ada97f094f',
  last_synced_at: '2026-11-10T05:32:00.000Z',
  created_at: '2026-11-10T05:32:00.000Z',
  updated_at: '2026-11-10T05:32:00.000Z'
};

describe('loadOrders', () => {
  it('applies every filter to the server query and only fetches one page', async () => {
    const db = createFakeDb({ orders: { data: [ORDER], error: null, count: 1 } });
    const result = await loadOrders({
      ...DEFAULT_ORDER_QUERY,
      sellerAccountId: 'SELLER_MAIN',
      operatorId: 'u-1',
      status: 'closed',
      currency: 'RUB',
      search: 'Client',
      from: '2026-11-01',
      to: '2026-11-02',
      pageSize: 25
    }, db.client);

    const calls = db.tableCalls('orders');
    expect(findCall(calls, 'eq')?.args).toEqual(['seller_account_id', 'SELLER_MAIN']);
    expect(calls.filter(call => call.method === 'eq').map(call => call.args[0])).toEqual([
      'seller_account_id', 'operator_id', 'status', 'currency'
    ]);
    expect(findCall(calls, 'gte')?.args).toEqual(['funpay_created_at', new Date(2026, 10, 1).toISOString()]);
    expect(findCall(calls, 'lt')?.args).toEqual(['funpay_created_at', new Date(2026, 10, 3).toISOString()]);
    expect(findCall(calls, 'or')?.args[0]).toContain('buyer_username.ilike.%Client%');
    expect(calls.filter(call => call.method === 'order').map(call => call.args)).toEqual([
      ['funpay_created_at', { ascending: false }],
      ['order_id', { ascending: true }]
    ]);
    expect(findCall(calls, 'range')?.args).toEqual([0, 24]);
    expect(result.total).toBe(1);
    expect(result.pages).toBe(1);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].order_id).toBe('TEST_ORD_001');
  });

  it('maps the unassigned filter to a null check instead of an equality', async () => {
    const db = createFakeDb({ orders: { data: [], error: null, count: 0 } });
    await loadOrders({ ...DEFAULT_ORDER_QUERY, operatorId: UNASSIGNED_OPERATOR }, db.client);

    const calls = db.tableCalls('orders');
    expect(findCall(calls, 'is')?.args).toEqual(['operator_id', null]);
    expect(calls.filter(call => call.method === 'eq')).toHaveLength(0);
  });

  it('requests the correct server window for a later page', async () => {
    const db = createFakeDb({ orders: { data: [], error: null, count: 500 } });
    const result = await loadOrders({ ...DEFAULT_ORDER_QUERY, page: 3, pageSize: 50 }, db.client);

    expect(findCall(db.tableCalls('orders'), 'range')?.args).toEqual([100, 149]);
    expect(result.page).toBe(3);
    expect(result.pages).toBe(10);
  });

  it('re-fetches the last existing page when the requested page is out of range', async () => {
    const db = createFakeDb({ orders: { data: [ORDER], error: null, count: 10 } });
    const result = await loadOrders({ ...DEFAULT_ORDER_QUERY, page: 5, pageSize: 50 }, db.client);

    expect(db.tableCalls('orders').filter(call => call.method === 'range').map(call => call.args)).toEqual([
      [200, 249],
      [0, 49]
    ]);
    expect(result.clamped).toBe(true);
    expect(result.page).toBe(1);
  });

  it('returns an empty page without inventing rows', async () => {
    const db = createFakeDb({ orders: { data: [], error: null, count: 0 } });
    const result = await loadOrders(DEFAULT_ORDER_QUERY, db.client);
    expect(result.rows).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.pages).toBe(1);
  });

  it('propagates Supabase errors instead of hiding them', async () => {
    const db = createFakeDb({ orders: { data: null, error: { message: 'permission denied' }, count: null } });
    await expect(loadOrders(DEFAULT_ORDER_QUERY, db.client)).rejects.toEqual({ message: 'permission denied' });
  });
});

describe('order detail and audit', () => {
  it('loads a single order by its composite key', async () => {
    const db = createFakeDb({ orders: { data: ORDER, error: null } });
    const order = await loadOrder('SELLER_MAIN', 'TEST_ORD_001', db.client);
    expect(order?.order_id).toBe('TEST_ORD_001');
    expect(db.tableCalls('orders').filter(call => call.method === 'eq').map(call => call.args)).toEqual([
      ['seller_account_id', 'SELLER_MAIN'],
      ['order_id', 'TEST_ORD_001']
    ]);
  });

  it('returns null when the order is not visible or missing', async () => {
    const db = createFakeDb({ orders: { data: null, error: null } });
    expect(await loadOrder('SELLER_MAIN', 'nope', db.client)).toBeNull();
  });

  it('reads the audit trail newest first', async () => {
    const db = createFakeDb({ order_audit_logs: { data: [{ id: 'a' }], error: null } });
    const logs = await loadOrderAudit('SELLER_MAIN', 'TEST_ORD_001', db.client);

    const calls = db.tableCalls('order_audit_logs');
    expect(calls.filter(call => call.method === 'eq').map(call => call.args)).toEqual([
      ['seller_account_id', 'SELLER_MAIN'],
      ['order_id', 'TEST_ORD_001']
    ]);
    expect(findCall(calls, 'order')?.args).toEqual(['created_at', { ascending: false }]);
    expect(logs).toHaveLength(1);
  });
});

describe('reassignOrderOperator', () => {
  it('calls the RPC with the exact parameter names and a trimmed reason', async () => {
    const db = createFakeDb();
    await reassignOrderOperator({
      sellerAccountId: 'SELLER_MAIN',
      orderId: 'TEST_ORD_001',
      newOperatorId: '34a83ee3-dbc8-49c3-8982-c1ada97f094f',
      reason: '  ошибочная автоматическая привязка  '
    }, db.client);

    expect(db.rpcCalls).toEqual([{
      name: 'reassign_order_operator',
      args: {
        p_seller_account_id: 'SELLER_MAIN',
        p_order_id: 'TEST_ORD_001',
        p_new_operator_id: '34a83ee3-dbc8-49c3-8982-c1ada97f094f',
        p_reason: 'ошибочная автоматическая привязка'
      }
    }]);
  });

  it('supports clearing the operator when the order must leave every shift', async () => {
    const db = createFakeDb();
    await reassignOrderOperator({ sellerAccountId: 'SELLER_MAIN', orderId: 'TEST_ORD_001', newOperatorId: null, reason: 'заказ вне смены' }, db.client);
    expect(db.rpcCalls[0].args.p_new_operator_id).toBeNull();
  });

  it('refuses an empty reason before touching the database', async () => {
    const db = createFakeDb();
    await expect(reassignOrderOperator({ sellerAccountId: 'SELLER_MAIN', orderId: 'X', newOperatorId: null, reason: '   ' }, db.client))
      .rejects.toThrow(/причину/);
    expect(db.rpcCalls).toHaveLength(0);
  });

  it('surfaces RPC failures', async () => {
    const db = createFakeDb();
    db.setRpcResponse({ data: null, error: { message: 'Необходимо указать причину' } });
    await expect(reassignOrderOperator({ sellerAccountId: 'SELLER_MAIN', orderId: 'X', newOperatorId: null, reason: 'причина' }, db.client))
      .rejects.toEqual({ message: 'Необходимо указать причину' });
  });
});
