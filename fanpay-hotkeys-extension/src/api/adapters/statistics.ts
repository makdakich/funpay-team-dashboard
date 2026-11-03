import { DashboardStats, FunPayOrder } from '../../shared/types';
import { calculateDashboardStats } from '../../shared/utils';

/**
 * Statistics Adapter
 * Pure local calculation engine.
 * Never calls external APIs, calculates metrics strictly in memory.
 */
export class FunPayStatisticsAdapter {
  /**
   * Calculate full multi-currency dashboard metrics
   */
  public static calculate(
    orders: FunPayOrder[],
    sellerSharePercent: number,
    balances: Record<string, number> = {},
    primaryCurrency: string = '₽',
    lastSync: number | null = null,
    referenceTime: number = Date.now()
  ): DashboardStats {
    return calculateDashboardStats(
      orders,
      sellerSharePercent,
      balances,
      primaryCurrency,
      lastSync,
      referenceTime
    );
  }
}
