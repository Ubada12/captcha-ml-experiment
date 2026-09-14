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
 *   POST /api/taxpayer          body: { "gstin": "..." }
 *     Triggers a real lookup: launches a browser, solves a real
 *     CAPTCHA via 2Captcha, submits the form, intercepts the
 *     taxpayerDetails response. Deliberately POST, not GET —
 *     this has real side effects (costs a 2Captcha credit,
 *     writes files, takes up to a couple of minutes), which a
 *     "safe" GET shouldn't do. Runs through the queue in
 *     queue.js, so concurrent requests are served one at a time.
 *     Responds with the taxpayerDetails JSON exactly as
 *     intercepted — never reshaped.
 *
 *   GET  /api/taxpayer/:gstin/cached
 *     Returns the most recently stored result for that GSTIN
 *     from disk, with no browser involved. 404 if nothing has
 *     been looked up for that GSTIN yet.
 */

const express = require("express");
const logger = require("../logger/logger");
const { runLookup } = require("../pipeline/pipeline");
const { runExclusive, getQueueLength } = require("./queue");
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

        logger.info(`Received lookup request for GSTIN ${gstin}. Queue depth: ${getQueueLength()}.`);

        try {
            const result = await runExclusive(() => runLookup(gstin));

            // Returned exactly as intercepted from the taxpayerDetails
            // network response — never reshaped here or upstream.
            res.json(result);

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
