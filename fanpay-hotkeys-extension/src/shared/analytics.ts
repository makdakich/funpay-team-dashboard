/**
 * Analytics Engine: Time series aggregation, custom date range filtering,
 * adaptive granularity (hours/days/weeks/months), and SVG chart generation for FanPay Assistant.
 */

import { FunPayOrder } from './types';
import { formatMoney, normalizeCurrency } from './utils';

export type Granularity = 'hours' | 'days' | 'weeks' | 'months';
export type PeriodOption = '7' | '30' | '90' | '180' | '365' | 'all' | 'custom';
export type MetricType = 'turnover' | 'orders' | 'share';

export interface DateRange {
  start: number;
  end: number;
  isValid: boolean;
  error?: string;
  label?: string;
}

export interface ChartBucket {
  key: string;
  startTime: number;
  endTime: number;
  label: string;
  fullLabel: string;
  turnover: number;
  share: number;
  ordersCount: number;
  refundsCount: number;
  refundsAmount: number;
  orderIds: string[];
}

export interface ChartRenderOptions {
  width?: number;
  height?: number;
  metric?: MetricType;
  currency?: string;
}

/**
 * Determine the optimal granularity for a given date range
 */
export function getRecommendedGranularity(startMs: number, endMs: number): Granularity {
  const durationDays = (endMs - startMs) / (24 * 3600 * 1000);
  if (durationDays <= 2.1) {
    return 'hours';
  } else if (durationDays <= 35) {
    return 'days';
  } else if (durationDays <= 180) {
    return 'weeks';
  } else {
    return 'months';
  }
}

/**
 * Format a Date to YYYY-MM-DD for HTML5 date inputs in local time
 */
export function formatDateForInput(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Compute timestamp boundaries for standard or custom periods in user's local timezone
 */
export function computeDateRange(
  period: PeriodOption,
  customStartStr?: string,
  customEndStr?: string,
  orders?: FunPayOrder[]
): DateRange {
  const now = new Date();
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime();

  if (period === 'all') {
    if (!orders || orders.length === 0) {
      // Default to 30 days if no orders
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29, 0, 0, 0, 0).getTime();
      return { start, end: todayEnd, isValid: true, label: 'Всё время (нет заказов)' };
    }

    let minTimestamp = Infinity;
    for (const o of orders) {
      if (typeof o.timestamp === 'number' && o.timestamp > 0 && o.timestamp < minTimestamp) {
        minTimestamp = o.timestamp;
      }
    }

    if (minTimestamp === Infinity) {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29, 0, 0, 0, 0).getTime();
      return { start, end: todayEnd, isValid: true, label: 'Всё время' };
    }

    const minDate = new Date(minTimestamp);
    const start = new Date(minDate.getFullYear(), minDate.getMonth(), minDate.getDate(), 0, 0, 0, 0).getTime();
    return {
      start,
      end: todayEnd,
      isValid: true,
      label: `Всё время (${new Date(start).toLocaleDateString()} — ${new Date(todayEnd).toLocaleDateString()})`
    };
  }

  if (period === 'custom') {
    if (!customStartStr || !customEndStr) {
      return { start: 0, end: 0, isValid: false, error: 'Укажите дату начала и окончания' };
    }

    const [sY, sM, sD] = customStartStr.split('-').map(Number);
    const [eY, eM, eD] = customEndStr.split('-').map(Number);

    if (isNaN(sY) || isNaN(sM) || isNaN(sD) || isNaN(eY) || isNaN(eM) || isNaN(eD)) {
      return { start: 0, end: 0, isValid: false, error: 'Неверный формат даты (требуется ГГГГ-ММ-ДД)' };
    }

    const startDate = new Date(sY, sM - 1, sD, 0, 0, 0, 0);
    const endDate = new Date(eY, eM - 1, eD, 23, 59, 59, 999);

    const start = startDate.getTime();
    const end = endDate.getTime();

    if (isNaN(start) || isNaN(end)) {
      return { start: 0, end: 0, isValid: false, error: 'Некорректная дата' };
    }

    if (end < start) {
      return { start, end, isValid: false, error: 'Дата окончания не может быть раньше даты начала' };
    }

    return {
      start,
      end,
      isValid: true,
      label: `${startDate.toLocaleDateString()} — ${endDate.toLocaleDateString()}`
    };
  }

  // Standard numeric periods: 7, 30, 90, 180, 365
  const days = parseInt(period, 10) || 7;
  const startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1), 0, 0, 0, 0);
  const start = startDate.getTime();

  return {
    start,
    end: todayEnd,
    isValid: true,
    label: `${days} дней (${startDate.toLocaleDateString()} — ${now.toLocaleDateString()})`
  };
}

/**
 * Generate time-series buckets with zero-filling for empty periods
 */
export function generateBuckets(
  orders: FunPayOrder[],
  startMs: number,
  endMs: number,
  granularity: Granularity,
  currency: string,
  sharePercent: number
): ChartBucket[] {
  const normCurr = normalizeCurrency(currency);
  const buckets: ChartBucket[] = [];

  if (startMs >= endMs) {
    return buckets;
  }

  // Helper to format short date
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const monthNamesRu = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];
  const fullMonthNamesRu = [
    'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
    'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'
  ];

  if (granularity === 'hours') {
    let currTime = startMs;
    while (currTime <= endMs) {
      const d = new Date(currTime);
      const nextHour = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1, 0, 0, 0).getTime();
      const bucketEnd = Math.min(endMs, nextHour - 1);

      const hStr = `${pad2(d.getHours())}:00`;
      const dateLabel = `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)} ${hStr}`;
      const fullLabel = `${d.toLocaleDateString()} в ${hStr}`;

      buckets.push({
        key: `h_${currTime}`,
        startTime: currTime,
        endTime: bucketEnd,
        label: hStr,
        fullLabel,
        turnover: 0,
        share: 0,
        ordersCount: 0,
        refundsCount: 0,
        refundsAmount: 0,
        orderIds: []
      });

      currTime = nextHour;
    }
  } else if (granularity === 'days') {
    let curr = new Date(startMs);
    // Align to start of day
    let curDate = new Date(curr.getFullYear(), curr.getMonth(), curr.getDate(), 0, 0, 0, 0);

    while (curDate.getTime() <= endMs) {
      const bStart = Math.max(startMs, curDate.getTime());
      const nextDate = new Date(curDate.getFullYear(), curDate.getMonth(), curDate.getDate() + 1, 0, 0, 0, 0);
      const bEnd = Math.min(endMs, nextDate.getTime() - 1);

      const label = `${pad2(curDate.getDate())}.${pad2(curDate.getMonth() + 1)}`;
      const fullLabel = curDate.toLocaleDateString('ru-RU', {
        weekday: 'short',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });

      buckets.push({
        key: `d_${curDate.getTime()}`,
        startTime: bStart,
        endTime: bEnd,
        label,
        fullLabel,
        turnover: 0,
        share: 0,
        ordersCount: 0,
        refundsCount: 0,
        refundsAmount: 0,
        orderIds: []
      });

      curDate = nextDate;
    }
  } else if (granularity === 'weeks') {
    let cur = new Date(startMs);
    // Align to start of week (Monday)
    const dayOfWeek = cur.getDay(); // 0 is Sunday, 1 is Monday
    const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    let weekStart = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + diffToMonday, 0, 0, 0, 0);

    while (weekStart.getTime() <= endMs) {
      const bStart = Math.max(startMs, weekStart.getTime());
      const nextWeek = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 7, 0, 0, 0, 0);
      const bEnd = Math.min(endMs, nextWeek.getTime() - 1);

      const endDay = new Date(bEnd);
      const label = `${pad2(new Date(bStart).getDate())}.${pad2(new Date(bStart).getMonth() + 1)}`;
      const fullLabel = `${new Date(bStart).toLocaleDateString()} — ${endDay.toLocaleDateString()}`;

      buckets.push({
        key: `w_${weekStart.getTime()}`,
        startTime: bStart,
        endTime: bEnd,
        label,
        fullLabel,
        turnover: 0,
        share: 0,
        ordersCount: 0,
        refundsCount: 0,
        refundsAmount: 0,
        orderIds: []
      });

      weekStart = nextWeek;
    }
  } else if (granularity === 'months') {
    let cur = new Date(startMs);
    let monthStart = new Date(cur.getFullYear(), cur.getMonth(), 1, 0, 0, 0, 0);

    while (monthStart.getTime() <= endMs) {
      const bStart = Math.max(startMs, monthStart.getTime());
      const nextMonth = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1, 0, 0, 0, 0);
      const bEnd = Math.min(endMs, nextMonth.getTime() - 1);

      const label = `${monthNamesRu[monthStart.getMonth()]} ${String(monthStart.getFullYear()).slice(-2)}`;
      const fullLabel = `${fullMonthNamesRu[monthStart.getMonth()]} ${monthStart.getFullYear()}`;

      buckets.push({
        key: `m_${monthStart.getFullYear()}_${monthStart.getMonth()}`,
        startTime: bStart,
        endTime: bEnd,
        label,
        fullLabel,
        turnover: 0,
        share: 0,
        ordersCount: 0,
        refundsCount: 0,
        refundsAmount: 0,
        orderIds: []
      });

      monthStart = nextMonth;
    }
  }

  // Populate orders into buckets
  for (const o of orders) {
    if (!o.timestamp || o.timestamp < startMs || o.timestamp > endMs) {
      continue;
    }

    if (normalizeCurrency(o.currency) !== normCurr) {
      continue;
    }

    // Find bucket
    const bucket = buckets.find(b => o.timestamp >= b.startTime && o.timestamp <= b.endTime);
    if (!bucket) continue;

    const amount = o.price || 0;
    if (o.status === 'closed' || o.status === 'paid') {
      bucket.turnover += amount;
      bucket.ordersCount += 1;
      bucket.orderIds.push(o.id);
    } else if (o.status === 'refunded') {
      bucket.refundsCount += 1;
      bucket.refundsAmount += amount;
    }
  }

  // Compute share for each bucket
  for (const b of buckets) {
    b.share = b.turnover * (sharePercent / 100);
  }

  return buckets;
}

/**
 * Select adaptive X-axis ticks to prevent label collision.
 * Never exceeds maxTicks labels, evenly spaced across the entire timeline.
 */
export function selectAxisTicks(buckets: ChartBucket[], maxTicks = 7): number[] {
  const count = buckets.length;
  if (count <= 0) return [];
  if (count <= maxTicks) {
    return buckets.map((_, i) => i);
  }

  const indices: number[] = [];
  const step = (count - 1) / (maxTicks - 1);

  for (let i = 0; i < maxTicks; i++) {
    const idx = Math.min(count - 1, Math.round(i * step));
    if (!indices.includes(idx)) {
      indices.push(idx);
    }
  }

  return indices;
}

/**
 * Render a high-fidelity SVG Area + Spline Chart with adaptive X-axis and rich data attributes
 */
export function generateSvgChart(
  buckets: ChartBucket[],
  metric: MetricType = 'turnover',
  currency = '₽',
  options: ChartRenderOptions = {}
): string {
  const width = options.width || 860;
  const height = options.height || 260;
  const paddingLeft = 60;
  const paddingRight = 24;
  const paddingTop = 24;
  const paddingBottom = 40;

  const chartW = width - paddingLeft - paddingRight;
  const chartH = height - paddingTop - paddingBottom;

  if (buckets.length === 0) {
    return `
      <svg width="100%" height="100%" viewBox="0 0 ${width} ${height}" class="analytics-chart-svg">
        <text x="${width / 2}" y="${height / 2}" text-anchor="middle" fill="#64748B" font-size="13">
          Нет данных за выбранный период
        </text>
      </svg>
    `;
  }

  const values = buckets.map(b => {
    if (metric === 'turnover') return b.turnover;
    if (metric === 'share') return b.share;
    return b.ordersCount;
  });

  const maxValRaw = Math.max(...values, 0);
  // Give top breathing room
  const maxVal = maxValRaw === 0 ? 10 : maxValRaw * 1.15;

  // Generate 4 horizontal gridlines
  const gridLinesCount = 4;
  let gridSvg = '';
  for (let i = 0; i <= gridLinesCount; i++) {
    const yVal = (maxVal / gridLinesCount) * i;
    const yPos = height - paddingBottom - (i / gridLinesCount) * chartH;

    const labelText = metric === 'orders' ? String(Math.round(yVal)) : formatMoney(yVal, currency, false);

    gridSvg += `
      <line x1="${paddingLeft}" y1="${yPos}" x2="${width - paddingRight}" y2="${yPos}" stroke="#1E293B" stroke-width="1" stroke-dasharray="${i === 0 ? 'none' : '3,3'}" />
      <text x="${paddingLeft - 10}" y="${yPos + 4}" text-anchor="end" fill="#64748B" font-size="11" font-family="'JetBrains Mono', Consolas, monospace">${labelText}</text>
    `;
  }

  // Calculate coordinates
  const n = buckets.length;
  const coords: { x: number; y: number; bucket: ChartBucket; val: number }[] = [];

  buckets.forEach((b, idx) => {
    const val = values[idx];
    const x = n === 1 ? paddingLeft + chartW / 2 : paddingLeft + (idx / (n - 1)) * chartW;
    const y = height - paddingBottom - (val / maxVal) * chartH;
    coords.push({ x, y, bucket: b, val });
  });

  // Build smooth path
  let linePath = `M ${coords[0].x} ${coords[0].y}`;
  for (let i = 0; i < coords.length - 1; i++) {
    const p0 = coords[i === 0 ? 0 : i - 1];
    const p1 = coords[i];
    const p2 = coords[i + 1];
    const p3 = coords[i + 2 < coords.length ? i + 2 : coords.length - 1];

    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;

    linePath += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
  }

  // Build area path (closed down to bottom axis)
  const bottomY = height - paddingBottom;
  const areaPath = `${linePath} L ${coords[coords.length - 1].x} ${bottomY} L ${coords[0].x} ${bottomY} Z`;

  // Select adaptive X-axis ticks
  const tickIndices = selectAxisTicks(buckets, Math.min(8, Math.max(3, Math.floor(chartW / 85))));
  let xAxisSvg = '';
  tickIndices.forEach(idx => {
    const pt = coords[idx];
    xAxisSvg += `
      <line x1="${pt.x}" y1="${bottomY}" x2="${pt.x}" y2="${bottomY + 5}" stroke="#334155" stroke-width="1" />
      <text x="${pt.x}" y="${bottomY + 20}" text-anchor="middle" fill="#94A3B8" font-size="11" font-weight="500">${pt.bucket.label}</text>
    `;
  });

  // Interactive hover points
  let pointsSvg = '';
  coords.forEach((pt, idx) => {
    const formattedVal = metric === 'orders' ? `${pt.val} шт.` : formatMoney(pt.val, currency);
    const turnoverFormatted = formatMoney(pt.bucket.turnover, currency);
    const shareFormatted = formatMoney(pt.bucket.share, currency);

    pointsSvg += `
      <g class="chart-point-group" data-idx="${idx}" data-date="${pt.bucket.fullLabel}" data-val="${formattedVal}" data-turnover="${turnoverFormatted}" data-share="${shareFormatted}" data-orders="${pt.bucket.ordersCount}" data-refunds="${pt.bucket.refundsCount}">
        <!-- Invisible wide hit area -->
        <circle cx="${pt.x}" cy="${pt.y}" r="12" fill="transparent" class="chart-hit-area" />
        <!-- Visible dot -->
        <circle cx="${pt.x}" cy="${pt.y}" r="${n > 60 ? '2' : '4'}" fill="#3B82F6" stroke="#0B0F19" stroke-width="2" class="chart-dot" />
      </g>
    `;
  });

  return `
    <svg width="100%" height="100%" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" class="analytics-chart-svg">
      <defs>
        <linearGradient id="areaGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#3B82F6" stop-opacity="0.38" />
          <stop offset="70%" stop-color="#3B82F6" stop-opacity="0.06" />
          <stop offset="100%" stop-color="#3B82F6" stop-opacity="0.0" />
        </linearGradient>
        <linearGradient id="lineGradient" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="#60A5FA" />
          <stop offset="100%" stop-color="#3B82F6" />
        </linearGradient>
      </defs>

      <!-- Grid -->
      ${gridSvg}

      <!-- Bottom baseline -->
      <line x1="${paddingLeft}" y1="${bottomY}" x2="${width - paddingRight}" y2="${bottomY}" stroke="#334155" stroke-width="1.5" />

      <!-- Area fill -->
      <path d="${areaPath}" fill="url(#areaGradient)" class="chart-area-path" />

      <!-- Spline curve line -->
      <path d="${linePath}" fill="none" stroke="url(#lineGradient)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="chart-line-path" />

      <!-- X Axis Ticks & Labels -->
      ${xAxisSvg}

      <!-- Interactive Points -->
      ${pointsSvg}

      <!-- Dynamic crosshair line (hidden initially) -->
      <line id="chart-crosshair" x1="0" y1="${paddingTop}" x2="0" y2="${bottomY}" stroke="#60A5FA" stroke-width="1" stroke-dasharray="3,3" opacity="0" pointer-events="none" />
    </svg>
  `;
}
