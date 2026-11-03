import test from 'node:test';
import assert from 'node:assert/strict';
import { FunPayOrdersAdapter, parsePriceAndCurrency } from '../src/api/adapters/orders.ts';
import { FunPayBalanceAdapter } from '../src/api/adapters/balance.ts';
import { FunPayAccountAdapter } from '../src/api/adapters/account.ts';
import { FunPayStatisticsAdapter } from '../src/api/adapters/statistics.ts';
import { parseFunPayDateTimeToTimestamp } from '../src/shared/datetime.ts';
import { substituteVariables, aggregateClients, formatMoney, calculatePeriodMultiCurrencyStats } from '../src/shared/utils.ts';
import { FunPayOrder } from '../src/shared/types.ts';

// 1. FunPay Orders Adapter Tests
test('FunPayOrdersAdapter parses paid, closed, refunded, and unknown orders', () => {
  const mockHtml = `
    <div class="tc-wrapper">
      <!-- Order 1: Closed order in RUB -->
      <a href="https://funpay.com/orders/O1234567/" class="tc-item">
        <div class="tc-date-time">сегодня, 14:30</div>
        <div class="tc-order">#O1234567</div>
        <div class="text-muted">Roblox / Robux</div>
        <div class="order-desc"><div>1 000 Robux via Gamepass</div></div>
        <div class="media-user-name"><span data-href="/users/111222/">BuyerGamer</span></div>
        <div class="tc-price">500.00 ₽</div>
        <div class="tc-status">Закрыт</div>
      </a>

      <!-- Order 2: Paid order in USD -->
      <a href="https://funpay.com/orders/P9876543/" class="tc-item info">
        <div class="tc-date-time">вчера, 18:00</div>
        <div class="tc-order">#P9876543</div>
        <div class="text-muted">Steam / Accounts</div>
        <div class="order-desc"><div>CS2 Prime Account</div></div>
        <div class="media-user-name"><a href="/users/333444/">SteamPro</a></div>
        <div class="tc-price">15.50 $</div>
        <div class="tc-status text-info">Оплачен</div>
      </a>

      <!-- Order 3: Refunded order in RUB -->
      <a href="https://funpay.com/orders/R5555555/" class="tc-item warning">
        <div class="tc-date-time">10 мар 2026, 12:00</div>
        <div class="tc-order">#R5555555</div>
        <div class="text-muted">Minecraft / Keys</div>
        <div class="order-desc"><div>Java Edition Key</div></div>
        <div class="media-user-name"><span data-href="/users/111222/">BuyerGamer</span></div>
        <div class="tc-price">300 ₽</div>
        <div class="tc-status text-warning">Возврат</div>
      </a>

      <!-- Order 4: Unknown / dispute order -->
      <a href="https://funpay.com/orders/U0000001/" class="tc-item danger">
        <div class="tc-date-time">01 янв 2026, 10:00</div>
        <div class="tc-order">#U0000001</div>
        <div class="text-muted">Dispute Case</div>
        <div class="order-desc"><div>Arbitration Case</div></div>
        <div class="media-user-name"><span data-href="/users/999888/">ProblemUser</span></div>
        <div class="tc-price">1 000 ₽</div>
        <div class="tc-status text-danger">Спор</div>
      </a>
    </div>
  `;

  const orders = FunPayOrdersAdapter.parse(mockHtml);
  assert.equal(orders.length, 4);

  // Order 1 (Closed)
  assert.equal(orders[0].id, 'O1234567');
  assert.equal(orders[0].status, 'closed');
  assert.equal(orders[0].price, 500);
  assert.equal(orders[0].currency, '₽');
  assert.equal(orders[0].buyerId, 111222);
  assert.equal(orders[0].buyerUsername, 'BuyerGamer');
  assert.equal(orders[0].category, 'Roblox / Robux');

  // Order 2 (Paid)
  assert.equal(orders[1].id, 'P9876543');
  assert.equal(orders[1].status, 'paid');
  assert.equal(orders[1].price, 15.5);
  assert.equal(orders[1].currency, '$');
  assert.equal(orders[1].buyerId, 333444);
  assert.equal(orders[1].buyerUsername, 'SteamPro');

  // Order 3 (Refunded)
  assert.equal(orders[2].id, 'R5555555');
  assert.equal(orders[2].status, 'refunded');
  assert.equal(orders[2].price, 300);
  assert.equal(orders[2].currency, '₽');

  // Order 4 (Unknown)
  assert.equal(orders[3].id, 'U0000001');
  assert.equal(orders[3].status, 'unknown');
  assert.equal(orders[3].price, 1000);
});

// 2. FunPay Balance Adapter Tests
test('FunPayBalanceAdapter parses balance badge in DOM', () => {
  const htmlRub = '<span class="badge badge-balance">1 450.50 ₽</span>';
  const resRub = FunPayBalanceAdapter.parse(htmlRub);
  assert.equal(resRub.totalBalance, 1450.5);
  assert.equal(resRub.currency, '₽');
  assert.equal(resRub.balancesByCurrency['₽'], 1450.5);

  const htmlUsd = '<span class="badge badge-balance">125.00 $</span>';
  const resUsd = FunPayBalanceAdapter.parse(htmlUsd);
  assert.equal(resUsd.totalBalance, 125.0);
  assert.equal(resUsd.currency, '$');
  assert.equal(resUsd.balancesByCurrency['$'], 125.0);
});

// 3. FunPay Account Adapter Tests
test('FunPayAccountAdapter parses user link and data-app-data', () => {
  const html = `
    <body data-app-data="{&quot;userId&quot;:7654321,&quot;csrf-token&quot;:&quot;tok123&quot;,&quot;locale&quot;:&quot;ru&quot;}">
      <div class="user-link-name">SuperSeller</div>
      <span class="badge badge-trade">4</span>
      <span class="badge badge-orders">1</span>
    </body>
  `;

  const acc = FunPayAccountAdapter.parse(html);
  assert.ok(acc);
  assert.equal(acc?.userId, 7654321);
  assert.equal(acc?.username, 'SuperSeller');
  assert.equal(acc?.activeSales, 4);
  assert.equal(acc?.activePurchases, 1);
  assert.equal(acc?.csrfToken, 'tok123');

  // Unauthenticated page test
  const anonHtml = '<body><div class="login-link">Войти</div></body>';
  assert.equal(FunPayAccountAdapter.parse(anonHtml), null);
});

// 4. Statistics Calculation & Currency Isolation Tests
test('Statistics isolates currencies, calculates "Моя доля", and excludes unknown/refunds', () => {
  const orders: FunPayOrder[] = [
    {
      id: '1',
      description: 'Item 1',
      price: 1000,
      currency: '₽',
      buyerUsername: 'Alice',
      buyerId: 101,
      chatId: 'users-101',
      status: 'closed',
      dateStr: 'сегодня, 12:00',
      timestamp: Date.now()
    },
    {
      id: '2',
      description: 'Item 2',
      price: 2000,
      currency: '₽',
      buyerUsername: 'Bob',
      buyerId: 102,
      chatId: 'users-102',
      status: 'paid',
      dateStr: 'сегодня, 13:00',
      timestamp: Date.now()
    },
    {
      id: '3',
      description: 'Item 3 (Refund)',
      price: 500,
      currency: '₽',
      buyerUsername: 'Charlie',
      buyerId: 103,
      chatId: 'users-103',
      status: 'refunded',
      dateStr: 'сегодня, 10:00',
      timestamp: Date.now()
    },
    {
      id: '4',
      description: 'Item 4 (Unknown dispute)',
      price: 9999,
      currency: '₽',
      buyerUsername: 'Eve',
      buyerId: 104,
      chatId: 'users-104',
      status: 'unknown',
      dateStr: 'сегодня, 09:00',
      timestamp: Date.now()
    },
    {
      id: '5',
      description: 'USD Item',
      price: 50,
      currency: '$',
      buyerUsername: 'John',
      buyerId: 105,
      chatId: 'users-105',
      status: 'closed',
      dateStr: 'сегодня, 14:00',
      timestamp: Date.now()
    }
  ];

  const sellerSharePercent = 10; // 10%
  const stats = calculatePeriodMultiCurrencyStats(orders, sellerSharePercent);

  // RUB tests
  const rub = stats.currencies['₽'];
  assert.ok(rub);
  // Turnover should be 1000 + 2000 = 3000 (Refund 500 and Unknown 9999 excluded!)
  assert.equal(rub.turnover, 3000);
  assert.equal(rub.ordersCount, 2);
  assert.equal(rub.refundedCount, 1);
  assert.equal(rub.refundedSum, 500);
  // "Моя доля" = 3000 * 10 / 100 = 300
  assert.equal(rub.sellerShare, 300);
  assert.equal(rub.averageOrderSum, 1500);
  assert.equal(rub.uniqueClientsCount, 2); // Alice and Bob

  // USD tests (strictly isolated from RUB!)
  const usd = stats.currencies['$'];
  assert.ok(usd);
  assert.equal(usd.turnover, 50);
  assert.equal(usd.ordersCount, 1);
  assert.equal(usd.sellerShare, 5); // 50 * 0.10
  assert.equal(usd.uniqueClientsCount, 1);

  // Totals
  assert.equal(stats.totalOrdersCount, 3); // 2 RUB + 1 USD
  assert.equal(stats.totalRefundedCount, 1);
});

// 5. Client Aggregation strictly by buyerId
test('aggregateClients groups strictly by buyerId and ignores unknown status in spending', () => {
  const orders: FunPayOrder[] = [
    {
      id: 'A1',
      description: 'T1',
      price: 100,
      currency: '₽',
      buyerUsername: 'OldName',
      buyerId: 777,
      chatId: 'users-777',
      status: 'closed',
      dateStr: 'вчера',
      timestamp: 1000
    },
    {
      id: 'A2',
      description: 'T2',
      price: 200,
      currency: '₽',
      buyerUsername: 'NewName',
      buyerId: 777,
      chatId: 'users-777',
      status: 'closed',
      dateStr: 'сегодня',
      timestamp: 2000
    },
    {
      id: 'A3',
      description: 'T3',
      price: 500,
      currency: '₽',
      buyerUsername: 'NewName',
      buyerId: 777,
      chatId: 'users-777',
      status: 'unknown',
      dateStr: 'сегодня',
      timestamp: 3000
    }
  ];

  const clients = aggregateClients(orders);
  assert.equal(clients.length, 1);
  assert.equal(clients[0].buyerId, 777);
  // Fresh name picked
  assert.equal(clients[0].buyerUsername, 'NewName');
  // Only completed orders counted (100 + 200 = 300; unknown 500 excluded)
  assert.equal(clients[0].ordersCount, 2);
  assert.equal(clients[0].spentByCurrency['₽'], 300);
});

// 6. Template Variable Substitution Safe Fallbacks
test('substituteVariables replaces known keys and falls back safely without undefined/null', () => {
  const template = 'Здравствуйте, {buyer}! Ваш заказ #{order_id} ({product}) на сумму {amount} готов. Спасибо, {unknown_var}!';
  const vars = {
    buyer: 'Alexey',
    order_id: 'XYZ789',
    product: 'Robux 500',
    amount: '250 ₽',
    unknown_var: null
  };

  const result = substituteVariables(template, vars);
  assert.equal(
    result,
    'Здравствуйте, Alexey! Ваш заказ #XYZ789 (Robux 500) на сумму 250 ₽ готов. Спасибо, !'
  );
  assert.ok(!result.includes('undefined'));
  assert.ok(!result.includes('null'));
});

// 7. Money Formatting
test('formatMoney formats amounts with spaces and currency symbol', () => {
  assert.equal(formatMoney(1500, '₽'), '1 500 ₽');
  assert.equal(formatMoney(1234567.89, '$'), '1 234 567.89 $');
  assert.equal(formatMoney(0, '€'), '0 €');
});

// 8. FunPay Server Datetime (MSK UTC+3) Parsing
test('parseFunPayDateTimeToTimestamp parses relative and absolute date strings', () => {
  // Reference time: 2026-05-15 12:00:00 UTC (15:00:00 MSK)
  const refTimeUtc = Date.UTC(2026, 4, 15, 12, 0, 0);

  // "сегодня, 15:00" in MSK -> 12:00 UTC
  const todayParsed = parseFunPayDateTimeToTimestamp('сегодня, 15:00', refTimeUtc);
  assert.equal(todayParsed, refTimeUtc);

  // "вчера, 15:00" in MSK -> 24h earlier UTC
  const yesterdayParsed = parseFunPayDateTimeToTimestamp('вчера, 15:00', refTimeUtc);
  assert.equal(yesterdayParsed, refTimeUtc - 24 * 3600 * 1000);

  // "10 мая 2026, 15:00"
  const specificParsed = parseFunPayDateTimeToTimestamp('10 мая 2026, 15:00', refTimeUtc);
  const expectedUtc = Date.UTC(2026, 4, 10, 12, 0, 0);
  assert.equal(specificParsed, expectedUtc);
});

// 9. Dashboard Statistics with All Standard Periods
test('FunPayStatisticsAdapter calculates all time periods consistently', () => {
  const now = new Date(2026, 9, 4, 15, 0, 0).getTime(); // Fixed 15:00 reference point
  const dayMs = 24 * 3600 * 1000;

  const orders: FunPayOrder[] = [
    {
      id: 'TODAY1',
      description: 'Today Order',
      price: 1000,
      currency: '₽',
      buyerUsername: 'ClientToday',
      buyerId: 1,
      chatId: 'users-1',
      status: 'closed',
      dateStr: 'сегодня',
      timestamp: now - 3600 * 1000 // 1 hour ago (Today)
    },
    {
      id: 'WEEK1',
      description: '3 Days Ago Order',
      price: 2000,
      currency: '₽',
      buyerUsername: 'ClientWeek',
      buyerId: 2,
      chatId: 'users-2',
      status: 'closed',
      dateStr: '3 дня назад',
      timestamp: now - 3 * dayMs // 3 days ago (Within 7d, 30d, 90d, All)
    },
    {
      id: 'MONTH1',
      description: '20 Days Ago Order',
      price: 3000,
      currency: '₽',
      buyerUsername: 'ClientMonth',
      buyerId: 3,
      chatId: 'users-3',
      status: 'closed',
      dateStr: '20 дней назад',
      timestamp: now - 20 * dayMs // 20 days ago (Within 30d, 90d, All)
    },
    {
      id: 'QUARTER1',
      description: '60 Days Ago Order',
      price: 4000,
      currency: '₽',
      buyerUsername: 'ClientQuarter',
      buyerId: 4,
      chatId: 'users-4',
      status: 'closed',
      dateStr: '60 дней назад',
      timestamp: now - 60 * dayMs // 60 days ago (Within 90d, All)
    },
    {
      id: 'OLD1',
      description: '200 Days Ago Order',
      price: 5000,
      currency: '₽',
      buyerUsername: 'ClientOld',
      buyerId: 5,
      chatId: 'users-5',
      status: 'closed',
      dateStr: '200 дней назад',
      timestamp: now - 200 * dayMs // 200 days ago (Only in All Time)
    }
  ];

  const balances = { '₽': 15000 };
  const stats = FunPayStatisticsAdapter.calculate(orders, 15, balances, '₽', now, now);

  // Today: only TODAY1
  assert.equal(stats.today.currencies['₽'].turnover, 1000);
  assert.equal(stats.today.currencies['₽'].sellerShare, 150); // 1000 * 0.15

  // 7 Days: TODAY1 + WEEK1 = 3000
  assert.equal(stats.last7Days.currencies['₽'].turnover, 3000);
  assert.equal(stats.last7Days.currencies['₽'].sellerShare, 450); // 3000 * 0.15

  // 30 Days: TODAY1 + WEEK1 + MONTH1 = 6000
  assert.equal(stats.last30Days.currencies['₽'].turnover, 6000);
  assert.equal(stats.last30Days.currencies['₽'].sellerShare, 900); // 6000 * 0.15

  // 90 Days: TODAY1 + WEEK1 + MONTH1 + QUARTER1 = 10000
  assert.equal(stats.last90Days.currencies['₽'].turnover, 10000);
  assert.equal(stats.last90Days.currencies['₽'].sellerShare, 1500);

  // All Time: 1000 + 2000 + 3000 + 4000 + 5000 = 15000
  assert.equal(stats.allTime.currencies['₽'].turnover, 15000);
  assert.equal(stats.allTime.currencies['₽'].sellerShare, 2250);

  // Balance is kept separate and intact
  assert.equal(stats.balances['₽'], 15000);
});

// 10. parsePriceAndCurrency Unit Tests (All Edge Cases)
test('parsePriceAndCurrency parses all real FunPay amount and currency formats', () => {
  // Real FunPay template with tc-seller-sum and span.unit
  const res1 = parsePriceAndCurrency('999999.0<span class="unit">₽</span>');
  assert.equal(res1.price, 999999.0);
  assert.equal(res1.currency, '₽');
  assert.equal(res1.error, undefined);

  // Thousands separator with space
  const res2 = parsePriceAndCurrency('1 250.00 <span class="unit">₽</span>');
  assert.equal(res2.price, 1250.0);
  assert.equal(res2.currency, '₽');

  // Non-breaking space &nbsp;
  const res3 = parsePriceAndCurrency('1&nbsp;500.50<span class="unit">₽</span>');
  assert.equal(res3.price, 1500.5);
  assert.equal(res3.currency, '₽');

  // Narrow non-breaking space \u202f
  const res4 = parsePriceAndCurrency('2 400.00<span class="unit">₽</span>');
  assert.equal(res4.price, 2400.0);
  assert.equal(res4.currency, '₽');

  // USD with span.unit
  const res5 = parsePriceAndCurrency('15.50 <span class="unit">$</span>');
  assert.equal(res5.price, 15.5);
  assert.equal(res5.currency, '$');

  // EUR with span.unit
  const res6 = parsePriceAndCurrency('20.00 <span class="unit">€</span>');
  assert.equal(res6.price, 20.0);
  assert.equal(res6.currency, '€');

  // Legacy/simple format without span
  const res7 = parsePriceAndCurrency('500.00 ₽');
  assert.equal(res7.price, 500.0);
  assert.equal(res7.currency, '₽');

  // Integer without decimal
  const res8 = parsePriceAndCurrency('1000<span class="unit">₽</span>');
  assert.equal(res8.price, 1000);
  assert.equal(res8.currency, '₽');

  // Comma as decimal separator
  const res9 = parsePriceAndCurrency('1 500,75 <span class="unit">₽</span>');
  assert.equal(res9.price, 1500.75);
  assert.equal(res9.currency, '₽');

  // Unparseable string -> price: null and descriptive error
  const res10 = parsePriceAndCurrency('—');
  assert.equal(res10.price, null);
  assert.ok(res10.error);

  // Empty string -> price: null and error
  const res11 = parsePriceAndCurrency('');
  assert.equal(res11.price, null);
  assert.ok(res11.error);
});

// 11. FunPayOrdersAdapter parses Real Production FunPay Orders HTML with nested span.unit
test('FunPayOrdersAdapter parses real production FunPay order cards with span.unit and data-href', () => {
  const realProductionHtml = `
    <div class="tc-wrapper">
      <!-- Order 1: Real FunPay template with tc-price text-nowrap tc-seller-sum and span.unit -->
      <a href="https://funpay.com/orders/DELIVERY_TEST/" class="tc-item info">
        <div class="tc-date">
          <div class="tc-date-time">сегодня, 00:00</div>
          <div class="tc-date-left">1 минуту назад</div>
        </div>
        <div class="tc-order">#DELIVERY_TEST</div>
        <div class="order-desc">
          <div>ТЕСТ АВТОВЫДАЧИ</div>
          <div class="text-muted">Roblox / Robux</div>
        </div>
        <div class="tc-user">
          <div class="media media-user mt0 offline">
            <div class="media-left">
              <div class="avatar-photo pseudo-a" tabindex="0" data-href="https://funpay.com/users/123456/" style="..."></div>
            </div>
            <div class="media-body">
              <div class="media-user-name">
                <span class="pseudo-a" tabindex="0" data-href="https://funpay.com/users/123456/">BuyerName</span>
              </div>
              <div class="media-user-status">был недавно</div>
            </div>
          </div>
        </div>
        <div class="tc-status text-primary">Оплачен</div>
        <div class="tc-price text-nowrap tc-seller-sum">999999.0<span class="unit">₽</span></div>
      </a>

      <!-- Order 2: Historical closed order with 1 250.00 ₽ -->
      <a href="https://funpay.com/orders/HIST10001/" class="tc-item">
        <div class="tc-date">
          <div class="tc-date-time">15 мар 2024, 18:30</div>
        </div>
        <div class="tc-order">#HIST10001</div>
        <div class="order-desc">
          <div>Старый заказ CS:GO</div>
          <div class="text-muted">Steam / Accounts</div>
        </div>
        <div class="tc-user">
          <div class="media-user-name">
            <a href="/users/987654/">OldBuyer</a>
          </div>
        </div>
        <div class="tc-status">Закрыт</div>
        <div class="tc-price text-nowrap tc-seller-sum">1 250.00 <span class="unit">₽</span></div>
      </a>

      <!-- Order 3: Historical USD order with &nbsp; -->
      <a href="https://funpay.com/orders/HISTUSD01/" class="tc-item info">
        <div class="tc-date">
          <div class="tc-date-time">20 янв 2024, 10:00</div>
        </div>
        <div class="tc-order">#HISTUSD01</div>
        <div class="order-desc">
          <div>Discord Nitro 1 Year</div>
          <div class="text-muted">Discord / Subs</div>
        </div>
        <div class="tc-user">
          <div class="media-user-name">
            <span data-href="/users/555444/">DiscordUser</span>
          </div>
        </div>
        <div class="tc-status text-info">Оплачен</div>
        <div class="tc-price text-nowrap tc-seller-sum">29.99&nbsp;<span class="unit">$</span></div>
      </a>

      <!-- Order 4: Historical EUR order -->
      <a href="https://funpay.com/orders/HISTEUR01/" class="tc-item">
        <div class="tc-date">
          <div class="tc-date-time">01 фев 2024, 12:00</div>
        </div>
        <div class="tc-order">#HISTEUR01</div>
        <div class="order-desc">
          <div>European Gift Card</div>
          <div class="text-muted">Gift Cards</div>
        </div>
        <div class="tc-user">
          <div class="media-user-name"><a href="/users/111333/">EuroBuyer</a></div>
        </div>
        <div class="tc-status">Закрыт</div>
        <div class="tc-price text-nowrap tc-seller-sum">45.00 <span class="unit">€</span></div>
      </a>

      <!-- Order 5: Historical Refunded order with &nbsp; in price -->
      <a href="https://funpay.com/orders/REFUND001/" class="tc-item warning">
        <div class="tc-date">
          <div class="tc-date-time">10 янв 2024, 14:00</div>
        </div>
        <div class="tc-order">#REFUND001</div>
        <div class="order-desc">
          <div>Возвращенный заказ</div>
          <div class="text-muted">Keys</div>
        </div>
        <div class="tc-user">
          <div class="media-user-name"><a href="/users/222111/">RefundUser</a></div>
        </div>
        <div class="tc-status text-warning">Возврат</div>
        <div class="tc-price text-nowrap tc-seller-sum">1&nbsp;500.00<span class="unit">₽</span></div>
      </a>

      <!-- Order 6: Corrupted/missing price order -> must set price: null, not 0 -->
      <a href="https://funpay.com/orders/NOPRICE01/" class="tc-item">
        <div class="tc-date">
          <div class="tc-date-time">05 янв 2024, 08:00</div>
        </div>
        <div class="tc-order">#NOPRICE01</div>
        <div class="order-desc">
          <div>Заказ без указанной суммы</div>
          <div class="text-muted">Misc</div>
        </div>
        <div class="tc-user">
          <div class="media-user-name"><a href="/users/333222/">NoPriceUser</a></div>
        </div>
        <div class="tc-status">Закрыт</div>
        <div class="tc-price text-nowrap tc-seller-sum">—</div>
      </a>
    </div>
  `;

  const orders = FunPayOrdersAdapter.parse(realProductionHtml);
  assert.equal(orders.length, 6);

  // Order 1 (Production template, ₽)
  assert.equal(orders[0].id, 'DELIVERY_TEST');
  assert.equal(orders[0].price, 999999.0);
  assert.equal(orders[0].currency, '₽');
  assert.equal(orders[0].status, 'paid');
  assert.equal(orders[0].buyerId, 123456);
  assert.equal(orders[0].buyerUsername, 'BuyerName');

  // Order 2 (Historical 1 250.00 ₽)
  assert.equal(orders[1].id, 'HIST10001');
  assert.equal(orders[1].price, 1250.0);
  assert.equal(orders[1].currency, '₽');
  assert.equal(orders[1].status, 'closed');
  assert.equal(orders[1].buyerId, 987654);
  assert.equal(orders[1].buyerUsername, 'OldBuyer');

  // Order 3 (Historical USD with &nbsp;)
  assert.equal(orders[2].id, 'HISTUSD01');
  assert.equal(orders[2].price, 29.99);
  assert.equal(orders[2].currency, '$');
  assert.equal(orders[2].status, 'paid');
  assert.equal(orders[2].buyerId, 555444);

  // Order 4 (Historical EUR)
  assert.equal(orders[3].id, 'HISTEUR01');
  assert.equal(orders[3].price, 45.0);
  assert.equal(orders[3].currency, '€');
  assert.equal(orders[3].status, 'closed');
  assert.equal(orders[3].buyerId, 111333);

  // Order 5 (Refunded with &nbsp;)
  assert.equal(orders[4].id, 'REFUND001');
  assert.equal(orders[4].price, 1500.0);
  assert.equal(orders[4].currency, '₽');
  assert.equal(orders[4].status, 'refunded');

  // Order 6 (Unparseable price -> price: null, priceParseError set)
  assert.equal(orders[5].id, 'NOPRICE01');
  assert.equal(orders[5].price, null);
  assert.ok(orders[5].priceParseError);
});

// 12. Pagination Cursor Extraction Tests
test('FunPayOrdersAdapter extracts continue pagination cursor from various input elements and links', () => {
  // Standard FunPay pagination form: name before value
  const htmlNameFirst = `
    <div class="tc-wrapper">
      <form action="https://funpay.com/orders/trade" method="post">
        <input type="hidden" name="continue" value="12345678">
        <button class="btn btn-default">Показать ещё</button>
      </form>
    </div>
  `;
  assert.equal(FunPayOrdersAdapter.extractNextContinueId(htmlNameFirst), '12345678');

  // Alternative attribute order: value before name
  const htmlValueFirst = `
    <form method="post" action="/orders/trade">
      <input type="hidden" value="87654321" name="continue">
      <button class="btn btn-default">Показать ещё</button>
    </form>
  `;
  assert.equal(FunPayOrdersAdapter.extractNextContinueId(htmlValueFirst), '87654321');

  // Query parameter in pagination link
  const htmlLink = '<a href="https://funpay.com/orders/trade?continue=99887766">Показать ещё</a>';
  assert.equal(FunPayOrdersAdapter.extractNextContinueId(htmlLink), '99887766');

  // Last page of orders: no continue input exists
  const htmlLastPage = `
    <div class="tc-wrapper">
      <div class="alert alert-info">Больше заказов нет</div>
    </div>
  `;
  assert.equal(FunPayOrdersAdapter.extractNextContinueId(htmlLastPage), null);

  // Empty string or null
  assert.equal(FunPayOrdersAdapter.extractNextContinueId(''), null);
});

// 12b. inspectPaginationForm Form Inspection Unit Test
test('FunPayOrdersAdapter.inspectPaginationForm extracts form action, method, hidden inputs, and snippets', () => {
  const html = `
    <div class="tc-wrapper">
      <form action="/orders/trade" method="post" class="more-box">
        <input type="hidden" name="continue" value="98765432">
        <input type="hidden" name="filter" value="all">
        <button type="submit" class="btn btn-default">Показать ещё</button>
      </form>
    </div>
  `;
  const res = FunPayOrdersAdapter.inspectPaginationForm(html);
  assert.equal(res.formAction, '/orders/trade');
  assert.equal(res.formMethod, 'post');
  assert.equal(res.continueValue, '98765432');
  assert.equal(res.hiddenInputs.length, 2);
  assert.equal(res.hiddenInputs[0].name, 'continue');
  assert.equal(res.hiddenInputs[0].value, '98765432');
  assert.equal(res.hiddenInputs[1].name, 'filter');
  assert.equal(res.hiddenInputs[1].value, 'all');
  assert.ok(res.snippet.includes('Показать ещё'));
});

// 13. Multi-Page Parsing & Deduplication Across Pages
test('Multi-page trade history parsing correctly extracts across pages and merges without duplicates', () => {
  // Page 1: 08 Oct 2026 (Recent orders)
  const page1Html = `
    <div class="tc-wrapper">
      <a href="https://funpay.com/orders/P1_001/" class="tc-item info">
        <div class="tc-date-time">сегодня, 12:00</div>
        <div class="tc-order">#P1_001</div>
        <div class="order-desc"><div>Recent Item 1</div></div>
        <div class="media-user-name"><a href="/users/101/">User1</a></div>
        <div class="tc-price">500.00 <span class="unit">₽</span></div>
        <div class="tc-status">Оплачен</div>
      </a>
      <a href="https://funpay.com/orders/P1_002/" class="tc-item">
        <div class="tc-date-time">07 окт 2026, 15:00</div>
        <div class="tc-order">#P1_002</div>
        <div class="order-desc"><div>Recent Item 2</div></div>
        <div class="media-user-name"><a href="/users/102/">User2</a></div>
        <div class="tc-price">1 000.00 <span class="unit">₽</span></div>
        <div class="tc-status">Закрыт</div>
      </a>
      <input type="hidden" name="continue" value="P1_002">
    </div>
  `;

  // Page 2: 05 Oct 2026 & Late September (Transition orders, overlaps with P1_002 updated to closed)
  const page2Html = `
    <div class="tc-wrapper">
      <a href="https://funpay.com/orders/P1_002/" class="tc-item">
        <div class="tc-date-time">07 окт 2026, 15:00</div>
        <div class="tc-order">#P1_002</div>
        <div class="order-desc"><div>Recent Item 2 (Page 2 entry)</div></div>
        <div class="media-user-name"><a href="/users/102/">User2</a></div>
        <div class="tc-price">1 000.00 <span class="unit">₽</span></div>
        <div class="tc-status">Закрыт</div>
      </a>
      <a href="https://funpay.com/orders/P2_003/" class="tc-item">
        <div class="tc-date-time">25 сен 2026, 18:00</div>
        <div class="tc-order">#P2_003</div>
        <div class="order-desc"><div>September Item 3</div></div>
        <div class="media-user-name"><a href="/users/103/">User3</a></div>
        <div class="tc-price">1 500.00 <span class="unit">₽</span></div>
        <div class="tc-status">Закрыт</div>
      </a>
      <input type="hidden" name="continue" value="P2_003">
    </div>
  `;

  // Page 3: Old historical orders from 2024 / early 2026 (End of account history)
  const page3Html = `
    <div class="tc-wrapper">
      <a href="https://funpay.com/orders/P3_HIST1/" class="tc-item">
        <div class="tc-date-time">15 мар 2024, 10:00</div>
        <div class="tc-order">#P3_HIST1</div>
        <div class="order-desc"><div>Old 2024 Item</div></div>
        <div class="media-user-name"><a href="/users/104/">User4</a></div>
        <div class="tc-price">2 000.00 <span class="unit">₽</span></div>
        <div class="tc-status">Закрыт</div>
      </a>
    </div>
  `;

  const cursor1 = FunPayOrdersAdapter.extractNextContinueId(page1Html);
  assert.equal(cursor1, 'P1_002');

  const cursor2 = FunPayOrdersAdapter.extractNextContinueId(page2Html);
  assert.equal(cursor2, 'P2_003');

  const cursor3 = FunPayOrdersAdapter.extractNextContinueId(page3Html);
  assert.equal(cursor3, null); // Final page reached!

  const p1Orders = FunPayOrdersAdapter.parse(page1Html);
  const p2Orders = FunPayOrdersAdapter.parse(page2Html);
  const p3Orders = FunPayOrdersAdapter.parse(page3Html);

  assert.equal(p1Orders.length, 2);
  assert.equal(p2Orders.length, 2);
  assert.equal(p3Orders.length, 1);

  // Merge with deduplication (same logic as in FunPayClient.syncAllData)
  const orderMap = new Map<string, FunPayOrder>();
  for (const o of [...p1Orders, ...p2Orders, ...p3Orders]) {
    orderMap.set(o.id.toUpperCase(), o);
  }

  const allMergedOrders = Array.from(orderMap.values());
  // Total unique orders should be 4 (P1_001, P1_002, P2_003, P3_HIST1) — P1_002 is not duplicated!
  assert.equal(allMergedOrders.length, 4);

  const ids = allMergedOrders.map(o => o.id);
  assert.ok(ids.includes('P1_001'));
  assert.ok(ids.includes('P1_002'));
  assert.ok(ids.includes('P2_003'));
  assert.ok(ids.includes('P3_HIST1'));
});

// 14. Historical Orders Integration into Statistics (Before Oct 5)
test('Historical orders prior to October 5 are properly integrated into Dashboard statistics', () => {
  // Reference point: 08 Oct 2026, 12:00:00 UTC (15:00 MSK)
  const now = Date.UTC(2026, 9, 8, 12, 0, 0);

  const orders: FunPayOrder[] = [
    // Today (08 Oct 2026)
    {
      id: 'OCT08',
      description: 'Order Today',
      price: 500,
      currency: '₽',
      buyerUsername: 'B1',
      buyerId: 1,
      chatId: 'users-1',
      status: 'closed',
      dateStr: 'сегодня, 15:00',
      timestamp: now
    },
    // Oct 05 2026 (3 days ago - was previously the cutoff)
    {
      id: 'OCT05',
      description: 'Order Oct 5',
      price: 1000,
      currency: '₽',
      buyerUsername: 'B2',
      buyerId: 2,
      chatId: 'users-2',
      status: 'closed',
      dateStr: '05 окт 2026, 15:00',
      timestamp: Date.UTC(2026, 9, 5, 12, 0, 0)
    },
    // September 2026 (Older than Oct 5, within 30 days)
    {
      id: 'SEP20',
      description: 'Order Sep 20',
      price: 2000,
      currency: '₽',
      buyerUsername: 'B3',
      buyerId: 3,
      chatId: 'users-3',
      status: 'closed',
      dateStr: '20 сен 2026, 15:00',
      timestamp: Date.UTC(2026, 8, 20, 12, 0, 0)
    },
    // July 2026 (Older than 30 days, within 90 days)
    {
      id: 'JUL20',
      description: 'Order Jul 20',
      price: 3000,
      currency: '₽',
      buyerUsername: 'B4',
      buyerId: 4,
      chatId: 'users-4',
      status: 'closed',
      dateStr: '20 июл 2026, 15:00',
      timestamp: Date.UTC(2026, 6, 20, 12, 0, 0)
    },
    // March 2024 (Very old historical order, only in allTime)
    {
      id: 'MAR2024',
      description: 'Order March 2024',
      price: 5000,
      currency: '₽',
      buyerUsername: 'B5',
      buyerId: 5,
      chatId: 'users-5',
      status: 'closed',
      dateStr: '15 мар 2024, 15:00',
      timestamp: Date.UTC(2024, 2, 15, 12, 0, 0)
    }
  ];

  const sharePercent = 10;
  const stats = FunPayStatisticsAdapter.calculate(orders, sharePercent, { '₽': 5000 }, '₽', now, now);

  // 1. Today: only OCT08 (500 ₽)
  assert.equal(stats.today.currencies['₽'].turnover, 500);
  assert.equal(stats.today.currencies['₽'].sellerShare, 50);

  // 2. 7 Days: OCT08 + OCT05 = 500 + 1000 = 1500 ₽
  assert.equal(stats.last7Days.currencies['₽'].turnover, 1500);
  assert.equal(stats.last7Days.currencies['₽'].sellerShare, 150);

  // 3. 30 Days: OCT08 + OCT05 + SEP20 = 500 + 1000 + 2000 = 3500 ₽ (Includes September!)
  assert.equal(stats.last30Days.currencies['₽'].turnover, 3500);
  assert.equal(stats.last30Days.currencies['₽'].sellerShare, 350);
  assert.equal(stats.last30Days.currencies['₽'].ordersCount, 3);

  // 4. 90 Days: OCT08 + OCT05 + SEP20 + JUL20 = 500 + 1000 + 2000 + 3000 = 6500 ₽
  assert.equal(stats.last90Days.currencies['₽'].turnover, 6500);
  assert.equal(stats.last90Days.currencies['₽'].sellerShare, 650);
  assert.equal(stats.last90Days.currencies['₽'].ordersCount, 4);

  // 5. All Time: ALL orders included (500 + 1000 + 2000 + 3000 + 5000 = 11500 ₽)
  assert.equal(stats.allTime.currencies['₽'].turnover, 11500);
  assert.equal(stats.allTime.currencies['₽'].sellerShare, 1150); // 10%
  assert.equal(stats.allTime.currencies['₽'].ordersCount, 5);
  assert.equal(stats.allTime.currencies['₽'].uniqueClientsCount, 5);
});

