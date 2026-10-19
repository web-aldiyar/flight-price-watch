import type { Offer, TripLength } from './aviasales.ts';
import type { Watch } from './db.ts';
import { formatDate } from './dates.ts';

export const formatPrice = (price: number, currency: string): string =>
  `${price.toLocaleString('ru-RU')} ${currency === 'kzt' ? '₸' : currency.toUpperCase()}`;

/** "2–4 дня", "5–9 дней". */
export const describeTripLength = ({ minDays, maxDays }: TripLength): string =>
  `${minDays}–${maxDays} ${maxDays % 10 >= 2 && maxDays % 10 <= 4 && (maxDays < 10 || maxDays > 20) ? 'дня' : 'дней'}`;

/** "Шымкент → Астана, ноябрь 2026, в одну сторону". */
export const describeRoute = (
  watch: Pick<Watch, 'origin' | 'destination' | 'originName' | 'destinationName' | 'departDate' | 'returnDate' | 'trip'>,
): string => {
  const route = `${watch.originName ?? watch.origin} → ${watch.destinationName ?? watch.destination}`;
  const dates = watch.trip
    ? `${formatDate(watch.departDate)}, туда-обратно на ${describeTripLength(watch.trip)}`
    : watch.returnDate
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
    ...(offer.returnAt ? [`Обратно: ${formatDate(offer.returnAt.slice(0, 10))}, ${offer.returnAt.slice(11, 16)}`] : []),
    `<a href="${offer.link}">Купить на Aviasales</a>`,
  ].join('\n');
};
