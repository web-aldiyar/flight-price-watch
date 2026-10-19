export interface Watch {
  id: number;
  chatId: number;
  /** IATA city codes. */
  origin: string;
  destination: string;
  /** City names for display; null for watches created with bare codes. */
  originName: string | null;
  destinationName: string | null;
  /** YYYY-MM-DD or YYYY-MM (whole month). */
  departDate: string;
  /** YYYY-MM-DD or YYYY-MM; null for one-way. */
  returnDate: string | null;
  /** Alert only when the price is at or below this value. */
  maxPrice: number | null;
  lastPrice: number | null;
  createdAt: string;
}

export type NewWatch = Pick<
  Watch,
  'chatId' | 'origin' | 'destination' | 'originName' | 'destinationName' | 'departDate' | 'returnDate' | 'maxPrice'
>;

/** Runs one parameterized SQL statement and returns its rows (Neon HTTP driver or PGlite). */
export type Query = (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS watches (
    id          SERIAL PRIMARY KEY,
    chat_id     BIGINT NOT NULL,
    origin      TEXT NOT NULL,
    destination TEXT NOT NULL,
    depart_date TEXT NOT NULL,
    return_date TEXT,
    max_price   INTEGER,
    last_price  INTEGER,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS watches_chat ON watches (chat_id)`,
  `CREATE TABLE IF NOT EXISTS price_history (
    watch_id   INTEGER NOT NULL REFERENCES watches (id) ON DELETE CASCADE,
    price      INTEGER NOT NULL,
    checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS price_history_watch ON price_history (watch_id, checked_at)`,
  `ALTER TABLE watches ADD COLUMN IF NOT EXISTS origin_name TEXT`,
  `ALTER TABLE watches ADD COLUMN IF NOT EXISTS destination_name TEXT`,
  // Unfinished "new watch" dialog per chat (the bot is stateless between webhook calls).
  `CREATE TABLE IF NOT EXISTS chat_drafts (
    chat_id    BIGINT PRIMARY KEY,
    draft      JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
];

// Casts keep row values driver-independent (BIGINT and timestamps come back as strings or objects otherwise).
const COLUMNS = `id, chat_id::float8 AS chat_id, origin, destination, origin_name, destination_name, depart_date, return_date,
  max_price, last_price, created_at::text AS created_at`;

const toWatch = (row: Record<string, unknown>): Watch => ({
  id: Number(row['id']),
  chatId: Number(row['chat_id']),
  origin: String(row['origin']),
  destination: String(row['destination']),
  originName: (row['origin_name'] as string | null) ?? null,
  destinationName: (row['destination_name'] as string | null) ?? null,
  departDate: String(row['depart_date']),
  returnDate: (row['return_date'] as string | null) ?? null,
  maxPrice: row['max_price'] == null ? null : Number(row['max_price']),
  lastPrice: row['last_price'] == null ? null : Number(row['last_price']),
  createdAt: String(row['created_at']),
});

export class Store {
  private readonly query: Query;
  private schema: Promise<void> | undefined;

  constructor(query: Query) {
    this.query = query;
  }

  /** Creates the tables on first use (once per process / cold start). */
  private async sql(text: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    this.schema ??= (async () => {
      for (const statement of SCHEMA) await this.query(statement);
    })().catch((error: unknown) => {
      this.schema = undefined;
      throw error;
    });
    await this.schema;
    return this.query(text, params);
  }

  async addWatch(watch: NewWatch): Promise<Watch> {
    const [row] = await this.sql(
      `INSERT INTO watches (chat_id, origin, destination, origin_name, destination_name, depart_date, return_date, max_price)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${COLUMNS}`,
      [
        watch.chatId,
        watch.origin,
        watch.destination,
        watch.originName,
        watch.destinationName,
        watch.departDate,
        watch.returnDate,
        watch.maxPrice,
      ],
    );
    return toWatch(row!);
  }

  async listWatches(chatId?: number): Promise<Watch[]> {
    const rows =
      chatId === undefined
        ? await this.sql(`SELECT ${COLUMNS} FROM watches ORDER BY id`)
        : await this.sql(`SELECT ${COLUMNS} FROM watches WHERE chat_id = $1 ORDER BY id`, [chatId]);
    return rows.map(toWatch);
  }

  /** Replaces a watch's route, dates and max price; optionally forgets its price history. */
  async updateWatch(
    chatId: number,
    id: number,
    watch: Omit<NewWatch, 'chatId'>,
    resetPrices: boolean,
  ): Promise<Watch | null> {
    const [row] = await this.sql(
      `UPDATE watches SET origin = $3, destination = $4, origin_name = $5, destination_name = $6,
         depart_date = $7, return_date = $8, max_price = $9,
         last_price = CASE WHEN $10::boolean THEN NULL ELSE last_price END
       WHERE id = $1 AND chat_id = $2 RETURNING ${COLUMNS}`,
      [
        id,
        chatId,
        watch.origin,
        watch.destination,
        watch.originName,
        watch.destinationName,
        watch.departDate,
        watch.returnDate,
        watch.maxPrice,
        resetPrices,
      ],
    );
    if (!row) return null;
    if (resetPrices) await this.sql('DELETE FROM price_history WHERE watch_id = $1', [id]);
    return toWatch(row);
  }

  async removeWatch(chatId: number, id: number): Promise<boolean> {
    const rows = await this.sql('DELETE FROM watches WHERE id = $1 AND chat_id = $2 RETURNING id', [id, chatId]);
    return rows.length > 0;
  }

  async recordPrice(watchId: number, price: number): Promise<void> {
    await this.sql(
      `WITH updated AS (UPDATE watches SET last_price = $2 WHERE id = $1 RETURNING id)
       INSERT INTO price_history (watch_id, price) SELECT id, $2 FROM updated`,
      [watchId, price],
    );
  }

  async minPrice(watchId: number): Promise<number | null> {
    const [row] = await this.sql('SELECT MIN(price) AS min FROM price_history WHERE watch_id = $1', [watchId]);
    return row?.['min'] == null ? null : Number(row['min']);
  }

  async getDraft<T>(chatId: number): Promise<T | null> {
    const [row] = await this.sql('SELECT draft::text AS draft FROM chat_drafts WHERE chat_id = $1', [chatId]);
    return row ? (JSON.parse(String(row['draft'])) as T) : null;
  }

  async setDraft(chatId: number, draft: unknown): Promise<void> {
    await this.sql(
      `INSERT INTO chat_drafts (chat_id, draft) VALUES ($1, $2::jsonb)
       ON CONFLICT (chat_id) DO UPDATE SET draft = EXCLUDED.draft, updated_at = now()`,
      [chatId, JSON.stringify(draft)],
    );
  }

  async clearDraft(chatId: number): Promise<void> {
    await this.sql('DELETE FROM chat_drafts WHERE chat_id = $1', [chatId]);
  }
}
