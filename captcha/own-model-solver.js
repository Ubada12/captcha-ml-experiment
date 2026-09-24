/**
 * ============================================================
 * OWN-MODEL CAPTCHA SOLVER
 * ============================================================
 *
 * Talks to the local ml-service (a FastAPI process serving our
 * own trained CRNN+CTC model — see ml-service/serve.py) to solve
 * a captured CAPTCHA image ourselves instead of paying for
 * 2Captcha on every lookup.
 *
 * Deliberately a single function, not the create-task/poll-result
 * shape solver.js uses for 2Captcha — that shape exists because
 * 2Captcha's solve is an asynchronous remote job you have to poll
 * for. Local inference is a synchronous, sub-second HTTP call, so
 * pretending it needs polling would just be dishonest about what
 * this actually does.
 *
 * This module never decides whether a prediction is "good enough"
 * to submit — it only asks the model and reports back exactly what
 * it said, including the full confidence breakdown. Applying the
 * confidence threshold and deciding what to do about a low-
 * confidence or malformed result is pipeline.js's job, since that's
 * where the retry/fallback policy and attempt counting live.
 *
 * solver.js (2Captcha) is untouched and lives on as the fallback
 * path for whenever this module's prediction isn't trusted.
 */

const axios = require("axios");
const logger = require("../logger/logger");
const config = require("../config/config");

/**
 * Sends one captured CAPTCHA image to the local ml-service and
 * returns its prediction plus confidence breakdown.
 *
 * @param {string} base64Image - the captured CAPTCHA, as produced
 *   by captcha/capture.js (Puppeteer's element screenshot, base64
 *   PNG, no data-URL prefix).
 *
 * @returns {Promise<{
 *   text: string,
 *   lengthOk: boolean,
 *   avgConfidence: number,
 *   minConfidence: number,
 *   perCharConfidence: number[],
 *   rawSequenceLength: number,
 *   inferenceMs: number,
 *   confident: boolean
 * }>}
 *
 * `confident` is the one piece of judgment this module DOES apply —
 * a straightforward, config-driven threshold check — so every
 * caller doesn't have to re-read config.ownModelSolver.confidenceThreshold
 * itself. Everything else in the response is exactly what the model
 * service reported, unmodified.
 */
async function solveCaptcha(base64Image) {

    if (!base64Image) {
        throw new Error("[Own Model] Cannot solve: CAPTCHA image is empty.");
    }

    const { serviceUrl, requestTimeoutMs, confidenceThreshold } = config.ownModelSolver;

    logger.debug("Sending CAPTCHA image to own-model service for prediction...");

    let response;

    try {

        response = await axios.post(
            `${serviceUrl}/predict`,
            { image_base64: base64Image },
            { timeout: requestTimeoutMs }
        );

    } catch (error) {

        if (error.response) {
            // ml-service is up but rejected the request (e.g. 400 on a
            // malformed image, 503 if its model failed to load).
            throw new Error(
                `[Own Model] /predict HTTP ${error.response.status}: ` +
                `${JSON.stringify(error.response.data)}`
            );
        }

        // No response at all — service down, wrong port, timed out, etc.
        // This is exactly the situation config.ownModelSolver.enabled
        // exists to let an operator route around instantly (flip it
        // off in .env, restart, every lookup goes straight to 2Captcha)
        // rather than every request in the meantime failing this way.
        throw new Error(`[Own Model] /predict request failed: ${error.message}`);
    }

    const data = response.data;

    const lengthOk = Boolean(data.length_ok);
    const avgConfidence = Number(data.avg_confidence);
    const minConfidence = Number(data.min_confidence);

    const confident =
        lengthOk &&
        avgConfidence >= confidenceThreshold.avg &&
        minConfidence >= confidenceThreshold.min;

    // Never log the predicted digits themselves — same discipline
    // solver.js already applies to 2Captcha's answer. Confidence
    // numbers and the pass/fail verdict are the useful operational
    // signal; the actual text only goes where it's needed (dataset
    // store, failure store, or straight into the form field).
    logger.debug(
        `Own-model prediction received in ${data.inference_ms?.toFixed(1) ?? "?"}ms. ` +
        `lengthOk=${lengthOk}, avgConfidence=${avgConfidence.toFixed(3)}, ` +
        `minConfidence=${minConfidence.toFixed(3)}, confident=${confident}`
    );

    return {
        text: data.text ?? "",
        lengthOk,
        avgConfidence,
        minConfidence,
        // Defaulted defensively (matching lengthOk/avgConfidence/minConfidence
        // above) so a malformed/partial ml-service response still produces a
        // well-shaped object here instead of `undefined` fields silently
        // vanishing when this gets JSON.stringify'd into a failure/dataset
        // record later (JSON.stringify drops undefined keys entirely, which
        // would make the stored record's shape drift from every other one).
        perCharConfidence: data.per_char_confidence ?? [],
        rawSequenceLength: data.raw_sequence_length ?? null,
        inferenceMs: data.inference_ms ?? null,
        confident
    };
}

module.exports = { solveCaptcha };
