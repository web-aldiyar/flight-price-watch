import { beforeEach, describe, expect, it } from 'vitest';
import { PriceChecker } from '../src/checker.ts';
import { Conversation, MENU } from '../src/commands.ts';
import type { Store } from '../src/db.ts';
import { FakeMessenger, fakePlaces, memoryStore, scriptedSource } from './helpers.ts';

const TODAY = '2026-10-09';
const CHAT = 1;

describe('Conversation', () => {
  let store: Store;
  let messenger: FakeMessenger;
  let bot: Conversation;

  const setup = (prices: (number | null)[] = []) => {
    const checker = new PriceChecker(store, scriptedSource(prices), messenger, 'kzt');
    bot = new Conversation(store, checker, messenger, fakePlaces, 'kzt', () => TODAY);
  };
  const say = (text: string) => bot.handle({ kind: 'text', chatId: CHAT, text });
  const press = (data: string) => bot.handle({ kind: 'button', chatId: CHAT, data, callbackId: 'cb' });
  const texts = () => messenger.sent.map((m) => m.text);

  beforeEach(() => {
    store = memoryStore();
    messenger = new FakeMessenger();
    setup();
  });

  it('greets with the menu keyboard', async () => {
    await say('/start');
    expect(messenger.last?.text).toContain('Как начать');
    expect(messenger.last?.options?.menu?.flat()).toContain(MENU.track);
  });

  it('walks through the questions step by step', async () => {
    setup([28000]);
    await say(MENU.track);
    expect(messenger.last?.text).toContain('Откуда летим');

    await say('Шымкент');
    expect(messenger.last?.text).toContain('Куда летим');

    await say('астана');
    expect(messenger.last?.text).toContain('Шымкент → Астана. <b>Когда летим?</b>');
    expect(messenger.buttons).toContain('month:2026-11');

    await press('month:2026-11');
    expect(messenger.last?.text).toContain('обратный билет');

    await press('oneway');
    expect(messenger.last?.text).toContain('Когда вам написать');

    await say('30 000');
    const [watch] = await store.listWatches(CHAT);
    expect(watch).toMatchObject({
      origin: 'CIT',
      destination: 'NQZ',
      originName: 'Шымкент',
      destinationName: 'Астана',
      departDate: '2026-11',
      returnDate: null,
      maxPrice: 30000,
      lastPrice: 28000,
    });
    expect(texts().at(-2)).toContain('Готово');
    expect(texts().at(-1)).toContain('Нашёл билеты');
    expect(texts().at(-1)).toContain('28\u00a0000 ₸');
    expect(await store.getDraft(CHAT)).toBeNull();
  });

  it('asks which city when the name is ambiguous', async () => {
    await say(MENU.track);
    await say('Ур');
    expect(messenger.last?.text).toContain('Какой именно');
    expect(messenger.buttons).toEqual(['place:URA', 'place:UGC', 'cancel']);

    await press('place:UGC');
    expect(messenger.last?.text).toContain('Из города Ургенч');
  });

  it('explains unknown cities and bad dates without losing progress', async () => {
    await say(MENU.track);
    await say('Атлантида');
    expect(messenger.last?.text).toContain('Не нашёл город «Атлантида»');

    await say('Алматы');
    await say('Стамбул');
    await say('вчера');
    expect(messenger.last?.text).toContain('Не понял дату');

    await say('20 декабря');
    expect(messenger.last?.text).toContain('Вылет: 20 декабря 2026');
    await say('05.01');
    expect(messenger.last?.text).toContain('Когда вам написать');
    await press('anyprice');

    expect((await store.listWatches(CHAT))[0]).toMatchObject({ departDate: '2026-12-20', returnDate: '2027-01-05', maxPrice: null });
  });

  it('understands a whole request in one message', async () => {
    setup([31000]);
    await say('Шымкент Астана ноябрь до 30000');
    // Only the return question is left.
    expect(messenger.last?.text).toContain('обратный билет');

    await say('нет');
    const [watch] = await store.listWatches(CHAT);
    expect(watch).toMatchObject({ origin: 'CIT', destination: 'NQZ', departDate: '2026-11', returnDate: null, maxPrice: 30000 });
    expect(messenger.last?.text).toContain('дороже вашей суммы');
  });

  it('understands round trips in one message', async () => {
    await say('из Алматы в Стамбул 20.12 обратно 5 января');
    expect(messenger.last?.text).toContain('Когда вам написать');
    expect(await store.getDraft(CHAT)).toMatchObject({ departDate: '2026-12-20', returnDate: '2027-01-05' });
  });

  it('asks for what is missing from a partial message', async () => {
    await say('Алматы Стамбул');
    expect(messenger.last?.text).toContain('Когда летим');
  });

  it('suggests the menu for gibberish', async () => {
    await say('привет как дела бот');
    expect(messenger.last?.text).toContain('Не совсем понял');
  });

  it('cancels the dialog', async () => {
    await say(MENU.track);
    await press('cancel');
    expect(messenger.last?.text).toContain('отменил');
    expect(await store.getDraft(CHAT)).toBeNull();
  });

  it('handles stale buttons', async () => {
    await press('month:2026-11');
    expect(messenger.last?.text).toContain('устарели');
  });

  it('lists and deletes watches with buttons', async () => {
    setup([50000, 40000]);
    await say('Алматы Стамбул декабрь');
    await press('oneway');
    await press('anyprice');

    await say(MENU.list);
    expect(messenger.last?.text).toContain('Алматы → Стамбул, декабрь 2026, в одну сторону');
    expect(messenger.last?.text).toContain('сейчас 50\u00a0000 ₸');
    const [del] = messenger.buttons;
    expect(del).toMatch(/^del:\d+$/);

    await press(del!);
    expect(messenger.last?.text).toContain('Больше не слежу');
    await say(MENU.list);
    expect(messenger.last?.text).toContain('Пока ничего не отслеживаю');
  });

  it('keeps chats separate', async () => {
    await say('Алматы Стамбул декабрь');
    await bot.handle({ kind: 'text', chatId: 2, text: MENU.list });
    expect(messenger.last).toMatchObject({ chatId: 2, text: expect.stringContaining('Пока ничего') });
  });
});
