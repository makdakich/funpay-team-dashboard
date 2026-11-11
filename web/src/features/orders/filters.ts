import type { CurrencyCode, OrderStatus } from '@/types/database';
import { DEFAULT_PAGE_SIZE, normalizePageSize } from '@/lib/paging';
import { addDays, parseDayKeyInput, startOfDay } from '@/lib/time';

export type OrderSortColumn = 'funpay_created_at' | 'amount' | 'order_id';
export type SortDirection = 'asc' | 'desc';

/** Значение фильтра «оператор» для заказов без оператора. */
export const UNASSIGNED_OPERATOR = '__unassigned__';

export interface OrderQuery {
  search: string;
  operatorId: string;
  sellerAccountId: string;
  status: OrderStatus | '';
  currency: CurrencyCode | '';
  from: string;
  to: string;
  sortBy: OrderSortColumn;
  sortDirection: SortDirection;
  page: number;
  pageSize: number;
}

export const DEFAULT_ORDER_QUERY: OrderQuery = {
  search: '',
  operatorId: '',
  sellerAccountId: '',
  status: '',
  currency: '',
  from: '',
  to: '',
  sortBy: 'funpay_created_at',
  sortDirection: 'desc',
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE
};

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  paid: 'В обработке',
  closed: 'Завершён',
  refunded: 'Возврат'
};

export const ATTRIBUTION_STATUS_LABELS: Record<string, string> = {
  assigned: 'Назначен',
  ambiguous: 'Неоднозначно',
  unassigned: 'Без смены'
};

export const ATTRIBUTION_SOURCE_LABELS: Record<string, string> = {
  automatic: 'Автоматически',
  manual: 'Вручную',
  none: 'Не определён'
};

const SORT_COLUMNS: readonly OrderSortColumn[] = ['funpay_created_at', 'amount', 'order_id'];

/**
 * Убирает символы, ломающие грамматику PostgREST-фильтров, и сохраняет буквы
 * (включая кириллицу), цифры, пробелы, дефис, точку и подчёркивание.
 */
export function sanitizeSearchTerm(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/[,()%*"'\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

export function buildSearchFilter(term: string): string | null {
  const clean = sanitizeSearchTerm(term);
  if (!clean) return null;
  const pattern = '%' + clean + '%';
  return ['order_id', 'buyer_username', 'buyer_id'].map(column => column + '.ilike.' + pattern).join(',');
}

export interface DateBounds {
  fromIso: string | null;
  toIso: string | null;
}

/** Границы периода: from — начало дня, to — начало следующего дня (полуинтервал). */
export function resolveDateBounds(query: Pick<OrderQuery, 'from' | 'to'>): DateBounds {
  const from = query.from ? parseDayKeyInput(query.from) : null;
  const to = query.to ? parseDayKeyInput(query.to) : null;
  return {
    fromIso: from ? startOfDay(from).toISOString() : null,
    toIso: to ? addDays(startOfDay(to), 1).toISOString() : null
  };
}

export function orderQueryFromParams(params: URLSearchParams): OrderQuery {
  const status = params.get('status');
  const currency = params.get('currency');
  const sortBy = params.get('sort');
  const direction = params.get('dir');
  const page = Number(params.get('page'));

  return {
    search: params.get('search') ?? '',
    operatorId: params.get('operator') ?? '',
    sellerAccountId: params.get('shop') ?? '',
    status: status === 'paid' || status === 'closed' || status === 'refunded' ? status : '',
    currency: currency === 'RUB' || currency === 'USD' || currency === 'EUR' || currency === 'KZT' ? currency : '',
    from: params.get('from') ?? '',
    to: params.get('to') ?? '',
    sortBy: SORT_COLUMNS.includes(sortBy as OrderSortColumn) ? sortBy as OrderSortColumn : DEFAULT_ORDER_QUERY.sortBy,
    sortDirection: direction === 'asc' ? 'asc' : 'desc',
    page: Number.isFinite(page) && page > 0 ? Math.floor(page) : 1,
    pageSize: normalizePageSize(Number(params.get('size')))
  };
}

export function orderQueryToParams(query: OrderQuery): Record<string, string> {
  const params: Record<string, string> = {};
  if (query.search) params.search = query.search;
  if (query.operatorId) params.operator = query.operatorId;
  if (query.sellerAccountId) params.shop = query.sellerAccountId;
  if (query.status) params.status = query.status;
  if (query.currency) params.currency = query.currency;
  if (query.from) params.from = query.from;
  if (query.to) params.to = query.to;
  if (query.sortBy !== DEFAULT_ORDER_QUERY.sortBy) params.sort = query.sortBy;
  if (query.sortDirection !== DEFAULT_ORDER_QUERY.sortDirection) params.dir = query.sortDirection;
  if (query.page > 1) params.page = String(query.page);
  if (query.pageSize !== DEFAULT_PAGE_SIZE) params.size = String(query.pageSize);
  return params;
}

export function hasActiveFilters(query: OrderQuery): boolean {
  return Boolean(query.search || query.operatorId || query.sellerAccountId || query.status || query.currency || query.from || query.to);
}
