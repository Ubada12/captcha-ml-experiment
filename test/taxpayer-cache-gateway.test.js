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

test("resultCache.enabled = false bypasses the cache entirely, even with a fresh entry present", async () => {
    resetCallCounter();
    const gstin = "15DISABLED05Z5";
    await setCached(gstin, { legalName: "should be ignored" });

    config.resultCache.enabled = false;
    try {
        const result = await getOrRefreshTaxpayer(gstin, {});
        assert.equal(result.cacheStatus, "MISS");
        assert.equal(runLookupCallCount, 1, "disabling the cache must still perform a live lookup");
    } finally {
        config.resultCache.enabled = true; // restore for any tests after this one
    }
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
