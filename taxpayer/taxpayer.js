/**
 * ============================================================
 * TAXPAYER LOOKUP
 * ============================================================
 *
 * Everything related to filling in the GSTIN + CAPTCHA form,
 * submitting it, and intercepting the taxpayerDetails API
 * response. This module knows the portal's form flow; it does
 * not know how the CAPTCHA was solved (captcha/) or where
 * results get persisted (storage/).
 */

const logger = require("../logger/logger");
const config = require("../config/config");

async function enterGstin(page, gstin) {

    logger.debug(`Waiting for GSTIN input: ${config.selectors.gstinInput}`);

    await page.waitForSelector(config.selectors.gstinInput, {
        visible: true,
        timeout: config.timeouts.elementMs
    });

    await page.click(config.selectors.gstinInput);

    await page.type(config.selectors.gstinInput, gstin, {
        delay: 120
    });

    logger.info(`GSTIN entered successfully: ${gstin}`);
}

async function enterCaptchaSolution(page, solutionText) {

    logger.debug(`Waiting for CAPTCHA input: ${config.selectors.captchaInput}`);

    await page.waitForSelector(config.selectors.captchaInput, {
        visible: true,
        timeout: config.timeouts.elementMs
    });

    await page.click(config.selectors.captchaInput);

    // Clear any existing value first.
    await page.evaluate(selector => {
        const element = document.querySelector(selector);
        if (element) {
            element.value = "";
        }
    }, config.selectors.captchaInput);

    await page.type(config.selectors.captchaInput, solutionText, {
        delay: 50
    });

    logger.info("CAPTCHA solution entered successfully.");
}

// The portal returns HTTP 200 with a normal JSON body even when the
// lookup itself failed (invalid GSTIN, rejected CAPTCHA, etc.) — it
// signals failure inside the payload, not via HTTP status. A matching
// URL + 200 + parseable JSON is therefore NOT proof of a real result;
// this is what actually tells success from failure. Known codes get a
// human-readable reason; anything unrecognized still gets caught and
// surfaces its raw errorCode/message so it's obvious in the logs.
const KNOWN_PORTAL_ERROR_CODES = {
    SWEB_9035: "The GSTIN/UIN entered is invalid."
};

function assertSuccessfulTaxpayerPayload(data) {

    if (!data || typeof data !== "object") {
        return;
    }

    const errorCode = data.errorCode || null;
    const message = typeof data.message === "string" && data.message.trim().length > 0
        ? data.message.trim()
        : null;

    if (!errorCode && !message) {
        return;
    }

    const reason = message || KNOWN_PORTAL_ERROR_CODES[errorCode] || "the portal rejected the lookup.";

    throw new Error(
        `[Network] GST portal returned an error instead of taxpayer data: ${reason}` +
        (errorCode ? ` [errorCode=${errorCode}]` : "")
    );
}

function waitForTaxpayerResponse(page) {

    logger.debug(`Arming listener for response matching "${config.api.taxpayerPattern}"...`);

    return page.waitForResponse(
        response => {

            const url = response.url();

            if (!url.includes(config.api.taxpayerPattern)) {
                return false;
            }

            logger.debug(
                `Target taxpayerDetails response detected: ${url} (HTTP ${response.status()})`
            );

            return true;
        },
        {
            timeout: config.timeouts.taxpayerResponseMs
        }
    );
}

async function submitAndIntercept(page) {

    logger.debug(`Waiting for submit button: ${config.selectors.searchButton}`);

    await page.waitForSelector(config.selectors.searchButton, {
        visible: true,
        timeout: config.timeouts.elementMs
    });

    // IMPORTANT: the listener is armed immediately before the click
    // so its timeout window starts at the right moment, not while
    // we were waiting on other elements above.
    const responsePromise = waitForTaxpayerResponse(page);

    logger.debug("Clicking submit...");
    await page.click(config.selectors.searchButton);
    logger.info("Submit clicked.");

    let response;

    try {
        response = await responsePromise;
    } catch (error) {
        throw new Error(
            `[Network] taxpayerDetails API response was not received within ` +
            `${config.timeouts.taxpayerResponseMs / 1000} seconds. ` +
            `The form may have failed validation, the CAPTCHA may have been rejected, ` +
            `or the endpoint may not have fired.`
        );
    }

    logger.success(`taxpayerDetails response received. HTTP ${response.status()}`);

    let data;

    try {
        data = await response.json();
        logger.debug("taxpayerDetails JSON parsed successfully.");
    } catch (error) {
        throw new Error(
            `[Network] taxpayerDetails response was received but could not be parsed as JSON: ${error.message}`
        );
    }

    // Parsing succeeded, but that only proves it's valid JSON — it could
    // still be the portal's error shape rather than real taxpayer data.
    assertSuccessfulTaxpayerPayload(data);

    return data;
}

module.exports = { enterGstin, enterCaptchaSolution, submitAndIntercept };
