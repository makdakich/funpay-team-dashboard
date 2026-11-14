import type { CurrencyCode, OverviewData, OverviewOrderPoint, RecentActivity, Shift } from '@/types/database';
import type { Granularity, MetricType, PeriodOption } from './metrics';
import {
  CURRENCIES,
  CURRENCY_SYMBOLS,
  computeDateRange,
  computeExecutiveKpis,
  formatCurrency,
  generateBuckets,
  generateSvgChart
} from './metrics';
import { createButton, createNotice, createSkeleton, element, formatDate, icon, pluralize } from '@/components/ui';
import { getErrorMessage } from '@/lib/errors';
import { loadOverview } from './data';
import { supabase } from '@/lib/supabase';

export class OverviewPage {
  private readonly container: HTMLElement;
  private destroyed = false;
  private channel: ReturnType<typeof supabase.channel> | null = null;
  private resizeHandler: (() => void) | null = null;
  private contentEl: HTMLElement | null = null;
  private data: OverviewData | null = null;
  private wasConnected = false;
  private updateBalanceLive: (() => void) | null = null;
  private updateShiftsLive: ((activeCount: number, recent: RecentActivity[]) => void) | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.mount();
    void this.load();
    this.subscribeRealtime();
  }

  private mount(): void {
    const page = element('section', 'page-stack');
    const heading = element('div', 'page-heading');
    const copy = element('div');
    copy.append(
      element('div', 'eyebrow', ['КОМАНДА · V2.4']),
      element('h1', '', ['Обзор & Финансовая Аналитика']),
      element('p', 'page-description', ['Центр мониторинга выручки, эффективности сменщиков и динамики продаж на FunPay.'])
    );
    const refresh = createButton('Обновить', 'button button-secondary', 'refresh');
    refresh.addEventListener('click', () => void this.load());
    heading.append(copy, refresh);

    this.contentEl = element('div', 'page-content');
    this.contentEl.append(createSkeleton(5));
    page.append(heading, this.contentEl);
    this.container.replaceChildren(page);
  }

  private async load(): Promise<void> {
    if (this.destroyed || !this.contentEl) return;
    try {
      const data = await loadOverview();
      if (this.destroyed || !this.contentEl) return;
      this.data = data;
      this.renderData(data);
    } catch (error) {
      if (this.destroyed || !this.contentEl) return;
      this.contentEl.replaceChildren(createNotice('error', `Не удалось загрузить обзор: ${getErrorMessage(error)}`));
      const retry = createButton('Повторить запрос', 'button button-secondary', 'refresh');
      retry.style.justifySelf = 'start';
      retry.addEventListener('click', () => void this.load());
      this.contentEl.append(retry);
    }
  }

  private subscribeRealtime(): void {
    this.channel = supabase
      .channel(`overview-live-sync-${Math.random().toString(36).slice(2, 9)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'team_seller_accounts' }, payload => {
        if (this.destroyed || !this.data) return;
        const row = payload.new as any;
        if (row) {
          if (typeof row.total_balance === 'number') this.data.totalBalance = row.total_balance;
          if (row.balances && typeof row.balances === 'object') this.data.balancesByCurrency = row.balances;
          if (row.balance_currency) this.data.balanceCurrency = row.balance_currency;
          if (row.balance_updated_at) this.data.balanceUpdatedAt = row.balance_updated_at;
          if (row.account_name) this.data.storeName = row.account_name;
          this.updateBalanceLive?.();
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'shifts' }, () => {
        if (this.destroyed) return;
        void this.refreshShifts();
      })
      .subscribe(status => {
        if (this.destroyed) return;
        if (status === 'SUBSCRIBED') {
          if (this.wasConnected) {
            void this.load();
          }
          this.wasConnected = true;
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          this.wasConnected = false;
        }
      });
  }

  private async refreshShifts(): Promise<void> {
    if (this.destroyed || !this.data) return;
    try {
      const [activeRes, recentRes, profilesRes] = await Promise.all([
        supabase.from('shifts').select('id', { count: 'exact', head: true }).eq('status', 'active'),
        supabase.from('shifts').select('id,user_id,seller_account_id,start_time,end_time,duration_seconds,status').order('start_time', { ascending: false }).limit(6),
        supabase.from('profiles').select('user_id,display_name')
      ]);
      if (this.destroyed || !this.data) return;
      const activeCount = typeof activeRes.count === 'number' ? activeRes.count : this.data.activeShifts;
      this.data.activeShifts = activeCount;

      const names = new Map<string, string>();
      for (const p of (profilesRes.data ?? []) as any[]) {
        names.set(p.user_id, p.display_name);
      }
      const recentActivity: RecentActivity[] = ((recentRes.data ?? []) as Shift[]).map(shift => ({
        shift,
        displayName: names.get(shift.user_id) ?? 'Участник команды'
      }));
      this.data.recentActivity = recentActivity;
      this.updateShiftsLive?.(activeCount, recentActivity);
    } catch {
      // ignore
    }
  }

  private renderData(data: OverviewData): void {
    if (!this.contentEl) return;
    const { element: layout, updateBalance, updateShifts, renderChart } = buildOverviewInteractive(data);
    this.updateBalanceLive = updateBalance;
    this.updateShiftsLive = updateShifts;
    this.contentEl.replaceChildren(layout);
    this.bindWindowResize(renderChart);
  }

  private bindWindowResize(trigger: () => void): void {
    if (this.resizeHandler) {
      window.removeEventListener('resize', this.resizeHandler);
    }
    let resizeTimeout: any;
    this.resizeHandler = () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        if (!this.destroyed) trigger();
      }, 150);
    };
    window.addEventListener('resize', this.resizeHandler);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.channel) {
      void supabase.removeChannel(this.channel);
      this.channel = null;
    }
    if (this.resizeHandler) {
      window.removeEventListener('resize', this.resizeHandler);
      this.resizeHandler = null;
    }
    this.updateBalanceLive = null;
    this.updateShiftsLive = null;
  }
}

export function renderOverview(container: HTMLElement, _onRefresh?: () => void): OverviewPage {
  return new OverviewPage(container);
}

export interface OverviewInteractiveResult {
  element: HTMLElement;
  updateBalance: () => void;
  updateShifts: (activeCount: number, recentActivity: RecentActivity[]) => void;
  renderChart: () => void;
}

export function buildOverviewInteractive(data: OverviewData): OverviewInteractiveResult {
  const stack = element('div', 'overview-layout');

  // State for interactive dashboard
  let activeCurrency: CurrencyCode = 'RUB';
  let sharePercent = 10;
  let chartPeriod: PeriodOption = '7';
  let chartMetric: MetricType = 'turnover';
  let chartGranularity: Granularity = 'days';

  const orders: readonly OverviewOrderPoint[] = data.orders || [];

  // 1. Data Coverage Banner
  const kpis = computeExecutiveKpis(orders, activeCurrency, sharePercent);
  const coverageBar = element('div', 'coverage-strip');
  const coverageLeft = element('div', 'coverage-left');
  coverageLeft.append(
    element('span', 'coverage-icon', ['📅']),
    element('span', 'coverage-title', [
      orders.length > 0
        ? `Охват базы заказов: с ${kpis.earliestDateStr} по ${kpis.latestDateStr}`
        : 'История заказов ещё не синхронизирована'
    ])
  );
  const coverageRight = element('div', 'coverage-right');
  coverageRight.append(
    element('span', 'coverage-count-badge', [`Всего в базе: ${data.totalOrders.toLocaleString('ru-RU')} заказов`])
  );
  coverageBar.append(coverageLeft, coverageRight);

  // 2. Hero KPI Grid (Balance / Confirmed turnover + 3 Delta KPI cards)
  const heroGrid = element('section', 'hero-kpi-grid');

  // 2.1 Left: Balance / Confirmed Turnover Card
  const balanceCard = element('article', 'panel hero-balance-card');
  const cardHeader = element('div', 'hero-card-header');
  const metaBox = element('div', 'hero-meta');
  metaBox.append(
    element('span', 'hero-badge', ['БАЛАНС FUNPAY']),
    element('span', 'hero-sub', [`Пользователь: ${data.storeName || 'Основной магазин'} ${data.sellerAccountId ? `(ID ${data.sellerAccountId})` : ''}`])
  );

  const chipsWrap = element('div', 'currency-chips');
  const chipButtons: Record<CurrencyCode, HTMLElement> = {} as any;
  for (const c of CURRENCIES) {
    const chip = element('button', `currency-chip ${c === activeCurrency ? 'active' : ''}`, [
      `${CURRENCY_SYMBOLS[c]} ${c}`
    ]);
    chip.setAttribute('type', 'button');
    chip.addEventListener('click', () => {
      activeCurrency = c;
      updateCurrencyChips();
      updateExecutiveKpisUI();
      renderChartUI();
    });
    chipButtons[c] = chip;
    chipsWrap.append(chip);
  }
  cardHeader.append(metaBox, chipsWrap);

  const balanceVal = element('div', 'hero-balance-val tabular-nums', ['0 ₽']);
  const syncMeta = element('div', 'hero-turnover-meta');

  // Share slider & earnings row
  const shareControl = element('div', 'hero-share-control');
  const shareLabelRow = element('div', 'share-slider-label');
  const shareLabel = element('span', '', [`Моя доля от оборота: ${sharePercent}%`]);
  const cleanShareVal = element('span', 'share-earned-badge tabular-nums', ['Чистая доля сегодня: 0 ₽']);
  shareLabelRow.append(shareLabel, cleanShareVal);

  const shareSliderRow = element('div', 'share-slider-row');
  const slider = element('input', 'obsidian-slider') as HTMLInputElement;
  slider.type = 'range';
  slider.min = '1';
  slider.max = '100';
  slider.value = String(sharePercent);

  const numInput = element('input', 'share-num-input') as HTMLInputElement;
  numInput.type = 'number';
  numInput.min = '1';
  numInput.max = '100';
  numInput.value = String(sharePercent);

  const onShareChange = (val: number) => {
    sharePercent = Math.max(1, Math.min(100, val || 10));
    slider.value = String(sharePercent);
    numInput.value = String(sharePercent);
    shareLabel.textContent = `Моя доля от оборота: ${sharePercent}%`;
    updateExecutiveKpisUI();
    if (chartMetric === 'share') renderChartUI();
  };

  slider.addEventListener('input', () => onShareChange(Number(slider.value)));
  numInput.addEventListener('change', () => onShareChange(Number(numInput.value)));
  shareSliderRow.append(slider, numInput);
  shareControl.append(shareLabelRow, shareSliderRow);

  balanceCard.append(cardHeader, balanceVal, syncMeta, shareControl);

  // 2.2 Right: 3 Delta KPI Cards Column
  const metricsCol = element('div', 'hero-metrics-column');

  // KPI 1: Выручка сегодня
  const kpiToday = element('article', 'panel delta-card');
  const kpiTodayHead = element('div', 'delta-label-row');
  kpiTodayHead.append(
    element('span', 'delta-name', ['ВЫРУЧКА СЕГОДНЯ']),
    element('span', 'delta-badge positive', ['СЕГОДНЯ'])
  );
  const kpiTodayVal = element('div', 'delta-value tabular-nums', ['0 ₽']);
  const kpiTodaySub = element('div', 'delta-sub', ['0 закрытых заказов']);
  kpiToday.append(kpiTodayHead, kpiTodayVal, kpiTodaySub);

  // KPI 2: Оборот за 7 дней
  const kpi7d = element('article', 'panel delta-card');
  const kpi7dHead = element('div', 'delta-label-row');
  kpi7dHead.append(
    element('span', 'delta-name', ['ОБОРОТ ЗА 7 ДНЕЙ']),
    element('span', 'delta-badge neutral', ['7 ДНЕЙ'])
  );
  const kpi7dVal = element('div', 'delta-value tabular-nums', ['0 ₽']);
  const kpi7dSub = element('div', 'delta-sub', ['Средний чек: 0 ₽']);
  kpi7d.append(kpi7dHead, kpi7dVal, kpi7dSub);

  // KPI 3: Успешность заказов
  const kpiSuccess = element('article', 'panel delta-card');
  const kpiSuccessHead = element('div', 'delta-label-row');
  const kpiSuccessBadge = element('span', 'delta-badge success', ['100%']);
  kpiSuccessHead.append(element('span', 'delta-name', ['УСПЕШНОСТЬ ЗАКАЗОВ']), kpiSuccessBadge);
  const kpiSuccessVal = element('div', 'delta-value tabular-nums', ['0 возвр. (0 успешн.)']);
  const kpiSuccessSub = element('div', 'delta-sub', [`Всего заказов: ${data.totalOrders}`]);
  kpiSuccess.append(kpiSuccessHead, kpiSuccessVal, kpiSuccessSub);

  metricsCol.append(kpiToday, kpi7d, kpiSuccess);
  heroGrid.append(balanceCard, metricsCol);

  function updateCurrencyChips() {
    for (const [c, btn] of Object.entries(chipButtons)) {
      btn.className = `currency-chip ${c === activeCurrency ? 'active' : ''}`;
    }
  }

  function updateExecutiveKpisUI() {
    const k = computeExecutiveKpis(orders, activeCurrency, sharePercent);

    // Current FunPay balance on the account
    const rawAccountBalance = data.balancesByCurrency?.[activeCurrency];
    const currentFunPayBalance = typeof rawAccountBalance === 'number'
      ? rawAccountBalance
      : (activeCurrency === 'RUB' ? (data.totalBalance ?? 0) : 0);

    balanceVal.textContent = formatCurrency(currentFunPayBalance, activeCurrency);

    if (data.balanceUpdatedAt) {
      const syncDate = new Date(data.balanceUpdatedAt);
      const diffMs = Date.now() - syncDate.getTime();
      const diffMin = Math.floor(diffMs / 60000);
      const timeStr = syncDate.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      const dateStr = syncDate.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
      if (diffMin > 120) {
        syncMeta.textContent = `⚠️ Баланс от: ${dateStr}, ${timeStr} (обновлено ${Math.floor(diffMin / 60)} ч. назад)`;
        syncMeta.style.color = '#f59e0b';
      } else if (diffMin <= 1) {
        syncMeta.textContent = `🟢 Баланс актуален (синхронизирован только что)`;
        syncMeta.style.color = '#10b981';
      } else {
        syncMeta.textContent = `Баланс актуален на: ${dateStr}, ${timeStr} (${diffMin} мин. назад)`;
        syncMeta.style.color = 'var(--text-secondary)';
      }
    } else {
      syncMeta.textContent = '⚠️ Баланс ещё не синхронизирован из расширения';
      syncMeta.style.color = '#f59e0b';
    }

    cleanShareVal.textContent = `Чистая доля сегодня: ${formatCurrency(k.todayCleanShare, activeCurrency)}`;

    kpiTodayVal.textContent = formatCurrency(k.todayTurnover, activeCurrency);
    kpiTodaySub.textContent = `${k.todayOrdersCount} закрытых заказов (доля: ${formatCurrency(k.todayCleanShare, activeCurrency)})`;

    kpi7dVal.textContent = formatCurrency(k.last7DaysTurnover, activeCurrency);
    kpi7dSub.textContent = `Средний чек: ${k.last7DaysAvgCheck.toLocaleString('ru-RU')} ${CURRENCY_SYMBOLS[activeCurrency]}`;

    kpiSuccessBadge.textContent = `${k.successRatePercent}%`;
    kpiSuccessVal.textContent = `${k.refundedOrdersCount} возвр. (${k.successfulOrdersCount} успешн.)`;
  }

  // 3. Advanced Sales Dynamics Chart Card
  const chartCard = element('section', 'panel chart-analytics-card');
  const chartTop = element('div', 'chart-top-controls');
  const chartHeadline = element('div', 'chart-headline-group');
  const chartTitle = element('h2', 'chart-title', ['Динамика продаж']);
  const chartSubtitle = element('span', 'chart-subtitle', ['Период']);
  chartHeadline.append(chartTitle, chartSubtitle);

  // Period pills
  const periodBar = element('div', 'period-pills-bar');
  const periods: { key: PeriodOption; label: string }[] = [
    { key: '7', label: '7 дней' },
    { key: '30', label: '30 дней' },
    { key: '90', label: '90 дней' },
    { key: '180', label: '180 дней' },
    { key: '365', label: '365 дней' },
    { key: 'all', label: 'Всё время' }
  ];
  const periodPillBtns: Record<PeriodOption, HTMLElement> = {} as any;

  for (const p of periods) {
    const pill = element('button', `period-pill ${p.key === chartPeriod ? 'active' : ''}`, [p.label]);
    pill.setAttribute('type', 'button');
    pill.addEventListener('click', () => {
      chartPeriod = p.key;
      for (const [k, b] of Object.entries(periodPillBtns)) {
        b.className = `period-pill ${k === chartPeriod ? 'active' : ''}`;
      }
      renderChartUI();
    });
    periodPillBtns[p.key] = pill;
    periodBar.append(pill);
  }
  chartTop.append(chartHeadline, periodBar);

  // Chart Sub-toolbar (Metric, Granularity, Currency)
  const chartSubToolbar = element('div', 'chart-sub-toolbar');

  // Metrics segment: Оборот / Заказы / Моя доля
  const metricGroup = element('div', 'segmented-control');
  const metricButtons: Record<MetricType, HTMLElement> = {} as any;
  const metricOptions: { key: MetricType; label: string }[] = [
    { key: 'turnover', label: 'Оборот' },
    { key: 'orders', label: 'Заказы' },
    { key: 'share', label: 'Моя доля' }
  ];
  for (const m of metricOptions) {
    const btn = element('button', `seg-btn ${m.key === chartMetric ? 'active' : ''}`, [m.label]);
    btn.setAttribute('type', 'button');
    btn.addEventListener('click', () => {
      chartMetric = m.key;
      for (const [k, b] of Object.entries(metricButtons)) {
        b.className = `seg-btn ${k === chartMetric ? 'active' : ''}`;
      }
      renderChartUI();
    });
    metricButtons[m.key] = btn;
    metricGroup.append(btn);
  }

  // Granularity segment: Часы / Дни / Недели / Месяцы
  const granGroup = element('div', 'granularity-toolbar');
  granGroup.append(element('span', 'tool-label', ['Группировка:']));
  const granSeg = element('div', 'segmented-control');
  const granButtons: Record<Granularity, HTMLElement> = {} as any;
  const granOptions: { key: Granularity; label: string }[] = [
    { key: 'hours', label: 'Часы' },
    { key: 'days', label: 'Дни' },
    { key: 'weeks', label: 'Недели' },
    { key: 'months', label: 'Месяцы' }
  ];
  for (const g of granOptions) {
    const btn = element('button', `seg-btn ${g.key === chartGranularity ? 'active' : ''}`, [g.label]);
    btn.setAttribute('type', 'button');
    btn.addEventListener('click', () => {
      chartGranularity = g.key;
      for (const [k, b] of Object.entries(granButtons)) {
        b.className = `seg-btn ${k === chartGranularity ? 'active' : ''}`;
      }
      renderChartUI();
    });
    granButtons[g.key] = btn;
    granSeg.append(btn);
  }
  granGroup.append(granSeg);

  // Currency select dropdown
  const currSelectWrap = element('div', 'chart-currency-picker');
  currSelectWrap.append(element('span', 'tool-label', ['Валюта:']));
  const currSelect = element('select', 'obsidian-select') as HTMLSelectElement;
  for (const c of CURRENCIES) {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = `${c} (${CURRENCY_SYMBOLS[c]})`;
    if (c === activeCurrency) opt.selected = true;
    currSelect.append(opt);
  }
  currSelect.addEventListener('change', () => {
    activeCurrency = currSelect.value as CurrencyCode;
    updateCurrencyChips();
    updateExecutiveKpisUI();
    renderChartUI();
  });
  currSelectWrap.append(currSelect);

  chartSubToolbar.append(metricGroup, granGroup, currSelectWrap);

  // Chart Canvas & Tooltip
  const chartWrapper = element('div', 'chart-wrapper');
  const chartContainer = element('div', 'chart-svg-container');
  const tooltip = element('div', 'chart-floating-tooltip');
  tooltip.style.display = 'none';
  tooltip.innerHTML = `
    <div class="tt-header" id="tt-date">Дата</div>
    <div class="tt-metric-row"><span id="tt-metric-name">Оборот</span>: <strong id="tt-val" class="tabular-nums">0 ₽</strong></div>
    <div class="tt-sub-row">Доля: <span id="tt-share" class="tabular-nums">0 ₽</span> · Заказов: <span id="tt-orders">0</span></div>
    <div class="tt-sub-row tt-refunds" id="tt-refunds-row">Возвратов: <span id="tt-refunds">0</span></div>
  `;
  chartWrapper.append(chartContainer, tooltip);
  chartCard.append(chartTop, chartSubToolbar, chartWrapper);

  function renderChartUI() {
    currSelect.value = activeCurrency;
    const range = computeDateRange(chartPeriod, orders);
    chartSubtitle.textContent = range.label;

    if (chartPeriod === '7' && chartGranularity === 'months') chartGranularity = 'days';
    if (chartPeriod === 'all' && chartGranularity === 'hours') chartGranularity = 'weeks';
    for (const [k, b] of Object.entries(granButtons)) {
      b.className = `seg-btn ${k === chartGranularity ? 'active' : ''}`;
    }

    const buckets = generateBuckets(orders, range.start, range.end, chartGranularity, activeCurrency, sharePercent);
    const width = chartContainer.clientWidth || 880;
    chartContainer.innerHTML = generateSvgChart(buckets, chartMetric, activeCurrency, width, 260);

    bindChartTooltip(chartContainer, tooltip);
  }

  function bindChartTooltip(container: HTMLElement, tip: HTMLElement) {
    const pointGroups = container.querySelectorAll<SVGGElement>('.chart-point-group');
    const crosshair = container.querySelector<SVGLineElement>('#web-chart-crosshair');

    pointGroups.forEach(group => {
      group.addEventListener('mouseenter', e => {
        const target = e.currentTarget as SVGGElement;
        const date = target.getAttribute('data-date') || '';
        const val = target.getAttribute('data-val') || '';
        const turnover = target.getAttribute('data-turnover') || '';
        const share = target.getAttribute('data-share') || '';
        const ordersCount = target.getAttribute('data-orders') || '0';
        const refundsCount = target.getAttribute('data-refunds') || '0';

        const ttDate = tip.querySelector('#tt-date');
        const ttMetricName = tip.querySelector('#tt-metric-name');
        const ttVal = tip.querySelector('#tt-val');
        const ttShare = tip.querySelector('#tt-share');
        const ttOrders = tip.querySelector('#tt-orders');
        const ttRefunds = tip.querySelector('#tt-refunds');

        if (ttDate) ttDate.textContent = date;
        if (ttMetricName) {
          ttMetricName.textContent = chartMetric === 'orders' ? 'Заказы' : chartMetric === 'share' ? 'Моя доля' : 'Оборот';
        }
        if (ttVal) ttVal.textContent = val;
        if (ttShare) {
          ttShare.textContent = chartMetric === 'turnover' ? `Доля: ${share}` : `Оборот: ${turnover}`;
        }
        if (ttOrders) ttOrders.textContent = ordersCount;
        if (ttRefunds) ttRefunds.textContent = refundsCount;

        const circle = target.querySelector('.chart-dot') as SVGCircleElement | null;
        if (circle) {
          const cx = parseFloat(circle.getAttribute('cx') || '0');
          const cy = parseFloat(circle.getAttribute('cy') || '0');
          const wrapRect = chartWrapper.getBoundingClientRect();
          const svgRect = container.getBoundingClientRect();
          const scaleX = svgRect.width / (chartContainer.clientWidth || 880);

          const pixelX = cx * scaleX;
          const pixelY = cy;

          let left = pixelX + 16;
          if (left + 180 > wrapRect.width) left = pixelX - 190;
          let top = pixelY - 40;
          if (top < 10) top = 10;

          tip.style.left = `${Math.max(10, left)}px`;
          tip.style.top = `${top}px`;
          tip.style.display = 'block';

          if (crosshair) {
            crosshair.setAttribute('x1', String(cx));
            crosshair.setAttribute('x2', String(cx));
            crosshair.setAttribute('opacity', '0.7');
          }
        }
      });

      group.addEventListener('mouseleave', () => {
        tip.style.display = 'none';
        if (crosshair) crosshair.setAttribute('opacity', '0');
      });
    });
  }

  // 4. Team Status & Recent Shifts Row
  const bottomGrid = element('div', 'overview-bottom-grid');

  // 4.1 Team Quick Overview Panel
  const teamPanel = element('section', 'panel team-status-card');
  const teamHeading = element('div', 'panel-heading');
  teamHeading.append(
    element('div', '', [
      element('h2', '', ['Команда и смены']),
      element('p', 'panel-description', ['Оперативный статус сотрудников на смене'])
    ]),
    element('span', 'data-chip', [`${data.activeMembers} участников`])
  );
  teamPanel.append(teamHeading);

  const teamKpis = element('div', 'kpi-grid mini-kpi-grid');
  const activeShiftsCard = createKpi('Активные смены', String(data.activeShifts), data.activeShifts === 0 ? 'нет смен в работе' : pluralize(data.activeShifts, 'смена в работе', 'смены в работе', 'смен в работе'), 'clock', 'green');
  teamKpis.append(
    createKpi('Сотрудники', String(data.activeMembers), pluralize(data.activeMembers, 'активный профиль', 'активных профиля', 'активных профилей'), 'users', 'blue'),
    activeShiftsCard,
    createKpi('Всего закрыто', data.closedOrders.toLocaleString('ru-RU'), `из ${data.totalOrders.toLocaleString('ru-RU')} заказов`, 'orders', 'violet')
  );
  teamPanel.append(teamKpis);

  // 4.2 Recent Shifts Activity Panel
  const activityPanel = element('section', 'panel activity-panel');
  const activityHeading = element('div', 'panel-heading');
  const activityCountBadge = element('span', 'subtle-count', [pluralize(data.recentActivity.length, 'событие', 'события', 'событий')]);
  activityHeading.append(
    element('div', '', [
      element('h2', '', ['Последняя активность']),
      element('p', 'panel-description', ['Недавние события рабочих смен команды'])
    ]),
    activityCountBadge
  );
  activityPanel.append(activityHeading);

  const activityContentHost = element('div', 'activity-content-host');
  activityPanel.append(activityContentHost);

  function renderActivityList(items: RecentActivity[]): HTMLElement {
    if (items.length === 0) {
      return emptyState('Пока нет активности', 'Когда участники начнут смены, последние события появятся здесь.');
    }
    const list = element('div', 'activity-list');
    for (const item of items) {
      const row = element('div', 'activity-row');
      const dot = element('span', `activity-marker ${item.shift.status === 'active' ? 'marker-live' : ''}`);
      const details = element('div', 'activity-details');
      details.append(
        element('strong', '', [item.displayName]),
        element('span', '', [item.shift.status === 'active' ? 'Начал смену' : 'Смена завершена'])
      );
      row.append(dot, details, element('time', 'activity-time', [formatDate(item.shift.start_time)]));
      list.append(row);
    }
    return list;
  }

  activityContentHost.replaceChildren(renderActivityList(data.recentActivity));
  bottomGrid.append(teamPanel, activityPanel);

  // Initial UI updates
  updateExecutiveKpisUI();
  renderChartUI();

  stack.append(coverageBar, heroGrid, chartCard, bottomGrid);

  const updateShifts = (activeCount: number, recent: RecentActivity[]) => {
    const valEl = activeShiftsCard.querySelector('.kpi-value');
    const detailEl = activeShiftsCard.querySelector('.kpi-detail');
    if (valEl) valEl.textContent = String(activeCount);
    if (detailEl) detailEl.textContent = activeCount === 0 ? 'нет смен в работе' : pluralize(activeCount, 'смена в работе', 'смены в работе', 'смен в работе');
    activityCountBadge.textContent = pluralize(recent.length, 'событие', 'события', 'событий');
    activityContentHost.replaceChildren(renderActivityList(recent));
  };

  return {
    element: stack,
    updateBalance: updateExecutiveKpisUI,
    updateShifts,
    renderChart: renderChartUI
  };
}

export function buildOverview(data: OverviewData): HTMLElement {
  return buildOverviewInteractive(data).element;
}

function createKpi(label: string, value: string, detail: string, iconName: 'users' | 'clock' | 'orders', accent: string): HTMLElement {
  const card = element('article', 'panel kpi-card');
  const top = element('div', 'kpi-top');
  const iconSpan = element('span', `kpi-icon kpi-${accent}`);
  iconSpan.append(icon(iconName));
  top.append(element('span', 'kpi-label', [label]), iconSpan);
  card.append(top, element('strong', 'kpi-value tabular-nums', [value]), element('span', 'kpi-detail', [detail]));
  return card;
}

function emptyState(title: string, description: string): HTMLElement {
  const box = element('div', 'empty-state');
  box.append(element('span', 'empty-mark', ['—']), element('strong', '', [title]), element('p', '', [description]));
  return box;
}
