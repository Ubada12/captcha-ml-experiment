/**
 * ============================================================
 * PIPELINE — CORE LOOKUP WORKFLOW
 * ============================================================
 *
 * The actual end-to-end automation, extracted so both entry
 * points — the one-shot CLI (main.js) and the HTTP API
 * (server.js) — call the exact same code for a lookup instead
 * of each having their own copy. Neither entry point knows how
 * a browser is launched, a CAPTCHA is solved, or a result is
 * stored — that's still owned by browser/, captcha/, taxpayer/,
 * and storage/, exactly as in the Level 2 refactor. This module
 * only sequences them.
 *
 * CAPTCHA solving policy (Level 6 of the roadmap):
 *
 *   Try our own trained model first (captcha/own-model-solver.js).
 *   A prediction is only trusted if it's exactly 6 digits AND
 *   clears both confidence thresholds (config.ownModelSolver).
 *   If not, recapture a fresh CAPTCHA (the portal issues a new
 *   image after every rejected attempt — confirmed empirically,
 *   not assumed) and try again, up to config.ownModelSolver.maxRetries
 *   times. If a prediction DOES look confident and gets submitted,
 *   the portal's own response is the real, certain answer — a
 *   confirmed-wrong rejection (SWEB_9000, see taxpayer.js) triggers
 *   the same recapture-and-retry behavior. Once own-model retries
 *   are exhausted, fall back to 2Captcha (captcha/solver.js),
 *   unless that fallback is explicitly disabled in config.
 *
 *   Every attempt that isn't a clean first-try success is recorded
 *   to storage/captcha-failure-store.js — image, full confidence
 *   breakdown, and what happened — so nothing about a CAPTCHA
 *   failure is ever only visible as a line scrolling past in the
 *   terminal. Terminal/log output itself stays at a professional,
 *   high-level status (attempt counts, outcomes) and never prints
 *   the actual predicted digits, the same discipline this file
 *   already applied to 2Captcha's answer before the own model
 *   existed.
 */

const config = require("../config/config");
const logger = require("../logger/logger");

const BrowserManager = require("../browser/browser");
const { captureCaptcha } = require("../captcha/capture");
const { createCaptchaTask, pollCaptchaResult } = require("../captcha/solver");
const { solveCaptcha } = require("../captcha/own-model-solver");
const { validateSolution } = require("../captcha/validator");
const { enterGstin, enterCaptchaSolution, submitAndIntercept } = require("../taxpayer/taxpayer");

const { saveDatasetSample } = require("../storage/dataset-store");
const { saveResult } = require("../storage/results-store");
const { saveFailureScreenshot } = require("../storage/failure-store");
const { recordCaptchaFailure } = require("../storage/captcha-failure-store");

const DIVIDER = "=".repeat(60);

/**
 * Runs the CAPTCHA solve/submit/verify cycle, retrying with a
 * freshly captured CAPTCHA whenever a prediction is rejected —
 * either by our own confidence check (pre-submit) or by the
 * portal itself (post-submit, the certain signal). Falls back to
 * 2Captcha once the own model's retries are exhausted.
 *
 * @param {import("puppeteer").Page} page
 * @param {string} gstin - only used for logging/failure records here;
 *   the GSTIN field is re-entered on every attempt (see inline
 *   comment) rather than assumed to survive a CAPTCHA rejection.
 * @returns {Promise<object>} the taxpayerDetails JSON exactly as
 *   intercepted — never reshaped here.
 */
async function solveAndSubmitWithRetries(page, gstin) {

    const ownModelConfig = config.ownModelSolver;

    // Total own-model attempts allowed: the first try plus maxRetries.
    const maxOwnModelAttempts = ownModelConfig.enabled ? ownModelConfig.maxRetries + 1 : 0;

    let ownModelAttempt = 0;
    let ownModelExhausted = !ownModelConfig.enabled;

    // eslint-disable-next-line no-constant-condition
    while (true) {

        // ------------------------------------------------------
        // Re-enter the GSTIN on every attempt, not just the first.
        //
        // We know the CAPTCHA image itself refreshes after a wrong
        // submission, but whether the portal does that via a full
        // page reload (which would also clear the GSTIN field) or
        // an in-place AJAX refresh is still unverified — see the
        // integration plan's testing section. Re-entering the GSTIN
        // every time is cheap and idempotent, and makes this loop
        // correct either way rather than assuming the more
        // convenient case.
        // ------------------------------------------------------
        await enterGstin(page, gstin);

        // Fresh capture every attempt — never reuse a previous image.
        const captcha = await captureCaptcha(page);

        let solutionText;
        let solverUsed;
        let prediction = null; // own-model confidence details, for records/logging

        const tryOwnModelThisAttempt = !ownModelExhausted && ownModelAttempt < maxOwnModelAttempts;

        if (tryOwnModelThisAttempt) {

            ownModelAttempt++;
            solverUsed = "own-model";

            logger.info(`Own-model CAPTCHA attempt ${ownModelAttempt}/${maxOwnModelAttempts}...`);

            try {
                prediction = await solveCaptcha(captcha.base64Image);
            } catch (error) {

                logger.warn(
                    { err: error },
                    `Own-model attempt ${ownModelAttempt}/${maxOwnModelAttempts} could not get a ` +
                    "prediction (service error) — treating as rejected."
                );

                await recordCaptchaFailure({
                    gstin,
                    base64Image: captcha.base64Image,
                    stage: "pre-submit",
                    reason: "service-error",
                    solver: "own-model",
                    attemptNumber: ownModelAttempt
                });

                if (ownModelAttempt >= maxOwnModelAttempts) {
                    ownModelExhausted = true;
                }

                continue; // recapture and try again (own model or fallback, next loop)
            }

            if (!prediction.lengthOk || !prediction.confident) {

                const reason = !prediction.lengthOk ? "malformed-length" : "low-confidence";

                logger.warn(
                    `Attempt ${ownModelAttempt}/${maxOwnModelAttempts} rejected pre-submit ` +
                    `(${reason}, confidence withheld from log — see failure record). ` +
                    (ownModelAttempt < maxOwnModelAttempts
                        ? "Recapturing and retrying."
                        : "Retries exhausted.")
                );

                await recordCaptchaFailure({
                    gstin,
                    base64Image: captcha.base64Image,
                    stage: "pre-submit",
                    reason,
                    predictedText: prediction.text,
                    solver: "own-model",
                    avgConfidence: prediction.avgConfidence,
                    minConfidence: prediction.minConfidence,
                    perCharConfidence: prediction.perCharConfidence,
                    attemptNumber: ownModelAttempt
                });

                if (ownModelAttempt >= maxOwnModelAttempts) {
                    ownModelExhausted = true;
                }

                continue; // recapture, loop again
            }

            // Confident prediction — one more cheap, free format re-check
            // before spending a form submission on it.
            validateSolution(prediction.text);
            solutionText = prediction.text;

        } else {

            // Own model is either disabled outright or its retries are
            // exhausted for this lookup — fall back to 2Captcha.
            if (config.ownModelSolver.enabled && !config.ownModelSolver.fallbackTo2CaptchaEnabled) {
                throw new Error(
                    `[Pipeline] Own-model CAPTCHA solver failed after ${maxOwnModelAttempts} ` +
                    "attempt(s) and 2Captcha fallback is disabled (OWN_MODEL_FALLBACK_ENABLED=false)."
                );
            }

            if (ownModelExhausted && ownModelConfig.enabled) {
                logger.warn("Own model exhausted its retries — falling back to 2Captcha.");
            }

            if (!config.captchaSolver.apiKey) {
                throw new Error("TWOCAPTCHA_API_KEY environment variable is missing.");
            }

            solverUsed = "2captcha";

            const taskId = await createCaptchaTask(captcha.base64Image);
            const solved = await pollCaptchaResult(taskId);

            validateSolution(solved.text);
            solutionText = solved.text;

            // Stashed only so the dataset/failure records below have a
            // consistent shape regardless of which solver ran.
            prediction = { taskId: solved.taskId, avgConfidence: null, minConfidence: null, perCharConfidence: null };
        }

        // ----------------------------------------------------
        // Submit and check the portal's response — the one
        // certain signal (see taxpayer.js's isCaptchaRejection).
        // ----------------------------------------------------
        await enterCaptchaSolution(page, solutionText);

        try {

            const result = await submitAndIntercept(page);

            if (solverUsed === "own-model") {
                logger.success(`CAPTCHA solved by own model on attempt ${ownModelAttempt}.`);
            } else {
                logger.success("CAPTCHA solved via 2Captcha fallback.");
            }

            await saveDatasetSample({
                base64Image: captcha.base64Image,
                label: solutionText,
                taskId: solverUsed === "2captcha" ? prediction.taskId : null,
                solver: solverUsed,
                solverConfidence: solverUsed === "own-model"
                    ? { avg: prediction.avgConfidence, min: prediction.minConfidence }
                    : null,
                portalConfirmed: "correct",
                attemptNumber: solverUsed === "own-model" ? ownModelAttempt : 1
            });

            return result;

        } catch (error) {

            if (error.isCaptchaRejection) {

                await recordCaptchaFailure({
                    gstin,
                    base64Image: captcha.base64Image,
                    stage: "post-submit",
                    reason: solverUsed === "own-model" ? "portal-rejected" : "2captcha-also-wrong",
                    predictedText: solutionText,
                    solver: solverUsed,
                    avgConfidence: prediction.avgConfidence,
                    minConfidence: prediction.minConfidence,
                    perCharConfidence: prediction.perCharConfidence,
                    attemptNumber: solverUsed === "own-model" ? ownModelAttempt : 1,
                    portalErrorCode: error.portalErrorCode
                });

                await saveDatasetSample({
                    base64Image: captcha.base64Image,
                    label: solutionText,
                    solver: solverUsed,
                    solverConfidence: solverUsed === "own-model"
                        ? { avg: prediction.avgConfidence, min: prediction.minConfidence }
                        : null,
                    portalConfirmed: "wrong",
                    attemptNumber: solverUsed === "own-model" ? ownModelAttempt : 1
                });

                if (solverUsed === "2captcha") {
                    // 2Captcha itself getting it wrong is rare (zero observed
                    // historically at time of writing) and there's no further
                    // automatic recovery layer beyond it — surface this as a
                    // genuine failure rather than looping forever.
                    logger.error("2Captcha's own answer was rejected by the portal — no further automatic recovery.");
                    throw error;
                }

                logger.warn(
                    `Own-model prediction rejected by the portal on attempt ` +
                    `${ownModelAttempt}/${maxOwnModelAttempts}. ` +
                    (ownModelAttempt < maxOwnModelAttempts
                        ? "Recapturing and retrying."
                        : "Retries exhausted — falling back to 2Captcha.")
                );

                if (ownModelAttempt >= maxOwnModelAttempts) {
                    ownModelExhausted = true;
                }

                continue; // recapture a fresh CAPTCHA and loop again
            }

            // Unrelated failure (bad GSTIN, navigation timeout, etc.) —
            // unchanged from before the own-model solver existed.
            throw error;
        }
    }
}

/**
 * Runs the full GST lookup workflow for a single GSTIN: launch
 * browser -> navigate -> [GSTIN + CAPTCHA solve/submit/verify,
 * with retries] -> store result -> cleanup.
 *
 * @param {string} gstin
 * @returns {Promise<object>} the taxpayerDetails JSON exactly as
 *   intercepted from the network response — never reshaped here
 *   or by any caller.
 */
async function runLookup(gstin) {

    if (!gstin) {
        throw new Error("[Pipeline] runLookup requires a GSTIN.");
    }

    logger.info(DIVIDER);
    logger.info(`GST portal automation starting for GSTIN ${gstin}.`);
    logger.info(DIVIDER);

    if (!config.ownModelSolver.enabled && !config.captchaSolver.apiKey) {
        throw new Error("TWOCAPTCHA_API_KEY environment variable is missing.");
    }

    const browserManager = new BrowserManager();

    try {

        // ----------------------------------------------------
        // 1-2. Launch browser, open target
        // ----------------------------------------------------
        await browserManager.launch();
        const page = await browserManager.newPage();
        await browserManager.goto(config.targetUrl);

        // ----------------------------------------------------
        // 3-8. GSTIN entry, CAPTCHA solve (own model, with
        // recapture-retry and 2Captcha fallback), submit, and
        // intercept the taxpayerDetails response.
        // ----------------------------------------------------
        const result = await solveAndSubmitWithRetries(page, gstin);

        logger.info(DIVIDER);
        logger.success("DATA EXTRACTION COMPLETE");
        logger.info(DIVIDER);

        // ----------------------------------------------------
        // 9. Store result
        // ----------------------------------------------------
        await saveResult(gstin, result);

        return result;

    } catch (error) {

        logger.error({ err: error }, "Workflow failed.");

        // ------------------------------------------------------
        // Best-effort failure diagnostics — never let this mask
        // the original error.
        // ------------------------------------------------------
        try {
            const page = await browserManager.getCurrentPage();

            if (page) {
                logger.debug(`Current URL: ${page.url()}`);

                await saveFailureScreenshot(page);

                const captchaError = await page.evaluate(() => {
                    const elements = Array.from(document.querySelectorAll(".err"));

                    const visible = elements.find(element => {
                        const style = window.getComputedStyle(element);
                        return (
                            style.display !== "none" &&
                            style.visibility !== "hidden" &&
                            element.textContent.trim()
                        );
                    });

                    return visible ? visible.textContent.trim() : null;
                });

                if (captchaError) {
                    logger.warn(`Visible portal error: "${captchaError}"`);
                }
            }
        } catch (debugError) {
            logger.warn({ err: debugError }, "Could not collect failure diagnostics.");
        }

        throw error;

    } finally {

        // ----------------------------------------------------
        // 10. Cleanup
        // ----------------------------------------------------
        await browserManager.close();
        logger.info("Application workflow terminated.");
    }
}

module.exports = { runLookup };
