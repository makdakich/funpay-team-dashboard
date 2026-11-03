import {
  AppSettings,
  BackupData,
  CompletedShift,
  ExtensionState,
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
import { FunPayClientsAdapter } from '../api/adapters/clients';

class OptionsController {
  private state: ExtensionState | null = null;
  private currentTab = 'dashboard';
  private chartMetric: 'turnover' | 'orders' | 'share' = 'turnover';
  private chartCurrency = '₽';
  private chartDays = 7;
  private orderPeriodFilter = 'all';
  private orderSearchQuery = '';
  private clientSearchQuery = '';
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
    if (!textEl || !this.state) return;
    if (this.state.cache.accountInfo) {
      const acc = this.state.cache.accountInfo;
      const bText = formatMoney(acc.totalBalance, acc.currency);
      textEl.textContent = `${acc.username} (${bText})`;
    } else {
      textEl.textContent = 'API не подключен';
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

  // --- 1. DASHBOARD ---
  private bindDashboardEvents() {
    // Sync button
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
        btn.innerHTML = '<span class="icon">🔄</span> Обновить данные';
      }
    });

    // Save seller share percent
    document.getElementById('btn-save-share')?.addEventListener('click', async () => {
      const input = document.getElementById('input-seller-share') as HTMLInputElement;
      const shareVal = parseFloat(input.value) || 0;
      await chrome.runtime.sendMessage({
        type: 'UPDATE_SETTINGS',
        payload: { sellerSharePercent: shareVal }
      });
      alert(`Процент "Моя доля" сохранен: ${shareVal}%`);
      await this.refreshState();
    });

    // Chart metric toggles
    document.querySelectorAll('.btn-chart-type').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.btn-chart-type').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.chartMetric = (btn.getAttribute('data-type') as 'turnover' | 'orders' | 'share') || 'turnover';
        this.renderChart();
      });
    });

    // Chart currency selector
    const currSelect = document.getElementById('chart-currency-select') as HTMLSelectElement;
    currSelect?.addEventListener('change', () => {
      this.chartCurrency = normalizeCurrency(currSelect.value);
      this.renderChart();
    });

    // Chart days toggles
    document.querySelectorAll('.btn-chart-days').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.btn-chart-days').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.chartDays = parseInt(btn.getAttribute('data-days') || '7', 10);
        this.renderChart();
      });
    });
  }

  private renderDashboard() {
    if (!this.state) return;
    const orders = this.state.cache.orders;
    const sharePercent = this.state.settings.sellerSharePercent ?? 10;
    const balances = this.state.cache.accountInfo?.balancesByCurrency ?? {};
    const primaryCurrency = this.state.cache.accountInfo?.currency ?? '₽';
    const lastSync = this.state.cache.lastSyncTimestamp;

    const stats = calculateDashboardStats(orders, sharePercent, balances, primaryCurrency, lastSync);

    // Balance Card (strictly real data, separate from turnover)
    const balanceEl = document.getElementById('stat-balance-val');
    const userEl = document.getElementById('stat-balance-user');

    if (balanceEl) {
      if (this.state.cache.accountInfo) {
        // Show all known currency balances
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

    // Share Input
    const shareInput = document.getElementById('input-seller-share') as HTMLInputElement;
    if (shareInput) shareInput.value = String(sharePercent);

    // Render multi-currency period blocks
    this.renderPeriodBlock('period-metrics-today', stats.today);
    this.renderPeriodBlock('period-metrics-7days', stats.last7Days);
    this.renderPeriodBlock('period-metrics-30days', stats.last30Days);
    this.renderPeriodBlock('period-metrics-90days', stats.last90Days);
    this.renderPeriodBlock('period-metrics-all', stats.allTime);

    this.renderChart();
  }

  private renderPeriodBlock(containerId: string, pStat: PeriodMultiCurrencyStats) {
    const el = document.getElementById(containerId);
    if (!el) return;

    const currEntries = Object.values(pStat.currencies);

    if (currEntries.length === 0) {
      el.innerHTML = `
        <div class="metric-row"><span class="metric-name">Оборот:</span><span class="metric-val">0 ₽</span></div>
        <div class="metric-row highlight-row"><span class="metric-name">Моя доля:</span><span class="metric-val">0 ₽</span></div>
        <div class="metric-row"><span class="metric-name">Заказов:</span><span class="metric-val">0</span></div>
        <div class="metric-row"><span class="metric-name">Клиентов:</span><span class="metric-val">0</span></div>
      `;
      return;
    }

    let html = '';

    // Render turnover & share for each isolated currency (never summed together)
    for (const c of currEntries) {
      html += `
        <div class="metric-row">
          <span class="metric-name">Оборот (${c.currency}):</span>
          <span class="metric-val">${formatMoney(c.turnover, c.currency)}</span>
        </div>
        <div class="metric-row highlight-row">
          <span class="metric-name">Моя доля (${c.currency}):</span>
          <span class="metric-val">${formatMoney(c.sellerShare, c.currency)}</span>
        </div>
      `;
    }

    // Transactions count & unique clients
    html += `
      <div class="metric-row">
        <span class="metric-name">Успешных заказов:</span>
        <span class="metric-val">${pStat.totalOrdersCount}</span>
      </div>
      <div class="metric-row">
        <span class="metric-name">Клиентов:</span>
        <span class="metric-val">${pStat.uniqueClientsCount}</span>
      </div>
    `;

    // Explicitly show refunded orders if any
    if (pStat.totalRefundedCount > 0) {
      const refDetails = currEntries
        .filter(c => c.refundedCount > 0)
        .map(c => `${formatMoney(c.refundedSum, c.currency)} (${c.refundedCount} шт)`)
        .join(', ');

      html += `
        <div class="metric-row" style="color:#f87171; border-top:1px dashed #374151; padding-top:4px; margin-top:4px;">
          <span class="metric-name" style="color:#f87171;">Возвраты:</span>
          <span class="metric-val" style="color:#f87171;">${refDetails}</span>
        </div>
      `;
    }

    el.innerHTML = html;
  }

  private renderChart() {
    const container = document.getElementById('chart-container');
    if (!container || !this.state) return;

    const orders = this.state.cache.orders;
    const sharePercent = this.state.settings.sellerSharePercent ?? 10;
    const curr = normalizeCurrency(this.chartCurrency);

    // Group daily buckets in user's local timezone
    const now = new Date();
    const buckets: { dateStr: string; label: string; turnover: number; orders: number; share: number }[] = [];

    for (let i = this.chartDays - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      const end = start + 24 * 60 * 60 * 1000;

      // Filter by matching currency and only count completed/active sales
      const dayOrders = orders.filter(o =>
        o.timestamp >= start &&
        o.timestamp < end &&
        normalizeCurrency(o.currency) === curr &&
        (o.status === 'paid' || o.status === 'closed')
      );

      const turnover = dayOrders.reduce((sum, o) => sum + (o.price || 0), 0);
      const share = turnover * (sharePercent / 100);

      const label = `${d.getDate()}.${d.getMonth() + 1}`;
      buckets.push({
        dateStr: d.toLocaleDateString(),
        label,
        turnover,
        orders: dayOrders.length,
        share
      });
    }

    const values = buckets.map(b => {
      if (this.chartMetric === 'turnover') return b.turnover;
      if (this.chartMetric === 'share') return b.share;
      return b.orders;
    });

    const maxVal = Math.max(...values, 1);
    const width = 800;
    const height = 240;
    const padding = 40;
    const chartW = width - padding * 2;
    const chartH = height - padding * 2;
    const barWidth = Math.max(10, Math.min(36, (chartW / buckets.length) * 0.6));

    let barsSvg = '';
    buckets.forEach((b, idx) => {
      const val = values[idx];
      const barH = (val / maxVal) * chartH;
      const x = padding + (idx * (chartW / buckets.length)) + ((chartW / buckets.length) - barWidth) / 2;
      const y = height - padding - barH;

      const displayVal = this.chartMetric === 'orders' ? String(val) : formatMoney(val, curr);

      barsSvg += `
        <g class="chart-bar-group">
          <rect x="${x}" y="${y}" width="${barWidth}" height="${barH}" rx="4" fill="#10b981" opacity="0.85">
            <title>${b.dateStr} (${curr}): ${displayVal}</title>
          </rect>
          <text x="${x + barWidth / 2}" y="${height - padding + 16}" text-anchor="middle" fill="#94a3b8" font-size="11">${b.label}</text>
          ${val > 0 ? `<text x="${x + barWidth / 2}" y="${Math.max(16, y - 6)}" text-anchor="middle" fill="#f8fafc" font-size="10" font-weight="600">${this.chartMetric === 'orders' ? val : Math.round(val)}</text>` : ''}
        </g>
      `;
    });

    container.innerHTML = `
      <svg width="100%" height="100%" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet">
        <line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" stroke="#334155" stroke-width="1" />
        ${barsSvg}
      </svg>
    `;
  }

  // --- 1b. SHIFTS HISTORY ---
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
        btn.innerHTML = '<span class="icon">⏳</span> Пересчет...';
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
          btn.innerHTML = '<span class="icon">🔄</span> Пересчитать выручку';
        }
      }
    });

    // Export CSV button
    document.getElementById('btn-export-shifts-csv')?.addEventListener('click', () => {
      this.exportShiftsCsv();
    });

    // Shift modal close/cancel
    document.getElementById('btn-cancel-shift')?.addEventListener('click', () => {
      this.closeShiftModal();
    });
    document.getElementById('modal-shift-close')?.addEventListener('click', () => {
      this.closeShiftModal();
    });

    // Orders modal close
    document.getElementById('btn-close-shift-orders')?.addEventListener('click', () => {
      this.closeShiftOrdersModal();
    });
    document.getElementById('modal-shift-orders-close')?.addEventListener('click', () => {
      this.closeShiftOrdersModal();
    });

    // Shift modal input changes for live duration preview
    const startInp = document.getElementById('shift-modal-start') as HTMLInputElement | null;
    const endInp = document.getElementById('shift-modal-end') as HTMLInputElement | null;
    const updatePreview = () => {
      const sVal = startInp?.value;
      const eVal = endInp?.value;
      const previewEl = document.getElementById('shift-modal-calc-preview');
      if (!previewEl) return;
      if (sVal && eVal) {
        const sTime = new Date(sVal).getTime();
        const eTime = new Date(eVal).getTime();
        if (eTime > sTime) {
          const dur = eTime - sTime;
          const orders = this.state?.cache?.orders || [];
          const percent = this.state?.settings?.sellerSharePercent ?? 10.0;
          const earnings = calculateShiftEarnings(sTime, eTime, orders, percent);
          const parts: string[] = [];
          for (const [c, amt] of Object.entries(earnings.turnoverByCurrency)) {
            parts.push(formatMoney(amt, c));
          }
          const turnStr = parts.length > 0 ? parts.join(', ') : '0 ₽';
          previewEl.textContent = `Длительность: ${formatDuration(dur)} • Найдено заказов: ${earnings.ordersCount} (Оборот: ${turnStr})`;
          previewEl.style.color = '#34d399';
          return;
        }
      }
      previewEl.textContent = 'Длительность и заказы будут автоматически рассчитаны по указанному времени.';
      previewEl.style.color = 'var(--text-muted)';
    };
    startInp?.addEventListener('input', updatePreview);
    endInp?.addEventListener('input', updatePreview);

    // Save shift modal button
    document.getElementById('btn-save-shift')?.addEventListener('click', async () => {
      const idInp = (document.getElementById('shift-modal-id') as HTMLInputElement)?.value;
      const opInp = (document.getElementById('shift-modal-operator') as HTMLInputElement)?.value?.trim();
      const sInp = (document.getElementById('shift-modal-start') as HTMLInputElement)?.value;
      const eInp = (document.getElementById('shift-modal-end') as HTMLInputElement)?.value;
      const noteInp = (document.getElementById('shift-modal-note') as HTMLInputElement)?.value?.trim();

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
      const percent = this.state?.settings?.sellerSharePercent ?? 10.0;
      const earnings = calculateShiftEarnings(sTime, eTime, orders, percent);

      const shift: CompletedShift = {
        id: idInp || `shift_${sTime}_${Math.random().toString(36).slice(2, 8)}`,
        operatorName: opInp,
        startTime: sTime,
        endTime: eTime,
        duration: dur,
        sellerSharePercent: percent,
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
    const modalDatalist = document.getElementById('operator-modal-suggestions');

    const knownOperators = new Set<string>();
    if (this.state.settings.operatorsList) {
      this.state.settings.operatorsList.forEach(op => knownOperators.add(op));
    }
    this.shifts.forEach(s => {
      if (s.operatorName) knownOperators.add(s.operatorName);
    });

    if (filterSelect) {
      const current = this.shiftsOperatorFilter;
      filterSelect.innerHTML = '<option value="all">Все сменщики</option>';
      for (const op of Array.from(knownOperators).sort()) {
        const opt = document.createElement('option');
        opt.value = op;
        opt.textContent = op;
        if (op === current) opt.selected = true;
        filterSelect.appendChild(opt);
      }
    }

    if (modalDatalist) {
      modalDatalist.innerHTML = Array.from(knownOperators)
        .map(op => `<option value="${op}">`)
        .join('');
    }

    this.renderShiftsTable();
  }

  private renderShiftsTable() {
    const tbody = document.getElementById('shifts-table-body');
    const emptyBox = document.getElementById('shifts-empty');
    if (!tbody) return;

    let filtered = [...this.shifts];

    // Filter by operator
    if (this.shiftsOperatorFilter !== 'all') {
      filtered = filtered.filter(s => s.operatorName === this.shiftsOperatorFilter);
    }

    // Filter by period
    const now = new Date();
    if (this.shiftsPeriodFilter === 'today') {
      const startToday = getUserStartOfToday();
      filtered = filtered.filter(s => s.startTime >= startToday);
    } else if (this.shiftsPeriodFilter === '7days') {
      const start7 = getUserStartOfDaysAgo(7);
      filtered = filtered.filter(s => s.startTime >= start7);
    } else if (this.shiftsPeriodFilter === '30days') {
      const start30 = getUserStartOfDaysAgo(30);
      filtered = filtered.filter(s => s.startTime >= start30);
    } else if (this.shiftsPeriodFilter === 'this_month') {
      filtered = filtered.filter(s => {
        const d = new Date(s.startTime);
        return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
      });
    }

    // Update Overview Metric Cards
    let totalDurationMs = 0;
    const totalTurnoverByCurr: Record<string, number> = {};
    const totalShareByCurr: Record<string, number> = {};
    let totalOrdersCount = 0;

    for (const s of filtered) {
      totalDurationMs += s.duration || 0;
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
      const durStr = formatDuration(s.duration);

      const turnoverParts = Object.entries(s.earnings?.turnoverByCurrency || {})
        .filter(([, a]) => a > 0)
        .map(([c, a]) => formatMoney(a, c));
      const turnoverFormatted = turnoverParts.length > 0 ? turnoverParts.join('<br>') : '0 ₽';

      const shareParts = Object.entries(s.earnings?.sellerShareByCurrency || {})
        .filter(([, a]) => a > 0)
        .map(([c, a]) => formatMoney(a, c));
      const shareFormatted = shareParts.length > 0 ? shareParts.join('<br>') : '0 ₽';

      const ordersBtn = (s.earnings?.ordersCount || 0) > 0
        ? `<button class="btn-orders-count" data-shift-id="${s.id}">${s.earnings.ordersCount} шт. 🔍</button>`
        : `<span style="color: var(--text-muted);">0</span>`;

      return `
        <tr>
          <td><span style="font-weight: 500;">${dateFormatted}</span></td>
          <td><span class="operator-badge">👤 ${s.operatorName || 'Оператор 1'}</span></td>
          <td style="font-variant-numeric: tabular-nums;">${intervalStr}</td>
          <td style="font-variant-numeric: tabular-nums; font-weight: 600; color: #34d399;">${durStr}</td>
          <td>${ordersBtn}</td>
          <td style="font-variant-numeric: tabular-nums; font-weight: 600;">${turnoverFormatted}</td>
          <td style="font-variant-numeric: tabular-nums; color: #34d399; font-weight: 600;">${shareFormatted}</td>
          <td style="color: var(--text-muted); font-size: 12px; max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${s.note || '—'}</td>
          <td>
            <div style="display: flex; gap: 6px;">
              <button class="btn btn-sm btn-outline btn-edit-shift" data-shift-id="${s.id}" title="Редактировать смену">✏️</button>
              <button class="btn btn-sm btn-danger btn-delete-shift" data-shift-id="${s.id}" title="Удалить смену">🗑️</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');

    // Attach row button events
    tbody.querySelectorAll('.btn-orders-count').forEach(btn => {
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
        const shift = this.shifts.find(s => s.id === id);
        if (id && confirm(`Удалить смену сменщика "${shift?.operatorName || 'Оператор'}" за ${new Date(shift?.startTime || 0).toLocaleDateString()}?`)) {
          await chrome.runtime.sendMessage({
            type: 'DELETE_SHIFT',
            payload: { shiftId: id }
          });
          await this.refreshState();
        }
      });
    });
  }

  private openShiftModal(shift?: CompletedShift) {
    const modal = document.getElementById('modal-shift');
    const title = document.getElementById('modal-shift-title');
    const idInp = document.getElementById('shift-modal-id') as HTMLInputElement | null;
    const opInp = document.getElementById('shift-modal-operator') as HTMLInputElement | null;
    const startInp = document.getElementById('shift-modal-start') as HTMLInputElement | null;
    const endInp = document.getElementById('shift-modal-end') as HTMLInputElement | null;
    const noteInp = document.getElementById('shift-modal-note') as HTMLInputElement | null;
    const previewEl = document.getElementById('shift-modal-calc-preview');

    if (!modal) return;

    const toLocalIso = (ts: number) => {
      const d = new Date(ts);
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };

    if (shift) {
      if (title) title.textContent = 'Редактировать рабочую смену';
      if (idInp) idInp.value = shift.id;
      if (opInp) opInp.value = shift.operatorName;
      if (startInp) startInp.value = toLocalIso(shift.startTime);
      if (endInp) endInp.value = toLocalIso(shift.endTime);
      if (noteInp) noteInp.value = shift.note || '';
    } else {
      if (title) title.textContent = 'Добавить рабочую смену вручную';
      if (idInp) idInp.value = '';
      if (opInp) opInp.value = this.state?.settings?.lastOperator || 'Оператор 1';
      const now = Date.now();
      const eightHoursAgo = now - 8 * 3600 * 1000;
      if (startInp) startInp.value = toLocalIso(eightHoursAgo);
      if (endInp) endInp.value = toLocalIso(now);
      if (noteInp) noteInp.value = '';
    }

    if (previewEl) {
      previewEl.textContent = 'Длительность и заказы будут автоматически рассчитаны по указанному времени.';
      previewEl.style.color = 'var(--text-muted)';
    }

    modal.style.display = 'flex';
  }

  private closeShiftModal() {
    const modal = document.getElementById('modal-shift');
    if (modal) modal.style.display = 'none';
  }

  private viewShiftOrders(shift: CompletedShift) {
    const modal = document.getElementById('modal-shift-orders');
    const title = document.getElementById('modal-shift-orders-title');
    const content = document.getElementById('shift-orders-list-content');
    if (!modal || !content) return;

    if (title) {
      title.textContent = `Заказы смены: ${shift.operatorName} (${new Date(shift.startTime).toLocaleDateString()})`;
    }

    const orderIdsSet = new Set((shift.earnings.orderIds || []).map(id => id.toUpperCase()));
    const matchingOrders = (this.state?.cache?.orders || []).filter(o => orderIdsSet.has(o.id.toUpperCase()));

    if (matchingOrders.length === 0) {
      content.innerHTML = `
        <div style="padding: 16px; text-align: center; color: var(--text-muted);">
          Номера заказов: ${Array.from(orderIdsSet).join(', ') || 'нет'}<br>
          (Подробные карточки заказов не найдены в текущем кеше. Выполните «Обновить данные» на Дашборде).
        </div>
      `;
    } else {
      content.innerHTML = `
        <table class="data-table" style="width: 100%;">
          <thead>
            <tr>
              <th>ID</th>
              <th>Дата</th>
              <th>Покупатель</th>
              <th>Описание товара</th>
              <th>Сумма</th>
              <th>Статус</th>
            </tr>
          </thead>
          <tbody>
            ${matchingOrders.map(o => `
              <tr>
                <td><strong>#${o.id}</strong></td>
                <td>${o.dateStr}</td>
                <td>${o.buyerUsername || '—'}</td>
                <td>${o.description || '—'}</td>
                <td style="font-weight: 600; color: #34d399;">${formatMoney(o.price, o.currency)}</td>
                <td><span class="stat-badge">${o.status}</span></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
    }

    modal.style.display = 'flex';
  }

  private closeShiftOrdersModal() {
    const modal = document.getElementById('modal-shift-orders');
    if (modal) modal.style.display = 'none';
  }

  private exportShiftsCsv() {
    if (this.shifts.length === 0) {
      alert('История смен пуста, нечего экспортировать.');
      return;
    }

    const headers = ['ID', 'Дата', 'Сменщик', 'Начало', 'Конец', 'Длительность (мс)', 'Длительность (формат)', 'Заказов', 'Оборот', 'Доля', 'Заметка'];
    const rows: string[] = [];
    rows.push(headers.join(';'));

    for (const s of this.shifts) {
      const dateStr = new Date(s.startTime).toLocaleDateString('ru-RU');
      const startStr = formatTimeOnly(s.startTime);
      const endStr = formatTimeOnly(s.endTime);
      const durStr = formatDuration(s.duration);

      const turnoverParts = Object.entries(s.earnings?.turnoverByCurrency || {})
        .map(([c, a]) => `${a} ${c}`);
      const turnoverStr = turnoverParts.length > 0 ? turnoverParts.join(', ') : '0';

      const shareParts = Object.entries(s.earnings?.sellerShareByCurrency || {})
        .map(([c, a]) => `${a} ${c}`);
      const shareStr = shareParts.length > 0 ? shareParts.join(', ') : '0';

      const noteClean = (s.note || '').replace(/[\r\n;]/g, ' ');

      const row = [
        s.id,
        dateStr,
        `"${s.operatorName.replace(/"/g, '""')}"`,
        startStr,
        endStr,
        String(s.duration),
        durStr,
        String(s.earnings?.ordersCount || 0),
        `"${turnoverStr}"`,
        `"${shareStr}"`,
        `"${noteClean.replace(/"/g, '""')}"`
      ];
      rows.push(row.join(';'));
    }

    const csvContent = '\uFEFF' + rows.join('\r\n'); // UTF-8 BOM for Excel
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `fanpay-shifts-history-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  // --- 2. ORDERS ---
  private bindOrdersEvents() {
    const searchInput = document.getElementById('orders-search') as HTMLInputElement;
    searchInput?.addEventListener('input', (e) => {
      this.orderSearchQuery = (e.target as HTMLInputElement).value.toLowerCase();
      this.renderOrders();
    });

    document.querySelectorAll('.btn-filter').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.btn-filter').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.orderPeriodFilter = btn.getAttribute('data-period') || 'all';
        this.renderOrders();
      });
    });
  }

  private renderOrders() {
    if (!this.state) return;
    const tbody = document.getElementById('orders-table-body');
    const emptyBox = document.getElementById('orders-empty');
    if (!tbody) return;

    let orders = [...this.state.cache.orders];

    // Filter by period in local user timezone
    if (this.orderPeriodFilter === 'today') {
      const startToday = getUserStartOfToday();
      orders = orders.filter(o => o.timestamp >= startToday);
    } else if (this.orderPeriodFilter === '7days') {
      const start7 = getUserStartOfDaysAgo(7);
      orders = orders.filter(o => o.timestamp >= start7);
    } else if (this.orderPeriodFilter === '30days') {
      const start30 = getUserStartOfDaysAgo(30);
      orders = orders.filter(o => o.timestamp >= start30);
    } else if (this.orderPeriodFilter === '90days') {
      const start90 = getUserStartOfDaysAgo(90);
      orders = orders.filter(o => o.timestamp >= start90);
    }

    // Filter by search query
    if (this.orderSearchQuery) {
      orders = orders.filter(o =>
        o.id.toLowerCase().includes(this.orderSearchQuery) ||
        o.buyerUsername.toLowerCase().includes(this.orderSearchQuery) ||
        String(o.buyerId).includes(this.orderSearchQuery) ||
        o.description.toLowerCase().includes(this.orderSearchQuery)
      );
    }

    if (orders.length === 0) {
      tbody.innerHTML = '';
      if (emptyBox) emptyBox.style.display = 'block';
      return;
    }

    if (emptyBox) emptyBox.style.display = 'none';

    tbody.innerHTML = orders.map(o => {
      const statusBadge =
        o.status === 'paid' ? '<span class="order-status-badge status-paid">Оплачен</span>' :
        o.status === 'refunded' ? '<span class="order-status-badge status-refunded">Возврат</span>' :
        o.status === 'closed' ? '<span class="order-status-badge status-closed">Закрыт</span>' :
        '<span class="order-status-badge status-unknown">Неизвестен</span>';

      const priceDisplay = o.price !== null
        ? `<strong>${formatMoney(o.price, o.currency)}</strong>`
        : `<span style="color:#ef4444; font-size:12px; font-weight:600; cursor:help;" title="${o.priceParseError || 'Сумма не определена в HTML'}">Не определена ⚠️</span>`;

      return `
        <tr>
          <td><strong>#${o.id}</strong></td>
          <td>${o.dateStr}</td>
          <td><strong>${o.buyerUsername}</strong> <small style="color:#94a3b8;">(ID ${o.buyerId})</small></td>
          <td>${o.description}</td>
          <td>${priceDisplay}</td>
          <td>${statusBadge}</td>
        </tr>
      `;
    }).join('');
  }

  // --- 3. CLIENTS ---
  private bindClientsEvents() {
    const searchInput = document.getElementById('clients-search') as HTMLInputElement;
    searchInput?.addEventListener('input', (e) => {
      this.clientSearchQuery = (e.target as HTMLInputElement).value.toLowerCase();
      this.renderClients();
    });
  }

  private renderClients() {
    if (!this.state) return;
    const tbody = document.getElementById('clients-table-body');
    const emptyBox = document.getElementById('clients-empty');
    if (!tbody) return;

    // Aggregated strictly by buyerId
    let clients = FunPayClientsAdapter.fromOrders(this.state.cache.orders);

    if (this.clientSearchQuery) {
      clients = clients.filter(c =>
        c.buyerUsername.toLowerCase().includes(this.clientSearchQuery) ||
        String(c.buyerId).includes(this.clientSearchQuery)
      );
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

      return `
        <tr>
          <td><strong>#${c.buyerId}</strong></td>
          <td><strong>${c.buyerUsername}</strong></td>
          <td>${c.ordersCount}</td>
          <td>${c.refundedCount > 0 ? `<span style="color:#f87171; font-weight:600;">${c.refundedCount}</span>` : '0'}</td>
          <td><strong>${spentSummary}</strong></td>
          <td>${c.lastOrderDate}</td>
          <td>
            <button class="btn btn-sm btn-outline btn-client-orders" data-client-id="${c.buyerId}">
              Заказы
            </button>
          </td>
        </tr>
      `;
    }).join('');

    tbody.querySelectorAll('.btn-client-orders').forEach(btn => {
      btn.addEventListener('click', () => {
        const clientId = btn.getAttribute('data-client-id') || '';
        this.orderSearchQuery = clientId;
        const searchInput = document.getElementById('orders-search') as HTMLInputElement;
        if (searchInput) searchInput.value = clientId;
        this.switchTab('orders');
      });
    });
  }

  // --- 4. TEMPLATES ---
  private bindTemplatesEvents() {
    const filterSelect = document.getElementById('templates-profile-filter') as HTMLSelectElement;
    filterSelect?.addEventListener('change', (e) => {
      this.templateProfileFilter = (e.target as HTMLSelectElement).value;
      this.renderTemplates();
    });

    document.getElementById('btn-add-template')?.addEventListener('click', () => {
      this.openTemplateModal();
    });
  }

  private renderTemplates() {
    if (!this.state) return;
    const container = document.getElementById('templates-list-container');
    const filterSelect = document.getElementById('templates-profile-filter') as HTMLSelectElement;
    if (!container || !filterSelect) return;

    filterSelect.innerHTML = `<option value="all">Все профили</option>` +
      this.state.profiles.map(p => `<option value="${p.id}" ${this.templateProfileFilter === p.id ? 'selected' : ''}>${p.name}</option>`).join('');

    let templates = [...this.state.templates];
    if (this.templateProfileFilter !== 'all') {
      templates = templates.filter(t => t.profileId === this.templateProfileFilter || t.profileId === 'profile-common');
    }
    templates.sort((a, b) => a.sortOrder - b.sortOrder);

    if (templates.length === 0) {
      container.innerHTML = `<div class="card empty-state" style="padding:20px; text-align:center;">Нет шаблонов для выбранного профиля.</div>`;
      return;
    }

    container.innerHTML = templates.map(t => {
      const prof = this.state?.profiles.find(p => p.id === t.profileId);
      return `
        <div class="template-item-card">
          <div class="template-main-info">
            <span class="template-hotkey-badge">${t.hotkey || '—'}</span>
            <div class="template-text-block">
              <span class="template-item-title">${t.name} <small style="color:#94a3b8;">(${prof?.name || 'Общий'})</small></span>
              <span class="template-item-preview">${t.text}</span>
            </div>
          </div>
          <div class="template-actions">
            <button class="btn btn-sm btn-outline btn-edit-template" data-id="${t.id}">✏️</button>
            <button class="btn btn-sm btn-outline btn-copy-template" data-id="${t.id}" title="Дублировать">📋</button>
            <button class="btn btn-sm btn-danger btn-delete-template" data-id="${t.id}">🗑️</button>
          </div>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.btn-edit-template').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        const tmpl = this.state?.templates.find(t => t.id === id);
        if (tmpl) this.openTemplateModal(tmpl);
      });
    });

    container.querySelectorAll('.btn-copy-template').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        const tmpl = this.state?.templates.find(t => t.id === id);
        if (tmpl) {
          const duplicate: Template = {
            ...tmpl,
            id: `tmpl-${Date.now()}`,
            name: `${tmpl.name} (Копия)`,
            sortOrder: (tmpl.sortOrder || 0) + 1
          };
          await chrome.runtime.sendMessage({ type: 'SAVE_TEMPLATE', payload: duplicate });
          await this.refreshState();
        }
      });
    });

    container.querySelectorAll('.btn-delete-template').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        if (id && confirm('Удалить этот шаблон?')) {
          await chrome.runtime.sendMessage({ type: 'DELETE_TEMPLATE', payload: { templateId: id } });
          await this.refreshState();
        }
      });
    });
  }

  // --- 5. HOTKEYS ---
  private bindHotkeysEvents() {
    const select = document.getElementById('hotkeys-profile-select') as HTMLSelectElement;
    select?.addEventListener('change', () => {
      this.renderHotkeys();
    });
  }

  private renderHotkeys() {
    if (!this.state) return;
    const select = document.getElementById('hotkeys-profile-select') as HTMLSelectElement;
    const tbody = document.getElementById('hotkeys-table-body');
    if (!select || !tbody) return;

    const activeProfId = select.value || this.state.settings.selectedProfileId;
    select.innerHTML = this.state.profiles.map(p => `
      <option value="${p.id}" ${p.id === activeProfId ? 'selected' : ''}>${p.name}</option>
    `).join('');

    const templates = this.state.templates.filter(t => t.profileId === activeProfId || t.profileId === 'profile-common');

    tbody.innerHTML = templates.map(t => `
      <tr>
        <td><strong class="template-hotkey-badge">${t.hotkey || 'Не назначен'}</strong></td>
        <td><strong>${t.name}</strong></td>
        <td style="max-width:320px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${t.text}</td>
        <td>${t.enabled ? '<span style="color:#10b981;">Включен</span>' : '<span style="color:#ef4444;">Отключен</span>'}</td>
        <td>
          <button class="btn btn-sm btn-outline btn-edit-hotkey" data-id="${t.id}">Изменить</button>
        </td>
      </tr>
    `).join('');

    tbody.querySelectorAll('.btn-edit-hotkey').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        const tmpl = this.state?.templates.find(t => t.id === id);
        if (tmpl) this.openTemplateModal(tmpl);
      });
    });
  }

  // --- 6. PROFILES ---
  private bindProfilesEvents() {
    document.getElementById('btn-add-profile')?.addEventListener('click', () => {
      this.openProfileModal();
    });
  }

  private renderProfiles() {
    if (!this.state) return;
    const container = document.getElementById('profiles-grid-container');
    if (!container) return;

    container.innerHTML = this.state.profiles.map(p => {
      const isActive = p.id === this.state?.settings.selectedProfileId;
      const count = this.state?.templates.filter(t => t.profileId === p.id).length || 0;
      const isCommon = p.id === 'profile-common';

      return `
        <div class="profile-card ${isActive ? 'active-profile' : ''}">
          <div class="profile-card-header">
            <div>
              <div class="profile-name">${p.name}</div>
              <div class="form-hint">${count} шаблонов</div>
            </div>
            ${isActive ? '<span class="stat-badge">Активный</span>' : ''}
          </div>
          <div class="profile-card-actions">
            ${!isActive ? `<button class="btn btn-sm btn-primary btn-select-prof" data-id="${p.id}">Выбрать</button>` : ''}
            <button class="btn btn-sm btn-outline btn-edit-prof" data-id="${p.id}">Переименовать</button>
            ${!isCommon ? `<button class="btn btn-sm btn-danger btn-delete-prof" data-id="${p.id}">Удалить</button>` : ''}
          </div>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.btn-select-prof').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        if (id) {
          await chrome.runtime.sendMessage({ type: 'SET_SELECTED_PROFILE', payload: { profileId: id } });
          await this.refreshState();
        }
      });
    });

    container.querySelectorAll('.btn-edit-prof').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        const prof = this.state?.profiles.find(p => p.id === id);
        if (prof) this.openProfileModal(prof);
      });
    });

    container.querySelectorAll('.btn-delete-prof').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        if (id && confirm('Удалить этот профиль и все его шаблоны?')) {
          await chrome.runtime.sendMessage({ type: 'DELETE_PROFILE', payload: { profileId: id } });
          await this.refreshState();
        }
      });
    });
  }

  // --- 7. API SETTINGS ---
  private bindApiEvents() {
    const toggleBtn = document.getElementById('btn-toggle-key-visibility');
    const keyInput = document.getElementById('api-golden-key') as HTMLInputElement;
    toggleBtn?.addEventListener('click', () => {
      if (keyInput) {
        keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
      }
    });

    // Test API
    document.getElementById('btn-test-api')?.addEventListener('click', async () => {
      const btn = document.getElementById('btn-test-api') as HTMLButtonElement;
      const statusText = document.getElementById('api-status-text');
      const dot = document.getElementById('api-status-dot');
      const token = keyInput?.value?.trim() || '';

      btn.disabled = true;
      btn.textContent = 'Проверка...';

      try {
        const res = await chrome.runtime.sendMessage({
          type: 'TEST_API_CONNECTION',
          payload: { goldenKey: token }
        });

        if (res?.authenticated && res.user) {
          if (dot) dot.className = 'status-indicator connected';
          if (statusText) statusText.textContent = `● Подключено: ${res.user.username} (Баланс: ${formatMoney(res.user.totalBalance, res.user.currency)})`;
        } else {
          if (dot) dot.className = 'status-indicator error';
          const diag = res?.diagnostics;
          let diagInfo = '';
          if (diag) {
            const parts = [`HTTP ${diag.status}`];
            if (diag.source) parts.push(diag.source === 'content-script' ? 'вкладка FunPay' : 'прямой запрос');
            if (diag.isCloudflare) parts.push('Cloudflare');
            if (diag.hasLoginForm) parts.push('форма гостя');
            diagInfo = ` (${parts.join(', ')})`;
          }
          if (statusText) statusText.textContent = `● Ошибка: ${res?.error || 'Не удалось авторизоваться'}${diagInfo}`;
        }
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<span class="icon">🔍</span> Проверить подключение';
      }
    });

    // Save API key
    document.getElementById('btn-save-api')?.addEventListener('click', async () => {
      const token = keyInput?.value?.trim() || '';
      await chrome.runtime.sendMessage({
        type: 'UPDATE_SETTINGS',
        payload: { goldenKey: token }
      });
      alert('Токен golden_key сохранен в локальном защищенном хранилище!');
      await this.refreshState();
    });

    // Clear API key
    document.getElementById('btn-clear-api')?.addEventListener('click', async () => {
      if (confirm('Удалить сохраненный токен авторизации?')) {
        await chrome.runtime.sendMessage({ type: 'CLEAR_API_CREDENTIALS' });
        if (keyInput) keyInput.value = '';
        const statusText = document.getElementById('api-status-text');
        const dot = document.getElementById('api-status-dot');
        if (dot) dot.className = 'status-indicator';
        if (statusText) statusText.textContent = 'Токен удален';
        await this.refreshState();
      }
    });

    // Copy diagnostic report
    const copyDiagBtn = document.getElementById('btn-copy-diag');
    copyDiagBtn?.addEventListener('click', async () => {
      const reportText = this.state?.cache?.diagnosticReport;
      if (reportText) {
        await navigator.clipboard.writeText(reportText);
        const orig = copyDiagBtn.textContent;
        copyDiagBtn.textContent = '✅ Скопировано!';
        setTimeout(() => {
          copyDiagBtn.textContent = orig;
        }, 2000);
      }
    });
  }

  private renderApiSettings() {
    if (!this.state) return;
    const keyInput = document.getElementById('api-golden-key') as HTMLInputElement;
    if (keyInput && this.state.settings.goldenKey) {
      keyInput.value = this.state.settings.goldenKey;
    }

    const dot = document.getElementById('api-status-dot');
    const statusText = document.getElementById('api-status-text');
    if (this.state.cache.accountInfo) {
      if (dot) dot.className = 'status-indicator connected';
      if (statusText) statusText.textContent = `● Подключено: ${this.state.cache.accountInfo.username} (ID ${this.state.cache.accountInfo.userId})`;
    } else if (this.state.cache.error) {
      if (dot) dot.className = 'status-indicator error';
      if (statusText) statusText.textContent = `● Ошибка: ${this.state.cache.error}`;
    }

    const diagReportEl = document.getElementById('diag-report-text');
    const copyDiagBtn = document.getElementById('btn-copy-diag');
    if (diagReportEl) {
      if (this.state.cache.diagnosticReport) {
        diagReportEl.textContent = this.state.cache.diagnosticReport;
        if (copyDiagBtn) copyDiagBtn.style.display = 'inline-flex';
      } else {
        diagReportEl.textContent = 'Отчёт пока не сформирован. Нажмите «Обновить данные» на вкладке «Дашборд & Статистика».';
        if (copyDiagBtn) copyDiagBtn.style.display = 'none';
      }
    }
  }

  // --- 8. GENERAL SETTINGS ---
  private bindGeneralEvents() {
    const bindToggle = (id: string, key: keyof AppSettings) => {
      const el = document.getElementById(id) as HTMLInputElement;
      el?.addEventListener('change', async () => {
        await chrome.runtime.sendMessage({
          type: 'UPDATE_SETTINGS',
          payload: { [key]: el.checked }
        });
        await this.refreshState();
      });
    };

    bindToggle('setting-hotkeys-enabled', 'hotkeysEnabled');
    bindToggle('setting-panel-visible', 'panelVisible');
    bindToggle('setting-panel-docked', 'panelDocked');
    bindToggle('setting-dev-mode', 'developerMode');

    const themeSelect = document.getElementById('setting-theme') as HTMLSelectElement;
    themeSelect?.addEventListener('change', async () => {
      const themeVal = themeSelect.value as 'system' | 'dark' | 'light';
      document.body.className = `theme-${themeVal}`;
      await chrome.runtime.sendMessage({
        type: 'UPDATE_SETTINGS',
        payload: { theme: themeVal }
      });
    });

    const syncSelect = document.getElementById('setting-sync-interval') as HTMLSelectElement;
    syncSelect?.addEventListener('change', async () => {
      await chrome.runtime.sendMessage({
        type: 'UPDATE_SETTINGS',
        payload: { autoSyncIntervalMinutes: parseInt(syncSelect.value, 10) }
      });
    });
  }

  private renderGeneralSettings() {
    if (!this.state) return;
    const setChecked = (id: string, val: boolean) => {
      const el = document.getElementById(id) as HTMLInputElement;
      if (el) el.checked = !!val;
    };

    setChecked('setting-hotkeys-enabled', this.state.settings.hotkeysEnabled);
    setChecked('setting-panel-visible', this.state.settings.panelVisible);
    setChecked('setting-panel-docked', this.state.settings.panelDocked);
    setChecked('setting-dev-mode', this.state.settings.developerMode);

    const themeSelect = document.getElementById('setting-theme') as HTMLSelectElement;
    if (themeSelect) themeSelect.value = this.state.settings.theme;
    document.body.className = `theme-${this.state.settings.theme}`;

    const syncSelect = document.getElementById('setting-sync-interval') as HTMLSelectElement;
    if (syncSelect) syncSelect.value = String(this.state.settings.autoSyncIntervalMinutes);
  }

  // --- 9. BACKUP & EXPORT ---
  private bindBackupEvents() {
    document.getElementById('btn-export-backup')?.addEventListener('click', async () => {
      const res = await chrome.runtime.sendMessage({ type: 'EXPORT_BACKUP' });
      if (res?.backup) {
        const blob = new Blob([JSON.stringify(res.backup, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `fanpay-hotkeys-backup-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
      }
    });

    const fileInput = document.getElementById('input-backup-file') as HTMLInputElement;
    document.getElementById('btn-import-browse')?.addEventListener('click', () => {
      fileInput?.click();
    });

    fileInput?.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      const nameEl = document.getElementById('import-file-name');
      const optionsBox = document.getElementById('import-options-box');
      if (file && nameEl && optionsBox) {
        nameEl.textContent = file.name;
        optionsBox.style.display = 'block';
      }
    });

    document.getElementById('btn-apply-import')?.addEventListener('click', () => {
      const file = fileInput.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const content = e.target?.result as string;
          const backup: BackupData = JSON.parse(content);
          const modeEl = document.querySelector<HTMLInputElement>('input[name="import-mode"]:checked');
          const overwrite = modeEl?.value === 'overwrite';

          if (overwrite && !confirm('Внимание! Все текущие шаблоны и профили будут перезаписаны. Продолжить?')) {
            return;
          }

          const res = await chrome.runtime.sendMessage({
            type: 'IMPORT_BACKUP',
            payload: { backup, overwrite }
          });

          if (res?.success) {
            alert('Резервная копия успешно импортирована!');
            await this.refreshState();
          } else {
            alert('Ошибка импорта: ' + (res?.error || 'Неверный формат'));
          }
        } catch {
          alert('Ошибка чтения файла. Проверьте JSON.');
        }
      };
      reader.readAsText(file);
    });
  }

  // --- MODALS ---
  private bindModals() {
    document.getElementById('modal-template-close')?.addEventListener('click', () => this.closeTemplateModal());
    document.getElementById('btn-cancel-template')?.addEventListener('click', () => this.closeTemplateModal());

    document.querySelectorAll('.btn-var-tag').forEach(btn => {
      btn.addEventListener('click', () => {
        const varName = btn.getAttribute('data-var');
        const textarea = document.getElementById('tmpl-text') as HTMLTextAreaElement;
        if (varName && textarea) {
          const start = textarea.selectionStart;
          const end = textarea.selectionEnd;
          const val = textarea.value;
          textarea.value = val.substring(0, start) + varName + val.substring(end);
          textarea.focus();
          textarea.setSelectionRange(start + varName.length, start + varName.length);
        }
      });
    });

    const btnRecord = document.getElementById('btn-record-key');
    const hotkeyInput = document.getElementById('tmpl-hotkey') as HTMLInputElement;

    btnRecord?.addEventListener('click', () => {
      this.recordingKey = true;
      if (btnRecord) btnRecord.textContent = 'Нажмите клавишу...';
      hotkeyInput.focus();
    });

    hotkeyInput?.addEventListener('keydown', (e) => {
      if (!this.recordingKey) return;
      e.preventDefault();
      const parts: string[] = [];
      if (e.ctrlKey) parts.push('Ctrl');
      if (e.altKey) parts.push('Alt');
      if (e.shiftKey && !e.key.startsWith('F')) parts.push('Shift');
      if (/^F\d+$/i.test(e.key)) {
        parts.push(e.key.toUpperCase());
      } else if (e.key !== 'Control' && e.key !== 'Alt' && e.key !== 'Shift') {
        parts.push(e.key.toUpperCase());
      }

      hotkeyInput.value = parts.join('+');
      this.recordingKey = false;
      if (btnRecord) btnRecord.textContent = 'Захват клавиши';
    });

    document.getElementById('btn-save-template')?.addEventListener('click', async () => {
      const idInput = document.getElementById('tmpl-id') as HTMLInputElement;
      const profSelect = document.getElementById('tmpl-profile') as HTMLSelectElement;
      const nameInput = document.getElementById('tmpl-name') as HTMLInputElement;
      const hotkeyInp = document.getElementById('tmpl-hotkey') as HTMLInputElement;
      const textInput = document.getElementById('tmpl-text') as HTMLTextAreaElement;
      const enabledInput = document.getElementById('tmpl-enabled') as HTMLInputElement;

      if (!nameInput.value.trim()) {
        alert('Укажите название шаблона');
        return;
      }

      const id = idInput.value || `tmpl-${Date.now()}`;
      const template: Template = {
        id,
        profileId: profSelect.value,
        name: nameInput.value.trim(),
        hotkey: hotkeyInp.value.trim().toUpperCase(),
        text: textInput.value,
        enabled: enabledInput.checked,
        sortOrder: idInput.value ? (this.state?.templates.find(t => t.id === id)?.sortOrder || 1) : (this.state?.templates.length || 0) + 1
      };

      await chrome.runtime.sendMessage({ type: 'SAVE_TEMPLATE', payload: template });
      this.closeTemplateModal();
      await this.refreshState();
    });

    document.getElementById('modal-profile-close')?.addEventListener('click', () => this.closeProfileModal());
    document.getElementById('btn-cancel-profile')?.addEventListener('click', () => this.closeProfileModal());

    document.getElementById('btn-save-profile')?.addEventListener('click', async () => {
      const idInput = document.getElementById('prof-id') as HTMLInputElement;
      const nameInput = document.getElementById('prof-name') as HTMLInputElement;

      if (!nameInput.value.trim()) {
        alert('Укажите название профиля');
        return;
      }

      const id = idInput.value || `prof-${Date.now()}`;
      const profile: Profile = {
        id,
        name: nameInput.value.trim(),
        createdAt: Date.now()
      };

      await chrome.runtime.sendMessage({ type: 'SAVE_PROFILE', payload: profile });
      this.closeProfileModal();
      await this.refreshState();
    });
  }

  private openTemplateModal(tmpl?: Template) {
    const modal = document.getElementById('modal-template');
    const title = document.getElementById('modal-template-title');
    const idInput = document.getElementById('tmpl-id') as HTMLInputElement;
    const profSelect = document.getElementById('tmpl-profile') as HTMLSelectElement;
    const nameInput = document.getElementById('tmpl-name') as HTMLInputElement;
    const hotkeyInput = document.getElementById('tmpl-hotkey') as HTMLInputElement;
    const textInput = document.getElementById('tmpl-text') as HTMLTextAreaElement;
    const enabledInput = document.getElementById('tmpl-enabled') as HTMLInputElement;

    if (!modal || !this.state) return;

    profSelect.innerHTML = this.state.profiles.map(p => `
      <option value="${p.id}" ${p.id === (tmpl?.profileId || this.state?.settings.selectedProfileId) ? 'selected' : ''}>${p.name}</option>
    `).join('');

    if (tmpl) {
      if (title) title.textContent = 'Редактировать шаблон';
      idInput.value = tmpl.id;
      nameInput.value = tmpl.name;
      hotkeyInput.value = tmpl.hotkey;
      textInput.value = tmpl.text;
      enabledInput.checked = tmpl.enabled;
    } else {
      if (title) title.textContent = 'Новый шаблон';
      idInput.value = '';
      nameInput.value = '';
      hotkeyInput.value = '';
      textInput.value = '';
      enabledInput.checked = true;
    }

    modal.style.display = 'flex';
  }

  private closeTemplateModal() {
    const modal = document.getElementById('modal-template');
    if (modal) modal.style.display = 'none';
  }

  private openProfileModal(prof?: Profile) {
    const modal = document.getElementById('modal-profile');
    const title = document.getElementById('modal-profile-title');
    const idInput = document.getElementById('prof-id') as HTMLInputElement;
    const nameInput = document.getElementById('prof-name') as HTMLInputElement;

    if (!modal) return;

    if (prof) {
      if (title) title.textContent = 'Переименовать профиль';
      idInput.value = prof.id;
      nameInput.value = prof.name;
    } else {
      if (title) title.textContent = 'Новый профиль';
      idInput.value = '';
      nameInput.value = '';
    }

    modal.style.display = 'flex';
  }

  private closeProfileModal() {
    const modal = document.getElementById('modal-profile');
    if (modal) modal.style.display = 'none';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const options = new OptionsController();
  options.init();
});
