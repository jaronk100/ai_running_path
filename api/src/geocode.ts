import { config } from "./config.js";
import type { LatLng } from "./types.js";

export interface GeocodeResult {
  point: LatLng;
  matchedAddress: string;
}

/**
 * US Census geocoder: free, keyless, US-only, and good on street addresses.
 * Swap for Mapbox if you ever need POI names or non-US coverage — the shape of
 * this function is the only thing that would change.
 */
export async function geocode(address: string): Promise<GeocodeResult | null> {
  const url = new URL(config.censusGeocodeUrl);
  url.searchParams.set("address", address);
  url.searchParams.set("benchmark", "Public_AR_Current");
  url.searchParams.set("format", "json");

  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) return null;

  const json = (await res.json()) as {
    result?: {
      addressMatches?: {
        matchedAddress?: string;
        coordinates?: { x: number; y: number };
      }[];
    };
  };

  const match = json.result?.addressMatches?.[0];
  const c = match?.coordinates;
  if (!c) return null;

  return {
    point: { lat: c.y, lon: c.x },
    matchedAddress: match.matchedAddress ?? address,
  };
}
