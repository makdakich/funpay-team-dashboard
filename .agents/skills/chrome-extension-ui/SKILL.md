---
name: chrome-extension-ui
description: UI/UX design patterns, floating widgets, draggable overlays, responsive popups, options pages, scoped CSS isolation, and reactive state sync for Manifest V3 Chrome Extensions.
---

# Modern Chrome Extension UI/UX Engineering

Use this skill when designing, building, and styling Chrome Extension user interfaces (Popups, Options / Dashboard tabs, Content Script Floating Overlays, and Background Alarms).

---

## 1. Extension UI Paradigms

Chrome extensions feature three distinct UI environments:
1. **Action Popup (`popup.html`)**:
   - Fixed width (`360px` to `400px`), height up to `580px`.
   - Opens on icon click, closes immediately when user clicks elsewhere.
   - Must load instantly (<50ms). Never do heavy synchronous network queries on open; read immediately from local cache (`chrome.storage.local`).
2. **Dashboard / Options Page (`options.html`)**:
   - Full-bleed desktop web app environment.
   - Ideal for in-depth analytics, complex tables, multi-tab settings, historical data management, and CSV exports.
3. **In-Page Floating Widgets / Overlays (`content.ts`)**:
   - Injected directly into the host web application (e.g. `funpay.com`).
   - Must be strictly isolated to avoid conflicting with the host page CSS or JavaScript.

---

## 2. In-Page Floating HUD & Widget Engineering

### CSS Isolation
- Prefix all custom classes with a unique namespace (e.g. `.fph-widget-`, `.fph-btn-`, `.fph-badge-`).
- Set `all: initial` or strict CSS resets on the outer root container to prevent host site styles from distorting the extension UI.
- Use `box-sizing: border-box` universally within the widget tree.
- Keep `z-index` sufficiently high (`z-index: 999999`) to stay above host page navigation, but avoid blocking critical host page inputs.

### Draggable Widget Implementation
- Allow dragging by the header bar only:
  ```typescript
  let isDragging = false;
  let startX = 0, startY = 0, initialLeft = 0, initialTop = 0;

  header.addEventListener('mousedown', (e) => {
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = widget.getBoundingClientRect();
    initialLeft = rect.left;
    initialTop = rect.top;
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const maxLeft = window.innerWidth - widget.offsetWidth - 10;
    const maxTop = window.innerHeight - widget.offsetHeight - 10;
    const newLeft = Math.max(10, Math.min(maxLeft, initialLeft + dx));
    const newTop = Math.max(10, Math.min(maxTop, initialTop + dy));
    widget.style.left = `${newLeft}px`;
    widget.style.top = `${newTop}px`;
    widget.style.right = 'auto';
  });

  window.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      // Persist widget position to chrome.storage.local
      saveWidgetPosition(widget.offsetLeft, widget.offsetTop);
    }
  });
  ```

### Collapsible States
- Provide an minimize/expand toggle button.
- Minimized state: compact pill showing active indicator (e.g., green pulsating dot), operator name, and HH:MM:SS timer. Clicking expands to full card.
- Expanded state: displays operator, start time, live earnings, elapsed time, and actions.

---

## 3. Reactive State Synchronization Across Contexts

Never rely on polling loops (`setInterval(..., 1000)`) to detect state changes between tabs, popup, and content script.

Use `chrome.storage.onChanged`:
```typescript
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local') {
    if (changes.shiftState) {
      updateActiveShiftUI(changes.shiftState.newValue);
    }
    if (changes.syncCache) {
      updateDataCacheUI(changes.syncCache.newValue);
    }
  }
});
```
This ensures instant, synchronized updates across all open FunPay tabs, the popup, and options page.

---

## 4. Shift Overrun Alarms & Browser Restore Alerts

- **`chrome.alarms`**:
  Use Chrome alarms in `service-worker.ts` to check periodically (e.g., every 15 minutes) if an active shift exceeds the user-configured alert threshold (e.g., 8 hours).
- **`chrome.notifications`**:
  Display native desktop notifications when a shift exceeds threshold or when browser is reopened with an unclosed shift from hours ago.
- **Confirmation dialog**:
  Always confirm before ending a shift with a modal or native confirm to prevent accidental termination.
