/**
 * ============================================================
 * API KEY AUTH
 * ============================================================
 *
 * Every /api/* route requires a valid key in the X-API-Key
 * header. Keys live in API_KEYS in .env — a comma-separated
 * list, so more than one client can each get their own key
 * without needing a database.
 *
 * Fails closed: if API_KEYS isn't set at all, every request is
 * rejected (503) rather than silently letting everything through
 * because nobody configured it yet.
 *
 * Key comparison is constant-time (crypto.timingSafeEqual)
 * rather than `===`, so a wrong guess can't be narrowed down
 * faster by measuring how quickly the comparison fails.
 */

const crypto = require("crypto");
const logger = require("../logger/logger");
const config = require("../config/config");

function timingSafeEqualStrings(a, b) {
    const bufferA = Buffer.from(a);
    const bufferB = Buffer.from(b);

    if (bufferA.length !== bufferB.length) {
        // timingSafeEqual throws on mismatched lengths. Compare the
        // buffer against itself instead, purely so this branch takes
        // comparable time to the equal-length branch below — it's
        // never going to be reported as a match either way.
        crypto.timingSafeEqual(bufferA, bufferA);
        return false;
    }

    return crypto.timingSafeEqual(bufferA, bufferB);
}

function isValidApiKey(candidate) {
    if (typeof candidate !== "string" || candidate.length === 0) {
        return false;
    }

    return config.security.apiKeys.some(key => timingSafeEqualStrings(candidate, key));
}

function requireApiKey(req, res, next) {

    if (config.security.apiKeys.length === 0) {
        logger.error(
            "API_KEYS is not configured in .env — refusing all /api requests until it is set."
        );
        return res.status(503).json({ error: "API is not configured yet." });
    }

    const providedKey = req.get("X-API-Key");

    if (!isValidApiKey(providedKey)) {
        logger.warn(`Rejected request with missing/invalid API key (${req.method} ${req.originalUrl}).`);
        return res.status(401).json({ error: "Missing or invalid API key." });
    }

    next();
}

module.exports = { requireApiKey, isValidApiKey };
