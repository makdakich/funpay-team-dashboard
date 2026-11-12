/**
 * Safely send runtime messages from content script without throwing
 * "Extension context invalidated" if the extension was reloaded in chrome://extensions.
 */
export function safeSendMessage<T = any>(message: any): Promise<T | null> {
  try {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
      return Promise.resolve(null);
    }
    return chrome.runtime.sendMessage(message).catch(() => null);
  } catch {
    return Promise.resolve(null);
  }
}
