import type { CurrencyTotals, Order, Profile, SellerAccount, Shift } from '@/types/database';
import { buildHref } from '@/app/router';
import {
  badge, createButton, createEmptyState, createNotice, createSegmented, createSelect, createSkeleton,
  element, formatDate, formatDateTimeFull, icon, initialsOf
} from '@/components/ui';
import { createPageShell, createPanel, createTable } from '@/components/page';
import { getErrorMessage } from '@/lib/errors';
import {
  addAmountCents, addTotals, centsToTotals, emptyCents, formatCurrency, formatCurrencyTotals, shareCents, totalsAreEmpty
} from '@/lib/money';
import { loadSellerAccounts, loadTeamProfiles } from '@/lib/reference-data';
import { PERIOD_PRESETS, addDays, formatDurationSeconds, dayKey, resolvePreset, startOfDay, type PeriodPreset } from '@/lib/time';
import { supabase } from '@/lib/supabase';
import {
  finishShift, getActiveShiftForUser, getActiveShifts, loadShiftById, loadShiftHistory, loadShiftOrders,
  startShift,
  type ActiveTeamShift, type ShiftFilters, type ShiftHistory, type ShiftHistoryItem
} from './data';
import { formatDurationHms, shiftDurationSeconds } from './metrics';

const PRESET_ORDER: PeriodPreset[] = ['today', 'last7', 'last30', 'month', 'custom'];

export interface ShiftPageOptions {
  detailShiftId: string | null;
  currentProfile?: Profile | null;
}

export class ShiftHistoryPage {
  private readonly container: HTMLElement;
  private readonly detailShiftId: string | null;
  private readonly currentProfile: Profile | null;
  private filters: ShiftFilters & { preset: PeriodPreset; fromInput: string; toInput: string };
  private profiles: Profile[] = [];
  private shops: SellerAccount[] = [];
  private activeShift: Shift | null = null;
  private activeShiftTurnover: CurrencyTotals = { RUB: 0, USD: 0, EUR: 0, KZT: 0 };
  private activeShiftShare: CurrencyTotals = { RUB: 0, USD: 0, EUR: 0, KZT: 0 };
  private activeShiftOrdersCount = 0;
  private teamActiveShifts: ActiveTeamShift[] = [];
  private summaryHost: HTMLElement | null = null;
  private dataHost: HTMLElement | null = null;
  private activeShiftHost: HTMLElement | null = null;
  private teamActiveShiftsHost: HTMLElement | null = null;
  private realtimeStateLabel: HTMLElement | null = null;
  private shiftActionBtn: HTMLButtonElement | null = null;
  private modalHost: HTMLElement | null = null;
  private liveClockEl: HTMLElement | null = null;
  private realtimeCells: Array<{ node: HTMLElement; shift: Shift }> = [];
  private teamLiveCells: Array<{ node: HTMLElement; shift: Shift }> = [];
  private liveTimer: number | null = null;
  private channel: ReturnType<typeof supabase.channel> | null = null;
  private wasConnected = false;
  private destroyed = false;
  private loading = false;

  constructor(container: HTMLElement, options: ShiftPageOptions) {
    this.container = container;
    this.detailShiftId = options.detailShiftId;
    this.currentProfile = options.currentProfile ?? null;

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

  private isOwner(): boolean {
    return this.currentProfile?.role === 'owner';
  }

  private isCreator(): boolean {
    return Boolean(this.currentProfile?.is_creator);
  }

  private mountList(): void {
    const shell = createPageShell({
      eyebrow: 'КОМАНДА · СМЕНЫ',
      title: 'История смен',
      description: 'Смены команды, длительность и подтверждённый оборот закрытых заказов по каждой смене.'
    });

    // Realtime статус-индикатор
    this.realtimeStateLabel = element('span', 'realtime-indicator');
    this.realtimeStateLabel.append(element('span', 'realtime-dot'), document.createTextNode('Подключаем realtime…'));

    // Кнопка управления сменой ("+ Начать смену" / "⏹ Завершить смену")
    this.shiftActionBtn = createButton('+ Начать смену', 'button button-primary', 'clock');
    this.shiftActionBtn.addEventListener('click', () => {
      if (this.activeShift) this.openFinishShiftModal(this.activeShift);
      else this.openStartShiftModal();
    });

    const refresh = createButton('Обновить', 'button button-secondary', 'refresh');
    refresh.addEventListener('click', () => void this.refresh());

    shell.controls.append(this.realtimeStateLabel, this.shiftActionBtn, refresh);

    // Контейнеры для активной смены и обзора команды
    this.activeShiftHost = element('div', 'active-shift-host');
    this.teamActiveShiftsHost = element('div', 'team-active-shifts-host');

    const filtersPanel = createPanel('Фильтры', 'Оборот считается по связи orders.shift_id — заказ попадает максимум в одну смену');
    filtersPanel.body.append(this.buildFilterBar());

    const dataPanel = createPanel('Смены');
    this.summaryHost = element('div', 'summary-row');
    this.dataHost = element('div');
    this.dataHost.append(createSkeleton(6));
    dataPanel.body.append(this.summaryHost, this.dataHost);

    this.modalHost = element('div', 'modal-host');

    shell.content.append(
      this.activeShiftHost,
      this.teamActiveShiftsHost,
      filtersPanel.panel,
      dataPanel.panel,
      this.modalHost
    );
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

    await this.syncActiveShifts();
    await this.refresh();
    this.subscribeRealtime();
    this.startLiveTimer();
  }

  private subscribeRealtime(): void {
    this.channel = supabase
      .channel('shifts-live-sync')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'shifts' }, () => {
        void this.syncActiveShifts();
        void this.refresh();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'operator_status' }, () => {
        void this.syncActiveShifts();
      })
      .subscribe(status => {
        if (this.destroyed) return;
        const isSubscribed = status === 'SUBSCRIBED';
        this.setRealtimeLabel(isSubscribed);
        if (isSubscribed) {
          if (this.wasConnected) {
            void this.syncActiveShifts();
            void this.refresh();
          }
          this.wasConnected = true;
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          this.wasConnected = false;
        }
      });
  }

  private setRealtimeLabel(available: boolean): void {
    if (!this.realtimeStateLabel) return;
    this.realtimeStateLabel.classList.toggle('realtime-active', available);
    this.realtimeStateLabel.replaceChildren(
      element('span', 'realtime-dot'),
      document.createTextNode(available ? 'Realtime активно' : 'Обновление каждые 30 сек')
    );
  }

  private async syncActiveShifts(): Promise<void> {
    if (this.destroyed) return;
    try {
      const userId = this.currentProfile?.user_id;
      const [ownShift, teamShifts] = await Promise.all([
        userId ? getActiveShiftForUser(userId) : Promise.resolve(null),
        this.isOwner() ? getActiveShifts() : Promise.resolve([])
      ]);
      if (this.destroyed) return;
      this.activeShift = ownShift;
      this.teamActiveShifts = teamShifts;

      if (ownShift) {
        try {
          const orders = await loadShiftOrders(ownShift.id);
          const closed = orders.filter(o => o.status === 'closed');
          const cents = emptyCents();
          for (const o of closed) addAmountCents(cents, o.amount, o.currency);
          this.activeShiftTurnover = centsToTotals(cents);
          this.activeShiftShare = centsToTotals(shareCents(cents));
          this.activeShiftOrdersCount = closed.length;
        } catch {
          // ignore metrics error
        }
      }

      this.updateHeaderActionButton();
      this.renderActiveShiftCard();
      if (this.isOwner()) this.renderTeamActiveShifts();
    } catch (err) {
      console.warn('Failed to sync active shifts:', err);
    }
  }

  private updateHeaderActionButton(): void {
    if (!this.shiftActionBtn) return;
    this.shiftActionBtn.replaceChildren();
    if (this.activeShift) {
      this.shiftActionBtn.className = 'button button-danger-subtle';
      this.shiftActionBtn.append(icon('clock'), document.createTextNode('Завершить смену'));
    } else {
      this.shiftActionBtn.className = 'button button-primary';
      this.shiftActionBtn.append(icon('clock'), document.createTextNode('+ Начать смену'));
    }
  }

  private renderActiveShiftCard(): void {
    if (!this.activeShiftHost) return;
    if (!this.activeShift) {
      this.activeShiftHost.replaceChildren();
      this.liveClockEl = null;
      return;
    }

    const shift = this.activeShift;
    const card = element('article', 'panel active-shift-card');

    const top = element('div', 'active-shift-top');
    const identity = element('div', 'active-shift-identity');
    const badgeWrap = element('div', 'active-shift-badge-wrap');
    badgeWrap.append(element('span', 'pulse-dot'), document.createTextNode('Активная смена'));
    const opInitials = initialsOf(this.currentProfile?.display_name || 'Оператор');
    const avatar = element('span', 'profile-avatar', [opInitials]);
    avatar.style.width = '28px';
    avatar.style.height = '28px';
    avatar.style.fontSize = '11px';
    const opMeta = element('strong', '', [this.currentProfile?.display_name || 'Оператор']);
    identity.append(badgeWrap, avatar, opMeta);

    const shopMeta = element('span', 'environment-chip', [
      element('span', 'environment-dot'),
      `Магазин: ${this.shopLabel(shift.seller_account_id)} (${shift.seller_account_id})`
    ]);
    top.append(identity, shopMeta);

    const main = element('div', 'active-shift-main');
    const clockBox = element('div', 'active-shift-clock-box');
    const clock = element('div', 'active-shift-clock tabular-nums', [
      formatDurationHms(shiftDurationSeconds(shift))
    ]);
    this.liveClockEl = clock;
    const clockLabel = element('span', 'active-shift-clock-label', [
      `Начало: ${formatDate(shift.start_time)} · Длительность (HH:MM:SS)`
    ]);
    clockBox.append(clock, clockLabel);

    const stats = element('div', 'active-shift-stats');
    const stat1 = element('div', 'active-shift-stat-item', [
      element('span', 'active-shift-stat-label', ['Заказов в смене']),
      element('strong', 'active-shift-stat-value tabular-nums', [String(this.activeShiftOrdersCount)])
    ]);
    const stat2 = element('div', 'active-shift-stat-item', [
      element('span', 'active-shift-stat-label', ['Оборот (closed)']),
      element('strong', 'active-shift-stat-value tabular-nums', [
        totalsAreEmpty(this.activeShiftTurnover) ? '0 ₽' : formatCurrencyTotals(this.activeShiftTurnover)
      ])
    ]);
    const stat3 = element('div', 'active-shift-stat-item', [
      element('span', 'active-shift-stat-label', ['Доля оператора 10%']),
      element('strong', 'active-shift-stat-value active-shift-stat-share tabular-nums', [
        totalsAreEmpty(this.activeShiftShare) ? '0 ₽' : formatCurrencyTotals(this.activeShiftShare)
      ])
    ]);
    stats.append(stat1, stat2, stat3);

    const actions = element('div', 'active-shift-actions');
    const finishBtn = createButton('Завершить смену', 'button button-danger-subtle', 'clock');
    finishBtn.addEventListener('click', () => this.openFinishShiftModal(shift));
    actions.append(finishBtn);

    main.append(clockBox, stats, actions);
    card.append(top, main);
    this.activeShiftHost.replaceChildren(card);
  }

  private renderTeamActiveShifts(): void {
    if (!this.teamActiveShiftsHost) return;
    this.teamLiveCells = [];
    if (this.teamActiveShifts.length === 0) {
      this.teamActiveShiftsHost.replaceChildren();
      return;
    }

    const panel = element('div', 'team-active-shifts-panel');
    const header = element('div', 'team-active-shifts-panel-header');
    header.append(
      element('span', 'team-active-shifts-panel-title', [
        `Смены команды онлайн (${this.teamActiveShifts.length})`
      ]),
      element('span', 'realtime-indicator realtime-active', [
        element('span', 'realtime-dot'),
        document.createTextNode('Активно сейчас')
      ])
    );

    const grid = element('div', 'team-active-shifts-grid');
    for (const item of this.teamActiveShifts) {
      const chip = element('div', 'team-active-shift-chip');
      const info = element('div', 'team-active-shift-info');
      info.append(
        element('span', 'team-active-shift-name', [item.operatorName]),
        element('span', 'team-active-shift-sub', [
          `${this.shopLabel(item.shift.seller_account_id)} · с ${formatDate(item.shift.start_time)}`
        ])
      );

      const timer = element('span', 'team-active-shift-timer tabular-nums', [
        formatDurationHms(shiftDurationSeconds(item.shift))
      ]);
      this.teamLiveCells.push({ node: timer, shift: item.shift });

      chip.append(info, timer);
      grid.append(chip);
    }

    panel.append(header, grid);
    this.teamActiveShiftsHost.replaceChildren(panel);
  }

  private openStartShiftModal(): void {
    if (!this.modalHost) return;
    const existing = document.getElementById('modal-shift-start');
    if (existing) existing.remove();

    const overlay = element('div', 'modal-overlay');
    overlay.id = 'modal-shift-start';

    const dialog = element('div', 'modal-dialog');
    dialog.style.maxWidth = '460px';

    const header = element('div', 'modal-header');
    header.append(
      element('h3', '', ['Начать рабочую смену']),
      element('p', 'modal-subtitle', ['Фиксация начала смены для привязки входящих заказов'])
    );

    const form = element('form', 'modal-form');

    // Operator info
    const opGroup = element('div', 'form-group');
    const opLabel = element('label', 'form-label', ['Оператор:']);
    const opValue = element('div', 'member-identity');
    const opAvatar = element('span', 'member-avatar', [initialsOf(this.currentProfile?.display_name || 'Оператор')]);
    const opName = element('strong', '', [this.currentProfile?.display_name || 'Оператор']);
    const roleKind = this.isOwner() ? 'badge-owner' : 'badge-operator';
    const roleName = this.isCreator() ? 'Создатель' : (this.isOwner() ? 'Руководитель' : 'Оператор');
    const opRole = element('span', 'badge ' + roleKind, [roleName]);
    opValue.append(opAvatar, opName, opRole);
    opGroup.append(opLabel, opValue);

    // Store selector
    const storeGroup = element('div', 'form-group');
    const storeLabel = element('label', 'form-label', ['Магазин FunPay:']);
    const activeShops = this.shops.filter(s => s.is_active);
    const storeSelect = element('select', 'select-input') as HTMLSelectElement;
    for (const shop of activeShops) {
      const opt = element('option', '', [`${shop.account_name} (${shop.seller_account_id})`]);
      opt.value = shop.seller_account_id;
      storeSelect.append(opt);
    }
    if (activeShops.some(s => s.seller_account_id === '4473774')) {
      storeSelect.value = '4473774';
    } else if (activeShops.length > 0) {
      storeSelect.value = activeShops[0].seller_account_id;
    }
    storeGroup.append(storeLabel, storeSelect);

    const infoNotice = createNotice(
      'info',
      'После запуска смены все закрытые заказы в выбранном магазине будут автоматически закрепляться за вами для начисления 10% доли выручки.'
    );

    const errorNotice = element('div', 'notice notice-danger');
    errorNotice.style.display = 'none';

    form.append(opGroup, storeGroup, infoNotice, errorNotice);

    const actions = element('div', 'modal-actions');
    const cancelBtn = createButton('Отмена', 'button button-secondary');
    cancelBtn.type = 'button';
    cancelBtn.addEventListener('click', () => overlay.remove());

    const submitBtn = createButton('Подтвердить и начать', 'button button-primary', 'clock');
    submitBtn.type = 'submit';

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const sellerAccountId = storeSelect.value;
      if (!sellerAccountId) {
        errorNotice.textContent = 'Выберите магазин для смены';
        errorNotice.style.display = 'block';
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Открытие смены…';
      errorNotice.style.display = 'none';

      try {
        await startShift({
          sellerAccountId,
          userId: this.currentProfile?.user_id
        });
        overlay.remove();
        await this.syncActiveShifts();
        await this.refresh();
      } catch (err) {
        submitBtn.disabled = false;
        submitBtn.replaceChildren(icon('clock'), document.createTextNode('Подтвердить и начать'));
        errorNotice.textContent = getErrorMessage(err);
        errorNotice.style.display = 'block';
      }
    });

    actions.append(cancelBtn, submitBtn);
    form.append(actions);
    dialog.append(header, form);
    overlay.append(dialog);
    this.modalHost.replaceChildren(overlay);
  }

  private openFinishShiftModal(shift: Shift): void {
    if (!this.modalHost) return;
    const existing = document.getElementById('modal-shift-finish');
    if (existing) existing.remove();

    const overlay = element('div', 'modal-overlay');
    overlay.id = 'modal-shift-finish';

    const dialog = element('div', 'modal-dialog');
    dialog.style.maxWidth = '500px';

    const header = element('div', 'modal-header');
    header.append(
      element('h3', '', ['Завершить рабочую смену']),
      element('p', 'modal-subtitle', ['Подведение итогов и фиксация времени окончания'])
    );

    const form = element('form', 'modal-form');

    const durationSec = shiftDurationSeconds(shift);
    const kpiBox = element('div', 'stat-grid');
    kpiBox.style.gridTemplateColumns = 'repeat(2, 1fr)';
    kpiBox.append(
      this.statCard('Длительность смены', formatDurationHms(durationSec), `с ${formatDate(shift.start_time)}`),
      this.statCard('Магазин', this.shopLabel(shift.seller_account_id), shift.seller_account_id),
      this.statCard('Закрытых заказов', String(this.activeShiftOrdersCount), 'в текущей смене'),
      this.statCard('Доля оператора 10%', totalsAreEmpty(this.activeShiftShare) ? '0 ₽' : formatCurrencyTotals(this.activeShiftShare), 'к выплате')
    );

    const warnNotice = createNotice(
      'info',
      'После закрытия новые заказы перестанут автоматически привязываться к вашей смене. Система выполнит пересчёт атрибуции заказов.'
    );

    const errorNotice = element('div', 'notice notice-danger');
    errorNotice.style.display = 'none';

    form.append(kpiBox, warnNotice, errorNotice);

    const actions = element('div', 'modal-actions');
    const cancelBtn = createButton('Продолжить работу', 'button button-secondary');
    cancelBtn.type = 'button';
    cancelBtn.addEventListener('click', () => overlay.remove());

    const submitBtn = createButton('Завершить смену', 'button button-danger-subtle', 'check');
    submitBtn.type = 'submit';

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      submitBtn.disabled = true;
      submitBtn.textContent = 'Завершение и пересчёт…';
      errorNotice.style.display = 'none';

      try {
        await finishShift(shift.id);
        overlay.remove();
        await this.syncActiveShifts();
        await this.refresh();
      } catch (err) {
        submitBtn.disabled = false;
        submitBtn.replaceChildren(icon('check'), document.createTextNode('Завершить смену'));
        errorNotice.textContent = getErrorMessage(err);
        errorNotice.style.display = 'block';
      }
    });

    actions.append(cancelBtn, submitBtn);
    form.append(actions);
    dialog.append(header, form);
    overlay.append(dialog);
    this.modalHost.replaceChildren(overlay);
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
      [
        'Оператор',
        'Магазин',
        'Начало',
        'Окончание',
        'Длительность',
        'Статус',
        { label: 'Заказы', align: 'right' },
        { label: 'Оборот (closed)', align: 'right' },
        { label: 'Доля 10%', align: 'right' },
        ''
      ],
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
    if (item.shift.status === 'active') {
      durationCell.textContent = formatDurationHms(shiftDurationSeconds(item.shift));
      durationCell.style.color = '#6ee7b7';
      durationCell.style.fontFamily = 'ui-monospace, monospace';
      durationCell.style.fontWeight = '600';
      this.realtimeCells.push({ node: durationCell, shift: item.shift });
    } else {
      durationCell.textContent = formatDurationSeconds(shiftDurationSeconds(item.shift));
    }

    const statusCell = element('td');
    if (item.shift.status === 'active') {
      const activeBadge = element('span', 'badge badge-active', [
        element('span', 'pulse-dot'),
        document.createTextNode('Активна')
      ]);
      activeBadge.style.display = 'inline-flex';
      activeBadge.style.alignItems = 'center';
      activeBadge.style.gap = '6px';
      statusCell.append(activeBadge);
    } else {
      statusCell.append(badge('Завершена', 'neutral'));
    }

    const orderCell = element('td', 'tabular-nums numeric-cell', [String(item.orderCount)]);
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

    this.modalHost = element('div', 'modal-host');

    const panel = createPanel('Детали смены');
    const host = element('div');
    host.append(createSkeleton(5));
    panel.body.append(host);
    shell.content.append(panel.panel, this.modalHost);
    this.container.replaceChildren(shell.page);
    void this.loadDetail(host, shell.controls);
    this.startLiveTimer();
  }

  private async loadDetail(host: HTMLElement, controlsHost: HTMLElement): Promise<void> {
    if (!this.detailShiftId) return;
    try {
      const shift = await loadShiftById(this.detailShiftId);
      if (this.destroyed) return;
      if (!shift) {
        host.replaceChildren(createEmptyState('Смена не найдена', 'Возможно, ссылка устарела или запись удалена.'));
        return;
      }

      // Если смена активна и принадлежит текущему пользователю или пользователь руководитель
      if (shift.status === 'active' && (shift.user_id === this.currentProfile?.user_id || this.isOwner())) {
        const finishBtn = createButton('Завершить смену', 'button button-danger-subtle', 'clock');
        finishBtn.addEventListener('click', () => this.openFinishShiftModal(shift));
        controlsHost.append(finishBtn);
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
    addInfo('Длительность', formatDurationHms(shiftDurationSeconds(shift)));
    if (shift.status === 'active') {
      const durationValue = info.lastElementChild;
      if (durationValue instanceof HTMLElement) {
        durationValue.style.color = '#6ee7b7';
        durationValue.style.fontFamily = 'ui-monospace, monospace';
        durationValue.style.fontWeight = '600';
        this.realtimeCells.push({ node: durationValue, shift });
      }
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
    if (this.liveTimer !== null) window.clearInterval(this.liveTimer);
    this.liveTimer = window.setInterval(() => {
      // 1. Своя активная смена
      if (this.activeShift && this.liveClockEl) {
        this.liveClockEl.textContent = formatDurationHms(shiftDurationSeconds(this.activeShift));
      }
      // 2. Смены команды (для Owner)
      for (const cell of this.teamLiveCells) {
        cell.node.textContent = formatDurationHms(shiftDurationSeconds(cell.shift));
      }
      // 3. Таблица смен
      for (const cell of this.realtimeCells) {
        cell.node.textContent = formatDurationHms(shiftDurationSeconds(cell.shift));
      }
    }, 1000);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.liveTimer !== null) window.clearInterval(this.liveTimer);
    this.liveTimer = null;
    this.realtimeCells = [];
    this.teamLiveCells = [];
    if (this.channel) void supabase.removeChannel(this.channel);
    this.channel = null;
  }
}

function describeStatus(status: string): string {
  if (status === 'closed') return 'Завершён';
  if (status === 'paid') return 'В обработке';
  if (status === 'refunded') return 'Возврат';
  return status;
}
