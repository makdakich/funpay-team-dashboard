import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupMockDom } from '@/test-utils/dom-mock';
import { OverviewPage, buildOverviewInteractive } from './view';
import type { OverviewData } from '@/types/database';

describe('OverviewPage & Realtime Lifecycle', () => {
  let cleanupDom: () => void;

  beforeEach(() => {
    cleanupDom = setupMockDom();
  });

  afterEach(() => {
    cleanupDom();
  });

  const mockData: OverviewData = {
    activeMembers: 3,
    activeShifts: 1,
    totalOrders: 100,
    closedOrders: 80,
    turnoverByCurrency: { RUB: 50000, USD: 0, EUR: 0, KZT: 0 },
    operatorShareByCurrency: { RUB: 5000, USD: 0, EUR: 0, KZT: 0 },
    recentActivity: [
      {
        shift: {
          id: 'shift-1',
          user_id: 'user-1',
          seller_account_id: '4473774',
          start_time: new Date().toISOString(),
          end_time: null,
          duration_seconds: 0,
          status: 'active'
        },
        displayName: 'Оператор Алекс'
      }
    ],
    orders: [],
    sellerAccountId: '4473774',
    storeName: 'Hopeoflove',
    balancesByCurrency: { RUB: 12500 },
    totalBalance: 12500,
    balanceCurrency: 'RUB',
    balanceUpdatedAt: new Date().toISOString()
  };

  it('instantiates OverviewPage, mounts container and cleanly destroys', () => {
    const container = document.createElement('div');
    const page = new OverviewPage(container as any);

    expect(container.querySelector('.page-heading')?.textContent).toContain('Обзор & Финансовая Аналитика');
    expect(container.querySelector('.page-content')).not.toBeNull();

    expect(() => page.destroy()).not.toThrow();
  });

  it('buildOverviewInteractive returns interactive update handles', () => {
    const { element, updateBalance, updateShifts, renderChart } = buildOverviewInteractive(mockData);

    expect(element.classList.contains('overview-layout')).toBe(true);
    expect(element.querySelector('.hero-balance-val')?.textContent?.replace(/\s/g, ' ')).toContain('12 500');

    // Live update balance without full DOM recreation
    mockData.balancesByCurrency = { RUB: 18900 };
    mockData.totalBalance = 18900;
    updateBalance();
    expect(element.querySelector('.hero-balance-val')?.textContent?.replace(/\s/g, ' ')).toContain('18 900');

    // Live update shifts
    updateShifts(2, [
      {
        shift: {
          id: 'shift-2',
          user_id: 'user-2',
          seller_account_id: '4473774',
          start_time: new Date().toISOString(),
          end_time: null,
          duration_seconds: 0,
          status: 'active'
        },
        displayName: 'Оператор Мария'
      }
    ]);

    const kpiValues = element.querySelectorAll('.kpi-value');
    expect(kpiValues[1]?.textContent).toBe('2');

    expect(typeof renderChart).toBe('function');
  });

  it('detaches resize listener on destroy to prevent memory leaks', () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const container = document.createElement('div');
    const page = new OverviewPage(container as any);

    // Simulate binding the resize listener
    (page as any).bindWindowResize(() => {});

    page.destroy();
    expect(removeSpy).toHaveBeenCalledWith('resize', expect.any(Function));
    removeSpy.mockRestore();
  });
});
