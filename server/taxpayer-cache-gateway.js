/**
 * ============================================================
 * TAXPAYER CACHE GATEWAY — two-layer gatekeeping
 * ============================================================
 *
 * The one place that knows about BOTH the taxpayer cache
 * (storage/taxpayer-cache-store.js) and the lookup queue
 * (server/queue.js). server/app.js's POST /api/taxpayer route
 * calls getOrRefreshTaxpayer() instead of talking to either of
 * those directly — this keeps the route handler thin and keeps
 * the (slightly subtle) concurrency reasoning below in exactly
 * one file.
 *
 * THE PROBLEM THIS FILE SOLVES
 * -----------------------------
 * The naive version of "check cache, then run a live lookup if
 * stale" has a race: picture two requests for the same GSTIN
 * landing 200ms apart. Both check the cache before either one has
 * finished refreshing it, both see "stale," and both trigger a
 * full live lookup — exactly the duplicate-lookup problem caching
 * was supposed to remove, just moved slightly later in the
 * pipeline.
 *
 * THE FIX — validate at the moment you're about to act, not the
 * moment you asked. Two gates:
 *
 *   GATE 1 (fast pre-check, OUTSIDE the queue)
 *     Read the cache. If it's fresh enough, return it immediately.
 *     No queue, no browser, near-instant — this is the common case
 *     for a repeat GSTIN, and it costs nothing beyond one file read.
 *
 *   GATE 2 (re-validated check, INSIDE server/queue.js's
 *   runExclusive — only reached when Gate 1 found the cache stale
 *   or missing)
 *     Re-read the cache RIGHT THEN, at the moment this job actually
 *     gets to run. Because the queue is strictly ordered, by the
 *     time a given request's turn comes, anything that could have
 *     refreshed the cache ahead of it has already finished. If it's
 *     now fresh (someone ahead of us in line just refreshed it),
 *     return that — no browser touched. Only if it's STILL stale
 *     does a real live lookup happen.
 *
 * Net effect: for any burst of concurrent requests for the same
 * GSTIN, AT MOST ONE live lookup ever runs — using nothing but the
 * single-process queue that already exists (server/queue.js). No
 * distributed lock, no Redis, no new infrastructure. See
 * docs/gstin-cache-architecture-plan.md section 4.3 for the full
 * walkthrough and worked timeline examples.
 *
 * This is also, not coincidentally, the same "check → lock →
 * re-check" shape a Redis-backed version would use later — see
 * the architecture plan's section 7. Swapping `runExclusive` for a
 * distributed lock, if that's ever needed, would not require
 * touching the gate logic itself.
 */

const config = require("../config/config");
const logger = require("../logger/logger");
const { runExclusive } = require("./queue");
const { runLookup } = require("../pipeline/pipeline");
const { saveResult } = require("../storage/results-store");
const { getCached, setCached, isFresh } = require("../storage/taxpayer-cache-store");

/**
 * Resolves how old a cached result is allowed to be for THIS
 * request. The caller (POST /api/taxpayer's body) can override
 * the configured default per-request, since how fresh a lookup
 * needs to be genuinely varies by situation, not just by GSTIN —
 * see config.resultCache.defaultMaxAgeMs's own comment.
 *
 * `maxCacheAgeMs: 0` deliberately means "nothing cached is ever
 * fresh enough" — i.e. force a live lookup — falling out of the
 * same knob for free rather than needing a separate forceRefresh
 * flag (isFresh() already treats maxAgeMs <= 0 as "never fresh").
 *
 * @param {number|undefined} requestedMaxAgeMs - config.resultCache
 *   is bypassed with `enabled: false` — see getOrRefreshTaxpayer.
 */
function resolveMaxAgeMs(requestedMaxAgeMs) {

    if (requestedMaxAgeMs === undefined || requestedMaxAgeMs === null) {
        return config.resultCache.defaultMaxAgeMs;
    }

    const parsed = Number(requestedMaxAgeMs);

    if (!Number.isFinite(parsed) || parsed < 0) {
        logger.warn(
            `[Taxpayer Cache] Ignoring invalid maxCacheAgeMs (${JSON.stringify(requestedMaxAgeMs)}) — ` +
            `falling back to the configured default (${config.resultCache.defaultMaxAgeMs}ms).`
        );
        return config.resultCache.defaultMaxAgeMs;
    }

    return parsed;
}

/**
 * Performs the actual live lookup and writes both stores exactly
 * as POST /api/taxpayer always has:
 *   - storage/results-store.js — the permanent, per-lookup audit
 *     trail (unchanged, still written on every real lookup).
 *   - storage/taxpayer-cache-store.js — the canonical, overwritten
 *     cache record this feature adds.
 *
 * A cache-write failure is logged but never allowed to fail the
 * request — the live lookup itself already succeeded and that's
 * what the caller actually asked for.
 */
async function refreshTaxpayer(gstin) {

    const freshData = await runLookup(gstin);

    // Audit trail — unchanged behavior, still one new timestamped
    // file per real lookup, forever.
    await saveResult(gstin, freshData);

    // Canonical cache record — overwritten in place.
    await setCached(gstin, freshData);

    return freshData;
}

/**
 * The single entry point server/app.js's POST /api/taxpayer route
 * calls. Returns the taxpayer data plus whether it came from cache,
 * so the route can set the X-Cache response header without touching
 * the JSON body's shape.
 *
 * @param {string} gstin - already validated + normalized (uppercased)
 *   by the caller, same as before this feature existed.
 * @param {object} [options]
 * @param {number} [options.maxCacheAgeMs] - per-request freshness
 *   override; see resolveMaxAgeMs above.
 *
 * @returns {Promise<{data: object, cacheStatus: "HIT"|"MISS"}>}
 */
async function getOrRefreshTaxpayer(gstin, options = {}) {

    if (!config.resultCache.enabled) {
        // Master switch off — behave exactly as this endpoint did
        // before the cache existed. Still goes through the queue,
        // since that guarantee (only one Puppeteer/2Captcha run at
        // a time) is unrelated to caching and must never be skipped.
        logger.debug("[Taxpayer Cache] resultCache.enabled=false — skipping cache, running a live lookup.");
        const data = await runExclusive(() => refreshTaxpayer(gstin));
        return { data, cacheStatus: "MISS" };
    }

    const maxAgeMs = resolveMaxAgeMs(options.maxCacheAgeMs);

    // ------------------------------------------------------
    // GATE 1 — fast pre-check, outside the queue entirely.
    // ------------------------------------------------------
    const preCheckRecord = await getCached(gstin);

    if (isFresh(preCheckRecord, maxAgeMs)) {
        const ageMs = Date.now() - preCheckRecord.fetchedAt;
        logger.info(
            `[Taxpayer Cache] HIT for ${gstin} (age=${ageMs}ms, maxAge=${maxAgeMs}ms) — ` +
            "serving from cache, no browser lookup."
        );
        return { data: preCheckRecord.data, cacheStatus: "HIT" };
    }

    logger.debug(
        `[Taxpayer Cache] MISS/stale for ${gstin} at pre-check (maxAge=${maxAgeMs}ms) — ` +
        "queuing for a re-validated refresh."
    );

    // ------------------------------------------------------
    // GATE 2 — re-validated check, inside the queue. Only one
    // lookup job for the whole process runs at a time
    // (server/queue.js), so by the time this closure actually
    // executes, any refresh that was ahead of it in line has
    // already completed and written its result.
    // ------------------------------------------------------
    return runExclusive(async () => {

        const reCheckRecord = await getCached(gstin);

        if (isFresh(reCheckRecord, maxAgeMs)) {
            const ageMs = Date.now() - reCheckRecord.fetchedAt;
            logger.info(
                `[Taxpayer Cache] HIT for ${gstin} on re-check inside the queue ` +
                `(age=${ageMs}ms) — a request ahead of us already refreshed it. ` +
                "No browser lookup needed."
            );
            return { data: reCheckRecord.data, cacheStatus: "HIT" };
        }

        logger.info(`[Taxpayer Cache] Still stale for ${gstin} — running a live lookup.`);
        const data = await refreshTaxpayer(gstin);
        return { data, cacheStatus: "MISS" };
    });
}

module.exports = { getOrRefreshTaxpayer };
