/**
 * ============================================================
 * SCRAPE QUEUE
 * ============================================================
 *
 * Serializes lookup jobs so only one Puppeteer/2Captcha run is
 * ever in flight at a time. Running several Chromium instances
 * and 2Captcha tasks concurrently on one machine is a resource
 * and reliability risk we don't need to take on for a single-
 * consumer internal API — this keeps things simple and
 * predictable. Revisit if the API ever needs real concurrency.
 */

let tail = Promise.resolve();
let queueLength = 0;

/**
 * Runs `fn` once every job queued ahead of it has finished,
 * regardless of whether those earlier jobs succeeded or failed.
 * Returns a promise that resolves/rejects with fn's own outcome.
 */
function runExclusive(fn) {
    queueLength++;

    const run = tail.then(() => fn());

    tail = run.catch(() => {}).finally(() => {
        queueLength--;
    });

    return run;
}

function getQueueLength() {
    return queueLength;
}

module.exports = { runExclusive, getQueueLength };
