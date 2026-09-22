import { config } from "./config.js";
import type { LatLng } from "./types.js";

/**
 * Address -> coordinates, OSM first with the US Census as a fallback, and every
 * result checked against what was actually typed.
 *
 * The checking is not optional. The US Census geocoder silently answered
 * "1011 S Bagdad Rd, Leander" with "1011 BAGDAD RD" -- it dropped the S,
 * interpolated the house number onto a different Bagdad Road, and returned a
 * point 2 miles from the Leander library. Every route was then correctly built
 * around the wrong place. A geocoder that fails loudly is far better than one
 * that answers confidently and wrongly, so a result whose house number or
 * street does not match the query is discarded.
 *
 * Census is also address-only: it cannot find "Mason Homestead", and misses
 * addresses outside its known ranges (11840 Crystal Falls Pkwy). OSM has the
 * places and the newer addresses, so it leads.
 */

export interface GeocodeResult {
  point: LatLng;
  matchedAddress: string;
  source: "osm" | "census";
}

const cache = new Map<string, GeocodeResult | null>();

/**
 * Nominatim's usage policy allows at most one request per second. Calls are
 * queued rather than fired in parallel. Before this app has real traffic, move
 * to a self-hosted Nominatim or Photon, or a paid geocoder -- see docs/setup.md.
 */
const MIN_GAP_MS = 1100;
let lastCall = 0;
let queue: Promise<unknown> = Promise.resolve();

function serialise<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = MIN_GAP_MS - (Date.now() - lastCall);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await fn();
    } finally {
      lastCall = Date.now();
    }
  });
  queue = run.catch(() => undefined);
  return run as Promise<T>;
}

const HEADERS = {
  "user-agent": config.userAgent,
  accept: "application/json",
};

const STREET_SUFFIXES = new Set([
  "rd", "road", "st", "street", "ave", "avenue", "dr", "drive", "ln", "lane",
  "blvd", "boulevard", "pkwy", "parkway", "ct", "court", "cir", "circle",
  "trl", "trail", "way", "hwy", "highway", "pl", "place", "ter", "terrace",
  "loop", "run", "path", "cv", "cove", "bnd", "bend", "psge", "pass",
]);
const DIRECTIONS: Record<string, string> = {
  n: "north", s: "south", e: "east", w: "west",
  ne: "northeast", nw: "northwest", se: "southeast", sw: "southwest",
  north: "north", south: "south", east: "east", west: "west",
  northeast: "northeast", northwest: "northwest",
  southeast: "southeast", southwest: "southwest",
};

const words = (s: string) =>
  s.toLowerCase().replace(/[.,]/g, " ").split(/\s+/).filter(Boolean);

interface Parsed {
  houseNumber: string | null;
  direction: string | null;
  streetWords: string[];
}

/** Pull house number, directional prefix and street name out of an address. */
export function parseAddress(text: string): Parsed {
  // Only the part before the first comma is the street line.
  const line = text.split(",")[0] ?? text;
  const tokens = words(line);

  let houseNumber: string | null = null;
  if (tokens[0] && /^\d+[a-z]?$/.test(tokens[0])) houseNumber = tokens.shift()!;

  let direction: string | null = null;
  if (tokens[0] && DIRECTIONS[tokens[0]] && tokens.length > 1) {
    direction = DIRECTIONS[tokens.shift()!]!;
  }

  const streetWords = tokens.filter(
    (t) => !STREET_SUFFIXES.has(t) && !DIRECTIONS[t],
  );
  return { houseNumber, direction, streetWords };
}

/**
 * Does a candidate answer the question that was asked? House number must match
 * when one was given, the street name must contain every distinctive word of
 * the query, and a directional prefix must not contradict.
 */
export function addressMatches(query: string, candidate: string): boolean {
  const q = parseAddress(query);
  const c = parseAddress(candidate);

  if (q.houseNumber && c.houseNumber && q.houseNumber !== c.houseNumber) return false;
  if (q.direction && c.direction && q.direction !== c.direction) return false;
  // A query that names a direction the candidate lacks is the Bagdad Rd trap.
  if (q.direction && !c.direction) return false;

  const candidateWords = new Set(words(candidate));
  return q.streetWords.every((w) => candidateWords.has(w));
}

async function fromOsm(address: string): Promise<GeocodeResult | null> {
  const url = new URL(config.nominatimUrl);
  url.searchParams.set("q", address);
  url.searchParams.set("format", "json");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", "5");
  url.searchParams.set("countrycodes", "us");

  const res = await serialise(() => fetch(url, { headers: HEADERS }));
  if (!res.ok) return null;

  const rows = (await res.json()) as {
    lat: string;
    lon: string;
    display_name: string;
    name?: string;
    address?: Record<string, string>;
  }[];

  const asked = parseAddress(address);
  for (const row of rows) {
    const a = row.address ?? {};
    const street = [a["house_number"], a["road"]].filter(Boolean).join(" ");
    const label = street || row.name || row.display_name.split(",")[0] || "";

    // A named place ("Mason Homestead") needs no house number to be right.
    const namedMatch =
      !asked.houseNumber &&
      !!row.name &&
      asked.streetWords.every((w) => words(row.name!).includes(w));

    if (namedMatch || (street && addressMatches(address, street))) {
      return {
        point: { lat: Number(row.lat), lon: Number(row.lon) },
        matchedAddress: row.display_name.split(",").slice(0, 3).join(",").trim(),
        source: "osm",
      };
    }
  }
  return null;
}

async function fromCensus(address: string): Promise<GeocodeResult | null> {
  const url = new URL(config.censusGeocodeUrl);
  url.searchParams.set("address", address);
  url.searchParams.set("benchmark", "Public_AR_Current");
  url.searchParams.set("format", "json");

  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) return null;

  const json = (await res.json()) as {
    result?: {
      addressMatches?: { matchedAddress?: string; coordinates?: { x: number; y: number } }[];
    };
  };

  for (const m of json.result?.addressMatches ?? []) {
    const c = m.coordinates;
    if (!c || !m.matchedAddress) continue;
    if (!addressMatches(address, m.matchedAddress)) continue;
    return {
      point: { lat: c.y, lon: c.x },
      matchedAddress: m.matchedAddress,
      source: "census",
    };
  }
  return null;
}

export async function geocode(address: string): Promise<GeocodeResult | null> {
  const key = address.trim().toLowerCase().replace(/\s+/g, " ");
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  let result: GeocodeResult | null = null;
  try {
    result = await fromOsm(address);
  } catch {
    result = null; // fall through to Census
  }
  if (!result) {
    try {
      result = await fromCensus(address);
    } catch {
      result = null;
    }
  }

  cache.set(key, result);
  return result;
}
