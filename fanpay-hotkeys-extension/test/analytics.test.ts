import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeDateRange,
  getRecommendedGranularity,
  generateBuckets,
  selectAxisTicks,
  generateSvgChart,
  formatDateForInput
} from '../src/shared/analytics.ts';
import { FunPayOrder } from '../src/shared/types.ts';

describe('Analytics Engine & Chart Tests', () => {

  it('calculates standard date ranges correctly', () => {
    const range7 = computeDateRange('7');
    assert.equal(range7.isValid, true);
    assert.ok(range7.end > range7.start);
    const daysDiff7 = Math.round((range7.end - range7.start) / (24 * 3600 * 1000));
    assert.equal(daysDiff7, 7);

    const range30 = computeDateRange('30');
    assert.equal(range30.isValid, true);
    const daysDiff30 = Math.round((range30.end - range30.start) / (24 * 3600 * 1000));
    assert.equal(daysDiff30, 30);
  });

  it('validates custom date ranges and prevents invalid bounds', () => {
    // Valid custom range
    const validCustom = computeDateRange('custom', '2026-10-01', '2026-10-25');
    assert.equal(validCustom.isValid, true);
    assert.ok(validCustom.end > validCustom.start);

    // Invalid bounds: end before start
    const invalidCustom = computeDateRange('custom', '2026-10-25', '2026-10-01');
    assert.equal(invalidCustom.isValid, false);
    assert.match(invalidCustom.error || '', /раньше даты начала/);

    // Missing dates
    const missingCustom = computeDateRange('custom', '', '');
    assert.equal(missingCustom.isValid, false);
  });

  it('handles "all" period with historical orders and empty orders', () => {
    // Empty orders fallback
    const rangeEmpty = computeDateRange('all', undefined, undefined, []);
    assert.equal(rangeEmpty.isValid, true);

    // With orders
    const pastTime = new Date('2025-05-10T12:00:00Z').getTime();
    const mockOrders: FunPayOrder[] = [
      { id: '1', buyer: 'u1', buyerId: '1', itemTitle: 'Item', price: 100, currency: '₽', status: 'closed', timestamp: pastTime },
      { id: '2', buyer: 'u2', buyerId: '2', itemTitle: 'Item 2', price: 200, currency: '₽', status: 'closed', timestamp: pastTime + 86400000 }
    ];

    const rangeAll = computeDateRange('all', undefined, undefined, mockOrders);
    assert.equal(rangeAll.isValid, true);
    assert.ok(rangeAll.start <= pastTime);
    assert.ok(rangeAll.end > rangeAll.start);
  });

  it('recommends appropriate granularity based on date duration', () => {
    const now = Date.now();
    // 24 hours -> hours
    assert.equal(getRecommendedGranularity(now - 86400000, now), 'hours');
    // 7 days -> days
    assert.equal(getRecommendedGranularity(now - 7 * 86400000, now), 'days');
    // 60 days -> weeks
    assert.equal(getRecommendedGranularity(now - 60 * 86400000, now), 'weeks');
    // 365 days -> months
    assert.equal(getRecommendedGranularity(now - 365 * 86400000, now), 'months');
  });

  it('groups orders into buckets with zero-filling and currency isolation', () => {
    const baseTime = new Date('2026-10-10T10:00:00').getTime();
    const dayMs = 24 * 3600 * 1000;

    const orders: FunPayOrder[] = [
      // Day 1 (Oct 10) in RUB
      { id: 'o1', buyer: 'b1', buyerId: '1', itemTitle: 'Test 1', price: 1000, currency: '₽', status: 'closed', timestamp: baseTime },
      // Day 1 in USD (must be ignored when querying RUB)
      { id: 'o2', buyer: 'b2', buyerId: '2', itemTitle: 'Test 2', price: 50, currency: '$', status: 'closed', timestamp: baseTime + 1000 },
      // Day 3 (Oct 12) in RUB
      { id: 'o3', buyer: 'b3', buyerId: '3', itemTitle: 'Test 3', price: 2500, currency: '₽', status: 'closed', timestamp: baseTime + 2 * dayMs },
      // Day 3 refund in RUB (must not count towards closed turnover)
      { id: 'o4', buyer: 'b4', buyerId: '4', itemTitle: 'Refunded', price: 500, currency: '₽', status: 'refunded', timestamp: baseTime + 2 * dayMs + 1000 }
    ];

    const start = new Date('2026-10-10T00:00:00').getTime();
    const end = new Date('2026-10-14T23:59:59').getTime();

    const buckets = generateBuckets(orders, start, end, 'days', '₽', 15.0);

    // Should have 5 days (10, 11, 12, 13, 14)
    assert.equal(buckets.length, 5);

    // Day 0 (Oct 10)
    assert.equal(buckets[0].turnover, 1000);
    assert.equal(buckets[0].share, 150); // 15% of 1000
    assert.equal(buckets[0].ordersCount, 1);

    // Day 1 (Oct 11) - Zero filling!
    assert.equal(buckets[1].turnover, 0);
    assert.equal(buckets[1].ordersCount, 0);
    assert.equal(buckets[1].share, 0);

    // Day 2 (Oct 12)
    assert.equal(buckets[2].turnover, 2500);
    assert.equal(buckets[2].refundsCount, 1);
    assert.equal(buckets[2].refundsAmount, 500);

    // Query USD
    const usdBuckets = generateBuckets(orders, start, end, 'days', '$', 10.0);
    assert.equal(usdBuckets[0].turnover, 50);
    assert.equal(usdBuckets[0].ordersCount, 1);
    assert.equal(usdBuckets[2].turnover, 0);
  });

  it('never produces overlapping X-axis ticks for large bucket counts', () => {
    // Simulate 365 daily buckets
    const dummyBuckets = Array.from({ length: 365 }, (_, i) => ({
      key: `d_${i}`,
      startTime: i * 86400000,
      endTime: (i + 1) * 86400000 - 1,
      label: `Day ${i}`,
      fullLabel: `Full Day ${i}`,
      turnover: 0,
      share: 0,
      ordersCount: 0,
      refundsCount: 0,
      refundsAmount: 0,
      orderIds: []
    }));

    const maxTicks = 7;
    const ticks = selectAxisTicks(dummyBuckets, maxTicks);

    assert.ok(ticks.length <= maxTicks);
    assert.ok(ticks.length >= 2);
    assert.equal(ticks[0], 0);
    assert.equal(ticks[ticks.length - 1], 364);

    // Ensure strictly increasing indices
    for (let i = 1; i < ticks.length; i++) {
      assert.ok(ticks[i] > ticks[i - 1]);
    }
  });

  it('renders SVG chart with valid area path, spline curve, and interactive attributes', () => {
    const dummyBuckets = [
      { key: '1', startTime: 100, endTime: 200, label: '01.11', fullLabel: '1 ноя 2026', turnover: 1000, share: 100, ordersCount: 2, refundsCount: 0, refundsAmount: 0, orderIds: [] },
      { key: '2', startTime: 201, endTime: 300, label: '02.11', fullLabel: '2 ноя 2026', turnover: 2500, share: 250, ordersCount: 4, refundsCount: 0, refundsAmount: 0, orderIds: [] },
      { key: '3', startTime: 301, endTime: 400, label: '03.11', fullLabel: '3 ноя 2026', turnover: 1800, share: 180, ordersCount: 3, refundsCount: 0, refundsAmount: 0, orderIds: [] }
    ];

    const svg = generateSvgChart(dummyBuckets, 'turnover', '₽', { width: 800, height: 260 });
    assert.ok(svg.includes('<svg'));
    assert.ok(svg.includes('class="chart-line-path"'));
    assert.ok(svg.includes('class="chart-area-path"'));
    assert.ok(svg.includes('data-date="2 ноя 2026"'));
    assert.ok(svg.includes('data-val='));
    assert.ok(svg.includes('url(#areaGradient)'));
  });

  it('formats Date for input element correctly', () => {
    const d = new Date(2026, 10, 3); // 3 Nov 2026
    const str = formatDateForInput(d);
    assert.equal(str, '2026-11-03');
  });

});
