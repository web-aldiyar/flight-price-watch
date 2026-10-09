export interface Place {
  /** IATA city code, e.g. "CIT". */
  code: string;
  /** City name in Russian, e.g. "Шымкент". */
  name: string;
  country: string;
  /** ISO country code, e.g. "KZ". */
  countryCode: string;
}

export type PlaceSearch = (term: string) => Promise<Place[]>;

interface ApiPlace {
  type: string;
  code: string;
  name: string;
  country_name?: string;
  country_code?: string;
}

const API_URL = 'https://autocomplete.travelpayouts.com/places2';

/** City lookup by name in any language (Travelpayouts autocomplete, no token needed). */
export function createPlaceSearch(fetchFn: typeof fetch = fetch): PlaceSearch {
  return async (term) => {
    const params = new URLSearchParams({ term, locale: 'ru' });
    params.append('types[]', 'city');
    const response = await fetchFn(`${API_URL}?${params}`);
    if (!response.ok) throw new Error(`Places API responded with ${response.status}`);
    const places = (await response.json()) as ApiPlace[];

    const seen = new Set<string>();
    return places
      .filter((place) => place.type === 'city' && place.code && !seen.has(place.code) && seen.add(place.code))
      .slice(0, 5)
      .map((place) => ({
        code: place.code,
        name: place.name,
        country: place.country_name ?? '',
        countryCode: place.country_code ?? '',
      }));
  };
}
