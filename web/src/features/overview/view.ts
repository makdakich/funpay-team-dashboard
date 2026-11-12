import type { OverviewData } from '@/types/database';
import { CURRENCIES, CURRENCY_SYMBOLS, formatCurrency } from './metrics';
import { createButton, createNotice, createSkeleton, element, formatDate, icon, pluralize } from '@/components/ui';
import { getErrorMessage } from '@/lib/errors';
import { loadOverview } from './data';

export function renderOverview(container: HTMLElement, onRefresh: () => void): void {
  const page = element('section', 'page-stack');
  const heading = element('div', 'page-heading');
  const copy = element('div');
  copy.append(element('div', 'eyebrow', ['КОМАНДА · V2.4']), element('h1', '', ['Обзор']), element('p', 'page-description', ['Сводка по участникам, сменам и подтверждённым сделкам.']));
  const refresh = createButton('Обновить', 'button button-secondary', 'refresh');
  refresh.addEventListener('click', onRefresh);
  heading.append(copy, refresh);

  const content = element('div', 'page-content');
  content.append(createSkeleton(5));
  page.append(heading, content);
  container.replaceChildren(page);

  void loadOverview().then(data => {
    content.replaceChildren(buildOverview(data));
  }).catch(error => {
    content.replaceChildren(createNotice('error', `Не удалось загрузить обзор: ${getErrorMessage(error)}`));
    const retry = createButton('Повторить запрос', 'button button-secondary', 'refresh');
    retry.style.justifySelf = 'start';
    retry.addEventListener('click', onRefresh);
    content.append(retry);
  });
}

export function buildOverview(data: OverviewData): HTMLElement {
  const stack = element('div', 'overview-layout');
  const kpis = element('div', 'kpi-grid');
  kpis.append(
    createKpi('Участники', String(data.activeMembers), pluralize(data.activeMembers, 'активный профиль', 'активных профиля', 'активных профилей'), 'users', 'blue'),
    createKpi('Активные смены', String(data.activeShifts), data.activeShifts === 0 ? 'нет смен в работе' : pluralize(data.activeShifts, 'смена в работе', 'смены в работе', 'смен в работе'), 'clock', 'green'),
    createKpi('Все заказы', data.totalOrders.toLocaleString('ru-RU'), `${data.closedOrders.toLocaleString('ru-RU')} закрыто`, 'orders', 'violet')
  );

  const finance = element('section', 'panel finance-panel');
  const financeHead = element('div', 'panel-heading');
  financeHead.append(element('div', '', [element('h2', '', ['Подтверждённый оборот']), element('p', 'panel-description', ['Только заказы со статусом closed · валюты не конвертируются'])]));
  financeHead.append(element('span', 'data-chip', ['10% доля']));
  finance.append(financeHead);

  if (data.closedOrders === 0) {
    finance.append(emptyState('Нет закрытых заказов', 'Подтверждённый оборот появится после синхронизации заказов со статусом closed.'));
  } else {
    const tableWrap = element('div', 'table-scroll');
    const table = element('table', 'currency-table');
    const thead = element('thead');
    const header = element('tr');
    for (const title of ['Валюта', 'Оборот closed', 'Доля оператора · 10%']) header.append(element('th', '', [title]));
    thead.append(header);
    const tbody = element('tbody');
    for (const currency of CURRENCIES) {
      const turnover = data.turnoverByCurrency[currency];
      if (turnover === 0) continue;
      const row = element('tr');
      const code = element('td', 'currency-code');
      code.append(element('span', `currency-symbol currency-${currency.toLowerCase()}`, [CURRENCY_SYMBOLS[currency]]), document.createTextNode(currency));
      row.append(code, element('td', 'numeric-cell', [formatCurrency(turnover, currency)]), element('td', 'numeric-cell share-cell', [formatCurrency(data.operatorShareByCurrency[currency], currency)]));
      tbody.append(row);
    }
    table.append(thead, tbody);
    tableWrap.append(table);
    finance.append(tableWrap);
    finance.append(element('div', 'panel-footnote', ['Оплаченные и возвращённые заказы не включены в оборот и долю.']));
  }

  const activity = element('section', 'panel activity-panel');
  const activityHeading = element('div', 'panel-heading');
  activityHeading.append(element('div', '', [element('h2', '', ['Последняя активность']), element('p', 'panel-description', ['Недавние события смен команды'])]));
  activityHeading.append(element('span', 'subtle-count', [pluralize(data.recentActivity.length, 'событие', 'события', 'событий')]));
  activity.append(activityHeading);
  if (data.recentActivity.length === 0) {
    activity.append(emptyState('Пока нет активности', 'Когда участники начнут смены, последние события появятся здесь.'));
  } else {
    const list = element('div', 'activity-list');
    for (const item of data.recentActivity) {
      const row = element('div', 'activity-row');
      const dot = element('span', `activity-marker ${item.shift.status === 'active' ? 'marker-live' : ''}`);
      const details = element('div', 'activity-details');
      details.append(element('strong', '', [item.displayName]), element('span', '', [item.shift.status === 'active' ? 'Начал смену' : 'Смена завершена']));
      row.append(dot, details, element('time', 'activity-time', [formatDate(item.shift.start_time)]));
      list.append(row);
    }
    activity.append(list);
  }

  stack.append(kpis, finance, activity);
  return stack;
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
