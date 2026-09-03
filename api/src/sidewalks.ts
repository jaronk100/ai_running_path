import { config } from "./config.js";

/**
 * OSM sidewalk=* lookup by way id.
 *
 * This exists because GraphHopper cannot expose `sidewalk` as an encoded value
 * without a Java patch (confirmed by upstream: "It is not yet possible without
 * modifying the source code"). Separately-drawn sidewalks already arrive as
 * road_class == FOOTWAY, so this only fills the other case: a roadway carrying
 * a sidewalk=* tag.
 *
 * Cache is in-memory and unbounded-ish by design — way tags are effectively
 * static, and one Austin-sized metro warms up to a few hundred thousand entries
 * at most. Move this to Redis or SQLite before running more than one instance.
 */

export type SidewalkSide = "both" | "left" | "right" | "yes" | "separate" | "no" | "unknown";

const cache = new Map<number, SidewalkSide>();
const OVERPASS_CHUNK = 400;

export function cachedCount(): number {
  return cache.size;
}

function normalise(raw: string | undefined): SidewalkSide {
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

/**
 * Resolve sidewalk tags for the given way ids. Never throws: on any Overpass
 * failure the unresolved ids come back as "unknown", which the scorer already
 * treats as a neutral, non-excluding state.
 */
export async function lookupSidewalks(
  wayIds: Iterable<number>,
): Promise<{ tags: Map<number, SidewalkSide>; complete: boolean }> {
  const tags = new Map<number, SidewalkSide>();
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
      for (const id of chunk) tags.set(id, "unknown");
    }
  }

  return { tags, complete };
}

async function fetchChunk(
  ids: number[],
  into: Map<number, SidewalkSide>,
): Promise<boolean> {
  const query = `[out:json][timeout:20];way(id:${ids.join(",")});out tags;`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.overpassTimeoutMs);

  try {
    const res = await fetch(config.overpassUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });
    if (!res.ok) return false;

    const json = (await res.json()) as {
      elements?: { id: number; tags?: Record<string, string> }[];
    };

    const seen = new Set<number>();
    for (const el of json.elements ?? []) {
      // sidewalk:both=yes / sidewalk:left=yes are the newer schema; fall back
      // through them before giving up on a way.
      const t = el.tags ?? {};
      let value = normalise(t["sidewalk"]);
      if (value === "unknown") {
        const left = t["sidewalk:left"] && t["sidewalk:left"] !== "no";
        const right = t["sidewalk:right"] && t["sidewalk:right"] !== "no";
        if (left && right) value = "both";
        else if (left) value = "left";
        else if (right) value = "right";
        else if (t["sidewalk:both"]) value = normalise(t["sidewalk:both"]) === "no" ? "no" : "both";
        else if (t["sidewalk:left"] || t["sidewalk:right"]) value = "no";
      }
      cache.set(el.id, value);
      into.set(el.id, value);
      seen.add(el.id);
    }

    // Ways Overpass did not return (deleted, or outside the extract) are known
    // to be unknown rather than pending — cache that so we stop re-asking.
    for (const id of ids) {
      if (!seen.has(id)) {
        cache.set(id, "unknown");
        into.set(id, "unknown");
      }
    }
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
