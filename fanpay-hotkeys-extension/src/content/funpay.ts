import { ExtensionState, FunPayContext, ShiftState } from '../shared/types';
import { FunPayDomAdapter } from './adapter';
import { HotkeyManager } from './hotkeys';
import { FunPayPanel } from './panel';
import { ShiftHudWidget } from './shift-widget';
import { loadState, loadShiftState } from '../storage/storage';
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
  private shiftWidget = new ShiftHudWidget();
  private state: ExtensionState | null = null;
  private shiftState: ShiftState | null = null;
  private observer: MutationObserver | null = null;

  public async init() {
    if (window.__FPHK_INITIALIZED__) return;
    window.__FPHK_INITIALIZED__ = true;

    debugLog(false, 'FanPay Content Script initializing on', window.location.href);

    // 1. Load state and shift state directly from storage for instant responsiveness
    try {
      const localState = await loadState();
      const localShift = await loadShiftState();
      this.shiftState = localShift;
      this.applyState(localState);
      if (localShift) {
        this.shiftWidget.init(localShift, localState);
      }
    } catch {
      // Storage access will be retried via background message
    }

    // 2. Fetch fresh state from background service worker
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
      if (response && response.state) {
        this.applyState(response.state);
      }
      const shiftResp = await chrome.runtime.sendMessage({ type: 'GET_SHIFT_STATE' });
      if (shiftResp && shiftResp.shiftState) {
        this.shiftState = shiftResp.shiftState;
        if (this.state) {
          this.shiftWidget.updateState(shiftResp.shiftState, this.state);
        }
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
    if (this.shiftState) {
      this.shiftWidget.updateState(this.shiftState, state);
    }
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
      } else if (panelMounted && !chatPresent) {
        this.panel.destroy();
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
