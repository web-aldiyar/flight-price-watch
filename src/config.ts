export interface Config {
  telegramToken: string;
  travelpayoutsToken: string;
  currency: string;
  checkIntervalMinutes: number;
  dbPath: string;
  allowedChatIds: Set<number> | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Environment variable ${name} is required`);
    return value;
  };

  const interval = Number(env['CHECK_INTERVAL_MINUTES'] ?? 60);
  if (!Number.isFinite(interval) || interval < 1) {
    throw new Error('CHECK_INTERVAL_MINUTES must be a number >= 1');
  }

  const allowed = env['ALLOWED_CHAT_IDS']?.trim();

  return {
    telegramToken: required('TELEGRAM_BOT_TOKEN'),
    travelpayoutsToken: required('TRAVELPAYOUTS_TOKEN'),
    currency: (env['CURRENCY']?.trim() || 'rub').toLowerCase(),
    checkIntervalMinutes: interval,
    dbPath: env['DB_PATH']?.trim() || './data/watches.db',
    allowedChatIds: allowed ? new Set(allowed.split(',').map((id) => Number(id.trim()))) : null,
  };
}
