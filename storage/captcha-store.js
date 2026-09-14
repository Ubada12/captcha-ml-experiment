/**
 * ============================================================
 * CAPTCHA DEBUG STORE
 * ============================================================
 *
 * Saves a raw copy of every CAPTCHA image we capture, purely
 * for debugging ("what did the portal actually show us right
 * before this run failed?"). This is NOT the labeled training
 * dataset — see dataset-store.js for that.
 *
 * Never throws: a failure to save a debug image must not break
 * the main automation workflow.
 */

const fs = require("fs/promises");
const path = require("path");
const logger = require("../logger/logger");
const config = require("../config/config");

async function saveDebugCaptcha(base64Image) {
    try {
        await fs.mkdir(config.paths.captchasDir, { recursive: true });

        const fileName = `captcha-${Date.now()}.png`;
        const filePath = path.join(config.paths.captchasDir, fileName);

        await fs.writeFile(filePath, Buffer.from(base64Image, "base64"));

        logger.debug(`Debug CAPTCHA image saved: ${filePath}`);
        return filePath;

    } catch (error) {
        logger.warn({ err: error }, "Failed to save debug CAPTCHA image (non-fatal).");
        return null;
    }
}

module.exports = { saveDebugCaptcha };
