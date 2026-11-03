import { AppSettings, Template } from '../shared/types';
import { FunPayDomAdapter } from './adapter';
import { substituteVariables, debugLog } from '../shared/utils';

export class HotkeyManager {
  private templates: Template[] = [];
  private settings: AppSettings | null = null;
  private isListening = false;

  constructor() {
    this.handleKeyDown = this.handleKeyDown.bind(this);
  }

  public updateData(templates: Template[], settings: AppSettings) {
    this.templates = templates;
    this.settings = settings;

    // By default, always listen if hotkeys are enabled
    if (settings.hotkeysEnabled && !this.isListening) {
      this.startListening();
    } else if (!settings.hotkeysEnabled && this.isListening) {
      this.stopListening();
    }
  }

  public startListening() {
    if (this.isListening) return;
    window.addEventListener('keydown', this.handleKeyDown, true);
    document.addEventListener('keydown', this.handleKeyDown, true);
    this.isListening = true;
    debugLog(this.settings?.developerMode ?? false, 'Hotkey listener started');
  }

  public stopListening() {
    if (!this.isListening) return;
    window.removeEventListener('keydown', this.handleKeyDown, true);
    document.removeEventListener('keydown', this.handleKeyDown, true);
    this.isListening = false;
    debugLog(this.settings?.developerMode ?? false, 'Hotkey listener stopped');
  }

  private normalizeEventKey(e: KeyboardEvent): string {
    const parts: string[] = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey && !e.key.startsWith('F')) parts.push('Shift');

    // Handle Function keys F1-F12
    if (/^F\d+$/i.test(e.key)) {
      parts.push(e.key.toUpperCase());
    } else if (e.key !== 'Control' && e.key !== 'Alt' && e.key !== 'Shift') {
      parts.push(e.key.toUpperCase());
    }

    return parts.join('+');
  }

  private handleKeyDown(e: KeyboardEvent) {
    // If hotkeys are globally disabled in settings, do nothing
    if (this.settings && !this.settings.hotkeysEnabled) return;

    const keyCombo = this.normalizeEventKey(e);
    if (!keyCombo) return;

    // Check if key is a Function key (F1-F12)
    const isFunctionKey = /^F[1-9]$|^F1[0-2]$/i.test(keyCombo);

    // Search matching template:
    // 1. Try matching within active profile (or common profile)
    const activeProfileId = this.settings?.selectedProfileId;
    let match = this.templates.find(
      t => t.enabled &&
           (t.profileId === activeProfileId || t.profileId === 'profile-common') &&
           t.hotkey.trim().toUpperCase() === keyCombo.trim().toUpperCase()
    );

    // 2. If not found in active profile, try any enabled template
    if (!match) {
      match = this.templates.find(
        t => t.enabled && t.hotkey.trim().toUpperCase() === keyCombo.trim().toUpperCase()
      );
    }

    if (match) {
      // PREVENT BROWSER DEFAULT IMMEDIATELY (e.g. Chrome F1 help!)
      e.preventDefault();
      e.stopPropagation();

      const orderData = FunPayDomAdapter.findCurrentOrder();
      const currentUser = FunPayDomAdapter.getCurrentUser();

      const variables: Record<string, string | null | undefined> = {
        username: currentUser,
        order_id: orderData.id,
        product: orderData.product,
        amount: orderData.amount,
        buyer: orderData.buyer
      };

      const finalMessage = substituteVariables(match.text, variables);
      const inserted = FunPayDomAdapter.insertMessage(finalMessage);

      // If no input was found on page, copy to clipboard so user still gets their text
      if (!inserted && navigator.clipboard) {
        navigator.clipboard.writeText(finalMessage).catch(() => {});
      }

      debugLog(
        this.settings?.developerMode ?? false,
        `Hotkey ${keyCombo} triggered template: "${match.name}", inserted: ${inserted}`
      );

      this.showToastNotification(inserted ? `⚡ Вставлен: ${match.name}` : `📋 Скопировано в буфер: ${match.name}`);
    } else if (keyCombo === 'F1') {
      // Suppress browser default only for F1 so it doesn't open Chrome Help
      e.preventDefault();
    }
  }

  private showToastNotification(text: string) {
    const existing = document.getElementById('fphk-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'fphk-toast';
    toast.className = 'fphk-toast';
    toast.textContent = text;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('fphk-toast-fadeout');
      setTimeout(() => toast.remove(), 300);
    }, 1800);
  }
}
