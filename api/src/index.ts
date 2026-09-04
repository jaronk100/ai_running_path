import express from "express";
import { z } from "zod";
import { findRoutes } from "./candidates.js";
import { config } from "./config.js";
import { googleMapsUrl, toGpx, totalRunMiles } from "./export.js";
import * as gh from "./graphhopper.js";
import { cachedCount } from "./sidewalks.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

const searchSchema = z.object({
  address: z.string().min(3).max(300),
  distanceMi: z.number().positive().max(100),
  pathType: z.enum(["loop", "out_and_back"]),
  // Ignored for out_and_back, which always starts at the door.
  maxApproachMi: z
    .number()
    .min(0)
    .max(config.search.maxApproachCapMi)
    .optional(),
  page: z.number().int().min(1).max(20).optional(),
});

app.get("/health", async (_req, res) => {
  const routingUp = await gh.health();
  res.status(routingUp ? 200 : 503).json({
    ok: routingUp,
    graphhopper: routingUp ? "up" : "unreachable",
    sidewalkCacheEntries: cachedCount(),
  });
});

app.post("/search", async (req, res) => {
  const parsed = searchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", detail: parsed.error.issues });
    return;
  }

  try {
    const result = await findRoutes(parsed.data);

    res.json({
      ...result,
      candidates: result.candidates.map((c) => ({
        ...c,
        googleMapsUrl: googleMapsUrl(c.coordinates, c.approachCoordinates),
        // Convenience for the results card: what one lap actually costs.
        singleLapTotalMi: Number(
          totalRunMiles(c.approachDistanceMi, c.loopDistanceMi, 1).toFixed(2),
        ),
      })),
      // Surfaced so the UI can say "no sidewalk data for this area" rather than
      // silently implying these routes have no sidewalks.
      notes: result.sidewalkDataComplete
        ? []
        : ["Sidewalk data was unavailable for some segments; those are scored neutrally."],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    if (message.startsWith("Could not geocode")) {
      res.status(422).json({ error: "geocode_failed", detail: message });
      return;
    }
    console.error("[search] failed:", err);
    res.status(502).json({ error: "search_failed", detail: message });
  }
});

const gpxSchema = z.object({
  name: z.string().min(1).max(120).default("RunPath route"),
  coordinates: z.array(z.tuple([z.number(), z.number()])).min(2),
});

app.post("/export/gpx", (req, res) => {
  const parsed = gpxSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", detail: parsed.error.issues });
    return;
  }
  const gpx = toGpx(parsed.data.coordinates, parsed.data.name);
  res.type("application/gpx+xml").send(gpx);
});

const totalSchema = z.object({
  approachMi: z.number().min(0),
  loopMi: z.number().positive(),
  laps: z.number().int().min(1).max(50),
});

/** The total-run screen: 2A + (N x L). */
app.post("/total", (req, res) => {
  const parsed = totalSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", detail: parsed.error.issues });
    return;
  }
  const { approachMi, loopMi, laps } = parsed.data;
  res.json({
    approachMi,
    loopMi,
    laps,
    approachTotalMi: Number((approachMi * 2).toFixed(2)),
    loopTotalMi: Number((loopMi * laps).toFixed(2)),
    totalMi: Number(totalRunMiles(approachMi, loopMi, laps).toFixed(2)),
  });
});

app.listen(config.port, () => {
  console.log(`runpath-api listening on :${config.port}`);
  console.log(`graphhopper: ${config.graphhopperUrl} (profile "${config.profile}")`);
});
