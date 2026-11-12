import { ShiftState, ExtensionState } from '../shared/types';
import { formatDuration, formatTimeOnly } from '../shared/datetime';
import { calculateShiftEarnings, formatMoney } from '../shared/utils';
import { safeSendMessage } from './runtime';

export class ShiftHudWidget {
  private container: HTMLDivElement | null = null;
  private timerInterval: number | null = null;
  private shiftState: ShiftState | null = null;
  private extensionState: ExtensionState | null = null;
  private isMinimized = false;
  private isMouseDown = false;
  private isDragging = false;
  private justDragged = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private initialLeft = 20;
  private initialTop = 70;
  private showConfirmModal = false;

  public init(shiftState: ShiftState, extensionState: ExtensionState) {
    this.shiftState = shiftState;
    this.extensionState = extensionState;

    // Restore saved widget position and minimized state from settings
    const savedPos = extensionState.settings?.shiftWidgetPosition;
    if (savedPos) {
      if (typeof savedPos.left === 'number') this.initialLeft = savedPos.left;
      if (typeof savedPos.top === 'number') this.initialTop = savedPos.top;
      if (typeof savedPos.minimized === 'boolean') this.isMinimized = savedPos.minimized;
    }

    this.render();
    this.setupStorageListener();
  }

  public updateState(shiftState: ShiftState, extensionState?: ExtensionState) {
    this.shiftState = shiftState;
    if (extensionState) {
      this.extensionState = extensionState;
    }
    this.render();
  }

  private setupStorageListener() {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local') {
        if (changes.fphk_shift_state) {
          this.shiftState = changes.fphk_shift_state.newValue;
          this.render();
        }
        if (changes.fphk_settings && this.extensionState) {
          this.extensionState.settings = changes.fphk_settings.newValue;
          this.render();
        }
        if (changes.fphk_cache && this.extensionState) {
          this.extensionState.cache = changes.fphk_cache.newValue;
          this.render();
        }
      }
    });
  }

  public render() {
    // Only render if enabled in settings (default true)
    const isVisibleSetting = this.extensionState?.settings?.shiftWidgetVisible ?? true;

    // If shift is not active and no active state, remove from DOM
    if (!isVisibleSetting || !this.shiftState?.shiftActive || !this.shiftState.shiftStartTime) {
      this.destroy();
      return;
    }

    if (!this.container) {
      this.createContainer();
    }

    this.updateContent();
    this.startLiveTimer();
  }

  private createContainer() {
    this.container = document.createElement('div');
    this.container.id = 'fphk-shift-widget';
    this.container.className = 'fphk-shift-widget';
    
    // Apply position with window boundary check
    const maxLeft = Math.max(10, window.innerWidth - 300);
    const maxTop = Math.max(10, window.innerHeight - 200);
    const left = Math.max(10, Math.min(maxLeft, this.initialLeft));
    const top = Math.max(10, Math.min(maxTop, this.initialTop));

    this.container.style.left = `${left}px`;
    this.container.style.top = `${top}px`;

    document.body.appendChild(this.container);
    this.attachDragEvents();
  }

  private updateContent() {
    if (!this.container || !this.shiftState?.shiftStartTime) return;

    const operator = this.shiftState.currentOperator || 'Оператор 1';
    const startTimeFormatted = formatTimeOnly(this.shiftState.shiftStartTime);
    const elapsedMs = Math.max(0, Date.now() - this.shiftState.shiftStartTime);
    const durationFormatted = formatDuration(elapsedMs);

    // Calculate current shift earnings
    const orders = this.extensionState?.cache?.orders || [];
    const sharePercent = this.extensionState?.settings?.sellerSharePercent ?? 10.0;
    const earnings = calculateShiftEarnings(this.shiftState.shiftStartTime, Date.now(), orders, sharePercent);

    // Format turnover string (e.g., "1 450 ₽, $20")
    const turnoverCurrs = Object.entries(earnings.turnoverByCurrency);
    let turnoverText = '0 ₽';
    if (turnoverCurrs.length > 0) {
      turnoverText = turnoverCurrs.map(([curr, sum]) => formatMoney(sum, curr)).join(' | ');
    }

    const shareCurrs = Object.entries(earnings.sellerShareByCurrency);
    let shareText = '';
    if (shareCurrs.length > 0) {
      shareText = shareCurrs.map(([curr, sum]) => formatMoney(sum, curr)).join(' | ');
    }

    if (this.isMinimized) {
      this.container.classList.add('fphk-minimized');
      this.container.innerHTML = `
        <div class="fphk-widget-pill fphk-stealth-pill" id="fphk-minimized-pill" title="Смена активна • Нажмите, чтобы развернуть">
          <span class="fphk-dot-pulse"></span>
          <span class="fphk-pill-label">Смена</span>
          <button class="fphk-pill-btn-toggle" id="fphk-btn-widget-toggle" title="Развернуть смену">⛶</button>
        </div>
      `;
    } else {
      this.container.classList.remove('fphk-minimized');

      if (this.showConfirmModal) {
        this.container.innerHTML = `
          <div class="fphk-widget-card fphk-confirm-card">
            <div class="fphk-confirm-title">⚠️ Завершить смену?</div>
            <div class="fphk-confirm-desc">Оператор: <b>${this.escapeHtml(operator)}</b><br>Длительность: <b>${durationFormatted}</b></div>
            <div class="fphk-confirm-actions">
              <button class="fphk-btn fphk-btn-danger" id="fphk-btn-confirm-stop">Да, завершить</button>
              <button class="fphk-btn fphk-btn-secondary" id="fphk-btn-cancel-stop">Отмена</button>
            </div>
          </div>
        `;
      } else {
        this.container.innerHTML = `
          <div class="fphk-widget-card">
            <div class="fphk-widget-header" id="fphk-widget-drag-handle">
              <div class="fphk-header-left">
                <span class="fphk-dot-pulse"></span>
                <span class="fphk-widget-title">Смена активна</span>
              </div>
              <div class="fphk-header-actions">
                <button class="fphk-btn-icon fphk-btn-web" id="fphk-btn-web-dash" title="Открыть командный дашборд на сайте">🌐</button>
                <button class="fphk-btn-icon" id="fphk-btn-widget-toggle" title="Свернуть (скрыть имя, время и выручку)">—</button>
              </div>
            </div>

            <div class="fphk-widget-body">
              <div class="fphk-row-op">
                <span class="fphk-icon">👤</span>
                <span class="fphk-op-name">${this.escapeHtml(operator)}</span>
                <span class="fphk-start-time">с ${startTimeFormatted}</span>
              </div>

              <div class="fphk-timer-block">
                <span class="fphk-timer-val" id="fphk-timer-display">${durationFormatted}</span>
                <span class="fphk-timer-badge">${earnings.ordersCount} зак.</span>
              </div>

              <div class="fphk-earnings-box">
                <div class="fphk-earn-row">
                  <span class="fphk-earn-label">Выручка:</span>
                  <span class="fphk-earn-val" id="fphk-earn-turnover">${turnoverText}</span>
                </div>
                ${shareText ? `
                <div class="fphk-earn-row fphk-share-row">
                  <span class="fphk-earn-label">Моя доля (${sharePercent}%):</span>
                  <span class="fphk-earn-val fphk-share-val" id="fphk-earn-share">${shareText}</span>
                </div>` : ''}
              </div>

              <div class="fphk-widget-footer">
                <button class="fphk-btn fphk-btn-stop" id="fphk-btn-request-stop">
                  <span class="fphk-btn-icon-stop">🛑</span> Завершить смену
                </button>
              </div>
            </div>
          </div>
        `;
      }
    }

    this.bindWidgetEvents();
  }

  private bindWidgetEvents() {
    if (!this.container) return;

    // Open Web Dashboard
    const webDashBtn = this.container.querySelector('#fphk-btn-web-dash');
    if (webDashBtn) {
      webDashBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        window.open('https://makdakich.github.io/funpay-team-dashboard/', '_blank');
      });
    }

    // Toggle minimize
    const toggleBtn = this.container.querySelector('#fphk-btn-widget-toggle');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.isMinimized = !this.isMinimized;
        this.savePosition();
        this.updateContent();
      });
    }

    // Direct click on pill expands back to full widget
    const minPill = this.container.querySelector('#fphk-minimized-pill');
    if (minPill) {
      minPill.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.justDragged) {
          this.justDragged = false;
          return;
        }
        if (this.isMinimized) {
          this.isMinimized = false;
          this.savePosition();
          this.updateContent();
        }
      });
    }

    // Request Stop
    const reqStopBtn = this.container.querySelector('#fphk-btn-request-stop');
    if (reqStopBtn) {
      reqStopBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.showConfirmModal = true;
        this.updateContent();
      });
    }

    // Cancel Stop
    const cancelStopBtn = this.container.querySelector('#fphk-btn-cancel-stop');
    if (cancelStopBtn) {
      cancelStopBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.showConfirmModal = false;
        this.updateContent();
      });
    }

    // Confirm Stop
    const confirmStopBtn = this.container.querySelector('#fphk-btn-confirm-stop');
    if (confirmStopBtn) {
      confirmStopBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        confirmStopBtn.textContent = 'Завершение...';
        (confirmStopBtn as HTMLButtonElement).disabled = true;

        try {
          await safeSendMessage({ type: 'STOP_SHIFT' });
          this.showConfirmModal = false;
          this.destroy();
        } catch (err) {
          console.error('[FunPay Hotkeys] Failed to stop shift:', err);
          this.showConfirmModal = false;
          this.updateContent();
        }
      });
    }
  }

  private attachDragEvents() {
    if (!this.container) return;

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      // Don't drag if clicked on button or input
      if (target.closest('button') || target.closest('input')) return;

      this.isMouseDown = true;
      this.isDragging = false;
      this.justDragged = false;
      this.dragStartX = e.clientX;
      this.dragStartY = e.clientY;
      const rect = this.container!.getBoundingClientRect();
      this.initialLeft = rect.left;
      this.initialTop = rect.top;
      // Never preventDefault on mousedown to allow natural clicks!
    };

    this.container.addEventListener('mousedown', onMouseDown);

    const onMouseMove = (e: MouseEvent) => {
      if (!this.isMouseDown || !this.container) return;
      const dx = e.clientX - this.dragStartX;
      const dy = e.clientY - this.dragStartY;

      if (!this.isDragging) {
        if (Math.abs(dx) > 6 || Math.abs(dy) > 6) {
          this.isDragging = true;
        }
      }

      if (this.isDragging) {
        e.preventDefault();
        const maxLeft = Math.max(10, window.innerWidth - this.container.offsetWidth - 10);
        const maxTop = Math.max(10, window.innerHeight - this.container.offsetHeight - 10);

        const newLeft = Math.max(10, Math.min(maxLeft, this.initialLeft + dx));
        const newTop = Math.max(10, Math.min(maxTop, this.initialTop + dy));

        this.container.style.left = `${newLeft}px`;
        this.container.style.top = `${newTop}px`;
        this.container.style.right = 'auto';
        this.container.style.bottom = 'auto';
      }
    };

    const onMouseUp = () => {
      if (this.isMouseDown) {
        this.isMouseDown = false;
        if (this.isDragging) {
          this.isDragging = false;
          this.justDragged = true;
          setTimeout(() => {
            this.justDragged = false;
          }, 150);
          this.savePosition();
        } else {
          this.justDragged = false;
        }
      }
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }

  private savePosition() {
    if (!this.container) return;
    const rect = this.container.getBoundingClientRect();
    const position = {
      top: Math.round(rect.top),
      left: Math.round(rect.left),
      minimized: this.isMinimized
    };
    safeSendMessage({
      type: 'UPDATE_SETTINGS',
      payload: { shiftWidgetPosition: position }
    });
  }

  private startLiveTimer() {
    if (this.timerInterval !== null) return;

    this.timerInterval = window.setInterval(() => {
      if (!this.shiftState?.shiftStartTime) {
        this.stopLiveTimer();
        return;
      }
      if (this.isMinimized) {
        return;
      }
      const elapsed = Math.max(0, Date.now() - this.shiftState.shiftStartTime);
      const display = document.getElementById('fphk-timer-display');
      if (display) {
        display.textContent = formatDuration(elapsed);
      }
    }, 1000);
  }

  private stopLiveTimer() {
    if (this.timerInterval !== null) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  public destroy() {
    this.stopLiveTimer();
    if (this.container && this.container.parentElement) {
      this.container.parentElement.removeChild(this.container);
    }
    this.container = null;
  }

  private escapeHtml(str: string): string {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}
