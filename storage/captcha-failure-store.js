/**
 * ============================================================
 * CAPTCHA FAILURE STORE (forensic record, always-on)
 * ============================================================
 *
 * Persists a full, retrievable record of every own-model CAPTCHA
 * attempt that ISN'T a clean first-try success — a malformed
 * (wrong-length) prediction, a low-confidence prediction we chose
 * not to submit, a prediction the portal actually rejected
 * (SWEB_9000), the ml-service itself being unreachable or erroring
 * out for an attempt, or even a 2Captcha answer that turned out wrong.
 *
 * This is deliberately NOT the same thing as storage/dataset-store.js:
 *
 *   - dataset-store.js is training material, gated behind
 *     DATASET_COLLECTION_ENABLED, and only really cares about the
 *     final accepted (image, label) pair.
 *   - captcha-failure-store.js is operational/debugging evidence,
 *     always on, and cares specifically about the attempts that
 *     went wrong — the exact image, the model's full confidence
 *     breakdown, which layer caught the problem, and what
 *     happened next. The whole point is that nothing about a
 *     CAPTCHA failure is ever only visible as one line scrolling
 *     past in the terminal — it's sitting on disk afterward, ready
 *     to pull up and actually look at.
 *
 * On-disk layout (same append-only-JSONL + date-partitioned-images
 * pattern already used by dataset-store.js and failure-store.js,
 * for consistency and the same crash-safety properties):
 *
 *   data/captcha-failures/
 *     images/<YYYY-MM-DD>/<id>.png   the exact image that produced
 *                                     that failed/rejected attempt
 *     failures.jsonl                 one JSON record per line,
 *                                     append-only
 *
 * Never throws: a failure to record a CAPTCHA failure must never
 * mask or replace the real workflow error, exactly like every
 * other module under storage/.
 */

const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const logger = require("../logger/logger");
const config = require("../config/config");

function todayFolder() {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * @param {object} details
 * @param {string} details.gstin - the GSTIN being looked up when this happened.
 * @param {string} details.base64Image - the exact CAPTCHA image involved.
 * @param {"pre-submit"|"post-submit"} details.stage - which verification
 *   layer caught this (format/confidence checks happen pre-submit; the
 *   portal's own rejection is post-submit).
 * @param {"malformed-length"|"low-confidence"|"portal-rejected"|"2captcha-also-wrong"|"service-error"} details.reason
 * @param {string} [details.predictedText] - what the solver actually predicted.
 * @param {string} details.solver - "own-model" or "2captcha".
 * @param {number} [details.avgConfidence]
 * @param {number} [details.minConfidence]
 * @param {number[]} [details.perCharConfidence]
 * @param {number} details.attemptNumber - which retry attempt this was.
 * @param {string} [details.portalErrorCode] - e.g. "SWEB_9000", when stage is post-submit.
 *
 * @returns {Promise<object|null>} the stored record, or null if writing failed
 *   (logged as a warning, never thrown).
 */
async function recordCaptchaFailure(details) {

    const {
        gstin,
        base64Image,
        stage,
        reason,
        predictedText = null,
        solver,
        avgConfidence = null,
        minConfidence = null,
        perCharConfidence = null,
        attemptNumber,
        portalErrorCode = null
    } = details;

    try {
        const dateFolder = todayFolder();
        const imagesDir = path.join(config.paths.captchaFailuresImagesDir, dateFolder);

        await fs.mkdir(imagesDir, { recursive: true });
        await fs.mkdir(config.paths.captchaFailuresDir, { recursive: true });

        // Date.now() alone is NOT a safe unique id here: two failures
        // recorded within the same millisecond (entirely plausible —
        // e.g. Promise.all'd writes, or a tight retry loop) would get
        // the exact same id AND the exact same image filename, silently
        // overwriting one attempt's image with another's and leaving
        // failures.jsonl with two lines pointing at one wrong picture.
        // Confirmed by test: 20 rapid concurrent calls collapsed to 4
        // unique ids under plain Date.now(). A short random suffix
        // makes collisions practically impossible while keeping the
        // timestamp prefix for human-readable sorting/skimming.
        const id = `captchafail_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
        const imageFileName = `${id}.png`;
        const imagePath = path.join(imagesDir, imageFileName);

        if (base64Image) {
            await fs.writeFile(imagePath, Buffer.from(base64Image, "base64"));
        }

        // Portable forward-slash relative path, same convention
        // dataset-store.js uses, so tooling that reads either file
        // doesn't need two different path conventions.
        const relativeImagePath = `images/${dateFolder}/${imageFileName}`;

        const record = {
            id,
            gstin: gstin ?? null,
            image: relativeImagePath,
            stage,
            reason,
            predictedText,
            solver,
            avgConfidence,
            minConfidence,
            perCharConfidence,
            attemptNumber: attemptNumber ?? null,
            portalErrorCode,
            createdAt: new Date().toISOString()
        };

        const line = JSON.stringify(record) + "\n";
        await fs.appendFile(config.paths.captchaFailuresLogFile, line, "utf8");

        logger.debug(`CAPTCHA failure recorded: ${relativeImagePath} (reason=${reason}).`);

        return record;

    } catch (error) {
        logger.warn({ err: error }, "Failed to record CAPTCHA failure (non-fatal).");
        return null;
    }
}

module.exports = { recordCaptchaFailure };
