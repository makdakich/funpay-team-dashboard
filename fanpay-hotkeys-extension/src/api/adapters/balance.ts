import { normalizeCurrency } from '../../shared/utils';

export interface FunPayBalanceResult {
  totalBalance: number;
  currency: string;
  balancesByCurrency: Record<string, number>;
}

/**
 * Centralized selectors for FunPay Balance parsing
 */
export const BALANCE_SELECTORS = {
  // Balance badge on main header: <span class="badge badge-balance">1 450 ₽</span>
  badge: /class=["'][^"']*badge-balance[^"']*["'][^>]*>([^<]+)<\/span>/i
};

/**
 * Balance Adapter
 * Data source: HTML parsing of real balance badge on https://funpay.com/
 * Rule: Balance is NEVER calculated from order history. It is directly read from the FunPay DOM.
 */
export class FunPayBalanceAdapter {
  /**
   * Parse balance badge from FunPay HTML
   */
  public static parse(html: string): FunPayBalanceResult {
    const balancesByCurrency: Record<string, number> = {};
    let totalBalance = 0;
    let currency = '₽';

    const balanceMatch = html.match(BALANCE_SELECTORS.badge);
    if (balanceMatch && balanceMatch[1]) {
      const rawText = balanceMatch[1].trim(); // e.g. "1 450 ₽" or "100.50 $"
      const tokens = rawText.split(/\s+/);

      if (tokens.length >= 2) {
        const rawCurr = tokens[tokens.length - 1];
        currency = normalizeCurrency(rawCurr);
        const numPart = tokens.slice(0, tokens.length - 1).join('').replace(',', '.');
        totalBalance = parseFloat(numPart) || 0;
      } else {
        totalBalance = parseFloat(rawText.replace(',', '.')) || 0;
      }

      balancesByCurrency[currency] = totalBalance;
    }

    return {
      totalBalance,
      currency,
      balancesByCurrency
    };
  }
}
