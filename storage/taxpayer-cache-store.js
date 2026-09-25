/**
 * ============================================================
 * TAXPAYER RESULT CACHE STORE  (canonical per-GSTIN record)
 * ============================================================
 *
 * This is the fast-path cache from the approved cache-architecture
 * plan (see docs/gstin-cache-architecture-plan.md) — NOT the same
 * thing as storage/results-store.js, and it's worth being precise
 * about the difference:
 *
 *   - results-store.js is a permanent AUDIT TRAIL: one new
 *     timestamped file per lookup, forever, never overwritten.
 *     "What did this GSTIN look like on every date we ever
 *     checked it." Untouched by this module.
 *
 *   - taxpayer-cache-store.js (this file) is the CANONICAL,
 *     fast-path answer to "what's the current best known result
 *     for this GSTIN, and how old is it." Exactly ONE record per
 *     GSTIN, overwritten in place every time a fresh lookup
 *     succeeds. It never grows past "one file per distinct GSTIN
 *     ever looked up" — refreshing a GSTIN replaces its record,
 *     it never adds a new one.
 *
 * On-disk layout:
 *
 *   data/taxpayer-cache/
 *     <NORMALIZED_GSTIN>.json     one file per GSTIN, overwritten
 *                                  on every refresh
 *
 * Record shape (see README at the top of the architecture plan,
 * section 4.1):
 *
 *   {
 *     gstin: "27ABCDE1234F1Z5",   // duplicated inside the payload,
 *                                  // not just implied by the
 *                                  // filename, so a read can
 *                                  // self-verify against the key
 *                                  // it was fetched by
 *     data: { ... },              // the exact taxpayerDetails
 *                                  // payload — never reshaped
 *     fetchedAt: 1758781200000,   // Date.now() at the moment this
 *                                  // record was written — THIS is
 *                                  // what "how old is it" means.
 *                                  // See isFresh() below for why
 *                                  // this is deliberately NOT the
 *                                  // same thing as a filesystem
 *                                  // mtime or a Redis TTL.
 *     source: "GST_PORTAL",
 *     schemaVersion: 1
 *   }
 *
 * Freshness policy — "how old is acceptable" — deliberately does
 * NOT live here. This module only ever answers "how old is this
 * record" (isFresh, given a caller-supplied maxAgeMs) and "what's
 * the current record." Deciding what maxAgeMs should be for a
 * given request is server/taxpayer-cache-gateway.js's job, which
 * in turn resolves it from config.resultCache / the caller's
 * request body. Keeping that decision out of this file is
 * deliberate — see the architecture plan's "three different
 * concerns" discussion (fetchedAt vs. policy vs. retention).
 *
 * Writes are atomic (temp file + rename), which matters more here
 * than in any sibling store: every other module under storage/
 * writes a brand-new file once and never touches it again, so
 * there's nothing to race against. This file's whole point is to
 * be overwritten repeatedly over its lifetime, so without an
 * atomic write there'd be a real (if narrow) window where a
 * concurrent read — the cache-hit fast path in the gateway runs
 * with NO lock, by design — could see a half-written, truncated
 * JSON file. write-then-rename closes that window for free:
 * `fs.rename` is atomic on the same filesystem, so a reader always
 * either sees the old, complete file or the new, complete file,
 * never something in between.
 *
 * Never throws: exactly like every other storage/ module, a cache
 * read/write failure must never break a real lookup. Worst case,
 * a failed read behaves like a cache miss (falls through to a
 * live lookup) and a failed write just means the next request
 * doesn't benefit from this refresh — the lookup itself already
 * succeeded and was returned to the caller either way.
 */

const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const logger = require("../logger/logger");
const config = require("../config/config");

const SCHEMA_VERSION = 1;

/**
 * Same normalization rule the route layer already applies
 * (server/app.js uppercases every incoming GSTIN before it
 * reaches anything else) — repeated here, defensively, so this
 * module is correct even if some future caller forgets to
 * normalize first. "27abcde1234f1z5" and "27ABCDE1234F1Z5" must
 * always resolve to the exact same cache record, never two.
 */
function normalizeGstin(gstin) {
    return String(gstin || "").trim().toUpperCase();
}

function cacheFilePath(normalizedGstin) {
    return path.join(config.paths.taxpayerCacheDir, `${normalizedGstin}.json`);
}

/**
 * Reads the canonical cache record for a GSTIN.
 *
 * @param {string} gstin
 * @returns {Promise<{gstin: string, data: object, fetchedAt: number, source: string, schemaVersion: number} | null>}
 *   null if nothing has ever been cached for this GSTIN, the file
 *   is unreadable, or its contents don't parse — every one of
 *   those cases is treated identically to a cache miss.
 */
async function getCached(gstin) {

    const normalizedGstin = normalizeGstin(gstin);

    if (!normalizedGstin) {
        return null;
    }

    try {
        const raw = await fs.readFile(cacheFilePath(normalizedGstin), "utf8");
        const record = JSON.parse(raw);

        // Defensive consistency check (see the record-shape comment
        // above) — if the file's own gstin field doesn't match the
        // key we fetched it by, something is wrong with the
        // filesystem layer (a manual edit, a copy-paste mistake,
        // filesystem corruption). Treat it as a miss rather than
        // silently handing back data for the wrong GSTIN.
        if (record?.gstin !== normalizedGstin) {
            logger.warn(
                `Taxpayer cache record at ${normalizedGstin}.json has mismatched gstin ` +
                `field (${record?.gstin}) — treating as a cache miss.`
            );
            return null;
        }

        return record;

    } catch (error) {

        if (error.code === "ENOENT") {
            // No cache file yet for this GSTIN — a normal, expected miss.
            return null;
        }

        logger.warn({ err: error }, `Failed to read taxpayer cache for ${normalizedGstin} (non-fatal).`);
        return null;
    }
}

/**
 * Overwrites the one canonical cache record for a GSTIN with a
 * freshly fetched result. Atomic (temp file + rename) — see the
 * module-level comment for why that matters here specifically.
 *
 * @param {string} gstin
 * @param {object} data - the exact taxpayerDetails payload, never reshaped.
 * @returns {Promise<object|null>} the stored record, or null if writing failed
 *   (logged as a warning, never thrown — a cache-write failure must
 *   never undo an otherwise-successful lookup).
 */
async function setCached(gstin, data) {

    const normalizedGstin = normalizeGstin(gstin);

    if (!normalizedGstin) {
        logger.warn("[Taxpayer Cache] setCached called with an empty/invalid GSTIN — ignoring.");
        return null;
    }

    const record = {
        gstin: normalizedGstin,
        data,
        fetchedAt: Date.now(),
        source: "GST_PORTAL",
        schemaVersion: SCHEMA_VERSION
    };

    // Declared outside the try block so the catch handler below can
    // still see (and clean up) whichever temp path this attempt was
    // using, even if the failure happened after it was written.
    let tmpPath;

    try {
        await fs.mkdir(config.paths.taxpayerCacheDir, { recursive: true });

        const finalPath = cacheFilePath(normalizedGstin);

        // Unique temp filename (not just `${finalPath}.tmp`) so two
        // near-simultaneous refreshes for the SAME GSTIN — which
        // shouldn't happen given the gateway's queue-backed second
        // gate, but this module has no way to enforce that itself —
        // can't clobber each other's temp file mid-write. Only the
        // final atomic rename can ever actually win.
        tmpPath = `${finalPath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;

        await fs.writeFile(tmpPath, JSON.stringify(record, null, 2), "utf8");
        await fs.rename(tmpPath, finalPath); // atomic on the same filesystem

        logger.debug(
            `Taxpayer cache updated for ${normalizedGstin} (fetchedAt=${new Date(record.fetchedAt).toISOString()}).`
        );

        return record;

    } catch (error) {

        // If fs.writeFile succeeded but fs.rename then threw (e.g. a
        // transient filesystem error), the temp file is left behind
        // with nothing ever pointing at it again — a slow, silent
        // leak of `.tmp` files over the process's lifetime. Best-
        // effort cleanup: this itself must never throw or mask the
        // real error above, so any unlink failure (including the
        // completely normal case of the write never having reached
        // disk at all) is swallowed.
        if (tmpPath) {
            await fs.unlink(tmpPath).catch(() => {});
        }

        logger.warn({ err: error }, `Failed to write taxpayer cache for ${normalizedGstin} (non-fatal).`);
        return null;
    }
}

/**
 * Is a cache record fresh enough to use, given a caller-chosen
 * maxAgeMs? Pure function, no I/O — deliberately just arithmetic,
 * so the policy decision (what maxAgeMs SHOULD be) stays entirely
 * outside this store, in server/taxpayer-cache-gateway.js /
 * config.resultCache.
 *
 * @param {{fetchedAt: number}|null} record
 * @param {number} maxAgeMs - 0 means "nothing is ever fresh enough"
 *   (i.e. force a live lookup), matching config.resultCache's
 *   documented convention.
 * @returns {boolean}
 */
function isFresh(record, maxAgeMs) {

    if (!record || typeof record.fetchedAt !== "number") {
        return false;
    }

    if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
        return false;
    }

    const ageMs = Date.now() - record.fetchedAt;
    return ageMs >= 0 && ageMs <= maxAgeMs;
}

module.exports = { getCached, setCached, isFresh, normalizeGstin };
