export type ElementChild = Node | string | null | undefined;

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  children: ElementChild[] = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  appendChildren(node, children);
  return node;
}

export function appendChildren(parent: Node, children: ElementChild[]): void {
  for (const child of children) {
    if (child === null || child === undefined) continue;
    parent.appendChild(child instanceof Node ? child : document.createTextNode(child));
  }
}

export type IconName =
  | 'grid' | 'users' | 'clock' | 'orders' | 'template' | 'settings' | 'logout' | 'refresh'
  | 'chevron' | 'bolt' | 'search' | 'filter' | 'close' | 'user' | 'wallet' | 'calendar'
  | 'arrow-left' | 'check' | 'alert' | 'arrow-down' | 'arrow-up';

export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const shapes: Record<IconName, Array<[string, Record<string, string>]>> = {
    grid: [['rect', { x: '3', y: '3', width: '7', height: '7', rx: '1' }], ['rect', { x: '14', y: '3', width: '7', height: '7', rx: '1' }], ['rect', { x: '3', y: '14', width: '7', height: '7', rx: '1' }], ['rect', { x: '14', y: '14', width: '7', height: '7', rx: '1' }]],
    users: [['path', { d: 'M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2' }], ['circle', { cx: '10', cy: '7', r: '4' }], ['path', { d: 'M20 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75' }]],
    clock: [['circle', { cx: '12', cy: '12', r: '9' }], ['path', { d: 'M12 7v5l3 2' }]],
    orders: [['path', { d: 'M4 4h16v16H4z' }], ['path', { d: 'M8 8h8M8 12h8M8 16h5' }]],
    template: [['path', { d: 'M4 5h16M4 12h16M4 19h16' }], ['circle', { cx: '8', cy: '5', r: '1' }], ['circle', { cx: '15', cy: '12', r: '1' }]],
    settings: [['circle', { cx: '12', cy: '12', r: '3' }], ['path', { d: 'm19.4 15 .1.1 1.4 1.1-1.4 2.4-1.7-.7a8 8 0 0 1-1.8 1l-.3 1.8h-2.8l-.3-1.8a8 8 0 0 1-1.8-1l-1.7.7-1.4-2.4 1.4-1.1a8 8 0 0 1 0-2l-1.4-1.1 1.4-2.4 1.7.7a8 8 0 0 1 1.8-1l.3-1.8h2.8l.3 1.8a8 8 0 0 1 1.8 1l1.7-.7 1.4 2.4-1.4 1.1a8 8 0 0 1 0 2Z' }]],
    logout: [['path', { d: 'M10 17l5-5-5-5M15 12H3' }], ['path', { d: 'M12 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6' }]],
    refresh: [['path', { d: 'M20 7v5h-5M4 17v-5h5' }], ['path', { d: 'M5.6 9A7 7 0 0 1 18 6l2 2M4 16l2 2a7 7 0 0 0 12.4-3' }]],
    chevron: [['path', { d: 'm9 18 6-6-6-6' }]],
    bolt: [['path', { d: 'm13 2-3 8h7l-7 12 2-9H5l8-11Z' }]],
    search: [['circle', { cx: '11', cy: '11', r: '7' }], ['path', { d: 'm20 20-3.5-3.5' }]],
    filter: [['path', { d: 'M4 5h16l-6 7v6l-4 2v-8L4 5Z' }]],
    close: [['path', { d: 'M6 6l12 12M18 6 6 18' }]],
    user: [['circle', { cx: '12', cy: '8', r: '4' }], ['path', { d: 'M4 21a8 8 0 0 1 16 0' }]],
    wallet: [['rect', { x: '3', y: '6', width: '18', height: '13', rx: '2' }], ['path', { d: 'M3 10h18M16 14h2' }]],
    calendar: [['rect', { x: '3', y: '5', width: '18', height: '16', rx: '2' }], ['path', { d: 'M8 3v4M16 3v4M3 11h18' }]],
    'arrow-left': [['path', { d: 'M19 12H5M11 18l-6-6 6-6' }]],
    check: [['path', { d: 'm5 13 4 4L19 7' }]],
    alert: [['path', { d: 'M12 3 2 20h20L12 3Z' }], ['path', { d: 'M12 9v5M12 17h.01' }]],
    'arrow-down': [['path', { d: 'M12 5v14M5 12l7 7 7-7' }]],
    'arrow-up': [['path', { d: 'M12 19V5M5 12l7-7 7 7' }]]
  };
  for (const [tag, attributes] of shapes[name]) {
    const shape = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [attribute, value] of Object.entries(attributes)) shape.setAttribute(attribute, value);
    svg.append(shape);
  }
  svg.classList.add('icon');
  return svg;
}

export function createButton(label: string, className: string, iconName?: IconName): HTMLButtonElement {
  const button = element('button', className);
  button.type = 'button';
  if (iconName) button.append(icon(iconName));
  if (label) button.append(document.createTextNode(label));
  return button;
}

export function createNotice(kind: 'error' | 'info' | 'success', message: string): HTMLDivElement {
  const notice = element('div', 'notice notice-' + kind);
  notice.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  notice.textContent = message;
  return notice;
}

export function createSkeleton(lines = 3): HTMLElement {
  const group = element('div', 'skeleton-group');
  for (let index = 0; index < lines; index += 1) {
    const line = element('div', 'skeleton-line' + (index === 0 ? ' skeleton-line-wide' : ''));
    group.append(line);
  }
  return group;
}

export function createEmptyState(title: string, description: string): HTMLElement {
  const box = element('div', 'empty-state');
  box.append(element('span', 'empty-mark', ['—']), element('strong', '', [title]), element('p', '', [description]));
  return box;
}

export interface SelectOption { value: string; label: string; }

export function createSelect(
  options: readonly SelectOption[],
  value: string,
  onChange: (next: string) => void,
  className = 'select-input'
): HTMLSelectElement {
  const select = element('select', className);
  for (const option of options) {
    const node = element('option', '', [option.label]);
    node.value = option.value;
    select.append(node);
  }
  select.value = value;
  select.addEventListener('change', () => onChange(select.value));
  return select;
}

export function createField(label: string, control: HTMLElement): HTMLLabelElement {
  const field = element('label', 'filter-field');
  field.append(element('span', 'filter-label', [label]), control);
  return field;
}

export interface SegmentedOption { value: string; label: string; }

export function createSegmented(
  options: readonly SegmentedOption[],
  active: string,
  onSelect: (next: string) => void,
  className = 'segmented'
): HTMLElement {
  const group = element('div', className);
  for (const option of options) {
    const button = createButton(option.label, 'segmented-item' + (option.value === active ? ' segmented-item-active' : ''));
    button.dataset.value = option.value;
    button.setAttribute('aria-pressed', String(option.value === active));
    button.addEventListener('click', () => onSelect(option.value));
    group.append(button);
  }
  return group;
}

export function badge(text: string, kind: string): HTMLSpanElement {
  return element('span', 'badge badge-' + kind, [text]);
}

export function formatDate(value: string | null | undefined, options: Intl.DateTimeFormatOptions = {}): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', ...options
  }).format(date);
}

export function formatDateTimeFull(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).format(date);
}

export function formatDateOnly(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' }).format(date);
}

export function formatDuration(startTime: string, endTime: string | null): string {
  const start = new Date(startTime).getTime();
  const end = endTime ? new Date(endTime).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '—';
  const minutes = Math.floor((end - start) / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? hours + ' ч ' + String(minutes % 60).padStart(2, '0') + ' мин' : minutes + ' мин';
}

export function initialsOf(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase() ?? '').join('') || 'FP';
}
