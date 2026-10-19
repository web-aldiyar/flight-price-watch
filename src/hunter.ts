import { tripDays, type DestinationOffer, type ExploreSource, type TripLength } from './aviasales.ts';
import { formatDate } from './dates.ts';
import type { City, Hunt, HuntPrice, Store } from './db.ts';
import { formatPrice } from './format.ts';
import type { PlaceSearch } from './places.ts';
import type { Messenger } from './telegram.ts';

/** A ticket is a deal when it is at least this much cheaper than the usual price of the destination. */
export const DEAL_DROP = 0.2;
/** The usual price follows the prices seen over about a week. */
const USUAL_PRICE_HOURS = 7 * 24;

export interface HomeCity {
  code: string;
  name: string;
  countryCode: string;
}

/** Every trip starts here. */
export const HOME: HomeCity = { code: 'NQZ', name: 'Астана', countryCode: 'KZ' };

export const TRIP_LENGTHS: (TripLength & { label: string })[] = [
  { minDays: 3, maxDays: 14, label: '3–14 дней' },
  { minDays: 2, maxDays: 4, label: '2–4 дня' },
  { minDays: 5, maxDays: 9, label: '5–9 дней' },
  { minDays: 10, maxDays: 16, label: '10–16 дней' },
];
export const DEFAULT_TRIP: TripLength = TRIP_LENGTHS[0]!;

export const describeTripLength = (trip: TripLength): string => `${trip.minDays}–${trip.maxDays} дн.`;

export interface Trip {
  city: City;
  offer: DestinationOffer;
}

export interface Deal extends Trip {
  usualPrice: number;
}

/**
 * The new state of a destination after a price is seen, and whether that price is a deal worth an alert:
 * at least DEAL_DROP below the usual price and cheaper than the deal already reported.
 */
export function judgePrice(
  previous: Pick<HuntPrice, 'usualPrice' | 'dealPrice' | 'updatedAt'> | undefined,
  price: number,
  now: number,
): { usualPrice: number; dealPrice: number | null; isDeal: boolean } {
  if (!previous) return { usualPrice: price, dealPrice: null, isDeal: false };
  const weight = Math.min(1, Math.max(0, now - previous.updatedAt) / 3_600_000 / USUAL_PRICE_HOURS);
  const usualPrice = Math.round(previous.usualPrice + (price - previous.usualPrice) * weight);
  const cheap = price <= previous.usualPrice * (1 - DEAL_DROP);
  return {
    usualPrice,
    // Once the price is back to normal, the next drop is news again.
    dealPrice: cheap ? Math.min(price, previous.dealPrice ?? price) : null,
    isDeal: cheap && (previous.dealPrice === null || price < previous.dealPrice),
  };
}

/** "<b>Рим</b>, Италия — 85 000 ₸" and the dates, transfers and link below. */
export function formatTrip({ city, offer }: Trip, currency: string, title = city.name): string {
  const transfers = offer.transfers === 0 ? 'прямой' : `пересадок: ${offer.transfers}`;
  const dates = `${formatDate(offer.departureAt.slice(0, 10))} → ${formatDate(offer.returnAt!.slice(0, 10))}`;
  return (
    `<b>${title}</b>, ${city.country} — <b>${formatPrice(offer.price, currency)}</b>\n` +
    `     ${dates} · ${tripDays(offer)} дн. · ${transfers} · <a href="${offer.link}">купить</a>`
  );
}

export function buildDealAlert(deals: Deal[], currency: string): string {
  const lines = deals.map((deal) => {
    const drop = Math.round((1 - deal.offer.price / deal.usualPrice) * 100);
    return `${formatTrip(deal, currency)}\n     обычно ~${formatPrice(deal.usualPrice, currency)}, <b>−${drop}%</b>`;
  });
  return `🔥 <b>Горящие билеты из города ${HOME.name}!</b> Туда-обратно, дешевле обычного:\n\n${lines.join('\n\n')}`;
}

/**
 * "Ticket hunter": watches every destination abroad from the home city, on any dates,
 * and reports round trips that suddenly became much cheaper than usual.
 */
export class Hunter {
  private readonly store: Store;
  private readonly explore: ExploreSource;
  private readonly places: PlaceSearch;
  private readonly messenger: Messenger;
  private readonly currency: string;
  private readonly now: () => number;
  readonly home: HomeCity;

  constructor(
    store: Store,
    explore: ExploreSource,
    places: PlaceSearch,
    messenger: Messenger,
    currency: string,
    now: () => number = Date.now,
    home: HomeCity = HOME,
  ) {
    this.home = home;
    this.store = store;
    this.explore = explore;
    this.places = places;
    this.messenger = messenger;
    this.currency = currency;
    this.now = now;
  }

  /** Cities by IATA code: from the cache, otherwise looked up a few at a time and cached. */
  async cities(codes: string[]): Promise<Map<string, City>> {
    const unique = [...new Set(codes)];
    const known = new Map((await this.store.getCities(unique)).map((city) => [city.code, city]));
    const missing = unique.filter((code) => !known.has(code));
    const found: City[] = [];
    for (let i = 0; i < missing.length; i += 8) {
      const batch = await Promise.all(
        missing.slice(i, i + 8).map(async (code): Promise<City | null> => {
          try {
            const place = (await this.places(code)).find((p) => p.code === code);
            return place ? { ...place } : { code, name: code, country: '', countryCode: '' };
          } catch {
            return null; // Lookup failed: try again on the next scan.
          }
        }),
      );
      for (const city of batch) {
        if (city) {
          found.push(city);
          known.set(city.code, city);
        }
      }
    }
    await this.store.saveCities(found);
    return known;
  }

  /** The cheapest round trips abroad from the home city, one per destination, cheapest first. */
  async trips(trip: TripLength): Promise<Trip[]> {
    const origin = this.home;
    const offers = await this.explore(origin.code, { minDays: trip.minDays, maxDays: trip.maxDays });
    const cities = await this.cities(offers.map((offer) => offer.destination));
    return offers.flatMap((offer) => {
      const city = cities.get(offer.destination);
      // Unknown countries are skipped: we cannot tell whether they are abroad.
      return city?.countryCode && city.countryCode !== origin.countryCode ? [{ city, offer }] : [];
    });
  }

  /**
   * Looks at every destination, updates the usual prices and sends the deals found.
   * Returns all trips found (cheapest first) and the deals among them.
   */
  async scan(hunt: Hunt): Promise<{ trips: Trip[]; deals: Deal[] }> {
    const trips = await this.trips(hunt);
    const previous = new Map((await this.store.huntPrices(hunt.chatId)).map((p) => [p.destination, p]));
    const now = this.now();
    const deals: Deal[] = [];
    const updates = trips.map((trip) => {
      const before = previous.get(trip.city.code);
      const judged = judgePrice(before, trip.offer.price, now);
      if (judged.isDeal) deals.push({ ...trip, usualPrice: before!.usualPrice });
      return { destination: trip.city.code, usualPrice: judged.usualPrice, dealPrice: judged.dealPrice };
    });
    await this.store.saveHuntPrices(hunt.chatId, updates);

    // Biggest discounts first; a long list would bury them.
    deals.sort((a, b) => a.offer.price / a.usualPrice - b.offer.price / b.usualPrice);
    if (deals.length > 0) await this.messenger.send(hunt.chatId, buildDealAlert(deals.slice(0, 10), this.currency));
    return { trips, deals };
  }

  /** Scans every hunt, a couple at a time. */
  async scanAll(concurrency = 2): Promise<{ scanned: number; failed: number }> {
    const queue = await this.store.listHunts();
    const total = queue.length;
    let failed = 0;
    const worker = async () => {
      for (let hunt = queue.shift(); hunt; hunt = queue.shift()) {
        try {
          await this.scan(hunt);
        } catch (error) {
          failed++;
          console.error(`Failed to scan hunt of chat ${hunt.chatId}:`, error);
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    return { scanned: total, failed };
  }
}
