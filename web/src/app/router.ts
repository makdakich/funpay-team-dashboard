export type DashboardRoute = 'overview' | 'team' | 'shifts' | 'orders' | 'finance';

export const DASHBOARD_ROUTES: readonly DashboardRoute[] = ['overview', 'team', 'shifts', 'orders', 'finance'];

const ROUTE_TITLES: Record<DashboardRoute, string> = {
  overview: 'Обзор',
  team: 'Команда',
  shifts: 'История смен',
  orders: 'Заказы',
  finance: 'Финансы'
};

export interface RouteTarget {
  route: DashboardRoute;
  segments: string[];
  params: URLSearchParams;
}

export type QueryParams = URLSearchParams | Record<string, string | number | null | undefined>;

/** Разбирает hash вида '#/orders/SELLER_MAIN/ORD-1?status=closed' в маршрут, параметры пути и query. */
export function parseRoute(hash: string): RouteTarget {
  const raw = hash.replace(/^#\/?/, '');
  const queryIndex = raw.indexOf('?');
  const path = queryIndex === -1 ? raw : raw.slice(0, queryIndex);
  const query = queryIndex === -1 ? '' : raw.slice(queryIndex + 1);
  const parts = path.split('/').filter(part => part.length > 0).map(decodeSegment);
  const first = parts[0];
  const route = DASHBOARD_ROUTES.includes(first as DashboardRoute) ? first as DashboardRoute : 'overview';
  return { route, segments: parts.slice(1), params: new URLSearchParams(query) };
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function getDashboardRoute(hash: string): DashboardRoute {
  return parseRoute(hash).route;
}

export function getRouteTitle(route: DashboardRoute): string {
  return ROUTE_TITLES[route] ?? ROUTE_TITLES.overview;
}

export function serializeParams(params?: QueryParams): string {
  if (!params) return '';
  const search = params instanceof URLSearchParams ? new URLSearchParams(params) : new URLSearchParams();
  if (!(params instanceof URLSearchParams)) {
    for (const [key, value] of Object.entries(params)) {
      if (value === null || value === undefined || value === '') continue;
      search.set(key, String(value));
    }
  }
  const query = search.toString();
  return query ? '?' + query : '';
}

export function buildHref(
  route: DashboardRoute,
  segments: readonly string[] = [],
  params?: QueryParams
): string {
  const tail = segments.filter(segment => segment.length > 0).map(encodeURIComponent);
  return '#/' + [route, ...tail].join('/') + serializeParams(params);
}

export function routeKey(target: RouteTarget): string {
  return [target.route, ...target.segments].join('/') + serializeParams(target.params);
}

export function navigateTo(route: DashboardRoute, segments: readonly string[] = [], params?: QueryParams): void {
  window.location.hash = buildHref(route, segments, params);
}
