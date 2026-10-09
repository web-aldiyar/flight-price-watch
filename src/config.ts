export interface Config {
  telegramToken: string;
  travelpayoutsToken: string;
  currency: string;
  /** Neon connection string; local runs fall back to an embedded PGlite database. */
  databaseUrl: string | undefined;
  /** Protects /api/check and /api/setup; also derives the Telegram webhook secret. */
  cronSecret: string | undefined;
  /** Local polling mode only: how often to check prices. */
  checkIntervalMinutes: number;
  allowedChatIds: Set<number> | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Environment variable ${name} is required`);
    return value;
  };
  const optional = (name: string): string | undefined => env[name]?.trim() || undefined;

  const interval = Number(env['CHECK_INTERVAL_MINUTES'] ?? 60);
  if (!Number.isFinite(interval) || interval < 1) {
    throw new Error('CHECK_INTERVAL_MINUTES must be a number >= 1');
  }

  const allowed = optional('ALLOWED_CHAT_IDS');

  return {
    telegramToken: required('TELEGRAM_BOT_TOKEN'),
    travelpayoutsToken: required('TRAVELPAYOUTS_TOKEN'),
    currency: (optional('CURRENCY') ?? 'rub').toLowerCase(),
    // The Vercel Neon integration names the variable after its prefix (STORAGE_ by default).
    databaseUrl: optional('DATABASE_URL') ?? optional('POSTGRES_URL') ?? optional('STORAGE_URL'),
    cronSecret: optional('CRON_SECRET'),
    checkIntervalMinutes: interval,
    allowedChatIds: allowed ? new Set(allowed.split(',').map((id) => Number(id.trim()))) : null,
  };
}
