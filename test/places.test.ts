import { describe, expect, it } from 'vitest';
import { createPlaceSearch } from '../src/places.ts';

describe('createPlaceSearch', () => {
  it('queries the autocomplete API in Russian and keeps unique cities', async () => {
    let url = '';
    const fetchFn = (async (input: string) => {
      url = input;
      return Response.json([
        { type: 'city', code: 'CIT', name: 'Шымкент', country_name: 'Казахстан', country_code: 'KZ' },
        { type: 'airport', code: 'CIT', name: 'Шымкент', country_name: 'Казахстан' },
        { type: 'city', code: 'CIT', name: 'Шымкент', country_name: 'Казахстан' },
      ]);
    }) as typeof fetch;

    const places = await createPlaceSearch(fetchFn)('Шымкент');

    const params = new URL(url).searchParams;
    expect(params.get('term')).toBe('Шымкент');
    expect(params.get('locale')).toBe('ru');
    expect(params.getAll('types[]')).toEqual(['city']);
    expect(places).toEqual([{ code: 'CIT', name: 'Шымкент', country: 'Казахстан', countryCode: 'KZ' }]);
  });
});
