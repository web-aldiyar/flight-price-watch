import { describe, expect, it } from 'vitest';
import { createAviasalesSource } from '../src/aviasales.ts';

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
});
