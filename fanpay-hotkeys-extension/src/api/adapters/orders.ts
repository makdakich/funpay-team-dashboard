import { FunPayOrder, OrderStatus } from '../../shared/types';
import { parseFunPayDateTimeToTimestamp } from '../../shared/datetime';
import { normalizeCurrency } from '../../shared/utils';

/**
 * Result of parsing price and currency from HTML
 */
export interface ParsedPriceResult {
  price: number | null;
  currency: string;
  error?: string;
}

/**
 * Robust extraction of price amount and currency symbol/code from HTML element content.
 * Handles:
 * - <div class="tc-price text-nowrap tc-seller-sum">999999.0<span class="unit">₽</span></div>
 * - <div class="tc-price text-nowrap tc-seller-sum">1 250.00 <span class="unit">₽</span></div>
 * - Non-breaking spaces (&nbsp;, \u00a0, \u202f)
 * - Decimal separators (. and ,)
 * - USD ($), EUR (€), RUB (₽), KZT (₸)
 * - Unparseable or missing amounts (returns price: null with descriptive error)
 */
export function parsePriceAndCurrency(rawHtml: string): ParsedPriceResult {
  if (!rawHtml || !rawHtml.trim()) {
    return { price: null, currency: '₽', error: 'Элемент цены пуст или отсутствует' };
  }

  // 1. Extract Currency
  let currency = '₽';
  const unitMatch = rawHtml.match(/class=["'][^"']*\bunit\b[^"']*["'][^>]*>([^<]+)<\/span>/i);
  if (unitMatch && unitMatch[1] && unitMatch[1].trim()) {
    currency = normalizeCurrency(unitMatch[1].trim());
  } else {
    const textWithoutTags = rawHtml.replace(/<[^>]+>/g, ' ');
    if (textWithoutTags.includes('₽') || /руб/i.test(textWithoutTags)) {
      currency = '₽';
    } else if (textWithoutTags.includes('$') || /usd/i.test(textWithoutTags)) {
      currency = '$';
    } else if (textWithoutTags.includes('€') || /eur/i.test(textWithoutTags)) {
      currency = '€';
    } else if (textWithoutTags.includes('₸') || /kzt|тг/i.test(textWithoutTags)) {
      currency = '₸';
    }
  }

  // 2. Extract Amount
  let cleaned = rawHtml
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#160;/gi, ' ')
    .replace(/&thinsp;/gi, ' ')
    .replace(/[\u00a0\u202f\u2007\u2009]/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .trim();

  // Strip known currency symbols and words
  cleaned = cleaned
    .replace(/[₽$€₸]/g, ' ')
    .replace(/\b(?:руб|rub|usd|eur|kzt)\b/gi, ' ');

  // Match positive number, possibly with spaces or dots/commas
  // e.g. "999999.0", "1 250.00", "1 500,50", "500", "0.99"
  const numberMatch = cleaned.match(/(\d+(?:[ \t]\d+)*(?:[.,]\d+)?)/);
  if (!numberMatch || !numberMatch[1]) {
    return {
      price: null,
      currency,
      error: 'Не удалось выделить числовую сумму заказа из блока цены'
    };
  }

  const numStr = numberMatch[1].replace(/\s+/g, '').replace(',', '.');
  const parsed = parseFloat(numStr);

  if (isNaN(parsed) || !isFinite(parsed) || parsed < 0) {
    return {
      price: null,
      currency,
      error: `Некорректное числовое значение: "${numStr}"`
    };
  }

  return {
    price: parsed,
    currency
  };
}

/**
 * Centralized selectors and regex patterns for FunPay Orders page (/orders/trade)
 * If FunPay modifies its HTML layout, update these selectors in this single location.
 */
export const ORDERS_PAGE_SELECTORS = {
  // Regex to split on each order anchor <a class="...tc-item...">, capturing tag attributes
  itemOpenSplit: /<a\b([^>]*\btc-item\b[^>]*)>/i,
  // Order ID pattern (e.g. #ABCDEF12 or #DELIVERY_TEST)
  orderId: /class=["'][^"']*tc-order[^"']*["'][^>]*>#?([A-Za-z0-9_-]+)<\/div>/i,
  // Order description
  description: /class=["'][^"']*order-desc[^"']*["'][^>]*>(?:<div[^>]*>)?([^<]+)/i,
  // Price element container: matches <div class="...tc-price..."> ... </div> or tc-seller-sum
  // Uses backreference \1 to match the closing tag corresponding to the opening container tag
  priceBlock: /<([a-z0-9]+)\b[^>]*class=["'][^"']*\b(?:tc-price|tc-seller-sum)\b[^"']*["'][^>]*>([\s\S]*?)<\/\1>/i,
  // Fallback simple price match if no closing tag found
  priceFallback: /class=["'][^"']*\b(?:tc-price|tc-seller-sum)\b[^"']*["'][^>]*>([^<]+)/i,
  // Buyer username block: captures inner content and strips tags to handle <span class="pseudo-a">, <a>, and whitespace
  buyerUsernameBlock: /class=["'][^"']*media-user-name[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  // Buyer user ID from link (supports both relative /users/123/ and absolute https://funpay.com/users/123/)
  buyerId: /(?:href|data-href)=["'](?:https?:\/\/[^"']*\/users\/|\/users\/)(\d+)\/?["']/i,
  // Subcategory or game name
  subcategory: /class=["'][^"']*text-muted[^"']*["'][^>]*>([^<]+)<\/div>/i,
  // Date time string
  dateTime: /class=["'][^"']*tc-date-time[^"']*["'][^>]*>([^<]+)<\/div>/i,
  // Status indicator text
  statusText: /class=["'][^"']*tc-status[^"']*["'][^>]*>([^<]+)<\/div>/i,
  // Pagination continue cursor input: <input type="hidden" name="continue" value="...">
  continueInputNameFirst: /<input\b[^>]*name=["']continue["'][^>]*value=["']([^"']+)["']/i,
  continueInputValueFirst: /<input\b[^>]*value=["']([^"']+)["'][^>]*name=["']continue["']/i,
  continueUrlParam: /[?&]continue=([A-Za-z0-9_-]+)/i,
  continueButtonAttr: /<button\b[^>]*name=["']continue["'][^>]*value=["']([^"']+)["']/i,
  continueDataAttr: /data-continue=["']([^"']+)["']/i
};

/**
 * Diagnostic info extracted from FunPay trade page pagination form
 */
export interface PaginationFormInspection {
  formAction?: string;
  formMethod?: string;
  hiddenInputs: Array<{ name: string; value: string }>;
  continueValue?: string;
  snippet: string;
}

/**
 * Orders / Sales Adapter
 * Data source: HTML parsing of https://funpay.com/orders/trade
 * Extracts verified HTML fields from tc-item elements.
 */
export class FunPayOrdersAdapter {
  /**
   * Diagnostic inspector for the pagination form / button on FunPay trade page
   */
  public static inspectPaginationForm(html: string): PaginationFormInspection {
    if (!html) return { hiddenInputs: [], snippet: 'empty' };

    let snippet = '';
    const formMatch = html.match(/<form\b[^>]*>[\s\S]*?(?:name=["']continue["']|\bjs-more\b|Показать ещё)[\s\S]*?<\/form>/i);
    if (formMatch) {
      snippet = formMatch[0];
    } else {
      const idx = html.search(/name=["']continue["']|Показать ещё|\bjs-more\b|data-continue/i);
      if (idx !== -1) {
        snippet = html.substring(Math.max(0, idx - 150), Math.min(html.length, idx + 250));
      }
    }

    let formAction: string | undefined;
    let formMethod: string | undefined;
    if (snippet) {
      const actM = snippet.match(/action=["']([^"']+)["']/i);
      if (actM) formAction = actM[1];
      const metM = snippet.match(/method=["']([^"']+)["']/i);
      if (metM) formMethod = metM[1];
    }

    const hiddenInputs: Array<{ name: string; value: string }> = [];
    const targetSource = snippet || html;
    const inputMatches = targetSource.matchAll(/<input\b[^>]*>/gi);
    for (const m of inputMatches) {
      const tag = m[0];
      const nameM = tag.match(/name=["']?([^"'\s>]+)["']?/i);
      const valM = tag.match(/value=["']?([^"'\s>]*)["']?/i);
      if (nameM && nameM[1]) {
        hiddenInputs.push({ name: nameM[1], value: valM ? valM[1] : '' });
      }
    }

    const continueVal = FunPayOrdersAdapter.extractNextContinueId(html) || undefined;

    return {
      formAction,
      formMethod,
      hiddenInputs,
      continueValue: continueVal,
      snippet: snippet.replace(/\s+/g, ' ').trim().substring(0, 300)
    };
  }

  /**
   * Extract cursor/ID for the next page of orders from FunPay trade page HTML.
   * FunPay embeds <input type="hidden" name="continue" value="<NEXT_ORDER_ID>"> in the pagination form.
   * Returns null if there are no further pages (end of account order history).
   */
  public static extractNextContinueId(html: string): string | null {
    if (!html) return null;

    // Check if response is JSON (e.g. from an AJAX endpoint)
    if (html.trim().startsWith('{')) {
      try {
        const obj = JSON.parse(html);
        if (typeof obj.continue === 'string' && obj.continue.trim()) return obj.continue.trim();
        if (typeof obj.next === 'string' && obj.next.trim()) return obj.next.trim();
        if (typeof obj.next_order_id === 'string' && obj.next_order_id.trim()) return obj.next_order_id.trim();
        if (typeof obj.html === 'string') {
          return FunPayOrdersAdapter.extractNextContinueId(obj.html);
        }
      } catch {}
    }

    const matchNameFirst = html.match(ORDERS_PAGE_SELECTORS.continueInputNameFirst);
    if (matchNameFirst && matchNameFirst[1] && matchNameFirst[1].trim()) {
      return matchNameFirst[1].trim();
    }

    const matchValFirst = html.match(ORDERS_PAGE_SELECTORS.continueInputValueFirst);
    if (matchValFirst && matchValFirst[1] && matchValFirst[1].trim()) {
      return matchValFirst[1].trim();
    }

    const matchBtn = html.match(ORDERS_PAGE_SELECTORS.continueButtonAttr);
    if (matchBtn && matchBtn[1] && matchBtn[1].trim()) {
      return matchBtn[1].trim();
    }

    const matchData = html.match(ORDERS_PAGE_SELECTORS.continueDataAttr);
    if (matchData && matchData[1] && matchData[1].trim()) {
      return matchData[1].trim();
    }

    const matchParam = html.match(ORDERS_PAGE_SELECTORS.continueUrlParam);
    if (matchParam && matchParam[1] && matchParam[1].trim()) {
      return matchParam[1].trim();
    }

    return null;
  }

  /**
   * Parse list of orders from the trade page HTML
   */
  public static parse(html: string): FunPayOrder[] {
    if (!html) return [];

    let rawHtml = html;
    if (html.trim().startsWith('{')) {
      try {
        const obj = JSON.parse(html);
        if (typeof obj.html === 'string') {
          rawHtml = obj.html;
        }
      } catch {}
    }

    const orders: FunPayOrder[] = [];
    const parts = rawHtml.split(ORDERS_PAGE_SELECTORS.itemOpenSplit);

    // With capturing group, parts[1] is attrs, parts[2] is body, parts[3] is attrs, etc.
    for (let i = 1; i < parts.length; i += 2) {
      const openTagAttrs = parts[i] || '';
      const content = parts[i + 1] || '';

      // 1. Order ID: <div class="tc-order">#ABCDEF12</div>
      const idMatch = content.match(ORDERS_PAGE_SELECTORS.orderId);
      if (!idMatch || !idMatch[1]) continue;
      const orderId = idMatch[1].toUpperCase();

      // 2. Status determination:
      // - 'warning' class on tc-item or text 'возврат' indicates Refunded (Возврат)
      // - 'info' class on tc-item or text 'оплачен' indicates Paid (Оплачен, ожидает выполнения)
      // - default neutral tc-item or text 'закрыт' indicates Closed (Закрыт, выполнен)
      // - 'danger' / 'спор' or unrecognized structure indicates 'unknown' (never counted as successful sale)
      let status: OrderStatus = 'unknown';
      const statusTextMatch = content.match(ORDERS_PAGE_SELECTORS.statusText);
      const statusText = (statusTextMatch ? statusTextMatch[1] : '').toLowerCase();

      if (openTagAttrs.includes('warning') || statusText.includes('возврат') || statusText.includes('refund')) {
        status = 'refunded';
      } else if (openTagAttrs.includes('info') || statusText.includes('оплачен') || statusText.includes('paid')) {
        status = 'paid';
      } else if (openTagAttrs.includes('danger') || statusText.includes('спор') || statusText.includes('dispute')) {
        status = 'unknown';
      } else if (
        statusText.includes('закрыт') ||
        statusText.includes('closed') ||
        (!openTagAttrs.includes('warning') && !openTagAttrs.includes('info') && !openTagAttrs.includes('danger'))
      ) {
        status = 'closed';
      } else {
        status = 'unknown';
      }

      // 3. Description / Product
      let description = '';
      const descMatch = content.match(ORDERS_PAGE_SELECTORS.description);
      if (descMatch && descMatch[1]) {
        description = descMatch[1].trim();
      }

      // 4. Price & Currency from tc-price or tc-seller-sum
      let price: number | null = null;
      let currency = '₽';
      let priceParseError: string | undefined;

      const priceMatch = content.match(ORDERS_PAGE_SELECTORS.priceBlock);
      if (priceMatch && priceMatch[2]) {
        const parsedPrice = parsePriceAndCurrency(priceMatch[2]);
        price = parsedPrice.price;
        currency = parsedPrice.currency;
        priceParseError = parsedPrice.error;
      } else {
        const fallbackMatch = content.match(ORDERS_PAGE_SELECTORS.priceFallback);
        if (fallbackMatch && fallbackMatch[1]) {
          const parsedPrice = parsePriceAndCurrency(fallbackMatch[1]);
          price = parsedPrice.price;
          currency = parsedPrice.currency;
          priceParseError = parsedPrice.error;
        } else {
          price = null;
          priceParseError = 'Блок суммы (.tc-price / .tc-seller-sum) не найден в карточке заказа';
        }
      }

      // 5. Buyer Info: primary ID & username
      let buyerUsername = '';
      let buyerId = 0;
      const buyerIdMatch = content.match(ORDERS_PAGE_SELECTORS.buyerId);
      if (buyerIdMatch && buyerIdMatch[1]) {
        buyerId = parseInt(buyerIdMatch[1], 10);
      }

      const buyerUserMatch = content.match(ORDERS_PAGE_SELECTORS.buyerUsernameBlock);
      if (buyerUserMatch && buyerUserMatch[1]) {
        buyerUsername = buyerUserMatch[1].replace(/<[^>]+>/g, '').trim();
      }

      // 6. Subcategory / Game
      let category = '';
      const subcatMatch = content.match(ORDERS_PAGE_SELECTORS.subcategory);
      if (subcatMatch && subcatMatch[1]) {
        category = subcatMatch[1].trim();
      }

      // 7. Date string and UTC timestamp
      let dateStr = '';
      const dateMatch = content.match(ORDERS_PAGE_SELECTORS.dateTime);
      if (dateMatch && dateMatch[1]) {
        dateStr = dateMatch[1].trim();
      }

      const timestamp = parseFunPayDateTimeToTimestamp(dateStr);

      orders.push({
        id: orderId,
        description,
        price,
        currency,
        buyerUsername,
        buyerId,
        chatId: `users-${buyerId}`,
        status,
        dateStr,
        timestamp,
        category,
        priceParseError
      });
    }

    return orders;
  }
}
