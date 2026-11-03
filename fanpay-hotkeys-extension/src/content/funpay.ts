import { ExtensionState, FunPayContext } from '../shared/types';
import { FunPayDomAdapter } from './adapter';
import { HotkeyManager } from './hotkeys';
import { FunPayPanel } from './panel';
import { loadState } from '../storage/storage';
import { debugLog } from '../shared/utils';

// Global guard against double execution
declare global {
  interface Window {
    __FPHK_INITIALIZED__?: boolean;
  }
}

class FunPayContentController {
  private hotkeys = new HotkeyManager();
  private panel = new FunPayPanel();
  private state: ExtensionState | null = null;
  private observer: MutationObserver | null = null;

  public async init() {
    if (window.__FPHK_INITIALIZED__) return;
    window.__FPHK_INITIALIZED__ = true;

    debugLog(false, 'FanPay Content Script initializing on', window.location.href);

    // 1. Load state directly from storage for instant responsiveness
    try {
      const localState = await loadState();
      this.applyState(localState);
    } catch {
      // Storage access will be retried via background message
    }

    // 2. Fetch fresh state from background service worker
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
      if (response && response.state) {
        this.applyState(response.state);
      }
    } catch {
      // Background might be waking up, localState is already active
    }

    this.setupMessageListener();
    this.setupMutationObserver();
  }

  private applyState(state: ExtensionState) {
    this.state = state;
    this.hotkeys.updateData(state.templates, state.settings);
    this.panel.init(
      state.profiles,
      state.templates,
      state.settings,
      (profileId) => this.handleProfileChange(profileId)
    );
  }

  private handleProfileChange(profileId: string) {
    chrome.runtime.sendMessage({
      type: 'SET_SELECTED_PROFILE',
      payload: { profileId }
    }).catch(() => {});
  }

  private setupMessageListener() {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message.type === 'STATE_UPDATED') {
        this.applyState(message.payload);
        sendResponse({ success: true });
        return true;
      }

      if (message.type === 'INSERT_MESSAGE') {
        const text = message.payload?.text || '';
        const success = FunPayDomAdapter.insertMessage(text);
        sendResponse({ success });
        return true;
      }

      if (message.type === 'GET_FUNPAY_CONTEXT') {
        const order = FunPayDomAdapter.findCurrentOrder();
        const user = FunPayDomAdapter.getCurrentUser();
        const chat = FunPayDomAdapter.findCurrentChat();

        const context: FunPayContext = {
          onFunPay: true,
          username: user,
          orderId: order.id,
          product: order.product,
          amount: order.amount,
          buyer: order.buyer,
          isChatOpen: !!chat
        };

        sendResponse(context);
        return true;
      }

      if (message.type === 'FETCH_FUNPAY_PAGE') {
        const fetchUrl = message.payload?.url || 'https://funpay.com/';
        const method = (message.payload?.method || 'GET').toUpperCase();
        const body = message.payload?.body;
        const headers: Record<string, string> = { ...(message.payload?.headers || {}) };
        if (body && !headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = 'application/x-www-form-urlencoded';
        }

        (async () => {
          try {
            const resp = await fetch(fetchUrl, {
              method,
              headers: Object.keys(headers).length > 0 ? headers : undefined,
              body: body ? body : undefined,
              credentials: 'include'
            });
            const text = await resp.text();
            sendResponse({
              success: resp.ok,
              status: resp.status,
              finalUrl: resp.url || fetchUrl,
              contentType: resp.headers.get('content-type') || '',
              html: text
            });
          } catch (err: unknown) {
            sendResponse({
              success: false,
              status: 0,
              finalUrl: fetchUrl,
              contentType: '',
              html: '',
              error: err instanceof Error ? err.message : 'Ошибка запроса из вкладки FunPay'
            });
          }
        })();
        return true;
      }

      return false;
    });
  }

  private setupMutationObserver() {
    let lastUrl = window.location.href;

    this.observer = new MutationObserver(() => {
      // 1. Detect SPA URL changes
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        if (this.state) {
          this.panel.render();
        }
      }

      // 2. Re-attach panel if chat container appeared in DOM and panel is not mounted
      const panelMounted = document.getElementById('fphk-panel-root');
      const chatPresent = FunPayDomAdapter.findCurrentChat();
      if (!panelMounted && chatPresent && this.state) {
        this.panel.render();
      }
    });

    this.observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }
}

// Bootstrap content script immediately
const controller = new FunPayContentController();
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => controller.init());
} else {
  controller.init();
}
