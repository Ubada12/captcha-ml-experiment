/**
 * ============================================================
 * BULK DATASET COLLECTION SCRIPT
 * ============================================================
 *
 * Hits the running API server's POST /api/taxpayer over and
 * over with a real GSTIN, purely to rack up successful CAPTCHA
 * solves for the Level 3 dataset. This script is just a client
 * of the API, exactly like Postman was — it never touches
 * Puppeteer, 2Captcha, or the dataset store directly. The
 * server does all of that, the same as it would for any other
 * caller.
 *
 * IMPORTANT — read before running:
 *   Dataset collection only actually writes anything if the
 *   SERVER process was started with DATASET_COLLECTION_ENABLED=true
 *   in its .env. Env vars are read once at server startup, not
 *   live — so if the server is already running without that flag,
 *   set it in .env, then stop and restart `node server.js` first.
 *   This script has no way to check that from the outside: if you
 *   skip this, every one of the 100 lookups below will succeed and
 *   NOTHING will land in data/dataset/labels.jsonl.
 *
 *   Also worth knowing before you kick this off: 100 successful
 *   solves means 100 real 2Captcha charges, and each lookup
 *   realistically takes anywhere from ~15s to ~2 minutes (CAPTCHA
 *   polling can run long), plus a politeness delay between
 *   requests — so a full run of 100 can take well over an hour.
 *
 * Usage:
 *   node scripts/collect-dataset.js
 *   node scripts/collect-dataset.js --count=50 --delay-ms=5000
 *   npm run collect-dataset -- --count=25
 *
 * IMPORTANT — cache-aware POST /api/taxpayer:
 *   POST /api/taxpayer now serves a fresh-enough cached result
 *   instead of always running a live lookup (see
 *   server/taxpayer-cache-gateway.js and
 *   docs/gstin-cache-architecture-plan.md). This script's whole
 *   point is racking up MANY INDEPENDENT LIVE SOLVES of the same
 *   GSTIN, so every request below explicitly sends
 *   `maxCacheAgeMs: 0` — "nothing cached is ever fresh enough" —
 *   to force a real lookup every time, exactly like every request
 *   this script made before the cache existed. Do not remove that
 *   without understanding why it's there: without it, attempt 2
 *   onward would just return attempt 1's cached result instantly,
 *   with no error at all, and dataset collection would silently
 *   stop collecting anything.
 *
 * Flags (all optional):
 *   --count=100                     how many SUCCESSFUL solves to
 *                                    collect (keeps going past
 *                                    failures until it hits this
 *                                    many successes, not just N
 *                                    attempts)
 *   --gstin=<value>                 GSTIN to look up (defaults to
 *                                    config.gstin — the same one
 *                                    already confirmed working)
 *   --url=<value>                   endpoint to hit (defaults to
 *                                    http://localhost:<port>/api/taxpayer,
 *                                    using config.server.port)
 *   --delay-ms=3000                 pause between requests
 *   --max-consecutive-failures=5    abort if this many requests in
 *                                    a row fail, instead of quietly
 *                                    burning through 2Captcha
 *                                    credits on a broken run
 */

require("dotenv").config();

const config = require("../config/config");

function parseArgs(argv) {
    const args = {};

    for (const raw of argv) {
        const match = /^--([^=]+)=(.*)$/.exec(raw);
        if (match) {
            args[match[1]] = match[2];
        }
    }

    return args;
}

const cliArgs = parseArgs(process.argv.slice(2));

const TARGET_SUCCESS_COUNT = parseInt(cliArgs.count, 10) || 100;
const GSTIN = cliArgs.gstin || config.gstin;
const ENDPOINT_URL = cliArgs.url || `http://localhost:${config.server.port}/api/taxpayer`;
const DELAY_MS = cliArgs["delay-ms"] !== undefined ? parseInt(cliArgs["delay-ms"], 10) : 3000;
const MAX_CONSECUTIVE_FAILURES = parseInt(cliArgs["max-consecutive-failures"], 10) || 5;

const API_KEY = (config.security.apiKeys || [])[0];

// ------------------------------------------------------------
// Terminal output. This is a standalone admin tool, not part of
// the app's own request pipeline, so it doesn't route through
// logger/logger.js — it prints its own compact progress lines
// plus the raw response body, close to what Postman shows.
// ------------------------------------------------------------

const COLOR = {
    reset: "\x1b[0m",
    dim: "\x1b[2m",
    green: "\x1b[32m",
    red: "\x1b[31m",
    yellow: "\x1b[33m",
    cyan: "\x1b[36m",
    bold: "\x1b[1m"
};

function timestamp() {
    return new Date().toISOString().slice(11, 19); // HH:MM:SS
}

function line(color, label, message) {
    console.log(`${COLOR.dim}${timestamp()}${COLOR.reset} ${color}${label}${COLOR.reset} ${message}`);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function formatDuration(ms) {
    return `${(ms / 1000).toFixed(1)}s`;
}

async function attemptLookup(attemptNumber) {

    const startedAt = Date.now();

    line(COLOR.cyan, "→", `[attempt ${attemptNumber}] Sending lookup for GSTIN ${GSTIN}...`);

    let response;

    try {
        response = await fetch(ENDPOINT_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-API-Key": API_KEY
            },
            // maxCacheAgeMs: 0 forces a live lookup every time — see
            // the "IMPORTANT — cache-aware POST /api/taxpayer" note
            // in this file's header comment for why this must stay.
            body: JSON.stringify({ gstin: GSTIN, maxCacheAgeMs: 0 })
        });
    } catch (error) {
        const elapsed = formatDuration(Date.now() - startedAt);
        line(COLOR.red, "✖", `[attempt ${attemptNumber}] Request failed after ${elapsed}: ${error.message}`);
        return { ok: false, reason: error.message };
    }

    const elapsed = formatDuration(Date.now() - startedAt);
    let body;

    try {
        body = await response.json();
    } catch (error) {
        line(
            COLOR.red,
            "✖",
            `[attempt ${attemptNumber}] HTTP ${response.status} after ${elapsed}, but the response wasn't valid JSON.`
        );
        return { ok: false, reason: `non-JSON response (HTTP ${response.status})` };
    }

    if (!response.ok) {
        line(COLOR.red, "✖", `[attempt ${attemptNumber}] HTTP ${response.status} after ${elapsed}.`);
        console.log(JSON.stringify(body, null, 2));
        return { ok: false, reason: body?.details || body?.error || `HTTP ${response.status}` };
    }

    line(COLOR.green, "✔", `[attempt ${attemptNumber}] SUCCESS — HTTP ${response.status} in ${elapsed}.`);
    console.log(JSON.stringify(body, null, 2));
    return { ok: true };
}

async function main() {

    if (!API_KEY) {
        line(COLOR.red, "✖", "No API key found. Set API_KEYS in .env before running this.");
        process.exitCode = 1;
        return;
    }

    console.log("");
    line(COLOR.bold, "==", `Collecting ${TARGET_SUCCESS_COUNT} successful lookups from ${ENDPOINT_URL}`);
    line(COLOR.dim, "  ", `GSTIN: ${GSTIN} | delay between requests: ${DELAY_MS}ms`);
    line(
        COLOR.yellow,
        "!!",
        "Reminder: this only feeds the dataset if the SERVER was started with DATASET_COLLECTION_ENABLED=true."
    );
    console.log("");

    const runStartedAt = Date.now();

    let attempted = 0;
    let succeeded = 0;
    let failed = 0;
    let consecutiveFailures = 0;
    const failureReasons = [];

    while (succeeded < TARGET_SUCCESS_COUNT) {

        attempted++;

        const result = await attemptLookup(attempted);

        if (result.ok) {
            succeeded++;
            consecutiveFailures = 0;
        } else {
            failed++;
            consecutiveFailures++;
            failureReasons.push(result.reason);
        }

        const left = TARGET_SUCCESS_COUNT - succeeded;

        line(
            COLOR.bold,
            "==",
            `Progress: ${succeeded}/${TARGET_SUCCESS_COUNT} succeeded | ${attempted} attempted | ${failed} failed | ${left} left`
        );
        console.log("");

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            line(
                COLOR.red,
                "✖",
                `Aborting: ${consecutiveFailures} failures in a row. Last reason: ${failureReasons[failureReasons.length - 1]}`
            );
            line(
                COLOR.red,
                "✖",
                "Check the server is running, DATASET_COLLECTION_ENABLED, and your API key before retrying."
            );
            break;
        }

        if (succeeded < TARGET_SUCCESS_COUNT) {
            await sleep(DELAY_MS);
        }
    }

    const totalElapsed = formatDuration(Date.now() - runStartedAt);

    console.log("");
    line(COLOR.bold, "==", "Done.");
    line(COLOR.green, "✔", `${succeeded} succeeded`);
    line(failed > 0 ? COLOR.yellow : COLOR.dim, failed > 0 ? "!!" : "  ", `${failed} failed`);
    line(COLOR.dim, "  ", `${attempted} total attempts in ${totalElapsed}`);

    if (succeeded < TARGET_SUCCESS_COUNT) {
        line(COLOR.yellow, "!!", `Stopped short of the ${TARGET_SUCCESS_COUNT} target.`);
        process.exitCode = 1;
    }
}

main();
