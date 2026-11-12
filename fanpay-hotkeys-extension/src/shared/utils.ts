import {
  ClientSummary,
  CurrencyStats,
  DashboardStats,
  FunPayOrder,
  PeriodMultiCurrencyStats,
  ShiftEarnings
} from './types';
import {
  getUserStartOfDaysAgo,
  getUserStartOfToday
} from './datetime';

/**
 * Standardize currency symbol
 */
export function normalizeCurrency(curr: string): string {
  if (!curr) return '₽';
  const clean = curr.trim().toUpperCase();
  if (clean === 'RUB' || clean === '₽') return '₽';
  if (clean === 'USD' || clean === '$') return '$';
  if (clean === 'EUR' || clean === '€') return '€';
  return curr.trim();
}

/**
 * Format currency amount with thousands separator
 */
export function formatMoney(amount: number | null | undefined, currency: string = '₽'): string {
  if (amount === null || amount === undefined || isNaN(amount)) return `— ${currency}`;
  const rounded = Math.round(amount * 100) / 100;
  const parts = rounded.toFixed(rounded % 1 === 0 ? 0 : 2).split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const norm = normalizeCurrency(currency);
  return `${parts.join('.')} ${norm}`;
}

/**
 * Safe variable replacement in message templates.
 * Replaces known variables like {username}, {order_id}, etc.
 * If variable is unknown or null/undefined, it is safely left as empty.
 * Never inserts "undefined" or "null".
 */
export function substituteVariables(template: string, vars: Record<string, string | null | undefined>): string {
  if (!template) return '';
  return template.replace(/\{([a-zA-Z0-9_-]+)\}/g, (match, varName) => {
    const key = varName.toLowerCase();
    const val = vars[key];
    if (val !== undefined && val !== null && val !== '') {
      return String(val);
    }
    return '';
  });
}

/**
 * Calculate isolated multi-currency statistics for a slice of orders
 * Currencies are calculated completely separately without artificial summation.
 * Refunded orders are tracked separately and not counted into successful turnover.
 */
export function calculatePeriodMultiCurrencyStats(
  orders: FunPayOrder[],
  sellerSharePercent: number,
  knownCurrencies: string[] = []
): PeriodMultiCurrencyStats {
  const currencies: Record<string, CurrencyStats> = {};
  const allUniqueClients = new Set<number>();
  let totalOrdersCount = 0;
  let totalRefundedCount = 0;

  for (const c of knownCurrencies) {
    const norm = normalizeCurrency(c);
    if (!currencies[norm]) {
      currencies[norm] = {
        currency: norm,
        turnover: 0,
        sellerShare: 0,
        ordersCount: 0,
        refundedCount: 0,
        refundedSum: 0,
        uniqueClientsCount: 0,
        averageOrderSum: 0
      };
    }
  }

  for (const o of orders) {
    const curr = normalizeCurrency(o.currency || '₽');
    if (!currencies[curr]) {
      currencies[curr] = {
        currency: curr,
        turnover: 0,
        sellerShare: 0,
        ordersCount: 0,
        refundedCount: 0,
        refundedSum: 0,
        uniqueClientsCount: 0,
        averageOrderSum: 0
      };
    }

    const cStat = currencies[curr];

    if (o.status === 'refunded') {
      cStat.refundedCount += 1;
      if (o.price !== null) {
        cStat.refundedSum += o.price;
      }
      totalRefundedCount += 1;
    } else if (o.status === 'paid' || o.status === 'closed') {
      // Successful or in-progress order (paid, closed)
      if (o.price !== null) {
        cStat.turnover += o.price;
      }
      cStat.ordersCount += 1;
      totalOrdersCount += 1;
      if (o.buyerId) {
        allUniqueClients.add(o.buyerId);
      }
    } else {
      // Unrecognized or unknown status:
      // Excluded from turnover and successful order count to prevent false revenue metrics
    }
  }

  // Calculate unique buyers per currency & seller share
  for (const curr of Object.keys(currencies)) {
    const cStat = currencies[curr];
    cStat.sellerShare = cStat.turnover * (sellerSharePercent / 100);
    cStat.averageOrderSum = cStat.ordersCount > 0 ? cStat.turnover / cStat.ordersCount : 0;

    const currencyBuyers = new Set(
      orders
        .filter(o => normalizeCurrency(o.currency) === curr && (o.status === 'paid' || o.status === 'closed') && o.buyerId)
        .map(o => o.buyerId)
    );
    cStat.uniqueClientsCount = currencyBuyers.size;
  }

  return {
    currencies,
    totalOrdersCount,
    totalRefundedCount,
    uniqueClientsCount: allUniqueClients.size
  };
}

/**
 * Calculate complete dashboard statistics across user local periods
 */
export function calculateDashboardStats(
  orders: FunPayOrder[],
  sellerSharePercent: number,
  balances: Record<string, number> = {},
  primaryCurrency: string = '₽',
  lastSync: number | null = null,
  referenceTime: number = Date.now()
): DashboardStats {
  const normPrimary = normalizeCurrency(primaryCurrency);
  const known = Array.from(new Set([
    normPrimary,
    ...Object.keys(balances).map(normalizeCurrency),
    ...orders.map(o => normalizeCurrency(o.currency))
  ]));

  const startToday = getUserStartOfToday(referenceTime);
  const start7Days = getUserStartOfDaysAgo(7, referenceTime);
  const start30Days = getUserStartOfDaysAgo(30, referenceTime);
  const start90Days = getUserStartOfDaysAgo(90, referenceTime);

  const todayOrders = orders.filter(o => o.timestamp >= startToday);
  const last7Orders = orders.filter(o => o.timestamp >= start7Days);
  const last30Orders = orders.filter(o => o.timestamp >= start30Days);
  const last90Orders = orders.filter(o => o.timestamp >= start90Days);

  return {
    today: calculatePeriodMultiCurrencyStats(todayOrders, sellerSharePercent, known),
    last7Days: calculatePeriodMultiCurrencyStats(last7Orders, sellerSharePercent, known),
    last30Days: calculatePeriodMultiCurrencyStats(last30Orders, sellerSharePercent, known),
    last90Days: calculatePeriodMultiCurrencyStats(last90Orders, sellerSharePercent, known),
    allTime: calculatePeriodMultiCurrencyStats(orders, sellerSharePercent, known),
    sellerSharePercent,
    balances,
    primaryCurrency: normPrimary,
    lastSync
  };
}

/**
 * Group orders by client strictly using buyerId as primary identity
 */
export function aggregateClients(orders: FunPayOrder[]): ClientSummary[] {
  const map = new Map<number, ClientSummary>();

  for (const o of orders) {
    const id = o.buyerId || 0;
    let item = map.get(id);
    if (!item) {
      item = {
        buyerId: id,
        buyerUsername: o.buyerUsername || `Покупатель ${id}`,
        ordersCount: 0,
        spentByCurrency: {},
        refundedCount: 0,
        lastOrderDate: o.dateStr,
        lastOrderTimestamp: o.timestamp,
        orderIds: []
      };
      map.set(id, item);
    }

    // Keep freshest username seen for this buyer ID
    if (o.buyerUsername && o.timestamp >= item.lastOrderTimestamp) {
      item.buyerUsername = o.buyerUsername;
    }

    const curr = normalizeCurrency(o.currency || '₽');

    if (o.status === 'refunded') {
      item.refundedCount += 1;
    } else if (o.status === 'paid' || o.status === 'closed') {
      item.ordersCount += 1;
      if (o.price !== null) {
        item.spentByCurrency[curr] = (item.spentByCurrency[curr] || 0) + o.price;
      }
    }

    item.orderIds.push(o.id);
    if (o.timestamp > item.lastOrderTimestamp) {
      item.lastOrderTimestamp = o.timestamp;
      item.lastOrderDate = o.dateStr;
    }
  }

  return Array.from(map.values()).sort((a, b) => b.ordersCount - a.ordersCount);
}

/**
 * Safe logger for Developer Mode.
 * NEVER prints golden_key, phpsessid, or authentication tokens.
 */
export function debugLog(devMode: boolean, message: string, ...args: unknown[]) {
  if (!devMode) return;
  const sanitizedArgs = args.map(arg => {
    if (typeof arg === 'string') {
      if (arg.length > 15 && /^[a-zA-Z0-9_-]{16,}$/.test(arg)) {
        return '[REDACTED_CREDENTIAL]';
      }
    }
    return arg;
  });
  console.log(`[FunPay Assistant Debug ${new Date().toLocaleTimeString()}]: ${message}`, ...sanitizedArgs);
}

/**
 * Calculate financial earnings, turnover, and order metrics for a work shift interval.
 * Isolates currencies (₽, $, €, ₸) and excludes refunded orders from turnover.
 */
export function calculateShiftEarnings(
  startTime: number,
  endTime: number,
  orders: FunPayOrder[],
  sellerSharePercent: number
): ShiftEarnings {
  const turnoverByCurrency: Record<string, number> = {};
  const sellerShareByCurrency: Record<string, number> = {};
  const refundedSumByCurrency: Record<string, number> = {};
  let ordersCount = 0;
  let refundedCount = 0;
  const orderIds: string[] = [];

  const shiftOrders = orders.filter(o => o.timestamp >= startTime && o.timestamp <= endTime);

  for (const o of shiftOrders) {
    orderIds.push(o.id);
    const curr = normalizeCurrency(o.currency || '₽');
    const price = o.price || 0;

    if (o.status === 'refunded') {
      refundedCount += 1;
      refundedSumByCurrency[curr] = (refundedSumByCurrency[curr] || 0) + price;
    } else if (o.status === 'paid' || o.status === 'closed') {
      ordersCount += 1;
      turnoverByCurrency[curr] = (turnoverByCurrency[curr] || 0) + price;
      const share = price * (sellerSharePercent / 100);
      sellerShareByCurrency[curr] = (sellerShareByCurrency[curr] || 0) + share;
    }
  }

  // Round values
  for (const curr of Object.keys(turnoverByCurrency)) {
    turnoverByCurrency[curr] = Math.round(turnoverByCurrency[curr] * 100) / 100;
  }
  for (const curr of Object.keys(sellerShareByCurrency)) {
    sellerShareByCurrency[curr] = Math.round(sellerShareByCurrency[curr] * 100) / 100;
  }
  for (const curr of Object.keys(refundedSumByCurrency)) {
    refundedSumByCurrency[curr] = Math.round(refundedSumByCurrency[curr] * 100) / 100;
  }

  return {
    ordersCount,
    turnoverByCurrency,
    sellerShareByCurrency,
    refundedCount,
    refundedSumByCurrency,
    orderIds
  };
}

/**
 * Generate an RFC 4122 v4 UUID.
 * The v2.4 backend keys shifts by a real UUID, so locally created identifiers must be valid.
 */
export function generateUuid(): string {
  const globalCrypto: Crypto | undefined = typeof crypto !== 'undefined' ? crypto : undefined;

  if (globalCrypto && typeof globalCrypto.randomUUID === 'function') {
    return globalCrypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (globalCrypto && typeof globalCrypto.getRandomValues === 'function') {
    globalCrypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex: string[] = [];
  for (let i = 0; i < bytes.length; i += 1) {
    hex.push((bytes[i] + 0x100).toString(16).slice(1));
  }

  return (
    hex.slice(0, 4).join('') + '-' +
    hex.slice(4, 6).join('') + '-' +
    hex.slice(6, 8).join('') + '-' +
    hex.slice(8, 10).join('') + '-' +
    hex.slice(10, 16).join('')
  );
}
