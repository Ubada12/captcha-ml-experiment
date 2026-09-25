/**
 * ============================================================
 * SHARED TEST HELPERS
 * ============================================================
 *
 * Tiny, dependency-free test harness — this project has no test
 * framework installed (package.json's "test" script was a
 * placeholder before this suite existed), so these helpers give
 * every test file the same minimal shape: register a named async
 * test, run them in sequence, print PASS/FAIL, exit non-zero on
 * any failure. Each test file is meant to be run as its OWN node
 * process (see test/run-all.js) specifically so that mutating the
 * shared config singleton or monkey-patching another module's
 * exports in one test file can never leak into another one.
 */

const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tests = [];

function test(name, fn) {
    tests.push({ name, fn });
}

async function runTests() {
    // A test file that registers zero tests (e.g. a typo in a `test(`
    // call, or a file that threw before reaching any of them) would
    // otherwise fall straight to the "0/0 passed" branch below and
    // exit 0 — a silent false positive that test/run-all.js has no
    // way to tell apart from a genuinely all-passing file. Found
    // during the pre-deployment audit; dormant until now (every test
    // file so far has always registered at least one test), but worth
    // closing before this suite is trusted for CI.
    if (tests.length === 0) {
        console.log("  \x1b[31m✖ No tests were registered in this file.\x1b[0m");
        console.log("");
        console.log("\x1b[31m0/0 passed — treating an empty test file as a failure, not a pass.\x1b[0m");
        process.exitCode = 1;
        return;
    }

    let failed = 0;

    for (const { name, fn } of tests) {
        try {
            await fn();
            console.log(`  \x1b[32m✔\x1b[0m ${name}`);
        } catch (error) {
            failed++;
            console.log(`  \x1b[31m✖ ${name}\x1b[0m`);
            console.log(`    ${error.stack || error.message}`);
        }
    }

    const total = tests.length;
    const passed = total - failed;

    console.log("");
    console.log(
        failed === 0
            ? `\x1b[32m${passed}/${total} passed\x1b[0m`
            : `\x1b[31m${passed}/${total} passed, ${failed} failed\x1b[0m`
    );

    process.exitCode = failed === 0 ? 0 : 1;
}

/** A fresh, isolated temp directory — caller is responsible for nothing;
 * these live under the OS temp dir, not inside the project, so a test
 * run never touches real data/ files. */
function makeTempDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

module.exports = { test, runTests, assert, makeTempDir };
