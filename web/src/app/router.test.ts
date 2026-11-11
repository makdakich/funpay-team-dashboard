import { describe, expect, it } from 'vitest';
import { buildHref, getDashboardRoute, getRouteTitle, parseRoute, routeKey } from './router';

describe('hash routes', () => {
  it.each([
    ['#/overview', 'overview'],
    ['#/team', 'team'],
    ['#/team/members', 'team'],
    ['#/shifts', 'shifts'],
    ['#/orders', 'orders'],
    ['#/finance', 'finance'],
    ['#/orders?status=closed', 'orders'],
    ['#unknown', 'overview'],
    ['', 'overview']
  ] as const)('resolves %s to %s', (hash, route) => {
    expect(getDashboardRoute(hash)).toBe(route);
  });

  it('exposes route segments for deep links', () => {
    expect(parseRoute('#/shifts/363b47af-e8bf-4474-b2ee-ccba1ed2fe5f').segments).toEqual(['363b47af-e8bf-4474-b2ee-ccba1ed2fe5f']);
    expect(parseRoute('#/orders/SELLER_MAIN/ORD%201').segments).toEqual(['SELLER_MAIN', 'ORD 1']);
  });

  it('parses query parameters without breaking the route', () => {
    const target = parseRoute('#/orders?page=3&status=closed&search=ORD');
    expect(target.route).toBe('orders');
    expect(target.params.get('page')).toBe('3');
    expect(target.params.get('status')).toBe('closed');
    expect(target.params.get('search')).toBe('ORD');
  });

  it('builds encoded links back', () => {
    expect(buildHref('orders', ['SELLER_MAIN', 'ORD 1'])).toBe('#/orders/SELLER_MAIN/ORD%201');
    expect(buildHref('finance')).toBe('#/finance');
    expect(buildHref('orders', [], { page: 2, search: '' })).toBe('#/orders?page=2');
  });

  it('keeps a stable key for the current target', () => {
    expect(routeKey(parseRoute('#/orders?page=2'))).toBe('orders?page=2');
    expect(routeKey(parseRoute('#/shifts/abc'))).toBe('shifts/abc');
  });

  it('provides a title for each implemented route', () => {
    expect(getRouteTitle('overview')).toBe('Обзор');
    expect(getRouteTitle('team')).toBe('Команда');
    expect(getRouteTitle('shifts')).toBe('История смен');
    expect(getRouteTitle('orders')).toBe('Заказы');
    expect(getRouteTitle('finance')).toBe('Финансы');
  });
});
