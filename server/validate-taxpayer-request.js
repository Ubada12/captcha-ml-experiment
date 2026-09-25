/**
 * ============================================================
 * POST /api/taxpayer — REQUEST BODY VALIDATION
 * ============================================================
 *
 * Pulled out of server/app.js into its own small, pure, dependency-free
 * function specifically so it can be unit-tested directly (see
 * test/validate-taxpayer-request.test.js) without needing an HTTP
 * server or a mocked pipeline — this only ever looks at the parsed
 * JSON body and returns a verdict, no I/O of any kind.
 *
 * WHY THIS EXISTS (found during the whole-project audit before
 * deployment planning started):
 *
 *   server/app.js used to do this inline:
 *
 *     const maxCacheAgeMs = rawMaxCacheAgeMs === undefined
 *       ? undefined
 *       : Number(rawMaxCacheAgeMs);
 *
 *   A client sending the very natural `"maxCacheAgeMs": null` is NOT
 *   `undefined` (`null !== undefined`), so this fell through to
 *   `Number(null)`, which JavaScript evaluates to `0` — and `0` is
 *   this system's own convention for "force a live lookup, ignore
 *   anything cached." So sending `null` (meaning, to any reasonable
 *   caller, "I don't care, use whatever's normal") silently forced
 *   every request into the most expensive path there is, with no
 *   warning logged anywhere. This module fixes that by treating
 *   `null` exactly like "the field wasn't sent" — both mean "use
 *   config.resultCache.defaultMaxAgeMs" — and by rejecting anything
 *   else that isn't a genuine non-negative number with a clear 400,
 *   instead of silently coercing it into something the caller didn't
 *   ask for.
 *
 * Every field the client can send in this request body is validated
 * here, up front, before anything expensive (cache read, queue,
 * browser) is touched — same principle as the pre-existing GSTIN
 * format check, just centralized and extended to maxCacheAgeMs too.
 *
 * @param {*} body - req.body, already JSON-parsed by express.json().
 *   Anything at all can show up here — a client can send whatever it
 *   wants — so every field is checked for both presence and type.
 *
 * @returns {{valid: true, gstin: string, maxCacheAgeMs: number|undefined}
 *          |{valid: false, errors: string[]}}
 *   On success, `gstin` is trimmed + uppercased (the normalized form
 *   every downstream module expects) and `maxCacheAgeMs` is either a
 *   validated finite number >= 0, or `undefined` — meaning "the
 *   caller didn't ask for anything specific, fall back to the
 *   configured default" — never `null`, never NaN, never negative.
 */

const { isValidGstin } = require("../utils/gstin");

function validateTaxpayerRequestBody(body) {
    const errors = [];

    // ------------------------------------------------------
    // gstin — required, must be a non-empty string, must match the
    // GSTIN format (utils/gstin.js's own shape check).
    // ------------------------------------------------------
    const rawGstin = body?.gstin;
    let gstin = null;

    if (rawGstin === undefined || rawGstin === null || rawGstin === "") {
        errors.push("\"gstin\" is required.");
    } else if (typeof rawGstin !== "string") {
        errors.push(`"gstin" must be a string, got ${typeof rawGstin}.`);
    } else {
        const normalized = rawGstin.trim().toUpperCase();
        if (!isValidGstin(normalized)) {
            errors.push(`"gstin" is not a valid GSTIN: ${JSON.stringify(rawGstin)}`);
        } else {
            gstin = normalized;
        }
    }

    // ------------------------------------------------------
    // maxCacheAgeMs — optional. Absent or null both mean "use
    // config.resultCache.defaultMaxAgeMs" (see server/taxpayer-cache-
    // gateway.js's resolveMaxAgeMs). When present, it must be a
    // genuine finite number >= 0 — 0 is the documented "force a live
    // lookup" convention, so it's explicitly allowed, not treated as
    // falsy/missing.
    // ------------------------------------------------------
    const rawMaxCacheAgeMs = body?.maxCacheAgeMs;
    let maxCacheAgeMs; // stays undefined unless a valid value is provided

    if (rawMaxCacheAgeMs !== undefined && rawMaxCacheAgeMs !== null) {
        if (typeof rawMaxCacheAgeMs !== "number" || !Number.isFinite(rawMaxCacheAgeMs)) {
            errors.push(
                `"maxCacheAgeMs" must be a finite number of milliseconds when provided ` +
                `(omit it, or send null, to use the configured default) — got ${JSON.stringify(rawMaxCacheAgeMs)}.`
            );
        } else if (rawMaxCacheAgeMs < 0) {
            errors.push(
                `"maxCacheAgeMs" must be >= 0 (0 means "force a live lookup, ignore anything cached") — got ${rawMaxCacheAgeMs}.`
            );
        } else {
            maxCacheAgeMs = rawMaxCacheAgeMs;
        }
    }

    if (errors.length > 0) {
        return { valid: false, errors };
    }

    return { valid: true, gstin, maxCacheAgeMs };
}

module.exports = { validateTaxpayerRequestBody };
