import { PGlite } from '@electric-sql/pglite';
import type { Offer, PriceQuery, PriceSource } from '../src/aviasales.ts';
import { Store, type Query } from '../src/db.ts';
import type { Messenger } from '../src/telegram.ts';

export class FakeMessenger implements Messenger {
  readonly sent: { chatId: number; text: string }[] = [];
  async send(chatId: number, text: string): Promise<void> {
    this.sent.push({ chatId, text });
  }
}

/** In-memory Postgres (PGlite), no mocks. */
export function memoryQuery(): Query {
  const db = new PGlite();
  return async (text, params) => (await db.query<Record<string, unknown>>(text, params)).rows;
}

export const memoryStore = (): Store => new Store(memoryQuery());

export const offer = (price: number): Offer => ({
  price,
  airline: 'KC',
  departureAt: '2026-12-20T08:15:00+05:00',
  returnAt: null,
  transfers: 0,
  link: 'https://www.aviasales.ru/search/ALA2012IST1',
});

/** Price source that returns the given prices in order (null = no tickets). */
export function scriptedSource(prices: (number | null)[]): PriceSource & { queries: PriceQuery[] } {
  const queries: PriceQuery[] = [];
  const source = async (query: PriceQuery) => {
    queries.push(query);
    const price = prices.shift();
    if (price === undefined) throw new Error('no more scripted prices');
    return price === null ? null : offer(price);
  };
  return Object.assign(source, { queries });
}
