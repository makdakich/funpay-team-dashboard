import type { OperatorStatus, TeamMemberRow } from '@/types/database';
import { createButton, createNotice, createSkeleton, element, formatDate, formatDuration } from '@/components/ui';
import { getErrorMessage } from '@/lib/errors';
import { loadTeam } from './data';
import { supabase } from '@/lib/supabase';

const STALE_AFTER_MS = 10 * 60 * 1000;

export class TeamPage {
  private root: HTMLElement;
  private refreshTimer: number | null = null;
  private channel: ReturnType<typeof supabase.channel> | null = null;
  private stateLabel: HTMLElement | null = null;
  private dataContainer: HTMLElement | null = null;
  private destroyed = false;
  private loading = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.mount();
    void this.refresh();
    this.subscribeRealtime();
    this.armRefreshTimer(20_000);
  }

  /** Realtime — основной канал; polling остаётся страховкой с редким интервалом. */
  private armRefreshTimer(delayMs: number): void {
    if (this.refreshTimer !== null) window.clearInterval(this.refreshTimer);
    this.refreshTimer = window.setInterval(() => void this.refresh(), delayMs);
  }

  private mount(): void {
    const page = element('section', 'page-stack');
    const heading = element('div', 'page-heading');
    const copy = element('div');
    copy.append(element('div', 'eyebrow', ['КОМАНДА · УЧАСТНИКИ']), element('h1', '', ['Команда']), element('p', 'page-description', ['Текущая доступность и активные смены участников.']));
    const controls = element('div', 'heading-controls');
    this.stateLabel = element('span', 'realtime-indicator');
    this.stateLabel.append(element('span', 'realtime-dot'), document.createTextNode('Подключаем realtime…'));
    const refresh = createButton('Обновить', 'button button-secondary', 'refresh');
    refresh.addEventListener('click', () => void this.refresh());
    controls.append(this.stateLabel, refresh);
    heading.append(copy, controls);

    const panel = element('section', 'panel team-panel');
    const panelHeading = element('div', 'panel-heading');
    panelHeading.append(element('div', '', [element('h2', '', ['Состав команды']), element('p', 'panel-description', ['Статус сверяется с последним heartbeat и активной сменой'])]));
    panel.append(panelHeading);
    this.dataContainer = element('div', 'team-content');
    this.dataContainer.append(createSkeleton(5));
    panel.append(this.dataContainer);
    page.append(heading, panel);
    this.root.replaceChildren(page);
  }

  private subscribeRealtime(): void {
    this.channel = supabase
      .channel('team-live-status')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'operator_status' }, () => void this.refresh())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'shifts' }, () => void this.refresh())
      .subscribe(status => {
        if (this.destroyed) return;
        if (status === 'SUBSCRIBED') {
          this.setRealtimeLabel(true);
          this.armRefreshTimer(60_000);
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          this.setRealtimeLabel(false);
          this.armRefreshTimer(20_000);
        }
      });
  }

  private setRealtimeLabel(available: boolean): void {
    if (!this.stateLabel) return;
    this.stateLabel.classList.toggle('realtime-active', available);
    this.stateLabel.replaceChildren(element('span', 'realtime-dot'), document.createTextNode(available ? 'Realtime активно' : 'Обновление каждые 20 сек'));
  }

  private async refresh(): Promise<void> {
    if (this.loading || this.destroyed || !this.dataContainer) return;
    this.loading = true;
    try {
      const members = await loadTeam();
      if (this.destroyed) return;
      this.dataContainer.replaceChildren(renderTeamTable(members));
    } catch (error) {
      if (this.destroyed) return;
      const notice = createNotice('error', `Не удалось загрузить участников: ${getErrorMessage(error)}`);
      this.dataContainer?.replaceChildren(notice);
    } finally {
      this.loading = false;
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.refreshTimer !== null) window.clearInterval(this.refreshTimer);
    if (this.channel) void supabase.removeChannel(this.channel);
    this.channel = null;
  }
}

function renderTeamTable(members: TeamMemberRow[]): HTMLElement {
  if (members.length === 0) {
    const empty = element('div', 'empty-state team-empty');
    empty.append(element('span', 'empty-mark', ['—']), element('strong', '', ['Участники не найдены']), element('p', '', ['Проверьте активность профиля и политики доступа Supabase.']));
    return empty;
  }

  const wrap = element('div', 'table-scroll');
  const table = element('table', 'team-table');
  const thead = element('thead');
  const header = element('tr');
  for (const title of ['Участник', 'Статус', 'Текущая смена', 'Начало', 'Аккаунт продавца', 'Последний сигнал']) {
    const th = element('th', '', [title]);
    header.append(th);
  }
  thead.append(header);
  const tbody = element('tbody');
  for (const member of members) tbody.append(renderMemberRow(member));
  table.append(thead, tbody);
  wrap.append(table);
  return wrap;
}

function renderMemberRow(member: TeamMemberRow): HTMLTableRowElement {
  const { profile, presence, activeShift } = member;
  const row = element('tr');
  const person = element('td', 'member-cell');
  const initials = profile.display_name.trim().split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase() ?? '').join('') || 'FP';
  const avatar = element('span', 'member-avatar', [initials]);
  const identity = element('span', 'member-identity');
  identity.append(element('strong', '', [profile.display_name]), element('span', 'member-role', [profile.role === 'owner' ? 'Владелец' : 'Оператор']));
  person.append(avatar, identity);

  const state = derivePresence(presence);
  const status = element('td');
  status.append(element('span', `status-pill status-${state.key}`, [state.label]));

  const shiftCell = element('td');
  shiftCell.append(activeShift
    ? element('span', 'shift-live-label', [formatDuration(activeShift.start_time, null)])
    : element('span', 'muted-value', ['Нет активной смены']));

  const startCell = element('td', 'tabular-nums', [activeShift ? formatDate(activeShift.start_time, { year: undefined }) : '—']);
  const shopCell = element('td', 'tabular-nums', [activeShift?.seller_account_id ?? presence?.current_seller_account_id ?? '—']);
  const heartbeatCell = element('td', 'tabular-nums', [presence ? formatDate(presence.last_heartbeat_at, { year: undefined }) : 'Нет данных']);
  row.append(person, status, shiftCell, startCell, shopCell, heartbeatCell);
  return row;
}

function derivePresence(presence: OperatorStatus | null): { key: string; label: string } {
  if (!presence) return { key: 'offline', label: 'Оффлайн' };
  // Клиент явно сообщил, что ушёл со смены — это не «потеря связи».
  if (presence.status === 'offline') return { key: 'offline', label: 'Оффлайн' };
  const heartbeat = new Date(presence.last_heartbeat_at).getTime();
  if (!Number.isFinite(heartbeat) || Date.now() - heartbeat > STALE_AFTER_MS) {
    return { key: 'stale', label: 'Нет связи' };
  }
  const labels: Record<OperatorStatus['status'], { key: string; label: string }> = {
    offline: { key: 'offline', label: 'Оффлайн' },
    online: { key: 'online', label: 'В сети' },
    on_shift: { key: 'shift', label: 'На смене' },
    break: { key: 'break', label: 'Перерыв' }
  };
  return labels[presence.status] ?? { key: 'offline', label: 'Оффлайн' };
}
