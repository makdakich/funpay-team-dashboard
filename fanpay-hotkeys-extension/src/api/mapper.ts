import { FunPayAccountInfo, FunPayOrder, OrderStatus } from '../shared/types';
import { parseFunPayDate } from '../shared/utils';

/**
 * Parses the FunPay main page HTML (https://funpay.com/)
 */
export function parseMainPageHtml(html: string): FunPayAccountInfo | null {
  if (!html) return null;

  // 1. Extract Username
  const usernameMatch = html.match(/class=["'][^"']*user-link-name[^"']*["'][^>]*>([^<]+)<\/div>/i);
  const username = usernameMatch ? usernameMatch[1].trim() : null;

  // 2. Extract data-app-data JSON
  let userId = 0;
  let csrfToken = '';
  let locale = 'ru';

  const appDataMatch = html.match(/<body[^>]*data-app-data=["']([^"']+)["']/i);
  if (appDataMatch && appDataMatch[1]) {
    try {
      const decoded = appDataMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      const parsed = JSON.parse(decoded);
      userId = Number(parsed.userId || 0);
      csrfToken = parsed['csrf-token'] || '';
      locale = parsed.locale || 'ru';
    } catch {
      // ignore JSON errors
    }
  }

  if (!username && userId === 0) {
    // Not authenticated
    return null;
  }

  // 3. Extract Balance and Currency from <span class="badge badge-balance">...</span>
  let totalBalance = 0;
  let currency = '₽';
  const balanceMatch = html.match(/class=["'][^"']*badge-balance[^"']*["'][^>]*>([^<]+)<\/span>/i);
  if (balanceMatch && balanceMatch[1]) {
    const rawBalanceText = balanceMatch[1].trim(); // e.g. "1 450 ₽" or "100.50 $"
    const parts = rawBalanceText.split(/\s+/);
    if (parts.length >= 2) {
      currency = parts[parts.length - 1];
      const numPart = parts.slice(0, parts.length - 1).join('').replace(',', '.');
      totalBalance = parseFloat(numPart) || 0;
    } else {
      totalBalance = parseFloat(rawBalanceText.replace(',', '.')) || 0;
    }
  }

  // 4. Extract active sales count from badge-trade
  let activeSales = 0;
  const salesMatch = html.match(/class=["'][^"']*badge-trade[^"']*["'][^>]*>(\d+)<\/span>/i);
  if (salesMatch && salesMatch[1]) {
    activeSales = parseInt(salesMatch[1], 10);
  }

  // 5. Extract active purchases from badge-orders
  let activePurchases = 0;
  const purchasesMatch = html.match(/class=["'][^"']*badge-orders[^"']*["'][^>]*>(\d+)<\/span>/i);
  if (purchasesMatch && purchasesMatch[1]) {
    activePurchases = parseInt(purchasesMatch[1], 10);
  }

  return {
    userId,
    username: username || `ID ${userId}`,
    totalBalance,
    currency,
    activeSales,
    activePurchases,
    csrfToken,
    locale,
    lastUpdated: Date.now()
  };
}

/**
 * Parses the FunPay orders page HTML (https://funpay.com/orders/trade)
 */
export function parseOrdersPageHtml(html: string): FunPayOrder[] {
  if (!html) return [];

  const orders: FunPayOrder[] = [];

  // Split HTML by tc-item anchors
  const itemBlocks = html.split(/<a[^>]*class=["'][^"']*tc-item[^"']*["']/i).slice(1);

  for (const block of itemBlocks) {
    const endTagIdx = block.indexOf('</a>');
    const content = endTagIdx !== -1 ? block.substring(0, endTagIdx) : block;

    // 1. Order ID: <div class="tc-order">#ABCDEFGH</div>
    const idMatch = content.match(/class=["'][^"']*tc-order[^"']*["'][^>]*>#?([A-Za-z0-9]+)<\/div>/i);
    if (!idMatch || !idMatch[1]) continue;
    const id = idMatch[1].toUpperCase();

    // 2. Status from block classes
    // Class warning => refunded, info => paid, default => closed
    let status: OrderStatus = 'closed';
    const tagMatch = block.match(/^([^>]+)>/);
    const tagAttrs = tagMatch ? tagMatch[1] : '';
    if (tagAttrs.includes('warning')) {
      status = 'refunded';
    } else if (tagAttrs.includes('info')) {
      status = 'paid';
    } else {
      status = 'closed';
    }

    // 3. Description / Product: <div class="order-desc"><div>...</div></div>
    let description = '';
    const descMatch = content.match(/class=["'][^"']*order-desc[^"']*["'][^>]*>(?:<div[^>]*>)?([^<]+)/i);
    if (descMatch && descMatch[1]) {
      description = descMatch[1].trim();
    }

    // 4. Price & Currency: <div class="tc-price">150 ₽</div>
    let price = 0;
    let currency = '₽';
    const priceMatch = content.match(/class=["'][^"']*tc-price[^"']*["'][^>]*>([^<]+)<\/div>/i);
    if (priceMatch && priceMatch[1]) {
      const priceText = priceMatch[1].trim();
      const parts = priceText.split(/\s+/);
      if (parts.length >= 2) {
        currency = parts[parts.length - 1];
        const numPart = parts.slice(0, parts.length - 1).join('').replace(',', '.');
        price = parseFloat(numPart) || 0;
      } else {
        price = parseFloat(priceText.replace(',', '.')) || 0;
      }
    }

    // 5. Buyer info: <div class="media-user-name"><span ...>buyer</span></div> or data-href="/users/123/"
    let buyerUsername = '';
    let buyerId = 0;
    const buyerMatch = content.match(/class=["'][^"']*media-user-name[^"']*["'][^>]*>(?:<span[^>]*data-href=["']\/users\/(\d+)\/["'][^>]*>)?([^<]+)/i);
    if (buyerMatch) {
      buyerId = buyerMatch[1] ? parseInt(buyerMatch[1], 10) : 0;
      buyerUsername = (buyerMatch[2] || '').trim();
    }

    // 6. Subcategory name (e.g. "Roblox, Robux")
    let subcategoryName = '';
    const subcatMatch = content.match(/class=["'][^"']*text-muted[^"']*["'][^>]*>([^<]+)<\/div>/i);
    if (subcatMatch && subcatMatch[1]) {
      subcategoryName = subcatMatch[1].trim();
    }

    // 7. Date string: <div class="tc-date-time">сегодня, 14:15</div>
    let dateStr = '';
    const dateMatch = content.match(/class=["'][^"']*tc-date-time[^"']*["'][^>]*>([^<]+)<\/div>/i);
    if (dateMatch && dateMatch[1]) {
      dateStr = dateMatch[1].trim();
    }

    const timestamp = parseFunPayDate(dateStr);

    orders.push({
      id,
      description,
      price,
      currency,
      buyerUsername,
      buyerId,
      chatId: `users-${buyerId}`,
      status,
      dateStr,
      timestamp,
      subcategoryName
    });
  }

  return orders;
}
