import { describe, expect, it } from 'vitest';
import { createAviasalesSource, createExploreSource, tripDays } from '../src/aviasales.ts';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('createAviasalesSource', () => {
  it('requests the cheapest round trip and maps the response', async () => {
    let url = '';
    let headers: HeadersInit | undefined;
    const fetchFn = (async (input: string, init?: RequestInit) => {
      url = input;
      headers = init?.headers;
      return jsonResponse({
        success: true,
        currency: 'kzt',
        data: [
          {
            price: 61234,
            airline: 'PC',
            departure_at: '2026-12-20T08:15:00+05:00',
            return_at: '2027-01-05T10:00:00+03:00',
            transfers: 1,
            link: '/search/ALA2012IST05011',
          },
        ],
      });
    }) as typeof fetch;

    const offer = await createAviasalesSource('secret', 'kzt', fetchFn)({
      origin: 'ALA',
      destination: 'IST',
      departDate: '2026-12-20',
      returnDate: '2027-01-05',
    });

    const params = new URL(url).searchParams;
    expect(params.get('one_way')).toBe('false');
    expect(params.get('return_at')).toBe('2027-01-05');
    expect(params.get('sorting')).toBe('price');
    expect(params.get('currency')).toBe('kzt');
    expect(params.has('token')).toBe(false);
    expect(headers).toEqual({ 'X-Access-Token': 'secret' });
    expect(offer).toEqual({
      price: 61234,
      airline: 'PC',
      departureAt: '2026-12-20T08:15:00+05:00',
      returnAt: '2027-01-05T10:00:00+03:00',
      transfers: 1,
      link: 'https://www.aviasales.ru/search/ALA2012IST05011',
    });
  });

  it('returns null when there are no tickets', async () => {
    const fetchFn = (async () => jsonResponse({ success: true, data: [] })) as typeof fetch;
    const source = createAviasalesSource('t', 'rub', fetchFn);
    expect(await source({ origin: 'MOW', destination: 'LED', departDate: '2026-11', returnDate: null })).toBeNull();
  });

  it('throws on HTTP errors', async () => {
    const fetchFn = (async () => jsonResponse({}, 401)) as typeof fetch;
    const source = createAviasalesSource('bad', 'rub', fetchFn);
    await expect(source({ origin: 'MOW', destination: 'LED', departDate: '2026-11', returnDate: null })).rejects.toThrow('401');
  });

  it('finds the cheapest round trip of the right length per destination for "anywhere"', async () => {
    let url = '';
    const ticket = (destination: string, price: number, returnDay: number) => ({
      destination,
      price,
      airline: 'KC',
      departure_at: '2026-11-12T23:00:00+05:00',
      return_at: `2026-11-${returnDay}T01:00:00+03:00`,
      transfers: 0,
      link: `/search/ALA1211${destination}1`,
    });
    const fetchFn = (async (input: string) => {
      url = input;
      return jsonResponse({
        success: true,
        data: [
          ticket('NQZ', 15000, 13), // 1 day: too short
          ticket('NQZ', 16000, 19),
          ticket('NQZ', 17000, 20), // same destination again
          ticket('IST', 42000, 26),
          ticket('DXB', 43000, 30), // 18 days: too long
        ],
      });
    }) as typeof fetch;

    const offers = await createExploreSource('t', 'kzt', fetchFn)('ALA', { minDays: 3, maxDays: 14 });

    const params = new URL(url).searchParams;
    expect(params.get('origin')).toBe('ALA');
    expect(params.get('one_way')).toBe('false');
    expect(params.has('destination')).toBe(false);
    expect(params.has('departure_at')).toBe(false);
    expect(offers.map((o) => [o.destination, o.price, tripDays(o)])).toEqual([
      ['NQZ', 16000, 7],
      ['IST', 42000, 14],
    ]);
    expect(offers[0]?.link).toBe('https://www.aviasales.ru/search/ALA1211NQZ1');
  });
});
