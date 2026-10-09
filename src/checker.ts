import type { Offer, PriceSource } from './aviasales.ts';
import type { Store, Watch } from './db.ts';
import { describeOffer, describeRoute, formatPrice } from './format.ts';
import type { Messenger } from './telegram.ts';

/**
 * Whether a newly seen price is worth an alert:
 * - the first price is always reported, so the user sees where it starts;
 * - after that, only drops below the previous price;
 * - with a max price set, only prices at or below it.
 */
export function shouldNotify(watch: Watch, price: number): boolean {
  if (watch.maxPrice !== null && price > watch.maxPrice) return false;
  return watch.lastPrice === null || price < watch.lastPrice;
}

export function buildAlert(watch: Watch, offer: Offer, currency: string): string {
  const header =
    watch.lastPrice === null
      ? `✈️ Текущая цена #${watch.id}`
      : `📉 Цена снизилась #${watch.id}: было ${formatPrice(watch.lastPrice, currency)}`;
  return `${header}\n${describeRoute(watch)}\n\n${describeOffer(offer, currency)}`;
}

export class PriceChecker {
  private readonly store: Store;
  private readonly source: PriceSource;
  private readonly messenger: Messenger;
  private readonly currency: string;

  constructor(
    store: Store,
    source: PriceSource,
    messenger: Messenger,
    currency: string,
  ) {
    this.store = store;
    this.source = source;
    this.messenger = messenger;
    this.currency = currency;
  }

  /** Checks one watch; returns the offer found (or null when there are no tickets). */
  async check(watch: Watch): Promise<Offer | null> {
    const offer = await this.source(watch);
    if (!offer) return null;
    if (shouldNotify(watch, offer.price)) {
      await this.messenger.send(watch.chatId, buildAlert(watch, offer, this.currency));
    }
    this.store.recordPrice(watch.id, offer.price);
    return offer;
  }

  async checkAll(): Promise<void> {
    for (const watch of this.store.listWatches()) {
      try {
        await this.check(watch);
      } catch (error) {
        console.error(`Failed to check watch #${watch.id}:`, error);
      }
    }
  }
}
