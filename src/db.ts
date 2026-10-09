export interface Watch {
  id: number;
  chatId: number;
  origin: string;
  destination: string;
  /** YYYY-MM-DD or YYYY-MM (whole month). */
  departDate: string;
  /** YYYY-MM-DD or YYYY-MM; null for one-way. */
  returnDate: string | null;
  /** Alert only when the price is at or below this value. */
  maxPrice: number | null;
  lastPrice: number | null;
  createdAt: string;
}

export type NewWatch = Pick<Watch, 'chatId' | 'origin' | 'destination' | 'departDate' | 'returnDate' | 'maxPrice'>;

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
];

// Casts keep row values driver-independent (BIGINT and timestamps come back as strings or objects otherwise).
const COLUMNS = `id, chat_id::float8 AS chat_id, origin, destination, depart_date, return_date,
  max_price, last_price, created_at::text AS created_at`;

const toWatch = (row: Record<string, unknown>): Watch => ({
  id: Number(row['id']),
  chatId: Number(row['chat_id']),
  origin: String(row['origin']),
  destination: String(row['destination']),
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
      `INSERT INTO watches (chat_id, origin, destination, depart_date, return_date, max_price)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLUMNS}`,
      [watch.chatId, watch.origin, watch.destination, watch.departDate, watch.returnDate, watch.maxPrice],
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
}
