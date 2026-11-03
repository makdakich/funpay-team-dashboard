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
  private isMouseDown = false;
  private isDragging = false;
  private justDragged = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragStartLeft = 0;
  private dragStartTop = 0;
  private initialLeft = 20;
  private initialTop = 140;

  // Global window listener references
  private windowListenersAttached = false;
  private onMouseMoveBound = (e: MouseEvent) => this.handleMouseMove(e);
  private onMouseUpBound = () => this.handleMouseUp();

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

    this.ensureWindowListeners();
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
    if (this.windowListenersAttached) {
      window.removeEventListener('mousemove', this.onMouseMoveBound, true);
      window.removeEventListener('mouseup', this.onMouseUpBound, true);
      this.windowListenersAttached = false;
    }
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

    this.ensureWindowListeners();

    // Always create floating draggable container attached to body (NEVER insert into chat!)
    this.container = document.createElement('div');
    this.container.id = 'fphk-panel-root';
    this.container.className = `fphk-panel fphk-floating ${this.isCollapsed ? 'fphk-collapsed' : ''}`;

    // Apply clamped position with boundary protection
    const maxLeft = Math.max(10, window.innerWidth - (this.isCollapsed ? 140 : 320) - 10);
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
        <div class="fphk-toggle-btn" id="fphk-panel-toggle-btn" role="button" tabindex="0" title="Развернуть FanPay Hotkeys (нажмите чтобы открыть)">
          <span class="fphk-bolt">⚡</span>
          <span class="fphk-badge-mini">Hotkeys</span>
          <button type="button" class="fphk-expand-icon-btn" id="fphk-btn-panel-expand" title="Развернуть">⛶</button>
        </div>
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

  public expand() {
    this.isCollapsed = false;
    this.savePosition();
    this.render();
  }

  public collapse() {
    this.isCollapsed = true;
    this.savePosition();
    this.render();
  }

  private bindEvents() {
    if (!this.container) return;

    if (this.isCollapsed) {
      // Direct click listener on toggle pill
      const togglePill = this.container.querySelector<HTMLElement>('#fphk-panel-toggle-btn');
      if (togglePill) {
        togglePill.addEventListener('click', (e) => {
          e.stopPropagation();
          if (this.justDragged) {
            this.justDragged = false;
            return;
          }
          this.expand();
        });
      }

      // Direct click listener on ⛶ expand icon button
      const expandBtn = this.container.querySelector<HTMLElement>('#fphk-btn-panel-expand');
      if (expandBtn) {
        expandBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.expand();
        });
      }
    } else {
      // Profile selector
      const selectEl = this.container.querySelector<HTMLSelectElement>('.fphk-profile-select');
      selectEl?.addEventListener('change', (e) => {
        const newProfileId = (e.target as HTMLSelectElement).value;
        if (this.onProfileChangeCallback) {
          this.onProfileChangeCallback(newProfileId);
        }
      });

      // Collapse button (—)
      this.container.querySelector('.fphk-collapse-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.collapse();
      });

      // Settings button (⚙️)
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

  private ensureWindowListeners() {
    if (!this.windowListenersAttached) {
      window.addEventListener('mousemove', this.onMouseMoveBound, true);
      window.addEventListener('mouseup', this.onMouseUpBound, true);
      this.windowListenersAttached = true;
    }
  }

  private attachDragEvents() {
    if (!this.container) return;

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return; // Only primary mouse button

      const target = e.target as HTMLElement;

      if (!this.isCollapsed) {
        const header = target.closest('#fphk-panel-drag-handle');
        if (!header) return;
        // Don't drag if clicking buttons or select inside header
        if (target.closest('button') || target.closest('select') || target.closest('input')) return;
      } else {
        // In collapsed mode: clicking anywhere on the pill or wrapper allows dragging
        const pill = target.closest('#fphk-panel-toggle-btn') || target.closest('#fphk-panel-root');
        if (!pill) return;
      }

      this.isMouseDown = true;
      this.isDragging = false;
      this.justDragged = false;
      this.dragStartX = e.clientX;
      this.dragStartY = e.clientY;
      const rect = this.container!.getBoundingClientRect();
      this.dragStartLeft = rect.left;
      this.dragStartTop = rect.top;
      // CRITICAL: NEVER call e.preventDefault() here! Allow native click events to fire freely!
    };

    this.container.addEventListener('mousedown', onMouseDown);
  }

  private handleMouseMove(e: MouseEvent) {
    if (!this.isMouseDown || !this.container) return;

    const dx = e.clientX - this.dragStartX;
    const dy = e.clientY - this.dragStartY;

    if (!this.isDragging) {
      if (Math.abs(dx) > 6 || Math.abs(dy) > 6) {
        this.isDragging = true;
      }
    }

    if (this.isDragging) {
      e.preventDefault(); // Now we are truly dragging, prevent text selection

      const maxLeft = Math.max(10, window.innerWidth - this.container.offsetWidth - 10);
      const maxTop = Math.max(10, window.innerHeight - this.container.offsetHeight - 10);

      const newLeft = Math.max(10, Math.min(maxLeft, this.dragStartLeft + dx));
      const newTop = Math.max(10, Math.min(maxTop, this.dragStartTop + dy));

      this.container.style.left = `${newLeft}px`;
      this.container.style.top = `${newTop}px`;
      this.container.style.right = 'auto';
      this.container.style.bottom = 'auto';
    }
  }

  private handleMouseUp() {
    if (!this.isMouseDown) return;
    this.isMouseDown = false;

    if (this.isDragging) {
      this.isDragging = false;
      this.justDragged = true;
      setTimeout(() => {
        this.justDragged = false;
      }, 150);
      this.savePosition();
    } else {
      this.justDragged = false;
    }
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
