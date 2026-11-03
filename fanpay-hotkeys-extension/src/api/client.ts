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

  private async reportProgress(progress: import('../shared/types').SyncProgress): Promise<void> {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        await chrome.storage.local.set({ fphk_sync_progress: progress });
      }
    } catch {
      // ignore
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
    fetchAllHistory = false,
    maxPages = fetchAllHistory ? 100 : 20
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
      await this.reportProgress({
        inProgress: true,
        page: 1,
        totalOrdersFetched: 0,
        newOrdersFetched: 0,
        stage: 'Загрузка первой страницы заказов...'
      });

      const { html: firstPageHtml, diagnostics: ordersDiag } = await this.executeRequest('https://funpay.com/orders/trade', goldenKey, devMode);

      if (!firstPageHtml) {
        await this.reportProgress({
          inProgress: false,
          page: 1,
          totalOrdersFetched: 0,
          newOrdersFetched: 0,
          stage: 'Ошибка загрузки',
          error: ordersDiag.details || 'Не удалось загрузить историю заказов FunPay.'
        });
        return {
          success: false,
          account,
          orders: [],
          error: ordersDiag.details || 'Не удалось загрузить историю заказов FunPay.',
          diagnostics: ordersDiag
        };
      }

      if (ordersDiag.isCloudflare) {
        await this.reportProgress({
          inProgress: false,
          page: 1,
          totalOrdersFetched: 0,
          newOrdersFetched: 0,
          stage: 'Ошибка Cloudflare',
          error: 'Синхронизация заказов прервана: защита Cloudflare.'
        });
        return {
          success: false,
          account,
          orders: [],
          error: 'Синхронизация заказов прервана: защита Cloudflare.',
          diagnostics: ordersDiag
        };
      }

      const firstPageOrders = FunPayOrdersAdapter.parse(firstPageHtml);
      const p1Continue = FunPayOrdersAdapter.extractNextContinueId(firstPageHtml);

      const fetchedOrdersMap = new Map<string, FunPayOrder>();
      for (const order of firstPageOrders) {
        fetchedOrdersMap.set(order.id.toUpperCase(), order);
      }

      let currentContinue = p1Continue;
      let currentPage = 1;
      let workingMethod: 'POST' | 'GET' = 'POST';

      await this.reportProgress({
        inProgress: true,
        page: 1,
        totalOrdersFetched: firstPageOrders.length,
        newOrdersFetched: firstPageOrders.length,
        oldestOrderDate: firstPageOrders.length > 0 ? firstPageOrders[firstPageOrders.length - 1].dateStr : undefined,
        stage: `Страница 1: найдено ${firstPageOrders.length} заказов`
      });

      const existingIds = new Set(existingOrders.map(o => o.id.toUpperCase()));

      // 3. Multi-page pagination loop
      while (currentContinue && currentPage < maxPages) {
        currentPage++;

        let pageHtml = '';
        let pageDiag: FunPayDiagnostics | null = null;

        // Try POST first
        if (workingMethod === 'POST') {
          const res = await this.executeRequest(
            'https://funpay.com/orders/trade',
            goldenKey,
            devMode,
            {
              method: 'POST',
              body: `continue=${encodeURIComponent(currentContinue)}`,
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-Requested-With': 'XMLHttpRequest'
              }
            }
          );
          pageHtml = res.html;
          pageDiag = res.diagnostics;
        }

        let pageOrders = pageHtml ? FunPayOrdersAdapter.parse(pageHtml) : [];

        // If POST returned 0 orders or failed, try GET fallback
        if (pageOrders.length === 0) {
          const res = await this.executeRequest(
            `https://funpay.com/orders/trade?continue=${encodeURIComponent(currentContinue)}`,
            goldenKey,
            devMode,
            { method: 'GET' }
          );
          if (res.html) {
            const getOrders = FunPayOrdersAdapter.parse(res.html);
            if (getOrders.length > 0) {
              workingMethod = 'GET';
              pageHtml = res.html;
              pageDiag = res.diagnostics;
              pageOrders = getOrders;
            }
          }
        }

        if (pageOrders.length === 0) {
          debugLog(devMode, `Page ${currentPage} returned 0 orders. Reached end of history.`);
          break;
        }

        let newOrdersOnPage = 0;
        let existingOrdersHit = 0;

        for (const order of pageOrders) {
          const upperId = order.id.toUpperCase();
          if (!fetchedOrdersMap.has(upperId)) {
            newOrdersOnPage++;
            fetchedOrdersMap.set(upperId, order);
          }
          if (existingIds.has(upperId)) {
            existingOrdersHit++;
          }
        }

        const nextContinue = FunPayOrdersAdapter.extractNextContinueId(pageHtml);

        await this.reportProgress({
          inProgress: true,
          page: currentPage,
          totalOrdersFetched: fetchedOrdersMap.size,
          newOrdersFetched: newOrdersOnPage,
          oldestOrderDate: pageOrders[pageOrders.length - 1]?.dateStr,
          stage: `Страница ${currentPage}: загружено +${pageOrders.length} заказов (всего ${fetchedOrdersMap.size})`
        });

        // Incremental sync early stopping:
        // If not full history mode and all orders on this page are already known, stop!
        if (!fetchAllHistory && existingOrdersHit === pageOrders.length && existingOrders.length > 0) {
          debugLog(devMode, `Incremental sync reached known orders on page ${currentPage}. Stopping.`);
          break;
        }

        // Prevent infinite loops on broken/static cursor
        if (!nextContinue || nextContinue === currentContinue) {
          debugLog(devMode, `No further continue cursor found on page ${currentPage}. Reached end of history.`);
          break;
        }

        currentContinue = nextContinue;
      }

      // 4. Merge freshly fetched orders with existing cached orders
      const mergedMap = new Map<string, FunPayOrder>();
      for (const order of existingOrders) {
        mergedMap.set(order.id.toUpperCase(), order);
      }
      for (const [id, order] of fetchedOrdersMap.entries()) {
        mergedMap.set(id, order);
      }

      // Sort by UTC timestamp descending (newest first)
      const allOrders = Array.from(mergedMap.values()).sort((a, b) => b.timestamp - a.timestamp);

      await this.reportProgress({
        inProgress: false,
        page: currentPage,
        totalOrdersFetched: allOrders.length,
        newOrdersFetched: fetchedOrdersMap.size,
        stage: `Синхронизация завершена. Всего в базе: ${allOrders.length} заказов (${currentPage} стр.)`,
        complete: true
      });

      debugLog(
        devMode,
        `FunPay sync complete: user=${account.username}, balance=${account.totalBalance}, totalOrders=${allOrders.length}`
      );

      return {
        success: true,
        account,
        orders: allOrders,
        pagesFetched: currentPage,
        totalFetched: allOrders.length,
        newFetched: fetchedOrdersMap.size,
        diagnostics: ordersDiag
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Не удалось синхронизировать данные с FunPay';
      await this.reportProgress({
        inProgress: false,
        page: 0,
        totalOrdersFetched: 0,
        newOrdersFetched: 0,
        stage: 'Ошибка синхронизации',
        error: msg
      });
      return {
        success: false,
        account: null,
        orders: [],
        error: msg
      };
    }
  }
}
