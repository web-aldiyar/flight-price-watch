import type { Offer } from './aviasales.ts';
import type { Watch } from './db.ts';

export const formatPrice = (price: number, currency: string): string =>
  `${price.toLocaleString('ru-RU')} ${currency.toUpperCase()}`;

export const describeRoute = (watch: Watch): string => {
  const dates = watch.returnDate ? `${watch.departDate} → ${watch.returnDate}` : `${watch.departDate}, в одну сторону`;
  return `${watch.origin} → ${watch.destination} (${dates})`;
};

export const describeOffer = (offer: Offer, currency: string): string => {
  const transfers = offer.transfers === 0 ? 'прямой' : `пересадок: ${offer.transfers}`;
  const departure = offer.departureAt.slice(0, 16).replace('T', ' ');
  return [
    `<b>${formatPrice(offer.price, currency)}</b> · ${offer.airline} · ${transfers}`,
    `Вылет: ${departure}`,
    `<a href="${offer.link}">Открыть на Aviasales</a>`,
  ].join('\n');
};
