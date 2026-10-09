import { createHash, timingSafeEqual } from 'node:crypto';
import { createAviasalesSource, createExploreSource, type ExploreSource, type PriceSource } from './aviasales.ts';
import { PriceChecker } from './checker.ts';
import { BOT_COMMANDS, Conversation } from './commands.ts';
import type { Config } from './config.ts';
import { Store, type Query } from './db.ts';
import { createPlaceSearch, type PlaceSearch } from './places.ts';
import { parseUpdate, TelegramBot, type Incoming, type Update } from './telegram.ts';

export interface App {
  bot: TelegramBot;
  checker: PriceChecker;
  handleUpdate(update: Incoming): Promise<void>;
}

export interface AppDeps {
  query: Query;
  fetchFn?: typeof fetch;
  priceSource?: PriceSource;
  placeSearch?: PlaceSearch;
  exploreSource?: ExploreSource;
  today?: () => string;
}

export function createApp(config: Config, deps: AppDeps): App {
  const store = new Store(deps.query);
  const bot = new TelegramBot(config.telegramToken, deps.fetchFn);
  const source = deps.priceSource ?? createAviasalesSource(config.travelpayoutsToken, config.currency, deps.fetchFn);
  const places = deps.placeSearch ?? createPlaceSearch(deps.fetchFn);
  const checker = new PriceChecker(store, source, bot, config.currency);
  const explore = deps.exploreSource ?? createExploreSource(config.travelpayoutsToken, config.currency, deps.fetchFn);
  const conversation = new Conversation(store, checker, bot, places, explore, config.currency, deps.today);

  return {
    bot,
    checker,
    async handleUpdate(update) {
      try {
        if (update.kind === 'button') {
          await bot.answerButton(update.callbackId).catch((error: unknown) => console.error('answerCallbackQuery failed:', error));
        }
        if (config.allowedChatIds && !config.allowedChatIds.has(update.chatId)) {
          await bot.send(update.chatId, 'Доступ к боту ограничен.');
          return;
        }
        await conversation.handle(update);
      } catch (error) {
        console.error('Failed to handle update:', error);
        await bot
          .send(update.chatId, 'Что-то пошло не так 😕 Попробуйте ещё раз чуть позже.')
          .catch(() => {});
      }
    },
  };
}

/** Telegram allows only [A-Za-z0-9_-] in the webhook secret, so derive a hex one. */
export const webhookSecret = (cronSecret: string): string =>
  createHash('sha256').update(`telegram-webhook:${cronSecret}`).digest('hex');

const safeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

const text = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });

/**
 * HTTP API for serverless hosting:
 * - POST /api/telegram  Telegram webhook (checked via the secret token header)
 * - POST /api/check     check all prices; called on a schedule (Bearer CRON_SECRET)
 * - GET  /api/setup     register the webhook and bot commands (Bearer CRON_SECRET or ?key=)
 */
export function createHttpHandler(app: App, cronSecret: string): (request: Request) => Promise<Response> {
  const hookSecret = webhookSecret(cronSecret);
  const authorized = (request: Request): boolean => {
    const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
    const key = bearer ?? new URL(request.url).searchParams.get('key') ?? '';
    return safeEqual(key, cronSecret);
  };

  return async (request) => {
    const url = new URL(request.url);

    switch (url.pathname) {
      case '/api/telegram': {
        if (request.method !== 'POST') return text('Method Not Allowed', 405);
        if (!safeEqual(request.headers.get('x-telegram-bot-api-secret-token') ?? '', hookSecret)) {
          return text('Unauthorized', 401);
        }
        const update = parseUpdate((await request.json()) as Update);
        // Reply before responding: the function may be frozen as soon as the response is sent.
        if (update) await app.handleUpdate(update);
        return text('ok');
      }
      case '/api/check': {
        if (!authorized(request)) return text('Unauthorized', 401);
        return Response.json(await app.checker.checkAll());
      }
      case '/api/setup': {
        if (!authorized(request)) return text('Unauthorized', 401);
        const webhookUrl = `${url.origin}/api/telegram`;
        await app.bot.setWebhook(webhookUrl, hookSecret);
        await app.bot.setCommands(BOT_COMMANDS);
        return text(`Готово: Telegram будет присылать сообщения на ${webhookUrl}`);
      }
      case '/api/health':
        return text('ok');
      default:
        return text('Not Found', 404);
    }
  };
}
