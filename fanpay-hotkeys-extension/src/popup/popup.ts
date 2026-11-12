import { CompletedShift, ExtensionState, ShiftState } from '../shared/types';
import { calculateShiftEarnings, formatMoney } from '../shared/utils';
import { formatDuration, formatTimeOnly } from '../shared/datetime';

class PopupController {
  private state: ExtensionState | null = null;
  private shiftState: ShiftState = { shiftActive: false, shiftStartTime: null };
  private shiftTimerInterval: number | null = null;
  private lastCompletedShift: CompletedShift | null = null;
  private isShiftCollapsed = false;

  public async init() {
    this.bindEvents();
    await this.loadAndRenderState();
    await this.loadAndRenderShift();
  }

  private bindEvents() {
    // Sync button
    const btnSync = document.getElementById('btn-sync');
    btnSync?.addEventListener('click', async () => {
      this.setSyncingState(true);
      try {
        const res = await chrome.runtime.sendMessage({ type: 'SYNC_DATA' });
        if (res && res.success) {
          await this.loadAndRenderState();
        } else {
          console.warn('Sync warning:', res?.error);
        }
      } catch (err: unknown) {
        console.warn('Sync connection error:', err);
      } finally {
        this.setSyncingState(false);
      }
    });

    // Options button (gear icon)
    document.getElementById('btn-options')?.addEventListener('click', () => {
      chrome.runtime.openOptionsPage();
    });

    // Stats / Settings button in dock
    document.getElementById('btn-stats')?.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#general') });
    });

    // Web Dashboard (Site) button
    document.getElementById('btn-web-dashboard')?.addEventListener('click', () => {
      chrome.tabs.create({ url: 'https://makdakich.github.io/funpay-team-dashboard/' });
    });

    // Profile select change
    const profileSelect = document.getElementById('profile-select') as HTMLSelectElement;
    profileSelect?.addEventListener('change', async (e) => {
      const profileId = (e.target as HTMLSelectElement).value;
      await chrome.runtime.sendMessage({
        type: 'SET_SELECTED_PROFILE',
        payload: { profileId }
      });
      await this.loadAndRenderState();
    });

    // Navigation dock buttons
    document.getElementById('btn-nav-shifts')?.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#shifts') });
    });

    const openTemplatesTab = () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#templates') });
    };
    document.getElementById('btn-nav-templates')?.addEventListener('click', openTemplatesTab);
    document.getElementById('btn-popup-open-templates')?.addEventListener('click', openTemplatesTab);

    document.getElementById('btn-nav-orders')?.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#orders') });
    });

    const openCloudSettings = () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#api') });
    };

    document.getElementById('btn-nav-cloud')?.addEventListener('click', openCloudSettings);
    document.getElementById('popup-cloud-badge')?.addEventListener('click', openCloudSettings);

    // Shift toggle button
    document.getElementById('btn-toggle-shift')?.addEventListener('click', async () => {
      await this.handleToggleShift();
    });

    // Shift history open button
    document.getElementById('btn-open-shift-history')?.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#shifts') });
    });

    // Restore popup shift collapse state
    try {
      this.isShiftCollapsed = localStorage.getItem('fphk_popup_shift_collapsed') === 'true';
    } catch {
      // ignore
    }

    // Shift collapse & expand toggle buttons
    document.getElementById('btn-popup-shift-collapse')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.isShiftCollapsed = true;
      try { localStorage.setItem('fphk_popup_shift_collapsed', 'true'); } catch {}
      this.renderShiftState();
    });

    const expandPopupShift = (e: Event) => {
      e.stopPropagation();
      this.isShiftCollapsed = false;
      try { localStorage.setItem('fphk_popup_shift_collapsed', 'false'); } catch {}
      this.renderShiftState();
    };

    document.getElementById('shift-collapsed-box')?.addEventListener('click', expandPopupShift);
    document.getElementById('btn-popup-shift-expand')?.addEventListener('click', expandPopupShift);
  }

  private async loadAndRenderState() {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
      if (res?.state) {
        this.state = res.state;
      }
    } catch {
      // background waking up
    }

    // Operator suggestions & initial input
    const datalist = document.getElementById('operator-suggestions');
    if (datalist && this.state?.settings?.operatorsList) {
      datalist.innerHTML = this.state.settings.operatorsList
        .map(op => `<option value="${op}">`)
        .join('');
    }
    const opInput = document.getElementById('shift-operator-input') as HTMLInputElement | null;
    if (opInput && !opInput.value) {
      opInput.value = this.shiftState.currentOperator || this.state?.settings?.lastOperator || 'Алекс';
    }

    // Render Profiles Dropdown
    const select = document.getElementById('profile-select') as HTMLSelectElement;
    if (select && this.state) {
      select.innerHTML = '';
      const activeProfId = this.state.settings.selectedProfileId || this.state.settings.activeProfileId;
      for (const p of this.state.profiles) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name;
        if (p.id === activeProfId) {
          opt.selected = true;
        }
        select.appendChild(opt);
      }
    }

    // Render Quick Action Templates Palette
    this.renderQuickTemplates();

    // Render Cloud Auth state
    await this.renderCloudState();

    // Account & Balance Status
    const balanceVal = document.getElementById('balance-val');
    const syncOrdersCount = document.getElementById('sync-orders-count');
    const shopBadge = document.getElementById('shop-name-badge');
    const cardShopName = document.getElementById('card-shop-name');
    const cardShopId = document.getElementById('card-shop-id');

    const ordersCount = this.state?.cache?.orders?.length || 0;
    if (syncOrdersCount) {
      syncOrdersCount.textContent = `${ordersCount} зак.`;
    }

    if (this.state?.cache.accountInfo) {
      const acc = this.state.cache.accountInfo;
      if (balanceVal) balanceVal.textContent = formatMoney(acc.totalBalance, acc.currency);
      const name = acc.username || 'Hopeoflove';
      if (shopBadge) shopBadge.textContent = `🏪 ${name}`;
      if (cardShopName) cardShopName.textContent = name;
      if (cardShopId) cardShopId.textContent = acc.userId ? `#${acc.userId}` : '#4473774';
    } else {
      if (balanceVal) balanceVal.textContent = '0 ₽';
      if (shopBadge) shopBadge.textContent = '🏪 Hopeoflove';
      if (cardShopName) cardShopName.textContent = 'Hopeoflove';
      if (cardShopId) cardShopId.textContent = '#4473774';
    }
  }

  private async renderCloudState() {
    const cloudBadge = document.getElementById('popup-cloud-badge');
    const cloudText = document.getElementById('popup-cloud-text');
    if (!cloudBadge || !cloudText) return;

    try {
      const authRes = await chrome.runtime.sendMessage({ type: 'GET_CLOUD_AUTH_STATE' });
      const auth = authRes?.auth;

      if (auth && auth.user) {
        cloudBadge.className = 'connection-status-pill connected';
        const displayUser = auth.user.email?.split('@')[0] || auth.user.role || 'Подключено';
        cloudText.textContent = `🟢 ${displayUser}`;
        cloudBadge.title = `Подключено к Supabase как ${auth.user.email} (${auth.role || 'creator'})`;
      } else {
        cloudBadge.className = 'connection-status-pill warning';
        cloudText.textContent = '⚠️ Вход в облако';
        cloudBadge.title = 'Нажмите, чтобы войти в облако команды';
      }
    } catch {
      cloudBadge.className = 'connection-status-pill';
      cloudText.textContent = 'Облако: офлайн';
    }
  }

  private setSyncingState(syncing: boolean) {
    const btn = document.getElementById('btn-sync');
    if (btn) {
      btn.innerHTML = syncing ? '<span class="icon">⏳</span>' : '<span class="icon">🔄</span>';
      (btn as HTMLButtonElement).disabled = syncing;
    }
  }

  private async loadAndRenderShift() {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_SHIFT_STATE' });
      if (res && res.shiftState) {
        this.shiftState = res.shiftState;
      }
    } catch {
      // Background waking up
    }
    this.renderShiftState();
  }

  private renderShiftState() {
    if (this.shiftTimerInterval !== null) {
      clearInterval(this.shiftTimerInterval);
      this.shiftTimerInterval = null;
    }

    const cockpit = document.getElementById('shift-cockpit');
    const badge = document.getElementById('shift-badge');
    const idleBox = document.getElementById('shift-idle-box');
    const activeBox = document.getElementById('shift-active-box');
    const timerVal = document.getElementById('shift-timer');
    const startTimeEl = document.getElementById('shift-start-time');
    const activeOpBadge = document.getElementById('shift-active-op-badge');
    const ordersCountEl = document.getElementById('shift-orders-count');
    const liveTurnoverEl = document.getElementById('shift-live-turnover');
    const liveShareEl = document.getElementById('shift-live-share');
    const summaryEl = document.getElementById('shift-completed-summary');
    const opInput = document.getElementById('shift-operator-input') as HTMLInputElement | null;
    const btn = document.getElementById('btn-toggle-shift') as HTMLButtonElement | null;
    const btnText = document.getElementById('shift-btn-text');
    const collapseBtn = document.getElementById('btn-popup-shift-collapse');
    const collapsedBox = document.getElementById('shift-collapsed-box');
    const btnRow = document.getElementById('shift-btn-row');

    if (!btn) return;

    if (this.shiftState.shiftActive && typeof this.shiftState.shiftStartTime === 'number') {
      // Active shift
      if (cockpit) cockpit.className = this.isShiftCollapsed ? 'shift-cockpit-hero active collapsed' : 'shift-cockpit-hero active';
      if (badge) badge.textContent = '🟢 СМЕНА В ПРОЦЕССЕ';
      if (idleBox) idleBox.style.display = 'none';
      if (summaryEl) summaryEl.style.display = 'none';

      if (this.isShiftCollapsed) {
        if (collapseBtn) collapseBtn.style.display = 'none';
        if (activeBox) activeBox.style.display = 'none';
        if (btnRow) btnRow.style.display = 'none';
        if (collapsedBox) collapsedBox.style.display = 'flex';
        return;
      } else {
        if (collapseBtn) collapseBtn.style.display = 'inline-block';
        if (activeBox) activeBox.style.display = 'block';
        if (btnRow) btnRow.style.display = 'flex';
        if (collapsedBox) collapsedBox.style.display = 'none';
      }

      if (activeOpBadge) {
        activeOpBadge.textContent = `👤 ${this.shiftState.currentOperator || 'Алекс'}`;
      }
      if (startTimeEl) {
        startTimeEl.textContent = `Начало: ${formatTimeOnly(this.shiftState.shiftStartTime)}`;
      }

      btn.className = 'btn-cockpit-action btn-stop';
      if (btnText) btnText.textContent = 'Завершить смену';

      const updateTimer = () => {
        if (!this.shiftState.shiftStartTime || this.isShiftCollapsed) return;
        const elapsed = Math.max(0, Date.now() - this.shiftState.shiftStartTime);
        if (timerVal) {
          timerVal.textContent = formatDuration(elapsed);
        }

        if (this.state?.cache?.orders) {
          const sharePercent = this.state.settings.sellerSharePercent ?? 10.0;
          const earnings = calculateShiftEarnings(
            this.shiftState.shiftStartTime,
            Date.now(),
            this.state.cache.orders,
            sharePercent
          );

          if (ordersCountEl) {
            ordersCountEl.textContent = `${earnings.ordersCount}`;
          }

          const turnParts: string[] = [];
          for (const [curr, amt] of Object.entries(earnings.turnoverByCurrency)) {
            if (amt > 0) turnParts.push(formatMoney(amt, curr));
          }
          if (liveTurnoverEl) {
            liveTurnoverEl.textContent = turnParts.length > 0 ? turnParts.join(', ') : '0 ₽';
          }

          const shareParts: string[] = [];
          for (const [curr, amt] of Object.entries(earnings.sellerShareByCurrency)) {
            if (amt > 0) shareParts.push(formatMoney(amt, curr));
          }
          if (liveShareEl) {
            liveShareEl.textContent = shareParts.length > 0 ? shareParts.join(', ') : '0 ₽';
          }
        }
      };

      updateTimer();
      this.shiftTimerInterval = window.setInterval(updateTimer, 1000);
    } else {
      // Inactive shift
      if (cockpit) cockpit.className = 'shift-cockpit-hero';
      if (badge) badge.textContent = 'СМЕНА НЕ АКТИВНА';
      if (collapseBtn) collapseBtn.style.display = 'none';
      if (collapsedBox) collapsedBox.style.display = 'none';
      if (btnRow) btnRow.style.display = 'flex';
      if (idleBox) idleBox.style.display = 'block';
      if (activeBox) activeBox.style.display = 'none';

      if (opInput && this.shiftState.currentOperator) {
        opInput.value = this.shiftState.currentOperator;
      }

      if (this.lastCompletedShift) {
        if (summaryEl) {
          summaryEl.style.display = 'block';
          const e = this.lastCompletedShift.earnings;
          const parts: string[] = [];
          for (const [curr, amt] of Object.entries(e.turnoverByCurrency)) {
            if (amt > 0) parts.push(formatMoney(amt, curr));
          }
          const turnoverStr = parts.length > 0 ? parts.join(', ') : '0 ₽';
          summaryEl.innerHTML = `
            <strong>✅ Предыдущая:</strong> ${this.lastCompletedShift.operatorName} (${formatDuration(this.lastCompletedShift.duration)})<br>
            ${e.ordersCount} зак. • Оборот: ${turnoverStr}
          `;
        }
      } else {
        if (summaryEl) summaryEl.style.display = 'none';
      }

      btn.className = 'btn-cockpit-action btn-start';
      if (btnText) btnText.textContent = 'Начать смену';
    }
  }

  private async handleToggleShift() {
    const btn = document.getElementById('btn-toggle-shift') as HTMLButtonElement | null;
    if (btn) btn.disabled = true;

    try {
      if (this.shiftState.shiftActive) {
        const opName = this.shiftState.currentOperator || 'Алекс';
        const confirmed = window.confirm(`Завершить рабочую смену оператора «${opName}»?`);
        if (!confirmed) {
          if (btn) btn.disabled = false;
          return;
        }

        const res = await chrome.runtime.sendMessage({ type: 'STOP_SHIFT' });
        if (res && res.shiftState) {
          this.shiftState = res.shiftState;
          if (res.completedShift) {
            this.lastCompletedShift = res.completedShift;
          }
        }
      } else {
        const opInput = document.getElementById('shift-operator-input') as HTMLInputElement | null;
        const operatorName = opInput?.value?.trim() || 'Алекс';
        const res = await chrome.runtime.sendMessage({
          type: 'START_SHIFT',
          payload: { operatorName }
        });
        if (res && res.success && res.shiftState) {
          this.shiftState = res.shiftState;
          this.lastCompletedShift = null;
        } else if (res && !res.success) {
          alert(`Не удалось начать смену: ${res.error || 'Ошибка Supabase'}`);
        }
      }
    } catch (err: unknown) {
      console.error('Ошибка переключения смены:', err);
    } finally {
      if (btn) btn.disabled = false;
      this.renderShiftState();
    }
  }

  private renderQuickTemplates() {
    const tplGrid = document.getElementById('popup-quick-templates');
    if (!tplGrid || !this.state) return;

    const activeProfId = this.state.settings.selectedProfileId || this.state.settings.activeProfileId || 'profile-1';
    const tpls = (this.state.templates || []).filter(t => t.profileId === activeProfId && t.enabled !== false);
    const displayTpls = tpls.slice(0, 4);

    if (displayTpls.length === 0) {
      tplGrid.innerHTML = `
        <div style="color:var(--text-muted); font-size:11px; grid-column:span 2; text-align:center; padding:10px 0;">
          В выбранном профиле нет шаблонов. Добавьте их в настройках.
        </div>
      `;
      return;
    }

    tplGrid.innerHTML = displayTpls.map((t, idx) => {
      const keyLabel = t.hotkey || `F${idx + 1}`;
      return `
        <div class="popup-tpl-card" data-text="${encodeURIComponent(t.text)}" title="Клик — вставить в чат или скопировать">
          <div class="popup-tpl-top">
            <span class="popup-tpl-name">${t.name}</span>
            <span class="popup-tpl-key">${keyLabel}</span>
          </div>
          <div class="popup-tpl-snippet">${t.text}</div>
        </div>
      `;
    }).join('');

    tplGrid.querySelectorAll('.popup-tpl-card').forEach(card => {
      card.addEventListener('click', async () => {
        const encoded = card.getAttribute('data-text');
        if (!encoded) return;
        const text = decodeURIComponent(encoded);

        // Try inserting into active FunPay tab
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          const tab = tabs[0];
          if (tab?.id && tab.url?.includes('funpay.com')) {
            chrome.tabs.sendMessage(tab.id, {
              type: 'INSERT_MESSAGE',
              payload: { text }
            }).catch(() => {});
          }
        });

        // Copy to clipboard as reliable fallback
        try {
          await navigator.clipboard.writeText(text);
        } catch {}

        const nameEl = card.querySelector('.popup-tpl-name');
        if (nameEl) {
          const prev = nameEl.textContent;
          nameEl.textContent = 'Вставлено! ✓';
          setTimeout(() => { nameEl.textContent = prev; }, 1200);
        }
      });
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const popup = new PopupController();
  popup.init();
});
