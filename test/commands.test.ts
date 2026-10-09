import { beforeEach, describe, expect, it } from 'vitest';
import { PriceChecker } from '../src/checker.ts';
import { CommandHandler, parseTrackArgs } from '../src/commands.ts';
import type { Store } from '../src/db.ts';
import { FakeMessenger, memoryStore, scriptedSource } from './helpers.ts';

const TODAY = '2026-10-09';

describe('parseTrackArgs', () => {
  it('parses a one-way trip', () => {
    expect(parseTrackArgs(['ala', 'ist', '2026-12-20'], TODAY)).toEqual({
      ok: true,
      watch: { origin: 'ALA', destination: 'IST', departDate: '2026-12-20', returnDate: null, maxPrice: null },
    });
  });

  it('parses a round trip by month with a max price', () => {
    expect(parseTrackArgs(['ALA', 'IST', '2026-12', '2027-01', 'max=60000'], TODAY)).toEqual({
      ok: true,
      watch: { origin: 'ALA', destination: 'IST', departDate: '2026-12', returnDate: '2027-01', maxPrice: 60000 },
    });
  });

  it('accepts the current month', () => {
    expect(parseTrackArgs(['ALA', 'IST', '2026-10'], TODAY).ok).toBe(true);
  });

  it.each([
    [['ALA', 'IST'], 'Формат'],
    [['ALMATY', 'IST', '2026-12-20'], 'IATA'],
    [['ALA', 'ALA', '2026-12-20'], 'совпадают'],
    [['ALA', 'IST', '20.12.2026'], 'Неверная дата'],
    [['ALA', 'IST', '2026-10-01'], 'прошла'],
    [['ALA', 'IST', '2026-09'], 'прошла'],
    [['ALA', 'IST', '2026-12-20', '2026-12-10'], 'раньше'],
    [['ALA', 'IST', '2026-12-20', 'max=-5'], 'max'],
    [['ALA', 'IST', '2026-12-20', 'foo=1'], 'Неизвестный параметр'],
  ])('rejects %j', (args, error) => {
    const result = parseTrackArgs(args, TODAY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(error);
  });
});

describe('CommandHandler', () => {
  let store: Store;
  let messenger: FakeMessenger;

  const handler = (prices: (number | null)[]) => {
    const checker = new PriceChecker(store, scriptedSource(prices), messenger, 'kzt');
    return new CommandHandler(store, checker, messenger, 'kzt', () => TODAY);
  };

  beforeEach(() => {
    store = memoryStore();
    messenger = new FakeMessenger();
  });

  it('tracks a route, confirms, then reports the current price', async () => {
    const reply = await handler([52000]).handle(1, '/track ALA IST 2026-12-20');

    expect(reply).toBeNull();
    expect(messenger.sent.map((m) => m.text)).toEqual([
      expect.stringContaining('Слежу #1: ALA → IST'),
      expect.stringContaining('Текущая цена #1'),
    ]);
    expect((await store.listWatches(1))[0]?.lastPrice).toBe(52000);
  });

  it('says so when the price is above max', async () => {
    const reply = await handler([70000]).handle(1, '/track ALA IST 2026-12-20 max=60000');

    expect(reply).toContain('выше порога');
    expect(messenger.sent).toHaveLength(1);
  });

  it('keeps the watch when the first check fails', async () => {
    const reply = await handler([]).handle(1, '/track ALA IST 2026-12-20');

    expect(reply).toContain('Не удалось');
    expect(await store.listWatches(1)).toHaveLength(1);
  });

  it('lists and removes only the caller’s watches', async () => {
    const h = handler([50000, 40000]);
    await h.handle(1, '/track ALA IST 2026-12-20');
    await h.handle(2, '/track NQZ DXB 2026-11');

    expect(await h.handle(1, '/list')).toContain('ALA → IST');
    expect(await h.handle(1, '/list')).not.toContain('NQZ');
    expect(await h.handle(1, '/remove 2')).toContain('не найдено');
    expect(await h.handle(2, '/remove #2')).toContain('удалено');
    expect(await h.handle(2, '/list')).toContain('Отслеживаний нет');
  });

  it('handles /help with a bot-name suffix and ignores plain text', async () => {
    const h = handler([]);
    expect(await h.handle(1, '/help@flight_bot')).toContain('/track');
    expect(await h.handle(1, 'привет')).toBeNull();
    expect(await h.handle(1, '/foo')).toContain('Неизвестная команда');
  });
});
