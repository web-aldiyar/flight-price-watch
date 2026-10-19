/** Length of a round trip without fixed dates, in days between the flights. */
export interface TripLength {
  minDays: number;
  maxDays: number;
}

export interface PriceQuery {
  origin: string;
  destination: string;
  /** YYYY-MM-DD, YYYY-MM or "any". */
  departDate: string;
  returnDate: string | null;
  /** Round trip with a flexible return date. */
  trip: TripLength | null;
}

export interface Offer {
  price: number;
  airline: string;
  departureAt: string;
  returnAt: string | null;
  transfers: number;
  link: string;
}

export type PriceSource = (query: PriceQuery) => Promise<Offer | null>;

interface ApiTicket {
  price: number;
  airline: string;
  departure_at: string;
  return_at?: string;
  transfers: number;
  link: string;
}

interface ApiResponse {
  success: boolean;
  data?: ApiTicket[];
  error?: string;
}

/** Days between the outbound and return departure dates, as printed on the ticket. */
export const tripDays = (offer: Pick<Offer, 'departureAt' | 'returnAt'>): number =>
  offer.returnAt
    ? Math.round((Date.parse(offer.returnAt.slice(0, 10)) - Date.parse(offer.departureAt.slice(0, 10))) / 86_400_000)
    : 0;

const API_URL = 'https://api.travelpayouts.com/aviasales/v3/prices_for_dates';

/**
 * Cheapest offer from the Aviasales (Travelpayouts) Data API.
 * The data comes from the search cache, so it can lag behind live prices by a few hours.
 */
export function createAviasalesSource(token: string, currency: string, fetchFn: typeof fetch = fetch): PriceSource {
  return async (query) => {
    const params = new URLSearchParams({
      origin: query.origin,
      destination: query.destination,
      one_way: String(query.returnDate === null && query.trip === null),
      sorting: 'price',
      currency,
      // A flexible round trip is picked by its length from many tickets.
      limit: query.trip ? '1000' : '1',
    });
    // Without a date the API returns the cheapest tickets on any upcoming day.
    if (query.departDate !== 'any') params.set('departure_at', query.departDate);
    if (query.returnDate) params.set('return_at', query.returnDate);

    const response = await fetchFn(`${API_URL}?${params}`, { headers: { 'X-Access-Token': token } });
    if (!response.ok) {
      throw new Error(`Aviasales API responded with ${response.status}`);
    }
    const body = (await response.json()) as ApiResponse;
    if (!body.success) throw new Error(`Aviasales API error: ${body.error ?? 'unknown'}`);

    const offers = (body.data ?? []).map(
      (ticket): Offer => ({
        price: ticket.price,
        airline: ticket.airline,
        departureAt: ticket.departure_at,
        returnAt: ticket.return_at ?? null,
        transfers: ticket.transfers,
        link: `https://www.aviasales.ru${ticket.link}`,
      }),
    );
    const { trip } = query;
    const [offer] = trip
      ? offers.filter((o) => o.returnAt && tripDays(o) >= trip.minDays && tripDays(o) <= trip.maxDays)
      : offers;
    return offer ?? null;
  };
}
