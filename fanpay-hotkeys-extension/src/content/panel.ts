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

  // Dragging state
  private isDragging = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private initialLeft = 20;
  private initialTop = 140;

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
    this.isCollapsed = settings.panelVisible === false;

    // Restore saved panel position
    if (settings.panelPosition) {
      if (typeof settings.panelPosition.left === 'number') this.initialLeft = settings.panelPosition.left;
      if (typeof settings.panelPosition.top === 'number') this.initialTop = settings.panelPosition.top;
    }

    this.render();
  }

  public update(profiles: Profile[], templates: Template[], settings: AppSettings) {
    this.profiles = profiles;
    this.templates = templates;
    this.settings = settings;
    if (typeof settings.panelVisible === 'boolean') {
      this.isCollapsed = !settings.panelVisible;
    }
    if (settings.panelPosition) {
      if (typeof settings.panelPosition.left === 'number') this.initialLeft = settings.panelPosition.left;
      if (typeof settings.panelPosition.top === 'number') this.initialTop = settings.panelPosition.top;
    }
    this.render();
  }

  public destroy() {
    if (this.container) {
      this.container.remove();
      this.container = null;
    }
  }

  public render() {
    // If explicitly disabled in settings, remove from DOM
    if (this.settings?.panelEnabled === false) {
      this.destroy();
      return;
    }

    if (this.container) {
      this.container.remove();
    }

    // Always create floating draggable container attached to body (NEVER insert into chat!)
    this.container = document.createElement('div');
    this.container.id = 'fphk-panel-root';
    this.container.className = `fphk-panel fphk-floating ${this.isCollapsed ? 'fphk-collapsed' : ''}`;

    // Apply clamped position with boundary protection
    const maxLeft = Math.max(10, window.innerWidth - (this.isCollapsed ? 130 : 320) - 10);
    const maxTop = Math.max(10, window.innerHeight - (this.isCollapsed ? 50 : 280) - 10);
    const left = Math.max(10, Math.min(maxLeft, this.initialLeft));
    const top = Math.max(10, Math.min(maxTop, this.initialTop));

    this.container.style.position = 'fixed';
    this.container.style.left = `${left}px`;
    this.container.style.top = `${top}px`;
    this.container.style.right = 'auto';
    this.container.style.bottom = 'auto';
    this.container.style.zIndex = '999990';

    if (this.isCollapsed) {
      this.container.innerHTML = `
        <button class="fphk-toggle-btn" id="fphk-panel-toggle-btn" title="Развернуть FanPay Hotkeys • Нажмите или перетащите">
          <span class="fphk-bolt">⚡</span>
          <span class="fphk-badge-mini">Hotkeys</span>
          <span class="fphk-expand-icon">⛶</span>
        </button>
      `;
    } else {
      const activeProfileId = this.settings?.selectedProfileId || this.profiles[0]?.id;
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
        <div class="fphk-panel-header" id="fphk-panel-drag-handle" title="Перетащите для перемещения">
          <div class="fphk-panel-title">
            <span class="fphk-bolt">⚡</span>
            <span class="fphk-panel-title-text">FanPay Hotkeys</span>
          </div>
          <div class="fphk-header-actions">
            <button class="fphk-icon-btn fphk-settings-btn" title="Открыть настройки">⚙️</button>
            <button class="fphk-icon-btn fphk-collapse-btn" title="Свернуть в мини-кнопку">—</button>
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
    }

    document.body.appendChild(this.container);

    this.bindEvents();
    this.attachDragEvents();
  }

  private bindEvents() {
    if (!this.container) return;

    if (!this.isCollapsed) {
      // Profile selector
      const selectEl = this.container.querySelector<HTMLSelectElement>('.fphk-profile-select');
      selectEl?.addEventListener('change', (e) => {
        const newProfileId = (e.target as HTMLSelectElement).value;
        if (this.onProfileChangeCallback) {
          this.onProfileChangeCallback(newProfileId);
        }
      });

      // Collapse button
      this.container.querySelector('.fphk-collapse-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.isCollapsed = true;
        this.savePosition();
        this.render();
      });

      // Settings button
      this.container.querySelector('.fphk-settings-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' });
      });

      // Template buttons
      const btns = this.container.querySelectorAll<HTMLButtonElement>('.fphk-template-btn');
      btns.forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const tmplId = btn.getAttribute('data-id');
          const tmpl = this.templates.find(t => t.id === tmplId);
          if (tmpl) {
            this.handleTemplateClick(tmpl);
          }
        });
      });
    }
  }

  private attachDragEvents() {
    if (!this.container) return;

    let hasMoved = false;

    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;

      if (!this.isCollapsed) {
        const header = target.closest('#fphk-panel-drag-handle');
        if (!header) return;
        // Don't drag if clicking buttons inside header
        if (target.closest('button')) return;
      } else {
        // In collapsed mode: whole button is draggable
        if (!target.closest('#fphk-panel-toggle-btn')) return;
      }

      this.isDragging = true;
      hasMoved = false;
      this.dragStartX = e.clientX;
      this.dragStartY = e.clientY;
      const rect = this.container!.getBoundingClientRect();
      this.initialLeft = rect.left;
      this.initialTop = rect.top;
      e.preventDefault();
    };

    this.container.addEventListener('mousedown', onMouseDown);

    const onMouseMove = (e: MouseEvent) => {
      if (!this.isDragging || !this.container) return;
      const dx = e.clientX - this.dragStartX;
      const dy = e.clientY - this.dragStartY;

      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
        hasMoved = true;
      }

      const maxLeft = Math.max(10, window.innerWidth - this.container.offsetWidth - 10);
      const maxTop = Math.max(10, window.innerHeight - this.container.offsetHeight - 10);

      const newLeft = Math.max(10, Math.min(maxLeft, this.initialLeft + dx));
      const newTop = Math.max(10, Math.min(maxTop, this.initialTop + dy));

      this.container.style.left = `${newLeft}px`;
      this.container.style.top = `${newTop}px`;
      this.container.style.right = 'auto';
      this.container.style.bottom = 'auto';
    };

    const onMouseUp = () => {
      if (this.isDragging) {
        this.isDragging = false;
        if (hasMoved) {
          this.savePosition();
        } else if (this.isCollapsed) {
          // Clicked on collapsed toggle pill without dragging -> expand!
          this.isCollapsed = false;
          this.savePosition();
          this.render();
        }
      }
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }

  private savePosition() {
    if (!this.container) return;
    const rect = this.container.getBoundingClientRect();
    const position = {
      top: Math.round(rect.top),
      left: Math.round(rect.left)
    };
    this.initialLeft = position.left;
    this.initialTop = position.top;
    chrome.runtime.sendMessage({
      type: 'UPDATE_SETTINGS',
      payload: {
        panelPosition: position,
        panelVisible: !this.isCollapsed
      }
    }).catch(() => {});
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
    const headerTitle = this.container?.querySelector('.fphk-panel-title-text');
    if (headerTitle) {
      const original = headerTitle.textContent;
      headerTitle.textContent = text;
      setTimeout(() => {
        if (headerTitle) headerTitle.textContent = original;
      }, 1200);
    }
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
