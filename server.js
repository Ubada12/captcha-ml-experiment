/**
 * ============================================================
 * SERVER — HTTP ENTRY POINT
 * ============================================================
 *
 * Starts the API defined in server/app.js. Run alongside (or
 * instead of) the one-shot CLI (main.js) — both share the same
 * pipeline/pipeline.js core.
 *
 *   node server.js
 */

require("dotenv").config();

const config = require("./config/config");
const logger = require("./logger/logger");
const { createApp } = require("./server/app");

const app = createApp();

const httpServer = app.listen(config.server.port, () => {
    logger.success(`API server listening on port ${config.server.port}.`);
});

// A single lookup can legitimately take a couple of minutes — see
// config.server.requestTimeoutMs for why.
httpServer.setTimeout(config.server.requestTimeoutMs);

function shutdown(signal) {
    logger.info(`${signal} received. Shutting down API server...`);

    httpServer.close(() => {
        logger.info("API server closed.");
        process.exit(0);
    });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
