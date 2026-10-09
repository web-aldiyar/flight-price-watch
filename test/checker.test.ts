import { beforeEach, describe, expect, it } from 'vitest';
import { PriceChecker, shouldNotify } from '../src/checker.ts';
import { Store, type Watch } from '../src/db.ts';
import { FakeMessenger, offer, scriptedSource } from './helpers.ts';

const watch = (overrides: Partial<Watch> = {}): Watch => ({
  id: 1,
  chatId: 1,
  origin: 'ALA',
  destination: 'IST',
  departDate: '2026-12-20',
  returnDate: null,
  maxPrice: null,
  lastPrice: null,
  createdAt: '2026-10-09 00:00:00',
  ...overrides,
});

describe('shouldNotify', () => {
  it('reports the first price', () => expect(shouldNotify(watch(), 50000)).toBe(true));
  it('reports a drop', () => expect(shouldNotify(watch({ lastPrice: 50000 }), 49000)).toBe(true));
  it('ignores a rise or the same price', () => {
    expect(shouldNotify(watch({ lastPrice: 50000 }), 50000)).toBe(false);
    expect(shouldNotify(watch({ lastPrice: 50000 }), 51000)).toBe(false);
  });
  it('respects max price', () => {
    expect(shouldNotify(watch({ maxPrice: 45000 }), 50000)).toBe(false);
    expect(shouldNotify(watch({ maxPrice: 45000, lastPrice: 50000 }), 45000)).toBe(true);
  });
});

describe('PriceChecker.checkAll', () => {
  let store: Store;
  let messenger: FakeMessenger;

  beforeEach(() => {
    store = new Store(':memory:');
    messenger = new FakeMessenger();
  });

  it('alerts only on drops and keeps price history', async () => {
    store.addWatch({ chatId: 7, origin: 'ALA', destination: 'IST', departDate: '2026-12', returnDate: null, maxPrice: null });
    const checker = new PriceChecker(store, scriptedSource([50000, 55000, 48000]), messenger, 'kzt');

    await checker.checkAll();
    await checker.checkAll();
    await checker.checkAll();

    expect(messenger.sent.map((m) => m.text.split('\n')[0])).toEqual([
      '✈️ Текущая цена #1',
      '📉 Цена снизилась #1: было 55 000 KZT',
    ]);
    expect(store.minPrice(1)).toBe(48000);
  });

  it('continues with other watches when one fails', async () => {
    store.addWatch({ chatId: 7, origin: 'ALA', destination: 'IST', departDate: '2026-12', returnDate: null, maxPrice: null });
    store.addWatch({ chatId: 7, origin: 'NQZ', destination: 'DXB', departDate: '2026-12', returnDate: null, maxPrice: null });
    const source = async (query: { origin: string }) => {
      if (query.origin === 'ALA') throw new Error('API down');
      return offer(30000);
    };
    const checker = new PriceChecker(store, source, messenger, 'kzt');

    await checker.checkAll();

    expect(messenger.sent).toHaveLength(1);
    expect(messenger.sent[0]?.text).toContain('NQZ → DXB');
  });
});
