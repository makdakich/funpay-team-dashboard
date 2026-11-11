import type { CurrencyCode, CurrencyTotals, Profile, SellerAccount } from '@/types/database';
import {
  createButton, createEmptyState, createNotice, createSegmented, createSkeleton, element, formatDateOnly
} from '@/components/ui';
import { createPageShell, createPanel, createTable } from '@/components/page';
import { getErrorMessage } from '@/lib/errors';
import { CURRENCIES, CURRENCY_SYMBOLS, formatCurrency, totalsAreEmpty } from '@/lib/money';
import { loadSellerAccounts, loadTeamProfiles } from '@/lib/reference-data';
import { PERIOD_PRESETS, eachDayKey, formatDayLabel, previousRange, resolvePreset, type PeriodPreset } from '@/lib/time';
import { loadFinanceOrders } from './data';
import { analyzeFinance, type FinanceAnalysis, type FinanceGroupRow } from './metrics';

export class FinancePage {
  private readonly container: HTMLElement;
  private preset: PeriodPreset = 'last30';
  private fromInput = '';
  private toInput = '';
  private chartCurrency: CurrencyCode | null = null;
  private profiles: Profile[] = [];
  private shops: SellerAccount[] = [];
  private summaryHost: HTMLElement | null = null;
  private breakdownHost: HTMLElement | null = null;
  private destroyed = false;
  private loading = false;

  constructor(container: HTMLElement) {
    this.container = container;
    this.mount();
    void this.bootstrap();
  }

  private mount(): void {
    const shell = createPageShell({
      eyebrow: 'КОМАНДА · ФИНАНСЫ',
      title: 'Финансы',
      description: 'Подтверждённый оборот закрытых заказов, доля операторов 10% и динамика по валютам.'
    });
    const refresh = createButton('Обновить', 'button button-secondary', 'refresh');
    refresh.addEventListener('click', () => void this.refresh());
    shell.controls.append(refresh);

    const filtersPanel = createPanel('Период', 'В расчёт входят только заказы со статусом closed');
    const bar = element('div', 'filter-bar');
    const presetGroup = createSegmented(
      PERIOD_PRESETS.map(item => ({ value: item.key, label: item.label })),
      this.preset,
      value => { this.preset = value as PeriodPreset; this.applyPreset(); }
    );
    presetGroup.dataset.role = 'finance-presets';
    bar.append(element('div', 'filter-field filter-field-wide', [element('span', 'filter-label', ['Быстрый выбор']), presetGroup]));

    const fromInput = element('input', 'text-input compact-input');
    fromInput.type = 'date';
    fromInput.dataset.role = 'finance-from';
    fromInput.addEventListener('change', () => { this.fromInput = fromInput.value; this.preset = 'custom'; this.applyPreset(); });
    const toInput = element('input', 'text-input compact-input');
    toInput.type = 'date';
    toInput.dataset.role = 'finance-to';
    toInput.addEventListener('change', () => { this.toInput = toInput.value; this.preset = 'custom'; this.applyPreset(); });
    bar.append(
      element('div', 'filter-field', [element('span', 'filter-label', ['С даты']), fromInput]),
      element('div', 'filter-field', [element('span', 'filter-label', ['По дату']), toInput])
    );
    filtersPanel.body.append(bar);

    const summaryPanel = createPanel('Сводка периода');
    this.summaryHost = element('div');
    this.summaryHost.append(createSkeleton(5));
    summaryPanel.body.append(this.summaryHost);

    const breakdownPanel = createPanel('Разбивка', 'Валюты не суммируются между собой');
    this.breakdownHost = element('div', 'finance-layout');
    breakdownPanel.body.append(this.breakdownHost);

    shell.content.append(filtersPanel.panel, summaryPanel.panel, breakdownPanel.panel);
    this.container.replaceChildren(shell.page);
    this.syncPresetGroup();
    this.syncDateInputs();
  }

  private async bootstrap(): Promise<void> {
    try {
      const [profiles, shops] = await Promise.all([loadTeamProfiles(), loadSellerAccounts()]);
      if (this.destroyed) return;
      this.profiles = profiles;
      this.shops = shops;
    } catch (error) {
      if (!this.destroyed && this.summaryHost) {
        this.summaryHost.replaceChildren(createNotice('error', 'Не удалось загрузить справочники: ' + getErrorMessage(error)));
      }
    }
    await this.refresh();
  }

  private currentRange() {
    return resolvePreset(this.preset, new Date(), { from: this.fromInput, to: this.toInput });
  }

  private applyPreset(): void {
    const range = this.currentRange();
    this.fromInput = formatInputDate(range.from);
    this.toInput = formatInputDate(new Date(range.to.getTime() - 86_400_000));
    this.syncPresetGroup();
    this.syncDateInputs();
    void this.refresh();
  }

  private syncPresetGroup(): void {
    const group = this.container.querySelector<HTMLElement>('[data-role="finance-presets"]');
    if (!group) return;
    const rebuilt = createSegmented(
      PERIOD_PRESETS.map(item => ({ value: item.key, label: item.label })),
      this.preset,
      value => { this.preset = value as PeriodPreset; this.applyPreset(); }
    );
    rebuilt.dataset.role = 'finance-presets';
    group.replaceWith(rebuilt);
  }

  private syncDateInputs(): void {
    const fromInput = this.container.querySelector<HTMLInputElement>('[data-role="finance-from"]');
    if (fromInput) fromInput.value = this.fromInput;
    const toInput = this.container.querySelector<HTMLInputElement>('[data-role="finance-to"]');
    if (toInput) toInput.value = this.toInput;
  }

  private async refresh(): Promise<void> {
    if (this.destroyed || this.loading || !this.summaryHost || !this.breakdownHost) return;
    this.loading = true;
    try {
      const range = this.currentRange();
      const previousWindow = previousRange(range);
      const [current, previous] = await Promise.all([
        loadFinanceOrders({ fromIso: range.from.toISOString(), toIso: range.to.toISOString() }),
        loadFinanceOrders({ fromIso: previousWindow.from.toISOString(), toIso: previousWindow.to.toISOString() })
      ]);
      if (this.destroyed || !this.summaryHost || !this.breakdownHost) return;

      const operatorNames = new Map(this.profiles.map(profile => [profile.user_id, profile.display_name]));
      const shopNames = new Map(this.shops.map(shop => [shop.seller_account_id, shop.account_name]));
      const analysis = analyzeFinance(current.rows, { operatorNames, shopNames, dayKeys: eachDayKey(range) });
      const previousAnalysis = analyzeFinance(previous.rows);

      this.renderSummary(analysis, previousAnalysis, current, range);
      this.renderBreakdown(analysis);
    } catch (error) {
      if (this.destroyed || !this.summaryHost || !this.breakdownHost) return;
      const notice = createNotice('error', 'Не удалось загрузить финансы: ' + getErrorMessage(error));
      this.summaryHost.replaceChildren(notice);
      this.breakdownHost.replaceChildren();
    } finally {
      this.loading = false;
    }
  }

  private renderSummary(
    analysis: FinanceAnalysis,
    previousAnalysis: FinanceAnalysis,
    dataset: { paidCount: number; refundedCount: number; truncated: boolean },
    range: { from: Date; to: Date }
  ): void {
    if (!this.summaryHost) return;
    const host = element('div', 'finance-summary');
    const grid = element('div', 'stat-grid');
    grid.append(
      this.statCard('Подтверждённый оборот', totalsAreEmpty(analysis.turnover) ? '—' : currencySummary(analysis.turnover), 'заказы closed, валюты раздельно'),
      this.statCard('Доля операторов · 10%', totalsAreEmpty(analysis.share) ? '—' : currencySummary(analysis.share), 'ровно 10% подтверждённого оборота'),
      this.statCard('Закрытых заказов', analysis.closedCount.toLocaleString('ru-RU'), 'в подтверждённом обороте'),
      this.statCard('Вне оборота', 'оплачено: ' + dataset.paidCount + ' · возвратов: ' + dataset.refundedCount, 'paid и refunded не входят в оборот'),
      this.statCard('Без оператора', String(analysis.unlinkedCount), 'зачисляется в кассу команды, доля 0')
    );
    host.append(grid);
    host.append(this.buildComparison(analysis, previousAnalysis));

    const from = formatDateOnly(range.from.toISOString());
    const to = formatDateOnly(new Date(range.to.getTime() - 86_400_000).toISOString());
    host.append(element('p', 'panel-footnote', ['Период: ' + from + ' — ' + to + '. Сравнение идёт с предыдущим периодом той же длины.']));

    if (analysis.manualCount > 0 || analysis.ambiguousCount > 0) {
      host.append(createNotice('info',
        'Ручных назначений: ' + analysis.manualCount + '. С неоднозначной атрибуцией: ' + analysis.ambiguousCount +
        '. Такие заказы входят в оборот команды, но могут быть не привязаны к смене.'
      ));
    }
    if (analysis.unlinkedCount > 0) {
      host.append(createNotice('info',
        'Закрытых заказов без оператора: ' + analysis.unlinkedCount +
        '. Их оборот зачисляется в кассу команды полностью, операторская доля по ним равна нулю.'
      ));
    }
    if (dataset.truncated) {
      host.append(createNotice('info', 'За период очень много заказов: показаны первые 20000 записей. Сузьте период для точного расчёта.'));
    }
    this.summaryHost.replaceChildren(host);
  }

  private buildComparison(analysis: FinanceAnalysis, previousAnalysis: FinanceAnalysis): HTMLElement {
    const rows: HTMLElement[] = [];
    for (const currency of CURRENCIES) {
      const current = analysis.turnover[currency];
      const before = previousAnalysis.turnover[currency];
      if (current === 0 && before === 0) continue;
      const row = element('tr');
      row.append(
        element('td', 'currency-code', [CURRENCY_SYMBOLS[currency] + ' ' + currency]),
        element('td', 'numeric-cell', [formatCurrency(current, currency)]),
        element('td', 'numeric-cell share-cell', [formatCurrency(analysis.share[currency], currency)]),
        element('td', 'numeric-cell', [formatCurrency(before, currency)]),
        element('td', 'numeric-cell', [deltaLabel(current, before)])
      );
      rows.push(row);
    }

    const panel = createPanel('Оборот по валютам и сравнение с предыдущим периодом');
    if (rows.length === 0) {
      panel.body.append(createEmptyState('Нет закрытых заказов', 'Ни в текущем, ни в предыдущем периоде нет заказов со статусом closed.'));
    } else {
      panel.body.append(createTable(
        ['Валюта', 'Оборот сейчас', 'Доля 10%', 'Предыдущий период', 'Изменение'],
        rows
      ));
    }
    return panel.panel;
  }

  private renderBreakdown(analysis: FinanceAnalysis): void {
    if (!this.breakdownHost) return;
    const layout = element('div', 'finance-layout');
    layout.append(
      this.buildCurrencyTable(analysis),
      this.buildGroupPanel('Операторы', 'Доля считается только по закрытым заказам', analysis.byOperator, 'Оператор'),
      this.buildGroupPanel('Магазины', 'Оборот по аккаунтам продавца', analysis.byShop, 'Магазин'),
      this.buildChart(analysis)
    );
    this.breakdownHost.replaceChildren(layout);
  }

  private buildCurrencyTable(analysis: FinanceAnalysis): HTMLElement {
    const panel = createPanel('Валюты', 'Валюты учитываются строго раздельно — общих сумм нет');
    if (analysis.closedCount === 0) {
      panel.body.append(createEmptyState('Нет закрытых заказов', 'За выбранный период нет заказов со статусом closed. Оплаченные и возвращённые заказы в оборот не входят.'));
      return panel.panel;
    }
    const rows = analysis.byCurrency.map(entry => {
      const row = element('tr');
      row.append(
        element('td', 'currency-code', [CURRENCY_SYMBOLS[entry.currency] + ' ' + entry.currency]),
        element('td', 'tabular-nums', [entry.count.toLocaleString('ru-RU')]),
        element('td', 'numeric-cell', [formatCurrency(entry.turnover, entry.currency)]),
        element('td', 'numeric-cell share-cell', [formatCurrency(entry.share, entry.currency)])
      );
      return row;
    });
    panel.body.append(createTable(['Валюта', 'Заказов', 'Оборот', 'Доля 10%'], rows));
    return panel.panel;
  }

  private buildGroupPanel(title: string, description: string, groups: readonly FinanceGroupRow[], firstColumn: string): HTMLElement {
    const panel = createPanel(title, description);
    if (groups.length === 0) {
      panel.body.append(createEmptyState('Нет данных', 'В выбранном периоде нет закрытых заказов.'));
      return panel.panel;
    }
    const rows = groups.map(group => {
      const row = element('tr');
      row.append(
        element('td', '', [group.label]),
        element('td', 'tabular-nums', [group.count.toLocaleString('ru-RU')]),
        element('td', 'numeric-cell', [currencySummary(group.turnover)]),
        element('td', 'numeric-cell share-cell', [currencySummary(group.share)])
      );
      return row;
    });
    panel.body.append(createTable([firstColumn, 'Заказов', 'Оборот', 'Доля 10%'], rows));
    return panel.panel;
  }

  private buildChart(analysis: FinanceAnalysis): HTMLElement {
    const panel = createPanel('Динамика оборота', 'Каждая валюта показывается отдельно — значения не суммируются');
    const available = CURRENCIES.filter(currency => analysis.daily.some(point => point.turnover[currency] !== 0));
    if (available.length === 0) {
      panel.body.append(createEmptyState('Нет данных для графика', 'В выбранном периоде нет закрытых заказов.'));
      return panel.panel;
    }

    const active = this.chartCurrency && available.includes(this.chartCurrency) ? this.chartCurrency : available[0];
    this.chartCurrency = active;
    const controls = element('div', 'chart-controls');
    const chartHost = element('div', 'chart-host');

    const renderActive = (currency: CurrencyCode) => {
      this.chartCurrency = currency;
      chartHost.replaceChildren(this.buildBars(analysis, currency));
      controls.replaceChildren(createSegmented(
        available.map(item => ({ value: item, label: CURRENCY_SYMBOLS[item] + ' ' + item })),
        currency,
        value => renderActive(value as CurrencyCode)
      ));
    };
    renderActive(active);
    panel.body.append(controls, chartHost);
    return panel.panel;
  }

  private buildBars(analysis: FinanceAnalysis, currency: CurrencyCode): HTMLElement {
    const points = analysis.daily;
    const max = points.reduce((accumulator, point) => Math.max(accumulator, point.turnover[currency]), 0);
    if (max === 0) {
      return createEmptyState('Нет оборота в этой валюте', 'За выбранный период закрытых заказов в этой валюте нет.');
    }
    const chart = element('div', 'bar-chart');
    points.forEach((point, index) => {
      const value = point.turnover[currency];
      const column = element('div', 'bar-column');
      column.title = formatDayLabel(point.dateKey) + ': ' + formatCurrency(value, currency) + ' · заказов: ' + point.count;
      const bar = element('span', 'bar');
      bar.style.height = Math.max(2, Math.round((value / max) * 100)) + '%';
      column.append(bar);
      const showLabel = points.length <= 15 || index % 5 === 0 || index === points.length - 1;
      column.append(element('span', 'bar-label' + (showLabel ? '' : ' bar-label-hidden'), [showLabel ? formatDayLabel(point.dateKey) : '']));
      chart.append(column);
    });
    return chart;
  }

  private statCard(label: string, value: string, detail: string): HTMLElement {
    const card = element('article', 'stat-card');
    card.append(element('span', 'stat-label', [label]), element('strong', 'stat-value', [value]), element('span', 'stat-detail', [detail]));
    return card;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

function currencySummary(totals: CurrencyTotals): string {
  const parts = CURRENCIES.filter(currency => totals[currency] !== 0).map(currency => formatCurrency(totals[currency], currency));
  return parts.length ? parts.join(' · ') : '—';
}

function deltaLabel(current: number, before: number): string {
  if (before === 0) return current === 0 ? '—' : 'новый оборот';
  const delta = ((current - before) / before) * 100;
  return (delta > 0 ? '+' : '') + delta.toFixed(1) + '%';
}

function formatInputDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return date.getFullYear() + '-' + month + '-' + day;
}
