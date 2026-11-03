import { FunPayAccountInfo, FunPayOrder } from '../shared/types';
import { FunPayAuthResult, FunPayDiagnostics, FunPaySyncResult } from './models';
import { FunPayAccountAdapter } from './adapters/account';
import { FunPayBalanceAdapter } from './adapters/balance';
import { FunPayOrdersAdapter } from './adapters/orders';
import { debugLog } from '../shared/utils';

export interface FunPayRequestOptions {
  method?: 'GET' | 'POST';
  body?: string;
  headers?: Record<string, string>;
}

export interface FunPayFetchResult {
  html: string;
  diagnostics: FunPayDiagnostics;
}

/**
 * FunPay Web Transport Client
 * Centralized rate-limited network client for communicating with FunPay web pages.
 * Uses non-invasive Content Script transport via open FunPay tabs to preserve browser session integrity.
 * Never modifies, sets, or removes browser cookies. Never prints golden_key into console logs.
 */
export class FunPayClient {
  private static instance: FunPayClient;
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestTime = 0;
  private readonly MIN_INTERVAL_MS = 1500; // Rate limit: at least 1.5s between requests

  public static getInstance(): FunPayClient {
    if (!FunPayClient.instance) {
      FunPayClient.instance = new FunPayClient();
    }
    return FunPayClient.instance;
  }

  /**
   * Deprecated safe no-op: The extension never mutates browser cookies to protect user session.
   */
  public async setCookieIfNeeded(_goldenKey?: string): Promise<void> {
    // Intentionally no-op to protect browser session from corruption
  }

  /**
   * Deprecated safe no-op: The extension never removes browser cookies to protect user session.
   */
  public async removeCookie(): Promise<void> {
    // Intentionally no-op to protect browser session from deletion
  }

  /**
   * Attempt to fetch page through an open FunPay tab (content script proxy).
   * This provides full same-origin cookies and Cloudflare clearance without mutating cookies.
   */
  private async fetchViaContentScript(
    url: string,
    devMode: boolean,
    options?: FunPayRequestOptions
  ): Promise<FunPayFetchResult | null> {
    if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.query) {
      return null;
    }

    try {
      const tabs = await chrome.tabs.query({ url: ['*://funpay.com/*', '*://*.funpay.com/*'] });
      if (!tabs || tabs.length === 0) {
        return null;
      }

      // Prefer active tab if possible
      const targetTab = tabs.find(t => t.active && t.id) || tabs.find(t => t.id);
      if (!targetTab?.id) {
        return null;
      }

      debugLog(devMode, `Delegating request for ${url} to FunPay tab ${targetTab.id}`);

      let response = await this.sendTabFetchMessage(targetTab.id, url, options);

      // If content script was not yet loaded into this tab, try injecting it once and retry
      if (!response && chrome.scripting) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: targetTab.id },
            files: ['content.js']
          });
          await new Promise((r) => setTimeout(r, 100));
          response = await this.sendTabFetchMessage(targetTab.id, url, options);
        } catch {
          // injection failed or not permitted
        }
      }

      if (!response || !response.html) {
        return null;
      }

      const diagnostics = this.buildDiagnostics(
        response.status,
        response.finalUrl || url,
        response.contentType || 'text/html',
        response.html,
        'content-script'
      );

      return {
        html: response.html,
        diagnostics
      };
    } catch {
      return null;
    }
  }

  private async sendTabFetchMessage(
    tabId: number,
    url: string,
    options?: FunPayRequestOptions
  ): Promise<{
    success: boolean;
    status: number;
    finalUrl: string;
    contentType: string;
    html: string;
    error?: string;
  } | null> {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(
        tabId,
        {
          type: 'FETCH_FUNPAY_PAGE',
          payload: {
            url,
            method: options?.method,
            body: options?.body,
            headers: options?.headers
          }
        },
        (reply) => {
          if (chrome.runtime.lastError || !reply) {
            resolve(null);
          } else {
            resolve(reply);
          }
        }
      );
    });
  }

  /**
   * Build structured diagnostics for FunPay response.
   * Analyzes status code, redirect URL, Cloudflare challenges, and login form presence.
   */
  private buildDiagnostics(
    status: number,
    finalUrl: string,
    contentType: string,
    html: string,
    source: 'content-script' | 'background-fetch',
    customDetails?: string
  ): FunPayDiagnostics {
    if (customDetails) {
      return {
        status,
        finalUrl,
        contentType,
        hasUserElement: false,
        hasLoginForm: false,
        isCloudflare: false,
        details: customDetails,
        source
      };
    }

    const isCloudflare =
      status === 403 ||
      status === 503 ||
      html.includes('cf-browser-verification') ||
      html.includes('Just a moment...') ||
      html.includes('challenge-platform') ||
      html.includes('Attention Required! | Cloudflare') ||
      (html.includes('Cloudflare') && html.includes('Ray ID'));

    const hasUserElement =
      /class=["'][^"']*user-link-name[^"']*/i.test(html) ||
      /<body[^>]*data-app-data=["'][^"']*userId[^"']*/i.test(html);

    const hasLoginForm =
      html.includes('/account/login') ||
      html.includes('login-form') ||
      html.includes('class="login-link"') ||
      finalUrl.includes('/account/login');

    let details = '';
    if (isCloudflare) {
      details = `Блокировка Cloudflare (HTTP ${status} / Проверка бота). Откройте сайт funpay.com в активной вкладке браузера.`;
    } else if (hasUserElement) {
      details = `Сессия подтверждена: найден профиль пользователя (HTTP ${status}).`;
    } else if (hasLoginForm) {
      details = `Сессия не авторизована: FunPay возвращает форму входа гостя. Ключ не принят.`;
    } else {
      details = `Неожиданный ответ FunPay (HTTP ${status}, ${contentType || 'нет типа'}).`;
    }

    return {
      status,
      finalUrl,
      contentType,
      hasUserElement,
      hasLoginForm,
      isCloudflare,
      details,
      source
    };
  }

  /**
   * Enqueue a rate-limited request to FunPay safely through an open FunPay tab.
   * Never touches or mutates cookies.
   */
  private async executeRequest(
    url: string,
    _goldenKey?: string,
    devMode = false,
    options?: FunPayRequestOptions
  ): Promise<FunPayFetchResult> {
    return new Promise<FunPayFetchResult>((resolve, reject) => {
      this.queue = this.queue.then(async () => {
        try {
          const now = Date.now();
          const elapsed = now - this.lastRequestTime;
          if (elapsed < this.MIN_INTERVAL_MS) {
            await new Promise((r) => setTimeout(r, this.MIN_INTERVAL_MS - elapsed));
          }

          let attempt = 0;
          const maxAttempts = 2;
          let lastResult: FunPayFetchResult | null = null;

          while (attempt < maxAttempts) {
            attempt++;
            this.lastRequestTime = Date.now();

            debugLog(devMode, `Requesting FunPay URL: ${url} [${options?.method || 'GET'}] (attempt ${attempt})`);

            // Delegate request safely to open FunPay tab content script
            const tabResult = await this.fetchViaContentScript(url, devMode, options);
            if (tabResult) {
              lastResult = tabResult;

              if (lastResult.diagnostics.status === 429 && attempt < maxAttempts) {
                const backoff = Math.min(2000 * Math.pow(2, attempt), 10000);
                debugLog(devMode, `FunPay 429 Too Many Requests. Backoff ${backoff}ms`);
                await new Promise((r) => setTimeout(r, backoff));
                continue;
              }

              break;
            }

            // Tab not found or not responding on this attempt
            break;
          }

          if (!lastResult) {
            lastResult = {
              html: '',
              diagnostics: this.buildDiagnostics(
                0,
                url,
                '',
                '',
                'content-script',
                'Вкладка funpay.com не найдена. Откройте сайт FunPay в любой вкладке браузера для безопасной синхронизации.'
              )
            };
          }

          resolve(lastResult);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Неизвестная ошибка запроса к FunPay';
          reject(new Error(msg));
        }
      });
    });
  }

  /**
   * Test connection using manual golden_key token with full diagnostics.
   */
  public async testConnection(goldenKey?: string, devMode = false): Promise<FunPayAuthResult> {
    if (!goldenKey || !goldenKey.trim()) {
      return {
        authenticated: false,
        user: null,
        error: 'Токен golden_key не указан. Введите токен в настройках.'
      };
    }

    try {
      const { html, diagnostics } = await this.executeRequest('https://funpay.com/', goldenKey, devMode);

      if (!html) {
        return {
          authenticated: false,
          user: null,
          error: diagnostics.details || 'Вкладка funpay.com не найдена. Откройте сайт FunPay в активной вкладке браузера для проверки подключения.',
          diagnostics
        };
      }

      if (diagnostics.isCloudflare) {
        return {
          authenticated: false,
          user: null,
          error: 'Защита Cloudflare (HTTP 403 / Проверка браузера). Откройте сайт funpay.com в активной вкладке браузера, чтобы пройти проверку.',
          diagnostics
        };
      }

      const accountBase = FunPayAccountAdapter.parse(html);
      if (!accountBase) {
        let errorMsg = 'Не удалось авторизоваться. Проверьте значение golden_key.';
        if (diagnostics.hasLoginForm) {
          errorMsg = 'Ключ отклонен FunPay: возвращена страница входа гостя. Проверьте правильность и срок действия golden_key.';
        }
        return {
          authenticated: false,
          user: null,
          error: errorMsg,
          diagnostics
        };
      }

      const balanceData = FunPayBalanceAdapter.parse(html);
      const user: FunPayAccountInfo = {
        ...accountBase,
        totalBalance: balanceData.totalBalance,
        currency: balanceData.currency,
        balancesByCurrency: balanceData.balancesByCurrency
      };

      return {
        authenticated: true,
        user,
        diagnostics
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Ошибка подключения к FunPay';
      return {
        authenticated: false,
        user: null,
        error: msg
      };
    }
  }

  /**
   * Synchronize account identity, real balance and complete trade orders history.
   * Supports multi-page pagination using FunPay continue cursor, safe early termination
   * when connecting with existing cached history, and deduplication by order ID.
   */
  public async syncAllData(
    goldenKey?: string,
    devMode = false,
    existingOrders: FunPayOrder[] = [],
    maxPages = 20
  ): Promise<FunPaySyncResult> {
    if (!goldenKey || !goldenKey.trim()) {
      return {
        success: false,
        account: null,
        orders: [],
        error: 'Токен golden_key не задан в настройках. Укажите его для синхронизации.'
      };
    }

    try {
      // 1. Fetch main page to extract account and true balance
      const { html: mainHtml, diagnostics: mainDiag } = await this.executeRequest('https://funpay.com/', goldenKey, devMode);

      if (!mainHtml) {
        return {
          success: false,
          account: null,
          orders: [],
          error: mainDiag.details || 'Вкладка funpay.com не найдена. Откройте сайт FunPay в любой вкладке браузера для синхронизации данных.',
          diagnostics: mainDiag
        };
      }

      if (mainDiag.isCloudflare) {
        return {
          success: false,
          account: null,
          orders: [],
          error: 'Синхронизация прервана: защита Cloudflare. Откройте funpay.com в браузере.',
          diagnostics: mainDiag
        };
      }

      const accountBase = FunPayAccountAdapter.parse(mainHtml);
      if (!accountBase) {
        return {
          success: false,
          account: null,
          orders: [],
          error: mainDiag.hasLoginForm
            ? 'Сессия FunPay не активна (форма входа). Проверьте golden_key.'
            : 'Не удалось определить профиль продавца на FunPay.',
          diagnostics: mainDiag
        };
      }

      const balanceData = FunPayBalanceAdapter.parse(mainHtml);
      const account: FunPayAccountInfo = {
        ...accountBase,
        totalBalance: balanceData.totalBalance,
        currency: balanceData.currency,
        balancesByCurrency: balanceData.balancesByCurrency
      };

      // 2. Fetch sales history with cursor pagination
      const { html: firstPageHtml, diagnostics: ordersDiag } = await this.executeRequest('https://funpay.com/orders/trade', goldenKey, devMode);

      if (!firstPageHtml) {
        return {
          success: false,
          account,
          orders: [],
          error: ordersDiag.details || 'Не удалось загрузить историю заказов FunPay.',
          diagnostics: ordersDiag
        };
      }

      if (ordersDiag.isCloudflare) {
        return {
          success: false,
          account,
          orders: [],
          error: 'Синхронизация заказов прервана: защита Cloudflare.',
          diagnostics: ordersDiag
        };
      }

      // --- DIAGNOSTIC INVESTIGATION PIPELINE (3-Page Inspector) ---
      const diagLogs: string[] = [];
      diagLogs.push('================================================================================');
      diagLogs.push('ДИАГНОСТИЧЕСКИЙ ОТЧЁТ ПАГИНАЦИИ И ИСТОРИИ ЗАКАЗОВ FUNPAY');
      diagLogs.push('================================================================================');
      diagLogs.push(`Время запуска: ${new Date().toISOString()}`);
      diagLogs.push(`Пользователь: ${account.username} (Баланс: ${account.totalBalance} ${account.currency})`);

      // 1. Inspect Page 1
      const p1Inspection = FunPayOrdersAdapter.inspectPaginationForm(firstPageHtml);
      const firstPageOrders = FunPayOrdersAdapter.parse(firstPageHtml);
      const p1Continue = FunPayOrdersAdapter.extractNextContinueId(firstPageHtml);

      diagLogs.push('\n[1. СТРАНИЦА 1]');
      diagLogs.push(`* URL: https://funpay.com/orders/trade`);
      diagLogs.push(`* HTTP Status: ${ordersDiag.status}`);
      diagLogs.push(`* Длина HTML: ${firstPageHtml.length} символов`);
      diagLogs.push(`* Найдено заказов (карточек): ${firstPageOrders.length}`);
      if (firstPageOrders.length > 0) {
        diagLogs.push(`* Самый свежий заказ на стр. 1: #${firstPageOrders[0].id} (дата: ${firstPageOrders[0].dateStr})`);
        diagLogs.push(`* Самый старый заказ на стр. 1: #${firstPageOrders[firstPageOrders.length - 1].id} (дата: ${firstPageOrders[firstPageOrders.length - 1].dateStr})`);
      }
      diagLogs.push(`* Найден ли continue: ${p1Continue ? 'ДА' : 'НЕТ'}`);
      diagLogs.push(`* Значение continue: ${p1Continue ?? 'отсутствует'}`);

      // Inspect pagination form / button block
      diagLogs.push('\n[2. БЛОК ПАГИНАЦИИ НА СТРАНИЦЕ 1]');
      diagLogs.push(`* Form action: ${p1Inspection.formAction ?? 'не указан (отсутствует атрибут action)'}`);
      diagLogs.push(`* Form method: ${p1Inspection.formMethod ?? 'не указан (отсутствует атрибут method)'}`);
      diagLogs.push(`* Скрытые поля: ${p1Inspection.hiddenInputs.length > 0 ? p1Inspection.hiddenInputs.map(i => `${i.name}="${i.value}"`).join(', ') : 'скрытые поля не найдены'}`);
      diagLogs.push(`* Имя поля пагинации: continue (значение: ${p1Inspection.continueValue ?? 'нет'})`);
      diagLogs.push(`* Сырой HTML-фрагмент блока:\n  ${p1Inspection.snippet.replace(/\s+/g, ' ')}`);

      const fetchedOrdersMap = new Map<string, FunPayOrder>();
      for (const order of firstPageOrders) {
        fetchedOrdersMap.set(order.id.toUpperCase(), order);
      }

      // 2. Test Page 2: Compare POST vs GET
      let p2Continue: string | null = null;
      let p2WorkingMethod: 'POST' | 'GET' | 'NONE' = 'NONE';
      let page2Orders: FunPayOrder[] = [];

      if (p1Continue) {
        diagLogs.push('\n[3. СТРАНИЦА 2 — ТЕСТИРОВАНИЕ POST vs GET]');

        // 2a. POST test
        const postUrl = 'https://funpay.com/orders/trade';
        const postBody = `continue=${encodeURIComponent(p1Continue)}`;
        const { html: postHtml, diagnostics: postDiag } = await this.executeRequest(
          postUrl,
          goldenKey,
          devMode,
          {
            method: 'POST',
            body: postBody,
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'X-Requested-With': 'XMLHttpRequest'
            }
          }
        );
        const postOrders = FunPayOrdersAdapter.parse(postHtml);
        const postNextContinue = FunPayOrdersAdapter.extractNextContinueId(postHtml);
        const postNewOrders = postOrders.filter(o => !fetchedOrdersMap.has(o.id.toUpperCase()));

        diagLogs.push(`* Тест POST: URL=${postUrl}, body="${postBody}"`);
        diagLogs.push(`  - HTTP status: ${postDiag.status}, HTML длина: ${postHtml.length}`);
        diagLogs.push(`  - Распарсено заказов: ${postOrders.length} (из них НОВЫХ, отсутствующих на стр. 1: ${postNewOrders.length})`);
        if (postOrders.length > 0) {
          diagLogs.push(`  - Первый: #${postOrders[0].id} (${postOrders[0].dateStr}), Последний: #${postOrders[postOrders.length - 1].id} (${postOrders[postOrders.length - 1].dateStr})`);
        }
        diagLogs.push(`  - Следующий continue: ${postNextContinue ?? 'нет'}`);

        // 2b. GET test
        const getUrl = `https://funpay.com/orders/trade?continue=${encodeURIComponent(p1Continue)}`;
        const { html: getHtml, diagnostics: getDiag } = await this.executeRequest(
          getUrl,
          goldenKey,
          devMode,
          { method: 'GET' }
        );
        const getOrders = FunPayOrdersAdapter.parse(getHtml);
        const getNextContinue = FunPayOrdersAdapter.extractNextContinueId(getHtml);
        const getNewOrders = getOrders.filter(o => !fetchedOrdersMap.has(o.id.toUpperCase()));

        diagLogs.push(`* Тест GET: URL=${getUrl}`);
        diagLogs.push(`  - HTTP status: ${getDiag.status}, HTML длина: ${getHtml.length}`);
        diagLogs.push(`  - Распарсено заказов: ${getOrders.length} (из них НОВЫХ, отсутствующих на стр. 1: ${getNewOrders.length})`);
        if (getOrders.length > 0) {
          diagLogs.push(`  - Первый: #${getOrders[0].id} (${getOrders[0].dateStr}), Последний: #${getOrders[getOrders.length - 1].id} (${getOrders[getOrders.length - 1].dateStr})`);
        }
        diagLogs.push(`  - Следующий continue: ${getNextContinue ?? 'нет'}`);

        // Choose the method that provided new orders
        if (postNewOrders.length > 0) {
          p2WorkingMethod = 'POST';
          page2Orders = postOrders;
          p2Continue = postNextContinue;
        } else if (getNewOrders.length > 0) {
          p2WorkingMethod = 'GET';
          page2Orders = getOrders;
          p2Continue = getNextContinue;
        } else if (postOrders.length > 0) {
          p2WorkingMethod = 'POST';
          page2Orders = postOrders;
          p2Continue = postNextContinue;
        } else if (getOrders.length > 0) {
          p2WorkingMethod = 'GET';
          page2Orders = getOrders;
          p2Continue = getNextContinue;
        }

        diagLogs.push(`* ВЫБОР МЕТОДА: ${p2WorkingMethod} (новых заказов: ${page2Orders.length})`);

        for (const order of page2Orders) {
          fetchedOrdersMap.set(order.id.toUpperCase(), order);
        }
      } else {
        diagLogs.push('\n[3. СТРАНИЦА 2]');
        diagLogs.push('* Пропущена: поле continue на первой странице не найдено.');
      }

      // 3. Test Page 3
      let page3Orders: FunPayOrder[] = [];
      let p3Continue: string | null = null;
      if (p2Continue) {
        diagLogs.push('\n[4. СТРАНИЦА 3]');
        const p3Method = p2WorkingMethod === 'GET' ? 'GET' : 'POST';
        const p3Url = p3Method === 'GET'
          ? `https://funpay.com/orders/trade?continue=${encodeURIComponent(p2Continue)}`
          : 'https://funpay.com/orders/trade';
        const p3Options = p3Method === 'POST'
          ? {
              method: 'POST',
              body: `continue=${encodeURIComponent(p2Continue)}`,
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-Requested-With': 'XMLHttpRequest'
              }
            }
          : { method: 'GET' };

        const { html: p3Html, diagnostics: p3Diag } = await this.executeRequest(
          p3Url,
          goldenKey,
          devMode,
          p3Options
        );
        page3Orders = FunPayOrdersAdapter.parse(p3Html);
        p3Continue = FunPayOrdersAdapter.extractNextContinueId(p3Html);
        const p3NewOrders = page3Orders.filter(o => !fetchedOrdersMap.has(o.id.toUpperCase()));

        diagLogs.push(`* Метод: ${p3Method}, URL: ${p3Url}`);
        diagLogs.push(`* HTTP Status: ${p3Diag.status}, Длина HTML: ${p3Html.length}`);
        diagLogs.push(`* Распарсено заказов: ${page3Orders.length} (из них НОВЫХ: ${p3NewOrders.length})`);
        if (page3Orders.length > 0) {
          diagLogs.push(`* Первый заказ на стр. 3: #${page3Orders[0].id} (дата: ${page3Orders[0].dateStr})`);
          diagLogs.push(`* Последний заказ на стр. 3: #${page3Orders[page3Orders.length - 1].id} (дата: ${page3Orders[page3Orders.length - 1].dateStr})`);
        }
        diagLogs.push(`* Следующий continue после стр. 3: ${p3Continue ?? 'нет'}`);

        for (const order of page3Orders) {
          fetchedOrdersMap.set(order.id.toUpperCase(), order);
        }
      } else {
        diagLogs.push('\n[4. СТРАНИЦА 3]');
        diagLogs.push('* Пропущена: на второй странице отсутствует следующий continue.');
      }

      // 4. Merge freshly fetched orders with existing cached orders
      const totalRawFetched = firstPageOrders.length + page2Orders.length + page3Orders.length;
      const totalFreshDeduped = fetchedOrdersMap.size;

      const mergedMap = new Map<string, FunPayOrder>();
      for (const order of existingOrders) {
        mergedMap.set(order.id.toUpperCase(), order);
      }
      for (const [id, order] of fetchedOrdersMap.entries()) {
        mergedMap.set(id, order);
      }

      // Sort by UTC timestamp descending (newest first)
      const allOrders = Array.from(mergedMap.values()).sort((a, b) => b.timestamp - a.timestamp);
      const freshlyFetchedSorted = Array.from(fetchedOrdersMap.values()).sort((a, b) => b.timestamp - a.timestamp);

      diagLogs.push('\n[5. МЕТРИКИ PIPELINE И КЕША]');
      diagLogs.push(`* Стр. 1: заказов ${firstPageOrders.length}${firstPageOrders.length > 0 ? `, даты от "${firstPageOrders[0].dateStr}" до "${firstPageOrders[firstPageOrders.length - 1].dateStr}"` : ''}, continue = ${p1Continue ?? 'нет'}`);
      diagLogs.push(`* Стр. 2: заказов ${page2Orders.length}${page2Orders.length > 0 ? `, даты от "${page2Orders[0].dateStr}" до "${page2Orders[page2Orders.length - 1].dateStr}"` : ''}, continue = ${p2Continue ?? 'нет'}`);
      diagLogs.push(`* Стр. 3: заказов ${page3Orders.length}${page3Orders.length > 0 ? `, даты от "${page3Orders[0].dateStr}" до "${page3Orders[page3Orders.length - 1].dateStr}"` : ''}, continue = ${p3Continue ?? 'нет'}`);
      diagLogs.push(`* Всего скачано (сумма карточек со всех 3 страниц): ${totalRawFetched}`);
      diagLogs.push(`* Уникальных заказов после дедупликации в текущей сессии: ${totalFreshDeduped}`);
      diagLogs.push(`* Заказов было в локальном кеше: ${existingOrders.length}`);
      diagLogs.push(`* Итого заказов после слияния с кешем: ${allOrders.length}`);
      if (freshlyFetchedSorted.length > 0) {
        const oldestFresh = freshlyFetchedSorted[freshlyFetchedSorted.length - 1];
        diagLogs.push(`* Самый старый заказ в СКАЧАННЫХ данных: #${oldestFresh.id} (дата: ${oldestFresh.dateStr})`);
      }
      if (allOrders.length > 0) {
        const oldestCached = allOrders[allOrders.length - 1];
        diagLogs.push(`* Самый старый заказ в ИТОГОВОМ КЕШЕ: #${oldestCached.id} (дата: ${oldestCached.dateStr})`);
      }

      diagLogs.push('\n[6. ТОП-5 САМЫХ СВЕЖИХ ЗАКАЗОВ]');
      const top5Newest = allOrders.slice(0, 5);
      top5Newest.forEach((o, i) => {
        diagLogs.push(`  ${i + 1}. #${o.id} | ${o.dateStr} | ${o.price !== null ? `${o.price} ${o.currency}` : 'нет цены'} | ${o.status} | Покупатель: ${o.buyerUsername || '—'}`);
      });

      diagLogs.push('\n[7. ТОП-5 САМЫХ СТАРЫХ ЗАКАЗОВ]');
      const top5Oldest = allOrders.slice(Math.max(0, allOrders.length - 5)).reverse();
      top5Oldest.forEach((o, i) => {
        diagLogs.push(`  ${i + 1}. #${o.id} | ${o.dateStr} | ${o.price !== null ? `${o.price} ${o.currency}` : 'нет цены'} | ${o.status} | Покупатель: ${o.buyerUsername || '—'}`);
      });

      diagLogs.push('================================================================================');

      const fullReportText = diagLogs.join('\n');
      ordersDiag.diagnosticReport = fullReportText;

      console.log(fullReportText);
      debugLog(
        devMode,
        `FunPay sync complete: user=${account.username}, balance=${account.totalBalance}, totalOrders=${allOrders.length}`
      );

      return {
        success: true,
        account,
        orders: allOrders,
        diagnostics: ordersDiag
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Не удалось синхронизировать данные с FunPay';
      return {
        success: false,
        account: null,
        orders: [],
        error: msg
      };
    }
  }
}
