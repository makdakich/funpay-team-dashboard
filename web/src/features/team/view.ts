import type { OperatorStatus, Profile, TeamMemberRow } from '@/types/database';
import { createButton, createNotice, createSkeleton, element, formatDate, formatDuration } from '@/components/ui';
import { getErrorMessage } from '@/lib/errors';
import { inviteMember, loadTeam, setMemberActive, setMemberRole } from './data';
import { supabase } from '@/lib/supabase';

const STALE_AFTER_MS = 10 * 60 * 1000;

export class TeamPage {
  private root: HTMLElement;
  private currentUserProfile: Profile | null;
  private refreshTimer: number | null = null;
  private channel: ReturnType<typeof supabase.channel> | null = null;
  private stateLabel: HTMLElement | null = null;
  private dataContainer: HTMLElement | null = null;
  private inviteModalHost: HTMLElement | null = null;
  private destroyed = false;
  private loading = false;

  constructor(root: HTMLElement, currentUserProfile: Profile | null = null) {
    this.root = root;
    this.currentUserProfile = currentUserProfile;
    this.mount();
    void this.refresh();
    this.subscribeRealtime();
    this.armRefreshTimer(20_000);
  }

  private isOwner(): boolean {
    return this.currentUserProfile?.role === 'owner';
  }

  private isCreator(): boolean {
    return Boolean(this.currentUserProfile?.is_creator);
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
    copy.append(
      element('div', 'eyebrow', ['КОМАНДА · УПРАВЛЕНИЕ И СМЕНЫ']),
      element('h1', '', ['Команда']),
      element('p', 'page-description', ['Управление составом команды, контроль доступности и активные смены.'])
    );
    const controls = element('div', 'heading-controls');
    this.stateLabel = element('span', 'realtime-indicator');
    this.stateLabel.append(element('span', 'realtime-dot'), document.createTextNode('Подключаем realtime…'));

    const refresh = createButton('Обновить', 'button button-secondary', 'refresh');
    refresh.addEventListener('click', () => void this.refresh());
    controls.append(this.stateLabel, refresh);

    if (this.isOwner()) {
      const inviteBtn = createButton('+ Пригласить участника', 'button button-primary');
      inviteBtn.addEventListener('click', () => this.openInviteModal());
      controls.append(inviteBtn);
    }

    heading.append(copy, controls);

    const panel = element('section', 'panel team-panel');
    const panelHeading = element('div', 'panel-heading');
    panelHeading.append(
      element('div', '', [
        element('h2', '', ['Состав команды']),
        element('p', 'panel-description', [
          this.isOwner()
            ? 'Руководители и операторы · управление доступом и ролями'
            : 'Статус сверяется с последним heartbeat и активной сменой'
        ])
      ])
    );
    panel.append(panelHeading);
    this.dataContainer = element('div', 'team-content');
    this.dataContainer.append(createSkeleton(5));
    panel.append(this.dataContainer);

    this.inviteModalHost = element('div', 'modal-host');
    page.append(heading, panel, this.inviteModalHost);
    this.root.replaceChildren(page);
  }

  private subscribeRealtime(): void {
    this.channel = supabase
      .channel('team-live-status')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'operator_status' }, () => void this.refresh())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'shifts' }, () => void this.refresh())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, () => void this.refresh())
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
    this.stateLabel.replaceChildren(
      element('span', 'realtime-dot'),
      document.createTextNode(available ? 'Realtime активно' : 'Обновление каждые 20 сек')
    );
  }

  private async refresh(): Promise<void> {
    if (this.loading || this.destroyed || !this.dataContainer) return;
    this.loading = true;
    try {
      const includeInactive = this.isOwner();
      const members = await loadTeam(includeInactive);
      if (this.destroyed) return;
      this.dataContainer.replaceChildren(this.renderTeamTable(members));
    } catch (error) {
      if (this.destroyed) return;
      const notice = createNotice('error', `Не удалось загрузить участников: ${getErrorMessage(error)}`);
      this.dataContainer?.replaceChildren(notice);
    } finally {
      this.loading = false;
    }
  }

  private renderTeamTable(members: TeamMemberRow[]): HTMLElement {
    if (members.length === 0) {
      const empty = element('div', 'empty-state team-empty');
      empty.append(
        element('span', 'empty-mark', ['—']),
        element('strong', '', ['Участники не найдены']),
        element('p', '', ['Проверьте активность профиля и политики доступа Supabase.'])
      );
      return empty;
    }

    const wrap = element('div', 'table-scroll');
    const table = element('table', 'team-table');
    const thead = element('thead');
    const header = element('tr');

    const headers = ['Участник', 'Роль', 'Статус', 'Текущая смена', 'Начало', 'Магазин', 'Сигнал'];
    if (this.isOwner()) headers.push('Действия');

    for (const title of headers) {
      header.append(element('th', '', [title]));
    }
    thead.append(header);

    const tbody = element('tbody');
    for (const member of members) {
      tbody.append(this.renderMemberRow(member));
    }
    table.append(thead, tbody);
    wrap.append(table);
    return wrap;
  }

  private renderMemberRow(member: TeamMemberRow): HTMLTableRowElement {
    const { profile, presence, activeShift } = member;
    const row = element('tr');
    if (!profile.is_active) row.classList.add('row-inactive');

    const person = element('td', 'member-cell');
    const initials = profile.display_name.trim().split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase() ?? '').join('') || 'FP';
    const avatar = element('span', 'member-avatar', [initials]);
    const identity = element('span', 'member-identity');
    identity.append(element('strong', '', [profile.display_name]));
    person.append(avatar, identity);

    // Роль
    const roleCell = element('td');
    let roleText = 'Оператор';
    let roleClass = 'badge badge-operator';
    if (profile.is_creator) {
      roleText = '⭐ Создатель';
      roleClass = 'badge badge-creator';
    } else if (profile.role === 'owner') {
      roleText = '👑 Руководитель';
      roleClass = 'badge badge-owner';
    }
    roleCell.append(element('span', roleClass, [roleText]));

    // Статус присутствия и активности
    const statusCell = element('td');
    if (!profile.is_active) {
      const statusText = profile.invitation_status === 'invited' ? 'Приглашён' : (profile.invitation_status === 'pending_confirmation' ? 'Ожидает пароль' : 'Отключён');
      statusCell.append(element('span', 'status-pill status-offline', [statusText]));
    } else {
      const state = derivePresence(presence);
      statusCell.append(element('span', `status-pill status-${state.key}`, [state.label]));
    }

    const shiftCell = element('td');
    shiftCell.append(
      activeShift
        ? element('span', 'shift-live-label', [formatDuration(activeShift.start_time, null)])
        : element('span', 'muted-value', ['Нет активной смены'])
    );

    const startCell = element('td', 'tabular-nums', [activeShift ? formatDate(activeShift.start_time, { year: undefined }) : '—']);
    const shopCell = element('td', 'tabular-nums', [activeShift?.seller_account_id ?? presence?.current_seller_account_id ?? '—']);
    const heartbeatCell = element('td', 'tabular-nums', [presence ? formatDate(presence.last_heartbeat_at, { year: undefined }) : 'Нет данных']);

    row.append(person, roleCell, statusCell, shiftCell, startCell, shopCell, heartbeatCell);

    // Колонка управления для руководителей
    if (this.isOwner()) {
      const actionsCell = element('td', 'member-actions-cell');
      actionsCell.append(this.renderActions(member));
      row.append(actionsCell);
    }

    return row;
  }

  private renderActions(member: TeamMemberRow): HTMLElement {
    const { profile } = member;
    const group = element('div', 'action-buttons-group');

    // 1. Создатель системы полностью защищён от действий любого пользователя
    if (profile.is_creator) {
      group.append(element('span', 'muted-value text-xs', ['Защищён']));
      return group;
    }

    // 2. Управление вторым руководителем
    if (profile.role === 'owner') {
      if (this.isCreator()) {
        const demoteBtn = createButton('Понизить', 'button button-danger-subtle button-xs');
        demoteBtn.addEventListener('click', async () => {
          if (!confirm(`Понизить руководителя "${profile.display_name}" до оператора?`)) return;
          try {
            demoteBtn.disabled = true;
            await setMemberRole(profile.user_id, 'operator', 'Понижение до оператора Создателем');
            await this.refresh();
          } catch (e) {
            alert(`Ошибка: ${getErrorMessage(e)}`);
          } finally {
            demoteBtn.disabled = false;
          }
        });
        group.append(demoteBtn);
      } else {
        group.append(element('span', 'muted-value text-xs', ['Руководитель']));
      }
      return group;
    }

    // 3. Управление обычным оператором
    // Creator может повысить оператора до Owner
    if (this.isCreator()) {
      const promoteBtn = createButton('Сделать Owner', 'button button-secondary button-xs');
      promoteBtn.addEventListener('click', async () => {
        if (!confirm(`Назначить "${profile.display_name}" вторым руководителем (Owner)?`)) return;
        try {
          promoteBtn.disabled = true;
          await setMemberRole(profile.user_id, 'owner', 'Повышение до руководителя Создателем');
          await this.refresh();
        } catch (e) {
          alert(`Ошибка: ${getErrorMessage(e)}`);
        } finally {
          promoteBtn.disabled = false;
        }
      });
      group.append(promoteBtn);
    }

    // Оба руководителя могут активировать и деактивировать операторов
    if (profile.is_active) {
      const deactivateBtn = createButton('Отключить', 'button button-danger-subtle button-xs');
      deactivateBtn.addEventListener('click', async () => {
        if (!confirm(`Деактивировать участника "${profile.display_name}"? Доступ к системе будет заблокирован.`)) return;
        try {
          deactivateBtn.disabled = true;
          await setMemberActive(profile.user_id, false, 'Деактивация руководителем');
          await this.refresh();
        } catch (e) {
          alert(`Ошибка: ${getErrorMessage(e)}`);
        } finally {
          deactivateBtn.disabled = false;
        }
      });
      group.append(deactivateBtn);
    } else {
      if (profile.invitation_status === 'invited' || profile.invitation_status === 'pending_confirmation') {
        const reinviteBtn = createButton('Повторить инвайт', 'button button-secondary button-xs');
        reinviteBtn.addEventListener('click', () => {
          this.openInviteModal(undefined, profile.display_name);
        });
        group.append(reinviteBtn);
      }

      const activateBtn = createButton('Активировать', 'button button-primary button-xs');
      activateBtn.addEventListener('click', async () => {
        try {
          activateBtn.disabled = true;
          await setMemberActive(profile.user_id, true, 'Активация руководителем');
          await this.refresh();
        } catch (e) {
          alert(`Ошибка: ${getErrorMessage(e)}`);
        } finally {
          activateBtn.disabled = false;
        }
      });
      group.append(activateBtn);
    }

    return group;
  }

  private openInviteModal(initialEmail?: string, initialDisplayName?: string): void {
    if (!this.inviteModalHost) return;

    const overlay = element('div', 'modal-overlay');
    const modal = element('div', 'modal-dialog');
    const header = element('div', 'modal-header');
    header.append(element('h3', '', [initialDisplayName ? `Повторное приглашение: ${initialDisplayName}` : 'Пригласить участника команды']));

    const form = element('form', 'modal-form');
    const emailGroup = element('div', 'form-group');
    const emailInput = element('input', 'text-input');
    emailInput.type = 'email';
    emailInput.name = 'email';
    emailInput.required = true;
    emailInput.placeholder = 'operator@example.com';
    if (initialEmail) emailInput.value = initialEmail;

    emailGroup.append(
      element('label', '', ['Email пользователя']),
      emailInput
    );

    const nameGroup = element('div', 'form-group');
    const nameInput = element('input', 'text-input');
    nameInput.type = 'text';
    nameInput.name = 'displayName';
    nameInput.placeholder = 'Иван Иванов';
    if (initialDisplayName) nameInput.value = initialDisplayName;

    nameGroup.append(
      element('label', '', ['Отображаемое имя (необязательно)']),
      nameInput
    );

    const roleGroup = element('div', 'form-group');
    roleGroup.append(element('label', '', ['Роль в команде']));
    const select = element('select', 'select-input');
    select.name = 'role';
    const opOption = element('option', '', ['Оператор (Operator)']);
    opOption.value = 'operator';
    select.append(opOption);

    if (this.isCreator()) {
      const ownerOption = element('option', '', ['Руководитель (Owner)']);
      ownerOption.value = 'owner';
      select.append(ownerOption);
    } else {
      roleGroup.append(element('small', 'form-note', ['Назначение роли руководителя доступно только Создателю команды']));
    }
    roleGroup.append(select);

    const resendGroup = element('div', 'form-group');
    const resendLabel = element('label', 'checkbox-label');
    resendLabel.style.display = 'flex';
    resendLabel.style.alignItems = 'center';
    resendLabel.style.gap = '8px';
    resendLabel.style.cursor = 'pointer';
    const resendCheckbox = element('input', 'checkbox-input') as HTMLInputElement;
    resendCheckbox.type = 'checkbox';
    resendCheckbox.name = 'resend';
    if (initialDisplayName) resendCheckbox.checked = true;
    resendLabel.append(resendCheckbox, document.createTextNode('Повторное приглашение (создать прямую ссылку)'));
    resendGroup.append(resendLabel, element('small', 'form-note', [
      'Позволяет сгенерировать новую прямую ссылку для входа, если письмо не дошло'
    ]));

    const actions = element('div', 'modal-actions');
    const cancelBtn = createButton('Отмена', 'button button-secondary');
    cancelBtn.type = 'button';
    cancelBtn.addEventListener('click', () => overlay.remove());

    const submitBtn = createButton('Отправить приглашение', 'button button-primary');
    submitBtn.type = 'submit';

    actions.append(cancelBtn, submitBtn);
    form.append(emailGroup, nameGroup, roleGroup, resendGroup, actions);

    form.addEventListener('submit', async e => {
      e.preventDefault();
      const fd = new FormData(form);
      const email = String(fd.get('email') || '').trim();
      const displayName = String(fd.get('displayName') || '').trim();
      const role = (fd.get('role') as 'owner' | 'operator') || 'operator';
      const resend = resendCheckbox.checked;

      if (!email) return;

      try {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Отправка…';
        const res = await inviteMember({ email, displayName, role, resend });

        if (res.action_link) {
          modal.replaceChildren();

          const successHeader = element('div', 'modal-header');
          successHeader.append(element('h3', '', ['Приглашение сформировано']));

          const successBody = element('div', 'modal-form');
          successBody.append(createNotice('success', res.message));

          const linkGroup = element('div', 'form-group');
          linkGroup.append(
            element('label', '', ['Прямая ссылка для завершения регистрации']),
            element('p', 'form-note', [
              'Передайте эту ссылку сотруднику (в Telegram / Discord), если письмо задерживается или отправка была повторной:'
            ])
          );

          const linkRow = element('div', 'invite-link-row');
          linkRow.style.display = 'flex';
          linkRow.style.gap = '8px';
          linkRow.style.alignItems = 'center';

          const linkInput = element('input', 'text-input');
          linkInput.type = 'text';
          linkInput.readOnly = true;
          linkInput.value = res.action_link;
          linkInput.style.fontFamily = 'monospace';
          linkInput.style.fontSize = '12px';
          linkInput.style.flex = '1';

          const copyBtn = createButton('Копировать', 'button button-primary');
          copyBtn.type = 'button';
          copyBtn.addEventListener('click', async () => {
            try {
              await navigator.clipboard.writeText(res.action_link!);
              copyBtn.textContent = 'Скопировано!';
              setTimeout(() => {
                copyBtn.textContent = 'Копировать';
              }, 2000);
            } catch {
              linkInput.select();
              copyBtn.textContent = 'Скопировано!';
              setTimeout(() => {
                copyBtn.textContent = 'Копировать';
              }, 2000);
            }
          });

          linkRow.append(linkInput, copyBtn);
          linkGroup.append(linkRow);

          const actionsRow = element('div', 'modal-actions');
          const closeBtn = createButton('Готово', 'button button-secondary');
          closeBtn.type = 'button';
          closeBtn.addEventListener('click', () => {
            overlay.remove();
          });
          actionsRow.append(closeBtn);

          successBody.append(linkGroup, actionsRow);
          modal.append(successHeader, successBody);
          await this.refresh();
        } else {
          alert(res.message);
          overlay.remove();
          await this.refresh();
        }
      } catch (err) {
        alert(`Ошибка приглашения: ${getErrorMessage(err)}`);
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Отправить приглашение';
      }
    });

    modal.append(header, form);
    overlay.append(modal);
    this.inviteModalHost.replaceChildren(overlay);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.refreshTimer !== null) window.clearInterval(this.refreshTimer);
    if (this.channel) void supabase.removeChannel(this.channel);
    this.channel = null;
  }
}

function derivePresence(presence: OperatorStatus | null): { key: string; label: string } {
  if (!presence) return { key: 'offline', label: 'Оффлайн' };
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
