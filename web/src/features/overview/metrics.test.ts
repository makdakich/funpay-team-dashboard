import { describe, expect, it } from 'vitest';
import { aggregateClosedOrders, formatCurrencyTotals } from './metrics';

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
});
