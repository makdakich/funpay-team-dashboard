import { describe, expect, it } from 'vitest';
import {
  aggregateClosedOrders,
  computeDateRange,
  computeExecutiveKpis,
  formatCurrencyTotals,
  generateBuckets,
  generateSvgChart,
  selectAxisTicks
} from './metrics';
import type { OverviewOrderPoint } from '@/types/database';

describe('overview financial metrics', () => {
  it('keeps the four currencies isolated and computes ten percent independently', () => {
    const metrics = aggregateClosedOrders([
      { amount: '100.00', currency: 'RUB' },
      { amount: '12.50', currency: 'USD' },
      { amount: '7.25', currency: 'EUR' },
      { amount: '250.00', currency: 'KZT' }
    ]);

    expect(metrics.count).toBe(4);
    expect(metrics.turnoverByCurrency).toEqual({ RUB: 100, USD: 12.5, EUR: 7.25, KZT: 250 });
    expect(metrics.operatorShareByCurrency).toEqual({ RUB: 10, USD: 1.25, EUR: 0.73, KZT: 25 });
    expect(formatCurrencyTotals(metrics.turnoverByCurrency)).toContain('100,00');
  });

  it('returns zero totals for an empty result without fabricating orders', () => {
    const metrics = aggregateClosedOrders([]);
    expect(metrics.count).toBe(0);
    expect(metrics.turnoverByCurrency.RUB).toBe(0);
    expect(metrics.operatorShareByCurrency.RUB).toBe(0);
  });

  it('computes executive KPIs matching extension cards (today, 7d, refunds)', () => {
    const ref = new Date('2026-11-12T12:00:00Z').getTime();
    const mockOrders: OverviewOrderPoint[] = [
      {
        orderId: '1',
        amount: 2500,
        currency: 'RUB',
        status: 'closed',
        timestamp: new Date('2026-11-12T10:00:00Z').getTime(),
        funpayCreatedAt: '2026-11-12T10:00:00Z'
      },
      {
        orderId: '2',
        amount: 1500,
        currency: 'RUB',
        status: 'closed',
        timestamp: new Date('2026-11-10T10:00:00Z').getTime(),
        funpayCreatedAt: '2026-11-10T10:00:00Z'
      },
      {
        orderId: '3',
        amount: 500,
        currency: 'RUB',
        status: 'refunded',
        timestamp: new Date('2026-11-09T10:00:00Z').getTime(),
        funpayCreatedAt: '2026-11-09T10:00:00Z'
      },
      {
        orderId: '4',
        amount: 50,
        currency: 'USD',
        status: 'closed',
        timestamp: new Date('2026-11-12T10:00:00Z').getTime(),
        funpayCreatedAt: '2026-11-12T10:00:00Z'
      }
    ];

    const rubKpi = computeExecutiveKpis(mockOrders, 'RUB', 10, ref);
    expect(rubKpi.todayTurnover).toBe(2500);
    expect(rubKpi.todayOrdersCount).toBe(1);
    expect(rubKpi.todayCleanShare).toBe(250);
    expect(rubKpi.last7DaysTurnover).toBe(4000);
    expect(rubKpi.last7DaysOrdersCount).toBe(2);
    expect(rubKpi.last7DaysAvgCheck).toBe(2000);
    expect(rubKpi.successfulOrdersCount).toBe(2);
    expect(rubKpi.refundedOrdersCount).toBe(1);
    expect(rubKpi.successRatePercent).toBe(67);
  });

  it('computes date ranges for standard periods', () => {
    const ref = new Date('2026-11-12T12:00:00Z').getTime();
    const range7 = computeDateRange('7', [], ref);
    expect(range7.isValid).toBe(true);
    expect(range7.label).toContain('7 дней');

    const range30 = computeDateRange('30', [], ref);
    expect(range30.isValid).toBe(true);
    expect(range30.label).toContain('30 дней');
  });

  it('generates chart buckets and renders SVG chart with smooth spline and area fill', () => {
    const start = new Date('2026-11-06T00:00:00Z').getTime();
    const end = new Date('2026-11-12T23:59:59Z').getTime();
    const mockOrders: OverviewOrderPoint[] = [
      {
        orderId: '1',
        amount: 1000,
        currency: 'RUB',
        status: 'closed',
        timestamp: new Date('2026-11-08T12:00:00Z').getTime(),
        funpayCreatedAt: '2026-11-08T12:00:00Z'
      }
    ];

    const buckets = generateBuckets(mockOrders, start, end, 'days', 'RUB', 10);
    expect(buckets.length).toBeGreaterThan(0);

    const svg = generateSvgChart(buckets, 'turnover', 'RUB', 860, 260);
    expect(svg).toContain('<svg');
    expect(svg).toContain('class="chart-line-path"');
    expect(svg).toContain('class="chart-area-path"');
    expect(svg).toContain('class="chart-point-group"');
  });

  it('selects adaptive axis ticks without overflowing', () => {
    const dummyBuckets: any[] = Array.from({ length: 30 }, (_, i) => ({ label: `d${i}` }));
    const ticks = selectAxisTicks(dummyBuckets, 7);
    expect(ticks.length).toBeLessThanOrEqual(7);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBe(29);
  });
});
