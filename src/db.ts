import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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

interface WatchRow {
  id: number;
  chat_id: number;
  origin: string;
  destination: string;
  depart_date: string;
  return_date: string | null;
  max_price: number | null;
  last_price: number | null;
  created_at: string;
}

const toWatch = (row: WatchRow): Watch => ({
  id: row.id,
  chatId: row.chat_id,
  origin: row.origin,
  destination: row.destination,
  departDate: row.depart_date,
  returnDate: row.return_date,
  maxPrice: row.max_price,
  lastPrice: row.last_price,
  createdAt: row.created_at,
});

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS watches (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id     INTEGER NOT NULL,
        origin      TEXT NOT NULL,
        destination TEXT NOT NULL,
        depart_date TEXT NOT NULL,
        return_date TEXT,
        max_price   INTEGER,
        last_price  INTEGER,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS price_history (
        watch_id   INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
        price      INTEGER NOT NULL,
        checked_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS price_history_watch ON price_history(watch_id, checked_at);
    `);
  }

  addWatch(watch: NewWatch): Watch {
    const row = this.db
      .prepare(
        `INSERT INTO watches (chat_id, origin, destination, depart_date, return_date, max_price)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(watch.chatId, watch.origin, watch.destination, watch.departDate, watch.returnDate, watch.maxPrice);
    return toWatch(row as unknown as WatchRow);
  }

  listWatches(chatId?: number): Watch[] {
    const rows =
      chatId === undefined
        ? this.db.prepare('SELECT * FROM watches ORDER BY id').all()
        : this.db.prepare('SELECT * FROM watches WHERE chat_id = ? ORDER BY id').all(chatId);
    return (rows as unknown as WatchRow[]).map(toWatch);
  }

  removeWatch(chatId: number, id: number): boolean {
    const result = this.db.prepare('DELETE FROM watches WHERE id = ? AND chat_id = ?').run(id, chatId);
    return result.changes > 0;
  }

  recordPrice(watchId: number, price: number): void {
    this.db.prepare('INSERT INTO price_history (watch_id, price) VALUES (?, ?)').run(watchId, price);
    this.db.prepare('UPDATE watches SET last_price = ? WHERE id = ?').run(price, watchId);
  }

  minPrice(watchId: number): number | null {
    const row = this.db.prepare('SELECT MIN(price) AS min FROM price_history WHERE watch_id = ?').get(watchId) as
      | { min: number | null }
      | undefined;
    return row?.min ?? null;
  }

  close(): void {
    this.db.close();
  }
}
