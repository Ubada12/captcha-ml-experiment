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
 */

const config = require("../config/config");
const logger = require("../logger/logger");

const BrowserManager = require("../browser/browser");
const { captureCaptcha } = require("../captcha/capture");
const { createCaptchaTask, pollCaptchaResult } = require("../captcha/solver");
const { validateSolution } = require("../captcha/validator");
const { enterGstin, enterCaptchaSolution, submitAndIntercept } = require("../taxpayer/taxpayer");

const { saveDatasetSample } = require("../storage/dataset-store");
const { saveResult } = require("../storage/results-store");
const { saveFailureScreenshot } = require("../storage/failure-store");

const DIVIDER = "=".repeat(60);

/**
 * Runs the full GST lookup workflow for a single GSTIN: launch
 * browser -> navigate -> enter GSTIN -> capture+solve CAPTCHA ->
 * validate -> submit -> intercept taxpayerDetails -> store
 * result -> cleanup.
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

    if (!config.captchaSolver.apiKey) {
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
        // 3. Enter GSTIN
        // ----------------------------------------------------
        await enterGstin(page, gstin);

        // ----------------------------------------------------
        // 4. Capture CAPTCHA
        // ----------------------------------------------------
        const captcha = await captureCaptcha(page);

        // ----------------------------------------------------
        // 5. Send to solver, wait for solution
        // ----------------------------------------------------
        const taskId = await createCaptchaTask(captcha.base64Image);
        const solved = await pollCaptchaResult(taskId);

        // ----------------------------------------------------
        // 6. Validate solution format
        // ----------------------------------------------------
        validateSolution(solved.text);
        logger.success("CAPTCHA solved and validated.");

        // ----------------------------------------------------
        // 6b. Record dataset sample (no-op unless enabled —
        //     see config.dataset.enabled)
        // ----------------------------------------------------
        await saveDatasetSample({
            base64Image: captcha.base64Image,
            label: solved.text,
            taskId: solved.taskId
        });

        // ----------------------------------------------------
        // 7-8. Enter solution, submit, intercept API response
        // ----------------------------------------------------
        await enterCaptchaSolution(page, solved.text);
        const result = await submitAndIntercept(page);

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
