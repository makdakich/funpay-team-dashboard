import { CompletedShift, ExtensionState, ShiftState } from '../shared/types';
import { calculateShiftEarnings, formatMoney } from '../shared/utils';
import { formatDuration, formatTimeOnly } from '../shared/datetime';

class PopupController {
  private state: ExtensionState | null = null;
  private shiftState: ShiftState = { shiftActive: false, shiftStartTime: null };
  private shiftTimerInterval: number | null = null;
  private lastShiftCompleted = false;
  private lastCompletedShift: CompletedShift | null = null;
  private isShiftCollapsed = false;

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
      chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#dashboard') });
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
    const res = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    if (!res || !res.state) return;
    this.state = res.state;

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
        badge.className = 'hotkey-indicator on';
        badge.textContent = 'ХОТКЕИ ВКЛ';
      } else {
        badge.className = 'hotkey-indicator';
        badge.textContent = 'ХОТКЕИ ВЫКЛ';
      }
    }

    // Account & Balance Status
    const statusPill = document.getElementById('popup-status-badge');
    const statusText = document.getElementById('popup-status-text');
    const balanceVal = document.getElementById('balance-val');

    if (this.state?.cache.accountInfo) {
      const acc = this.state.cache.accountInfo;
      if (statusPill) statusPill.className = 'connection-status-pill connected';
      if (statusText) statusText.textContent = acc.username;
      if (balanceVal) balanceVal.textContent = formatMoney(acc.totalBalance, acc.currency);
    } else if (this.state?.cache.error) {
      if (statusPill) statusPill.className = 'connection-status-pill';
      if (statusText) statusText.textContent = 'Ошибка';
      if (balanceVal) balanceVal.textContent = '0 ₽';
    } else {
      if (statusPill) statusPill.className = 'connection-status-pill';
      if (statusText) statusText.textContent = 'Офлайн';
      if (balanceVal) balanceVal.textContent = '0 ₽';
    }

    // Render Quick Action Templates Palette
    this.renderQuickTemplates();
  }

  private renderQuickTemplates() {
    const tplGrid = document.getElementById('popup-quick-templates');
    if (!tplGrid || !this.state) return;

    const activeProfId = this.state.settings.selectedProfileId || this.state.settings.activeProfileId || 'default';
    const tpls = this.state.templates.filter(t => t.profileId === activeProfId);
    const displayTpls = tpls.slice(0, 4);

    if (displayTpls.length === 0) {
      tplGrid.innerHTML = `
        <div style="color:var(--text-muted); font-size:11px; grid-column:span 2; text-align:center; padding:12px 0;">
          В профиле нет шаблонов. Добавьте их в Дашборде.
        </div>
      `;
      return;
    }

    tplGrid.innerHTML = displayTpls.map((t, idx) => {
      const keyLabel = t.key || `F${idx + 1}`;
      return `
        <div class="popup-tpl-card" data-text="${encodeURIComponent(t.text)}" title="Нажмите, чтобы скопировать шаблон">
          <div class="popup-tpl-top">
            <span class="popup-tpl-name">${t.name}</span>
            <span class="popup-tpl-key">${keyLabel}</span>
          </div>
          <div class="popup-tpl-snippet">${t.text}</div>
        </div>
      `;
    }).join('');

    tplGrid.querySelectorAll('.popup-tpl-card').forEach(card => {
      card.addEventListener('click', () => {
        const encoded = card.getAttribute('data-text');
        if (encoded) {
          const text = decodeURIComponent(encoded);
          navigator.clipboard.writeText(text);
          const nameEl = card.querySelector('.popup-tpl-name');
          if (nameEl) {
            const prev = nameEl.textContent;
            nameEl.textContent = 'Скопировано! ✓';
            setTimeout(() => { nameEl.textContent = prev; }, 1200);
          }
        }
      });
    });
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
      btn.innerHTML = syncing ? '<span class="icon">⏳</span>' : '<span class="icon">🔄</span>';
      (btn as HTMLButtonElement).disabled = syncing;
    }
  }

  private showErrorStatus(msg: string) {
    const statusPill = document.getElementById('popup-status-badge');
    const statusText = document.getElementById('popup-status-text');
    if (statusPill) statusPill.className = 'connection-status-pill';
    if (statusText) statusText.textContent = 'Ошибка';
    console.warn(msg);
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
    const liveEarningsEl = document.getElementById('shift-live-earnings');
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
      if (badge) badge.textContent = 'СМЕНА В ПРОЦЕССЕ';
      if (idleBox) idleBox.style.display = 'none';
      if (summaryEl) summaryEl.style.display = 'none';

      if (this.isShiftCollapsed) {
        if (collapseBtn) collapseBtn.style.display = 'none';
        if (activeBox) activeBox.style.display = 'none';
        if (btnRow) btnRow.style.display = 'none';
        if (collapsedBox) collapsedBox.style.display = 'flex';
        return; // Stealth mode: zero name, zero money, zero timer rendered
      } else {
        if (collapseBtn) collapseBtn.style.display = 'inline-block';
        if (activeBox) activeBox.style.display = 'block';
        if (btnRow) btnRow.style.display = 'flex';
        if (collapsedBox) collapsedBox.style.display = 'none';
      }

      if (activeOpBadge) {
        activeOpBadge.textContent = `👤 ${this.shiftState.currentOperator || 'Оператор 1'}`;
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

        if (liveEarningsEl && this.state?.cache?.orders) {
          const earnings = calculateShiftEarnings(
            this.shiftState.shiftStartTime,
            Date.now(),
            this.state.cache.orders,
            this.state.settings.sellerSharePercent ?? 12.0
          );
          const parts: string[] = [];
          for (const [curr, amt] of Object.entries(earnings.turnoverByCurrency)) {
            if (amt > 0) {
              parts.push(formatMoney(amt, curr));
            }
          }
          const text = parts.length > 0 ? parts.join(', ') : '0 ₽';
          liveEarningsEl.textContent = `${earnings.ordersCount} зак. • Выручка: ${text}`;
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
        const opName = this.shiftState.currentOperator || 'Оператор 1';
        const confirmed = window.confirm(`Завершить рабочую смену оператора «${opName}»?`);
        if (!confirmed) {
          if (btn) btn.disabled = false;
          return;
        }

        const res = await chrome.runtime.sendMessage({ type: 'STOP_SHIFT' });
        if (res && res.shiftState) {
          this.shiftState = res.shiftState;
          this.lastShiftCompleted = true;
          if (res.completedShift) {
            this.lastCompletedShift = res.completedShift;
          }
        }
      } else {
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
