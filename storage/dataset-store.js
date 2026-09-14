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
 *     taskId, createdAt }
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
 * @param {{ base64Image: string, label: string, taskId?: string|number }} sample
 * @returns {Promise<object|null>} the stored record, or null if collection
 *   is disabled or saving failed.
 */
async function saveDatasetSample({ base64Image, label, taskId }) {

    if (!config.dataset.enabled) {
        return null;
    }

    try {
        const dateFolder = todayFolder();
        const imagesDir = path.join(config.paths.datasetImagesDir, dateFolder);

        await fs.mkdir(imagesDir, { recursive: true });
        await fs.mkdir(config.paths.datasetDir, { recursive: true });

        const buffer = Buffer.from(base64Image, "base64");
        const id = `captcha_${Date.now()}`;
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
            solver: "2captcha",
            taskId: taskId ?? null,
            createdAt: new Date().toISOString()
        };

        await appendLabelRecord(record);

        logger.debug(`Dataset sample stored: ${relativeImagePath}`);
        return record;

    } catch (error) {
        logger.warn({ err: error }, "Failed to store dataset sample (non-fatal).");
        return null;
    }
}

module.exports = { saveDatasetSample };
