/** Утилиты серверной пагинации: заказы никогда не загружаются целиком. */
export const PAGE_SIZE_OPTIONS: readonly number[] = [25, 50, 100];
export const DEFAULT_PAGE_SIZE = 50;

export function pageCount(total: number, pageSize: number): number {
  if (pageSize <= 0) return 1;
  return Math.max(1, Math.ceil(total / pageSize));
}

export function clampPage(page: number, total: number, pageSize: number): number {
  if (!Number.isFinite(page)) return 1;
  const last = pageCount(total, pageSize);
  return Math.min(Math.max(1, Math.floor(page)), last);
}

/** Диапазон (from, to) включительно — формат PostgREST `.range()`. */
export function sliceRange(page: number, pageSize: number): [number, number] {
  const safePage = Math.max(1, Math.floor(page));
  const safeSize = Math.max(1, Math.floor(pageSize));
  const from = (safePage - 1) * safeSize;
  return [from, from + safeSize - 1];
}

export function normalizePageSize(value: number): number {
  return PAGE_SIZE_OPTIONS.includes(value) ? value : DEFAULT_PAGE_SIZE;
}
