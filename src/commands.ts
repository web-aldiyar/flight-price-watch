import type { PriceChecker } from './checker.ts';
import type { NewWatch, Store } from './db.ts';
import { describeRoute, formatPrice } from './format.ts';
import type { Messenger } from './telegram.ts';

export const HELP = [
  'Я слежу за ценами на авиабилеты и пишу, когда они падают.',
  '',
  '<b>Команды</b>',
  '/track ALA IST 2026-12-20 — рейс в одну сторону на дату',
  '/track ALA IST 2026-12 — самый дешёвый в течение месяца',
  '/track ALA IST 2026-12-20 2027-01-05 — туда-обратно',
  '/track ALA IST 2026-12-20 max=60000 — уведомлять только при цене не выше 60000',
  '/list — мои отслеживания',
  '/remove 3 — удалить отслеживание #3',
  '/check — проверить цены сейчас',
  '',
  'Города и аэропорты — IATA-коды (MOW, ALA, NQZ, IST ...).',
].join('\n');

export const BOT_COMMANDS = [
  { command: 'track', description: 'Следить за маршрутом' },
  { command: 'list', description: 'Мои отслеживания' },
  { command: 'remove', description: 'Удалить отслеживание' },
  { command: 'check', description: 'Проверить цены сейчас' },
  { command: 'help', description: 'Помощь' },
];

const IATA = /^[A-Z]{3}$/;
const DATE = /^\d{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?$/;

export type ParseResult = { ok: true; watch: Omit<NewWatch, 'chatId'> } | { ok: false; error: string };

export function parseTrackArgs(args: string[], today: string): ParseResult {
  const positional = args.filter((arg) => !arg.includes('='));
  const options = new Map(
    args.filter((arg) => arg.includes('=')).map((arg) => arg.split('=', 2) as [string, string]),
  );

  const [origin, destination, departDate, returnDate, ...rest] = positional.map((arg) => arg.toUpperCase());
  if (!origin || !destination || !departDate || rest.length > 0) {
    return { ok: false, error: 'Формат: /track ОТКУДА КУДА ДАТА [ДАТА_ОБРАТНО] [max=ЦЕНА]' };
  }
  if (!IATA.test(origin) || !IATA.test(destination)) {
    return { ok: false, error: 'Город указывается трёхбуквенным IATA-кодом, например ALA или MOW.' };
  }
  if (origin === destination) return { ok: false, error: 'Пункты вылета и прилёта совпадают.' };

  for (const date of [departDate, returnDate]) {
    if (date !== undefined && !DATE.test(date)) {
      return { ok: false, error: `Неверная дата «${date}». Используйте ГГГГ-ММ-ДД или ГГГГ-ММ.` };
    }
  }
  // Compare at the precision the user gave: a month is in the past only once it has ended.
  if (departDate < today.slice(0, departDate.length)) {
    return { ok: false, error: 'Дата вылета уже прошла.' };
  }
  if (returnDate && returnDate < departDate) {
    return { ok: false, error: 'Дата возвращения раньше даты вылета.' };
  }

  let maxPrice: number | null = null;
  const max = options.get('max');
  if (max !== undefined) {
    maxPrice = Number(max);
    if (!Number.isInteger(maxPrice) || maxPrice <= 0) {
      return { ok: false, error: 'max должен быть положительным целым числом.' };
    }
  }
  for (const key of options.keys()) {
    if (key !== 'max') return { ok: false, error: `Неизвестный параметр «${key}».` };
  }

  return { ok: true, watch: { origin, destination, departDate, returnDate: returnDate ?? null, maxPrice } };
}

export class CommandHandler {
  private readonly store: Store;
  private readonly checker: PriceChecker;
  private readonly messenger: Messenger;
  private readonly currency: string;
  private readonly today: () => string;

  constructor(
    store: Store,
    checker: PriceChecker,
    messenger: Messenger,
    currency: string,
    today: () => string = () => new Date().toISOString().slice(0, 10),
  ) {
    this.store = store;
    this.checker = checker;
    this.messenger = messenger;
    this.currency = currency;
    this.today = today;
  }

  /** Handles a message and returns the reply text (null for no reply). */
  async handle(chatId: number, text: string): Promise<string | null> {
    const [rawCommand = '', ...args] = text.trim().split(/\s+/);
    // Strip the "@botname" suffix Telegram adds in group chats.
    const command = rawCommand.toLowerCase().split('@')[0];

    switch (command) {
      case '/start':
      case '/help':
        return HELP;
      case '/track':
        return this.track(chatId, args);
      case '/list':
        return this.list(chatId);
      case '/remove':
        return this.remove(chatId, args[0]);
      case '/check':
        return this.checkNow(chatId);
      default:
        return command?.startsWith('/') ? 'Неизвестная команда. /help — список команд.' : null;
    }
  }

  private async track(chatId: number, args: string[]): Promise<string | null> {
    const parsed = parseTrackArgs(args, this.today());
    if (!parsed.ok) return parsed.error;

    const watch = this.store.addWatch({ chatId, ...parsed.watch });
    const limit =
      watch.maxPrice === null ? '' : `\nУведомлю, когда цена будет не выше ${formatPrice(watch.maxPrice, this.currency)}.`;
    await this.messenger.send(chatId, `Слежу #${watch.id}: ${describeRoute(watch)}${limit}`);

    try {
      // The checker reports the current price itself unless it is above the max.
      const offer = await this.checker.check(watch);
      if (!offer) return 'Пока билетов в кэше Aviasales не найдено — продолжу проверять.';
      if (watch.maxPrice !== null && offer.price > watch.maxPrice) {
        return `Сейчас самый дешёвый билет ${formatPrice(offer.price, this.currency)} — выше порога, жду снижения.`;
      }
      return null;
    } catch (error) {
      console.error(`Initial check of watch #${watch.id} failed:`, error);
      return 'Не удалось получить цену сейчас — попробую при следующей проверке.';
    }
  }

  private list(chatId: number): string {
    const watches = this.store.listWatches(chatId);
    if (watches.length === 0) return 'Отслеживаний нет. Добавьте: /track ALA IST 2026-12-20';
    return watches
      .map((watch) => {
        const last = watch.lastPrice === null ? 'цена ещё неизвестна' : formatPrice(watch.lastPrice, this.currency);
        const min = this.store.minPrice(watch.id);
        const minText = min === null || min === watch.lastPrice ? '' : `, минимум ${formatPrice(min, this.currency)}`;
        const limit = watch.maxPrice === null ? '' : `, порог ${formatPrice(watch.maxPrice, this.currency)}`;
        return `#${watch.id} ${describeRoute(watch)}\n   ${last}${minText}${limit}`;
      })
      .join('\n');
  }

  private remove(chatId: number, rawId: string | undefined): string {
    const id = Number(rawId?.replace('#', ''));
    if (!Number.isInteger(id)) return 'Укажите номер: /remove 3';
    return this.store.removeWatch(chatId, id) ? `Отслеживание #${id} удалено.` : `Отслеживание #${id} не найдено.`;
  }

  private async checkNow(chatId: number): Promise<string> {
    const watches = this.store.listWatches(chatId);
    if (watches.length === 0) return 'Отслеживаний нет.';
    let failed = 0;
    for (const watch of watches) {
      try {
        await this.checker.check(watch);
      } catch (error) {
        failed++;
        console.error(`Check of watch #${watch.id} failed:`, error);
      }
    }
    const errors = failed > 0 ? ` Не удалось проверить: ${failed}.` : '';
    return `Проверено отслеживаний: ${watches.length}.${errors} Если цена упала — я уже написал.`;
  }
}
