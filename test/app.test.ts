import { beforeEach, describe, expect, it } from 'vitest';
import { createApp, createHttpHandler, webhookSecret } from '../src/app.ts';
import type { Config } from '../src/config.ts';
import { fakePlaces, memoryQuery, scriptedSource } from './helpers.ts';

const SECRET = 'cron-secret-123';
const BASE = 'https://flights.example.vercel.app';

const config: Config = {
  telegramToken: 'bot-token',
  travelpayoutsToken: 'tp-token',
  currency: 'kzt',
  databaseUrl: undefined,
  cronSecret: SECRET,
  checkIntervalMinutes: 60,
  allowedChatIds: null,
};

/** Records Telegram Bot API calls instead of sending them. */
function telegramFetch() {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ method: url.split('/').pop()!, body: JSON.parse(String(init?.body)) });
    return Response.json({ ok: true, result: true });
  }) as typeof fetch;
  return { calls, fetchFn };
}

const update = (text: string, chatId = 42) => ({ update_id: 1, message: { chat: { id: chatId }, text } });

describe('HTTP handler', () => {
  let telegram: ReturnType<typeof telegramFetch>;
  let handle: (request: Request) => Promise<Response>;

  const setup = (prices: (number | null)[] = [], overrides: Partial<Config> = {}) => {
    telegram = telegramFetch();
    const app = createApp(
      { ...config, ...overrides },
      { query: memoryQuery(), fetchFn: telegram.fetchFn, priceSource: scriptedSource(prices), placeSearch: fakePlaces },
    );
    handle = createHttpHandler(app, SECRET);
  };

  const webhook = (body: unknown, secret = webhookSecret(SECRET)) =>
    handle(
      new Request(`${BASE}/api/telegram`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
        body: JSON.stringify(body),
      }),
    );

  beforeEach(() => setup());

  it('answers a command received through the webhook', async () => {
    const response = await webhook(update('/help'));

    expect(response.status).toBe(200);
    expect(telegram.calls).toEqual([
      { method: 'sendMessage', body: expect.objectContaining({ chat_id: 42, text: expect.stringContaining('Как начать') }) },
    ]);
  });

  it('rejects webhook calls without the secret token', async () => {
    const response = await webhook(update('/help'), 'wrong');

    expect(response.status).toBe(401);
    expect(telegram.calls).toHaveLength(0);
  });

  it('acknowledges updates without text', async () => {
    expect((await webhook({ update_id: 2, edited_message: {} })).status).toBe(200);
    expect(telegram.calls).toHaveLength(0);
  });

  it('refuses chats outside ALLOWED_CHAT_IDS', async () => {
    setup([], { allowedChatIds: new Set([1]) });
    await webhook(update('/list', 42));

    expect(telegram.calls[0]?.body['text']).toContain('ограничен');
  });

  it('checks prices for tracked routes when authorized', async () => {
    setup([50000, 45000]);
    await webhook(update('/track ALA IST 2099-12-20'));
    await webhook(update('нет')); // no return ticket
    await webhook({
      update_id: 3,
      callback_query: { id: 'cb1', data: 'anyprice', message: { chat: { id: 42 } } },
    });
    expect(telegram.calls.map((c) => c.method)).toContain('answerCallbackQuery');

    const unauthorized = await handle(new Request(`${BASE}/api/check`, { method: 'POST' }));
    expect(unauthorized.status).toBe(401);

    const response = await handle(
      new Request(`${BASE}/api/check`, { method: 'POST', headers: { authorization: `Bearer ${SECRET}` } }),
    );
    expect(await response.json()).toEqual({ checked: 1, failed: 0 });
    expect(telegram.calls.at(-1)?.body['text']).toContain('Подешевело');
  });

  it('registers the webhook at the deployment URL', async () => {
    const response = await handle(new Request(`${BASE}/api/setup?key=${SECRET}`));

    expect(response.status).toBe(200);
    expect(telegram.calls.map((c) => c.method)).toEqual(['setWebhook', 'setMyCommands']);
    expect(telegram.calls[0]?.body).toMatchObject({
      url: `${BASE}/api/telegram`,
      secret_token: webhookSecret(SECRET),
      allowed_updates: ['message', 'callback_query'],
    });
  });

  it('returns 404 for unknown paths', async () => {
    expect((await handle(new Request(`${BASE}/api/nope`))).status).toBe(404);
  });
});

describe('loadConfig', () => {
  const base = { TELEGRAM_BOT_TOKEN: 't', TRAVELPAYOUTS_TOKEN: 'p' };

  it('reads the database URL under the names the Vercel Neon integration uses', async () => {
    const { loadConfig } = await import('../src/config.ts');
    expect(loadConfig({ ...base, STORAGE_URL: 'postgresql://storage' }).databaseUrl).toBe('postgresql://storage');
    expect(loadConfig({ ...base, POSTGRES_URL: 'postgresql://pg' }).databaseUrl).toBe('postgresql://pg');
    expect(loadConfig({ ...base, DATABASE_URL: 'postgresql://db', STORAGE_URL: 'x' }).databaseUrl).toBe('postgresql://db');
  });
});
