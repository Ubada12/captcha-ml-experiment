/**
 * ============================================================
 * API APP — ROUTES
 * ============================================================
 *
 * Builds the Express app (routes + middleware) without starting
 * to listen — server.js owns the listen/timeout/shutdown
 * concerns, this just owns "what does the API look like."
 *
 * Endpoints:
 *
 * Every /api/* route requires a valid API key in the X-API-Key
 * header — see auth.js and config.security.apiKeys (API_KEYS in
 * .env). /health is intentionally left open so it can be used as
 * an unauthenticated uptime/liveness check.
 *
 *   GET  /health
 *     Liveness check. Also reports current queue depth. No API
 *     key required.
 *
 *   POST /api/taxpayer          body: { "gstin": "...", "maxCacheAgeMs"?: number }
 *     Returns taxpayer data for a GSTIN — from the disk cache
 *     when a fresh-enough result already exists, or by running a
 *     real lookup (launches a browser, solves a real CAPTCHA,
 *     submits the form, intercepts the taxpayerDetails response)
 *     when it doesn't. See server/taxpayer-cache-gateway.js and
 *     docs/gstin-cache-architecture-plan.md for the full design —
 *     in short: GSTIN is the cache key, a cached result is used
 *     when it's no older than `maxCacheAgeMs` (defaults to
 *     config.resultCache.defaultMaxAgeMs when omitted; pass 0 to
 *     force a live lookup regardless of what's cached), and at
 *     most one live lookup ever runs per GSTIN even under a burst
 *     of concurrent requests for it.
 *
 *     Deliberately POST, not GET — a cache MISS has real side
 *     effects (may cost a 2Captcha credit, writes files, can take
 *     up to a couple of minutes), which a "safe" GET shouldn't
 *     do. Any live lookup still runs through the queue in
 *     queue.js, so concurrent live lookups (for any GSTIN) are
 *     served one at a time exactly as before.
 *
 *     Responds with the taxpayerDetails JSON exactly as
 *     intercepted/cached — never reshaped — with an added
 *     `X-Cache: HIT` or `X-Cache: MISS` response header (not in
 *     the body) so callers/logs can tell which path served the
 *     request without the payload contract changing at all.
 *
 *   GET  /api/taxpayer/:gstin/cached
 *     Returns the most recently stored result for that GSTIN
 *     from the permanent audit trail (storage/results-store.js),
 *     with no browser involved and no freshness check — 404 if
 *     nothing has ever been looked up for that GSTIN. This is a
 *     genuinely different contract from POST's cache ("give me
 *     whatever's on record, however old, or 404" vs. "give me a
 *     fresh-enough answer, refreshing if needed") and is
 *     deliberately left untouched by the cache feature above.
 */

const express = require("express");
const logger = require("../logger/logger");
const { getOrRefreshTaxpayer } = require("./taxpayer-cache-gateway");
const { getQueueLength } = require("./queue");
const { requireApiKey } = require("./auth");
const { isValidGstin } = require("../utils/gstin");
const { getLatestResult } = require("../storage/results-store");

function createApp() {

    const app = express();
    app.use(express.json());

    app.get("/health", (req, res) => {
        res.json({ status: "ok", queueLength: getQueueLength() });
    });

    // Everything below this line requires a valid X-API-Key header.
    app.use("/api", requireApiKey);

    app.get("/api/taxpayer/:gstin/cached", async (req, res) => {
        const gstin = String(req.params.gstin || "").toUpperCase();

        if (!isValidGstin(gstin)) {
            return res.status(400).json({ error: `Invalid GSTIN format: ${gstin}` });
        }

        const cached = await getLatestResult(gstin);

        if (!cached) {
            return res.status(404).json({ error: `No stored result for GSTIN ${gstin}.` });
        }

        res.json(cached);
    });

    app.post("/api/taxpayer", async (req, res) => {
        const gstin = String(req.body?.gstin || "").toUpperCase();

        if (!isValidGstin(gstin)) {
            return res.status(400).json({ error: `Invalid GSTIN format: ${gstin}` });
        }

        // Optional per-request freshness override — see the route's
        // own doc comment above and server/taxpayer-cache-gateway.js.
        // Left undefined when the caller doesn't send it, which
        // resolveMaxAgeMs() there treats as "use the configured
        // default," not as 0/force-refresh.
        const rawMaxCacheAgeMs = req.body?.maxCacheAgeMs;
        const maxCacheAgeMs = rawMaxCacheAgeMs === undefined ? undefined : Number(rawMaxCacheAgeMs);

        logger.info(`Received lookup request for GSTIN ${gstin}. Queue depth: ${getQueueLength()}.`);

        try {
            const { data, cacheStatus } = await getOrRefreshTaxpayer(gstin, { maxCacheAgeMs });

            // Cache hit/miss is signaled out-of-band via a response
            // header, never inside the body — the body stays exactly
            // the taxpayerDetails JSON as intercepted/cached, never
            // reshaped, whether this was a HIT or a MISS.
            res.set("X-Cache", cacheStatus);
            res.json(data);

        } catch (error) {
            logger.error({ err: error }, `Lookup failed for GSTIN ${gstin}.`);
            res.status(502).json({
                error: "GST portal lookup failed.",
                details: error.message
            });
        }
    });

    app.use((req, res) => {
        res.status(404).json({ error: "Not found." });
    });

    return app;
}

module.exports = { createApp };
