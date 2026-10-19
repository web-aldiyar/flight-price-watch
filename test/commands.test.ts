import { beforeEach, describe, expect, it } from 'vitest';
import type { DestinationOffer, TripLength } from '../src/aviasales.ts';
import { PriceChecker } from '../src/checker.ts';
import { Conversation, MENU } from '../src/commands.ts';
import type { Store } from '../src/db.ts';
import { Hunter } from '../src/hunter.ts';
import { FakeMessenger, fakePlaces, memoryStore, scriptedSource, trip } from './helpers.ts';

const TODAY = '2026-10-09';
const CHAT = 1;

describe('Conversation', () => {
  let store: Store;
  let messenger: FakeMessenger;
  let bot: Conversation;
  let explored: { origin: string; trip: TripLength }[];
  let destinations: DestinationOffer[];
  let now: number;

  const setup = (prices: (number | null)[] = []) => {
    const checker = new PriceChecker(store, scriptedSource(prices), messenger, 'kzt');
    explored = [];
    destinations = [
      trip('NQZ', 15000), // domestic from Kazakhstan: skipped
      { ...trip('IST', 42000), transfers: 1 },
      trip('XXX', 45000), // unknown city: skipped
      trip('DXB', 60000, '2027-01-15', '2027-01-22'),
    ];
    now = Date.parse('2026-10-09T12:00:00Z');
    const explore = async (origin: string, length: TripLength) => {
      explored.push({ origin, trip: length });
      return destinations;
    };
    const hunter = new Hunter(store, explore, fakePlaces, messenger, 'kzt', () => now);
    bot = new Conversation(store, checker, hunter, messenger, fakePlaces, 'kzt', () => TODAY);
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
    expect(messenger.buttons).toEqual([expect.stringMatching(/^edit:\d+$/), expect.stringMatching(/^del:\d+$/), 'new']);
    const del = messenger.buttons[1];

    await press(del!);
    expect(messenger.last?.text).toContain('Больше не слежу');
    await say(MENU.list);
    expect(messenger.last?.text).toContain('Пока ни за одним маршрутом не слежу');
  });

  it('keeps chats separate', async () => {
    await say('Алматы Стамбул декабрь');
    await bot.handle({ kind: 'text', chatId: 2, text: MENU.list });
    expect(messenger.last).toMatchObject({ chatId: 2, text: expect.stringContaining('Пока ни за одним') });
  });

  describe('editing', () => {
    /** Creates "Алматы → Стамбул, декабрь, one way, any price" and returns its id. */
    const createWatch = async () => {
      await say('Алматы Стамбул декабрь');
      await press('oneway');
      await press('anyprice');
      return (await store.listWatches(CHAT))[0]!.id;
    };

    it('offers the fields to change', async () => {
      setup([50000]);
      const id = await createWatch();
      await press(`edit:${id}`);

      expect(messenger.last?.text).toContain('Что изменить');
      expect(messenger.buttons).toEqual([
        `editf:${id}.origin`,
        `editf:${id}.destination`,
        `editf:${id}.depart`,
        `editf:${id}.return`,
        `editf:${id}.price`,
        'cancel',
      ]);
    });

    it('changes the max price and keeps the price history', async () => {
      setup([50000]);
      const id = await createWatch();
      await press(`editf:${id}.price`);
      expect(messenger.last?.text).toContain('Когда вам написать');

      await say('45к');
      expect(messenger.last?.text).toContain('Сохранил');
      expect(messenger.last?.text).toContain('Сейчас самый дешёвый билет: 50\u00a0000 ₸');
      expect((await store.listWatches(CHAT))[0]).toMatchObject({ id, maxPrice: 45000, lastPrice: 50000 });
      expect(await store.getDraft(CHAT)).toBeNull();
    });

    it('changes the destination, resets prices and checks again', async () => {
      setup([50000, 20000]);
      const id = await createWatch();
      await press(`editf:${id}.destination`);
      expect(messenger.last?.text).toContain('Куда летим');

      await say('Астана');
      expect(texts().at(-2)).toContain('Алматы → Астана, декабрь 2026');
      expect(texts().at(-1)).toContain('Нашёл билеты');
      expect((await store.listWatches(CHAT))[0]).toMatchObject({ id, destination: 'NQZ', lastPrice: 20000 });
      expect(await store.minPrice(id)).toBe(20000);
    });

    it('rejects the same city on both ends', async () => {
      setup([50000]);
      const id = await createWatch();
      await press(`editf:${id}.destination`);
      await say('Алматы');
      expect(messenger.last?.text).toContain('не может совпадать');
    });

    it('adds a return date and validates it against the departure', async () => {
      setup([50000, 90000]);
      const id = await createWatch();
      await press(`editf:${id}.return`);
      await say('01.11');
      expect(messenger.last?.text).toContain('раньше вылета');

      await say('10 января');
      expect((await store.listWatches(CHAT))[0]).toMatchObject({ returnDate: '2027-01-10' });
    });

    it('changes the departure month with a button', async () => {
      setup([50000, 45000]);
      const id = await createWatch();
      await press(`editf:${id}.depart`);
      await press('month:2027-01');
      expect((await store.listWatches(CHAT))[0]).toMatchObject({ departDate: '2027-01' });
    });

    it('cancels editing without changes', async () => {
      setup([50000]);
      const id = await createWatch();
      await press(`editf:${id}.origin`);
      await press('cancel');
      expect((await store.listWatches(CHAT))[0]).toMatchObject({ origin: 'ALA' });
    });
  });

  describe('anywhere', () => {
    it('shows the cheapest round trips abroad on any date', async () => {
      await say(MENU.explore);
      expect(messenger.last?.text).toContain('за границу');

      await say('Алматы');
      expect(explored).toEqual([{ origin: 'ALA', trip: { minDays: 3, maxDays: 14 } }]);
      const text = messenger.last?.text ?? '';
      expect(text).toContain('Самые дешёвые поездки за границу из города Алматы');
      expect(text).not.toContain('Астана');
      expect(text).toContain('<b>1. Стамбул</b>, Турция — <b>42\u00a0000 ₸</b>');
      expect(text).toContain('20 декабря 2026 → 27 декабря 2026 · 7 дн. · пересадок: 1');
      expect(text).toContain('<b>2. Дубай</b>, ОАЭ — <b>60\u00a0000 ₸</b>\n     15 января 2027');
      expect(messenger.buttons).toEqual([
        'follow:ALA.IST.2026-12-20.2026-12-27',
        'follow:ALA.DXB.2027-01-15.2027-01-22',
        'hfrom:ALA',
      ]);
      expect(await store.getDraft(CHAT)).toBeNull();
    });

    it('starts watching the dates of the trip found', async () => {
      setup([60000]);
      await say(MENU.explore);
      await say('Алматы');
      await press('follow:ALA.DXB.2027-01-15.2027-01-22');

      expect((await store.listWatches(CHAT))[0]).toMatchObject({
        origin: 'ALA',
        destination: 'DXB',
        originName: 'Алматы',
        destinationName: 'Дубай',
        departDate: '2027-01-15',
        returnDate: '2027-01-22',
        maxPrice: null,
      });
      expect(messenger.last?.text).toContain('Нашёл билеты');
    });

    it('still understands buttons from older messages', async () => {
      setup([60000]);
      await press('follow:ALA.DXB.2027-01');
      expect((await store.listWatches(CHAT))[0]).toMatchObject({ departDate: '2027-01', returnDate: null });
    });

    it('says so when there is nothing abroad', async () => {
      destinations = [trip('NQZ', 15000)];
      await say('/anywhere');
      await say('Алматы');
      expect(messenger.last?.text).toContain('за границу пока не нашлось');
    });

    it('turns the city into a hunt', async () => {
      await say(MENU.explore);
      await say('Алматы');
      await press('hfrom:ALA');
      expect(await store.getHunt(CHAT)).toMatchObject({ origins: [{ code: 'ALA', name: 'Алматы', countryCode: 'KZ' }] });
    });
  });

  describe('ticket hunter', () => {
    const hourLater = () => (now += 3_600_000);

    it('asks for a departure city, offering big cities', async () => {
      await say(MENU.hunt);
      expect(messenger.last?.text).toContain('Откуда можете вылететь');
      expect(messenger.buttons).toEqual(['hcity:MOW', 'hcity:TLV', 'hcity:LON', 'hcity:MAD', 'hcity:ROM', 'cancel']);
    });

    it('hunts from the chosen cities and shows what is cheap now', async () => {
      destinations = [trip('MOW', 20000), trip('IST', 42000), trip('ROM', 90000)];
      await say('/hunt');
      await press('hcity:MOW');

      expect(await store.getHunt(CHAT)).toEqual({
        chatId: CHAT,
        origins: [{ code: 'MOW', name: 'Москва', countryCode: 'RU' }],
        minDays: 3,
        maxDays: 14,
      });
      expect(texts().at(-2)).toContain('Добавил: Москва');
      const text = messenger.last?.text ?? '';
      expect(text).toContain('<b>1. Москва → Стамбул</b>, Турция — <b>42\u00a0000 ₸</b>');
      expect(text).toContain('<b>2. Москва → Рим</b>');
      expect(text).not.toContain('Москва → Москва');

      // A city typed by name is added too, and both are scanned.
      await say(MENU.hunt);
      expect(messenger.last?.text).toContain('Вылет из: Москва');
      await press('hadd');
      await say('Алматы');
      expect((await store.getHunt(CHAT))?.origins.map((o) => o.code)).toEqual(['MOW', 'ALA']);
      expect(explored.slice(-2).map((e) => e.origin)).toEqual(['MOW', 'ALA']);
      // Istanbul is cheapest from either city; Moscow is abroad from Almaty.
      expect(messenger.last?.text).toContain('Алматы → Москва');
    });

    it('alerts once when a destination gets much cheaper than usual', async () => {
      destinations = [trip('IST', 100000), trip('ROM', 200000)];
      await press('hcity:MOW');
      expect(texts().some((t) => t.includes('Выгодные'))).toBe(false);
      const scan = async () => {
        hourLater();
        const before = messenger.sent.length;
        await say(MENU.check);
        return messenger.sent.slice(before).map((m) => m.text);
      };

      destinations = [trip('IST', 90000), trip('ROM', 150000)];
      let sent = await scan();
      expect(sent[0]).toContain('Выгодные билеты');
      expect(sent[0]).toContain('Москва → Рим');
      expect(sent[0]).toContain('обычно ~200\u00a0000 ₸, <b>−25%</b>');
      expect(sent[0]).not.toContain('Стамбул'); // only 10% cheaper

      // The same deal is not reported again; a deeper drop is.
      sent = await scan();
      expect(sent.some((t) => t.includes('Выгодные'))).toBe(false);
      destinations = [trip('IST', 90000), trip('ROM', 140000)];
      sent = await scan();
      expect(sent[0]).toContain('140\u00a0000 ₸');
    });

    it('changes the trip length and forgets the old usual prices', async () => {
      await press('hcity:MOW');
      await press('hlen');
      expect(messenger.buttons).toEqual(['hlenset:3-14', 'hlenset:2-4', 'hlenset:5-9', 'hlenset:10-16', 'cancel']);
      await press('hlenset:2-4');
      expect(await store.getHunt(CHAT)).toMatchObject({ minDays: 2, maxDays: 4 });
      expect(explored.at(-1)?.trip).toEqual({ minDays: 2, maxDays: 4 });
    });

    it('removes cities and turns off with the last one', async () => {
      await press('hcity:MOW');
      await press('hcity:TLV');
      await press('hcity:MOW');
      expect(texts()).toContain('Москва уже в списке.');

      await press('hdel:MOW');
      expect((await store.getHunt(CHAT))?.origins.map((o) => o.code)).toEqual(['TLV']);
      expect(messenger.last?.text).toContain('Вылет из: Тель-Авив');

      await press('hdel:TLV');
      expect(await store.getHunt(CHAT)).toBeNull();
      expect(messenger.last?.text).toContain('Охотник выключен');
    });
  });
});
