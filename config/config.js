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
    // 2Captcha solver settings
    // ------------------------------------------------------
    captchaSolver: {
        apiKey: process.env.TWOCAPTCHA_API_KEY,
        expectedLength: 6,
        maxPollAttempts: 24,
        pollIntervalMs: 5000
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
