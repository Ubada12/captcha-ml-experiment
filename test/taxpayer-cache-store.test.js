/**
 * Tests storage/taxpayer-cache-store.js in isolation, against a
 * temp directory (never the real data/taxpayer-cache/). Run as its
 * own process — see test/run-all.js.
 */

const fs = require("fs");
const path = require("path");
const { test, runTests, assert, makeTempDir } = require("./test-helpers");

const config = require("../config/config");
config.paths.taxpayerCacheDir = makeTempDir("taxpayer-cache-store-test");

const { getCached, setCached, isFresh, normalizeGstin } = require("../storage/taxpayer-cache-store");

const SAMPLE_GSTIN = "27ABCDE1234F1Z5";
const SAMPLE_DATA = { legalName: "ABC TEXTILES PRIVATE LIMITED", registrationStatus: "ACTIVE" };

test("getCached returns null when nothing has ever been cached for a GSTIN", async () => {
    const result = await getCached("29ZZZZZ0000Z1Z0");
    assert.equal(result, null);
});

test("setCached then getCached round-trips the exact record shape", async () => {
    const written = await setCached(SAMPLE_GSTIN, SAMPLE_DATA);
    assert.ok(written, "setCached should return the stored record");

    const read = await getCached(SAMPLE_GSTIN);
    assert.ok(read, "getCached should find what was just written");

    assert.equal(read.gstin, SAMPLE_GSTIN);
    assert.deepEqual(read.data, SAMPLE_DATA);
    assert.equal(typeof read.fetchedAt, "number");
    assert.equal(read.source, "GST_PORTAL");
    assert.equal(read.schemaVersion, 1);
});

test("GSTIN key is case/whitespace normalized — one record regardless of casing", async () => {
    const gstin = "29poiuy5678g1z9";
    await setCached(gstin, { legalName: "lowercase written" });

    const readUpper = await getCached("29POIUY5678G1Z9");
    const readPadded = await getCached("  29POIUY5678G1Z9  ");

    assert.ok(readUpper, "should find the record via the uppercase form");
    assert.ok(readPadded, "should find the record via a padded form");
    assert.equal(readUpper.data.legalName, "lowercase written");
    assert.equal(normalizeGstin(" 29poiuy5678g1z9 "), "29POIUY5678G1Z9");
});

test("a second setCached for the same GSTIN overwrites in place — no duplicate files", async () => {
    const gstin = "07OVERWR1234F1Z2";

    await setCached(gstin, { legalName: "first version" });
    const filesAfterFirst = fs.readdirSync(config.paths.taxpayerCacheDir)
        .filter(name => name.startsWith(gstin));
    assert.equal(filesAfterFirst.length, 1);

    await setCached(gstin, { legalName: "second version" });
    const filesAfterSecond = fs.readdirSync(config.paths.taxpayerCacheDir)
        .filter(name => name.startsWith(gstin));

    assert.equal(filesAfterSecond.length, 1, "must still be exactly one file for this GSTIN");

    const read = await getCached(gstin);
    assert.equal(read.data.legalName, "second version");
});

test("no leftover .tmp files remain after a successful write (atomic write-then-rename)", async () => {
    await setCached("19TMPCHECK123F1Z1", { legalName: "tmp check" });

    const leftoverTmpFiles = fs.readdirSync(config.paths.taxpayerCacheDir)
        .filter(name => name.endsWith(".tmp"));

    assert.deepEqual(leftoverTmpFiles, [], "temp files should never survive a successful setCached call");
});

test("a cache file with a mismatched internal gstin field is treated as a miss, not trusted", async () => {
    const gstin = "36MISMATCH12F1Z3";
    await setCached(gstin, { legalName: "will be corrupted" });

    // Hand-corrupt the file's internal gstin field while keeping the
    // filename correct — simulates filesystem-level corruption/tampering.
    const filePath = path.join(config.paths.taxpayerCacheDir, `${gstin}.json`);
    const record = JSON.parse(fs.readFileSync(filePath, "utf8"));
    record.gstin = "SOMETHING_ELSE_ENTIRELY";
    fs.writeFileSync(filePath, JSON.stringify(record));

    const read = await getCached(gstin);
    assert.equal(read, null, "a mismatched gstin field must never be trusted as a hit");
});

test("isFresh: within maxAge is fresh, older than maxAge is not", async () => {
    const now = Date.now();
    assert.equal(isFresh({ fetchedAt: now - 1000 }, 5000), true);
    assert.equal(isFresh({ fetchedAt: now - 10000 }, 5000), false);
});

test("isFresh: maxAgeMs of 0 means nothing is ever fresh (force-refresh convention)", async () => {
    assert.equal(isFresh({ fetchedAt: Date.now() }, 0), false);
});

test("isFresh: null/missing record is never fresh", async () => {
    assert.equal(isFresh(null, 60000), false);
    assert.equal(isFresh(undefined, 60000), false);
});

test("isFresh: a record timestamped in the future (clock skew) is never trusted as fresh", async () => {
    assert.equal(isFresh({ fetchedAt: Date.now() + 60000 }, 5000), false);
});

runTests();
