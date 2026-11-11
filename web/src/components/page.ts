import { appendChildren, element, type ElementChild } from './ui';

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

/** Собирает таблицу со строкой заголовков и телом; прокрутка по горизонтали уже в CSS. */
export function createTable(headers: readonly string[], rows: readonly HTMLElement[], minWidthClass = ''): HTMLElement {
  const wrap = element('div', 'table-scroll');
  const table = element('table', 'data-table ' + minWidthClass);
  const thead = element('thead');
  const headerRow = element('tr');
  for (const title of headers) headerRow.append(element('th', '', [title]));
  thead.append(headerRow);
  const tbody = element('tbody');
  for (const row of rows) tbody.append(row);
  table.append(thead, tbody);
  wrap.append(table);
  return wrap;
}
