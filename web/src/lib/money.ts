import type { CurrencyCode, CurrencyTotals } from '@/types/database';

/** Валюты учитываются строго раздельно — общих сумм по разным валютам нет. */
export const CURRENCIES: readonly CurrencyCode[] = ['RUB', 'USD', 'EUR', 'KZT'];

export const CURRENCY_SYMBOLS: Record<CurrencyCode, string> = {
  RUB: '₽',
  USD: '$',
  EUR: '€',
  KZT: '₸'
};

/** Доля оператора — ровно 10% подтверждённого оборота закрытых заказов. */
export const OPERATOR_SHARE_RATE = 0.1;

/** Внутреннее представление денег — целые копейки/центы, чтобы избежать ошибок округления. */
export type CentsTotals = Record<CurrencyCode, number>;

export function emptyCents(): CentsTotals {
  return { RUB: 0, USD: 0, EUR: 0, KZT: 0 };
}

export function emptyTotals(): CurrencyTotals {
  return { RUB: 0, USD: 0, EUR: 0, KZT: 0 };
}

export function isSupportedCurrency(value: unknown): value is CurrencyCode {
  return typeof value === 'string' && (CURRENCIES as readonly string[]).includes(value);
}

/** Строгий разбор Numeric формата '123.45'. Возвращает null для мусора. */
export function amountToCents(amount: string | number): number | null {
  const raw = typeof amount === 'number' ? amount.toFixed(2) : String(amount).trim();
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(raw);
  if (!match) return null;
  const fractional = (match[2] ?? '').padEnd(2, '0');
  return Number(match[1]) * 100 + Number(fractional.length === 0 ? '0' : fractional);
}

export function addAmountCents(totals: CentsTotals, amount: string | number, currency: unknown): void {
  if (!isSupportedCurrency(currency)) return;
  const cents = amountToCents(amount);
  if (cents === null) return;
  totals[currency] += cents;
}

export function centsToTotals(cents: CentsTotals): CurrencyTotals {
  return { RUB: cents.RUB / 100, USD: cents.USD / 100, EUR: cents.EUR / 100, KZT: cents.KZT / 100 };
}

export function totalsToCents(totals: CurrencyTotals): CentsTotals {
  return {
    RUB: Math.round(totals.RUB * 100),
    USD: Math.round(totals.USD * 100),
    EUR: Math.round(totals.EUR * 100),
    KZT: Math.round(totals.KZT * 100)
  };
}

export function shareCents(cents: CentsTotals): CentsTotals {
  return {
    RUB: Math.round(cents.RUB * OPERATOR_SHARE_RATE),
    USD: Math.round(cents.USD * OPERATOR_SHARE_RATE),
    EUR: Math.round(cents.EUR * OPERATOR_SHARE_RATE),
    KZT: Math.round(cents.KZT * OPERATOR_SHARE_RATE)
  };
}

export function shareTotals(totals: CurrencyTotals): CurrencyTotals {
  return centsToTotals(shareCents(totalsToCents(totals)));
}

export function addTotals(target: CurrencyTotals, source: CurrencyTotals): void {
  const cents = totalsToCents(target);
  const extra = totalsToCents(source);
  const merged: CentsTotals = {
    RUB: cents.RUB + extra.RUB,
    USD: cents.USD + extra.USD,
    EUR: cents.EUR + extra.EUR,
    KZT: cents.KZT + extra.KZT
  };
  const result = centsToTotals(merged);
  for (const currency of CURRENCIES) target[currency] = result[currency];
}

export function totalsAreEmpty(totals: CurrencyTotals): boolean {
  return CURRENCIES.every(currency => totals[currency] === 0);
}

export function nonZeroCurrencies(totals: CurrencyTotals): CurrencyCode[] {
  return CURRENCIES.filter(currency => totals[currency] !== 0);
}

export function formatCurrency(value: number, currency: CurrencyCode): string {
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value);
}

export function formatCurrencyTotals(totals: CurrencyTotals, emptyLabel = 'Нет закрытых заказов'): string {
  const entries = nonZeroCurrencies(totals).map(currency => formatCurrency(totals[currency], currency));
  return entries.length ? entries.join(' · ') : emptyLabel;
}
