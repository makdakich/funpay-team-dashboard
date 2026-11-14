import { appendChildren, element, type ElementChild } from './ui';
import { supabase } from '@/lib/supabase';

export interface PageHeadingOptions {
  eyebrow: string;
  title: string;
  description: string;
  actions?: ElementChild[];
}

export interface PageShell {
  page: HTMLElement;
  heading: HTMLElement;
  controls: HTMLElement;
  content: HTMLElement;
}

export function createPageShell(options: PageHeadingOptions): PageShell {
  const page = element('section', 'page-stack');
  const heading = element('div', 'page-heading');
  const copy = element('div');
  copy.append(
    element('div', 'eyebrow', [options.eyebrow]),
    element('h1', '', [options.title]),
    element('p', 'page-description', [options.description])
  );
  const controls = element('div', 'heading-controls');
  heading.append(copy, controls);
  const content = element('div', 'page-content');
  page.append(heading, content);
  if (options.actions) appendChildren(controls, options.actions);
  return { page, heading, controls, content };
}

export interface Panel {
  panel: HTMLElement;
  heading: HTMLElement;
  body: HTMLElement;
}

export function createPanel(title: string, description?: string, trailing: ElementChild[] = []): Panel {
  const panel = element('section', 'panel content-panel');
  const heading = element('div', 'panel-heading');
  const copy = element('div');
  copy.append(element('h2', '', [title]));
  if (description) copy.append(element('p', 'panel-description', [description]));
  heading.append(copy);
  if (trailing.length) {
    const aside = element('div', 'panel-heading-aside');
    appendChildren(aside, trailing);
    heading.append(aside);
  }
  const body = element('div', 'panel-body');
  panel.append(heading, body);
  return { panel, heading, body };
}

export interface RealtimeIndicator {
  node: HTMLElement;
  update(available: boolean, fallback: string): void;
}

export function createRealtimeIndicator(initialText: string): RealtimeIndicator {
  const node = element('span', 'realtime-indicator');
  node.append(element('span', 'realtime-dot'), document.createTextNode(initialText));
  return {
    node,
    update(available: boolean, fallback: string) {
      node.classList.toggle('realtime-active', available);
      node.replaceChildren(element('span', 'realtime-dot'), document.createTextNode(available ? 'Realtime активно' : fallback));
    }
  };
}

export class SyncStatusIndicator {
  public readonly node: HTMLElement;
  private readonly dotEl: HTMLElement;
  private readonly labelEl: HTMLElement;
  private timer: number | null = null;
  private channel: ReturnType<typeof supabase.channel> | null = null;
  private destroyed = false;
  private socketState: 'connected' | 'reconnecting' | 'disconnected' = 'reconnecting';
  private lastOrdersSync: Date | null = null;
  private lastBalanceSync: Date | null = null;

  constructor() {
    this.node = element('div', 'sync-status-indicator realtime-indicator');
    this.dotEl = element('span', 'realtime-dot');
    this.labelEl = element('span', 'sync-status-label', ['Подключение к Realtime…']);
    this.node.append(this.dotEl, this.labelEl);
    this.node.title = 'Статус Realtime и свежесть данных FunPay';
    this.node.style.cursor = 'default';
    this.render();
    this.timer = window.setInterval(() => this.render(), 15_000);

    void this.init();
  }

  private async init(): Promise<void> {
    await this.fetchTimestamps();
    this.subscribe();
  }

  private async fetchTimestamps(): Promise<void> {
    try {
      const [orderRes, sellerRes] = await Promise.all([
        supabase.from('orders').select('last_synced_at').order('last_synced_at', { ascending: false }).limit(1).maybeSingle(),
        supabase.from('team_seller_accounts').select('balance_updated_at').order('balance_updated_at', { ascending: false }).limit(1).maybeSingle()
      ]);
      if (this.destroyed) return;
      if (orderRes.data?.last_synced_at) {
        this.lastOrdersSync = new Date(orderRes.data.last_synced_at);
      }
      if (sellerRes.data?.balance_updated_at) {
        this.lastBalanceSync = new Date(sellerRes.data.balance_updated_at);
      }
      this.render();
    } catch {
      // ignore
    }
  }

  private subscribe(): void {
    this.channel = supabase
      .channel(`header-sync-status-${Math.random().toString(36).slice(2, 9)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, payload => {
        if (this.destroyed) return;
        const row = payload.new as any;
        if (row?.last_synced_at) {
          this.lastOrdersSync = new Date(row.last_synced_at);
          this.render();
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'team_seller_accounts' }, payload => {
        if (this.destroyed) return;
        const row = payload.new as any;
        if (row?.balance_updated_at) {
          this.lastBalanceSync = new Date(row.balance_updated_at);
          this.render();
        }
      })
      .subscribe(status => {
        if (this.destroyed) return;
        if (status === 'SUBSCRIBED') {
          this.socketState = 'connected';
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          this.socketState = 'reconnecting';
        } else if (status === 'CLOSED') {
          this.socketState = 'disconnected';
        }
        this.render();
      });
  }

  private render(): void {
    if (this.destroyed) return;

    this.node.classList.remove('realtime-active', 'sync-status-warning', 'sync-status-error');

    if (this.socketState === 'reconnecting') {
      this.node.classList.add('sync-status-warning');
      this.labelEl.textContent = 'Переподключение…';
      this.node.title = 'Потеряно соединение с Realtime. Идёт автоматическое переподключение.';
      return;
    }

    if (this.socketState === 'disconnected') {
      this.node.classList.add('sync-status-error');
      this.labelEl.textContent = 'Офлайн';
      this.node.title = 'Realtime недоступен. Данные обновляются только вручную.';
      return;
    }

    // socketState === 'connected'
    this.node.classList.add('realtime-active');

    const latestTime = Math.max(
      this.lastOrdersSync?.getTime() ?? 0,
      this.lastBalanceSync?.getTime() ?? 0
    );

    if (latestTime === 0) {
      this.labelEl.textContent = 'Realtime активно';
      this.node.title = 'Подключено к Realtime. История синхронизаций FunPay ожидает первого обновления.';
      return;
    }

    const diffMin = Math.floor((Date.now() - latestTime) / 60000);
    const orderStr = this.lastOrdersSync ? this.lastOrdersSync.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : 'нет данных';
    const balStr = this.lastBalanceSync ? this.lastBalanceSync.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : 'нет данных';

    let freshnessLabel = '';
    if (diffMin <= 1) {
      freshnessLabel = 'FunPay: только что';
    } else if (diffMin < 60) {
      freshnessLabel = `FunPay: ${diffMin} мин. назад`;
    } else {
      const diffHours = Math.floor(diffMin / 60);
      freshnessLabel = `FunPay: > ${diffHours} ч. назад`;
    }

    this.labelEl.textContent = `${freshnessLabel} · Live`;
    this.node.title = `Realtime подключен\nЗаказы синхронизированы: ${orderStr}\nБаланс обновлён: ${balStr}`;
  }

  destroy(): void {
    this.destroyed = true;
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    if (this.channel) void supabase.removeChannel(this.channel);
    this.channel = null;
  }
}

export type TableHeaderItem = string | { label: string; align?: 'left' | 'right' | 'center'; className?: string };

/** Собирает таблицу со строкой заголовков и телом; автоматически выравнивает заголовки над числовыми ячейками. */
export function createTable(headers: readonly TableHeaderItem[], rows: readonly HTMLElement[], minWidthClass = ''): HTMLElement {
  const wrap = element('div', 'table-scroll');
  const table = element('table', 'data-table ' + minWidthClass);
  const thead = element('thead');
  const headerRow = element('tr');
  const firstRow = rows[0];
  const firstCells = firstRow ? (Array.from(firstRow.children) as HTMLElement[]) : [];

  for (let i = 0; i < headers.length; i++) {
    const item = headers[i];
    const title = typeof item === 'string' ? item : item.label;
    const cell = firstCells[i];
    const isNumericFromCell = Boolean(
      cell && (
        cell.classList.contains('numeric-cell') ||
        cell.classList.contains('share-cell')
      )
    );
    const isExplicitRight = typeof item !== 'string' && item.align === 'right';
    const isRight = isExplicitRight || isNumericFromCell;

    const thClasses = [];
    if (isRight) thClasses.push('th-numeric');
    if (typeof item !== 'string' && item.className) thClasses.push(item.className);

    const th = element('th', thClasses.join(' '), [title]);
    if (isRight) {
      th.style.textAlign = 'right';
    }
    headerRow.append(th);
  }

  thead.append(headerRow);
  const tbody = element('tbody');
  for (const row of rows) tbody.append(row);
  table.append(thead, tbody);
  wrap.append(table);
  return wrap;
}
