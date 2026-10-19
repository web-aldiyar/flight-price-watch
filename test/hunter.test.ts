import { describe, expect, it } from 'vitest';
import { judgePrice } from '../src/hunter.ts';

const HOUR = 3_600_000;

describe('judgePrice', () => {
  it('takes the first price as the usual one', () => {
    expect(judgePrice(undefined, 100000, 0)).toEqual({ usualPrice: 100000, dealPrice: null, isDeal: false });
  });

  it('finds a deal 20% below the usual price', () => {
    const usual = { usualPrice: 100000, dealPrice: null, updatedAt: 0 };
    expect(judgePrice(usual, 85000, HOUR).isDeal).toBe(false);
    expect(judgePrice(usual, 80000, HOUR)).toMatchObject({ dealPrice: 80000, isDeal: true });
  });

  it('reports an ongoing deal only when it gets cheaper', () => {
    const deal = { usualPrice: 100000, dealPrice: 80000, updatedAt: 0 };
    expect(judgePrice(deal, 80000, HOUR)).toMatchObject({ dealPrice: 80000, isDeal: false });
    expect(judgePrice(deal, 75000, HOUR)).toMatchObject({ dealPrice: 75000, isDeal: true });
    // Back to normal: the next drop is news again.
    expect(judgePrice(deal, 95000, HOUR).dealPrice).toBeNull();
  });

  it('moves the usual price slowly, over about a week', () => {
    const usual = { usualPrice: 100000, dealPrice: null, updatedAt: 0 };
    expect(judgePrice(usual, 50000, HOUR).usualPrice).toBe(99702);
    expect(judgePrice(usual, 50000, 7 * 24 * HOUR).usualPrice).toBe(50000);
  });
});
