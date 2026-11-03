import { FunPayAccountInfo } from '../../shared/types';

/**
 * Centralized selectors for FunPay Account & User Profile parsing
 */
export const ACCOUNT_SELECTORS = {
  // Username displayed in user profile link
  username: /class=["'][^"']*user-link-name[^"']*["'][^>]*>([^<]+)<\/div>/i,
  // User ID and configuration in body attribute
  appData: /<body[^>]*data-app-data=["']([^"']+)["']/i,
  // Counter badge for active sales
  salesBadge: /class=["'][^"']*badge-trade[^"']*["'][^>]*>(\d+)<\/span>/i,
  // Counter badge for active purchases
  purchasesBadge: /class=["'][^"']*badge-orders[^"']*["'][^>]*>(\d+)<\/span>/i
};

/**
 * Account / Profile Adapter
 * Data source: HTML parsing of https://funpay.com/
 * Mechanism: Extracts username, userId, active sales counters from DOM and data-app-data attribute.
 */
export class FunPayAccountAdapter {
  /**
   * Parse profile details from raw HTML of funpay.com
   */
  public static parse(html: string): Omit<FunPayAccountInfo, 'totalBalance' | 'currency' | 'balancesByCurrency'> | null {
    if (!html) return null;

    // 1. Extract Username from .user-link-name
    const usernameMatch = html.match(ACCOUNT_SELECTORS.username);
    const username = usernameMatch ? usernameMatch[1].trim() : null;

    // 2. Extract internal JSON configuration from data-app-data
    let userId = 0;
    let csrfToken = '';
    let locale = 'ru';

    const appDataMatch = html.match(ACCOUNT_SELECTORS.appData);
    if (appDataMatch && appDataMatch[1]) {
      try {
        const decoded = appDataMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
        const parsed = JSON.parse(decoded);
        userId = Number(parsed.userId || 0);
        csrfToken = parsed['csrf-token'] || '';
        locale = parsed.locale || 'ru';
      } catch {
        // ignore JSON parsing issues
      }
    }

    // If neither username nor userId is detected, the user is unauthenticated
    if (!username && userId === 0) {
      return null;
    }

    // 3. Count of active sales from badge-trade
    let activeSales = 0;
    const salesMatch = html.match(ACCOUNT_SELECTORS.salesBadge);
    if (salesMatch && salesMatch[1]) {
      activeSales = parseInt(salesMatch[1], 10);
    }

    // 4. Count of active purchases from badge-orders
    let activePurchases = 0;
    const purchasesMatch = html.match(ACCOUNT_SELECTORS.purchasesBadge);
    if (purchasesMatch && purchasesMatch[1]) {
      activePurchases = parseInt(purchasesMatch[1], 10);
    }

    return {
      userId,
      username: username || `Пользователь #${userId}`,
      activeSales,
      activePurchases,
      csrfToken,
      locale,
      lastUpdated: Date.now()
    };
  }
}
