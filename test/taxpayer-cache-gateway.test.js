/**
 * Tests server/taxpayer-cache-gateway.js — the two-gate
 * orchestration that's the heart of the cache design. Runs as its
 * own process (see test/run-all.js) so mutating the config
 * singleton and monkey-patching pipeline.js's exports here can
 * never leak into another test file.
 *
 * Mocking approach: this project has no test framework/mocking
 * library, so pipeline.js and results-store.js are required
 * directly FIRST, their exported functions are overwritten in
 * place, and ONLY THEN is the gateway required for the first time
 * — Node's module cache means the gateway's own
 * `const { runLookup } = require(...)` destructuring picks up the
 * already-patched function, not the real one. Order matters: the
 * gateway must not have been required (by anything) before the
 * patching happens.
 */

const { test, runTests, assert, makeTempDir } = require("./test-helpers");

const config = require("../config/config");
config.paths.taxpayerCacheDir = makeTempDir("taxpayer-cache-gateway-test-cache");
config.paths.resultsDir = makeTempDir("taxpayer-cache-gateway-test-results");
config.resultCache.enabled = true;
config.resultCache.defaultMaxAgeMs = 60 * 60 * 1000; // 1h default for these tests

// Patch BEFORE the gateway is ever required.
const pipelineModule = require("../pipeline/pipeline");
const resultsStoreModule = require("../storage/results-store");

let runLookupCallCount = 0;
let runLookupDelayMs = 0;

pipelineModule.runLookup = async gstin => {
    runLookupCallCount++;
    if (runLookupDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, runLookupDelayMs));
    }
    return { legalName: `LIVE RESULT for ${gstin}`, fetchedNumber: runLookupCallCount };
};

resultsStoreModule.saveResult = async () => null; // no-op — audit trail isn't what's under test here

const { getOrRefreshTaxpayer } = require("../server/taxpayer-cache-gateway");
const { setCached, getCached } = require("../storage/taxpayer-cache-store");

function resetCallCounter() {
    runLookupCallCount = 0;
    runLookupDelayMs = 0;
}

test("Gate 1 HIT: a fresh cache entry is served without ever calling runLookup", async () => {
    resetCallCounter();
    const gstin = "11GATE1HIT001Z1";
    await setCached(gstin, { legalName: "already cached" });

    const result = await getOrRefreshTaxpayer(gstin, {});

    assert.equal(result.cacheStatus, "HIT");
    assert.equal(result.data.legalName, "already cached");
    assert.equal(runLookupCallCount, 0, "runLookup must not be called on a fresh-cache hit");
});

test("Gate 1 MISS: no cache entry runs a live lookup and populates the cache", async () => {
    resetCallCounter();
    const gstin = "12GATE1MISS002Z2";

    const first = await getOrRefreshTaxpayer(gstin, {});
    assert.equal(first.cacheStatus, "MISS");
    assert.equal(runLookupCallCount, 1);

    // A second call shortly after should now be a HIT, from the
    // record the first call just wrote — no second lookup.
    const second = await getOrRefreshTaxpayer(gstin, {});
    assert.equal(second.cacheStatus, "HIT");
    assert.equal(runLookupCallCount, 1, "the second call must not trigger another live lookup");
    assert.equal(second.data.legalName, first.data.legalName);
});

test("maxCacheAgeMs: 0 forces a live lookup even when a fresh cache entry exists", async () => {
    resetCallCounter();
    const gstin = "13FORCEDREFRESH03Z3";
    await setCached(gstin, { legalName: "stale-by-choice" });

    const result = await getOrRefreshTaxpayer(gstin, { maxCacheAgeMs: 0 });

    assert.equal(result.cacheStatus, "MISS", "maxCacheAgeMs: 0 must never be served from cache");
    assert.equal(runLookupCallCount, 1);
});

test("a smaller per-request maxCacheAgeMs overrides the configured default", async () => {
    resetCallCounter();
    const gstin = "14OVERRIDE04Z4";

    await setCached(gstin, { legalName: "aging record" });
    const record = await getCached(gstin);

    // Backdate the record so it's older than a tight override, but
    // still comfortably within the 1h configured default — proves
    // the override is actually being honored, not just the default.
    record.fetchedAt = Date.now() - 5000; // 5s old
    await require("fs/promises").writeFile(
        require("path").join(config.paths.taxpayerCacheDir, `${gstin}.json`),
        JSON.stringify(record)
    );

    const result = await getOrRefreshTaxpayer(gstin, { maxCacheAgeMs: 1000 }); // only 1s acceptable

    assert.equal(result.cacheStatus, "MISS", "a 5s-old record must be stale against a 1s override");
    assert.equal(runLookupCallCount, 1);
});

test("resultCache.enabled = false bypasses the cache entirely — no read AND no write", async () => {
    resetCallCounter();
    const gstin = "15DISABLED05Z5";
    await setCached(gstin, { legalName: "should be ignored" });

    config.resultCache.enabled = false;
    try {
        const result = await getOrRefreshTaxpayer(gstin, {});
        assert.equal(result.cacheStatus, "MISS");
        assert.equal(runLookupCallCount, 1, "disabling the cache must still perform a live lookup");

        // The bug this test used to miss (found in the pre-deployment
        // audit): the disabled branch called refreshTaxpayer(), which
        // unconditionally wrote the fresh result back to the cache
        // store — so "disabled" only ever meant "don't read," not the
        // "never consulted or written to at all" config.js promises.
        // Checking the store directly (bypassing the gateway, which
        // is still disabled) proves the pre-existing record was left
        // alone, not silently overwritten by the live lookup above.
        const stored = await getCached(gstin);
        assert.equal(
            stored.data.legalName,
            "should be ignored",
            "disabling the cache must mean the live lookup's fresh result is NOT written back either"
        );
    } finally {
        config.resultCache.enabled = true; // restore for any tests after this one
    }
});

test("concurrency: a burst of maxCacheAgeMs:0 (force-refresh) requests for the same GSTIN still only triggers one live lookup", async () => {
    resetCallCounter();
    runLookupDelayMs = 40; // widen the race window so all three requests' Gate 1 checks land before the first one finishes
    const gstin = "18FORCEBURST08Z8";
    await setCached(gstin, { legalName: "stale-by-choice" }); // present but must be ignored by every request in the burst — maxCacheAgeMs: 0 means "never fresh"
    // A small real gap between the pre-existing write above and the
    // burst below, so this test isn't relying on sub-millisecond
    // timing luck to tell them apart (Date.now() is only
    // millisecond-resolution — see the gateway's own comment on why
    // it compares with a strict `>`, not `>=`).
    await new Promise(resolve => setTimeout(resolve, 10));

    // The bug this covers (found in the pre-deployment audit): Gate
    // 2's re-check used to rely solely on isFresh(record, maxAgeMs),
    // which is unconditionally false whenever maxAgeMs <= 0 — so even
    // the two requests queued BEHIND the one that actually ran the
    // live lookup would themselves each run their own live lookup,
    // since "is this fresh enough" can never be true under force-
    // refresh semantics. Fixed with a "was this refreshed after I
    // arrived" check in the gateway, specific to maxAgeMs <= 0.
    const results = await Promise.all([
        getOrRefreshTaxpayer(gstin, { maxCacheAgeMs: 0 }),
        getOrRefreshTaxpayer(gstin, { maxCacheAgeMs: 0 }),
        getOrRefreshTaxpayer(gstin, { maxCacheAgeMs: 0 })
    ]);

    assert.equal(runLookupCallCount, 1, "a concurrent force-refresh burst for one GSTIN must still only run one live lookup");

    const missCount = results.filter(r => r.cacheStatus === "MISS").length;
    const hitCount = results.filter(r => r.cacheStatus === "HIT").length;
    assert.equal(missCount, 1, "exactly one request in the burst should be the MISS that did the work");
    assert.equal(hitCount, 2, "the other two should be HITs off the one live lookup's result, not separate live lookups");
});

test("concurrency: two simultaneous requests for the same GSTIN trigger exactly ONE live lookup", async () => {
    resetCallCounter();
    runLookupDelayMs = 40; // widen the race window so both requests' Gate 1 pre-checks land before either finishes
    const gstin = "16RACE06Z6";

    const [resultA, resultB] = await Promise.all([
        getOrRefreshTaxpayer(gstin, {}),
        getOrRefreshTaxpayer(gstin, {})
    ]);

    assert.equal(runLookupCallCount, 1, "a concurrent burst for one GSTIN must never run more than one live lookup");

    const statuses = [resultA.cacheStatus, resultB.cacheStatus].sort();
    assert.deepEqual(
        statuses,
        ["HIT", "MISS"],
        "exactly one request should be the MISS that did the work, the other a HIT off its result"
    );

    // Both requests must still see the SAME underlying data, whichever
    // one actually ran the lookup.
    assert.equal(resultA.data.legalName, resultB.data.legalName);
});

test("concurrency: a burst of THREE simultaneous requests still only triggers one live lookup", async () => {
    resetCallCounter();
    runLookupDelayMs = 40;
    const gstin = "17RACE307Z7";

    const results = await Promise.all([
        getOrRefreshTaxpayer(gstin, {}),
        getOrRefreshTaxpayer(gstin, {}),
        getOrRefreshTaxpayer(gstin, {})
    ]);

    assert.equal(runLookupCallCount, 1);
    const missCount = results.filter(r => r.cacheStatus === "MISS").length;
    const hitCount = results.filter(r => r.cacheStatus === "HIT").length;
    assert.equal(missCount, 1);
    assert.equal(hitCount, 2);
});

runTests();
