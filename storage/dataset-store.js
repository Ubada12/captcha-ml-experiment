/**
 * ============================================================
 * CAPTCHA DATASET STORE  (Level 3 of the roadmap)
 * ============================================================
 *
 * Persists a verified (image, label) pair every time 2Captcha
 * successfully solves one of our own CAPTCHAs — the raw
 * material for eventually training our own model.
 *
 * Gated entirely by DATASET_COLLECTION_ENABLED (config.dataset.enabled).
 * When it's false, this module is a strict no-op — it touches no
 * files at all. Flipping it on starts collection; it never changes
 * how CAPTCHAs actually get solved. See README.md for why "collect
 * data" and "train a model" stay separate, later steps.
 *
 * On-disk layout (kept intentionally boring so it never gets messy
 * as it grows):
 *
 *   data/dataset/
 *     images/<YYYY-MM-DD>/<id>.png    one PNG per sample, date-
 *                                      partitioned the same way
 *                                      storage/failure-store.js
 *                                      partitions failure screenshots
 *     labels.jsonl                    one JSON object per line,
 *                                      append-only
 *
 * labels.jsonl is append-only NDJSON rather than a single JSON
 * array on purpose: appending one line is a single atomic write
 * with nothing to corrupt, it scales to any dataset size without
 * a full read-modify-rewrite on every sample, and it's trivial to
 * stream/validate line-by-line later (Level 4 dataset engineering:
 * duplicate/corrupt/invalid checks, digit distribution, splits).
 *
 * Each record:
 *   { id, image, label, length, numeric, sha256, source, solver,
 *     taskId, createdAt, solverConfidence, portalConfirmed,
 *     attemptNumber }
 *
 * solverConfidence / portalConfirmed / attemptNumber were added
 * once the own-model solver existed (see captcha/own-model-solver.js
 * and pipeline.js): the portal's response now gives us a free,
 * authoritative correctness label for every own-model attempt, not
 * just the ones that get 2Captcha-fallback treatment, so it's worth
 * capturing that for every sample rather than only the successful
 * ones. For a 2Captcha-sourced sample, solverConfidence is null
 * (2Captcha doesn't expose one) and portalConfirmed is "correct"
 * (same as before — 2Captcha's answer is trusted once the portal
 * accepts it).
 *
 * What this module deliberately never stores:
 *   - API keys, cookies, or session secrets
 *   - anything from the GSTIN lookup itself (the taxpayer result)
 *
 * Never throws: dataset collection must never break the main
 * automation workflow.
 */

const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const logger = require("../logger/logger");
const config = require("../config/config");

function sha256(buffer) {
    return crypto.createHash("sha256").update(buffer).digest("hex");
}

function todayFolder() {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Appends one record as a single line to labels.jsonl. A plain
 * fs.appendFile call is used deliberately — no read, no parse, no
 * rewrite of anything that already exists on disk.
 */
async function appendLabelRecord(record) {
    const line = JSON.stringify(record) + "\n";
    await fs.appendFile(config.paths.datasetLabelsFile, line, "utf8");
}

/**
 * @param {object} sample
 * @param {string} sample.base64Image
 * @param {string} sample.label - the accepted/predicted CAPTCHA text.
 * @param {string|number} [sample.taskId] - 2Captcha's task id, when solver is "2captcha".
 * @param {"own-model"|"2captcha"} [sample.solver] - which solver produced `label`.
 *   Defaults to "2captcha" so existing call sites (pre-dating the own-model
 *   solver) keep working unchanged.
 * @param {{avg: number, min: number}|null} [sample.solverConfidence] - the
 *   own-model confidence breakdown, or null for a 2Captcha-sourced sample.
 * @param {"correct"|"wrong"} [sample.portalConfirmed] - what the portal's
 *   response actually confirmed about `label`. Defaults to "correct" to
 *   match prior behavior (this function was only ever called on an
 *   already-accepted solve before the own-model retry loop existed).
 * @param {number} [sample.attemptNumber] - which retry attempt produced
 *   this sample, for lookups that needed more than one try.
 *
 * @returns {Promise<object|null>} the stored record, or null if collection
 *   is disabled or saving failed.
 */
async function saveDatasetSample({
    base64Image,
    label,
    taskId,
    solver = "2captcha",
    solverConfidence = null,
    portalConfirmed = "correct",
    attemptNumber = 1
}) {

    if (!config.dataset.enabled) {
        return null;
    }

    try {
        const dateFolder = todayFolder();
        const imagesDir = path.join(config.paths.datasetImagesDir, dateFolder);

        await fs.mkdir(imagesDir, { recursive: true });
        await fs.mkdir(config.paths.datasetDir, { recursive: true });

        const buffer = Buffer.from(base64Image, "base64");
        // Date.now() alone is NOT a safe unique id: two samples saved
        // within the same millisecond (Promise.all'd writes, a tight
        // retry loop, the own-model retry loop now hitting this from
        // multiple attempts per lookup) get the same id AND the same
        // image filename, silently overwriting one sample's image with
        // another's. Confirmed by test against the sibling
        // captcha-failure-store.js: 20 rapid concurrent calls collapsed
        // to 4 unique ids under plain Date.now(). A short random suffix
        // fixes this while keeping the timestamp prefix for
        // human-readable sorting.
        const id = `captcha_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
        const imageFileName = `${id}.png`;
        const imagePath = path.join(imagesDir, imageFileName);

        await fs.writeFile(imagePath, buffer);

        // Stored as a forward-slash relative path (not an OS-specific
        // absolute one) so labels.jsonl stays portable between the
        // machine that collected it and whatever later trains on it.
        const relativeImagePath = `images/${dateFolder}/${imageFileName}`;

        const record = {
            id,
            image: relativeImagePath,
            label,
            length: label.length,
            numeric: /^\d+$/.test(label),
            sha256: sha256(buffer),
            source: "own-captcha-generator",
            solver,
            taskId: taskId ?? null,
            createdAt: new Date().toISOString(),
            solverConfidence,
            portalConfirmed,
            attemptNumber
        };

        await appendLabelRecord(record);

        logger.debug(`Dataset sample stored: ${relativeImagePath} (solver=${solver}, portalConfirmed=${portalConfirmed}).`);
        return record;

    } catch (error) {
        logger.warn({ err: error }, "Failed to store dataset sample (non-fatal).");
        return null;
    }
}

module.exports = { saveDatasetSample };
