import { createAviasalesSource } from './aviasales.ts';
import { PriceChecker } from './checker.ts';
import { BOT_COMMANDS, CommandHandler } from './commands.ts';
import { loadConfig } from './config.ts';
import { Store } from './db.ts';
import { TelegramBot } from './telegram.ts';

const config = loadConfig();
const store = new Store(config.dbPath);
const bot = new TelegramBot(config.telegramToken);
const checker = new PriceChecker(
  store,
  createAviasalesSource(config.travelpayoutsToken, config.currency),
  bot,
  config.currency,
);
const commands = new CommandHandler(store, checker, bot, config.currency);

const shutdown = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => shutdown.abort());
}

let checking = false;
const runChecks = async () => {
  if (checking) return;
  checking = true;
  try {
    await checker.checkAll();
  } finally {
    checking = false;
  }
};
const timer = setInterval(runChecks, config.checkIntervalMinutes * 60_000);

await bot.setCommands(BOT_COMMANDS).catch((error: unknown) => console.error('setMyCommands failed:', error));
console.log(`Bot started, checking prices every ${config.checkIntervalMinutes} min`);
void runChecks();

for await (const { chatId, text } of bot.messages(shutdown.signal)) {
  if (config.allowedChatIds && !config.allowedChatIds.has(chatId)) {
    await bot.send(chatId, 'Доступ к боту ограничен.').catch(() => {});
    continue;
  }
  try {
    const reply = await commands.handle(chatId, text);
    if (reply) await bot.send(chatId, reply);
  } catch (error) {
    console.error('Failed to handle message:', error);
  }
}

clearInterval(timer);
store.close();
console.log('Bot stopped');
