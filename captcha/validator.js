/**
 * ============================================================
 * CAPTCHA SOLUTION VALIDATOR
 * ============================================================
 *
 * Confirms a solver's output actually looks like a valid
 * CAPTCHA answer (exactly N numeric digits, per config) before
 * we waste a form submission on it. Kept separate from
 * solver.js so a future solver (or an own-trained model) can
 * reuse the same validation rule without duplicating it.
 */

const logger = require("../logger/logger");
const config = require("../config/config");

function validateSolution(solution) {

    const expectedLength = config.captchaSolver.expectedLength;
    const pattern = new RegExp(`^\\d{${expectedLength}}$`);

    if (typeof solution !== "string" || !pattern.test(solution)) {
        throw new Error(
            `[CAPTCHA] Invalid solver result. Expected exactly ${expectedLength} digits, ` +
            `received length=${solution?.length ?? "undefined"}.`
        );
    }

    logger.debug(`CAPTCHA solution passed format validation (${expectedLength} digits).`);
    return true;
}

module.exports = { validateSolution };
