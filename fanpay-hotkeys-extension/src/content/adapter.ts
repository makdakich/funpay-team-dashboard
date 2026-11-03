/**
 * FunPay DOM Adapter
 * Robust abstraction over FunPay page elements.
 * Uses fallback selector chains and returns null if information cannot be reliably determined.
 */

export interface FunPayPageOrder {
  id: string | null;
  product: string | null;
  amount: string | null;
  buyer: string | null;
}

export class FunPayDomAdapter {
  private static INPUT_SELECTORS = [
    'textarea.chat-msg-input',
    'form.chat-form textarea',
    '.chat-form textarea',
    'textarea[name="content"]',
    '.chat textarea',
    '.chat-detail textarea',
    'form[action*="chat"] textarea',
    'textarea.form-control',
    'textarea'
  ];

  /**
   * Find the active message textarea in the chat
   */
  public static findMessageInput(): HTMLTextAreaElement | HTMLInputElement | null {
    // 1. If user has already clicked / focused into any text input or textarea, use it directly!
    const active = document.activeElement;
    if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) {
      const el = active as HTMLTextAreaElement | HTMLInputElement;
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type !== 'button' && type !== 'submit' && type !== 'checkbox' && type !== 'radio' && type !== 'file') {
        return el;
      }
    }

    // 2. Iterate through selector chain
    for (const selector of this.INPUT_SELECTORS) {
      const el = document.querySelector<HTMLTextAreaElement | HTMLInputElement>(selector);
      if (el && this.isElementVisible(el)) {
        return el;
      }
    }

    // 3. Fallback to any visible textarea on the page
    const allTextareas = document.querySelectorAll<HTMLTextAreaElement>('textarea');
    for (const ta of allTextareas) {
      if (this.isElementVisible(ta)) {
        return ta;
      }
    }

    return null;
  }

  /**
   * Find current chat container element
   */
  public static findCurrentChat(): HTMLElement | null {
    return (
      document.querySelector<HTMLElement>('.chat-detail') ||
      document.querySelector<HTMLElement>('.chat') ||
      document.querySelector<HTMLElement>('.chat-content') ||
      document.querySelector<HTMLElement>('.chat-form') ||
      document.querySelector<HTMLElement>('form[action*="chat"]') ||
      null
    );
  }

  /**
   * Safely insert text into the chat textarea at cursor position or append
   * Crucial: NEVER triggers submit or auto-sends!
   */
  public static insertMessage(text: string): boolean {
    const input = this.findMessageInput();
    if (!input) {
      return false;
    }

    input.focus();

    if ('selectionStart' in input && typeof input.selectionStart === 'number') {
      const start = input.selectionStart;
      const end = input.selectionEnd ?? start;
      const currentVal = input.value;
      const prefix = currentVal.substring(0, start);
      const suffix = currentVal.substring(end);

      // Add a space if cursor is right after existing text without trailing whitespace
      const separator = prefix.length > 0 && !/\s$/.test(prefix) ? ' ' : '';
      const newVal = prefix + separator + text + suffix;

      input.value = newVal;
      const newCursorPos = start + separator.length + text.length;
      input.setSelectionRange(newCursorPos, newCursorPos);
    } else {
      input.value = (input.value ? input.value + ' ' : '') + text;
    }

    // Dispatch input & change events for frameworks / event listeners
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));

    return true;
  }

  /**
   * Get current authenticated username from header or app data
   */
  public static getCurrentUser(): string | null {
    // 1. Check .user-link-name
    const nameEl = document.querySelector('.user-link-name');
    if (nameEl && nameEl.textContent?.trim()) {
      return nameEl.textContent.trim();
    }

    // 2. Check body data-app-data
    try {
      const bodyAppData = document.body.getAttribute('data-app-data');
      if (bodyAppData) {
        const parsed = JSON.parse(bodyAppData);
        if (parsed.userName || parsed.username) {
          return parsed.userName || parsed.username;
        }
      }
    } catch {
      // ignore json parse errors
    }

    return null;
  }

  /**
   * Get current order ID if on order page or chat header
   */
  public static getCurrentOrderId(): string | null {
    // 1. From URL: /orders/ABCDEFGH/
    const urlMatch = window.location.pathname.match(/\/orders\/([A-Za-z0-9]+)/);
    if (urlMatch && urlMatch[1]) {
      return urlMatch[1].toUpperCase();
    }

    // 2. From page order title/heading
    const headerOrder = document.querySelector('.order-header, .page-header, .chat-header');
    if (headerOrder && headerOrder.textContent) {
      const match = headerOrder.textContent.match(/#([A-Za-z0-9]{8})/);
      if (match && match[1]) {
        return match[1].toUpperCase();
      }
    }

    return null;
  }

  /**
   * Extract current order context details if present
   */
  public static findCurrentOrder(): FunPayPageOrder {
    const orderId = this.getCurrentOrderId();
    let product: string | null = null;
    let amount: string | null = null;
    let buyer: string | null = null;

    // Check order page info blocks
    const descEl = document.querySelector('.order-desc, .param-item .param-value');
    if (descEl && descEl.textContent) {
      product = descEl.textContent.trim();
    }

    const priceEl = document.querySelector('.tc-price, .tc-seller-sum, .order-header .price, .order-status .price');
    if (priceEl && priceEl.textContent) {
      amount = priceEl.textContent.trim().replace(/\s+/g, ' ');
    }

    const buyerEl = document.querySelector('.chat-header .media-user-name, .order-header .user-link-name');
    if (buyerEl && buyerEl.textContent) {
      buyer = buyerEl.textContent.trim();
    }

    return {
      id: orderId,
      product,
      amount,
      buyer
    };
  }

  /**
   * Check if element is displayed on screen
   */
  private static isElementVisible(el: HTMLElement): boolean {
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }
}
