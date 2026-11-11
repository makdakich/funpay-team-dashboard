import type { ClosedOrderAmount, CurrencyTotals } from '@/types/database';
import { CURRENCIES, CURRENCY_SYMBOLS, addAmountCents, centsToTotals, emptyCents, formatCurrency, formatCurrencyTotals, shareCents } from '@/lib/money';

export { CURRENCIES, CURRENCY_SYMBOLS, formatCurrency, formatCurrencyTotals };

export interface FinancialMetrics {
  count: number;
  turnoverByCurrency: CurrencyTotals;
  operatorShareByCurrency: CurrencyTotals;
}

export function aggregateClosedOrders(rows: readonly ClosedOrderAmount[]): FinancialMetrics {
  const cents = emptyCents();

  for (const row of rows) {
    addAmountCents(cents, row.amount, row.currency);
  }

  return {
    count: rows.length,
    turnoverByCurrency: centsToTotals(cents),
    operatorShareByCurrency: centsToTotals(shareCents(cents))
  };
}
