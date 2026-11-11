import { AuthService, type AuthState } from '@/lib/auth';
import { getErrorMessage } from '@/lib/errors';
import { createButton, createNotice, element, icon, type IconName } from '@/components/ui';
import { renderLogin } from '@/features/auth/login-view';
import { renderOverview } from '@/features/overview/view';
import { FinancePage } from '@/features/finance/view';
import { OrdersPage } from '@/features/orders/view';
import { ShiftHistoryPage } from '@/features/shifts/view';
import { TeamPage } from '@/features/team/view';
import { getRouteTitle, parseRoute, routeKey, type DashboardRoute, type RouteTarget } from './router';

export class DashboardApp {
  private readonly root: HTMLElement;
  private readonly auth = new AuthService();
  private authState: AuthState = { status: 'loading' };
  private unsubscribeAuth: (() => void) | null = null;
  private currentPage: { destroy(): void } | null = null;
  private currentRouteKey: string | null = null;
  private activeUserId: string | null = null;
  private mainContent: HTMLElement | null = null;
  private mobileSidebar: HTMLElement | null = null;
  private mobileOverlay: HTMLButtonElement | null = null;
  private mobileButton: HTMLButtonElement | null = null;
  private routeHandler = () => this.handleRouteChange();

  constructor(root: HTMLElement) {
    this.root = root;
  }

  async start(): Promise<void> {
    this.unsubscribeAuth = this.auth.subscribe(state => {
      this.authState = state;
      this.renderAuthState();
    });
    window.addEventListener('hashchange', this.routeHandler);
    try {
      await this.auth.initialize();
    } catch (error) {
      this.renderFatalError(getErrorMessage(error));
    }
  }

  private renderAuthState(): void {
    const state = this.authState;
    if (state.status === 'active') {
      if (this.activeUserId !== state.user.id) this.mountDashboard(state.profile.display_name, state.profile.role, state.user.id);
      else this.handleRouteChange();
      return;
    }

    this.destroyCurrentPage();
    this.activeUserId = null;
    this.currentRouteKey = null;
    this.mainContent = null;
    this.mobileSidebar = null;
    this.mobileOverlay = null;
    this.mobileButton = null;

    if (state.status === 'loading') {
      const loading = element('main', 'auth-loading');
      loading.append(element('div', 'loading-orb'), element('span', '', ['Проверяем сессию…']));
      this.root.replaceChildren(loading);
    } else if (state.status === 'inactive') {
      this.renderAccessBlocked('Профиль команды не найден или отключён. Попросите владельца проверить доступ.', 'inactive');
    } else if (state.status === 'profile-error') {
      this.renderAccessBlocked(`Не удалось проверить профиль: ${state.message}`, 'profile-error');
    } else {
      renderLogin(this.root, this.auth);
    }
  }

  private mountDashboard(displayName: string, role: string, userId: string): void {
    this.destroyCurrentPage();
    this.activeUserId = userId;
    const shell = element('div', 'app-shell');
    const sidebar = element('aside', 'sidebar');
    this.mobileSidebar = sidebar;

    const brand = element('a', 'brand-lockup');
    brand.href = '#/overview';
    const mark = element('span', 'brand-mark');
    mark.append(icon('bolt'));
    brand.append(mark, element('span', 'brand-copy', [element('strong', '', ['FANPAY']), element('small', '', ['TEAM DASHBOARD'])]));
    sidebar.append(brand);

    const workspace = element('div', 'workspace-switcher');
    workspace.append(element('span', 'workspace-icon', ['F']), element('span', 'workspace-meta', [element('small', '', ['WORKSPACE']), element('strong', '', ['Команда FunPay'])]), element('span', 'workspace-chevron', ['⌄']));
    sidebar.append(workspace);

    const nav = element('nav', 'side-navigation');
    nav.setAttribute('aria-label', 'Основная навигация');
    nav.append(element('span', 'nav-section-label', ['РАБОЧЕЕ ПРОСТРАНСТВО']));
    nav.append(this.createNavItem('overview', 'Обзор', 'grid'));
    nav.append(this.createNavItem('team', 'Команда', 'users'));
    nav.append(this.createNavItem('shifts', 'История смен', 'clock'));
    nav.append(this.createNavItem('orders', 'Заказы', 'orders'));
    nav.append(this.createNavItem('finance', 'Финансы', 'wallet'));
    nav.append(element('span', 'nav-section-label nav-section-spaced', ['ПЛАНИРУЕТСЯ']));
    nav.append(this.createDisabledNavItem('Шаблоны', 'template'));
    nav.append(element('span', 'sidebar-spacer'));
    nav.append(this.createDisabledNavItem('Настройки команды', 'settings'));
    sidebar.append(nav);

    const sidebarFooter = element('div', 'sidebar-footer');
    const avatar = element('span', 'profile-avatar', [initials(displayName)]);
    const userMeta = element('span', 'profile-meta', [element('strong', '', [displayName]), element('small', '', [role === 'owner' ? 'Владелец команды' : 'Оператор'])]);
    const logout = createButton('Выйти', 'icon-button logout-button', 'logout');
    logout.title = 'Выйти из аккаунта';
    logout.setAttribute('aria-label', 'Выйти из аккаунта');
    logout.addEventListener('click', () => void this.handleSignOut());
    sidebarFooter.append(avatar, userMeta, logout);
    sidebar.append(sidebarFooter);

    this.mobileOverlay = element('button', 'sidebar-overlay');
    this.mobileOverlay.type = 'button';
    this.mobileOverlay.setAttribute('aria-label', 'Закрыть меню');
    this.mobileOverlay.addEventListener('click', () => this.closeMobileSidebar());

    const workspaceMain = element('div', 'workspace-main');
    const topbar = element('header', 'topbar');
    const topLeft = element('div', 'topbar-left');
    this.mobileButton = createButton('Меню', 'icon-button mobile-menu-button');
    this.mobileButton.setAttribute('aria-label', 'Открыть меню');
    this.mobileButton.addEventListener('click', () => this.openMobileSidebar());
    topLeft.append(this.mobileButton, element('div', 'breadcrumbs', [element('span', '', ['Workspace']), element('span', 'breadcrumb-separator', ['/']), element('strong', 'breadcrumb-current', [getRouteTitle(parseRoute(window.location.hash).route)])]));
    const topRight = element('div', 'topbar-right');
    topRight.append(element('span', 'environment-chip', [element('span', 'environment-dot'), 'Защищённое соединение']));
    topbar.append(topLeft, topRight);

    const main = element('main', 'main-content');
    this.mainContent = main;
    workspaceMain.append(topbar, main);
    shell.append(sidebar, this.mobileOverlay, workspaceMain);
    this.root.replaceChildren(shell);
    this.renderRoute(parseRoute(window.location.hash));
  }

  private createNavItem(route: DashboardRoute, label: string, iconName: IconName): HTMLAnchorElement {
    const link = element('a', 'nav-item');
    link.href = `#/${route}`;
    link.dataset.route = route;
    link.append(icon(iconName), element('span', '', [label]), element('span', 'nav-active-marker'));
    link.addEventListener('click', () => this.closeMobileSidebar());
    return link;
  }

  private createDisabledNavItem(label: string, iconName: 'clock' | 'orders' | 'template' | 'settings'): HTMLDivElement {
    const item = element('div', 'nav-item nav-item-disabled');
    item.append(icon(iconName), element('span', '', [label]), element('span', 'nav-coming-soon', ['Скоро']));
    return item;
  }

  private handleRouteChange(): void {
    if (this.authState.status !== 'active' || !this.mainContent) return;
    const target = parseRoute(window.location.hash);
    // Нормализуем только «голый» неизвестный маршрут: путь детализации и query-параметры фильтров сохраняем.
    if (!target.segments.length && !target.params.toString()) {
      const normalized = `#/${target.route}`;
      if (window.location.hash !== normalized) {
        window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${normalized}`);
      }
    }
    this.renderRoute(target);
  }

  private renderRoute(target: RouteTarget): void {
    if (!this.mainContent) return;
    const key = routeKey(target);
    if (this.currentRouteKey === key) return;
    this.destroyCurrentPage();
    this.currentRouteKey = key;
    const main = this.mainContent;
    main.replaceChildren();
    document.querySelectorAll<HTMLAnchorElement>('.nav-item[data-route]').forEach(link => {
      const active = link.dataset.route === target.route;
      link.classList.toggle('nav-item-active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    const breadcrumb = document.querySelector('.breadcrumb-current');
    if (breadcrumb) breadcrumb.textContent = getRouteTitle(target.route);

    switch (target.route) {
      case 'team':
        this.currentPage = new TeamPage(main);
        break;
      case 'shifts':
        this.currentPage = new ShiftHistoryPage(main, { detailShiftId: target.segments[0] ?? null });
        break;
      case 'orders':
        this.currentPage = new OrdersPage(main, {
          orderRef: target.segments.length >= 2 ? { sellerAccountId: target.segments[0], orderId: target.segments[1] } : null,
          params: target.params
        });
        break;
      case 'finance':
        this.currentPage = new FinancePage(main);
        break;
      default:
        this.currentPage = null;
        this.renderOverviewRoute();
        break;
    }
  }

  private renderOverviewRoute(): void {
    if (!this.mainContent) return;
    renderOverview(this.mainContent, () => this.renderOverviewRoute());
  }

  private openMobileSidebar(): void {
    this.mobileSidebar?.classList.add('sidebar-open');
    this.mobileOverlay?.classList.add('overlay-visible');
    this.mobileButton?.setAttribute('aria-expanded', 'true');
  }

  private closeMobileSidebar(): void {
    this.mobileSidebar?.classList.remove('sidebar-open');
    this.mobileOverlay?.classList.remove('overlay-visible');
    this.mobileButton?.setAttribute('aria-expanded', 'false');
  }

  private async handleSignOut(): Promise<void> {
    try {
      await this.auth.signOut();
      window.location.hash = '#/login';
    } catch (error) {
      this.renderFatalError(`Не удалось завершить сессию: ${getErrorMessage(error)}`);
    }
  }

  private renderAccessBlocked(message: string, state: 'inactive' | 'profile-error'): void {
    const page = element('main', 'access-page');
    const card = element('section', 'access-card');
    card.append(element('span', 'brand-mark', [state === 'inactive' ? '!' : '…']), element('h1', '', [state === 'inactive' ? 'Нет доступа к команде' : 'Не удалось проверить доступ']), createNotice(state === 'inactive' ? 'info' : 'error', message));
    const actions = element('div', 'access-actions');
    if (state === 'profile-error') {
      const retry = createButton('Повторить проверку', 'button button-primary', 'refresh');
      retry.addEventListener('click', () => window.location.reload());
      actions.append(retry);
    }
    const logout = createButton('Вернуться ко входу', 'button button-secondary');
    logout.addEventListener('click', () => void this.handleSignOut());
    actions.append(logout);
    card.append(actions);
    page.append(card);
    this.root.replaceChildren(page);
  }

  private renderFatalError(message: string): void {
    const page = element('main', 'access-page');
    page.append(createNotice('error', message));
    this.root.replaceChildren(page);
  }

  private destroyCurrentPage(): void {
    this.currentPage?.destroy();
    this.currentPage = null;
    this.currentRouteKey = null;
  }

  destroy(): void {
    this.destroyCurrentPage();
    this.unsubscribeAuth?.();
    this.auth.dispose();
    window.removeEventListener('hashchange', this.routeHandler);
  }
}

function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase() ?? '').join('') || 'FP';
}
