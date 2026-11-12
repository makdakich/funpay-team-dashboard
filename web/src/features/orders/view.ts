import type { Order, OrderAuditLog, Profile, SellerAccount } from '@/types/database';
import { buildHref } from '@/app/router';
import {
  badge, createButton, createEmptyState, createNotice, createSelect, createSkeleton,
  element, formatDate, formatDateTimeFull, icon
} from '@/components/ui';
import { createPageShell, createPanel, createRealtimeIndicator, createTable, type RealtimeIndicator } from '@/components/page';
import { getErrorMessage } from '@/lib/errors';
import { formatCurrency } from '@/lib/money';
import { PAGE_SIZE_OPTIONS } from '@/lib/paging';
import { loadSellerAccounts, loadTeamProfiles } from '@/lib/reference-data';
import { supabase } from '@/lib/supabase';
import { loadOrder, loadOrderAudit, loadOrders, reassignOrderOperator, type OrderPageResult } from './data';
import {
  ATTRIBUTION_SOURCE_LABELS, ATTRIBUTION_STATUS_LABELS, DEFAULT_ORDER_QUERY, ORDER_STATUS_LABELS,
  UNASSIGNED_OPERATOR, hasActiveFilters, orderQueryFromParams, orderQueryToParams,
  type OrderQuery, type OrderSortColumn
} from './filters';

const SEARCH_DEBOUNCE_MS = 350;
const REALTIME_DEBOUNCE_MS = 900;

export interface OrdersPageOptions {
  orderRef: { sellerAccountId: string; orderId: string } | null;
  params: URLSearchParams;
  isOwner?: boolean;
}

export class OrdersPage {
  private readonly container: HTMLElement;
  private readonly orderRef: OrdersPageOptions['orderRef'];
  private readonly isOwner: boolean;
  private query: OrderQuery;
  private profiles: Profile[] = [];
  private shops: SellerAccount[] = [];
  private tableHost: HTMLElement | null = null;
  private pagerHost: HTMLElement | null = null;
  private indicator: RealtimeIndicator | null = null;
  private channel: ReturnType<typeof supabase.channel> | null = null;
  private searchTimer: number | null = null;
  private realtimeTimer: number | null = null;
  private destroyed = false;
  private loading = false;
  private detailHost: HTMLElement | null = null;

  constructor(container: HTMLElement, options: OrdersPageOptions) {
    this.container = container;
    this.orderRef = options.orderRef;
    this.isOwner = Boolean(options.isOwner);
    this.query = orderQueryFromParams(options.params);
    if (this.orderRef) this.mountDetail();
    else this.mountList();
  }

  private mountList(): void {
    const shell = createPageShell({
      eyebrow: 'КОМАНДА · ЗАКАЗЫ',
      title: 'Заказы',
      description: 'Полный список заказов с серверной пагинацией, поиском, фильтрами и аудитом ручных переназначений.'
    });
    const refresh = createButton('Обновить', 'button button-secondary', 'refresh');
    refresh.addEventListener('click', () => void this.refresh());
    this.indicator = createRealtimeIndicator('Подключаем realtime…');
    shell.controls.append(this.indicator.node, refresh);

    const filtersPanel = createPanel('Поиск и фильтры', 'Фильтры применяются на сервере — за один запрос приходит только одна страница');
    filtersPanel.body.append(this.buildFilterBar());

    const dataPanel = createPanel('Результаты');
    this.tableHost = element('div');
    this.tableHost.append(createSkeleton(6));
    this.pagerHost = element('div', 'pagination');
    dataPanel.body.append(this.tableHost, this.pagerHost);

    shell.content.append(filtersPanel.panel, dataPanel.panel);
    this.container.replaceChildren(shell.page);

    void this.bootstrap();
  }

  private async bootstrap(): Promise<void> {
    await this.loadOptions();
    await this.refresh();
    this.subscribeRealtime();
  }

  private async loadOptions(): Promise<void> {
    try {
      const [profiles, shops] = await Promise.all([loadTeamProfiles(), loadSellerAccounts()]);
      if (this.destroyed) return;
      this.profiles = profiles;
      this.shops = shops;
      this.fillSelect('[data-role="operator-filter"]', [{ value: '', label: 'Все операторы' }]
        .concat([{ value: UNASSIGNED_OPERATOR, label: 'Без оператора' }])
        .concat(profiles.map(profile => ({ value: profile.user_id, label: profile.display_name }))), this.query.operatorId);
      this.fillSelect('[data-role="shop-filter"]', [{ value: '', label: 'Все магазины' }]
        .concat(shops.map(shop => ({ value: shop.seller_account_id, label: shop.account_name + (shop.is_active ? '' : ' (неактивен)') }))), this.query.sellerAccountId);
    } catch (error) {
      if (!this.destroyed && this.tableHost) {
        this.tableHost.replaceChildren(createNotice('error', 'Не удалось загрузить справочники: ' + getErrorMessage(error)));
      }
    }
  }

  private fillSelect(selector: string, options: Array<{ value: string; label: string }>, current: string): void {
    const select = this.container.querySelector<HTMLSelectElement>(selector);
    if (!select) return;
    select.replaceChildren();
    for (const option of options) {
      const node = element('option', '', [option.label]);
      node.value = option.value;
      select.append(node);
    }
    select.value = current;
  }

  private buildFilterBar(): HTMLElement {
    const bar = element('div', 'filter-bar');

    const search = element('input', 'text-input');
    search.type = 'search';
    search.placeholder = 'ID заказа или покупатель';
    search.value = this.query.search;
    search.dataset.role = 'search-input';
    search.addEventListener('input', () => {
      if (this.searchTimer !== null) window.clearTimeout(this.searchTimer);
      this.searchTimer = window.setTimeout(() => this.updateQuery({ search: search.value, page: 1 }), SEARCH_DEBOUNCE_MS);
    });

    const operatorSelect = createSelect([{ value: '', label: 'Все операторы' }], this.query.operatorId, value => this.updateQuery({ operatorId: value, page: 1 }));
    operatorSelect.dataset.role = 'operator-filter';
    const shopSelect = createSelect([{ value: '', label: 'Все магазины' }], this.query.sellerAccountId, value => this.updateQuery({ sellerAccountId: value, page: 1 }));
    shopSelect.dataset.role = 'shop-filter';

    const statusSelect = createSelect(
      [{ value: '', label: 'Все статусы' }].concat(
        (['closed', 'paid', 'refunded'] as const).map(status => ({ value: status, label: ORDER_STATUS_LABELS[status] }))
      ),
      this.query.status,
      value => this.updateQuery({ status: value as OrderQuery['status'], page: 1 })
    );
    const currencySelect = createSelect(
      [{ value: '', label: 'Все валюты' }, { value: 'RUB', label: 'RUB' }, { value: 'USD', label: 'USD' }, { value: 'EUR', label: 'EUR' }, { value: 'KZT', label: 'KZT' }],
      this.query.currency,
      value => this.updateQuery({ currency: value as OrderQuery['currency'], page: 1 })
    );

    const fromInput = element('input', 'text-input compact-input');
    fromInput.type = 'date';
    fromInput.value = this.query.from;
    fromInput.addEventListener('change', () => this.updateQuery({ from: fromInput.value, page: 1 }));
    const toInput = element('input', 'text-input compact-input');
    toInput.type = 'date';
    toInput.value = this.query.to;
    toInput.addEventListener('change', () => this.updateQuery({ to: toInput.value, page: 1 }));

    const sizeSelect = createSelect(
      PAGE_SIZE_OPTIONS.map(size => ({ value: String(size), label: size + ' строк' })),
      String(this.query.pageSize),
      value => this.updateQuery({ pageSize: Number(value), page: 1 })
    );

    const reset = createButton('Сбросить фильтры', 'button button-secondary');
    reset.addEventListener('click', () => this.resetFilters());

    bar.append(
      this.field('Поиск', search),
      this.field('Оператор', operatorSelect),
      this.field('Магазин', shopSelect),
      this.field('Статус', statusSelect),
      this.field('Валюта', currencySelect),
      this.field('С даты', fromInput),
      this.field('По дату', toInput),
      this.field('Строк', sizeSelect),
      element('div', 'filter-field filter-actions', [element('span', 'filter-label', ['\u00a0']), reset])
    );
    return bar;
  }

  private field(label: string, control: HTMLElement): HTMLElement {
    return element('div', 'filter-field', [element('span', 'filter-label', [label]), control]);
  }

  private updateQuery(patch: Partial<OrderQuery>): void {
    this.query = { ...this.query, ...patch };
    this.syncUrl();
    void this.refresh();
  }

  private syncUrl(): void {
    const href = buildHref('orders', [], orderQueryToParams(this.query));
    window.history.replaceState(null, '', window.location.pathname + window.location.search + href);
  }

  private resetFilters(): void {
    this.query = { ...DEFAULT_ORDER_QUERY };
    this.syncUrl();
    this.mountList();
  }

  private async refresh(): Promise<void> {
    if (this.destroyed || this.loading || !this.tableHost) return;
    this.loading = true;
    try {
      const result = await loadOrders(this.query);
      if (this.destroyed || !this.tableHost) return;
      if (result.page !== this.query.page) {
        this.query = { ...this.query, page: result.page };
        this.syncUrl();
      }
      this.tableHost.replaceChildren(this.renderTable(result));
      this.renderPager(result);
    } catch (error) {
      if (this.destroyed || !this.tableHost) return;
      this.tableHost.replaceChildren(createNotice('error', 'Не удалось загрузить заказы: ' + getErrorMessage(error)));
      this.pagerHost?.replaceChildren();
    } finally {
      this.loading = false;
    }
  }

  private renderTable(result: OrderPageResult): HTMLElement {
    if (result.rows.length === 0) {
      return hasActiveFilters(this.query)
        ? createEmptyState('Ничего не найдено', 'Ослабьте фильтры или очистите поиск — записи по этим условиям отсутствуют.')
        : createEmptyState('Заказов пока нет', 'Заказы появятся после синхронизации через Chrome Extension (sync_orders_batch).');
    }

    const wrap = element('div', 'table-scroll');
    const table = element('table', 'data-table table-wide');
    const thead = element('thead');
    const headRow = element('tr');
    headRow.append(this.sortableHeader('order_id', 'Заказ'));
    headRow.append(element('th', '', ['Покупатель']));
    headRow.append(element('th', '', ['Магазин']));
    headRow.append(this.sortableHeader('amount', 'Сумма'));
    headRow.append(element('th', '', ['Статус']));
    headRow.append(element('th', '', ['Оператор']));
    headRow.append(element('th', '', ['Атрибуция']));
    headRow.append(this.sortableHeader('funpay_created_at', 'Создан'));
    headRow.append(element('th', '', ['']));
    thead.append(headRow);

    const tbody = element('tbody');
    for (const order of result.rows) tbody.append(this.renderRow(order));
    table.append(thead, tbody);
    wrap.append(table);
    return wrap;
  }

  private sortableHeader(column: OrderSortColumn, label: string): HTMLTableCellElement {
    const cell = element('th');
    const active = this.query.sortBy === column;
    const button = element('button', 'sort-button' + (active ? ' sort-button-active' : ''));
    button.type = 'button';
    button.append(document.createTextNode(label));
    if (active) button.append(icon(this.query.sortDirection === 'asc' ? 'arrow-up' : 'arrow-down'));
    button.addEventListener('click', () => {
      const direction = this.query.sortBy === column && this.query.sortDirection === 'desc' ? 'asc' : 'desc';
      this.updateQuery({ sortBy: column, sortDirection: direction, page: 1 });
    });
    cell.append(button);
    return cell;
  }

  private renderRow(order: Order): HTMLTableRowElement {
    const row = element('tr', 'row-interactive');
    row.append(
      element('td', 'mono-cell', [order.order_id]),
      element('td', '', [order.buyer_username ?? order.buyer_id ?? '—']),
      element('td', '', [this.shopLabel(order.seller_account_id)]),
      element('td', 'numeric-cell', [formatCurrency(Number(order.amount), order.currency)]),
      element('td', '', [badge(ORDER_STATUS_LABELS[order.status] ?? order.status, order.status)]),
      element('td', '', [this.operatorLabel(order.operator_id)]),
      element('td', 'cell-sub', [this.attributionLabel(order)])
    );
    const created = element('td', 'tabular-nums', [formatDate(order.funpay_created_at)]);
    const actions = element('td', 'cell-actions');
    const open = createButton('Открыть', 'button button-ghost');
    open.addEventListener('click', () => this.openDetail(order));
    actions.append(open);
    row.append(created, actions);
    return row;
  }

  private openDetail(order: Order): void {
    window.location.hash = buildHref(
      'orders',
      [order.seller_account_id, order.order_id],
      orderQueryToParams(this.query)
    );
  }

  private renderPager(result: OrderPageResult): void {
    if (!this.pagerHost) return;
    this.pagerHost.replaceChildren();
    if (result.total === 0) return;

    const previous = createButton('Назад', 'button button-secondary', 'arrow-left');
    previous.disabled = result.page <= 1;
    previous.addEventListener('click', () => this.updateQuery({ page: result.page - 1 }));

    const next = createButton('Вперёд', 'button button-secondary', 'chevron');
    next.disabled = result.page >= result.pages;
    next.addEventListener('click', () => this.updateQuery({ page: result.page + 1 }));

    const info = element('span', 'pager-info', [
      'Страница ' + result.page + ' из ' + result.pages + ' · всего заказов: ' + result.total.toLocaleString('ru-RU')
    ]);
    this.pagerHost.append(previous, info, next);
  }

  private operatorLabel(operatorId: string | null): string {
    if (!operatorId) return 'Без оператора';
    const profile = this.profiles.find(p => p.user_id === operatorId);
    if (profile) return profile.display_name;
    return operatorId.length > 12 ? operatorId.slice(0, 8) + '…' : operatorId;
  }

  private shopLabel(sellerAccountId: string): string {
    return this.shops.find(shop => shop.seller_account_id === sellerAccountId)?.account_name ?? sellerAccountId;
  }

  private attributionLabel(order: Order): string {
    const status = ATTRIBUTION_STATUS_LABELS[order.attribution_status] ?? order.attribution_status;
    const source = ATTRIBUTION_SOURCE_LABELS[order.attribution_source] ?? order.attribution_source;
    return status + ' · ' + source;
  }

  private subscribeRealtime(): void {
    if (this.channel) {
      void supabase.removeChannel(this.channel);
      this.channel = null;
    }
    this.channel = supabase
      .channel('orders-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => this.scheduleRealtimeRefresh())
      .subscribe(status => {
        if (this.destroyed || !this.indicator) return;
        if (status === 'SUBSCRIBED') this.indicator.update(true, '');
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          this.indicator.update(false, 'Realtime недоступно · обновляйте вручную');
        }
      });
  }

  private scheduleRealtimeRefresh(): void {
    if (this.realtimeTimer !== null) window.clearTimeout(this.realtimeTimer);
    this.realtimeTimer = window.setTimeout(() => void this.refresh(), REALTIME_DEBOUNCE_MS);
  }

  private mountDetail(): void {
    const shell = createPageShell({
      eyebrow: 'КОМАНДА · ЗАКАЗЫ',
      title: 'Карточка заказа',
      description: 'Финансовые поля заказа неизменяемы; переназначение выполняется только через RPC reassign_order_operator.'
    });
    const back = createButton('К списку заказов', 'button button-secondary', 'arrow-left');
    back.addEventListener('click', () => {
      window.location.hash = buildHref('orders', [], orderQueryToParams(this.query));
    });
    shell.controls.append(back);

    const panel = createPanel('Заказ');
    const host = element('div');
    host.append(createSkeleton(6));
    panel.body.append(host);
    shell.content.append(panel.panel);
    this.container.replaceChildren(shell.page);
    this.detailHost = host;
    void this.loadDetail();
  }

  private async loadDetail(): Promise<void> {
    const host = this.detailHost;
    const ref = this.orderRef;
    if (!host || !ref) return;
    try {
      const [order, audit, profiles, shops] = await Promise.all([
        loadOrder(ref.sellerAccountId, ref.orderId),
        loadOrderAudit(ref.sellerAccountId, ref.orderId),
        loadTeamProfiles(),
        loadSellerAccounts()
      ]);
      if (this.destroyed) return;
      this.profiles = profiles;
      this.shops = shops;
      if (!order) {
        host.replaceChildren(createEmptyState('Заказ не найден', 'Проверьте магазин и ID заказа — запись недоступна для текущей сессии.'));
        return;
      }
      host.replaceChildren(this.buildDetail(order, audit));
    } catch (error) {
      if (this.destroyed) return;
      host.replaceChildren(createNotice('error', 'Не удалось загрузить заказ: ' + getErrorMessage(error)));
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.searchTimer !== null) window.clearTimeout(this.searchTimer);
    if (this.realtimeTimer !== null) window.clearTimeout(this.realtimeTimer);
    if (this.channel) void supabase.removeChannel(this.channel);
    this.channel = null;
    this.searchTimer = null;
    this.realtimeTimer = null;
  }

  private buildDetail(order: Order, audit: readonly OrderAuditLog[]): HTMLElement {
    const stack = element('div', 'detail-stack');
    const head = element('div', 'detail-head');
    const identity = element('div');
    identity.append(element('span', 'eyebrow', [order.seller_account_id]), element('h2', 'detail-title', [order.order_id]));
    head.append(identity, badge(ORDER_STATUS_LABELS[order.status] ?? order.status, order.status));
    stack.append(head);

    const info = element('dl', 'detail-grid');
    const add = (label: string, value: string, mono = false) => {
      info.append(element('dt', 'detail-label', [label]));
      info.append(element('dd', mono ? 'detail-value mono-cell' : 'detail-value', [value]));
    };
    add('Магазин', this.shopLabel(order.seller_account_id));
    add('Сумма', formatCurrency(Number(order.amount), order.currency));
    add('Валюта', order.currency);
    add('Статус', ORDER_STATUS_LABELS[order.status] ?? order.status);
    add('Создан на FunPay', formatDateTimeFull(order.funpay_created_at));
    add('Покупатель', order.buyer_username ?? order.buyer_id ?? '—');
    add('ID покупателя', order.buyer_id ?? '—', true);
    add('Оператор', this.operatorLabel(order.operator_id));
    add('Смена', order.shift_id ?? 'Не привязана (ручная или неоднозначная атрибуция)', true);
    add('Атрибуция', this.attributionLabel(order));
    add('Товар', order.title ?? '—');
    add('Категория', order.subcategory ?? '—', true);
    add('Последняя синхронизация', formatDateTimeFull(order.last_synced_at));
    add('Обновлён', formatDateTimeFull(order.updated_at));
    stack.append(info);

    if (order.description) {
      const description = element('div', 'detail-description');
      description.append(element('span', 'detail-label', ['Описание']), element('p', '', [order.description]));
      stack.append(description);
    }

    stack.append(createNotice('info',
      'RPC reassign_order_operator отвязывает заказ от смены (orders.shift_id = NULL) и помечает атрибуцию как manual. ' +
      'Заказ продолжает учитываться в подтверждённом обороте команды и в доле нового оператора, но исчезает из оборота конкретной смены.'
    ));

    if (this.isOwner) {
      const reassign = createPanel('Ручное переназначение оператора', 'Нужна непустая причина; запись попадёт в order_audit_logs');
      reassign.body.append(this.buildReassignForm(order));
      stack.append(reassign.panel);
    }

    const auditPanel = createPanel('История изменений', audit.length ? 'Записей: ' + audit.length : 'Изменений ещё не было');
    if (audit.length === 0) {
      auditPanel.body.append(createEmptyState('Журнал пуст', 'Ручные переназначения по этому заказу не выполнялись.'));
    } else {
      auditPanel.body.append(createTable(
        ['Когда', 'Кто', 'Оператор: было → стало', 'Атрибуция: было → стало', 'Причина'],
        audit.map(entry => this.renderAuditRow(entry)),
        'table-wide'
      ));
    }
    stack.append(auditPanel.panel);
    return stack;
  }

  private renderAuditRow(entry: OrderAuditLog): HTMLTableRowElement {
    const describe = (status: string, source: string) =>
      (ATTRIBUTION_STATUS_LABELS[status] ?? status) + ' · ' + (ATTRIBUTION_SOURCE_LABELS[source] ?? source);
    const row = element('tr');
    row.append(
      element('td', 'tabular-nums', [formatDateTimeFull(entry.created_at)]),
      element('td', '', [entry.changed_by_display_name]),
      element('td', '', [(entry.old_operator_display_name ?? 'без оператора') + ' → ' + (entry.new_operator_display_name ?? 'без оператора')]),
      element('td', 'cell-sub', [describe(entry.old_attribution_status, entry.old_attribution_source) + ' → ' + describe(entry.new_attribution_status, entry.new_attribution_source)]),
      element('td', '', [entry.reason])
    );
    return row;
  }

  private buildReassignForm(order: Order): HTMLFormElement {
    const form = element('form', 'reassign-form');
    const operatorSelect = createSelect(
      [{ value: '', label: 'Снять оператора (unassigned)' }].concat(
        this.profiles.map(profile => ({ value: profile.user_id, label: profile.display_name }))
      ),
      order.operator_id ?? '',
      () => undefined
    );

    const reason = element('textarea', 'text-input reassign-reason');
    reason.rows = 3;
    reason.placeholder = 'Причина переназначения (обязательна, попадёт в аудит)';

    const submit = createButton('Переназначить', 'button button-primary', 'check');
    submit.type = 'submit';

    const message = element('div', 'form-message');
    const reasonField = element('label', 'filter-field');
    reasonField.append(element('span', 'filter-label', ['Причина']), reason);
    form.append(this.field('Новый оператор', operatorSelect), reasonField, submit, message);

    form.addEventListener('submit', event => {
      event.preventDefault();
      submit.disabled = true;
      message.replaceChildren();
      void reassignOrderOperator({
        sellerAccountId: order.seller_account_id,
        orderId: order.order_id,
        newOperatorId: operatorSelect.value || null,
        reason: reason.value
      })
        .then(() => {
          if (this.destroyed) return;
          message.replaceChildren(createNotice('success', 'Оператор переназначен. Изменение зафиксировано в журнале аудита.'));
          void this.loadDetail();
        })
        .catch(error => {
          if (this.destroyed) return;
          message.replaceChildren(createNotice('error', 'Не удалось переназначить: ' + getErrorMessage(error)));
        })
        .finally(() => { submit.disabled = false; });
    });
    return form;
  }
}