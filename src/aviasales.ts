export interface PriceQuery {
  origin: string;
  destination: string;
  departDate: string;
  returnDate: string | null;
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
  destination: string;
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

const API_URL = 'https://api.travelpayouts.com/aviasales/v3/prices_for_dates';

/** Cheapest tickets from the Aviasales (Travelpayouts) Data API, cheapest first. */
async function fetchTickets(token: string, params: URLSearchParams, fetchFn: typeof fetch): Promise<ApiTicket[]> {
  const response = await fetchFn(`${API_URL}?${params}`, { headers: { 'X-Access-Token': token } });
  if (!response.ok) {
    throw new Error(`Aviasales API responded with ${response.status}`);
  }
  const body = (await response.json()) as ApiResponse;
  if (!body.success) throw new Error(`Aviasales API error: ${body.error ?? 'unknown'}`);
  return body.data ?? [];
}

const toOffer = (ticket: ApiTicket): Offer => ({
  price: ticket.price,
  airline: ticket.airline,
  departureAt: ticket.departure_at,
  returnAt: ticket.return_at ?? null,
  transfers: ticket.transfers,
  link: `https://www.aviasales.ru${ticket.link}`,
});

/**
 * Cheapest offer for a route.
 * The data comes from the search cache, so it can lag behind live prices by a few hours.
 */
export function createAviasalesSource(token: string, currency: string, fetchFn: typeof fetch = fetch): PriceSource {
  return async (query) => {
    const params = new URLSearchParams({
      origin: query.origin,
      destination: query.destination,
      departure_at: query.departDate,
      one_way: String(query.returnDate === null),
      sorting: 'price',
      currency,
      limit: '1',
    });
    if (query.returnDate) params.set('return_at', query.returnDate);

    const [ticket] = await fetchTickets(token, params, fetchFn);
    return ticket ? toOffer(ticket) : null;
  };
}

export interface DestinationOffer extends Offer {
  /** IATA city code. */
  destination: string;
}

/** Length of a round trip, in nights between the outbound and return flights. */
export interface TripLength {
  minDays: number;
  maxDays: number;
}

/** Days between the outbound and return departure dates (local dates, as printed on the ticket). */
export const tripDays = (offer: Pick<Offer, 'departureAt' | 'returnAt'>): number =>
  offer.returnAt
    ? Math.round((Date.parse(offer.returnAt.slice(0, 10)) - Date.parse(offer.departureAt.slice(0, 10))) / 86_400_000)
    : 0;

/** Cheapest round trips from a city to anywhere, on any upcoming dates: one per destination, cheapest first. */
export type ExploreSource = (origin: string, trip: TripLength) => Promise<DestinationOffer[]>;

export function createExploreSource(token: string, currency: string, fetchFn: typeof fetch = fetch): ExploreSource {
  return async (origin, trip) => {
    const params = new URLSearchParams({
      origin,
      one_way: 'false',
      sorting: 'price',
      currency,
      limit: '1000',
    });
    const tickets = await fetchTickets(token, params, fetchFn);
    const seen = new Set<string>();
    return tickets
      .map((ticket) => ({ ...toOffer(ticket), destination: ticket.destination }))
      .filter((offer) => {
        if (!offer.destination || !offer.returnAt || seen.has(offer.destination)) return false;
        const days = tripDays(offer);
        return days >= trip.minDays && days <= trip.maxDays && seen.add(offer.destination);
      })
      .slice(0, 80);
  };
}
