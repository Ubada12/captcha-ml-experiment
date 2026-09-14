/**
 * ============================================================
 * GSTIN FORMAT VALIDATION
 * ============================================================
 *
 * A cheap, local sanity check on GSTIN shape before we spend a
 * browser launch and a paid 2Captcha solve on a request that
 * could never have succeeded. This checks FORMAT only — not
 * whether the GSTIN is actually registered, which is exactly
 * what the portal lookup itself answers.
 *
 * Format: 2-digit state code + 10-character PAN (5 letters, 4
 * digits, 1 letter) + 1 alphanumeric entity code + literal "Z"
 * + 1 alphanumeric checksum character. 15 characters total.
 */

const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

function isValidGstin(gstin) {
    return typeof gstin === "string" && GSTIN_PATTERN.test(gstin);
}

module.exports = { isValidGstin };
