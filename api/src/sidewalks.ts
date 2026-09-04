import { config } from "./config.js";

/**
 * OSM way-tag lookup for the attributes GraphHopper cannot expose.
 *
 * Two gaps, both verified against the shipped GraphHopper 11 jar:
 *
 * - `sidewalk` is not an encoded value and cannot be added without patching
 *   Java source. Separately-drawn sidewalks do arrive natively as
 *   `footway == SIDEWALK`, so this only fills the other case: a roadway
 *   carrying a sidewalk=* tag.
 * - `lit` is not an encoded value either, despite what some GraphHopper docs
 *   claim. There is no Lit class in com.graphhopper.routing.ev at all, so
 *   streetlight coverage has to come from here.
 *
 * Cache is in-memory. Way tags are effectively static, so an Austin-sized metro
 * warms up quickly. Move to Redis or SQLite before running more than one
 * instance.
 */

export type SidewalkSide =
  | "both"
  | "left"
  | "right"
  | "yes"
  | "separate"
  | "no"
  | "unknown";

export interface WayTags {
  sidewalk: SidewalkSide;
  /** null means unknown, which is common and must never exclude a route. */
  lit: boolean | null;
}

const UNKNOWN: WayTags = { sidewalk: "unknown", lit: null };

const cache = new Map<number, WayTags>();
const OVERPASS_CHUNK = 400;

export function cachedCount(): number {
  return cache.size;
}

function normaliseSidewalk(raw: string | undefined): SidewalkSide {
  if (!raw) return "unknown";
  const v = raw.trim().toLowerCase();
  if (v === "both") return "both";
  if (v === "left") return "left";
  if (v === "right") return "right";
  if (v === "yes") return "yes";
  if (v === "separate") return "separate";
  if (v === "no" || v === "none") return "no";
  return "unknown";
}

function normaliseLit(raw: string | undefined): boolean | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (v === "no" || v === "disused") return false;
  // yes, 24/7, automatic, sunset-sunrise, limited... all count as lit.
  return true;
}

function readTags(t: Record<string, string>): WayTags {
  let sidewalk = normaliseSidewalk(t["sidewalk"]);

  if (sidewalk === "unknown") {
    // Newer schema: sidewalk:left=yes / sidewalk:right=no
    const left = t["sidewalk:left"] && t["sidewalk:left"] !== "no";
    const right = t["sidewalk:right"] && t["sidewalk:right"] !== "no";
    if (left && right) sidewalk = "both";
    else if (left) sidewalk = "left";
    else if (right) sidewalk = "right";
    else if (t["sidewalk:both"]) {
      sidewalk = normaliseSidewalk(t["sidewalk:both"]) === "no" ? "no" : "both";
    } else if (t["sidewalk:left"] || t["sidewalk:right"]) {
      sidewalk = "no";
    }
  }

  return { sidewalk, lit: normaliseLit(t["lit"]) };
}

/**
 * Resolve tags for the given way ids. Never throws: on any Overpass failure the
 * unresolved ids come back as unknown, which the scorer treats as neutral.
 */
export async function lookupWayTags(
  wayIds: Iterable<number>,
): Promise<{ tags: Map<number, WayTags>; complete: boolean }> {
  const tags = new Map<number, WayTags>();
  const missing: number[] = [];

  for (const id of wayIds) {
    const hit = cache.get(id);
    if (hit !== undefined) tags.set(id, hit);
    else missing.push(id);
  }

  if (missing.length === 0) return { tags, complete: true };

  let complete = true;
  for (let i = 0; i < missing.length; i += OVERPASS_CHUNK) {
    const chunk = missing.slice(i, i + OVERPASS_CHUNK);
    const ok = await fetchChunk(chunk, tags);
    if (!ok) {
      complete = false;
      for (const id of chunk) tags.set(id, UNKNOWN);
    }
  }

  return { tags, complete };
}

async function fetchChunk(
  ids: number[],
  into: Map<number, WayTags>,
): Promise<boolean> {
  const query = `[out:json][timeout:20];way(id:${ids.join(",")});out tags;`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.overpassTimeoutMs);

  try {
    const res = await fetch(config.overpassUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        // Overpass returns 406 Not Acceptable to Node's default headers. Without
        // this the whole sidewalk/lit feature fails silently and every route
        // looks like it merely has no data.
        "user-agent": "RunPath/0.1 (running route planner)",
        accept: "application/json",
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });
    if (!res.ok) return false;

    const json = (await res.json()) as {
      elements?: { id: number; tags?: Record<string, string> }[];
    };

    const seen = new Set<number>();
    for (const el of json.elements ?? []) {
      const parsed = readTags(el.tags ?? {});
      cache.set(el.id, parsed);
      into.set(el.id, parsed);
      seen.add(el.id);
    }

    // Ways Overpass did not return are known-unknown rather than pending.
    // Cache that so we stop re-asking on every subsequent search.
    for (const id of ids) {
      if (!seen.has(id)) {
        cache.set(id, UNKNOWN);
        into.set(id, UNKNOWN);
      }
    }
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
