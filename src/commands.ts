import type { PriceChecker } from './checker.ts';
import { formatDate, monthIndex, parseDate, parsePrice, upcomingMonths } from './dates.ts';
import type { Store, Watch } from './db.ts';
import { describeRoute, formatPrice } from './format.ts';
import type { Place, PlaceSearch } from './places.ts';
import type { Incoming, InlineButton, Messenger } from './telegram.ts';

export const MENU = {
  track: '✈️ Новое отслеживание',
  list: '📋 Мои отслеживания',
  check: '🔄 Проверить цены',
  help: '❓ Помощь',
};
export const MENU_KEYBOARD = [[MENU.track], [MENU.list, MENU.check], [MENU.help]];

export const BOT_COMMANDS = [
  { command: 'track', description: 'Новое отслеживание' },
  { command: 'list', description: 'Мои отслеживания' },
  { command: 'check', description: 'Проверить цены сейчас' },
  { command: 'cancel', description: 'Отменить ввод' },
  { command: 'help', description: 'Как пользоваться' },
];

export const HELP = [
  'Привет! Я слежу за ценами на авиабилеты и пишу, когда билет дешевеет. ✈️',
  '',
  '<b>Как начать</b>',
  `Нажмите «${MENU.track}» — я спрошу, откуда, куда и когда вы летите.`,
  '',
  'Или напишите всё одним сообщением, например:',
  '• <i>Шымкент Астана ноябрь</i>',
  '• <i>Алматы Стамбул 20.12 обратно 05.01 до 150000</i>',
  '',
  'Цены проверяю каждые 15 минут и пишу, только когда стало дешевле.',
].join('\n');

/** An unfinished "new watch" dialog, saved between messages. */
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
}

type Step = 'origin' | 'destination' | 'depart' | 'return' | 'price';

export function nextStep(draft: Draft): Step | null {
  if (!draft.origin) return 'origin';
  if (!draft.destination) return 'destination';
  if (!draft.departDate) return 'depart';
  if (draft.returnDate === undefined) return 'return';
  if (draft.maxPrice === undefined) return 'price';
  return null;
}

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
  private readonly messenger: Messenger;
  private readonly places: PlaceSearch;
  private readonly currency: string;
  private readonly today: () => string;

  constructor(
    store: Store,
    checker: PriceChecker,
    messenger: Messenger,
    places: PlaceSearch,
    currency: string,
    today: () => string = () => new Date().toISOString().slice(0, 10),
  ) {
    this.store = store;
    this.checker = checker;
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
    const step = nextStep(draft);
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
        draft.departDate = date;
        return this.advance(chatId, draft);
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

  private async pickPlace(chatId: number, draft: Draft, place: Place): Promise<void> {
    if (draft.origin && place.code === draft.origin.code) {
      return this.send(chatId, `Вы уже вылетаете из города ${place.name}. Куда летим?`, [[CANCEL]]);
    }
    if (draft.origin) draft.destination = place;
    else draft.origin = place;
    delete draft.options;
    await this.advance(chatId, draft);
  }

  /** Saves the draft and asks the next question, or creates the watch when everything is known. */
  private async advance(chatId: number, draft: Draft): Promise<void> {
    const step = nextStep(draft);
    if (!step) return this.finish(chatId, draft);
    await this.store.setDraft(chatId, draft);

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
      case 'price':
        return this.send(
          chatId,
          `<b>Когда вам написать?</b>\nНапишите сумму, например <i>30000</i>, — сообщу, когда билет будет не дороже. Или нажмите кнопку.`,
          this.priceButtons(),
        );
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

  private async created(chatId: number, watch: Watch): Promise<void> {
    const limit = watch.maxPrice === null ? 'при любом снижении цены' : `когда цена будет не выше ${formatPrice(watch.maxPrice, this.currency)}`;
    await this.send(chatId, `✅ <b>Готово!</b> Слежу за билетами:\n${describeRoute(watch)}\n\nНапишу ${limit}. Сейчас посмотрю текущую цену…`);

    try {
      // The checker reports the current price itself unless it is above the max.
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
    if (action === 'del') return this.remove(chatId, Number(value));

    const draft = await this.store.getDraft<Draft>(chatId);
    const step = draft && nextStep(draft);
    if (!draft || !step) {
      return this.send(chatId, `Эти кнопки уже устарели. Нажмите «${MENU.track}», чтобы начать заново.`);
    }

    if (action === 'place' && (step === 'origin' || step === 'destination')) {
      const place = draft.options?.find((p) => p.code === value);
      if (place) return this.pickPlace(chatId, draft, place);
    } else if (action === 'month' && step === 'depart') {
      draft.departDate = value;
      return this.advance(chatId, draft);
    } else if (action === 'oneway' && step === 'return') {
      draft.returnDate = null;
      return this.advance(chatId, draft);
    } else if (action === 'anyprice' && step === 'price') {
      draft.maxPrice = null;
      return this.advance(chatId, draft);
    }
    // A button from an earlier question: repeat the current one.
    return this.advance(chatId, draft);
  }

  // ---- list / remove / check ----

  private async list(chatId: number): Promise<void> {
    const watches = await this.store.listWatches(chatId);
    if (watches.length === 0) {
      return this.send(chatId, 'Пока ничего не отслеживаю.', [[{ text: MENU.track, data: 'new' }]]);
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
    const buttons = watches.map((watch, i) => ({ text: `🗑 Удалить ${i + 1}`, data: `del:${watch.id}` }));
    await this.send(chatId, `📋 <b>Ваши отслеживания</b>\n\n${lines.join('\n\n')}`, [
      ...rows(buttons, 3),
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
      return this.send(chatId, 'Пока ничего не отслеживаю.', [[{ text: MENU.track, data: 'new' }]]);
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
