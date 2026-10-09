/**
 * Local mode: long polling + a timer, with an embedded PGlite database unless DATABASE_URL is set.
 * In production the bot runs on Vercel instead (see deploy/vercel.ts).
 */
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { connect } from './database.ts';
import { BOT_COMMANDS } from './commands.ts';

const config = loadConfig();
const app = createApp(config, { query: await connect(config.databaseUrl) });

const shutdown = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => shutdown.abort());
}

let checking = false;
const runChecks = async () => {
  if (checking) return;
  checking = true;
  try {
    const { checked, failed } = await app.checker.checkAll();
    console.log(`Checked ${checked} watches, ${failed} failed`);
  } finally {
    checking = false;
  }
};
const timer = setInterval(runChecks, config.checkIntervalMinutes * 60_000);

await app.bot.setCommands(BOT_COMMANDS).catch((error: unknown) => console.error('setMyCommands failed:', error));
console.log(`Bot started (polling), checking prices every ${config.checkIntervalMinutes} min`);
void runChecks();

for await (const message of app.bot.messages(shutdown.signal)) {
  await app.handleMessage(message);
}

clearInterval(timer);
console.log('Bot stopped');
