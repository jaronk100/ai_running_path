import { fileURLToPath } from "node:url";
import express from "express";
import { z } from "zod";
import { GeocodeFailed, OutsideMapArea, findRoutes } from "./candidates.js";
import { config } from "./config.js";
import { googleMapsUrl, toGpx, totalRunMiles } from "./export.js";
import * as gh from "./graphhopper.js";

/** Form-field names as a person would read them back. */
const FIELD_LABELS: Record<string, string> = {
  address: "Start address",
  distanceMi: "Distance",
  pathType: "Path type",
  maxApproachMi: "Max distance to loop start",
  page: "Page",
  name: "Route name",
  coordinates: "Route",
  approachMi: "Approach distance",
  loopMi: "Loop distance",
  laps: "Laps",
};

/**
 * Validation failures as a sentence someone can act on. Returning the raw
 * issue list meant the UI could only say "invalid_request", which names the
 * category of problem and nothing about the problem.
 */
function describeIssues(error: z.ZodError): string {
  const parts: string[] = [];
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "");
    const label = FIELD_LABELS[key] ?? key ?? "Request";
    let text: string;

    switch (issue.code) {
      case "invalid_type":
        text =
          issue.received === "undefined"
            ? `${label} is required.`
            : `${label} must be a ${issue.expected}.`;
        break;
      case "too_small":
        text =
          issue.type === "string"
            ? `${label} must be at least ${issue.minimum} characters.`
            : `${label} must be ${issue.inclusive ? "at least" : "greater than"} ${issue.minimum}.`;
        break;
      case "too_big":
        text =
          issue.type === "string"
            ? `${label} must be at most ${issue.maximum} characters.`
            : `${label} must be ${issue.inclusive ? "at most" : "less than"} ${issue.maximum}.`;
        break;
      case "invalid_enum_value":
        text = `${label} must be one of: ${issue.options.join(", ")}.`;
        break;
      default:
        text = `${label} is not valid.`;
    }
    if (!parts.includes(text)) parts.push(text);
  }
  return parts.join(" ") || "The request was not valid.";
}

const app = express();
app.use(express.json({ limit: "2mb" }));

// Dev route viewer at /viewer: draws /search results on a map so candidate
// shapes can be judged by eye, which no metric replaces. Resolves the same way
// under tsx (src/) and the compiled build (dist/).
app.use(
  express.static(fileURLToPath(new URL("../public", import.meta.url)), {
    extensions: ["html"],
    // Revalidate every load. Without this a browser can sit on a cached copy
    // of the viewer for days and appear to be missing changes that shipped.
    setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
  }),
);

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
  });
});

app.post("/search", async (req, res) => {
  const parsed = searchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", detail: describeIssues(parsed.error) });
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
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    // These two are the user's problem to fix, not a server fault, and the UI
    // shows the detail verbatim -- so they carry a sentence worth reading.
    if (err instanceof GeocodeFailed) {
      res.status(422).json({ error: "geocode_failed", detail: message });
      return;
    }
    if (err instanceof OutsideMapArea) {
      res.status(422).json({ error: "outside_map_area", detail: message });
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
    res.status(400).json({ error: "invalid_request", detail: describeIssues(parsed.error) });
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
    res.status(400).json({ error: "invalid_request", detail: describeIssues(parsed.error) });
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
