import type { CurrencyTotals, Order, Profile, SellerAccount, Shift } from '@/types/database';
import { buildHref } from '@/app/router';
import {
  badge, createButton, createEmptyState, createNotice, createSegmented, createSelect, createSkeleton,
  element, formatDate, formatDateTimeFull
} from '@/components/ui';
import { createPageShell, createPanel, createTable } from '@/components/page';
import { getErrorMessage } from '@/lib/errors';
import {
  addAmountCents, addTotals, centsToTotals, emptyCents, formatCurrency, formatCurrencyTotals, shareCents, totalsAreEmpty
} from '@/lib/money';
import { loadSellerAccounts, loadTeamProfiles } from '@/lib/reference-data';
import { PERIOD_PRESETS, addDays, formatDurationSeconds, dayKey, resolvePreset, startOfDay, type PeriodPreset } from '@/lib/time';
import {
  loadShiftById, loadShiftHistory, loadShiftOrders,
  type ShiftFilters, type ShiftHistory, type ShiftHistoryItem
} from './data';
import { shiftDurationSeconds } from './metrics';

const PRESET_ORDER: PeriodPreset[] = ['today', 'last7', 'last30', 'month', 'custom'];
const FAST_REFRESH_MS = 30_000;

export interface ShiftPageOptions {
  detailShiftId: string | null;
}

export class ShiftHistoryPage {
  private readonly container: HTMLElement;
  private readonly detailShiftId: string | null;
  private filters: ShiftFilters & { preset: PeriodPreset; fromInput: string; toInput: string };
  private profiles: Profile[] = [];
  private shops: SellerAccount[] = [];
  private summaryHost: HTMLElement | null = null;
  private dataHost: HTMLElement | null = null;
  private realtimeCells: Array<{ node: HTMLElement; shift: Shift }> = [];
  private liveTimer: number | null = null;
  private destroyed = false;
  private loading = false;

  constructor(container: HTMLElement, options: ShiftPageOptions) {
    this.container = container;
    this.detailShiftId = options.detailShiftId;
    const today = startOfDay(new Date());
    const from = addDays(today, -6);
    this.filters = {
      operatorId: '',
      status: 'all',
      from: from.toISOString(),
      to: addDays(today, 1).toISOString(),
      preset: 'last7',
      fromInput: dayKey(from),
      toInput: dayKey(today)
    };

    if (this.detailShiftId) this.mountDetail();
    else this.mountList();
  }

  private mountList(): void {
    const shell = createPageShell({
      eyebrow: 'КОМАНДА · СМЕНЫ',
      title: 'История смен',
      description: 'Смены команды, длительность и подтверждённый оборот закрытых заказов по каждой смене.'
    });
    const refresh = createButton('Обновить', 'button button-secondary', 'refresh');
    refresh.addEventListener('click', () => void this.refresh());
    shell.controls.append(refresh);

    const filtersPanel = createPanel('Фильтры', 'Оборот считается по связи orders.shift_id — заказ попадает максимум в одну смену');
    filtersPanel.body.append(this.buildFilterBar());

    const dataPanel = createPanel('Смены');
    this.summaryHost = element('div', 'summary-row');
    this.dataHost = element('div');
    this.dataHost.append(createSkeleton(6));
    dataPanel.body.append(this.summaryHost, this.dataHost);

    shell.content.append(filtersPanel.panel, dataPanel.panel);
    this.container.replaceChildren(shell.page);
    void this.bootstrap();
  }

  private async bootstrap(): Promise<void> {
    try {
      const [profiles, shops] = await Promise.all([loadTeamProfiles(), loadSellerAccounts()]);
      if (this.destroyed) return;
      this.profiles = profiles;
      this.shops = shops;
      this.refreshFilters();
    } catch (error) {
      if (!this.destroyed && this.dataHost) {
        this.dataHost.replaceChildren(createNotice('error', 'Не удалось загрузить участников: ' + getErrorMessage(error)));
      }
    }
    await this.refresh();
    this.startLiveTimer();
  }

  private buildFilterBar(): HTMLElement {
    const bar = element('div', 'filter-bar');
    const operatorSelect = createSelect(
      [{ value: '', label: 'Все операторы' }],
      this.filters.operatorId,
      value => { this.filters.operatorId = value; this.applyPreset(this.filters.preset); }
    );
    operatorSelect.dataset.role = 'operator-filter';

    const statusSelect = createSelect(
      [
        { value: 'all', label: 'Все смены' },
        { value: 'active', label: 'Активные' },
        { value: 'completed', label: 'Завершённые' }
      ],
      this.filters.status,
      value => { this.filters.status = value as ShiftFilters['status']; void this.refresh(); }
    );

    const fromInput = element('input', 'text-input compact-input');
    fromInput.type = 'date';
    fromInput.value = this.filters.fromInput;
    fromInput.dataset.role = 'from-input';
    fromInput.addEventListener('change', () => {
      this.filters.fromInput = fromInput.value;
      this.filters.preset = 'custom';
      this.applyPreset('custom');
    });

    const toInput = element('input', 'text-input compact-input');
    toInput.type = 'date';
    toInput.value = this.filters.toInput;
    toInput.dataset.role = 'to-input';
    toInput.addEventListener('change', () => {
      this.filters.toInput = toInput.value;
      this.filters.preset = 'custom';
      this.applyPreset('custom');
    });

    const presetGroup = createSegmented(
      PERIOD_PRESETS.filter(preset => PRESET_ORDER.includes(preset.key)).map(preset => ({ value: preset.key, label: preset.label })),
      this.filters.preset,
      value => this.applyPreset(value as PeriodPreset)
    );
    presetGroup.dataset.role = 'preset-group';

    bar.append(
      this.wrapField('Оператор', operatorSelect),
      this.wrapField('Статус', statusSelect),
      this.wrapField('С', fromInput),
      this.wrapField('По', toInput),
      element('div', 'filter-field filter-field-wide', [element('span', 'filter-label', ['Период']), presetGroup])
    );
    return bar;
  }

  private wrapField(label: string, control: HTMLElement): HTMLElement {
    return element('div', 'filter-field', [element('span', 'filter-label', [label]), control]);
  }

  private refreshFilters(): void {
    const operatorSelect = this.container.querySelector<HTMLSelectElement>('[data-role="operator-filter"]');
    if (operatorSelect) {
      const options = [{ value: '', label: 'Все операторы' }].concat(
        this.profiles.map(profile => ({ value: profile.user_id, label: profile.display_name }))
      );
      const current = this.filters.operatorId;
      operatorSelect.replaceChildren();
      for (const option of options) {
        const node = element('option', '', [option.label]);
        node.value = option.value;
        operatorSelect.append(node);
      }
      operatorSelect.value = current;
    }
    const fromInput = this.container.querySelector<HTMLInputElement>('[data-role="from-input"]');
    if (fromInput) fromInput.value = this.filters.fromInput;
    const toInput = this.container.querySelector<HTMLInputElement>('[data-role="to-input"]');
    if (toInput) toInput.value = this.filters.toInput;
  }

  private applyPreset(preset: PeriodPreset): void {
    if (preset !== 'custom') {
      const range = resolvePreset(preset, new Date());
      this.filters.from = range.from.toISOString();
      this.filters.to = range.to.toISOString();
      this.filters.fromInput = dayKey(range.from);
      this.filters.toInput = dayKey(addDays(range.to, -1));
    } else {
      const from = this.filters.fromInput ? new Date(this.filters.fromInput + 'T00:00:00') : startOfDay(new Date());
      const to = this.filters.toInput ? new Date(this.filters.toInput + 'T00:00:00') : from;
      this.filters.from = startOfDay(from).toISOString();
      this.filters.to = addDays(startOfDay(to), 1).toISOString();
    }
    this.filters.preset = preset;
    this.refreshFilters();
    const group = this.container.querySelector<HTMLElement>('[data-role="preset-group"]');
    if (group) {
      const rebuilt = createSegmented(
        PERIOD_PRESETS.filter(item => PRESET_ORDER.includes(item.key)).map(item => ({ value: item.key, label: item.label })),
        preset,
        value => this.applyPreset(value as PeriodPreset)
      );
      rebuilt.dataset.role = 'preset-group';
      group.replaceWith(rebuilt);
    }
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    if (this.destroyed || this.loading || !this.dataHost) return;
    this.loading = true;
    try {
      const history = await loadShiftHistory({
        operatorId: this.filters.operatorId,
        status: this.filters.status,
        from: this.filters.from,
        to: this.filters.to
      });
      if (this.destroyed || !this.dataHost) return;
      this.realtimeCells = [];
      this.renderSummary(history);
      this.dataHost.replaceChildren(this.renderTable(history));
    } catch (error) {
      if (this.destroyed || !this.dataHost) return;
      this.dataHost.replaceChildren(createNotice('error', 'Не удалось загрузить смены: ' + getErrorMessage(error)));
    } finally {
      this.loading = false;
    }
  }

  private renderSummary(history: ShiftHistory): void {
    if (!this.summaryHost) return;
    const turnover: CurrencyTotals = { RUB: 0, USD: 0, EUR: 0, KZT: 0 };
    const share: CurrencyTotals = { RUB: 0, USD: 0, EUR: 0, KZT: 0 };
    let activeCount = 0;
    let orderCount = 0;
    for (const item of history.items) {
      addTotals(turnover, item.turnover);
      addTotals(share, item.share);
      orderCount += item.orderCount;
      if (item.shift.status === 'active') activeCount += 1;
    }

    const summary = element('div', 'stat-grid');
    summary.append(
      this.statCard('Смен в выборке', String(history.items.length), 'активных: ' + activeCount),
      this.statCard('Закрытых заказов', String(orderCount), 'привязаны к сменам через shift_id'),
      this.statCard('Подтверждённый оборот', totalsAreEmpty(turnover) ? '—' : formatCurrencyTotals(turnover), 'только status = closed, валюты раздельно'),
      this.statCard('Доля операторов · 10%', totalsAreEmpty(share) ? '—' : formatCurrencyTotals(share), 'по закрытым заказам с оператором')
    );

    this.summaryHost.replaceChildren(summary);
    if (history.truncated) {
      this.summaryHost.append(createNotice('info', 'Показаны последние ' + history.items.length + ' смен. Сузьте период, чтобы увидеть более ранние записи.'));
    }
    if (history.unlinked.closedCount > 0) {
      this.summaryHost.append(createNotice(
        'info',
        'Вне смен: ' + history.unlinked.closedCount + ' закрытых заказов на ' +
          formatCurrencyTotals(history.unlinked.turnover, '—') +
          '. Из них с неоднозначной атрибуцией: ' + history.unlinked.ambiguousCount +
          '. Они входят в кассу команды, но не привязаны ни к одной смене.'
      ));
    }
  }

  private statCard(label: string, value: string, detail: string): HTMLElement {
    const card = element('article', 'stat-card');
    card.append(element('span', 'stat-label', [label]), element('strong', 'stat-value', [value]), element('span', 'stat-detail', [detail]));
    return card;
  }

  private renderShopCell(sellerAccountId: string): HTMLTableCellElement {
    const cell = element('td');
    cell.append(element('strong', 'cell-main', [this.shopLabel(sellerAccountId)]));
    cell.append(element('span', 'cell-sub mono-cell', [sellerAccountId]));
    return cell;
  }

  private shopLabel(sellerAccountId: string): string {
    return this.shops.find(shop => shop.seller_account_id === sellerAccountId)?.account_name ?? sellerAccountId;
  }

  private renderTable(history: ShiftHistory): HTMLElement {
    if (history.items.length === 0) {
      return createEmptyState('Смены не найдены', 'Измените период или фильтры. Данные берутся из таблицы shifts.');
    }
    const rows = history.items.map(item => this.renderRow(item));
    return createTable(
      ['Оператор', 'Магазин', 'Начало', 'Окончание', 'Длительность', 'Статус', 'Заказы', 'Оборот (closed)', 'Доля 10%', ''],
      rows,
      'table-wide'
    );
  }

  private renderRow(item: ShiftHistoryItem): HTMLTableRowElement {
    const row = element('tr', 'row-interactive');
    row.dataset.shiftId = item.shift.id;

    const operatorCell = element('td', '', [element('strong', '', [item.operatorName])]);
    operatorCell.append(element('span', 'cell-sub', [item.shift.status === 'active' ? 'Активная смена' : 'Завершена']));

    const durationCell = element('td', 'tabular-nums');
    durationCell.textContent = formatDurationSeconds(shiftDurationSeconds(item.shift));
    if (item.shift.status === 'active') this.realtimeCells.push({ node: durationCell, shift: item.shift });

    const statusCell = element('td');
    statusCell.append(item.shift.status === 'active'
      ? badge('Активна', 'active')
      : badge('Завершена', 'neutral'));

    const orderCell = element('td', 'tabular-nums', [String(item.orderCount)]);
    const turnoverCell = element('td', 'numeric-cell', [totalsAreEmpty(item.turnover) ? '—' : formatCurrencyTotals(item.turnover, '—')]);
    const shareCell = element('td', 'numeric-cell share-cell', [totalsAreEmpty(item.share) ? '—' : formatCurrencyTotals(item.share, '—')]);

    const actionCell = element('td', 'cell-actions');
    const open = createButton('Заказы', 'button button-ghost');
    open.addEventListener('click', () => { window.location.hash = buildHref('shifts', [item.shift.id]); });
    actionCell.append(open);

    row.append(
      operatorCell,
      this.renderShopCell(item.shift.seller_account_id),
      element('td', 'tabular-nums', [formatDate(item.shift.start_time)]),
      element('td', 'tabular-nums', [item.shift.end_time ? formatDate(item.shift.end_time) : '—']),
      durationCell,
      statusCell,
      orderCell,
      turnoverCell,
      shareCell,
      actionCell
    );
    return row;
  }

  private mountDetail(): void {
    const shell = createPageShell({
      eyebrow: 'КОМАНДА · СМЕНЫ',
      title: 'Смена',
      description: 'Заказы, привязанные к выбранной смене через orders.shift_id.'
    });
    const back = createButton('К списку смен', 'button button-secondary', 'arrow-left');
    back.addEventListener('click', () => { window.location.hash = buildHref('shifts'); });
    shell.controls.append(back);

    const panel = createPanel('Детали смены');
    const host = element('div');
    host.append(createSkeleton(5));
    panel.body.append(host);
    shell.content.append(panel.panel);
    this.container.replaceChildren(shell.page);
    void this.loadDetail(host);
    this.startLiveTimer();
  }

  private async loadDetail(host: HTMLElement): Promise<void> {
    if (!this.detailShiftId) return;
    try {
      const shift = await loadShiftById(this.detailShiftId);
      if (this.destroyed) return;
      if (!shift) {
        host.replaceChildren(createEmptyState('Смена не найдена', 'Возможно, ссылка устарела или запись удалена.'));
        return;
      }
      const [orders, profiles] = await Promise.all([loadShiftOrders(shift.id), loadTeamProfiles()]);
      if (this.destroyed) return;
      host.replaceChildren(this.buildDetail(shift, orders, profiles));
    } catch (error) {
      if (this.destroyed) return;
      host.replaceChildren(createNotice('error', 'Не удалось загрузить смену: ' + getErrorMessage(error)));
    }
  }

  private buildDetail(shift: Shift, orders: readonly Order[], profiles: readonly Profile[]): HTMLElement {
    const closed = orders.filter(order => order.status === 'closed');
    const cents = emptyCents();
    for (const order of closed) addAmountCents(cents, order.amount, order.currency);
    const turnover: CurrencyTotals = centsToTotals(cents);
    const share = centsToTotals(shareCents(cents));

    const operatorName = profiles.find(profile => profile.user_id === shift.user_id)?.display_name ?? 'Участник команды';
    const stack = element('div', 'detail-stack');

    const info = element('dl', 'detail-grid');
    const addInfo = (label: string, value: string, mono = false) => {
      info.append(element('dt', 'detail-label', [label]));
      info.append(element('dd', mono ? 'detail-value mono-cell' : 'detail-value', [value]));
    };
    addInfo('Оператор', operatorName);
    addInfo('Магазин', shift.seller_account_id, true);
    addInfo('Статус', shift.status === 'active' ? 'Активна' : 'Завершена');
    addInfo('Начало', formatDateTimeFull(shift.start_time));
    addInfo('Окончание', shift.end_time ? formatDateTimeFull(shift.end_time) : 'Ещё не закрыта');
    addInfo('Длительность', formatDurationSeconds(shiftDurationSeconds(shift)));
    if (shift.status === 'active') {
      const durationValue = info.lastElementChild;
      if (durationValue instanceof HTMLElement) this.realtimeCells.push({ node: durationValue, shift });
    }
    addInfo('Заказов всего', String(orders.length));
    addInfo('Закрытых заказов', String(closed.length));
    addInfo('Оборот (closed)', totalsAreEmpty(turnover) ? '—' : formatCurrencyTotals(turnover, '—'));
    addInfo('Доля оператора · 10%', totalsAreEmpty(share) ? '—' : formatCurrencyTotals(share, '—'));
    stack.append(info);

    if (closed.length === 0) {
      stack.append(createNotice('info', shift.status === 'active'
        ? 'На активной смене пока нет подтверждённых (closed) заказов.'
        : 'В этой смене нет подтверждённых заказов со статусом closed.'));
    }

    if (orders.length === 0) {
      stack.append(createEmptyState('Заказов нет', 'К этой смене не привязан ни один заказ.'));
      return stack;
    }

    const rows = orders.map(order => {
      const row = element('tr');
      row.append(
        element('td', 'mono-cell', [order.order_id]),
        element('td', '', [order.buyer_username ?? order.buyer_id ?? '—']),
        element('td', 'numeric-cell', [formatCurrency(Number(order.amount), order.currency)]),
        element('td', '', [describeStatus(order.status)]),
        element('td', '', [order.attribution_source === 'manual' ? 'Вручную' : order.attribution_status === 'assigned' ? 'Автоматически' : order.attribution_status === 'ambiguous' ? 'Неоднозначно' : 'Без смены']),
        element('td', 'tabular-nums', [formatDate(order.funpay_created_at)])
      );
      return row;
    });
    stack.append(createTable(['Заказ', 'Покупатель', 'Сумма', 'Статус', 'Атрибуция', 'Создан'], rows, 'table-wide'));
    stack.append(element('p', 'panel-footnote', [
      'Оборот и доля считаются только по заказам со статусом closed. Заказы paid и refunded в оборот не входят, возвраты не вычитаются повторно.'
    ]));
    return stack;
  }

  private startLiveTimer(): void {
    this.liveTimer = window.setInterval(() => {
      for (const cell of this.realtimeCells) {
        cell.node.textContent = formatDurationSeconds(shiftDurationSeconds(cell.shift));
      }
    }, FAST_REFRESH_MS);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.liveTimer !== null) window.clearInterval(this.liveTimer);
    this.liveTimer = null;
    this.realtimeCells = [];
  }
}

function describeStatus(status: string): string {
  if (status === 'closed') return 'Завершён';
  if (status === 'paid') return 'В обработке';
  if (status === 'refunded') return 'Возврат';
  return status;
}
