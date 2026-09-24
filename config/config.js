/**
 * ============================================================
 * APPLICATION CONFIGURATION
 * ============================================================
 *
 * All tunable, non-secret configuration lives here. Secrets
 * (API keys, credentials) stay in `.env` and are only read
 * here via process.env — never hardcoded.
 *
 * dotenv.config() is called once, in main.js (the entry point),
 * before this file is required anywhere.
 */

const path = require("path");

const projectRoot = path.resolve(__dirname, "..");

// ------------------------------------------------------
// `process.env.X || fallback` silently discards an explicit,
// deliberately-chosen "0" — parseInt("0") === 0, and 0 is falsy in
// JS, so `0 || 2` evaluates to 2 instead of the 0 the operator
// actually asked for. That's a real footgun for knobs where 0 is a
// meaningful value (e.g. OWN_MODEL_MAX_RETRIES=0 meaning "don't
// retry the own model at all, fall back to 2Captcha after the first
// miss", or a confidence threshold of 0 meaning "always trust it").
// These two helpers fall back only when the env var is genuinely
// unset/unparseable (NaN), never when it parses to a valid 0.
// ------------------------------------------------------
function intFromEnv(value, fallback) {
    const parsed = parseInt(value, 10);
    return Number.isNaN(parsed) ? fallback : parsed;
}

function floatFromEnv(value, fallback) {
    const parsed = parseFloat(value);
    return Number.isNaN(parsed) ? fallback : parsed;
}

module.exports = {

    // ------------------------------------------------------
    // Target site / lookup
    // ------------------------------------------------------
    targetUrl:
        process.env.TARGET_URL ||
        "http://xyz.com/gst_lookup/limited_data",

    gstin:
        process.env.GSTIN_NUMBER ||
        "27AOHPA6448R1ZC",

    // ------------------------------------------------------
    // Form selectors (kept together so a portal markup change
    // only requires editing this one block)
    // ------------------------------------------------------
    selectors: {
        gstinInput: "#for_gstin",
        captchaImage: "#imgCaptcha",
        captchaInput: "#fo-captcha",
        searchButton: "#lotsearch"
    },

    // ------------------------------------------------------
    // Target API endpoint we intercept via Puppeteer's
    // network layer
    // ------------------------------------------------------
    api: {
        taxpayerPattern: "/services/api/search/taxpayerDetails"
    },

    // ------------------------------------------------------
    // 2Captcha solver settings — unchanged. Still required
    // whenever the own-model fallback path (below) can fire.
    // ------------------------------------------------------
    captchaSolver: {
        apiKey: process.env.TWOCAPTCHA_API_KEY,
        expectedLength: 6,
        maxPollAttempts: 24,
        pollIntervalMs: 5000
    },

    // ------------------------------------------------------
    // Own-trained CAPTCHA model settings (Level 6 of the
    // roadmap: try our own model first, fall back to 2Captcha
    // on low confidence or a confirmed-wrong portal rejection).
    //
    // Talks to ml-service (a standalone FastAPI process — see
    // ml-service/serve.py) over plain HTTP. That service is not
    // started by this app; run it separately (see ml-service's
    // own docs) before enabling this.
    // ------------------------------------------------------
    ownModelSolver: {

        serviceUrl: process.env.OWN_MODEL_SERVICE_URL || "http://127.0.0.1:8001",

        // Local inference should be near-instant. A short timeout
        // here means a hung/unreachable ml-service is detected and
        // routed around (see fallbackTo2CaptchaEnabled) in seconds,
        // not by hanging the whole lookup.
        //
        // Careful with 0 here: this is passed straight to axios as
        // `timeout`, and axios treats 0 as "no timeout at all" (waits
        // forever), not "time out immediately" — the opposite of what
        // 0 usually implies for the other knobs in this block.
        requestTimeoutMs: intFromEnv(process.env.OWN_MODEL_REQUEST_TIMEOUT_MS, 5000),

        // How many times to retry OUR OWN model — each retry against
        // a freshly recaptured CAPTCHA image, since the portal issues
        // a new image after every rejected attempt — before giving up
        // on it for this lookup. 2 means up to 3 total own-model
        // attempts (the first try plus 2 retries). 0 is a valid,
        // deliberate choice too ("try our model exactly once, then go
        // straight to 2Captcha") — see intFromEnv's comment above for
        // why this can't just be `parseInt(...) || 2`.
        maxRetries: intFromEnv(process.env.OWN_MODEL_MAX_RETRIES, 2),

        // A prediction is only trusted pre-submit if it's exactly 6
        // digits AND clears both confidence thresholds. minConfidence
        // matters more than avgConfidence here: a single wrong digit
        // fails the whole lookup, so one weak character should count
        // as low confidence overall even if the other five are strong.
        //
        // These are STARTING VALUES, not calibrated ones — see the
        // ML_Captcha_Integration_Plan.md "Open item" section. Revisit
        // once the full labeled dataset can be scored end-to-end.
        confidenceThreshold: {
            avg: floatFromEnv(process.env.OWN_MODEL_AVG_CONFIDENCE_THRESHOLD, 0.90),
            min: floatFromEnv(process.env.OWN_MODEL_MIN_CONFIDENCE_THRESHOLD, 0.60)
        },

        // Master switch. false = own-model-solver.js is never called
        // at all and every lookup goes straight to 2Captcha, exactly
        // like before this feature existed — an instant rollback
        // lever if the own-model path ever needs to be pulled out of
        // the live path without a code change.
        enabled: process.env.OWN_MODEL_SOLVER_ENABLED !== "false",

        // Separate from `enabled` on purpose: this controls only
        // whether exhausting maxRetries falls back to 2Captcha, or
        // just fails the lookup outright. Kept as its own switch so
        // "always use our model, never spend a 2Captcha credit" is
        // also a valid configuration, not just on/off for the whole
        // own-model feature.
        fallbackTo2CaptchaEnabled: process.env.OWN_MODEL_FALLBACK_ENABLED !== "false"
    },

    // ------------------------------------------------------
    // Timeouts (all in milliseconds)
    // ------------------------------------------------------
    timeouts: {
        apiRequestMs: 15000,
        pageNavigationMs: 30000,
        elementMs: 10000,
        taxpayerResponseMs: 15000
    },

    // ------------------------------------------------------
    // Browser launch options
    // ------------------------------------------------------
    browser: {
        launchOptions: {
            // Defaults to headless so this runs unmodified on any
            // machine — including a bare Linux server/VM with no
            // display at all, which would otherwise fail to launch
            // the browser entirely. Set HEADLESS=false in .env only
            // when you deliberately want to watch it run (e.g. on
            // your own desktop while debugging).
            headless: process.env.HEADLESS !== "false",
            defaultViewport: null,
            args: [
                "--start-maximized",
                // Required inside almost any Docker/container host
                // (Vast.ai included) — Chrome's sandbox needs kernel
                // privileges that containers typically run as root
                // without, and refuses to launch at all otherwise.
                // Harmless on a normal desktop/VM, so this stays on
                // unconditionally rather than behind another env flag.
                "--no-sandbox",
                "--disable-setuid-sandbox",
                // Containers default /dev/shm to 64MB, which headless
                // Chrome can outgrow mid-run (renderer crashes with no
                // useful error). This makes Chrome use /tmp instead.
                "--disable-dev-shm-usage"
            ]
        }
    },

    // ------------------------------------------------------
    // Dataset collection (Level 3/4 of the roadmap).
    //
    // Off by default. We deliberately don't start collecting
    // labeled CAPTCHAs until we've decided to, per the
    // "don't rush into training" plan. Flip this on later via
    // .env: DATASET_COLLECTION_ENABLED=true
    // ------------------------------------------------------
    dataset: {
        enabled: process.env.DATASET_COLLECTION_ENABLED === "true"
    },

    // ------------------------------------------------------
    // Logging
    // ------------------------------------------------------
    logging: {
        // trace | debug | info | success | warn | error | fatal
        level: process.env.LOG_LEVEL || "debug"
    },

    // ------------------------------------------------------
    // API server (Level 3.5)
    // ------------------------------------------------------
    server: {
        port: parseInt(process.env.PORT, 10) || 4000,

        // A single lookup can legitimately take a couple of minutes —
        // CAPTCHA polling alone can run up to maxPollAttempts *
        // pollIntervalMs (24 * 5s = 120s by default) on top of page
        // navigation and element waits. This must stay comfortably
        // above that so the HTTP layer doesn't time out a lookup that
        // was still genuinely in progress.
        requestTimeoutMs: 5 * 60 * 1000
    },

    // ------------------------------------------------------
    // API authentication.
    //
    // API_KEYS is a comma-separated list in .env — one string per
    // client that's allowed to call /api/*. No database, no
    // sessions: a request either presents a key from this list in
    // the X-API-Key header or it gets a 401. CORS is intentionally
    // NOT configured (see README) — this key is what authorizes a
    // caller, not which origin it came from.
    // ------------------------------------------------------
    security: {
        apiKeys: (process.env.API_KEYS || "")
            .split(",")
            .map(key => key.trim())
            .filter(Boolean)
    },

    // ------------------------------------------------------
    // S3 batch upload (scripts/upload-dataset.js).
    //
    // Not part of the collection pipeline itself — a separate,
    // periodically-run tool that zips whatever's accumulated in
    // data/dataset/ and ships it to S3 once there's enough of it.
    // AWS credentials are deliberately NOT read here: the AWS SDK's
    // default provider chain already reads AWS_ACCESS_KEY_ID /
    // AWS_SECRET_ACCESS_KEY from the environment on its own, so
    // there's nothing for this app's config to duplicate.
    // ------------------------------------------------------
    s3: {
        bucket: process.env.S3_BUCKET || null,
        region: process.env.AWS_REGION || "ap-south-1",
        prefix: process.env.S3_PREFIX || "gst-captcha-dataset",
        // Upload once this many new, not-yet-uploaded samples have
        // accumulated. --flush (see the script) overrides this to
        // upload whatever's pending regardless of size — for the
        // last partial batch at the end of a run.
        batchSize: parseInt(process.env.DATASET_BATCH_SIZE, 10) || 1000
    },

    // ------------------------------------------------------
    // Filesystem paths — every module that writes to disk
    // pulls its path from here, so there is exactly one place
    // that defines the on-disk layout.
    // ------------------------------------------------------
    paths: {
        root: projectRoot,

        captchasDir: path.join(projectRoot, "data", "captchas"),
        failuresDir: path.join(projectRoot, "data", "failures"),
        resultsDir: path.join(projectRoot, "data", "results"),

        // Own-model CAPTCHA failure forensics (storage/captcha-failure-store.js).
        // Deliberately separate from failuresDir above (that one is generic
        // workflow-failure screenshots) and from the dataset dir below (that
        // one is gated training material) — this is always-on operational
        // evidence specifically about CAPTCHA prediction attempts.
        captchaFailuresDir: path.join(projectRoot, "data", "captcha-failures"),
        captchaFailuresImagesDir: path.join(projectRoot, "data", "captcha-failures", "images"),
        captchaFailuresLogFile: path.join(projectRoot, "data", "captcha-failures", "failures.jsonl"),

        datasetDir: path.join(projectRoot, "data", "dataset"),
        // Images are further partitioned by date at write time (see
        // storage/dataset-store.js), the same way failuresDir is —
        // this is just the common base.
        datasetImagesDir: path.join(projectRoot, "data", "dataset", "images"),
        // Append-only JSONL: one JSON record per line. Never read
        // and rewritten as a whole array — that's what we're
        // deliberately avoiding, since a crash mid-rewrite would
        // corrupt the entire dataset instead of just losing the
        // one in-flight line.
        datasetLabelsFile: path.join(projectRoot, "data", "dataset", "labels.jsonl"),
        // Tracks upload-dataset.js's own progress through labels.jsonl
        // (how many lines have already been shipped to S3, and any
        // batch that was in flight when the process last stopped).
        // Rewritten atomically (write-then-rename) on every update —
        // unlike labels.jsonl, this one genuinely needs to be rewritten
        // as a whole each time, so it gets the corruption-safety
        // pattern suited to that instead of append-only.
        datasetUploadStateFile: path.join(projectRoot, "data", "dataset", ".upload-state.json"),
        // Scratch space for zips while they're being built/uploaded —
        // cleaned up immediately after each upload, success or failure.
        datasetTmpDir: path.join(projectRoot, "data", "dataset", ".tmp"),

        logsDir: path.join(projectRoot, "logs"),
        logFile: path.join(projectRoot, "logs", "application.log")
    }
};
