# flight-price-watch

Telegram-бот, который следит за ценами на авиабилеты и пишет, когда цена падает.
Цены берутся из [Aviasales Data API (Travelpayouts)](https://support.travelpayouts.com/hc/ru/articles/203956163).

## Как это работает

1. В Telegram отправляете боту `/track ALA IST 2026-12-20`.
2. Бот сразу присылает текущую минимальную цену, потом проверяет её раз в `CHECK_INTERVAL_MINUTES` минут.
3. Если цена стала ниже прошлой (и не выше порога `max=`, если он задан), бот присылает сообщение со ссылкой на Aviasales.

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

> Data API отдаёт цены из кэша поисков Aviasales за последние дни, а не живой поиск.
> По редким направлениям данных может не быть, и цена может отличаться от цены на сайте.

## Запуск

Нужно:
- **Токен бота**: создайте бота у [@BotFather](https://t.me/BotFather).
- **Токен Travelpayouts**: зарегистрируйтесь на [travelpayouts.com](https://www.travelpayouts.com/), токен лежит в разделе *Профиль → API токен*.

```bash
cp .env.example .env   # заполните токены
```

### Docker (рекомендуется)

```bash
docker compose up -d --build
```

База SQLite хранится в volume `data`.

### Без Docker (Node.js ≥ 22.18)

```bash
npm install
npm run dev      # с автоперезапуском, читает .env
# или
node --env-file=.env src/index.ts
```

Сборка не нужна: Node запускает TypeScript напрямую (type stripping). Рантайм-зависимостей нет, только `node:sqlite` и `fetch`.

Боту нужен постоянно работающий процесс (long polling и таймер), поэтому serverless (Vercel и т. п.) не подходит.
Подойдут VPS, Railway, Fly.io, Render (Background Worker) с постоянным диском для `DB_PATH`.

## Настройки

| Переменная | По умолчанию | |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | — | обязательно |
| `TRAVELPAYOUTS_TOKEN` | — | обязательно |
| `CURRENCY` | `rub` | валюта цен (`rub`, `kzt`, `usd`, `eur`, ...) |
| `CHECK_INTERVAL_MINUTES` | `60` | период проверки |
| `DB_PATH` | `./data/watches.db` | файл SQLite |
| `ALLOWED_CHAT_IDS` | все | chat id через запятую, если бот только для себя |

## Разработка

```bash
npm run typecheck
npm test
```

```
src/
  index.ts      — запуск: polling Telegram + периодическая проверка
  commands.ts   — разбор команд бота
  checker.ts    — проверка цен и правила уведомлений
  aviasales.ts  — клиент Aviasales Data API
  telegram.ts   — минимальный клиент Telegram Bot API
  db.ts         — SQLite (отслеживания и история цен)
```
