/**
 * ============================================================
 * RESULTS STORE
 * ============================================================
 *
 * Saves the successfully intercepted taxpayerDetails JSON to
 * disk, so a lookup result outlives the terminal it printed to,
 * and lets it be read back later without re-running the browser
 * (see getLatestResult, used by the /cached API endpoint).
 *
 * Never throws: a failure to save or read a result must not hide
 * the fact that a lookup itself succeeded — the caller still gets
 * the data back either way.
 */

const fs = require("fs/promises");
const path = require("path");
const logger = require("../logger/logger");
const config = require("../config/config");

function safeFileToken(value) {
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "_");
}

async function saveResult(gstin, data) {
    try {
        await fs.mkdir(config.paths.resultsDir, { recursive: true });

        const fileName = `${safeFileToken(gstin)}-${Date.now()}.json`;
        const filePath = path.join(config.paths.resultsDir, fileName);

        await fs.writeFile(filePath, JSON.stringify(data, null, 2));

        logger.debug(`Result saved: ${filePath}`);
        return filePath;

    } catch (error) {
        logger.warn({ err: error }, "Failed to save result to disk (non-fatal).");
        return null;
    }
}

/**
 * Returns the most recently saved result for a GSTIN, or null if
 * none exists yet. Filenames are `<gstin>-<Date.now()>.json`; since
 * Date.now() timestamps are fixed-width for the foreseeable future,
 * a plain lexicographic sort is also a chronological sort.
 */
async function getLatestResult(gstin) {
    try {
        const files = await fs.readdir(config.paths.resultsDir);
        const prefix = `${safeFileToken(gstin)}-`;

        const matches = files
            .filter(name => name.startsWith(prefix) && name.endsWith(".json"))
            .sort();

        if (matches.length === 0) {
            return null;
        }

        const latestFile = matches[matches.length - 1];
        const raw = await fs.readFile(path.join(config.paths.resultsDir, latestFile), "utf8");

        return JSON.parse(raw);

    } catch (error) {
        if (error.code === "ENOENT") {
            // No results directory yet — nothing has ever been saved.
            return null;
        }

        logger.warn({ err: error }, "Failed to read cached result (non-fatal).");
        return null;
    }
}

module.exports = { saveResult, getLatestResult };
