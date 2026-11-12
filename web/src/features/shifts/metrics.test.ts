import { describe, expect, it } from 'vitest';
import { formatDurationHms, groupOrdersByShift, shiftDurationSeconds } from './metrics';

describe('shift turnover metrics', () => {
  it('groups closed orders by shift and keeps currencies separated', () => {
    const groups = groupOrdersByShift([
      { shift_id: 'shift-a', amount: '1500.00', currency: 'RUB', status: 'closed' },
      { shift_id: 'shift-a', amount: '25.00', currency: 'USD', status: 'closed' },
      { shift_id: 'shift-b', amount: '300.00', currency: 'KZT', status: 'closed' }
    ]);

    expect(groups.get('shift-a')?.count).toBe(2);
    expect(groups.get('shift-a')?.turnover).toEqual({ RUB: 1500, USD: 25, EUR: 0, KZT: 0 });
    expect(groups.get('shift-a')?.share).toEqual({ RUB: 150, USD: 2.5, EUR: 0, KZT: 0 });
    expect(groups.get('shift-b')?.turnover.KZT).toBe(300);
    expect(groups.get('shift-b')?.turnover.RUB).toBe(0);
  });

  it('excludes paid and refunded orders from the confirmed turnover', () => {
    const groups = groupOrdersByShift([
      { shift_id: 'shift-a', amount: '100.00', currency: 'RUB', status: 'paid' },
      { shift_id: 'shift-a', amount: '900.00', currency: 'RUB', status: 'refunded' },
      { shift_id: 'shift-a', amount: '50.00', currency: 'RUB', status: 'closed' }
    ]);

    expect(groups.get('shift-a')?.count).toBe(1);
    expect(groups.get('shift-a')?.turnover.RUB).toBe(50);
    expect(groups.get('shift-a')?.share.RUB).toBe(5);
  });

  it('ignores orders with no shift link so nothing is double counted', () => {
    const groups = groupOrdersByShift([
      { shift_id: null, amount: '700.00', currency: 'RUB', status: 'closed' },
      { shift_id: 'shift-a', amount: '100.00', currency: 'RUB', status: 'closed' }
    ]);

    expect([...groups.keys()]).toEqual(['shift-a']);
    expect(groups.get('shift-a')?.turnover.RUB).toBe(100);
  });

  it('returns an empty map for empty input', () => {
    expect(groupOrdersByShift([]).size).toBe(0);
  });
});

describe('shift duration', () => {
  it('counts an active shift up to the current moment', () => {
    const shift = { start_time: '2026-11-10T05:30:00.000Z', end_time: null, duration_seconds: 0, status: 'active' as const };
    expect(shiftDurationSeconds(shift, Date.parse('2026-11-10T05:32:00.000Z'))).toBe(120);
    expect(shiftDurationSeconds(shift, Date.parse('2026-11-10T06:00:00.000Z'))).toBe(1800);
  });

  it('uses end_time for a completed shift', () => {
    const shift = { start_time: '2026-11-10T05:30:00.000Z', end_time: '2026-11-10T05:32:01.000Z', duration_seconds: 121, status: 'completed' as const };
    expect(shiftDurationSeconds(shift)).toBe(121);
  });

  it('falls back to the stored duration when end_time is missing', () => {
    const shift = { start_time: '2026-11-10T05:30:00.000Z', end_time: null, duration_seconds: 83, status: 'completed' as const };
    expect(shiftDurationSeconds(shift)).toBe(83);
  });

  it('never returns a negative duration', () => {
    const shift = { start_time: '2026-11-10T05:30:00.000Z', end_time: '2026-11-10T05:00:00.000Z', duration_seconds: 0, status: 'completed' as const };
    expect(shiftDurationSeconds(shift)).toBe(0);
  });
});

describe('formatDurationHms', () => {
  it('formats zero seconds as 00:00:00', () => {
    expect(formatDurationHms(0)).toBe('00:00:00');
  });

  it('formats seconds with zero-padding', () => {
    expect(formatDurationHms(5)).toBe('00:00:05');
    expect(formatDurationHms(65)).toBe('00:01:05');
    expect(formatDurationHms(3665)).toBe('01:01:05');
  });

  it('formats multi-hour shifts correctly', () => {
    expect(formatDurationHms(36000)).toBe('10:00:00');
    expect(formatDurationHms(9872)).toBe('02:44:32');
  });

  it('handles negative or invalid values gracefully', () => {
    expect(formatDurationHms(-10)).toBe('00:00:00');
    expect(formatDurationHms(NaN)).toBe('00:00:00');
  });
});

