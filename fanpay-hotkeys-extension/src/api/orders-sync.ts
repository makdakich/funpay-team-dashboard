/**
 * Adapter between the local FunPay order cache and the v2.4 RPC `sync_orders_batch`.
 *
 * The server contract (008_rpc_functions.sql) is strict:
 *   - at most 50 orders per call;
 *   - `amount` is a string matching ^[0-9]+(\.[0-9]{1,2})?$ with 0 < amount <= 99999999.99;
 *   - `currency` is one of RUB, USD, EUR, KZT (never a FunPay symbol);
 *   - `status` is one of paid, closed, refunded;
 *   - `funpay_created_at` is an ISO timestamp between 2020-01-01 and now + 15 minutes.
 * Anything that cannot be normalized is dropped locally and reported, because sending it
 * would only produce an `error` row from the server.
 */

import { FunPayOrder, OrderSyncReport } from '../shared/types';

export const SYNC_BATCH_LIMIT = 50;
export const MAX_AMOUNT = 99999999.99;
export const AMOUNT_PATTERN = /^[0-9]+(\.[0-9]{1,2})?$/;

/** FunPay renders prices with currency symbols; the database stores ISO codes only. */
const CURRENCY_SYMBOL_MAP: Record<string, string> = {
  '₽': 'RUB',
  'руб': 'RUB',
  'руб.': 'RUB',
  'rub': 'RUB',
  'rur': 'RUB',
  '$': 'USD',
  'usd': 'USD',
  'долл': 'USD',
  'долл.': 'USD',
  '€': 'EUR',
  'eur': 'EUR',
  'евро': 'EUR',
  '₸': 'KZT',
  'kzt': 'KZT',
  'тенге': 'KZT',
  'тг': 'KZT',
  'тнг': 'KZT'
};

export interface SyncOrdersBatchItem {
  order_id: string;
  amount: string;
  currency: string;
  status: string;
  funpay_created_at: string;
  buyer_id: string | null;
  buyer_username: string | null;
  title: string | null;
  description: string | null;
  subcategory: string | null;
}

export interface RpcOrderResult {
  order_id?: string;
  action?: string;
  message?: string;
  status?: string;
  attribution?: string;
  current_status?: string;
}

const STATUS_RANK: Record<string, number> = { paid: 1, closed: 2, refunded: 3 };

/** Map a FunPay currency symbol or code onto the ISO code accepted by the RPC. */
export function normalizeCurrency(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  return CURRENCY_SYMBOL_MAP[key] || CURRENCY_SYMBOL_MAP[raw.trim()] || null;
}

/** Render a numeric price as the exact decimal string the RPC regex expects. */
export function formatAmount(price: number | null | undefined): string | null {
  if (price === null || price === undefined || !Number.isFinite(price)) return null;
  if (price <= 0 || price > MAX_AMOUNT) return null;
  const formatted = price.toFixed(2);
  return AMOUNT_PATTERN.test(formatted) ? formatted : null;
}

/** Convert a local millisecond timestamp into an ISO string accepted by the RPC. */
export function toIsoTimestamp(timestamp: number | null | undefined): string | null {
  if (!timestamp || !Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  const ms = date.getTime();
  if (Number.isNaN(ms)) return null;
  if (ms < Date.parse('2020-01-01T00:00:00.000Z')) return null;
  if (ms > Date.now() + 15 * 60 * 1000) return null;
  return date.toISOString();
}

function truncate(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

export interface OrderMapOutcome {
  item?: SyncOrdersBatchItem;
  reason?: string;
}

/** Map one locally cached order onto the RPC payload row. */
export function mapOrderToBatchItem(order: FunPayOrder): OrderMapOutcome {
  const orderId = truncate(order?.id, 64);
  if (!orderId) {
    return { reason: 'Отсутствует номер заказа' };
  }

  const status = (order.status || '').toString().trim().toLowerCase();
  if (!STATUS_RANK[status]) {
    return { reason: `Неподдерживаемый статус заказа: ${order.status || 'пусто'}` };
  }

  const amount = formatAmount(order.price);
  if (!amount) {
    return { reason: order.price === null ? 'Не удалось распознать сумму заказа' : 'Сумма заказа вне допустимых границ' };
  }

  const currency = normalizeCurrency(order.currency);
  if (!currency) {
    return { reason: `Неизвестная валюта: ${order.currency || 'пусто'}` };
  }

  const createdAt = toIsoTimestamp(order.timestamp);
  if (!createdAt) {
    return { reason: 'Некорректная дата создания заказа' };
  }

  const buyerId = order.buyerId === null || order.buyerId === undefined ? null : String(order.buyerId);

  return {
    item: {
      order_id: orderId,
      amount,
      currency,
      status,
      funpay_created_at: createdAt,
      buyer_id: truncate(buyerId, 64),
      buyer_username: truncate(order.buyerUsername, 100),
      title: truncate(order.description, 255),
      description: truncate(order.description, 1000),
      subcategory: truncate(order.category, 100)
    }
  };
}

export interface BatchBuildResult {
  items: SyncOrdersBatchItem[];
  skipped: { orderId: string; reason: string }[];
  deduplicated: number;
}

/**
 * Normalize a cached order list into RPC rows.
 * Duplicate order IDs are collapsed to the most advanced status, since a repeated order
 * with a lower status would be rejected by the server status hierarchy anyway.
 */
export function buildBatch(orders: FunPayOrder[]): BatchBuildResult {
  const byId = new Map<string, FunPayOrder>();
  let deduplicated = 0;

  for (const order of orders || []) {
    const id = truncate(order?.id, 64);
    if (!id) continue;
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, order);
      continue;
    }
    deduplicated += 1;
    const existingRank = STATUS_RANK[(existing.status || '').toLowerCase()] || 0;
    const incomingRank = STATUS_RANK[(order.status || '').toLowerCase()] || 0;
    const keepIncoming = incomingRank > existingRank
      || (incomingRank === existingRank && existing.price === null && order.price !== null);
    if (keepIncoming) {
      byId.set(id, order);
    }
  }

  const items: SyncOrdersBatchItem[] = [];
  const skipped: { orderId: string; reason: string }[] = [];

  for (const [id, order] of byId) {
    const outcome = mapOrderToBatchItem(order);
    if (outcome.item) {
      items.push(outcome.item);
    } else {
      skipped.push({ orderId: id, reason: outcome.reason || 'Не удалось подготовить заказ' });
    }
  }

  return { items, skipped, deduplicated };
}

export function chunk<T>(items: T[], size: number = SYNC_BATCH_LIMIT): T[][] {
  const safeSize = size > 0 ? size : 1;
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += safeSize) {
    chunks.push(items.slice(i, i + safeSize));
  }
  return chunks;
}

export function createEmptyReport(sellerAccountId: string): OrderSyncReport {
  return {
    sellerAccountId,
    totalOrders: 0,
    sentOrders: 0,
    inserted: 0,
    updated: 0,
    financialDiscrepancies: 0,
    createdTimeDiscrepancies: 0,
    ignoredStatusDowngrades: 0,
    rejected: 0,
    skippedLocally: 0,
    skippedDetails: [],
    errors: [],
    chunks: 0,
    finishedAt: Date.now()
  };
}

/** Fold one RPC response row into the running report. */
export function applyRpcRow(report: OrderSyncReport, row: RpcOrderResult): void {
  switch (row?.action) {
    case 'inserted':
      report.inserted += 1;
      break;
    case 'updated':
      report.updated += 1;
      break;
    case 'financial_discrepancy_logged':
      report.financialDiscrepancies += 1;
      break;
    case 'created_at_discrepancy_logged':
      report.createdTimeDiscrepancies += 1;
      break;
    case 'ignored_status_downgrade':
      report.ignoredStatusDowngrades += 1;
      break;
    case 'error':
      report.rejected += 1;
      if (report.errors.length < 20) {
        report.errors.push(`${row.order_id || 'UNKNOWN'}: ${row.message || 'отклонён сервером'}`);
      }
      break;
    default:
      break;
  }
}

export type RpcCaller = (fn: string, args: Record<string, unknown>) => Promise<unknown>;

export interface SyncOptions {
  maxRetries?: number;
  retryDelayMs?: number;
}

/**
 * Push locally cached orders to the team backend in chunks of 50.
 * Retries on transient network errors with exponential backoff.
 * Never throws: per-chunk failures are collected into the report so the operator keeps
 * working even when the cloud is unreachable.
 */
export async function syncOrdersWithRpc(
  rpc: RpcCaller,
  sellerAccountId: string,
  orders: FunPayOrder[],
  options?: SyncOptions
): Promise<OrderSyncReport> {
  const report = createEmptyReport(sellerAccountId);
  report.totalOrders = (orders || []).length;

  if (!sellerAccountId) {
    report.errors.push('Не указан ID магазина продавца (seller_account_id)');
    return report;
  }

  const { items, skipped } = buildBatch(orders || []);
  report.skippedLocally = skipped.length;
  report.skippedDetails = skipped.slice(0, 20);

  const batches = chunk(items, SYNC_BATCH_LIMIT);
  report.chunks = batches.length;

  const maxRetries = options?.maxRetries ?? 2;
  const retryDelayMs = options?.retryDelayMs ?? 200;

  for (const batch of batches) {
    let response: unknown = null;
    let lastError: unknown = null;
    let succeeded = false;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        response = await rpc('sync_orders_batch', {
          p_seller_account_id: sellerAccountId,
          p_orders: batch
        });
        succeeded = true;
        break;
      } catch (err) {
        lastError = err;
        const errMsg = err instanceof Error ? err.message : String(err);
        // Do not retry on permanent client or permission errors (e.g. 400, 401, 403)
        if (errMsg.includes('400') || errMsg.includes('401') || errMsg.includes('403') || errMsg.includes('Нет прав')) {
          break;
        }
        if (attempt < maxRetries) {
          const delay = retryDelayMs * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    if (!succeeded) {
      report.errors.push(lastError instanceof Error ? lastError.message : 'Неизвестная ошибка пакетной синхронизации');
      continue;
    }

    const rows: RpcOrderResult[] = Array.isArray(response)
      ? (response as RpcOrderResult[])
      : typeof response === 'string'
        ? (JSON.parse(response) as RpcOrderResult[])
        : [];

    report.sentOrders += batch.length;
    for (const row of rows) {
      applyRpcRow(report, row);
    }
  }

  report.finishedAt = Date.now();
  return report;
}
