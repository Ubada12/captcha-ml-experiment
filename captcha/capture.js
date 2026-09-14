/**
 * ============================================================
 * CAPTCHA CAPTURE
 * ============================================================
 *
 * Locates the CAPTCHA image on the page and screenshots it as
 * a base64 PNG. Delegates the "save a debug copy to disk"
 * responsibility to storage/captcha-store.js — this module's
 * only job is getting the image out of the page.
 */

const logger = require("../logger/logger");
const config = require("../config/config");
const { saveDebugCaptcha } = require("../storage/captcha-store");

async function captureCaptcha(page) {

    logger.debug("Waiting for CAPTCHA image...");

    const captchaElement = await page.waitForSelector(
        config.selectors.captchaImage,
        {
            visible: true,
            timeout: config.timeouts.elementMs
        }
    );

    if (!captchaElement) {
        throw new Error("[CAPTCHA] CAPTCHA image element was not found.");
    }

    logger.debug("CAPTCHA image element found.");

    const captchaUrl = await captchaElement.evaluate(img => img.src);

    if (!captchaUrl) {
        throw new Error("[CAPTCHA] CAPTCHA image has no src URL.");
    }

    logger.debug(`CAPTCHA image URL: ${captchaUrl}`);

    const base64Image = await captchaElement.screenshot({
        encoding: "base64"
    });

    if (!base64Image) {
        throw new Error("[CAPTCHA] Screenshot returned empty Base64 data.");
    }

    logger.info(`CAPTCHA captured successfully (${base64Image.length} base64 chars).`);

    const savedPath = await saveDebugCaptcha(base64Image);

    return {
        base64Image,
        captchaUrl,
        savedPath
    };
}

module.exports = { captureCaptcha };
