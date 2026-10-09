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
      ? `✈️ <b>Нашёл билеты</b>\n${describeRoute(watch)}`
      : `📉 <b>Подешевело!</b> Было ${formatPrice(watch.lastPrice, currency)}\n${describeRoute(watch)}`;
  return `${header}\n\n${describeOffer(offer, currency)}`;
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
    await this.store.recordPrice(watch.id, offer.price);
    return offer;
  }

  /** Checks every watch, a few at a time; returns how many were checked and how many failed. */
  async checkAll(concurrency = 4): Promise<{ checked: number; failed: number }> {
    const queue = await this.store.listWatches();
    const total = queue.length;
    let failed = 0;
    const worker = async () => {
      for (let watch = queue.shift(); watch; watch = queue.shift()) {
        try {
          await this.check(watch);
        } catch (error) {
          failed++;
          console.error(`Failed to check watch #${watch.id}:`, error);
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    return { checked: total, failed };
  }
}
