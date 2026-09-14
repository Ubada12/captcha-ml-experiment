/**
 * ============================================================
 * FAILURE STORE
 * ============================================================
 *
 * Saves a full-page screenshot when the workflow fails,
 * organized by date so a bad day's failures are easy to find
 * and correlate against the structured log file's timestamps.
 *
 * Never throws: a failure to save diagnostics must not mask
 * or replace the original error.
 */

const fs = require("fs/promises");
const path = require("path");
const logger = require("../logger/logger");
const config = require("../config/config");

function todayFolder() {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

async function saveFailureScreenshot(page) {
    try {
        const dir = path.join(config.paths.failuresDir, todayFolder());
        await fs.mkdir(dir, { recursive: true });

        const fileName = `failure-${Date.now()}.png`;
        const filePath = path.join(dir, fileName);

        await page.screenshot({ path: filePath, fullPage: true });

        logger.debug(`Failure screenshot saved: ${filePath}`);
        return filePath;

    } catch (error) {
        logger.warn({ err: error }, "Failed to save failure screenshot (non-fatal).");
        return null;
    }
}

module.exports = { saveFailureScreenshot };
