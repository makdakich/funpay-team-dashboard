import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ORDER_QUERY,
  buildSearchFilter,
  hasActiveFilters,
  orderQueryFromParams,
  orderQueryToParams,
  resolveDateBounds,
  sanitizeSearchTerm
} from './filters';

describe('order search sanitising', () => {
  it('removes characters that break PostgREST filter grammar', () => {
    expect(sanitizeSearchTerm('ORD-1,(x)%*"\\')).toBe('ORD-1 x');
  });

  it('keeps cyrillic names and collapses spaces', () => {
    expect(sanitizeSearchTerm('  Иван    Петров ')).toBe('Иван Петров');
  });

  it('returns no filter for a blank term so the query stays untouched', () => {
    expect(buildSearchFilter('   ')).toBeNull();
    expect(buildSearchFilter(',,,,')).toBeNull();
  });

  it('searches order id, buyer username and buyer id', () => {
    expect(buildSearchFilter('101')).toBe(
      'order_id.ilike.%101%,buyer_username.ilike.%101%,buyer_id.ilike.%101%'
    );
  });
});

describe('order date bounds', () => {
  it('uses a half-open interval in local time', () => {
    const bounds = resolveDateBounds({ from: '2026-11-01', to: '2026-11-01' });
    expect(bounds.fromIso).toBe(new Date(2026, 10, 1).toISOString());
    expect(bounds.toIso).toBe(new Date(2026, 10, 2).toISOString());
  });

  it('ignores empty or malformed dates', () => {
    expect(resolveDateBounds({ from: '', to: '' })).toEqual({ fromIso: null, toIso: null });
    expect(resolveDateBounds({ from: 'not-a-date', to: '' }).fromIso).toBeNull();
  });
});

describe('order query <-> hash params', () => {
  it('drops default values from the hash', () => {
    expect(orderQueryToParams(DEFAULT_ORDER_QUERY)).toEqual({});
  });

  it('serialises active filters and page', () => {
    const params = orderQueryToParams({
      ...DEFAULT_ORDER_QUERY,
      status: 'closed',
      currency: 'RUB',
      search: 'Robux',
      operatorId: 'u-1',
      sellerAccountId: 'SELLER_MAIN',
      page: 3,
      pageSize: 25,
      sortBy: 'amount',
      sortDirection: 'asc'
    });
    expect(params).toEqual({
      search: 'Robux',
      operator: 'u-1',
      shop: 'SELLER_MAIN',
      status: 'closed',
      currency: 'RUB',
      sort: 'amount',
      dir: 'asc',
      page: '3',
      size: '25'
    });
  });

  it('round trips through URLSearchParams', () => {
    const source = { ...DEFAULT_ORDER_QUERY, status: 'refunded' as const, currency: 'USD' as const, page: 2, from: '2026-11-01', to: '2026-11-05' };
    const restored = orderQueryFromParams(new URLSearchParams(orderQueryToParams(source)));
    expect(restored).toEqual(source);
  });

  it('guards against unknown values coming from the URL', () => {
    const query = orderQueryFromParams(new URLSearchParams('status=weird&currency=BTC&sort=drop&dir=sideways&page=-4&size=999'));
    expect(query.status).toBe('');
    expect(query.currency).toBe('');
    expect(query.sortBy).toBe('funpay_created_at');
    expect(query.sortDirection).toBe('desc');
    expect(query.page).toBe(1);
    expect(query.pageSize).toBe(50);
  });

  it('detects active filters for the empty state copy', () => {
    expect(hasActiveFilters(DEFAULT_ORDER_QUERY)).toBe(false);
    expect(hasActiveFilters({ ...DEFAULT_ORDER_QUERY, status: 'paid' })).toBe(true);
  });
});
