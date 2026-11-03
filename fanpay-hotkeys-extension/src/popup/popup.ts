import { CompletedShift, ExtensionState, ShiftState } from '../shared/types';
import { calculateShiftEarnings, formatMoney } from '../shared/utils';
import { formatDuration, formatTimeOnly } from '../shared/datetime';

class PopupController {
  private state: ExtensionState | null = null;
  private shiftState: ShiftState = { shiftActive: false, shiftStartTime: null };
  private shiftTimerInterval: number | null = null;
  private lastShiftCompleted = false;
  private lastCompletedShift: CompletedShift | null = null;

  public async init() {
    this.bindEvents();
    await this.loadAndRenderState();
    await this.loadAndRenderShift();
    await this.checkCurrentTab();
  }

  private bindEvents() {
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

    // Sync button
    const btnSync = document.getElementById('btn-sync');
    btnSync?.addEventListener('click', async () => {
      this.setSyncingState(true);
      try {
        const res = await chrome.runtime.sendMessage({ type: 'SYNC_DATA' });
        if (res.success) {
          await this.loadAndRenderState();
        } else {
          this.showErrorStatus(res.error || 'Ошибка синхронизации');
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Ошибка связи с фоновым сервисом';
        this.showErrorStatus(msg);
      } finally {
        this.setSyncingState(false);
      }
    });

    // Options button
    const btnOptions = document.getElementById('btn-options');
    btnOptions?.addEventListener('click', () => {
      chrome.runtime.openOptionsPage();
    });

    // Stats button
    const btnStats = document.getElementById('btn-stats');
    btnStats?.addEventListener('click', () => {
      // Open options with anchor or param for stats tab
      chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#stats') });
    });

    // Orders link
    const linkOrders = document.getElementById('link-orders');
    linkOrders?.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#orders') });
    });

    // Shift toggle button
    const btnShift = document.getElementById('btn-toggle-shift');
    btnShift?.addEventListener('click', async () => {
      await this.handleToggleShift();
    });

    // Shift history open button
    document.getElementById('btn-open-shift-history')?.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#shifts') });
    });
  }

  private async loadAndRenderState() {
    const res = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    if (!res || !res.state) return;
    this.state = res.state;

    // Render Profiles Dropdown
    const select = document.getElementById('profile-select') as HTMLSelectElement;
    if (select && this.state) {
      select.innerHTML = '';
      for (const p of this.state.profiles) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name;
        if (p.id === this.state.settings.selectedProfileId) {
          opt.selected = true;
        }
        select.appendChild(opt);
      }
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
      opInput.value = this.shiftState.currentOperator || this.state?.settings?.lastOperator || 'Оператор 1';
    }

    // Hotkeys badge
    const badge = document.getElementById('hotkeys-status-badge');
    if (badge && this.state) {
      if (this.state.settings.hotkeysEnabled) {
        badge.className = 'badge-status badge-on';
        badge.textContent = 'Хоткеи ВКЛ';
      } else {
        badge.className = 'badge-status badge-off';
        badge.textContent = 'Хоткеи ВЫКЛ';
      }
    }

    // Account & Balance Status
    const dot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');
    const statusSub = document.getElementById('status-sub');
    const balanceRow = document.getElementById('balance-row');
    const balanceVal = document.getElementById('balance-val');
    const syncTime = document.getElementById('sync-time');

    if (this.state?.cache.accountInfo) {
      const acc = this.state.cache.accountInfo;
      if (dot) dot.className = 'status-indicator connected';
      if (statusText) statusText.textContent = `FunPay: ${acc.username}`;
      if (statusSub) statusSub.textContent = `ID: ${acc.userId} • Продаж: ${acc.activeSales}`;
      if (balanceRow) balanceRow.style.display = 'flex';
      if (balanceVal) balanceVal.textContent = formatMoney(acc.totalBalance, acc.currency);
    } else if (this.state?.cache.error) {
      if (dot) dot.className = 'status-indicator error';
      if (statusText) statusText.textContent = 'Ошибка авторизации';
      if (statusSub) statusSub.textContent = this.state.cache.error;
      if (balanceRow) balanceRow.style.display = 'none';
    } else {
      if (dot) dot.className = 'status-indicator';
      if (statusText) statusText.textContent = 'Сессия не синхронизирована';
      if (statusSub) statusSub.textContent = 'Нажмите "Синхронизация" или проверьте API';
      if (balanceRow) balanceRow.style.display = 'none';
    }

    // Sync time
    if (syncTime && this.state) {
      if (this.state.cache.lastSyncTimestamp) {
        const dt = new Date(this.state.cache.lastSyncTimestamp);
        syncTime.textContent = `Синхр: ${dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      } else {
        syncTime.textContent = 'Синхронизация: никогда';
      }
    }
  }

  private async checkCurrentTab() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const currentTab = tabs[0];
      const notice = document.getElementById('funpay-tab-notice');
      if (notice) {
        const isFunPay = currentTab?.url && currentTab.url.includes('funpay.com');
        notice.style.display = isFunPay ? 'none' : 'flex';
      }
    });
  }

  private setSyncingState(syncing: boolean) {
    const btn = document.getElementById('btn-sync');
    if (btn) {
      btn.textContent = syncing ? '⏳ Загрузка...' : '🔄 Синхронизация';
      (btn as HTMLButtonElement).disabled = syncing;
    }
  }

  private showErrorStatus(msg: string) {
    const dot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');
    const statusSub = document.getElementById('status-sub');
    if (dot) dot.className = 'status-indicator error';
    if (statusText) statusText.textContent = 'Ошибка подключения';
    if (statusSub) statusSub.textContent = msg;
  }

  private async loadAndRenderShift() {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_SHIFT_STATE' });
      if (res && res.shiftState) {
        this.shiftState = res.shiftState;
      }
    } catch {
      // Background waking up or direct storage access
    }
    this.renderShiftState();
  }

  private renderShiftState() {
    if (this.shiftTimerInterval !== null) {
      clearInterval(this.shiftTimerInterval);
      this.shiftTimerInterval = null;
    }

    const badge = document.getElementById('shift-badge');
    const timerDisplay = document.getElementById('shift-timer-display');
    const timerVal = document.getElementById('shift-timer');
    const startTimeEl = document.getElementById('shift-start-time');
    const idleMsg = document.getElementById('shift-idle-msg');
    const operatorRow = document.getElementById('shift-operator-row');
    const activeOpBadge = document.getElementById('shift-active-op-badge');
    const liveEarningsEl = document.getElementById('shift-live-earnings');
    const summaryEl = document.getElementById('shift-completed-summary');
    const opInput = document.getElementById('shift-operator-input') as HTMLInputElement | null;
    const btn = document.getElementById('btn-toggle-shift') as HTMLButtonElement | null;

    if (!btn) return;

    if (this.shiftState.shiftActive && typeof this.shiftState.shiftStartTime === 'number') {
      // Active shift state
      if (badge) {
        badge.className = 'badge-status badge-on';
        badge.textContent = 'В смене';
      }
      if (operatorRow) operatorRow.style.display = 'none';
      if (idleMsg) idleMsg.style.display = 'none';
      if (summaryEl) summaryEl.style.display = 'none';
      if (timerDisplay) timerDisplay.style.display = 'flex';
      if (activeOpBadge) {
        activeOpBadge.textContent = `👤 ${this.shiftState.currentOperator || 'Оператор 1'}`;
      }
      if (startTimeEl) {
        startTimeEl.textContent = `Начало: ${formatTimeOnly(this.shiftState.shiftStartTime)}`;
      }

      btn.className = 'btn btn-shift btn-shift-stop';
      btn.innerHTML = '<span class="btn-icon">⏹</span> Завершить смену';

      const updateTimer = () => {
        if (!this.shiftState.shiftStartTime) return;
        const elapsed = Math.max(0, Date.now() - this.shiftState.shiftStartTime);
        if (timerVal) {
          timerVal.textContent = formatDuration(elapsed);
        }

        // Live shift earnings from cached orders
        if (liveEarningsEl && this.state?.cache?.orders) {
          const earnings = calculateShiftEarnings(
            this.shiftState.shiftStartTime,
            Date.now(),
            this.state.cache.orders,
            this.state.settings.sellerSharePercent ?? 10.0
          );
          const parts: string[] = [];
          for (const [curr, amt] of Object.entries(earnings.turnoverByCurrency)) {
            if (amt > 0) {
              const share = earnings.sellerShareByCurrency[curr] || 0;
              parts.push(`${formatMoney(amt, curr)} (доля: ${formatMoney(share, curr)})`);
            }
          }
          const text = parts.length > 0 ? parts.join(', ') : '0 ₽';
          liveEarningsEl.textContent = `Заказов: ${earnings.ordersCount} • Выручка: ${text}`;
        }
      };

      updateTimer();
      this.shiftTimerInterval = window.setInterval(updateTimer, 1000);
    } else {
      // Inactive shift state
      if (badge) {
        badge.className = 'badge-status badge-off';
        badge.textContent = 'Не активна';
      }
      if (operatorRow) operatorRow.style.display = 'flex';
      if (timerDisplay) timerDisplay.style.display = 'none';

      if (opInput && this.shiftState.currentOperator) {
        opInput.value = this.shiftState.currentOperator;
      }

      if (this.lastCompletedShift) {
        if (idleMsg) idleMsg.style.display = 'none';
        if (summaryEl) {
          summaryEl.style.display = 'block';
          const e = this.lastCompletedShift.earnings;
          const parts: string[] = [];
          for (const [curr, amt] of Object.entries(e.turnoverByCurrency)) {
            if (amt > 0) parts.push(formatMoney(amt, curr));
          }
          const turnoverStr = parts.length > 0 ? parts.join(', ') : '0 ₽';
          summaryEl.innerHTML = `
            <strong>✅ Смена завершена!</strong> (${this.lastCompletedShift.operatorName})<br>
            ⏱ Отработано: ${formatDuration(this.lastCompletedShift.duration)}<br>
            📦 Заказов: ${e.ordersCount} • Выручка: ${turnoverStr}
          `;
        }
      } else {
        if (summaryEl) summaryEl.style.display = 'none';
        if (idleMsg) {
          idleMsg.style.display = 'block';
          idleMsg.textContent = 'Смена не начата';
        }
      }

      btn.className = 'btn btn-shift btn-shift-start';
      btn.innerHTML = '<span class="btn-icon">▶</span> Начать смену';
    }
  }

  private async handleToggleShift() {
    const btn = document.getElementById('btn-toggle-shift') as HTMLButtonElement | null;
    if (btn) btn.disabled = true;

    try {
      if (this.shiftState.shiftActive) {
        // Confirmation before ending shift to prevent accidental termination
        const opName = this.shiftState.currentOperator || 'Оператор 1';
        const confirmed = window.confirm(`Завершить рабочую смену оператора «${opName}»?`);
        if (!confirmed) {
          if (btn) btn.disabled = false;
          return;
        }

        // Stop current shift
        const res = await chrome.runtime.sendMessage({ type: 'STOP_SHIFT' });
        if (res && res.shiftState) {
          this.shiftState = res.shiftState;
          this.lastShiftCompleted = true;
          if (res.completedShift) {
            this.lastCompletedShift = res.completedShift;
          }
        }
      } else {
        // Start new shift with chosen operator name
        const opInput = document.getElementById('shift-operator-input') as HTMLInputElement | null;
        const operatorName = opInput?.value?.trim() || 'Оператор 1';
        const res = await chrome.runtime.sendMessage({
          type: 'START_SHIFT',
          payload: { operatorName }
        });
        if (res && res.shiftState) {
          this.shiftState = res.shiftState;
          this.lastShiftCompleted = false;
          this.lastCompletedShift = null;
        }
      }
    } catch (err: unknown) {
      console.error('Ошибка переключения смены:', err);
    } finally {
      if (btn) btn.disabled = false;
      this.renderShiftState();
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const popup = new PopupController();
  popup.init();
});
