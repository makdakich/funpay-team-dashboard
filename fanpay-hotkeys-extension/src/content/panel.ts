import { AppSettings, Profile, Template } from '../shared/types';
import { FunPayDomAdapter } from './adapter';
import { substituteVariables } from '../shared/utils';

export class FunPayPanel {
  private container: HTMLElement | null = null;
  private profiles: Profile[] = [];
  private templates: Template[] = [];
  private settings: AppSettings | null = null;
  private isCollapsed = false;
  private onProfileChangeCallback?: (profileId: string) => void;

  public init(
    profiles: Profile[],
    templates: Template[],
    settings: AppSettings,
    onProfileChange: (profileId: string) => void
  ) {
    this.profiles = profiles;
    this.templates = templates;
    this.settings = settings;
    this.onProfileChangeCallback = onProfileChange;
    this.isCollapsed = !settings.panelVisible;

    this.render();
  }

  public update(profiles: Profile[], templates: Template[], settings: AppSettings) {
    this.profiles = profiles;
    this.templates = templates;
    this.settings = settings;
    this.render();
  }

  public destroy() {
    if (this.container) {
      this.container.remove();
      this.container = null;
    }
  }

  public render() {
    if (this.container) {
      this.container.remove();
    }

    const hostChat = FunPayDomAdapter.findCurrentChat();
    // Create panel wrapper
    this.container = document.createElement('div');
    this.container.id = 'fphk-panel-root';
    this.container.className = `fphk-panel ${this.isCollapsed ? 'fphk-collapsed' : ''}`;

    if (this.isCollapsed) {
      this.container.innerHTML = `
        <button class="fphk-toggle-btn" title="Развернуть FanPay Hotkeys">
          <span class="fphk-icon">⚡</span>
          <span class="fphk-badge-mini">Hotkeys</span>
        </button>
      `;
      this.container.querySelector('.fphk-toggle-btn')?.addEventListener('click', () => {
        this.isCollapsed = false;
        this.saveCollapsedState(true);
        this.render();
      });
    } else {
      const activeProfileId = this.settings?.selectedProfileId || this.profiles[0]?.id;
      const activeProfile = this.profiles.find(p => p.id === activeProfileId) || this.profiles[0];

      // Filter templates for active profile and common profile
      const activeTemplates = this.templates.filter(
        t => t.enabled && (t.profileId === activeProfileId || t.profileId === 'profile-common')
      ).sort((a, b) => a.sortOrder - b.sortOrder);

      const profileOptions = this.profiles
        .map(p => `<option value="${p.id}" ${p.id === activeProfileId ? 'selected' : ''}>${p.name}</option>`)
        .join('');

      let buttonsHtml = '';
      if (activeTemplates.length === 0) {
        buttonsHtml = `<div class="fphk-empty-msg">Нет активных шаблонов для профиля</div>`;
      } else {
        buttonsHtml = activeTemplates.map(t => `
          <button class="fphk-template-btn" data-id="${t.id}" title="${this.escapeHtml(t.text)}">
            ${t.hotkey ? `<span class="fphk-key-tag">${t.hotkey}</span>` : ''}
            <span class="fphk-btn-label">${this.escapeHtml(t.name)}</span>
          </button>
        `).join('');
      }

      this.container.innerHTML = `
        <div class="fphk-panel-header">
          <div class="fphk-panel-title">
            <span class="fphk-bolt">⚡</span>
            <span>FanPay Hotkeys</span>
          </div>
          <div class="fphk-header-actions">
            <button class="fphk-icon-btn fphk-settings-btn" title="Открыть настройки">⚙️</button>
            <button class="fphk-icon-btn fphk-collapse-btn" title="Свернуть">✕</button>
          </div>
        </div>

        <div class="fphk-panel-toolbar">
          <label class="fphk-profile-label">Профиль:</label>
          <select class="fphk-profile-select">
            ${profileOptions}
          </select>
        </div>

        <div class="fphk-buttons-grid">
          ${buttonsHtml}
        </div>
      `;

      // Event Listeners
      const selectEl = this.container.querySelector<HTMLSelectElement>('.fphk-profile-select');
      selectEl?.addEventListener('change', (e) => {
        const newProfileId = (e.target as HTMLSelectElement).value;
        if (this.onProfileChangeCallback) {
          this.onProfileChangeCallback(newProfileId);
        }
      });

      this.container.querySelector('.fphk-collapse-btn')?.addEventListener('click', () => {
        this.isCollapsed = true;
        this.saveCollapsedState(false);
        this.render();
      });

      this.container.querySelector('.fphk-settings-btn')?.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' });
      });

      // Template click handlers
      const btns = this.container.querySelectorAll<HTMLButtonElement>('.fphk-template-btn');
      btns.forEach(btn => {
        btn.addEventListener('click', () => {
          const tmplId = btn.getAttribute('data-id');
          const tmpl = this.templates.find(t => t.id === tmplId);
          if (tmpl) {
            this.handleTemplateClick(tmpl);
          }
        });
      });
    }

    // Try to dock above chat form, or fallback to fixed position
    const chatForm = hostChat?.querySelector('.chat-form, form');
    if (chatForm && chatForm.parentNode && this.settings?.panelDocked) {
      chatForm.parentNode.insertBefore(this.container, chatForm);
      this.container.classList.add('fphk-docked');
    } else {
      document.body.appendChild(this.container);
      this.container.classList.add('fphk-floating');
    }
  }

  private handleTemplateClick(tmpl: Template) {
    const orderData = FunPayDomAdapter.findCurrentOrder();
    const currentUser = FunPayDomAdapter.getCurrentUser();

    const variables: Record<string, string | null | undefined> = {
      username: currentUser,
      order_id: orderData.id,
      product: orderData.product,
      amount: orderData.amount,
      buyer: orderData.buyer
    };

    const textToInsert = substituteVariables(tmpl.text, variables);
    const success = FunPayDomAdapter.insertMessage(textToInsert);

    if (success) {
      this.flashStatus(`Вставлено: ${tmpl.name}`);
    } else {
      this.flashStatus('Поле сообщения не найдено');
    }
  }

  private flashStatus(text: string) {
    const headerTitle = this.container?.querySelector('.fphk-panel-title span:last-child');
    if (headerTitle) {
      const original = headerTitle.textContent;
      headerTitle.textContent = text;
      setTimeout(() => {
        if (headerTitle) headerTitle.textContent = original;
      }, 1200);
    }
  }

  private saveCollapsedState(visible: boolean) {
    chrome.runtime.sendMessage({
      type: 'UPDATE_SETTINGS',
      payload: { panelVisible: visible }
    });
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
