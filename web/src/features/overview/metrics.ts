import type { ClosedOrderAmount, CurrencyCode, CurrencyTotals, OverviewOrderPoint } from '@/types/database';
import { CURRENCIES, CURRENCY_SYMBOLS, addAmountCents, centsToTotals, emptyCents, formatCurrency, formatCurrencyTotals, shareCents } from '@/lib/money';

export { CURRENCIES, CURRENCY_SYMBOLS, formatCurrency, formatCurrencyTotals };

export interface FinancialMetrics {
  count: number;
  turnoverByCurrency: CurrencyTotals;
  operatorShareByCurrency: CurrencyTotals;
}

export type Granularity = 'hours' | 'days' | 'weeks' | 'months';
export type PeriodOption = '7' | '30' | '90' | '180' | '365' | 'all';
export type MetricType = 'turnover' | 'orders' | 'share';

export interface DateRange {
  start: number;
  end: number;
  isValid: boolean;
  label: string;
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
}

export interface ExecutiveKpis {
  todayTurnover: number;
  todayOrdersCount: number;
  todayCleanShare: number;
  last7DaysTurnover: number;
  last7DaysOrdersCount: number;
  last7DaysAvgCheck: number;
  successfulOrdersCount: number;
  refundedOrdersCount: number;
  successRatePercent: number;
  earliestDateStr: string;
  latestDateStr: string;
}

export const FUNPAY_TZ_OFFSET_HOURS = 3;
export const MSK_OFFSET_MS = FUNPAY_TZ_OFFSET_HOURS * 3600 * 1000;

/**
 * Aggregate closed orders amount by currency (strict cents arithmetic)
 */
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

/**
 * Compute executive metrics matching Extension's dashboard cards
 */
export function computeExecutiveKpis(
  orders: readonly OverviewOrderPoint[],
  activeCurrency: CurrencyCode = 'RUB',
  sharePercent: number = 10,
  referenceTime: number = Date.now()
): ExecutiveKpis {
  // FunPay operates in Moscow Time (UTC+3)
  const nowMsk = new Date(referenceTime + MSK_OFFSET_MS);
  const todayStart = Date.UTC(nowMsk.getUTCFullYear(), nowMsk.getUTCMonth(), nowMsk.getUTCDate()) - MSK_OFFSET_MS;
  const d7Start = todayStart - 6 * 24 * 3600 * 1000;

  let todayTurnover = 0;
  let todayOrdersCount = 0;
  let last7DaysTurnover = 0;
  let last7DaysOrdersCount = 0;
  let successfulOrdersCount = 0;
  let refundedOrdersCount = 0;

  let minTs = Infinity;
  let maxTs = 0;

  for (const o of orders) {
    if (o.timestamp > 0) {
      if (o.timestamp < minTs) minTs = o.timestamp;
      if (o.timestamp > maxTs) maxTs = o.timestamp;
    }

    if (o.currency === activeCurrency) {
      if (o.status === 'closed' || o.status === 'paid') {
        successfulOrdersCount++;
        if (o.timestamp >= todayStart) {
          todayTurnover += o.amount;
          todayOrdersCount++;
        }
        if (o.timestamp >= d7Start) {
          last7DaysTurnover += o.amount;
          last7DaysOrdersCount++;
        }
      } else if (o.status === 'refunded') {
        refundedOrdersCount++;
      }
    }
  }

  const todayCleanShare = todayTurnover * (sharePercent / 100);
  const last7DaysAvgCheck = last7DaysOrdersCount > 0 ? Math.round(last7DaysTurnover / last7DaysOrdersCount) : 0;
  const totalDecided = successfulOrdersCount + refundedOrdersCount;
  const successRatePercent = totalDecided > 0 ? Math.round((successfulOrdersCount / totalDecided) * 100) : 100;

  const earliestDateStr = minTs !== Infinity
    ? new Date(minTs + MSK_OFFSET_MS).toLocaleDateString('ru-RU', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' })
    : '—';
  const latestDateStr = maxTs > 0
    ? new Date(maxTs + MSK_OFFSET_MS).toLocaleDateString('ru-RU', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' })
    : 'сегодня';

  return {
    todayTurnover: Math.round(todayTurnover * 100) / 100,
    todayOrdersCount,
    todayCleanShare: Math.round(todayCleanShare * 100) / 100,
    last7DaysTurnover: Math.round(last7DaysTurnover * 100) / 100,
    last7DaysOrdersCount,
    last7DaysAvgCheck,
    successfulOrdersCount,
    refundedOrdersCount,
    successRatePercent,
    earliestDateStr,
    latestDateStr
  };
}

/**
 * Compute timestamp range boundaries aligned with FunPay MSK time
 */
export function computeDateRange(
  period: PeriodOption,
  orders: readonly OverviewOrderPoint[] = [],
  referenceTime: number = Date.now()
): DateRange {
  const nowMsk = new Date(referenceTime + MSK_OFFSET_MS);
  const todayEnd = Date.UTC(nowMsk.getUTCFullYear(), nowMsk.getUTCMonth(), nowMsk.getUTCDate(), 23, 59, 59, 999) - MSK_OFFSET_MS;

  if (period === 'all') {
    let minTimestamp = Infinity;
    for (const o of orders) {
      if (o.timestamp > 0 && o.timestamp < minTimestamp) {
        minTimestamp = o.timestamp;
      }
    }

    if (minTimestamp === Infinity) {
      const start = todayEnd - 30 * 24 * 3600 * 1000 + 1;
      return { start, end: todayEnd, isValid: true, label: 'Всё время (нет заказов)' };
    }

    const minDateMsk = new Date(minTimestamp + MSK_OFFSET_MS);
    const start = Date.UTC(minDateMsk.getUTCFullYear(), minDateMsk.getUTCMonth(), minDateMsk.getUTCDate()) - MSK_OFFSET_MS;
    return {
      start,
      end: todayEnd,
      isValid: true,
      label: `Всё время (${new Date(start + MSK_OFFSET_MS).toLocaleDateString('ru-RU', { timeZone: 'UTC' })} — ${new Date(todayEnd + MSK_OFFSET_MS).toLocaleDateString('ru-RU', { timeZone: 'UTC' })})`
    };
  }

  const days = parseInt(period, 10) || 7;
  const start = Date.UTC(nowMsk.getUTCFullYear(), nowMsk.getUTCMonth(), nowMsk.getUTCDate() - (days - 1)) - MSK_OFFSET_MS;

  const startDateLabel = new Date(start + MSK_OFFSET_MS).toLocaleDateString('ru-RU', { timeZone: 'UTC' });
  const endDateLabel = new Date(todayEnd + MSK_OFFSET_MS).toLocaleDateString('ru-RU', { timeZone: 'UTC' });

  return {
    start,
    end: todayEnd,
    isValid: true,
    label: `${days} дней (${startDateLabel} — ${endDateLabel})`
  };
}

/**
 * Determine recommended granularity
 */
export function getRecommendedGranularity(startMs: number, endMs: number): Granularity {
  const durationDays = (endMs - startMs) / (24 * 3600 * 1000);
  if (durationDays <= 2.1) return 'hours';
  if (durationDays <= 35) return 'days';
  if (durationDays <= 180) return 'weeks';
  return 'months';
}

/**
 * Generate time-series buckets with zero-filling
 */
export function generateBuckets(
  orders: readonly OverviewOrderPoint[],
  startMs: number,
  endMs: number,
  granularity: Granularity,
  currency: CurrencyCode,
  sharePercent: number
): ChartBucket[] {
  const buckets: ChartBucket[] = [];
  if (startMs >= endMs) return buckets;

  const pad2 = (n: number) => String(n).padStart(2, '0');
  const monthNamesRu = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];

  if (granularity === 'hours') {
    let currTime = startMs;
    while (currTime <= endMs) {
      const d = new Date(currTime);
      const nextHour = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1, 0, 0, 0).getTime();
      const bucketEnd = Math.min(endMs, nextHour - 1);
      const hStr = `${pad2(d.getHours())}:00`;

      buckets.push({
        key: `h_${currTime}`,
        startTime: currTime,
        endTime: bucketEnd,
        label: hStr,
        fullLabel: `${d.toLocaleDateString('ru-RU')} в ${hStr}`,
        turnover: 0,
        share: 0,
        ordersCount: 0,
        refundsCount: 0,
        refundsAmount: 0
      });
      currTime = nextHour;
    }
  } else if (granularity === 'days') {
    // FunPay days are strictly aligned to Moscow Time (UTC+3)
    const curMsk = new Date(startMs + MSK_OFFSET_MS);
    let curDayStart = Date.UTC(curMsk.getUTCFullYear(), curMsk.getUTCMonth(), curMsk.getUTCDate()) - MSK_OFFSET_MS;

    while (curDayStart <= endMs) {
      const bStart = Math.max(startMs, curDayStart);
      const nextDayStart = curDayStart + 24 * 3600 * 1000;
      const bEnd = Math.min(endMs, nextDayStart - 1);

      const dMsk = new Date(curDayStart + MSK_OFFSET_MS);
      const label = `${pad2(dMsk.getUTCDate())}.${pad2(dMsk.getUTCMonth() + 1)}`;
      const fullLabel = dMsk.toLocaleDateString('ru-RU', {
        timeZone: 'UTC',
        weekday: 'short',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });

      buckets.push({
        key: `d_${curDayStart}`,
        startTime: bStart,
        endTime: bEnd,
        label,
        fullLabel,
        turnover: 0,
        share: 0,
        ordersCount: 0,
        refundsCount: 0,
        refundsAmount: 0
      });
      curDayStart = nextDayStart;
    }
  } else if (granularity === 'weeks') {
    const cur = new Date(startMs);
    const dayOfWeek = cur.getDay();
    const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const weekStart = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + diffToMonday, 0, 0, 0, 0);

    while (weekStart.getTime() <= endMs) {
      const bStart = Math.max(startMs, weekStart.getTime());
      const nextWeek = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 7, 0, 0, 0, 0);
      const bEnd = Math.min(endMs, nextWeek.getTime() - 1);

      const label = `${pad2(weekStart.getDate())}.${pad2(weekStart.getMonth() + 1)}`;
      const fullLabel = `Неделя с ${weekStart.toLocaleDateString('ru-RU')}`;

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
        refundsAmount: 0
      });
      weekStart.setTime(nextWeek.getTime());
    }
  } else {
    // months
    const cur = new Date(startMs);
    const monthStart = new Date(cur.getFullYear(), cur.getMonth(), 1, 0, 0, 0, 0);

    while (monthStart.getTime() <= endMs) {
      const bStart = Math.max(startMs, monthStart.getTime());
      const nextMonth = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1, 0, 0, 0, 0);
      const bEnd = Math.min(endMs, nextMonth.getTime() - 1);

      const label = `${monthNamesRu[monthStart.getMonth()]} ${String(monthStart.getFullYear()).slice(-2)}`;
      const fullLabel = `${monthNamesRu[monthStart.getMonth()]} ${monthStart.getFullYear()}`;

      buckets.push({
        key: `m_${monthStart.getTime()}`,
        startTime: bStart,
        endTime: bEnd,
        label,
        fullLabel,
        turnover: 0,
        share: 0,
        ordersCount: 0,
        refundsCount: 0,
        refundsAmount: 0
      });
      monthStart.setTime(nextMonth.getTime());
    }
  }

  // Populate orders into buckets
  for (const o of orders) {
    if (!o.timestamp || o.timestamp < startMs || o.timestamp > endMs || o.currency !== currency) {
      continue;
    }

    const bucket = buckets.find(b => o.timestamp >= b.startTime && o.timestamp <= b.endTime);
    if (!bucket) continue;

    if (o.status === 'closed' || o.status === 'paid') {
      bucket.turnover += o.amount;
      bucket.ordersCount += 1;
    } else if (o.status === 'refunded') {
      bucket.refundsCount += 1;
      bucket.refundsAmount += o.amount;
    }
  }

  for (const b of buckets) {
    b.turnover = Math.round(b.turnover * 100) / 100;
    b.share = Math.round(b.turnover * (sharePercent / 100) * 100) / 100;
  }

  return buckets;
}

/**
 * Select adaptive X-axis ticks to avoid collisions
 */
export function selectAxisTicks(buckets: ChartBucket[], maxTicks = 7): number[] {
  const count = buckets.length;
  if (count <= 0) return [];
  if (count <= maxTicks) return buckets.map((_, i) => i);

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
 * Generate smooth SVG Spline & Area chart
 */
export function generateSvgChart(
  buckets: ChartBucket[],
  metric: MetricType = 'turnover',
  currency: CurrencyCode = 'RUB',
  width = 860,
  height = 260
): string {
  const paddingLeft = 68;
  const paddingRight = 24;
  const paddingTop = 24;
  const paddingBottom = 40;

  const chartW = width - paddingLeft - paddingRight;
  const chartH = height - paddingTop - paddingBottom;
  const currSymbol = CURRENCY_SYMBOLS[currency] ?? '₽';

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
  const maxVal = maxValRaw === 0 ? 10 : maxValRaw * 1.15;

  // 4 horizontal gridlines
  const gridLinesCount = 4;
  let gridSvg = '';
  for (let i = 0; i <= gridLinesCount; i++) {
    const yVal = (maxVal / gridLinesCount) * i;
    const yPos = height - paddingBottom - (i / gridLinesCount) * chartH;
    const labelText = metric === 'orders' ? String(Math.round(yVal)) : `${Math.round(yVal).toLocaleString('ru-RU')} ${currSymbol}`;

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

  // Build smooth bezier spline
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

  const bottomY = height - paddingBottom;
  const areaPath = `${linePath} L ${coords[coords.length - 1].x} ${bottomY} L ${coords[0].x} ${bottomY} Z`;

  // X-axis ticks
  const tickIndices = selectAxisTicks(buckets, Math.min(8, Math.max(3, Math.floor(chartW / 85))));
  let xAxisSvg = '';
  tickIndices.forEach(idx => {
    const pt = coords[idx];
    xAxisSvg += `
      <line x1="${pt.x}" y1="${bottomY}" x2="${pt.x}" y2="${bottomY + 5}" stroke="#334155" stroke-width="1" />
      <text x="${pt.x}" y="${bottomY + 20}" text-anchor="middle" fill="#94A3B8" font-size="11" font-weight="500">${pt.bucket.label}</text>
    `;
  });

  // Interactive points
  let pointsSvg = '';
  coords.forEach((pt, idx) => {
    const formattedVal = metric === 'orders' ? `${pt.val} зак.` : formatCurrency(pt.val, currency);
    const turnoverFormatted = formatCurrency(pt.bucket.turnover, currency);
    const shareFormatted = formatCurrency(pt.bucket.share, currency);

    pointsSvg += `
      <g class="chart-point-group" data-idx="${idx}" data-date="${pt.bucket.fullLabel}" data-val="${formattedVal}" data-turnover="${turnoverFormatted}" data-share="${shareFormatted}" data-orders="${pt.bucket.ordersCount}" data-refunds="${pt.bucket.refundsCount}">
        <circle cx="${pt.x}" cy="${pt.y}" r="14" fill="transparent" class="chart-hit-area" />
        <circle cx="${pt.x}" cy="${pt.y}" r="${n > 60 ? '2.5' : '4'}" fill="#3B82F6" stroke="#0B0F19" stroke-width="2" class="chart-dot" />
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

      ${gridSvg}

      <line x1="${paddingLeft}" y1="${bottomY}" x2="${width - paddingRight}" y2="${bottomY}" stroke="#334155" stroke-width="1.5" />
      <path d="${areaPath}" fill="url(#areaGradient)" class="chart-area-path" />
      <path d="${linePath}" fill="none" stroke="url(#lineGradient)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="chart-line-path" />
      ${xAxisSvg}
      ${pointsSvg}

      <line id="web-chart-crosshair" x1="0" y1="${paddingTop}" x2="0" y2="${bottomY}" stroke="#60A5FA" stroke-width="1" stroke-dasharray="3,3" opacity="0" pointer-events="none" />
    </svg>
  `;
}
