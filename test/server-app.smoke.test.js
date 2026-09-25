/**
 * Smoke test: does server/app.js's createApp() actually boot and
 * wire up its routes correctly after the cache refactor? This
 * deliberately does NOT exercise a real lookup (that would need a
 * real browser + real portal) — it only proves the require graph,
 * middleware, and route registration all still work end-to-end
 * over real HTTP, on an ephemeral port, exactly the way a real
 * client would call this API.
 */

const http = require("http");
const { test, runTests, assert, makeTempDir } = require("./test-helpers");

const config = require("../config/config");
config.paths.taxpayerCacheDir = makeTempDir("server-app-smoke-cache");
config.paths.resultsDir = makeTempDir("server-app-smoke-results");
config.security.apiKeys = ["test-api-key-123"];

const { createApp } = require("../server/app");

const app = createApp();
let server;
let baseUrl;

async function startServer() {
    return new Promise(resolve => {
        server = app.listen(0, () => {
            baseUrl = `http://127.0.0.1:${server.address().port}`;
            resolve();
        });
    });
}

async function stopServer() {
    return new Promise(resolve => server.close(resolve));
}

test("setup: server boots on an ephemeral port", async () => {
    await startServer();
    assert.ok(baseUrl);
});

test("GET /health responds without requiring an API key", async () => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "ok");
    assert.equal(typeof body.queueLength, "number");
});

test("POST /api/taxpayer without an API key is rejected with 401", async () => {
    const response = await fetch(`${baseUrl}/api/taxpayer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gstin: "27ABCDE1234F1Z5" })
    });
    assert.equal(response.status, 401);
});

test("POST /api/taxpayer with a malformed GSTIN is rejected with 400 before ever touching the cache/lookup path", async () => {
    const response = await fetch(`${baseUrl}/api/taxpayer`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": "test-api-key-123" },
        body: JSON.stringify({ gstin: "not-a-real-gstin" })
    });
    assert.equal(response.status, 400);
});

test("POST /api/taxpayer with an invalid maxCacheAgeMs is rejected with 400, listing the problem", async () => {
    // A syntactically valid GSTIN here on purpose — this proves the
    // rejection comes from maxCacheAgeMs validation specifically, not
    // as a side effect of the gstin check above. Since validation
    // runs (and fails) before getOrRefreshTaxpayer is ever called,
    // this never reaches the real pipeline/browser — same as the
    // malformed-GSTIN case above.
    const response = await fetch(`${baseUrl}/api/taxpayer`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": "test-api-key-123" },
        body: JSON.stringify({ gstin: "27ABCDE1234F1Z5", maxCacheAgeMs: -1 })
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.ok(Array.isArray(body.details) && body.details.some(message => message.includes("maxCacheAgeMs")));
});

test("GET /api/taxpayer/:gstin/cached with a valid but never-looked-up GSTIN returns 404", async () => {
    const response = await fetch(`${baseUrl}/api/taxpayer/29ZZZZZ0000Z1Z0/cached`, {
        headers: { "X-API-Key": "test-api-key-123" }
    });
    assert.equal(response.status, 404);
});

test("unknown route returns 404", async () => {
    const response = await fetch(`${baseUrl}/api/does-not-exist`, {
        headers: { "X-API-Key": "test-api-key-123" }
    });
    assert.equal(response.status, 404);
});

test("teardown: server closes cleanly", async () => {
    await stopServer();
});

runTests();
