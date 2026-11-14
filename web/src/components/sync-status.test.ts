import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupMockDom } from '@/test-utils/dom-mock';
import { SyncStatusIndicator } from './page';

describe('SyncStatusIndicator', () => {
  let cleanupDom: () => void;

  beforeEach(() => {
    cleanupDom = setupMockDom();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanupDom();
  });

  it('initializes in reconnecting state with appropriate styling', () => {
    const indicator = new SyncStatusIndicator();
    expect(indicator.node.classList.contains('sync-status-indicator')).toBe(true);
    expect(indicator.node.classList.contains('sync-status-warning')).toBe(true);
    expect(indicator.node.textContent).toContain('Переподключение');
    indicator.destroy();
  });

  it('updates UI based on live socket and timestamp updates', () => {
    const indicator = new SyncStatusIndicator();

    // Trigger internal render with mock connected state
    (indicator as any).socketState = 'connected';
    (indicator as any).lastOrdersSync = new Date(Date.now() - 3 * 60 * 1000); // 3 minutes ago
    (indicator as any).render();

    expect(indicator.node.classList.contains('realtime-active')).toBe(true);
    expect(indicator.node.textContent).toContain('FunPay: 3 мин. назад · Live');

    // Recent (< 1 min)
    (indicator as any).lastOrdersSync = new Date(Date.now() - 30 * 1000);
    (indicator as any).render();
    expect(indicator.node.textContent).toContain('FunPay: только что · Live');

    // Offline state
    (indicator as any).socketState = 'disconnected';
    (indicator as any).render();
    expect(indicator.node.classList.contains('sync-status-error')).toBe(true);
    expect(indicator.node.textContent).toContain('Офлайн');

    indicator.destroy();
  });

  it('cleans up timers and channels upon destroy', () => {
    const clearSpy = vi.spyOn(window, 'clearInterval');
    const indicator = new SyncStatusIndicator();

    indicator.destroy();
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
