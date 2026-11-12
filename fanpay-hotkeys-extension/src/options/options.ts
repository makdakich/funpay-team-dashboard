import {
  AppSettings,
  BackupData,
  CloudAuthState,
  CloudShop,
  CompletedShift,
  ExtensionState,
  OrderSyncReport,
  PeriodMultiCurrencyStats,
  Profile,
  Template
} from '../../src/shared/types';
import {
  calculateDashboardStats,
  calculateShiftEarnings,
  formatMoney,
  normalizeCurrency
} from '../../src/shared/utils';
import {
  formatDuration,
  formatTimeOnly,
  getUserStartOfDaysAgo,
  getUserStartOfToday
} from '../../src/shared/datetime';
import {
  PeriodOption,
  Granularity,
  MetricType,
  computeDateRange,
  getRecommendedGranularity,
  generateBuckets,
  generateSvgChart,
  formatDateForInput
} from '../../src/shared/analytics';
import { FunPayClientsAdapter } from '../api/adapters/clients';

class OptionsController {
  private state: ExtensionState | null = null;
  private currentTab = 'dashboard';
  private cloudAuth: CloudAuthState | null = null;

  // Chart analytics state
  private chartMetric: MetricType = 'turnover';
  private chartCurrency = '₽';
  private chartPeriod: PeriodOption = '7';
  private chartGranularity: Granularity = 'days';
  private customStartDate = '';
  private customEndDate = '';

  // Filter & list state
  private orderPeriodFilter = 'all';
  private orderSearchQuery = '';
  private clientSearchQuery = '';
  private clientsSort = 'turnover';
  private templateProfileFilter = 'all';
  private recordingKey = false;
  private shifts: CompletedShift[] = [];
  private shiftsOperatorFilter = 'all';
  private shiftsPeriodFilter = 'all';

  public async init() {
    this.bindNavigation();
    this.bindDashboardEvents();
    this.bindShiftsEvents();
    this.bindOrdersEvents();
    this.bindClientsEvents();
    this.bindTemplatesEvents();
    this.bindHotkeysEvents();
    this.bindProfilesEvents();
    this.bindApiEvents();
    this.bindGeneralEvents();
    this.bindBackupEvents();
    this.bindModals();

    // Listen to background progress updates and shift changes
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local') {
        if (changes.fphk_sync_progress) {
          this.updateSyncProgressUI(changes.fphk_sync_progress.newValue);
        }
        if (changes.fphk_shift_state) {
          this.renderDashboardShift();
          this.renderShiftsActiveBanner();
        }
      }
    });

    await this.refreshState();

    // Check hash anchor e.g. #stats, #orders
    const hash = window.location.hash.replace('#', '');
    if (hash && document.querySelector(`.nav-item[data-tab="${hash}"]`)) {
      this.switchTab(hash);
    } else if (hash === 'stats') {
      this.switchTab('dashboard');
    }
  }

  private async refreshState() {
    const res = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    if (res?.state) {
      this.state = res.state;
    }

    // Team cloud session (schema v2.4): kept separate from local state
    const authRes = await chrome.runtime.sendMessage({ type: 'GET_CLOUD_AUTH_STATE' });
    this.cloudAuth = authRes?.auth || null;

    const shiftsRes = await chrome.runtime.sendMessage({ type: 'GET_SHIFT_HISTORY' });
    if (shiftsRes?.history) {
      this.shifts = shiftsRes.history;
    }
    if (this.state) {
      this.renderCurrentTab();
      this.renderSidebarStatus();
    }
  }

  // --- NAVIGATION ---
  private bindNavigation() {
    const navItems = document.querySelectorAll<HTMLButtonElement>('.nav-item');
    navItems.forEach(item => {
      item.addEventListener('click', () => {
        const tab = item.getAttribute('data-tab');
        if (tab) this.switchTab(tab);
      });
    });
  }

  private switchTab(tabName: string) {
    this.currentTab = tabName;
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    document.querySelector(`.nav-item[data-tab="${tabName}"]`)?.classList.add('active');

    document.querySelectorAll('.tab-pane').forEach(el => el.classList.remove('active'));
    document.getElementById(`tab-${tabName}`)?.classList.add('active');

    this.renderCurrentTab();
  }

  private renderSidebarStatus() {
    const textEl = document.getElementById('sidebar-sync-text');
    const userEl = document.getElementById('sidebar-username');
    const avatarEl = document.getElementById('sidebar-user-avatar');
    const orderCountEl = document.getElementById('nav-orders-count');
    const topbarSyncTime = document.getElementById('topbar-sync-time');

    if (!this.state) return;

    if (orderCountEl && this.state.cache.orders) {
      orderCountEl.textContent = String(this.state.cache.orders.length);
    }

    if (topbarSyncTime && this.state.cache.lastSyncTimestamp) {
      const d = new Date(this.state.cache.lastSyncTimestamp);
      topbarSyncTime.textContent = `Обновлено: ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }

    if (this.state.cache.accountInfo) {
      const acc = this.state.cache.accountInfo;
      const bText = formatMoney(acc.totalBalance, acc.currency);
      if (textEl) textEl.textContent = bText;
      if (userEl) userEl.textContent = acc.username;
      if (avatarEl) {
        avatarEl.textContent = (acc.username || 'FP').slice(0, 2).toUpperCase();
      }
    } else {
      if (textEl) textEl.textContent = 'API не подключен';
      if (userEl) userEl.textContent = 'Гость';
    }
  }

  private renderCurrentTab() {
    if (!this.state) return;
    switch (this.currentTab) {
      case 'dashboard':
        this.renderDashboard();
        break;
      case 'shifts':
        this.renderShifts();
        break;
      case 'orders':
        this.renderOrders();
        break;
      case 'clients':
        this.renderClients();
        break;
      case 'templates':
        this.renderTemplates();
        break;
      case 'hotkeys':
        this.renderHotkeys();
        break;
      case 'profiles':
        this.renderProfiles();
        break;
      case 'api':
        this.renderApiSettings();
        break;
      case 'general':
        this.renderGeneralSettings();
        break;
      case 'backup':
        break;
    }
  }

  // ==========================================================================
  // 1. DASHBOARD & ADVANCED SALES ANALYTICS
  // ==========================================================================
  private bindDashboardEvents() {
    // Sync button (Normal incremental sync)
    document.getElementById('btn-dashboard-sync')?.addEventListener('click', async () => {
      const btn = document.getElementById('btn-dashboard-sync') as HTMLButtonElement;
      btn.disabled = true;
      btn.innerHTML = '⏳ Синхронизация...';
      try {
        const res = await chrome.runtime.sendMessage({ type: 'SYNC_DATA' });
        if (!res?.success) {
          alert('Ошибка синхронизации: ' + (res?.error || 'Проверьте токен golden_key'));
        }
        await this.refreshState();
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<span class="btn-icon">🔄</span> Синхронизировать';
      }
    });

    // Fetch All History Button (Full multi-page pagination)
    document.getElementById('btn-fetch-all-history')?.addEventListener('click', async () => {
      const btn = document.getElementById('btn-fetch-all-history') as HTMLButtonElement;
      const banner = document.getElementById('sync-progress-banner');
      btn.disabled = true;
      btn.innerHTML = '⏳ Загрузка всех страниц...';
      if (banner) banner.style.display = 'block';

      try {
        const res = await chrome.runtime.sendMessage({ type: 'FETCH_ALL_HISTORY' });
        if (!res?.success) {
          alert('Ошибка загрузки полной истории: ' + (res?.error || 'Проверьте подключение'));
        } else {
          alert(`Полная история продаж успешно получена!\nВсего заказов в базе: ${res.cache?.orders?.length || 0}`);
        }
        await this.refreshState();
      } catch (err: unknown) {
        alert('Ошибка запроса полной истории: ' + (err instanceof Error ? err.message : String(err)));
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<span class="btn-icon">📥</span> Загрузить всю историю';
        if (banner) {
          setTimeout(() => { banner.style.display = 'none'; }, 2000);
        }
      }
    });

    // Stop Shift from Dashboard Live Card
    document.getElementById('btn-dash-stop-shift')?.addEventListener('click', async () => {
      const activeShiftRes = await chrome.runtime.sendMessage({ type: 'GET_SHIFT_STATE' });
      const op = activeShiftRes?.shiftState?.currentOperator || 'Оператор';
      if (!window.confirm(`Завершить активную смену оператора «${op}»?`)) return;

      const res = await chrome.runtime.sendMessage({ type: 'STOP_SHIFT' });
      if (res?.success) {
        alert('Смена успешно завершена и сохранена в историю!');
        await this.refreshState();
      }
    });

    // Topbar shift action button (start or stop)
    document.getElementById('btn-topbar-shift-action')?.addEventListener('click', async () => {
      const res = await chrome.runtime.sendMessage({ type: 'GET_SHIFT_STATE' });
      const shiftState = res?.shiftState;
      if (shiftState && shiftState.shiftActive) {
        if (window.confirm(`Завершить активную смену оператора «${shiftState.currentOperator || 'Оператор'}»?`)) {
          await chrome.runtime.sendMessage({ type: 'STOP_SHIFT' });
          await this.refreshState();
        }
      } else {
        const op = prompt('Введите имя сменщика для старта смены:', 'Оператор 1');
        if (op && op.trim()) {
          await chrome.runtime.sendMessage({
            type: 'START_SHIFT',
            payload: { operator: op.trim() }
          });
          await this.refreshState();
        }
      }
    });

    // Save seller share percent
    document.getElementById('btn-save-share')?.addEventListener('click', async () => {
      const input = document.getElementById('input-seller-share') as HTMLInputElement;
      const shareVal = parseFloat(input?.value) || 0;
      await chrome.runtime.sendMessage({
        type: 'UPDATE_SETTINGS',
        payload: { sellerSharePercent: shareVal }
      });
      alert(`Процент "Моя доля" сохранен: ${shareVal}%`);
      await this.refreshState();
    });

    // Sync share slider and input
    const slider = document.getElementById('input-seller-share-slider') as HTMLInputElement | null;
    const numInput = document.getElementById('input-seller-share') as HTMLInputElement | null;
    const shareDisplay = document.getElementById('dash-share-percent-display');

    slider?.addEventListener('input', () => {
      if (numInput) numInput.value = slider.value;
      if (shareDisplay) shareDisplay.textContent = `${slider.value}%`;
      this.updateLiveShareCalc();
      this.renderChart();
    });

    numInput?.addEventListener('input', () => {
      if (slider) slider.value = numInput.value;
      if (shareDisplay) shareDisplay.textContent = `${numInput.value}%`;
      this.updateLiveShareCalc();
      this.renderChart();
    });

    // Hero currency switcher chips
    document.querySelectorAll('#hero-currency-chips .currency-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('#hero-currency-chips .currency-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        const curr = chip.getAttribute('data-curr') || '₽';
        this.chartCurrency = normalizeCurrency(curr);
        const currSelect = document.getElementById('chart-currency-select') as HTMLSelectElement | null;
        if (currSelect) currSelect.value = this.chartCurrency;
        this.renderDashboard();
      });
    });

    // Chart metric toggles
    document.querySelectorAll('.btn-chart-type').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.btn-chart-type').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.chartMetric = (btn.getAttribute('data-type') as MetricType) || 'turnover';
        this.renderChart();
      });
    });

    // Chart granularity toggles
    document.querySelectorAll('.btn-chart-granularity').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.btn-chart-granularity').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.chartGranularity = (btn.getAttribute('data-granularity') as Granularity) || 'days';
        this.renderChart();
      });
    });

    // Chart currency dropdown
    const currSelect = document.getElementById('chart-currency-select') as HTMLSelectElement | null;
    currSelect?.addEventListener('change', () => {
      this.chartCurrency = normalizeCurrency(currSelect.value);
      document.querySelectorAll('#hero-currency-chips .currency-chip').forEach(c => {
        if (c.getAttribute('data-curr') === this.chartCurrency) {
          c.classList.add('active');
        } else {
          c.classList.remove('active');
        }
      });
      this.renderChart();
    });

    // Period pills
    document.querySelectorAll('.period-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.period-pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const periodAttr = btn.getAttribute('data-days') as PeriodOption;
        this.chartPeriod = periodAttr || '7';

        const customBar = document.getElementById('chart-custom-range-bar');
        if (this.chartPeriod === 'custom') {
          if (customBar) customBar.style.display = 'flex';
          const startInp = document.getElementById('chart-date-start') as HTMLInputElement | null;
          const endInp = document.getElementById('chart-date-end') as HTMLInputElement | null;
          if (startInp && !startInp.value) {
            const d = new Date();
            d.setDate(d.getDate() - 30);
            startInp.value = formatDateForInput(d);
            this.customStartDate = startInp.value;
          }
          if (endInp && !endInp.value) {
            endInp.value = formatDateForInput(new Date());
            this.customEndDate = endInp.value;
          }
        } else {
          if (customBar) customBar.style.display = 'none';
        }

        // Set recommended granularity
        const orders = this.state?.cache?.orders || [];
        const range = computeDateRange(this.chartPeriod, this.customStartDate, this.customEndDate, orders);
        if (range.isValid) {
          this.chartGranularity = getRecommendedGranularity(range.start, range.end);
          document.querySelectorAll('.btn-chart-granularity').forEach(gb => {
            if (gb.getAttribute('data-granularity') === this.chartGranularity) {
              gb.classList.add('active');
            } else {
              gb.classList.remove('active');
            }
          });
        }

        this.renderChart();
      });
    });

    // Custom date range inputs
    const startInp = document.getElementById('chart-date-start') as HTMLInputElement | null;
    const endInp = document.getElementById('chart-date-end') as HTMLInputElement | null;

    const handleCustomDateChange = () => {
      if (startInp && endInp) {
        this.customStartDate = startInp.value;
        this.customEndDate = endInp.value;
        const orders = this.state?.cache?.orders || [];
        const range = computeDateRange('custom', this.customStartDate, this.customEndDate, orders);
        const errEl = document.getElementById('chart-range-error');

        if (!range.isValid) {
          if (errEl) {
            errEl.textContent = range.error || 'Ошибка в датах';
            errEl.style.display = 'inline';
          }
        } else {
          if (errEl) errEl.style.display = 'none';
          this.chartGranularity = getRecommendedGranularity(range.start, range.end);
          document.querySelectorAll('.btn-chart-granularity').forEach(gb => {
            if (gb.getAttribute('data-granularity') === this.chartGranularity) {
              gb.classList.add('active');
            } else {
              gb.classList.remove('active');
            }
          });
          this.renderChart();
        }
      }
    };

    startInp?.addEventListener('change', handleCustomDateChange);
    endInp?.addEventListener('change', handleCustomDateChange);
    document.getElementById('btn-chart-apply-range')?.addEventListener('click', handleCustomDateChange);

    // Reset range button
    document.getElementById('btn-chart-reset-range')?.addEventListener('click', () => {
      const p7 = document.querySelector('.period-pill[data-days="7"]') as HTMLButtonElement | null;
      p7?.click();
    });

    // View all orders button on dashboard
    document.getElementById('btn-view-all-orders')?.addEventListener('click', () => {
      this.switchTab('orders');
    });

    // Global quick search
    document.getElementById('global-search-input')?.addEventListener('input', (e) => {
      const query = (e.target as HTMLInputElement).value.trim();
      if (query.length > 1) {
        this.orderSearchQuery = query.toLowerCase();
        this.clientSearchQuery = query.toLowerCase();
        this.renderRecentOrders();
      }
    });

    // Client orders drawer close
    document.getElementById('client-drawer-close')?.addEventListener('click', () => {
      const drawer = document.getElementById('client-orders-drawer');
      if (drawer) drawer.style.display = 'none';
    });
    document.getElementById('client-orders-drawer')?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).id === 'client-orders-drawer') {
        (e.target as HTMLElement).style.display = 'none';
      }
    });

    // Stop shift on shifts tab
    document.getElementById('btn-shifts-stop-active')?.addEventListener('click', async () => {
      const activeShiftRes = await chrome.runtime.sendMessage({ type: 'GET_SHIFT_STATE' });
      const op = activeShiftRes?.shiftState?.currentOperator || 'Оператор';
      if (!window.confirm(`Завершить активную смену оператора «${op}»?`)) return;
      await chrome.runtime.sendMessage({ type: 'STOP_SHIFT' });
      await this.refreshState();
    });
  }

  private renderDashboard() {
    if (!this.state) return;
    const orders = this.state.cache.orders;
    const sharePercent = this.state.settings.sellerSharePercent ?? 12;
    const balances = this.state.cache.accountInfo?.balancesByCurrency ?? {};
    const primaryCurrency = this.state.cache.accountInfo?.currency ?? '₽';
    const lastSync = this.state.cache.lastSyncTimestamp;

    const stats = calculateDashboardStats(orders, sharePercent, balances, primaryCurrency, lastSync);

    // Balance Card
    const balanceEl = document.getElementById('stat-balance-val');
    const userEl = document.getElementById('stat-balance-user');

    if (balanceEl) {
      if (this.state.cache.accountInfo) {
        const bList = Object.entries(balances).map(([curr, amt]) => formatMoney(amt, curr));
        balanceEl.textContent = bList.length > 0 ? bList.join(' • ') : formatMoney(this.state.cache.accountInfo.totalBalance, primaryCurrency);
      } else {
        balanceEl.textContent = '0 ₽';
      }
    }

    if (userEl && this.state.cache.accountInfo) {
      userEl.textContent = `Пользователь: ${this.state.cache.accountInfo.username} (ID ${this.state.cache.accountInfo.userId})`;
    } else if (userEl) {
      userEl.textContent = 'Укажите токен в разделе "FunPay API"';
    }

    // Share input & slider
    const shareInput = document.getElementById('input-seller-share') as HTMLInputElement | null;
    const shareSlider = document.getElementById('input-seller-share-slider') as HTMLInputElement | null;
    const shareDisplay = document.getElementById('dash-share-percent-display');

    if (shareInput) shareInput.value = String(sharePercent);
    if (shareSlider) shareSlider.value = String(sharePercent);
    if (shareDisplay) shareDisplay.textContent = `${sharePercent}%`;

    // Render Hero Delta metrics
    this.renderHeroDeltaMetrics(stats);

    // Render Operations split
    this.renderRecentOrders();
    this.renderLeaderboard();

    // Render active shift
    this.renderDashboardShift();
    this.renderHistoryCoverage();

    // Render sales chart
    this.renderChart();
  }

  private updateLiveShareCalc() {
    const input = document.getElementById('input-seller-share') as HTMLInputElement | null;
    const shareVal = parseFloat(input?.value || '12') || 0;
    const badge = document.getElementById('dash-hero-share-calc');
    if (!badge || !this.state) return;

    const orders = this.state.cache.orders || [];
    const stats = calculateDashboardStats(
      orders,
      shareVal,
      this.state.cache.accountInfo?.balancesByCurrency ?? {},
      this.state.cache.accountInfo?.currency ?? '₽',
      this.state.cache.lastSyncTimestamp ?? null
    );

    const curr = normalizeCurrency(this.chartCurrency);
    const todayStat = stats.today?.currencies?.[curr];
    const todayTurnover = todayStat?.turnover || 0;
    const shareEarned = todayTurnover * (shareVal / 100);
    badge.textContent = `Чистая доля сегодня: ${formatMoney(shareEarned, curr)}`;
  }

  private renderHeroDeltaMetrics(stats: any) {
    const todayTurnoverEl = document.getElementById('dash-today-turnover-val');
    const todayOrdersEl = document.getElementById('dash-today-orders-count');
    const todayDeltaEl = document.getElementById('dash-today-delta');

    const d7TurnoverEl = document.getElementById('dash-7d-turnover-val');
    const d7AvgCheckEl = document.getElementById('dash-7d-avg-check');

    const closedRateEl = document.getElementById('dash-closed-rate-val');
    const qualityBadgeEl = document.getElementById('dash-quality-badge');
    const alltimeSummaryEl = document.getElementById('dash-alltime-summary');

    const curr = normalizeCurrency(this.chartCurrency);
    const todayStat = stats.today?.currencies?.[curr];
    const todayTurnover = todayStat?.turnover || 0;
    const todayOrders = todayStat?.ordersCount || 0;

    const d7Stat = stats.last7Days?.currencies?.[curr];
    const d7Turnover = d7Stat?.turnover || 0;
    const d7Orders = d7Stat?.ordersCount || 0;
    const d7AvgCheck = d7Orders > 0 ? Math.round(d7Turnover / d7Orders) : 0;

    const allStat = stats.allTime?.currencies?.[curr];
    const allTurnover = allStat?.turnover || 0;
    const allOrders = allStat?.ordersCount || 0;
    const allRefunds = allStat?.refundedCount || 0;
    const totalTransactions = allOrders + allRefunds;
    const successRate = totalTransactions > 0 ? Math.round((allOrders / totalTransactions) * 100) : 100;

    if (todayTurnoverEl) todayTurnoverEl.textContent = formatMoney(todayTurnover, curr);
    if (todayOrdersEl) todayOrdersEl.textContent = `${todayOrders} закрытых заказов`;
    if (todayDeltaEl) {
      const avgDaily7 = d7Turnover / 7;
      if (avgDaily7 > 0) {
        const delta = Math.round(((todayTurnover - avgDaily7) / avgDaily7) * 100);
        todayDeltaEl.textContent = `${delta >= 0 ? '+' : ''}${delta}%`;
        todayDeltaEl.className = `delta-badge ${delta >= 0 ? 'positive' : 'neutral'}`;
      } else {
        todayDeltaEl.textContent = '100% ▲';
        todayDeltaEl.className = 'delta-badge positive';
      }
    }

    if (d7TurnoverEl) d7TurnoverEl.textContent = formatMoney(d7Turnover, curr);
    if (d7AvgCheckEl) d7AvgCheckEl.textContent = `Средний чек: ${formatMoney(d7AvgCheck, curr)}`;

    if (closedRateEl) closedRateEl.textContent = `${allRefunds} возвр. (${allOrders} успешн.)`;
    if (qualityBadgeEl) {
      qualityBadgeEl.textContent = `${successRate}%`;
      qualityBadgeEl.className = `delta-badge ${successRate >= 95 ? 'success' : 'neutral'}`;
    }
    if (alltimeSummaryEl) alltimeSummaryEl.textContent = `Всего заказов: ${totalTransactions}`;

    this.updateLiveShareCalc();
  }

  private renderRecentOrders() {
    const tbody = document.getElementById('dash-recent-orders-body');
    const emptyBox = document.getElementById('dash-recent-empty');
    const badgeTotal = document.getElementById('dash-orders-total-badge');
    if (!tbody || !this.state) return;

    let orders = this.state.cache.orders || [];
    if (badgeTotal) badgeTotal.textContent = String(orders.length);

    if (this.orderSearchQuery) {
      orders = orders.filter(o =>
        o.id.toLowerCase().includes(this.orderSearchQuery) ||
        (o.buyer && o.buyer.toLowerCase().includes(this.orderSearchQuery)) ||
        (o.title && o.title.toLowerCase().includes(this.orderSearchQuery))
      );
    }

    if (orders.length === 0) {
      tbody.innerHTML = '';
      if (emptyBox) emptyBox.style.display = 'block';
      return;
    }
    if (emptyBox) emptyBox.style.display = 'none';

    const recent = orders.slice(0, 8);
    tbody.innerHTML = recent.map(o => {
      const statusPill = o.status === 'closed'
        ? '<span class="status-pill closed">Закрыт</span>'
        : (o.status === 'paid' ? '<span class="status-pill paid">Оплачен</span>' : '<span class="status-pill refunded">Возврат</span>');
      return `
        <tr>
          <td><strong style="font-family:var(--font-mono); font-size:11px;">#${o.id}</strong></td>
          <td style="white-space:nowrap;">${o.dateStr}</td>
          <td><strong>${o.buyer || 'Покупатель'}</strong></td>
          <td class="tabular-nums" style="font-weight:600; color:var(--text-primary);">${formatMoney(o.price, o.currency)}</td>
          <td>${statusPill}</td>
        </tr>
      `;
    }).join('');
  }

  private renderLeaderboard() {
    const listEl = document.getElementById('dash-leaderboard-list');
    if (!listEl) return;

    if (this.shifts.length === 0) {
      listEl.innerHTML = `
        <div style="color:var(--text-muted); font-size:12px; text-align:center; padding:16px 0;">
          Смен пока нет. Статистика появится после завершения первой смены.
        </div>
      `;
      return;
    }

    const opStats: Record<string, { shiftsCount: number; turnoverByCurrency: Record<string, number>; totalSeconds: number; ordersCount: number }> = {};
    for (const s of this.shifts) {
      const name = s.operatorName || 'Без имени';
      if (!opStats[name]) {
        opStats[name] = { shiftsCount: 0, turnoverByCurrency: {}, totalSeconds: 0, ordersCount: 0 };
      }
      opStats[name].shiftsCount += 1;
      opStats[name].totalSeconds += (s.duration || 0) / 1000;
      opStats[name].ordersCount += (s.earnings?.ordersCount || 0);

      const tc = s.earnings?.turnoverByCurrency || {};
      for (const [c, amt] of Object.entries(tc)) {
        opStats[name].turnoverByCurrency[c] = (opStats[name].turnoverByCurrency[c] || 0) + amt;
      }
    }

    const items = Object.entries(opStats).sort((a, b) => b[1].shiftsCount - a[1].shiftsCount).slice(0, 5);

    listEl.innerHTML = items.map(([name, stat]) => {
      const hours = Math.round((stat.totalSeconds / 3600) * 10) / 10;
      const turnParts = Object.entries(stat.turnoverByCurrency).map(([c, amt]) => formatMoney(amt, c));
      const turnStr = turnParts.length > 0 ? turnParts.join(' • ') : '0 ₽';
      const initials = name.slice(0, 2).toUpperCase();

      return `
        <div class="leader-item">
          <div class="leader-left">
            <div class="leader-avatar">${initials}</div>
            <div>
              <div class="leader-name">${name}</div>
              <div class="leader-meta">${stat.shiftsCount} смен (${hours} ч) • ${stat.ordersCount} зак.</div>
            </div>
          </div>
          <div class="leader-right">
            <div class="leader-val tabular-nums">${turnStr}</div>
          </div>
        </div>
      `;
    }).join('');
  }

  private async renderDashboardShift() {
    const shiftBanner = document.getElementById('dashboard-active-shift');
    const topbarPill = document.getElementById('topbar-shift-pill');
    const topbarText = document.getElementById('topbar-shift-text');
    const topbarBtn = document.getElementById('btn-topbar-shift-action');

    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_SHIFT_STATE' });
      const shiftState = res?.shiftState;

      if (!shiftState || !shiftState.shiftActive || !shiftState.shiftStartTime) {
        if (shiftBanner) shiftBanner.style.display = 'none';
        if (topbarPill) {
          topbarPill.className = 'topbar-shift-pill shift-idle';
          if (topbarText) topbarText.textContent = 'Смена не начата';
          if (topbarBtn) {
            topbarBtn.textContent = '▶ Старт';
            topbarBtn.title = 'Начать смену';
          }
        }
        return;
      }

      if (shiftBanner) shiftBanner.style.display = 'block';
      const opEl = document.getElementById('dash-shift-op');
      const startEl = document.getElementById('dash-shift-start');
      const timerEl = document.getElementById('dash-shift-timer');
      const earningsEl = document.getElementById('dash-shift-earnings');

      const opName = shiftState.currentOperator || 'Оператор 1';
      if (opEl) opEl.textContent = `👤 ${opName}`;
      if (startEl) startEl.textContent = `Начало: ${formatTimeOnly(shiftState.shiftStartTime)}`;

      const orders = this.state?.cache?.orders || [];
      const sharePercent = this.state?.settings?.sellerSharePercent ?? 12.0;

      const elapsed = Math.max(0, Date.now() - shiftState.shiftStartTime);
      const elapsedFormatted = formatDuration(elapsed);
      if (timerEl) timerEl.textContent = elapsedFormatted;

      const e = calculateShiftEarnings(shiftState.shiftStartTime, Date.now(), orders, sharePercent);
      const parts: string[] = [];
      for (const [curr, amt] of Object.entries(e.turnoverByCurrency)) {
        if (amt > 0) parts.push(formatMoney(amt, curr));
      }
      const turnoverStr = parts.length > 0 ? parts.join(', ') : '0 ₽';
      if (earningsEl) {
        earningsEl.textContent = `Заказов: ${e.ordersCount} • Выручка: ${turnoverStr}`;
      }

      // Update Topbar
      if (topbarPill) {
        topbarPill.className = 'topbar-shift-pill shift-active';
        if (topbarText) topbarText.textContent = `${opName} • ${elapsedFormatted}`;
        if (topbarBtn) {
          topbarBtn.textContent = '🛑 Стоп';
          topbarBtn.title = 'Завершить активную смену';
        }
      }
    } catch {
      // ignore
    }
  }

  private renderHistoryCoverage() {
    const orders = this.state?.cache?.orders || [];
    const spanTextEl = document.getElementById('coverage-span-text');
    const metaTextEl = document.getElementById('coverage-meta-text');

    if (!spanTextEl || !metaTextEl) return;

    if (orders.length === 0) {
      spanTextEl.textContent = 'Нет загруженных данных. Нажмите «Загрузить всю историю».';
      metaTextEl.textContent = '0 заказов в базе';
      return;
    }

    const newest = orders[0];
    const oldest = orders[orders.length - 1];

    const newestStr = newest.dateStr || (newest.timestamp ? new Date(newest.timestamp).toLocaleDateString('ru-RU') : '');
    const oldestStr = oldest.dateStr || (oldest.timestamp ? new Date(oldest.timestamp).toLocaleDateString('ru-RU') : '');

    spanTextEl.textContent = oldestStr && newestStr ? `с ${oldestStr} по ${newestStr}` : 'История загружена';
    metaTextEl.textContent = `Всего в базе: ${orders.length} заказов`;
  }

  private updateSyncProgressUI(prog: import('../../src/shared/types').SyncProgress | null) {
    const banner = document.getElementById('sync-progress-banner');
    const title = document.getElementById('sync-progress-text');
    const counter = document.getElementById('sync-progress-counter');
    const bar = document.getElementById('sync-progress-bar');
    const sub = document.getElementById('sync-progress-sub');

    if (!banner || !prog) {
      if (banner && (!prog || !prog.inProgress)) {
        banner.style.display = 'none';
      }
      return;
    }

    if (prog.inProgress) {
      banner.style.display = 'block';
      if (title) title.textContent = prog.stage || 'Синхронизация истории продаж...';
      if (counter) counter.textContent = `${prog.totalOrdersFetched || 0} зак.`;
      if (bar) {
        const pct = Math.min(95, Math.max(10, (prog.page || 1) * 6));
        bar.style.width = `${pct}%`;
      }
      if (sub) {
        sub.textContent = `Страница ${prog.page || 1} • Последний заказ от: ${prog.oldestOrderDate || '—'}`;
      }
    } else {
      if (bar) bar.style.width = '100%';
      if (title) title.textContent = prog.error ? `Ошибка: ${prog.error}` : 'Синхронизация завершена!';
      setTimeout(() => {
        banner.style.display = 'none';
      }, 3000);
    }
  }

  private renderChart() {
    const container = document.getElementById('chart-container');
    if (!container || !this.state) return;

    const orders = this.state.cache.orders || [];
    const sharePercent = this.state.settings.sellerSharePercent ?? 12;
    const curr = normalizeCurrency(this.chartCurrency);

    // Compute active range
    const range = computeDateRange(this.chartPeriod, this.customStartDate, this.customEndDate, orders);
    const summaryEl = document.getElementById('chart-range-summary');
    if (summaryEl && range.label) {
      summaryEl.textContent = range.label;
    }

    const errEl = document.getElementById('chart-range-error');
    if (!range.isValid) {
      if (errEl) {
        errEl.textContent = range.error || 'Некорректный диапазон дат';
        errEl.style.display = 'inline';
      }
      return;
    } else {
      if (errEl) errEl.style.display = 'none';
    }

    // Generate buckets with zero-filling
    const buckets = generateBuckets(orders, range.start, range.end, this.chartGranularity, curr, sharePercent);

    // Render SVG
    container.innerHTML = generateSvgChart(buckets, this.chartMetric, curr, {
      width: container.clientWidth || 860,
      height: 260
    });

    this.bindChartTooltip(container);
  }

  private bindChartTooltip(container: HTMLElement) {
    const tooltip = document.getElementById('chart-tooltip');
    if (!tooltip) return;

    const pointGroups = container.querySelectorAll('.chart-point-group');
    const crosshair = container.querySelector('#chart-crosshair') as SVGLineElement | null;

    pointGroups.forEach(g => {
      g.addEventListener('mouseenter', (e) => {
        const target = e.currentTarget as HTMLElement;
        const date = target.getAttribute('data-date') || '';
        const val = target.getAttribute('data-val') || '';
        const turnover = target.getAttribute('data-turnover') || '';
        const share = target.getAttribute('data-share') || '';
        const ordersCount = target.getAttribute('data-orders') || '0';
        const refundsCount = parseInt(target.getAttribute('data-refunds') || '0', 10);

        const dEl = document.getElementById('tt-date');
        const vEl = document.getElementById('tt-val');
        const tEl = document.getElementById('tt-turnover');
        const sEl = document.getElementById('tt-share');
        const oEl = document.getElementById('tt-orders');
        const refRow = document.getElementById('tt-refunds-row');
        const refEl = document.getElementById('tt-refunds');

        if (dEl) dEl.textContent = date;
        if (vEl) vEl.textContent = val;
        if (tEl) tEl.textContent = turnover;
        if (sEl) sEl.textContent = share;
        if (oEl) oEl.textContent = `${ordersCount} шт.`;
        if (refRow && refEl) {
          if (refundsCount > 0) {
            refEl.textContent = `${refundsCount} шт.`;
            refRow.style.display = 'flex';
          } else {
            refRow.style.display = 'none';
          }
        }

        tooltip.style.display = 'block';

        // Update crosshair
        const circle = target.querySelector('.chart-hit-area') as SVGCircleElement | null;
        if (crosshair && circle) {
          const cx = circle.getAttribute('cx') || '0';
          crosshair.setAttribute('x1', cx);
          crosshair.setAttribute('x2', cx);
          crosshair.style.opacity = '1';
        }
      });

      g.addEventListener('mousemove', (e: MouseEvent) => {
        const wrapper = container.parentElement;
        if (!wrapper) return;
        const rect = wrapper.getBoundingClientRect();
        let left = e.clientX - rect.left + 15;
        let top = e.clientY - rect.top - 20;

        if (left + 180 > rect.width) {
          left = e.clientX - rect.left - 195;
        }
        if (top < 10) top = 10;

        tooltip.style.left = `${left}px`;
        tooltip.style.top = `${top}px`;
      });
    });

    container.addEventListener('mouseleave', () => {
      tooltip.style.display = 'none';
      if (crosshair) crosshair.style.opacity = '0';
    });
  }

  // ==========================================================================
  // 2. SHIFTS HISTORY
  // ==========================================================================
  private bindShiftsEvents() {
    // Filter by operator
    document.getElementById('shifts-filter-operator')?.addEventListener('change', (e) => {
      this.shiftsOperatorFilter = (e.target as HTMLSelectElement).value;
      this.renderShiftsTable();
    });

    // Filter by period
    document.getElementById('shifts-filter-period')?.addEventListener('change', (e) => {
      this.shiftsPeriodFilter = (e.target as HTMLSelectElement).value;
      this.renderShiftsTable();
    });

    // Manual add shift button
    document.getElementById('btn-add-shift-manual')?.addEventListener('click', () => {
      this.openShiftModal();
    });

    // Recalculate shifts button
    document.getElementById('btn-recalculate-shifts')?.addEventListener('click', async () => {
      const btn = document.getElementById('btn-recalculate-shifts') as HTMLButtonElement | null;
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span class="btn-icon">⏳</span> Пересчет...';
      }
      try {
        const res = await chrome.runtime.sendMessage({ type: 'RECALCULATE_SHIFTS_EARNINGS' });
        if (res?.history) {
          this.shifts = res.history;
        }
        await this.refreshState();
        alert('Выручка по всем сменам успешно пересчитана на основе сохраненных заказов FunPay!');
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = '<span class="btn-icon">🔄</span> Пересчитать выручку';
        }
      }
    });

    // Export CSV button
    document.getElementById('btn-export-shifts-csv')?.addEventListener('click', () => {
      this.exportShiftsCsv();
    });

    // Import Historical Shifts button (v1.0-v2.1 legacy shifts of "Алекс")
    document.getElementById('btn-import-historical-shifts')?.addEventListener('click', async () => {
      const btn = document.getElementById('btn-import-historical-shifts') as HTMLButtonElement | null;
      const resDiv = document.getElementById('historical-shifts-result');
      if (btn) {
        btn.disabled = true;
        btn.textContent = '⏳ Перенос смен в Cloud...';
      }
      if (resDiv) {
        resDiv.style.display = 'none';
      }

      try {
        const res = await chrome.runtime.sendMessage({ action: 'IMPORT_HISTORICAL_SHIFTS' });
        if (resDiv) {
          resDiv.style.display = 'block';
          if (res?.success) {
            resDiv.style.color = '#34d399';
            resDiv.innerHTML = `✔ Успешно перенесено: <strong>${res.importedCount ?? 0}</strong> смен (пропущено: ${res.skippedCount ?? 0}). Смены закреплены за Создателем!`;
            if (btn) {
              btn.textContent = '✔ Перенос завершён';
            }
            await this.refreshState();
          } else {
            resDiv.style.color = '#f87171';
            resDiv.textContent = `❌ Ошибка переноса: ${res?.error || 'Неизвестная ошибка'}`;
            if (btn) {
              btn.disabled = false;
              btn.textContent = 'Повторить перенос';
            }
          }
        }
      } catch (err: unknown) {
        if (resDiv) {
          resDiv.style.display = 'block';
          resDiv.style.color = '#f87171';
          resDiv.textContent = `❌ Ошибка: ${err instanceof Error ? err.message : 'Не удалось выполнить запрос'}`;
        }
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'Повторить перенос';
        }
      }
    });

    // Shift modal close/cancel
    const closeModal = () => this.closeShiftModal();
    document.getElementById('btn-shift-modal-cancel')?.addEventListener('click', closeModal);
    document.getElementById('shift-modal-close')?.addEventListener('click', closeModal);

    // Save shift modal button
    document.getElementById('btn-shift-modal-save')?.addEventListener('click', async () => {
      const idInp = (document.getElementById('modal-shift-id') as HTMLInputElement)?.value;
      const opInp = (document.getElementById('modal-shift-operator') as HTMLInputElement)?.value?.trim();
      const sInp = (document.getElementById('modal-shift-start') as HTMLInputElement)?.value;
      const eInp = (document.getElementById('modal-shift-end') as HTMLInputElement)?.value;
      const rateInp = parseFloat((document.getElementById('modal-shift-rate') as HTMLInputElement)?.value || '10') || 10;
      const noteInp = (document.getElementById('modal-shift-note') as HTMLInputElement)?.value?.trim();

      if (!opInp) {
        alert('Пожалуйста, укажите имя сменщика/оператора.');
        return;
      }
      if (!sInp || !eInp) {
        alert('Пожалуйста, укажите время начала и окончания смены.');
        return;
      }

      const sTime = new Date(sInp).getTime();
      const eTime = new Date(eInp).getTime();
      if (isNaN(sTime) || isNaN(eTime) || eTime <= sTime) {
        alert('Время окончания смены должно быть позже времени начала!');
        return;
      }

      const dur = eTime - sTime;
      const orders = this.state?.cache?.orders || [];
      const earnings = calculateShiftEarnings(sTime, eTime, orders, rateInp);

      const shift: CompletedShift = {
        id: idInp || `shift_${sTime}_${Math.random().toString(36).slice(2, 8)}`,
        operatorName: opInp,
        startTime: sTime,
        endTime: eTime,
        duration: dur,
        sellerSharePercent: rateInp,
        earnings,
        note: noteInp || undefined
      };

      await chrome.runtime.sendMessage({
        type: 'SAVE_SHIFT',
        payload: { shift }
      });

      this.closeShiftModal();
      await this.refreshState();
    });
  }

  private renderShifts() {
    if (!this.state) return;

    // Populate operators filter dropdown
    const filterSelect = document.getElementById('shifts-filter-operator') as HTMLSelectElement | null;
    const modalDatalist = document.getElementById('modal-operators-datalist');

    const knownOperators = new Set<string>();
    if (this.state.settings.operatorsList) {
      this.state.settings.operatorsList.forEach(op => knownOperators.add(op));
    }
    this.shifts.forEach(s => {
      if (s.operatorName) knownOperators.add(s.operatorName);
    });

    if (filterSelect) {
      const cur = this.shiftsOperatorFilter;
      filterSelect.innerHTML = '<option value="all">Все сменщики</option>' +
        Array.from(knownOperators).map(op => `<option value="${op}" ${op === cur ? 'selected' : ''}>${op}</option>`).join('');
    }

    if (modalDatalist) {
      modalDatalist.innerHTML = Array.from(knownOperators).map(op => `<option value="${op}"></option>`).join('');
    }

    this.renderShiftsActiveBanner();
    this.renderShiftsTable();
    this.checkHistoricalShiftsBanner();
  }

  private async checkHistoricalShiftsBanner() {
    const banner = document.getElementById('historical-shifts-banner');
    const countBadge = document.getElementById('historical-shifts-count-badge');
    if (!banner) return;

    try {
      const res = await chrome.runtime.sendMessage({ action: 'CHECK_HISTORICAL_SHIFTS' });
      if (res?.success && typeof res.count === 'number' && res.count > 0) {
        banner.style.display = 'block';
        if (countBadge) countBadge.textContent = `${res.count} смен`;
      } else {
        banner.style.display = 'none';
      }
    } catch (e) {
      console.warn('Failed to check historical shifts banner:', e);
      banner.style.display = 'none';
    }
  }

  private async renderShiftsActiveBanner() {
    const banner = document.getElementById('shifts-active-banner');
    if (!banner) return;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_SHIFT_STATE' });
      const shiftState = res?.shiftState;

      const liveBadgeNav = document.getElementById('nav-badge-shift-live');

      if (!shiftState || !shiftState.shiftActive || !shiftState.shiftStartTime) {
        banner.style.display = 'none';
        if (liveBadgeNav) liveBadgeNav.style.display = 'none';
        return;
      }

      banner.style.display = 'flex';
      if (liveBadgeNav) liveBadgeNav.style.display = 'inline-block';

      const opEl = document.getElementById('shifts-active-op');
      const startEl = document.getElementById('shifts-active-start');
      const timerEl = document.getElementById('shifts-active-timer');
      const earningsEl = document.getElementById('shifts-active-earnings');

      const opName = shiftState.currentOperator || 'Оператор 1';
      if (opEl) opEl.textContent = `👤 ${opName}`;
      if (startEl) startEl.textContent = `Старт: ${formatTimeOnly(shiftState.shiftStartTime)}`;

      const elapsed = Math.max(0, Date.now() - shiftState.shiftStartTime);
      if (timerEl) timerEl.textContent = formatDuration(elapsed);

      const orders = this.state?.cache?.orders || [];
      const percent = this.state?.settings?.sellerSharePercent ?? 12.0;
      const earnings = calculateShiftEarnings(shiftState.shiftStartTime, Date.now(), orders, percent);

      const parts: string[] = [];
      for (const [c, amt] of Object.entries(earnings.turnoverByCurrency)) {
        if (amt > 0) parts.push(formatMoney(amt, c));
      }
      const turnStr = parts.length > 0 ? parts.join(', ') : '0 ₽';
      if (earningsEl) earningsEl.textContent = `${earnings.ordersCount} зак. • Оборот: ${turnStr}`;
    } catch {
      // ignore
    }
  }

  private renderShiftsTable() {
    const tbody = document.getElementById('shifts-table-body');
    const emptyBox = document.getElementById('shifts-empty');
    if (!tbody) return;

    let filtered = [...this.shifts];

    // Filter by operator
    if (this.shiftsOperatorFilter !== 'all') {
      filtered = filtered.filter(s => (s.operatorName || 'Оператор 1') === this.shiftsOperatorFilter);
    }

    // Filter by period
    const now = new Date();
    if (this.shiftsPeriodFilter === 'today') {
      const todayStart = getUserStartOfToday().getTime();
      filtered = filtered.filter(s => s.startTime >= todayStart);
    } else if (this.shiftsPeriodFilter === '7days') {
      const d7 = getUserStartOfDaysAgo(7).getTime();
      filtered = filtered.filter(s => s.startTime >= d7);
    } else if (this.shiftsPeriodFilter === '30days') {
      const d30 = getUserStartOfDaysAgo(30).getTime();
      filtered = filtered.filter(s => s.startTime >= d30);
    } else if (this.shiftsPeriodFilter === 'this_month') {
      const mStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
      filtered = filtered.filter(s => s.startTime >= mStart);
    }

    // Sort newest first
    filtered.sort((a, b) => b.startTime - a.startTime);

    // Update Overview Metric Cards
    let totalDurationMs = 0;
    const totalTurnoverByCurr: Record<string, number> = {};
    const totalShareByCurr: Record<string, number> = {};
    let totalOrdersCount = 0;

    for (const s of filtered) {
      const dur = s.duration || (s.endTime && s.startTime ? Math.max(0, s.endTime - s.startTime) : 0);
      totalDurationMs += dur;
      totalOrdersCount += s.earnings?.ordersCount || 0;
      for (const [curr, amt] of Object.entries(s.earnings?.turnoverByCurrency || {})) {
        totalTurnoverByCurr[curr] = (totalTurnoverByCurr[curr] || 0) + amt;
      }
      for (const [curr, amt] of Object.entries(s.earnings?.sellerShareByCurrency || {})) {
        totalShareByCurr[curr] = (totalShareByCurr[curr] || 0) + amt;
      }
    }

    const totalHours = Math.floor(totalDurationMs / 3600000);
    const totalMins = Math.floor((totalDurationMs % 3600000) / 60000);
    const avgDurationMs = filtered.length > 0 ? Math.round(totalDurationMs / filtered.length) : 0;
    const avgHours = (avgDurationMs / 3600000).toFixed(1);

    const hoursEl = document.getElementById('shifts-total-hours-val');
    const countBadge = document.getElementById('shifts-total-count-badge');
    const avgDurEl = document.getElementById('shifts-avg-duration-val');
    const turnoverEl = document.getElementById('shifts-total-turnover-val');
    const ordersBadge = document.getElementById('shifts-total-orders-badge');
    const shareEl = document.getElementById('shifts-total-share-val');

    if (hoursEl) hoursEl.textContent = `${totalHours} ч ${totalMins} мин`;
    if (countBadge) countBadge.textContent = `${filtered.length} смен`;
    if (avgDurEl) avgDurEl.textContent = `Средняя смена: ${avgHours} ч`;
    if (ordersBadge) ordersBadge.textContent = `${totalOrdersCount} заказов`;

    if (turnoverEl) {
      const turnParts = Object.entries(totalTurnoverByCurr).map(([c, amt]) => formatMoney(amt, c));
      turnoverEl.textContent = turnParts.length > 0 ? turnParts.join(' • ') : '0 ₽';
    }
    if (shareEl) {
      const shareParts = Object.entries(totalShareByCurr).map(([c, amt]) => formatMoney(amt, c));
      shareEl.textContent = shareParts.length > 0 ? shareParts.join(' • ') : '0 ₽';
    }

    // Render Table Rows
    if (filtered.length === 0) {
      tbody.innerHTML = '';
      if (emptyBox) emptyBox.style.display = 'block';
      return;
    }

    if (emptyBox) emptyBox.style.display = 'none';

    tbody.innerHTML = filtered.map(s => {
      const startDate = new Date(s.startTime);
      const dateFormatted = startDate.toLocaleDateString('ru-RU', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        year: 'numeric'
      });
      const intervalStr = `${formatTimeOnly(s.startTime)} — ${formatTimeOnly(s.endTime)}`;
      const durMs = s.duration || (s.endTime && s.startTime ? Math.max(0, s.endTime - s.startTime) : 0);
      const durStr = formatDuration(durMs);

      const turnoverParts = Object.entries(s.earnings?.turnoverByCurrency || {})
        .filter(([, a]) => a > 0)
        .map(([c, a]) => formatMoney(a, c));
      const turnoverFormatted = turnoverParts.length > 0 ? turnoverParts.join('<br>') : '0 ₽';

      const shareParts = Object.entries(s.earnings?.sellerShareByCurrency || {})
        .filter(([, a]) => a > 0)
        .map(([c, a]) => formatMoney(a, c));
      const shareFormatted = shareParts.length > 0 ? shareParts.join('<br>') : '0 ₽';

      const ordersBtn = (s.earnings?.ordersCount || 0) > 0
        ? `<button class="btn btn-xs btn-outline btn-shift-orders-inspect" data-shift-id="${s.id}">${s.earnings.ordersCount} шт. 🔍</button>`
        : `<span style="color: var(--text-muted);">0</span>`;

      return `
        <tr>
          <td><strong>${dateFormatted}</strong></td>
          <td><span class="operator-badge">👤 ${s.operatorName || 'Оператор 1'}</span></td>
          <td class="tabular-nums">${intervalStr}</td>
          <td class="tabular-nums" style="font-weight: 600; color: #34D399;">${durStr}</td>
          <td>${ordersBtn}</td>
          <td class="tabular-nums" style="font-weight: 600;">${turnoverFormatted}</td>
          <td class="tabular-nums" style="color: #34D399; font-weight: 600;">${shareFormatted}</td>
          <td style="color: var(--text-muted); font-size: 11px; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${s.note || '—'}</td>
          <td style="text-align: right;">
            <div style="display: inline-flex; gap: 6px;">
              <button class="btn btn-xs btn-outline btn-edit-shift" data-shift-id="${s.id}" title="Редактировать смену">✏️</button>
              <button class="btn btn-xs btn-danger-glow btn-delete-shift" data-shift-id="${s.id}" title="Удалить смену">🗑️</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');

    // Attach row events
    tbody.querySelectorAll('.btn-shift-orders-inspect').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-shift-id');
        const shift = this.shifts.find(s => s.id === id);
        if (shift) this.viewShiftOrders(shift);
      });
    });

    tbody.querySelectorAll('.btn-edit-shift').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-shift-id');
        const shift = this.shifts.find(s => s.id === id);
        if (shift) this.openShiftModal(shift);
      });
    });

    tbody.querySelectorAll('.btn-delete-shift').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-shift-id');
        if (!id) return;
        if (!confirm('Вы уверены, что хотите удалить эту запись о смене?')) return;
        await chrome.runtime.sendMessage({
          type: 'DELETE_SHIFT',
          payload: { shiftId: id }
        });
        await this.refreshState();
      });
    });
  }

  private openShiftModal(shift?: CompletedShift) {
    const modal = document.getElementById('shift-modal');
    if (!modal) return;

    const idInp = document.getElementById('modal-shift-id') as HTMLInputElement;
    const opInp = document.getElementById('modal-shift-operator') as HTMLInputElement;
    const sInp = document.getElementById('modal-shift-start') as HTMLInputElement;
    const eInp = document.getElementById('modal-shift-end') as HTMLInputElement;
    const rateInp = document.getElementById('modal-shift-rate') as HTMLInputElement;
    const noteInp = document.getElementById('modal-shift-note') as HTMLTextAreaElement;
    const titleEl = document.getElementById('shift-modal-title');
    const delBtn = document.getElementById('btn-shift-modal-delete') as HTMLButtonElement | null;

    if (shift) {
      if (titleEl) titleEl.textContent = 'Редактирование смены';
      if (idInp) idInp.value = shift.id;
      if (opInp) opInp.value = shift.operatorName;
      if (sInp) sInp.value = new Date(shift.startTime).toISOString().slice(0, 16);
      if (eInp) eInp.value = new Date(shift.endTime).toISOString().slice(0, 16);
      if (rateInp) rateInp.value = String(shift.sellerSharePercent || 10);
      if (noteInp) noteInp.value = shift.note || '';
      if (delBtn) {
        delBtn.style.display = 'inline-block';
        delBtn.onclick = async () => {
          if (confirm('Удалить эту смену?')) {
            await chrome.runtime.sendMessage({ type: 'DELETE_SHIFT', payload: { shiftId: shift.id } });
            this.closeShiftModal();
            await this.refreshState();
          }
        };
      }
    } else {
      if (titleEl) titleEl.textContent = 'Добавление смены вручную';
      if (idInp) idInp.value = '';
      if (opInp) opInp.value = this.state?.settings?.operatorsList?.[0] || 'Оператор 1';
      const now = new Date();
      const past = new Date(now.getTime() - 8 * 3600000);
      if (sInp) sInp.value = past.toISOString().slice(0, 16);
      if (eInp) eInp.value = now.toISOString().slice(0, 16);
      if (rateInp) rateInp.value = String(this.state?.settings?.sellerSharePercent || 10);
      if (noteInp) noteInp.value = '';
      if (delBtn) delBtn.style.display = 'none';
    }

    modal.style.display = 'flex';
  }

  private closeShiftModal() {
    const modal = document.getElementById('shift-modal');
    if (modal) modal.style.display = 'none';
  }

  private viewShiftOrders(shift: CompletedShift) {
    const drawer = document.getElementById('client-orders-drawer');
    const titleEl = document.getElementById('client-drawer-title');
    const summaryEl = document.getElementById('client-drawer-summary');
    const tbody = document.getElementById('client-drawer-orders');
    if (!drawer || !this.state) return;

    const orders = (this.state.cache.orders || []).filter(o =>
      o.timestamp >= shift.startTime && o.timestamp <= shift.endTime
    );

    if (titleEl) titleEl.textContent = `Смена: ${shift.operatorName} (${formatDuration(shift.duration)})`;

    const parts = Object.entries(shift.earnings?.turnoverByCurrency || {}).map(([c, amt]) => formatMoney(amt, c));
    const turnStr = parts.length > 0 ? parts.join(' • ') : '0 ₽';

    if (summaryEl) {
      summaryEl.innerHTML = `
        <div>
          <div style="font-size:11px; color:var(--text-muted);">Заказов за смену:</div>
          <div style="font-size:16px; font-weight:700; color:#fff;">${orders.length}</div>
        </div>
        <div>
          <div style="font-size:11px; color:var(--text-muted);">Оборот смены:</div>
          <div style="font-size:16px; font-weight:700; color:var(--accent-emerald);">${turnStr}</div>
        </div>
        <div>
          <div style="font-size:11px; color:var(--text-muted);">Ставка:</div>
          <div style="font-size:16px; font-weight:700; color:#fff;">${shift.sellerSharePercent}%</div>
        </div>
      `;
    }

    if (tbody) {
      if (orders.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:20px; color:var(--text-muted);">Заказы в указанный интервал не найдены</td></tr>`;
      } else {
        tbody.innerHTML = orders.map(o => {
          const statusPill = o.status === 'closed'
            ? '<span class="status-pill closed">Закрыт</span>'
            : (o.status === 'paid' ? '<span class="status-pill paid">Оплачен</span>' : '<span class="status-pill refunded">Возврат</span>');
          return `
            <tr>
              <td><strong style="font-family:var(--font-mono); font-size:11px;">#${o.id}</strong></td>
              <td>${o.dateStr}</td>
              <td>${o.title}</td>
              <td class="tabular-nums" style="font-weight:600;">${formatMoney(o.price, o.currency)}</td>
              <td>${statusPill}</td>
            </tr>
          `;
        }).join('');
      }
    }

    drawer.style.display = 'flex';
  }

  private exportShiftsCsv() {
    if (this.shifts.length === 0) {
      alert('История смен пуста!');
      return;
    }

    const headers = ['ID', 'Оператор', 'Начало', 'Окончание', 'Длительность (мин)', 'Заказов', 'Оборот', 'Доля', 'Заметка'];
    const rows = this.shifts.map(s => {
      const turnParts = Object.entries(s.earnings?.turnoverByCurrency || {}).map(([c, a]) => `${a} ${c}`).join('; ');
      const shareParts = Object.entries(s.earnings?.sellerShareByCurrency || {}).map(([c, a]) => `${a} ${c}`).join('; ');
      const durMins = Math.round((s.duration || 0) / 60000);

      return [
        `"${s.id}"`,
        `"${s.operatorName || ''}"`,
        `"${new Date(s.startTime).toLocaleString('ru-RU')}"`,
        `"${new Date(s.endTime).toLocaleString('ru-RU')}"`,
        durMins,
        s.earnings?.ordersCount || 0,
        `"${turnParts}"`,
        `"${shareParts}"`,
        `"${(s.note || '').replace(/"/g, '""')}"`
      ].join(',');
    });

    const csvContent = '\uFEFF' + [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `funpay_shifts_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ==========================================================================
  // 3. ORDERS
  // ==========================================================================
  private bindOrdersEvents() {
    document.querySelectorAll('.btn-filter').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.btn-filter').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.orderPeriodFilter = btn.getAttribute('data-period') || 'all';
        this.renderOrders();
      });
    });

    document.getElementById('orders-search')?.addEventListener('input', (e) => {
      this.orderSearchQuery = (e.target as HTMLInputElement).value.trim().toLowerCase();
      this.renderOrders();
    });
  }

  private renderOrders() {
    if (!this.state) return;
    const tbody = document.getElementById('orders-table-body');
    const emptyBox = document.getElementById('orders-empty');
    if (!tbody) return;

    let orders = [...this.state.cache.orders];

    // Period filter
    const now = new Date();
    if (this.orderPeriodFilter === 'today') {
      const todayStart = getUserStartOfToday().getTime();
      orders = orders.filter(o => o.timestamp >= todayStart);
    } else if (this.orderPeriodFilter === '7days') {
      const d7 = getUserStartOfDaysAgo(7).getTime();
      orders = orders.filter(o => o.timestamp >= d7);
    } else if (this.orderPeriodFilter === '30days') {
      const d30 = getUserStartOfDaysAgo(30).getTime();
      orders = orders.filter(o => o.timestamp >= d30);
    } else if (this.orderPeriodFilter === '90days') {
      const d90 = getUserStartOfDaysAgo(90).getTime();
      orders = orders.filter(o => o.timestamp >= d90);
    }

    // Search query filter
    if (this.orderSearchQuery) {
      orders = orders.filter(o =>
        o.id.toLowerCase().includes(this.orderSearchQuery) ||
        ((o.buyerUsername || (o as any).buyer) && (o.buyerUsername || (o as any).buyer).toLowerCase().includes(this.orderSearchQuery)) ||
        ((o.description || (o as any).title) && (o.description || (o as any).title).toLowerCase().includes(this.orderSearchQuery)) ||
        (o.buyerId && String(o.buyerId).includes(this.orderSearchQuery))
      );
    }

    if (orders.length === 0) {
      tbody.innerHTML = '';
      if (emptyBox) emptyBox.style.display = 'block';
      return;
    }

    if (emptyBox) emptyBox.style.display = 'none';

    tbody.innerHTML = orders.map(o => {
      const statusPill = o.status === 'closed'
        ? '<span class="status-pill closed">Закрыт</span>'
        : (o.status === 'paid' ? '<span class="status-pill paid">Оплачен</span>' : '<span class="status-pill refunded">Возврат</span>');
      const buyerName = o.buyerUsername || (o as any).buyer || (o.buyerId ? `ID ${o.buyerId}` : 'Покупатель');
      const itemTitle = o.description || (o as any).title || '—';
      return `
        <tr>
          <td><strong style="font-family:var(--font-mono); font-size:11px;">#${o.id}</strong></td>
          <td style="white-space:nowrap;">${o.dateStr}</td>
          <td><strong>${buyerName}</strong></td>
          <td style="max-width:320px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${itemTitle}</td>
          <td class="tabular-nums" style="font-weight:600; color:var(--text-primary);">${formatMoney(o.price, o.currency)}</td>
          <td>${statusPill}</td>
        </tr>
      `;
    }).join('');
  }

  // ==========================================================================
  // 4. CRM CLIENTS
  // ==========================================================================
  private bindClientsEvents() {
    document.getElementById('clients-search')?.addEventListener('input', (e) => {
      this.clientSearchQuery = (e.target as HTMLInputElement).value.trim().toLowerCase();
      this.renderClients();
    });

    document.getElementById('clients-sort-select')?.addEventListener('change', (e) => {
      this.clientsSort = (e.target as HTMLSelectElement).value;
      this.renderClients();
    });
  }

  private renderClients() {
    if (!this.state) return;
    const tbody = document.getElementById('clients-table-body');
    const emptyBox = document.getElementById('clients-empty');
    if (!tbody) return;

    let clients = FunPayClientsAdapter.fromOrders(this.state.cache.orders);

    if (this.clientSearchQuery) {
      clients = clients.filter(c =>
        c.buyerUsername.toLowerCase().includes(this.clientSearchQuery) ||
        String(c.buyerId).includes(this.clientSearchQuery)
      );
    }

    // Sort clients
    if (this.clientsSort === 'orders') {
      clients.sort((a, b) => b.ordersCount - a.ordersCount);
    } else if (this.clientsSort === 'recent') {
      clients.sort((a, b) => (b.lastOrderDate || '').localeCompare(a.lastOrderDate || ''));
    } else if (this.clientsSort === 'name') {
      clients.sort((a, b) => a.buyerUsername.localeCompare(b.buyerUsername));
    } else {
      // turnover sort
      clients.sort((a, b) => {
        const sumA = Object.values(a.spentByCurrency).reduce((s, x) => s + x, 0);
        const sumB = Object.values(b.spentByCurrency).reduce((s, x) => s + x, 0);
        return sumB - sumA;
      });
    }

    if (clients.length === 0) {
      tbody.innerHTML = '';
      if (emptyBox) emptyBox.style.display = 'block';
      return;
    }

    if (emptyBox) emptyBox.style.display = 'none';

    tbody.innerHTML = clients.map(c => {
      const spentSummary = Object.entries(c.spentByCurrency)
        .map(([curr, amt]) => formatMoney(amt, curr))
        .join(' • ') || '0 ₽';

      const isVip = c.ordersCount >= 5 || Object.values(c.spentByCurrency).some(amt => amt >= 10000);
      const isRegular = c.ordersCount >= 2;
      const tierBadge = isVip
        ? '<span class="loyalty-tag vip">VIP</span>'
        : (isRegular ? '<span class="loyalty-tag regular">Regular</span>' : '<span class="loyalty-tag new">New</span>');

      return `
        <tr>
          <td><strong>${c.buyerUsername}</strong></td>
          <td><strong style="font-family:var(--font-mono); color:var(--text-muted);">#${c.buyerId}</strong></td>
          <td>${tierBadge}</td>
          <td><strong>${c.ordersCount}</strong></td>
          <td>${c.refundedCount > 0 ? `<span style="color:#f87171; font-weight:600;">${c.refundedCount}</span>` : '<span style="color:var(--text-muted);">0</span>'}</td>
          <td class="tabular-nums" style="font-weight:600; color:var(--text-primary);">${spentSummary}</td>
          <td>${c.lastOrderDate}</td>
          <td style="text-align: right;">
            <button class="btn btn-xs btn-outline btn-client-orders" data-client-id="${c.buyerId}">
              История покупок
            </button>
          </td>
        </tr>
      `;
    }).join('');

    tbody.querySelectorAll('.btn-client-orders').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = (e.currentTarget as HTMLElement).getAttribute('data-client-id');
        if (id) this.openClientDrawer(id);
      });
    });
  }

  private openClientDrawer(clientId: string) {
    const drawer = document.getElementById('client-orders-drawer');
    const titleEl = document.getElementById('client-drawer-title');
    const summaryEl = document.getElementById('client-drawer-summary');
    const tbody = document.getElementById('client-drawer-orders');
    if (!drawer || !this.state) return;

    const orders = (this.state.cache.orders || []).filter(o => String(o.buyerId) === String(clientId));
    if (orders.length === 0) return;

    const clientName = orders[0].buyer || `ID ${clientId}`;
    if (titleEl) titleEl.textContent = `${clientName} (#${clientId})`;

    let totalSpentByCurr: Record<string, number> = {};
    let refunds = 0;
    for (const o of orders) {
      if (o.status === 'closed' || o.status === 'paid') {
        const c = normalizeCurrency(o.currency);
        totalSpentByCurr[c] = (totalSpentByCurr[c] || 0) + (o.price || 0);
      } else if (o.status === 'refunded') {
        refunds++;
      }
    }
    const spentStr = Object.entries(totalSpentByCurr).map(([c, amt]) => formatMoney(amt, c)).join(' • ') || '0 ₽';

    if (summaryEl) {
      summaryEl.innerHTML = `
        <div>
          <div style="font-size:11px; color:var(--text-muted);">Заказов:</div>
          <div style="font-size:16px; font-weight:700; color:#fff;">${orders.length}</div>
        </div>
        <div>
          <div style="font-size:11px; color:var(--text-muted);">Сумма покупок:</div>
          <div style="font-size:16px; font-weight:700; color:var(--accent-emerald);">${spentStr}</div>
        </div>
        <div>
          <div style="font-size:11px; color:var(--text-muted);">Возвратов:</div>
          <div style="font-size:16px; font-weight:700; color:${refunds > 0 ? '#f87171' : '#fff'};">${refunds}</div>
        </div>
      `;
    }

    if (tbody) {
      tbody.innerHTML = orders.map(o => {
        const statusPill = o.status === 'closed'
          ? '<span class="status-pill closed">Закрыт</span>'
          : (o.status === 'paid' ? '<span class="status-pill paid">Оплачен</span>' : '<span class="status-pill refunded">Возврат</span>');
        return `
          <tr>
            <td><strong style="font-family:var(--font-mono); font-size:11px;">#${o.id}</strong></td>
            <td>${o.dateStr}</td>
            <td>${o.title}</td>
            <td class="tabular-nums" style="font-weight:600;">${formatMoney(o.price, o.currency)}</td>
            <td>${statusPill}</td>
          </tr>
        `;
      }).join('');
    }

    drawer.style.display = 'flex';
  }

  // ==========================================================================
  // 5. TEMPLATES
  // ==========================================================================
  private bindTemplatesEvents() {
    document.getElementById('templates-profile-filter')?.addEventListener('change', (e) => {
      this.templateProfileFilter = (e.target as HTMLSelectElement).value;
      this.renderTemplates();
    });

    document.getElementById('btn-add-template')?.addEventListener('click', () => {
      const name = prompt('Название нового шаблона:');
      if (!name) return;
      const text = prompt('Текст сообщения:');
      if (!text) return;

      const profileId = this.templateProfileFilter === 'all'
        ? (this.state?.settings.activeProfileId || 'default')
        : this.templateProfileFilter;

      const newTpl: Template = {
        id: `tpl_${Date.now()}`,
        profileId,
        name,
        text
      };

      chrome.runtime.sendMessage({
        type: 'SAVE_TEMPLATE',
        payload: { template: newTpl }
      }, () => this.refreshState());
    });
  }

  private renderTemplates() {
    if (!this.state) return;
    const filterSelect = document.getElementById('templates-profile-filter') as HTMLSelectElement;
    const container = document.getElementById('templates-list-container');
    if (!filterSelect || !container) return;

    // Populate profiles dropdown
    const activeProf = this.templateProfileFilter;
    filterSelect.innerHTML = '<option value="all">Все профили</option>' +
      this.state.profiles.map(p => `<option value="${p.id}" ${p.id === activeProf ? 'selected' : ''}>${p.name}</option>`).join('');

    let tpls = this.state.templates;
    if (this.templateProfileFilter !== 'all') {
      tpls = tpls.filter(t => t.profileId === this.templateProfileFilter);
    }

    if (tpls.length === 0) {
      container.innerHTML = '<div style="color:var(--text-muted); text-align:center; padding:30px;">Шаблоны не найдены</div>';
      return;
    }

    container.innerHTML = tpls.map(t => {
      const keycap = t.key ? `<span class="tpl-keycap">${t.key}</span>` : '';
      return `
        <div class="template-card">
          <div class="tpl-header">
            <span class="tpl-name">${t.name}</span>
            ${keycap}
          </div>
          <div class="tpl-text-preview">${t.text}</div>
          <div style="display:flex; justify-content:flex-end; gap:6px; margin-top:4px;">
            <button class="btn btn-xs btn-outline btn-edit-tpl" data-id="${t.id}">Изменить</button>
            <button class="btn btn-xs btn-danger-glow btn-del-tpl" data-id="${t.id}">Удалить</button>
          </div>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.btn-del-tpl').forEach(b => {
      b.addEventListener('click', () => {
        const id = b.getAttribute('data-id');
        if (id && confirm('Удалить шаблон?')) {
          chrome.runtime.sendMessage({ type: 'DELETE_TEMPLATE', payload: { templateId: id } }, () => this.refreshState());
        }
      });
    });

    container.querySelectorAll('.btn-edit-tpl').forEach(b => {
      b.addEventListener('click', () => {
        const id = b.getAttribute('data-id');
        const tpl = this.state?.templates.find(t => t.id === id);
        if (!tpl) return;
        const newText = prompt('Редактировать текст шаблона:', tpl.text);
        if (newText !== null) {
          tpl.text = newText;
          chrome.runtime.sendMessage({ type: 'SAVE_TEMPLATE', payload: { template: tpl } }, () => this.refreshState());
        }
      });
    });
  }

  // ==========================================================================
  // 6. HOTKEYS
  // ==========================================================================
  private bindHotkeysEvents() {
    document.getElementById('hotkeys-profile-filter')?.addEventListener('change', () => {
      this.renderHotkeys();
    });
  }

  private renderHotkeys() {
    if (!this.state) return;
    const filterSelect = document.getElementById('hotkeys-profile-filter') as HTMLSelectElement;
    const container = document.getElementById('hotkeys-list-container');
    if (!filterSelect || !container) return;

    if (filterSelect.options.length === 0) {
      filterSelect.innerHTML = this.state.profiles.map(p =>
        `<option value="${p.id}" ${p.id === this.state?.settings.activeProfileId ? 'selected' : ''}>${p.name}</option>`
      ).join('');
    }

    const currentProfileId = filterSelect.value || this.state.settings.activeProfileId;
    const tpls = this.state.templates.filter(t => t.profileId === currentProfileId);

    const keys = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8'];

    container.innerHTML = keys.map(k => {
      const assigned = tpls.find(t => t.key === k);
      const name = assigned ? assigned.name : '<span style="color:var(--text-muted);">Не назначен</span>';
      return `
        <div class="hotkey-slot-card">
          <div style="display:flex; align-items:center; gap:10px;">
            <span class="slot-keycap">${k}</span>
            <span style="font-size:12px; font-weight:600;">${name}</span>
          </div>
          <button class="btn btn-xs btn-outline btn-assign-key" data-key="${k}">Назначить</button>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.btn-assign-key').forEach(b => {
      b.addEventListener('click', () => {
        const k = b.getAttribute('data-key');
        if (!k) return;
        const choices = tpls.map(t => `${t.id}: ${t.name}`).join('\n');
        const choice = prompt(`Выберите шаблон для ${k}:\n${choices}\n\nВведите ID шаблона (или оставьте пустым для сброса):`);
        if (choice === null) return;

        // Clear key from all templates in profile
        tpls.forEach(t => {
          if (t.key === k) {
            delete t.key;
            chrome.runtime.sendMessage({ type: 'SAVE_TEMPLATE', payload: { template: t } });
          }
        });

        const target = tpls.find(t => t.id === choice.trim());
        if (target) {
          target.key = k;
          chrome.runtime.sendMessage({ type: 'SAVE_TEMPLATE', payload: { template: target } }, () => this.refreshState());
        } else {
          this.refreshState();
        }
      });
    });
  }

  // ==========================================================================
  // 7. PROFILES
  // ==========================================================================
  private bindProfilesEvents() {
    document.getElementById('btn-add-profile')?.addEventListener('click', () => {
      const name = prompt('Название нового профиля (например: "Dota 2"):');
      if (!name) return;
      const newProf: Profile = {
        id: `prof_${Date.now()}`,
        name,
        isDefault: false,
        hotkeys: []
      };
      chrome.runtime.sendMessage({ type: 'SAVE_PROFILE', payload: { profile: newProf } }, () => this.refreshState());
    });
  }

  private renderProfiles() {
    if (!this.state) return;
    const container = document.getElementById('profiles-list-container');
    if (!container) return;

    container.innerHTML = this.state.profiles.map(p => {
      const isActive = p.id === this.state?.settings.activeProfileId;
      const tplCount = this.state?.templates.filter(t => t.profileId === p.id).length || 0;

      return `
        <div class="obsidian-card" style="margin-bottom:12px; display:flex; justify-content:space-between; align-items:center;">
          <div>
            <div style="font-weight:700; font-size:14px; color:#fff;">
              ${p.name} ${isActive ? '<span class="status-pill closed" style="margin-left:6px;">АКТИВЕН</span>' : ''}
            </div>
            <div style="font-size:12px; color:var(--text-muted); margin-top:2px;">Шаблонов: ${tplCount}</div>
          </div>
          <div style="display:flex; gap:8px;">
            ${!isActive ? `<button class="btn btn-xs btn-primary-accent btn-set-active-prof" data-id="${p.id}">Активировать</button>` : ''}
            ${!p.isDefault ? `<button class="btn btn-xs btn-danger-glow btn-del-prof" data-id="${p.id}">Удалить</button>` : ''}
          </div>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.btn-set-active-prof').forEach(b => {
      b.addEventListener('click', () => {
        const id = b.getAttribute('data-id');
        if (id) {
          chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', payload: { activeProfileId: id } }, () => this.refreshState());
        }
      });
    });

    container.querySelectorAll('.btn-del-prof').forEach(b => {
      b.addEventListener('click', () => {
        const id = b.getAttribute('data-id');
        if (id && confirm('Удалить этот профиль и все связанные шаблоны?')) {
          chrome.runtime.sendMessage({ type: 'DELETE_PROFILE', payload: { profileId: id } }, () => this.refreshState());
        }
      });
    });
  }

  // ==========================================================================
  // 8. API SETTINGS
  // ==========================================================================
  private bindApiEvents() {
    document.getElementById('btn-save-key')?.addEventListener('click', async () => {
      const input = document.getElementById('golden-key-input') as HTMLInputElement;
      const key = input?.value?.trim() || '';
      await chrome.runtime.sendMessage({
        type: 'UPDATE_SETTINGS',
        payload: { goldenKey: key }
      });
      alert('Токен сохранен!');
      await this.refreshState();
    });

    // ------------------------------------------------------------------
    // Team cloud (Supabase v2.4)
    // ------------------------------------------------------------------
    document.getElementById('btn-cloud-signin')?.addEventListener('click', async () => {
      const btn = document.getElementById('btn-cloud-signin') as HTMLButtonElement;
      const email = (document.getElementById('cloud-email-input') as HTMLInputElement)?.value?.trim() || '';
      const password = (document.getElementById('cloud-password-input') as HTMLInputElement)?.value || '';

      btn.disabled = true;
      btn.textContent = 'Вход...';
      try {
        const res = await chrome.runtime.sendMessage({
          type: 'SIGN_IN_CLOUD',
          payload: { email, password }
        });
        if (!res?.success) {
          alert('Не удалось войти: ' + (res?.error || 'неизвестная ошибка'));
        } else {
          const passwordInput = document.getElementById('cloud-password-input') as HTMLInputElement;
          if (passwordInput) passwordInput.value = '';
        }
      } finally {
        btn.disabled = false;
        btn.textContent = 'Войти';
        await this.refreshState();
      }
    });

    document.getElementById('btn-cloud-signout')?.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'SIGN_OUT_CLOUD' });
      await this.refreshState();
    });

    document.getElementById('btn-cloud-save-seller')?.addEventListener('click', async () => {
      const value = (document.getElementById('cloud-seller-input') as HTMLInputElement)?.value?.trim() || '';
      await chrome.runtime.sendMessage({
        type: 'UPDATE_SETTINGS',
        payload: { sellerAccountId: value }
      });
      await this.refreshState();
    });

    document.getElementById('btn-cloud-load-shops')?.addEventListener('click', async () => {
      const hint = document.getElementById('cloud-sync-result');
      const res = await chrome.runtime.sendMessage({ type: 'FETCH_CLOUD_SHOPS' });
      const shops: CloudShop[] = res?.shops || [];

      if (!shops.length) {
        if (hint) hint.textContent = 'В облаке не найден ни один активный магазин команды (нужен вход оператора).';
        return;
      }

      if (hint) {
        hint.textContent = 'Магазины команды: ' + shops.map(s => s.accountName + ' (' + s.sellerAccountId + ')').join(', ');
      }

      const input = document.getElementById('cloud-seller-input') as HTMLInputElement;
      if (input && !input.value.trim() && shops.length === 1) {
        input.value = shops[0].sellerAccountId;
      }
    });

    document.getElementById('btn-cloud-push-orders')?.addEventListener('click', async () => {
      const btn = document.getElementById('btn-cloud-push-orders') as HTMLButtonElement;
      const hint = document.getElementById('cloud-sync-result');

      btn.disabled = true;
      btn.textContent = 'Отправка...';
      try {
        const res = await chrome.runtime.sendMessage({ type: 'SYNC_ORDERS_TO_CLOUD' });
        const summary = this.formatSyncReport(res?.report as OrderSyncReport | undefined);

        if (hint) {
          hint.textContent = res?.success
            ? '✅ ' + summary
            : '⚠️ ' + (res?.error || 'Ошибка синхронизации') + (res?.report ? ' | ' + summary : '');
        }
      } finally {
        btn.disabled = false;
        btn.textContent = 'Отправить заказы в облако';
      }
    });

    document.getElementById('btn-test-key')?.addEventListener('click', async () => {
      const btn = document.getElementById('btn-test-key') as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = 'Проверка...';
      try {
        const res = await chrome.runtime.sendMessage({ type: 'SYNC_DATA' });
        if (res?.success) {
          alert('Токен успешно проверен! Подключение установлено.');
        } else {
          alert('Ошибка проверки токена: ' + (res?.error || 'Проверьте токен'));
        }
      } finally {
        btn.disabled = false;
        btn.textContent = 'Проверить';
      }
      await this.refreshState();
    });
  }

  private renderApiSettings() {
    if (!this.state) return;
    const input = document.getElementById('golden-key-input') as HTMLInputElement;
    const dot = document.getElementById('key-status-dot');
    const text = document.getElementById('key-status-text');

    if (input && this.state.settings.goldenKey) {
      input.value = this.state.settings.goldenKey;
    }

    if (dot && text) {
      if (this.state.cache.accountInfo) {
        dot.className = 'status-dot-lg green';
        text.textContent = `Подключено: ${this.state.cache.accountInfo.username} (Баланс: ${formatMoney(this.state.cache.accountInfo.totalBalance, this.state.cache.accountInfo.currency)})`;
      } else {
        dot.className = 'status-dot-lg red';
        text.textContent = 'Сессия FunPay не активна или токен не указан';
      }
    }

    // Team cloud session and seller account (schema v2.4)
    const sellerInput = document.getElementById('cloud-seller-input') as HTMLInputElement;
    if (sellerInput && this.state.settings.sellerAccountId) {
      sellerInput.value = this.state.settings.sellerAccountId;
    }

    const cloudStatus = document.getElementById('cloud-auth-status');
    if (cloudStatus) {
      if (this.cloudAuth?.signedIn) {
        const identity = this.cloudAuth.email || this.cloudAuth.userId || 'оператор';
        cloudStatus.textContent = this.cloudAuth.expired
          ? '✅ Вход выполнен: ' + identity + ' (токен обновится при следующем запросе)'
          : '✅ Вход выполнен: ' + identity;
      } else {
        cloudStatus.textContent = 'Вход не выполнен: политики RLS вернут пустой результат для команды.';
      }
    }
  }

  private formatSyncReport(report?: OrderSyncReport): string {
    if (!report) return 'Отчёт недоступен';

    const parts = [
      'отправлено ' + report.sentOrders + ' из ' + report.totalOrders,
      'новых ' + report.inserted,
      'обновлено ' + report.updated,
      'расхождений ' + (report.financialDiscrepancies + report.createdTimeDiscrepancies),
      'отклонено ' + report.rejected,
      'пропущено локально ' + report.skippedLocally,
      'пакетов ' + report.chunks
    ];

    let summary = parts.join(' • ');
    if (report.errors.length) {
      summary += ' | Ошибки: ' + report.errors.slice(0, 3).join('; ');
    }
    if (report.skippedDetails.length) {
      const sample = report.skippedDetails.slice(0, 2)
        .map(item => item.orderId + ': ' + item.reason)
        .join('; ');
      summary += ' | Пропуски: ' + sample;
    }
    return summary;
  }

  // ==========================================================================
  // 9. GENERAL SETTINGS
  // ==========================================================================
  private bindGeneralEvents() {
    document.getElementById('btn-save-settings')?.addEventListener('click', async () => {
      const hotkeys = (document.getElementById('setting-hotkeys') as HTMLInputElement)?.checked;
      const panelEnabled = (document.getElementById('setting-panel-enabled') as HTMLInputElement)?.checked;
      const sound = (document.getElementById('setting-sound') as HTMLInputElement)?.checked;
      const notifs = (document.getElementById('setting-notifications') as HTMLInputElement)?.checked;
      const alertHours = parseInt((document.getElementById('setting-shift-alert-hours') as HTMLInputElement)?.value || '8', 10);
      const opsRaw = (document.getElementById('setting-operators-list') as HTMLTextAreaElement)?.value || '';

      const opsList = opsRaw.split('\n').map(s => s.trim()).filter(Boolean);

      await chrome.runtime.sendMessage({
        type: 'UPDATE_SETTINGS',
        payload: {
          hotkeysEnabled: hotkeys,
          panelEnabled: panelEnabled,
          soundEnabled: sound,
          notificationsEnabled: notifs,
          shiftOverrunAlertHours: alertHours,
          operatorsList: opsList
        }
      });

      alert('Настройки сохранены!');
      await this.refreshState();
    });
  }

  private renderGeneralSettings() {
    if (!this.state) return;
    const s = this.state.settings;

    const hk = document.getElementById('setting-hotkeys') as HTMLInputElement;
    const panelEn = document.getElementById('setting-panel-enabled') as HTMLInputElement;
    const snd = document.getElementById('setting-sound') as HTMLInputElement;
    const notif = document.getElementById('setting-notifications') as HTMLInputElement;
    const alertH = document.getElementById('setting-shift-alert-hours') as HTMLInputElement;
    const ops = document.getElementById('setting-operators-list') as HTMLTextAreaElement;

    if (hk) hk.checked = !!s.hotkeysEnabled;
    if (panelEn) panelEn.checked = s.panelEnabled !== false;
    if (snd) snd.checked = !!s.soundEnabled;
    if (notif) notif.checked = !!s.notificationsEnabled;
    if (alertH) alertH.value = String(s.shiftOverrunAlertHours || 8);
    if (ops && s.operatorsList) ops.value = s.operatorsList.join('\n');
  }

  // ==========================================================================
  // 10. BACKUP
  // ==========================================================================
  private bindBackupEvents() {
    document.getElementById('btn-export-backup')?.addEventListener('click', async () => {
      const res = await chrome.runtime.sendMessage({ type: 'EXPORT_BACKUP' });
      if (res?.backup) {
        const json = JSON.stringify(res.backup, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `funpay_backup_${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
      }
    });

    const fileInput = document.getElementById('input-import-file') as HTMLInputElement;
    document.getElementById('btn-import-backup')?.addEventListener('click', () => {
      fileInput?.click();
    });

    fileInput?.addEventListener('change', async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const text = await file.text();
      try {
        const backup = JSON.parse(text);
        if (confirm('Импортировать данные? Текущие шаблоны и профили будут объединены.')) {
          await chrome.runtime.sendMessage({ type: 'IMPORT_BACKUP', payload: { backup } });
          alert('Данные успешно импортированы!');
          await this.refreshState();
        }
      } catch (err) {
        alert('Ошибка при чтении файла резервной копии!');
      }
    });
  }

  private bindModals() {
    // Backdrop click handlers to dismiss modals
    document.getElementById('shift-modal')?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).id === 'shift-modal') {
        this.closeShiftModal();
      }
    });
  }
}

// Instantiate and start
const controller = new OptionsController();
document.addEventListener('DOMContentLoaded', () => {
  controller.init();
});
