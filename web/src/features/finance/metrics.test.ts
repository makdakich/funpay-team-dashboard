import { describe, expect, it } from 'vitest';
import { analyzeFinance, type FinanceOrderRow } from './metrics';

function row(partial: Partial<FinanceOrderRow>): FinanceOrderRow {
  return {
    seller_account_id: 'SELLER_MAIN',
    order_id: 'ORD',
    amount: '100.00',
    currency: 'RUB',
    status: 'closed',
    operator_id: 'op-1',
    attribution_status: 'assigned',
    funpay_created_at: '2026-11-10T05:31:59.865Z',
    ...partial
  };
}

describe('finance analysis', () => {
  it('keeps the four currencies strictly separate', () => {
    const analysis = analyzeFinance([
      row({ order_id: 'A', amount: '1000.00', currency: 'RUB' }),
      row({ order_id: 'B', amount: '10.00', currency: 'USD' }),
      row({ order_id: 'C', amount: '5.00', currency: 'EUR' }),
      row({ order_id: 'D', amount: '2000.00', currency: 'KZT' })
    ]);

    expect(analysis.turnover).toEqual({ RUB: 1000, USD: 10, EUR: 5, KZT: 2000 });
    expect(analysis.share).toEqual({ RUB: 100, USD: 1, EUR: 0.5, KZT: 200 });
    expect(analysis.byCurrency.map(entry => [entry.currency, entry.turnover])).toEqual([
      ['RUB', 1000],
      ['USD', 10],
      ['EUR', 5],
      ['KZT', 2000]
    ]);
  });

  it('excludes paid and refunded orders without subtracting refunds twice', () => {
    const analysis = analyzeFinance([
      row({ order_id: 'A', amount: '500.00', status: 'closed' }),
      row({ order_id: 'B', amount: '400.00', status: 'paid' }),
      row({ order_id: 'C', amount: '500.00', status: 'refunded' })
    ]);

    expect(analysis.closedCount).toBe(1);
    expect(analysis.turnover.RUB).toBe(500);
    expect(analysis.share.RUB).toBe(50);
  });

  it('still credits unassigned orders to the team cash box with no operator share', () => {
    const analysis = analyzeFinance([
      row({ order_id: 'A', amount: '300.00', operator_id: null, attribution_status: 'unassigned' }),
      row({ order_id: 'B', amount: '100.00', operator_id: 'op-1' })
    ]);

    expect(analysis.turnover.RUB).toBe(400);
    expect(analysis.share.RUB).toBe(40);
    expect(analysis.unlinkedCount).toBe(1);
    const unassigned = analysis.byOperator.find(group => group.key === '__unassigned__');
    expect(unassigned?.count).toBe(1);
    expect(unassigned?.turnover.RUB).toBe(300);
    expect(analysis.byOperator.find(group => group.key === 'op-1')?.share.RUB).toBe(10);
  });

  it('reports ambiguous and manual attributions instead of hiding them', () => {
    const analysis = analyzeFinance([
      row({ order_id: 'A', operator_id: null, attribution_status: 'ambiguous' }),
      row({ order_id: 'B', operator_id: 'op-2', attribution_status: 'manual' })
    ]);

    expect(analysis.ambiguousCount).toBe(1);
    expect(analysis.manualCount).toBe(1);
    expect(analysis.unlinkedCount).toBe(1);
  });

  it('groups turnover by operator and by shop', () => {
    const analysis = analyzeFinance([
      row({ order_id: 'A', operator_id: 'op-1', amount: '100.00' }),
      row({ order_id: 'B', operator_id: 'op-1', amount: '50.00' }),
      row({ order_id: 'C', operator_id: 'op-2', amount: '25.00' }),
      row({ order_id: 'D', operator_id: 'op-1', seller_account_id: 'SELLER_ALT', amount: '75.00' })
    ], { operatorNames: new Map([['op-1', 'Иван'], ['op-2', 'Пётр']]) });

    expect(analysis.byOperator.map(group => [group.label, group.count, group.turnover.RUB])).toEqual([
      ['Иван', 3, 225],
      ['Пётр', 1, 25]
    ]);
    expect(analysis.byShop.map(group => [group.key, group.turnover.RUB])).toEqual([
      ['SELLER_MAIN', 175],
      ['SELLER_ALT', 75]
    ]);
  });

  it('builds a daily series for every day of the requested period', () => {
    const analysis = analyzeFinance([
      row({ order_id: 'A', amount: '100.00', funpay_created_at: new Date(2026, 10, 10, 12).toISOString() }),
      row({ order_id: 'B', amount: '200.00', funpay_created_at: new Date(2026, 10, 12, 9).toISOString() })
    ], { dayKeys: ['2026-11-10', '2026-11-11', '2026-11-12'] });

    expect(analysis.daily.map(point => [point.dateKey, point.turnover.RUB, point.count])).toEqual([
      ['2026-11-10', 100, 1],
      ['2026-11-11', 0, 0],
      ['2026-11-12', 200, 1]
    ]);
  });

  it('rounds the ten percent share per currency', () => {
    const analysis = analyzeFinance([
      row({ order_id: 'A', amount: '7.25', currency: 'EUR' }),
      row({ order_id: 'B', amount: '12.50', currency: 'USD' })
    ]);
    expect(analysis.byCurrency.find(entry => entry.currency === 'EUR')?.share).toBe(0.73);
    expect(analysis.byCurrency.find(entry => entry.currency === 'USD')?.share).toBe(1.25);
  });

  it('returns honest zeros for an empty dataset', () => {
    const analysis = analyzeFinance([]);
    expect(analysis.closedCount).toBe(0);
    expect(analysis.turnover).toEqual({ RUB: 0, USD: 0, EUR: 0, KZT: 0 });
    expect(analysis.byOperator).toEqual([]);
    expect(analysis.byShop).toEqual([]);
    expect(analysis.byCurrency).toHaveLength(4);
  });
});
