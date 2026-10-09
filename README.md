# flight-price-watch

Telegram-бот, который следит за ценами на авиабилеты и пишет, когда цена падает.
Цены берутся из [Aviasales Data API (Travelpayouts)](https://support.travelpayouts.com/hc/ru/articles/203956163).

Работает бесплатно: **Vercel** (бот) + **Neon** (база Postgres) + **GitHub Actions** (проверка цен каждые 15 минут).

## Команды бота

| Команда | Что делает |
| --- | --- |
| `/track ALA IST 2026-12-20` | в одну сторону на конкретную дату |
| `/track ALA IST 2026-12` | самый дешёвый билет за месяц |
| `/track ALA IST 2026-12-20 2027-01-05` | туда-обратно |
| `/track ALA IST 2026-12 max=60000` | уведомлять только при цене ≤ 60000 |
| `/list` | список отслеживаний с последней и минимальной ценой |
| `/remove 3` | удалить отслеживание #3 |
| `/check` | проверить все свои маршруты прямо сейчас |

Города и аэропорты задаются IATA-кодами (`MOW`, `ALA`, `NQZ`, `IST`, ...).
Сразу после `/track` бот присылает текущую цену, дальше пишет только когда цена стала ниже прошлой.

> Data API отдаёт цены из кэша поисков Aviasales за последние дни, а не живой поиск.
> По редким направлениям данных может не быть, и цена может отличаться от цены на сайте.

## Как это устроено

```
Telegram ──webhook──▶ Vercel /api/telegram ──▶ ответ сразу
GitHub Actions (каждые 15 мин) ──▶ Vercel /api/check ──▶ Aviasales API ──▶ уведомление в Telegram
                                         │
                                    Neon Postgres (маршруты и история цен)
```

## Развёртывание

Понадобятся:
- токен бота от [@BotFather](https://t.me/BotFather);
- токен [Travelpayouts](https://www.travelpayouts.com/) (профиль → API-токен);
- `CRON_SECRET`: любая длинная случайная строка, например результат `openssl rand -hex 32`.
  Она защищает служебные адреса бота от посторонних.

### 1. База данных: Neon

1. Зарегистрируйтесь на [neon.tech](https://neon.tech) (бесплатный тариф) и создайте проект.
2. Скопируйте **connection string** (`postgresql://...`). Таблицы бот создаст сам.

### 2. Бот: Vercel

1. На [vercel.com](https://vercel.com) → **Add New → Project** → импортируйте этот репозиторий. Настройки сборки уже в `vercel.json`, менять ничего не нужно.
2. В **Environment Variables** добавьте:

   | Переменная | Значение |
   | --- | --- |
   | `TELEGRAM_BOT_TOKEN` | токен бота |
   | `TRAVELPAYOUTS_TOKEN` | токен Travelpayouts |
   | `DATABASE_URL` | строка подключения Neon (при подключении Neon через Vercel Storage подойдёт и `STORAGE_URL`) |
   | `CRON_SECRET` | ваша случайная строка |
   | `CURRENCY` | `kzt` (или `rub`, `usd`, ...) |
   | `ALLOWED_CHAT_IDS` | необязательно: ваш chat id (узнать у @userinfobot), чтобы бот отвечал только вам |

3. **Deploy**. Получите адрес вида `https://flight-price-watch-xxx.vercel.app`.
4. Откройте в браузере `https://<ваш-адрес>/api/setup?key=<CRON_SECRET>`. Должно появиться «Готово». Это один раз регистрирует webhook в Telegram.
5. Напишите боту `/start`.

> Если изменили переменные окружения, сделайте **Redeploy** в Vercel.

### 3. Проверка цен: GitHub Actions

В репозитории на GitHub → **Settings → Secrets and variables → Actions**:
- вкладка **Secrets** → `CRON_SECRET` = та же строка, что в Vercel;
- вкладка **Variables** → `APP_URL` = адрес из Vercel, без `/` в конце.

Проверить: **Actions → Check prices → Run workflow**. Дальше запускается сам каждые 15 минут.
Если в репозитории 60 дней не было коммитов, GitHub отключает расписание. Включить снова можно на той же странице.

## Локальный запуск

Нужен Node.js ≥ 22.18. Без `DATABASE_URL` используется встроенная база в `./data/pglite`.

```bash
cp .env.example .env   # вписать токены
npm install
npm run dev
```

Локально бот работает через long polling, а он не работает, пока у бота включён webhook.
Отключить webhook: `https://api.telegram.org/bot<TOKEN>/deleteWebhook`. Включить обратно: снова открыть `/api/setup`.

## Разработка

```bash
npm run typecheck
npm test              # тесты на PGlite (настоящий Postgres в WASM), без моков базы
npm run build:vercel  # сборка в .vercel/output
```

```
src/
  app.ts        — сборка приложения и HTTP API (/api/telegram, /api/check, /api/setup)
  index.ts      — локальный режим: long polling + таймер
  commands.ts   — разбор команд бота
  checker.ts    — проверка цен и правила уведомлений
  aviasales.ts  — клиент Aviasales Data API
  telegram.ts   — минимальный клиент Telegram Bot API
  db.ts         — хранилище (Postgres): отслеживания и история цен
  database.ts   — подключение: Neon или встроенный PGlite
deploy/
  vercel.ts     — точка входа функции Vercel
  build.mjs     — сборка в формат Vercel Build Output API
```
