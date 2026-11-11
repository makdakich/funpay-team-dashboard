import type { CurrencyCode, CurrencyTotals } from '@/types/database';
import { CURRENCIES, addAmountCents, centsToTotals, emptyCents, shareCents } from '@/lib/money';
import { dayKeyFromIso } from '@/lib/time';

export const UNASSIGNED_GROUP_KEY = '__unassigned__';

export interface FinanceOrderRow {
  seller_account_id: string;
  order_id: string;
  amount: string;
  currency: string;
  status: string;
  operator_id: string | null;
  attribution_status: string;
  funpay_created_at: string;
}

export interface GroupTotals {
  count: number;
  turnover: CurrencyTotals;
  share: CurrencyTotals;
}

export interface FinanceGroupRow extends GroupTotals {
  key: string;
  label: string;
}

export interface CurrencyRow {
  currency: CurrencyCode;
  count: number;
  turnover: number;
  share: number;
}

export interface DaySeriesPoint {
  dateKey: string;
  count: number;
  turnover: CurrencyTotals;
}

export interface FinanceAnalysis {
  closedCount: number;
  turnover: CurrencyTotals;
  share: CurrencyTotals;
  byCurrency: CurrencyRow[];
  byOperator: FinanceGroupRow[];
  byShop: FinanceGroupRow[];
  daily: DaySeriesPoint[];
  manualCount: number;
  unlinkedCount: number;
  ambiguousCount: number;
}

export interface AnalyzeOptions {
  operatorNames?: Map<string, string>;
  shopNames?: Map<string, string>;
  dayKeys?: readonly string[];
  unassignedLabel?: string;
  unknownLabel?: string;
}

interface Bucket {
  count: number;
  cents: ReturnType<typeof emptyCents>;
}

function newBucket(): Bucket {
  return { count: 0, cents: emptyCents() };
}

function bucketToTotals(bucket: Bucket): GroupTotals {
  return {
    count: bucket.count,
    turnover: centsToTotals(bucket.cents),
    share: centsToTotals(shareCents(bucket.cents))
  };
}

/**
 * Финансовая модель v2.4: в подтверждённый оборот входят ТОЛЬКО заказы
 * со статусом 'closed'. Возвраты (refunded) и заказы в обработке (paid)
 * исключаются по статусу — никакого повторного вычитания возвратов нет.
 * Валюты считаются раздельно, доля оператора равна ровно 10% оборота.
 */
export function analyzeFinance(rows: readonly FinanceOrderRow[], options: AnalyzeOptions = {}): FinanceAnalysis {
  const total = newBucket();
  const operatorBuckets = new Map<string, Bucket>();
  const shopBuckets = new Map<string, Bucket>();
  const currencyBuckets = new Map<CurrencyCode, Bucket>();
  const dayBuckets = new Map<string, Bucket>();
  for (const currency of CURRENCIES) currencyBuckets.set(currency, newBucket());

  let manualCount = 0;
  let unlinkedCount = 0;
  let ambiguousCount = 0;

  for (const row of rows) {
    if (row.status !== 'closed') continue;

    total.count += 1;
    addAmountCents(total.cents, row.amount, row.currency);

    const operatorKey = row.operator_id ?? UNASSIGNED_GROUP_KEY;
    const operatorBucket = operatorBuckets.get(operatorKey) ?? newBucket();
    operatorBucket.count += 1;
    addAmountCents(operatorBucket.cents, row.amount, row.currency);
    operatorBuckets.set(operatorKey, operatorBucket);

    const shopBucket = shopBuckets.get(row.seller_account_id) ?? newBucket();
    shopBucket.count += 1;
    addAmountCents(shopBucket.cents, row.amount, row.currency);
    shopBuckets.set(row.seller_account_id, shopBucket);

    const currencyBucket = currencyBuckets.get(row.currency as CurrencyCode);
    if (currencyBucket) {
      currencyBucket.count += 1;
      addAmountCents(currencyBucket.cents, row.amount, row.currency);
    }

    const dateKey = dayKeyFromIso(row.funpay_created_at);
    if (dateKey) {
      const dayBucket = dayBuckets.get(dateKey) ?? newBucket();
      dayBucket.count += 1;
      addAmountCents(dayBucket.cents, row.amount, row.currency);
      dayBuckets.set(dateKey, dayBucket);
    }

    if (row.attribution_status === 'manual') manualCount += 1;
    if (row.attribution_status === 'ambiguous') ambiguousCount += 1;
    if (!row.operator_id) unlinkedCount += 1;
  }

  const unknownLabel = options.unknownLabel ?? 'Неизвестный участник';
  const byOperator: FinanceGroupRow[] = [...operatorBuckets.entries()]
    .map(([key, bucket]) => ({
      key,
      label: key === UNASSIGNED_GROUP_KEY
        ? options.unassignedLabel ?? 'Без оператора'
        : options.operatorNames?.get(key) ?? unknownLabel,
      ...bucketToTotals(bucket)
    }))
    .sort((left, right) => right.count - left.count);

  const byShop: FinanceGroupRow[] = [...shopBuckets.entries()]
    .map(([key, bucket]) => ({
      key,
      label: options.shopNames?.get(key) ?? key,
      ...bucketToTotals(bucket)
    }))
    .sort((left, right) => right.count - left.count);

  const byCurrency: CurrencyRow[] = CURRENCIES.map(currency => {
    const bucket = currencyBuckets.get(currency) ?? newBucket();
    const totals = bucketToTotals(bucket);
    return { currency, count: bucket.count, turnover: totals.turnover[currency], share: totals.share[currency] };
  });

  const orderedKeys = options.dayKeys ? [...options.dayKeys] : [...dayBuckets.keys()].sort();
  const daily: DaySeriesPoint[] = orderedKeys.map(dateKey => {
    const bucket = dayBuckets.get(dateKey) ?? newBucket();
    return { dateKey, count: bucket.count, turnover: centsToTotals(bucket.cents) };
  });

  return {
    closedCount: total.count,
    turnover: centsToTotals(total.cents),
    share: centsToTotals(shareCents(total.cents)),
    byCurrency,
    byOperator,
    byShop,
    daily,
    manualCount,
    unlinkedCount,
    ambiguousCount
  };
}
