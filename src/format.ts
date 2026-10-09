import type { Offer } from './aviasales.ts';
import type { Watch } from './db.ts';
import { formatDate } from './dates.ts';

export const formatPrice = (price: number, currency: string): string =>
  `${price.toLocaleString('ru-RU')} ${currency === 'kzt' ? '₸' : currency.toUpperCase()}`;

/** "Шымкент → Астана, ноябрь 2026, в одну сторону". */
export const describeRoute = (watch: Pick<Watch, 'origin' | 'destination' | 'originName' | 'destinationName' | 'departDate' | 'returnDate'>): string => {
  const route = `${watch.originName ?? watch.origin} → ${watch.destinationName ?? watch.destination}`;
  const dates = watch.returnDate
    ? `${formatDate(watch.departDate)}, обратно ${formatDate(watch.returnDate)}`
    : `${formatDate(watch.departDate)}, в одну сторону`;
  return `${route}, ${dates}`;
};

export const describeOffer = (offer: Offer, currency: string): string => {
  const transfers = offer.transfers === 0 ? 'прямой рейс' : `пересадок: ${offer.transfers}`;
  const [date = '', time = ''] = offer.departureAt.split('T');
  return [
    `<b>${formatPrice(offer.price, currency)}</b> · ${transfers}`,
    `Вылет: ${formatDate(date)}, ${time.slice(0, 5)}`,
    `<a href="${offer.link}">Купить на Aviasales</a>`,
  ].join('\n');
};
