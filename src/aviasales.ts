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

/**
 * Cheapest offer from the Aviasales (Travelpayouts) Data API.
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

    const response = await fetchFn(`${API_URL}?${params}`, { headers: { 'X-Access-Token': token } });
    if (!response.ok) {
      throw new Error(`Aviasales API responded with ${response.status}`);
    }
    const body = (await response.json()) as ApiResponse;
    if (!body.success) throw new Error(`Aviasales API error: ${body.error ?? 'unknown'}`);

    const ticket = body.data?.[0];
    if (!ticket) return null;
    return {
      price: ticket.price,
      airline: ticket.airline,
      departureAt: ticket.departure_at,
      returnAt: ticket.return_at ?? null,
      transfers: ticket.transfers,
      link: `https://www.aviasales.ru${ticket.link}`,
    };
  };
}
