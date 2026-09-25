/**
 * Tests server/validate-taxpayer-request.js in isolation — a pure
 * function, no I/O, no server, no mocking needed. This is what
 * directly proves the `maxCacheAgeMs: null` bug (found in the
 * pre-deployment audit — see the module's own header comment) is
 * actually fixed: null must resolve to `undefined` (use the
 * configured default), never to `0` (force-refresh).
 */

const { test, runTests, assert } = require("./test-helpers");
const { validateTaxpayerRequestBody } = require("../server/validate-taxpayer-request");

const VALID_GSTIN = "27ABCDE1234F1Z5";

test("a minimal valid body (gstin only) validates, with maxCacheAgeMs left undefined", () => {
    const result = validateTaxpayerRequestBody({ gstin: VALID_GSTIN });
    assert.equal(result.valid, true);
    assert.equal(result.gstin, VALID_GSTIN);
    assert.equal(result.maxCacheAgeMs, undefined);
});

test("gstin is trimmed and uppercased", () => {
    const result = validateTaxpayerRequestBody({ gstin: "  27abcde1234f1z5  " });
    assert.equal(result.valid, true);
    assert.equal(result.gstin, VALID_GSTIN);
});

test("a missing gstin field is rejected", () => {
    const result = validateTaxpayerRequestBody({});
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(message => message.includes("gstin")));
});

test("an empty-string gstin is rejected", () => {
    const result = validateTaxpayerRequestBody({ gstin: "" });
    assert.equal(result.valid, false);
});

test("a non-string gstin (e.g. a number) is rejected with a type-specific message", () => {
    const result = validateTaxpayerRequestBody({ gstin: 12345 });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(message => message.includes("must be a string")));
});

test("a malformed gstin (wrong shape) is rejected", () => {
    const result = validateTaxpayerRequestBody({ gstin: "not-a-real-gstin" });
    assert.equal(result.valid, false);
});

test("THE BUG FIX: maxCacheAgeMs: null resolves to undefined (use the default), not 0 (force-refresh)", () => {
    const result = validateTaxpayerRequestBody({ gstin: VALID_GSTIN, maxCacheAgeMs: null });
    assert.equal(result.valid, true);
    assert.equal(
        result.maxCacheAgeMs,
        undefined,
        "null must mean \"use the configured default\", exactly like omitting the field — never 0/force-refresh"
    );
});

test("maxCacheAgeMs omitted entirely also resolves to undefined", () => {
    const result = validateTaxpayerRequestBody({ gstin: VALID_GSTIN });
    assert.equal(result.maxCacheAgeMs, undefined);
});

test("maxCacheAgeMs: 0 is accepted and preserved as 0 (the documented force-refresh convention)", () => {
    const result = validateTaxpayerRequestBody({ gstin: VALID_GSTIN, maxCacheAgeMs: 0 });
    assert.equal(result.valid, true);
    assert.equal(result.maxCacheAgeMs, 0);
});

test("a positive maxCacheAgeMs is accepted and preserved exactly", () => {
    const result = validateTaxpayerRequestBody({ gstin: VALID_GSTIN, maxCacheAgeMs: 3600000 });
    assert.equal(result.valid, true);
    assert.equal(result.maxCacheAgeMs, 3600000);
});

test("a negative maxCacheAgeMs is rejected with a 400-worthy error, not silently clamped", () => {
    const result = validateTaxpayerRequestBody({ gstin: VALID_GSTIN, maxCacheAgeMs: -1 });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(message => message.includes("maxCacheAgeMs")));
});

test("a string maxCacheAgeMs (even a numeric-looking one) is rejected, not coerced", () => {
    const result = validateTaxpayerRequestBody({ gstin: VALID_GSTIN, maxCacheAgeMs: "3600000" });
    assert.equal(result.valid, false);
});

test("a boolean maxCacheAgeMs is rejected", () => {
    const result = validateTaxpayerRequestBody({ gstin: VALID_GSTIN, maxCacheAgeMs: true });
    assert.equal(result.valid, false);
});

test("Infinity is rejected (finite check, not just typeof number)", () => {
    const result = validateTaxpayerRequestBody({ gstin: VALID_GSTIN, maxCacheAgeMs: Infinity });
    assert.equal(result.valid, false);
});

test("NaN is rejected", () => {
    const result = validateTaxpayerRequestBody({ gstin: VALID_GSTIN, maxCacheAgeMs: NaN });
    assert.equal(result.valid, false);
});

test("multiple problems in one body are all reported together, not just the first", () => {
    const result = validateTaxpayerRequestBody({ gstin: "bad-gstin", maxCacheAgeMs: -5 });
    assert.equal(result.valid, false);
    assert.equal(result.errors.length, 2, "both the bad gstin and the negative maxCacheAgeMs should be reported");
});

runTests();
