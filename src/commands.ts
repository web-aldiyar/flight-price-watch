import type { PriceChecker } from './checker.ts';
import { formatDate, monthIndex, parseDate, parsePrice, upcomingMonths } from './dates.ts';
import type { Store, Watch } from './db.ts';
import { describeRoute, formatPrice } from './format.ts';
import {
  DEAL_DROP,
  DEFAULT_TRIP,
  describeTripLength,
  formatTrip,
  TRIP_LENGTHS,
  type Hunter,
  type Trip,
} from './hunter.ts';
import type { Place, PlaceSearch } from './places.ts';
import type { Incoming, InlineButton, Messenger } from './telegram.ts';

export const MENU = {
  hunt: '🔥 Горящие билеты',
  track: '✈️ Новое отслеживание',
  explore: '🌍 Куда угодно',
  list: '📋 Мои отслеживания',
  check: '🔄 Проверить цены',
  help: '❓ Помощь',
};
export const MENU_KEYBOARD = [[MENU.hunt], [MENU.explore, MENU.track], [MENU.list, MENU.check], [MENU.help]];

export const BOT_COMMANDS = [
  { command: 'hunt', description: 'Горящие билеты за границу' },
  { command: 'track', description: 'Новое отслеживание' },
  { command: 'anywhere', description: 'Самые дешёвые поездки сейчас' },
  { command: 'list', description: 'Мои отслеживания' },
  { command: 'check', description: 'Проверить цены сейчас' },
  { command: 'cancel', description: 'Отменить ввод' },
  { command: 'help', description: 'Как пользоваться' },
];

export const HELP = [
  'Привет! Я помогаю улететь за границу дёшево — куда угодно и когда угодно. ✈️',
  '',
  '<b>Как начать</b>',
  `Нажмите «${MENU.hunt}» — я буду сам просматривать все направления за границу из Астаны на любые даты (туда-обратно) и напишу, когда билет куда-то внезапно станет намного дешевле обычного.`,
  '',
  `«${MENU.explore}» — самые дешёвые поездки за границу из Астаны прямо сейчас.`,
  `«${MENU.track}» — если уже знаете, куда и когда летите: слежу за одним маршрутом.`,
  '',
  'Маршрут можно написать и одним сообщением, например:',
  '• <i>Шымкент Астана ноябрь</i>',
  '• <i>Алматы Стамбул 20.12 обратно 05.01 до 150000</i>',
  '',
  'Цены проверяю каждые 15 минут и пишу, только когда стало дешевле.',
].join('\n');

export type Step = 'origin' | 'destination' | 'depart' | 'return' | 'price';

/** An unfinished "new watch" or "edit watch" dialog, saved between messages. */
export interface Draft {
  origin?: Place;
  destination?: Place;
  departDate?: string;
  /** null = one way; undefined = not asked yet. */
  returnDate?: string | null;
  /** null = alert on any drop; undefined = not asked yet. */
  maxPrice?: number | null;
  /** City candidates shown as buttons for the current step. */
  options?: Place[];
  /** Set when changing one field of an existing watch instead of creating one. */
  edit?: { watchId: number; step: Step };
}

export function nextStep(draft: Draft): Step | null {
  if (!draft.origin) return 'origin';
  if (!draft.destination) return 'destination';
  if (!draft.departDate) return 'depart';
  if (draft.returnDate === undefined) return 'return';
  if (draft.maxPrice === undefined) return 'price';
  return null;
}

/** The question the dialog is waiting for an answer to. */
const currentStep = (draft: Draft): Step | null => draft.edit?.step ?? nextStep(draft);

const EDIT_FIELDS: { step: Step; label: string }[] = [
  { step: 'origin', label: '🛫 Откуда' },
  { step: 'destination', label: '🛬 Куда' },
  { step: 'depart', label: '📅 Дата вылета' },
  { step: 'return', label: '🔙 Обратный билет' },
  { step: 'price', label: '💰 Цена' },
];

const CANCEL: InlineButton = { text: '✖️ Отмена', data: 'cancel' };
const ONE_WAY = new Set(['нет', 'не нужен', 'не надо', 'в одну сторону', 'одну сторону', 'туда']);
const ANY_PRICE = new Set(['нет', 'любая', 'любой', 'без', 'без лимита', 'не важно', 'неважно', 'при любом']);
const FILLER_WORDS = new Set([
  'из', 'в', 'во', 'на', 'и', 'с', 'по', 'туда', 'обратно', 'назад', 'билет', 'билеты', 'рейс', 'хочу', 'лететь', 'полететь',
]);

const rows = <T>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

export class Conversation {
  private readonly store: Store;
  private readonly checker: PriceChecker;
  private readonly hunter: Hunter;
  private readonly messenger: Messenger;
  private readonly places: PlaceSearch;
  private readonly currency: string;
  private readonly today: () => string;

  constructor(
    store: Store,
    checker: PriceChecker,
    hunter: Hunter,
    messenger: Messenger,
    places: PlaceSearch,
    currency: string,
    today: () => string = () => new Date().toISOString().slice(0, 10),
  ) {
    this.store = store;
    this.checker = checker;
    this.hunter = hunter;
    this.messenger = messenger;
    this.places = places;
    this.currency = currency;
    this.today = today;
  }

  async handle(input: Incoming): Promise<void> {
    if (input.kind === 'button') return this.onButton(input.chatId, input.data);
    return this.onText(input.chatId, input.text.trim());
  }

  private send(chatId: number, text: string, buttons?: InlineButton[][]): Promise<void> {
    return this.messenger.send(chatId, text, buttons ? { buttons } : { menu: MENU_KEYBOARD });
  }

  // ---- text messages ----

  private async onText(chatId: number, text: string): Promise<void> {
    const [first = '', ...args] = text.split(/\s+/);
    // Strip the "@botname" suffix Telegram adds in group chats.
    const command = first.startsWith('/') ? first.toLowerCase().split('@')[0] : null;

    if (command === '/start' || command === '/help' || text === MENU.help) {
      await this.store.clearDraft(chatId);
      return this.send(chatId, HELP);
    }
    if (command === '/cancel') return this.cancel(chatId);
    if (command === '/track' || text === MENU.track) {
      return args.length > 0 && command ? this.quickStart(chatId, args.join(' ')) : this.startDraft(chatId);
    }
    if (command === '/hunt' || text === MENU.hunt) return this.showHunt(chatId);
    if (command === '/anywhere' || text === MENU.explore) return this.showCheapest(chatId);
    if (command === '/list' || text === MENU.list) return this.list(chatId);
    if (command === '/check' || text === MENU.check) return this.checkNow(chatId);
    if (command === '/remove') return this.remove(chatId, Number(args[0]?.replace('#', '')));
    if (command) return this.send(chatId, `Не знаю такую команду. Нажмите «${MENU.help}».`);

    const draft = await this.store.getDraft<Draft>(chatId);
    return draft ? this.answerStep(chatId, draft, text) : this.quickStart(chatId, text);
  }

  private async startDraft(chatId: number): Promise<void> {
    await this.advance(chatId, {});
  }

  private async cancel(chatId: number): Promise<void> {
    await this.store.clearDraft(chatId);
    await this.send(chatId, 'Хорошо, отменил.');
  }

  /** Handles an answer to the current question of the dialog. */
  private async answerStep(chatId: number, draft: Draft, text: string): Promise<void> {
    const step = currentStep(draft);
    const lower = text.toLowerCase();

    switch (step) {
      case 'origin':
      case 'destination': {
        const places = await this.places(text);
        if (places.length === 0) {
          return this.send(chatId, `Не нашёл город «${text}». Проверьте название и напишите ещё раз.`, [[CANCEL]]);
        }
        const exact = places.find((p) => p.name.toLowerCase() === lower);
        if (exact || places.length === 1) return this.pickPlace(chatId, draft, exact ?? places[0]!);
        draft.options = places;
        await this.store.setDraft(chatId, draft);
        return this.send(chatId, 'Какой именно город?', [
          ...places.map((p) => [{ text: `${p.name}, ${p.country}`, data: `place:${p.code}` }]),
          [CANCEL],
        ]);
      }
      case 'depart': {
        const date = parseDate(text, this.today());
        if (!date) return this.send(chatId, 'Не понял дату 🤔 Напишите, например, <i>20.11</i> или <i>ноябрь</i>.', [[CANCEL]]);
        return this.setDepart(chatId, draft, date);
      }
      case 'return': {
        if (ONE_WAY.has(lower)) {
          draft.returnDate = null;
          return this.advance(chatId, draft);
        }
        const date = parseDate(text, this.today());
        if (!date) {
          return this.send(chatId, 'Не понял дату 🤔 Напишите, например, <i>05.12</i>, или нажмите кнопку.', this.returnButtons());
        }
        if (date < draft.departDate!) {
          return this.send(chatId, 'Дата возвращения раньше вылета. Напишите другую дату.', this.returnButtons());
        }
        draft.returnDate = date;
        return this.advance(chatId, draft);
      }
      case 'price': {
        if (ANY_PRICE.has(lower)) {
          draft.maxPrice = null;
          return this.advance(chatId, draft);
        }
        const price = parsePrice(text);
        if (!price) return this.send(chatId, 'Напишите сумму числом, например <i>30000</i>, или нажмите кнопку.', this.priceButtons());
        draft.maxPrice = price;
        return this.advance(chatId, draft);
      }
      default:
        return this.advance(chatId, draft);
    }
  }

  private async setDepart(chatId: number, draft: Draft, date: string): Promise<void> {
    if (draft.returnDate && draft.returnDate < date) {
      return this.send(
        chatId,
        `Обратный вылет у вас ${formatDate(draft.returnDate)} — дата вылета должна быть раньше. Напишите другую дату.`,
        [[CANCEL]],
      );
    }
    draft.departDate = date;
    return this.advance(chatId, draft);
  }

  private async pickPlace(chatId: number, draft: Draft, place: Place): Promise<void> {
    const field = draft.edit?.step ?? (draft.origin ? 'destination' : 'origin');
    const other = field === 'origin' ? draft.destination : draft.origin;
    if (other?.code === place.code) {
      return this.send(chatId, `Город вылета и прилёта не может совпадать (${place.name}). Напишите другой город.`, [[CANCEL]]);
    }
    if (field === 'origin') draft.origin = place;
    else draft.destination = place;
    delete draft.options;
    await this.advance(chatId, draft);
  }

  /** Saves the draft and asks the next question, or saves the watch when everything is known. */
  private async advance(chatId: number, draft: Draft): Promise<void> {
    if (draft.edit) return this.applyEdit(chatId, draft);
    const step = nextStep(draft);
    if (!step) return this.finish(chatId, draft);
    await this.store.setDraft(chatId, draft);
    return this.ask(chatId, draft, step);
  }

  private async ask(chatId: number, draft: Draft, step: Step): Promise<void> {
    const route = draft.origin && draft.destination ? `${draft.origin.name} → ${draft.destination.name}` : '';
    switch (step) {
      case 'origin':
        return this.send(chatId, '✈️ <b>Откуда летим?</b>\nНапишите город, например: <i>Алматы</i>', [[CANCEL]]);
      case 'destination':
        return this.send(chatId, `Из города ${draft.origin!.name}. <b>Куда летим?</b>\nНапишите город, например: <i>Стамбул</i>`, [[CANCEL]]);
      case 'depart': {
        const months = upcomingMonths(this.today()).map((m) => ({ text: m.label, data: `month:${m.value}` }));
        return this.send(
          chatId,
          `${route}. <b>Когда летим?</b>\nВыберите месяц — найду самый дешёвый день. Или напишите точную дату, например <i>20.11</i>`,
          [...rows(months, 3), [CANCEL]],
        );
      }
      case 'return':
        return this.send(
          chatId,
          `Вылет: ${formatDate(draft.departDate!)}. <b>Нужен обратный билет?</b>\nНапишите дату возвращения, например <i>05.12</i>, или нажмите кнопку.`,
          this.returnButtons(),
        );
      case 'price': {
        const current = draft.edit && draft.maxPrice ? `Сейчас: не дороже ${formatPrice(draft.maxPrice, this.currency)}.\n` : '';
        return this.send(
          chatId,
          `${current}<b>Когда вам написать?</b>\nНапишите сумму, например <i>30000</i>, — сообщу, когда билет будет не дороже. Или нажмите кнопку.`,
          this.priceButtons(),
        );
      }
    }
  }

  private returnButtons(): InlineButton[][] {
    return [[{ text: '➡️ Только туда', data: 'oneway' }], [CANCEL]];
  }

  private priceButtons(): InlineButton[][] {
    return [[{ text: '📉 При любом снижении цены', data: 'anyprice' }], [CANCEL]];
  }

  private async finish(chatId: number, draft: Draft): Promise<void> {
    await this.store.clearDraft(chatId);
    const watch = await this.store.addWatch({
      chatId,
      origin: draft.origin!.code,
      destination: draft.destination!.code,
      originName: draft.origin!.name,
      destinationName: draft.destination!.name,
      departDate: draft.departDate!,
      returnDate: draft.returnDate ?? null,
      maxPrice: draft.maxPrice ?? null,
    });
    await this.created(chatId, watch);
  }

  private describeLimit(watch: Watch): string {
    return watch.maxPrice === null
      ? 'при любом снижении цены'
      : `когда цена будет не выше ${formatPrice(watch.maxPrice, this.currency)}`;
  }

  private async created(chatId: number, watch: Watch): Promise<void> {
    await this.send(
      chatId,
      `✅ <b>Готово!</b> Слежу за билетами:\n${describeRoute(watch)}\n\nНапишу ${this.describeLimit(watch)}. Сейчас посмотрю текущую цену…`,
    );
    await this.reportFirstCheck(chatId, watch);
  }

  /** Checks a new or changed watch; the checker itself sends the price unless it is above the max. */
  private async reportFirstCheck(chatId: number, watch: Watch): Promise<void> {
    try {
      const offer = await this.checker.check(watch);
      if (!offer) {
        await this.send(chatId, 'Пока билетов по этому направлению не нашлось. Продолжу проверять и напишу, когда появятся.');
      } else if (watch.maxPrice !== null && offer.price > watch.maxPrice) {
        await this.send(chatId, `Сейчас самый дешёвый билет стоит ${formatPrice(offer.price, this.currency)} — дороже вашей суммы. Жду, когда подешевеет.`);
      }
    } catch (error) {
      console.error(`Initial check of watch #${watch.id} failed:`, error);
      await this.send(chatId, 'Не получилось узнать цену прямо сейчас — попробую при следующей проверке.');
    }
  }

  // ---- cheapest destinations ----

  private async showCheapest(chatId: number): Promise<void> {
    await this.store.clearDraft(chatId);
    const home = this.hunter.home;
    let trips: Trip[];
    try {
      trips = (await this.hunter.trips(DEFAULT_TRIP)).slice(0, 10);
    } catch (error) {
      console.error('Explore search failed:', error);
      return this.send(chatId, 'Не получилось загрузить цены 😕 Попробуйте чуть позже.');
    }
    const huntButton = (await this.store.getHunt(chatId)) ? [] : [[{ text: '🔥 Ловить горящие билеты', data: 'hon' }]];
    if (trips.length === 0) {
      return this.send(chatId, `Из города ${home.name} билетов за границу пока не нашлось. Попробуйте чуть позже.`, huntButton);
    }

    const lines = trips.map((trip, i) => formatTrip(trip, this.currency, `${i + 1}. ${trip.city.name}`));
    const follow = trips.slice(0, 6).map(({ offer, city }) => ({
      text: `🔔 ${city.name}`,
      data: `follow:${home.code}.${offer.destination}.${offer.departureAt.slice(0, 10)}.${offer.returnAt!.slice(0, 10)}`,
    }));
    await this.send(
      chatId,
      `🌍 <b>Самые дешёвые поездки за границу из города ${home.name}</b> (туда-обратно на ${describeTripLength(DEFAULT_TRIP)}, ближайшие даты):\n\n${lines.join('\n\n')}\n\nНажмите 🔔, чтобы я следил за ценой на эти даты.`,
      [...rows(follow, 2), ...huntButton],
    );
  }

  private async follow(chatId: number, value: string): Promise<void> {
    // Old buttons carry a month and no return date.
    const [origin, destination, departDate, returnDate] = value.split('.');
    if (!origin || !destination || !departDate) return;
    const cities = await this.hunter.cities([origin, destination]);
    const watch = await this.store.addWatch({
      chatId,
      origin,
      destination,
      originName: cities.get(origin)?.name ?? origin,
      destinationName: cities.get(destination)?.name ?? destination,
      departDate,
      returnDate: returnDate ?? null,
      maxPrice: null,
    });
    await this.created(chatId, watch);
  }

  // ---- ticket hunter ----

  private async showHunt(chatId: number): Promise<void> {
    await this.store.clearDraft(chatId);
    const hunt = await this.store.getHunt(chatId);
    if (!hunt) return this.startHunt(chatId);
    await this.send(
      chatId,
      [
        '🔥 <b>Ловлю горящие билеты</b>',
        `Из города ${this.hunter.home.name} во все страны, на любые даты, туда-обратно на ${describeTripLength(hunt)}`,
        '',
        `Проверяю каждые 15 минут и пишу, когда билет куда-то стал дешевле обычного на ${Math.round(DEAL_DROP * 100)}% и больше.`,
      ].join('\n'),
      [
        [{ text: '🔎 Лучшее сейчас', data: 'hbest' }],
        [
          { text: '📅 Длительность', data: 'hlen' },
          { text: '⏹ Выключить', data: 'hoff' },
        ],
      ],
    );
  }

  private async startHunt(chatId: number): Promise<void> {
    await this.store.saveHunt({ chatId, ...DEFAULT_TRIP });
    await this.send(
      chatId,
      `🔥 <b>Включил охоту за горящими билетами.</b>\nСлежу за всеми направлениями за границу из города ${this.hunter.home.name}, на любые даты. Как только билет куда-то станет намного дешевле обычного — напишу.\n\nСейчас посмотрю, что есть…`,
    );
    await this.showBest(chatId);
  }

  /** Scans the hunt now and shows the cheapest trips (the scan itself reports deals). */
  private async showBest(chatId: number): Promise<void> {
    const hunt = await this.store.getHunt(chatId);
    if (!hunt) return this.showHunt(chatId);
    let trips: Trip[];
    try {
      trips = (await this.hunter.scan(hunt)).trips;
    } catch (error) {
      console.error('Hunt scan failed:', error);
      return this.send(chatId, 'Не получилось загрузить цены 😕 Попробую при следующей проверке.', [[{ text: '🔥 Горящие билеты', data: 'hunt' }]]);
    }
    const best = trips.slice(0, 10);
    if (best.length === 0) {
      return this.send(
        chatId,
        'Пока билетов за границу не нашлось — данные появляются, когда их кто-то ищет. Продолжу проверять и напишу, когда что-то подешевеет.',
        [[{ text: '🔥 Горящие билеты', data: 'hunt' }]],
      );
    }
    const lines = best.map((trip, i) => formatTrip(trip, this.currency, `${i + 1}. ${trip.city.name}`));
    await this.send(
      chatId,
      `🌍 <b>Самые дешёвые поездки из города ${this.hunter.home.name} сейчас</b> (туда-обратно на ${describeTripLength(hunt)}):\n\n${lines.join('\n\n')}\n\nЗапомнил эти цены. Напишу, когда что-то станет дешевле обычного на ${Math.round(DEAL_DROP * 100)}% и больше.`,
      [[{ text: '🔥 Горящие билеты', data: 'hunt' }]],
    );
  }

  private async stopHunt(chatId: number): Promise<void> {
    await this.store.removeHunt(chatId);
    await this.send(chatId, '⏹ Слежение за горящими билетами выключено. Включить снова можно в любой момент.', [[{ text: MENU.hunt, data: 'hunt' }]]);
  }

  private async askTripLength(chatId: number): Promise<void> {
    const buttons = TRIP_LENGTHS.map((t) => ({ text: t.label, data: `hlenset:${t.minDays}-${t.maxDays}` }));
    await this.send(chatId, '📅 <b>На сколько дней летим?</b>', [...rows(buttons, 2), [CANCEL]]);
  }

  private async setTripLength(chatId: number, value: string): Promise<void> {
    const trip = TRIP_LENGTHS.find((t) => `${t.minDays}-${t.maxDays}` === value);
    const hunt = await this.store.getHunt(chatId);
    if (!trip || !hunt) return this.showHunt(chatId);
    await this.store.saveHunt({ ...hunt, minDays: trip.minDays, maxDays: trip.maxDays });
    // Usual prices of other trip lengths do not compare.
    await this.store.clearHuntPrices(chatId);
    await this.send(chatId, `✅ Сохранил: поездка на ${describeTripLength(trip)}`);
    await this.showBest(chatId);
  }

  // ---- editing ----

  private async showEditMenu(chatId: number, id: number): Promise<void> {
    const watch = (await this.store.listWatches(chatId)).find((w) => w.id === id);
    if (!watch) return this.send(chatId, 'Этого отслеживания уже нет.');
    await this.store.clearDraft(chatId);
    const buttons = EDIT_FIELDS.map((f) => ({ text: f.label, data: `editf:${id}.${f.step}` }));
    await this.send(
      chatId,
      `✏️ <b>Что изменить?</b>\n${describeRoute(watch)}\nНапишу ${this.describeLimit(watch)}.`,
      [...rows(buttons, 2), [CANCEL]],
    );
  }

  private async startEdit(chatId: number, id: number, step: Step): Promise<void> {
    const watch = (await this.store.listWatches(chatId)).find((w) => w.id === id);
    if (!watch) return this.send(chatId, 'Этого отслеживания уже нет.');
    const draft: Draft = {
      origin: { code: watch.origin, name: watch.originName ?? watch.origin, country: '', countryCode: '' },
      destination: { code: watch.destination, name: watch.destinationName ?? watch.destination, country: '', countryCode: '' },
      departDate: watch.departDate,
      returnDate: watch.returnDate,
      maxPrice: watch.maxPrice,
      edit: { watchId: id, step },
    };
    await this.store.setDraft(chatId, draft);
    await this.ask(chatId, draft, step);
  }

  private async applyEdit(chatId: number, draft: Draft): Promise<void> {
    const { watchId, step } = draft.edit!;
    // A new route or dates make the old prices meaningless; a new max price does not.
    const resetPrices = step !== 'price';
    await this.store.clearDraft(chatId);
    const watch = await this.store.updateWatch(
      chatId,
      watchId,
      {
        origin: draft.origin!.code,
        destination: draft.destination!.code,
        originName: draft.origin!.name,
        destinationName: draft.destination!.name,
        departDate: draft.departDate!,
        returnDate: draft.returnDate ?? null,
        maxPrice: draft.maxPrice ?? null,
      },
      resetPrices,
    );
    if (!watch) return this.send(chatId, 'Этого отслеживания уже нет.');

    if (resetPrices) {
      await this.send(chatId, `✅ <b>Сохранил.</b> Теперь слежу:\n${describeRoute(watch)}\n\nСейчас посмотрю цену…`);
      return this.reportFirstCheck(chatId, watch);
    }
    const now = watch.lastPrice === null ? '' : `\nСейчас самый дешёвый билет: ${formatPrice(watch.lastPrice, this.currency)}.`;
    await this.send(chatId, `✅ <b>Сохранил.</b> Напишу ${this.describeLimit(watch)}.${now}`);
  }

  /**
   * Understands a free-form message like "Шымкент Астана ноябрь до 30000",
   * fills in what it can and asks for the rest.
   */
  private async quickStart(chatId: number, text: string): Promise<void> {
    const today = this.today();
    const tokens = text.toLowerCase().replace(/[→—–,;]/g, ' ').split(/\s+/).filter(Boolean);
    const draft: Draft = {};
    const words: string[] = [];

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      // Dates: "20 ноября 2026", "20 ноября", "ноябрь 2026", "20.11", "ноябрь".
      const date = [3, 2, 1]
        .map((n) => tokens.slice(i, i + n))
        .filter((part) => part.length === 1 || /\d/.test(part[0]!) || monthIndex(part[0]!) >= 0)
        .map((part) => ({ length: part.length, date: parseDate(part.join(' '), today) }))
        .find((candidate) => candidate.date);
      if (date?.date) {
        if (!draft.departDate) draft.departDate = date.date;
        else if (draft.returnDate === undefined) draft.returnDate = date.date;
        i += date.length - 1;
        continue;
      }
      if (token === 'до' || /^\d/.test(token)) {
        const price = parsePrice(token === 'до' ? (tokens[++i] ?? '') : token);
        if (price && price >= 1000) draft.maxPrice = price;
        continue;
      }
      if (!FILLER_WORDS.has(token)) words.push(token);
    }

    if (words.length > 2 || (words.length === 0 && !draft.departDate)) {
      return this.send(
        chatId,
        `Не совсем понял 🤔\nНажмите «${MENU.track}» — я задам пару вопросов. Или напишите, например: <i>Шымкент Астана ноябрь</i>`,
      );
    }

    const notFound: string[] = [];
    for (const word of words) {
      const [place] = await this.places(word);
      if (!place) notFound.push(word);
      else if (!draft.origin) draft.origin = place;
      else if (place.code !== draft.origin.code) draft.destination = place;
    }
    if (draft.departDate && draft.returnDate && draft.returnDate < draft.departDate) delete draft.returnDate;

    if (notFound.length > 0) {
      await this.send(chatId, `Не нашёл город «${notFound.join('», «')}» — уточню отдельно.`, [[CANCEL]]);
    }
    await this.advance(chatId, draft);
  }

  // ---- buttons ----

  private async onButton(chatId: number, data: string): Promise<void> {
    const [action = '', value = ''] = data.split(':');
    if (action === 'cancel') return this.cancel(chatId);
    if (action === 'new') return this.startDraft(chatId);
    if (action === 'explore') return this.showCheapest(chatId);
    if (action === 'hunt' || action === 'hon') return this.showHunt(chatId);
    if (action === 'hbest') return this.showBest(chatId);
    if (action === 'hoff') return this.stopHunt(chatId);
    if (action === 'hlen') return this.askTripLength(chatId);
    if (action === 'hlenset') return this.setTripLength(chatId, value);
    if (action === 'follow') return this.follow(chatId, value);
    if (action === 'del') return this.remove(chatId, Number(value));
    if (action === 'edit') return this.showEditMenu(chatId, Number(value));
    if (action === 'editf') {
      const [id, field] = value.split('.');
      if (EDIT_FIELDS.some((f) => f.step === field)) return this.startEdit(chatId, Number(id), field as Step);
    }

    const draft = await this.store.getDraft<Draft>(chatId);
    const step = draft && currentStep(draft);
    if (!draft || !step) {
      return this.send(chatId, `Эти кнопки уже устарели. Нажмите «${MENU.track}», чтобы начать заново.`);
    }

    if (action === 'place' && (step === 'origin' || step === 'destination')) {
      const place = draft.options?.find((p) => p.code === value);
      if (place) return this.pickPlace(chatId, draft, place);
    } else if (action === 'month' && step === 'depart') {
      return this.setDepart(chatId, draft, value);
    } else if (action === 'oneway' && step === 'return') {
      draft.returnDate = null;
      return this.advance(chatId, draft);
    } else if (action === 'anyprice' && step === 'price') {
      draft.maxPrice = null;
      return this.advance(chatId, draft);
    }
    // A button from an earlier question: repeat the current one.
    return this.ask(chatId, draft, step);
  }

  // ---- list / remove / check ----

  private async list(chatId: number): Promise<void> {
    const watches = await this.store.listWatches(chatId);
    if (watches.length === 0) {
      return this.send(chatId, 'Пока ни за одним маршрутом не слежу.', [
        [{ text: MENU.hunt, data: 'hunt' }],
        [{ text: MENU.track, data: 'new' }],
      ]);
    }
    const lines = await Promise.all(
      watches.map(async (watch, i) => {
        const parts: string[] = [];
        parts.push(watch.lastPrice === null ? 'цена пока неизвестна' : `сейчас ${formatPrice(watch.lastPrice, this.currency)}`);
        const min = await this.store.minPrice(watch.id);
        if (min !== null && min !== watch.lastPrice) parts.push(`минимум был ${formatPrice(min, this.currency)}`);
        if (watch.maxPrice !== null) parts.push(`жду ≤ ${formatPrice(watch.maxPrice, this.currency)}`);
        return `<b>${i + 1}.</b> ${describeRoute(watch)}\n     ${parts.join(' · ')}`;
      }),
    );
    const buttons = watches.map((watch, i) => [
      { text: `✏️ Изменить ${i + 1}`, data: `edit:${watch.id}` },
      { text: `🗑 Удалить ${i + 1}`, data: `del:${watch.id}` },
    ]);
    await this.send(chatId, `📋 <b>Ваши отслеживания</b>\n\n${lines.join('\n\n')}`, [
      ...buttons,
      [{ text: '➕ Добавить ещё', data: 'new' }],
    ]);
  }

  private async remove(chatId: number, id: number): Promise<void> {
    if (!Number.isInteger(id)) return this.send(chatId, `Откройте «${MENU.list}» и нажмите 🗑 у нужного маршрута.`);
    const watch = (await this.store.listWatches(chatId)).find((w) => w.id === id);
    if (!watch || !(await this.store.removeWatch(chatId, id))) {
      return this.send(chatId, 'Этого отслеживания уже нет.');
    }
    await this.send(chatId, `🗑 Больше не слежу: ${describeRoute(watch)}`);
  }

  private async checkNow(chatId: number): Promise<void> {
    const watches = await this.store.listWatches(chatId);
    if (watches.length === 0) {
      if (await this.store.getHunt(chatId)) return this.showBest(chatId);
      return this.send(chatId, 'Пока ничего не отслеживаю.', [
        [{ text: MENU.hunt, data: 'hunt' }],
        [{ text: MENU.track, data: 'new' }],
      ]);
    }
    let failed = 0;
    let found = 0;
    for (const watch of watches) {
      try {
        const offer = await this.checker.check(watch);
        if (offer && watch.lastPrice !== null && offer.price < watch.lastPrice) found++;
      } catch (error) {
        failed++;
        console.error(`Check of watch #${watch.id} failed:`, error);
      }
    }
    const summary = found > 0 ? `Подешевело: ${found} — подробности выше.` : 'Цены не снизились.';
    const errors = failed > 0 ? `\nНе удалось проверить: ${failed}, попробую позже.` : '';
    await this.send(chatId, `🔄 Проверил ${watches.length} маршрут(а). ${summary}${errors}`);
  }
}
