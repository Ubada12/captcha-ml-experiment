/**
 * ============================================================
 * S3 BATCH DATASET UPLOAD
 * ============================================================
 *
 * A separate, standalone admin tool — like collect-dataset.js —
 * not part of the live pipeline. It zips whatever's accumulated
 * in data/dataset/ and ships it to S3 in fixed-size batches, so
 * a long unattended collection run (e.g. 10 hours on a rented
 * box) doesn't have to hold its entire dataset on local disk
 * until the very end.
 *
 * It NEVER touches labels.jsonl or the image files themselves —
 * only reads them. Collection (collect-dataset.js / the server)
 * and upload are fully independent; run this alongside a
 * collection run, or after it's finished, without coordinating
 * them beyond both pointing at the same data/dataset/ folder.
 *
 * WHY A SEPARATE STATE FILE, NOT JUST "HAS THIS LINE BEEN SEEN":
 * labels.jsonl is append-only NDJSON — new samples only ever get
 * added at the end, never inserted or reordered. That means "the
 * first N lines" is a stable, well-defined prefix forever, and
 * upload progress can be tracked as nothing more than a single
 * line-count cursor: data/dataset/.upload-state.json. Lines before
 * the cursor are already uploaded; everything after it is pending.
 *
 * CRASH SAFETY: the state file records a batch as "pending" BEFORE
 * the zip is built or the upload starts, and only moves it to
 * "completed" (advancing the cursor) after S3 confirms the PUT
 * succeeded. If this script dies mid-upload, the next run finds
 * that pending batch and *resumes* it — same line range, same S3
 * key — rather than starting a new one or losing track. Re-running
 * the same PutObject to the same key is safe (S3 just overwrites),
 * so a resumed batch can never create a duplicate object.
 *
 * NAMING CONVENTION:
 *   <S3_PREFIX>/batch-<0001>_<count>samples_<UTC-timestamp>.zip
 *   e.g. gst-captcha-dataset/batch-0001_1000samples_2026-09-14T10-00-00Z.zip
 *
 * Each zip contains:
 *   labels.jsonl        just that batch's lines (not the whole file)
 *   images/<date>/*.png  only the images those lines reference
 *
 * Usage:
 *   node scripts/upload-dataset.js                upload every full
 *                                                  batch currently
 *                                                  pending (batchSize
 *                                                  or more new lines)
 *   node scripts/upload-dataset.js --flush         also upload a
 *                                                  final, undersized
 *                                                  batch — use this
 *                                                  once, at the end
 *                                                  of a run
 *   node scripts/upload-dataset.js --watch                     loop
 *   node scripts/upload-dataset.js --watch --interval-ms=300000 forever,
 *                                                  checking for a new
 *                                                  full batch every
 *                                                  interval (default
 *                                                  5 min). Never
 *                                                  flushes on its own
 *                                                  — run --flush
 *                                                  separately once,
 *                                                  by hand, when the
 *                                                  collection run is
 *                                                  actually done.
 *
 * Requires in .env: S3_BUCKET (required), AWS_ACCESS_KEY_ID /
 * AWS_SECRET_ACCESS_KEY (required — read by the AWS SDK itself, not
 * this app's config), AWS_REGION / S3_PREFIX / DATASET_BATCH_SIZE
 * (all optional, see .env.example).
 */

require("dotenv").config();

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const archiver = require("archiver");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const config = require("../config/config");

// ------------------------------------------------------------
// CLI args — reuses collect-dataset.js's --key=value convention,
// plus two plain boolean flags this script also needs.
// ------------------------------------------------------------

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
const FLUSH = process.argv.includes("--flush");
const WATCH = process.argv.includes("--watch");
const WATCH_INTERVAL_MS = cliArgs["interval-ms"] !== undefined
    ? parseInt(cliArgs["interval-ms"], 10)
    : 5 * 60 * 1000;

// ------------------------------------------------------------
// Terminal output — same compact style as collect-dataset.js,
// deliberately not routed through logger/logger.js since this is
// an admin tool, not part of the request pipeline.
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

function formatBytes(bytes) {
    if (bytes < 1024) { return `${bytes} B`; }
    if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(ms) {
    return `${(ms / 1000).toFixed(1)}s`;
}

// ------------------------------------------------------------
// State file — atomic write-then-rename, since (unlike
// labels.jsonl) this one really is read, modified, and rewritten
// whole on every update.
// ------------------------------------------------------------

function defaultState() {
    return {
        uploadedLineCount: 0,
        nextBatchNumber: 1,
        pendingBatch: null,
        completedBatches: []
    };
}

async function loadState() {
    try {
        const raw = await fsp.readFile(config.paths.datasetUploadStateFile, "utf8");
        return JSON.parse(raw);
    } catch (error) {
        if (error.code === "ENOENT") {
            return defaultState();
        }
        throw new Error(`Upload state file exists but couldn't be read/parsed: ${error.message}`);
    }
}

async function saveState(state) {
    const target = config.paths.datasetUploadStateFile;
    const tmp = `${target}.tmp`;
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
    await fsp.rename(tmp, target); // atomic on POSIX — never a half-written state file
}

// ------------------------------------------------------------
// labels.jsonl reading
// ------------------------------------------------------------

async function readLabelLines() {
    let raw;
    try {
        raw = await fsp.readFile(config.paths.datasetLabelsFile, "utf8");
    } catch (error) {
        if (error.code === "ENOENT") { return []; }
        throw error;
    }
    return raw.split("\n").filter(l => l.trim().length > 0);
}

function batchKey(batchNumber, count) {
    const paddedNumber = String(batchNumber).padStart(4, "0");
    const ts = new Date().toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z");
    const filename = `batch-${paddedNumber}_${count}samples_${ts}.zip`;
    return `${config.s3.prefix}/${filename}`;
}

// ------------------------------------------------------------
// Zip + upload one batch
// ------------------------------------------------------------

async function buildZip(lines, zipPath) {
    await fsp.mkdir(path.dirname(zipPath), { recursive: true });

    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(zipPath);
        const archive = archiver("zip", { zlib: { level: 9 } });

        let settled = false;
        const fail = (err) => {
            if (settled) { return; }
            settled = true;
            reject(err);
        };

        output.on("close", () => {
            if (settled) { return; }
            settled = true;
            resolve(archive.pointer());
        });
        archive.on("warning", (err) => { line(COLOR.yellow, "!!", `archiver warning: ${err.message}`); });
        archive.on("error", fail);
        output.on("error", fail);

        archive.pipe(output);

        // Only this batch's lines go in — not the whole labels.jsonl.
        archive.append(lines.join("\n") + "\n", { name: "labels.jsonl" });

        let missingImages = 0;
        for (const rawLine of lines) {
            let record;
            try {
                record = JSON.parse(rawLine);
            } catch {
                continue; // a corrupt line shouldn't abort the whole batch
            }
            if (!record.image) { continue; }
            const absoluteImagePath = path.join(config.paths.datasetDir, record.image);
            if (fs.existsSync(absoluteImagePath)) {
                archive.file(absoluteImagePath, { name: record.image });
            } else {
                missingImages++;
            }
        }

        if (missingImages > 0) {
            line(COLOR.yellow, "!!", `${missingImages} image(s) referenced in labels.jsonl were missing on disk — zipped without them.`);
        }

        archive.finalize();
    });
}

async function uploadZip(s3Client, zipPath, key) {
    const sizeBytes = (await fsp.stat(zipPath)).size;
    const body = fs.createReadStream(zipPath);
    await s3Client.send(new PutObjectCommand({
        Bucket: config.s3.bucket,
        Key: key,
        Body: body,
        ContentType: "application/zip"
    }));
    return sizeBytes;
}

/**
 * Processes exactly one batch (builds zip, uploads, updates state),
 * whether it's a brand-new batch or a resumed pending one. Returns
 * true if a batch was processed, false if there was nothing to do.
 */
async function processOneBatch(s3Client, { flush }) {
    const state = await loadState();

    let batch = state.pendingBatch;

    if (batch) {
        line(COLOR.yellow, "!!", `Resuming pending batch #${batch.batchNumber} (${batch.count} samples) — an earlier run didn't finish it.`);
    } else {
        const allLines = await readLabelLines();
        const pendingCount = allLines.length - state.uploadedLineCount;

        if (pendingCount <= 0) {
            return false;
        }
        if (pendingCount < config.s3.batchSize && !flush) {
            line(COLOR.dim, "  ", `${pendingCount} new sample(s) pending — waiting for ${config.s3.batchSize} before uploading (or run with --flush).`);
            return false;
        }

        const count = flush ? pendingCount : config.s3.batchSize;
        const startLine = state.uploadedLineCount;
        const endLine = startLine + count;
        const batchNumber = state.nextBatchNumber;
        const key = batchKey(batchNumber, count);

        batch = { batchNumber, startLine, endLine, count, key, startedAt: new Date().toISOString() };
        state.pendingBatch = batch;
        await saveState(state); // pending is durable BEFORE any zip/upload work starts
    }

    const allLines = await readLabelLines();
    const batchLines = allLines.slice(batch.startLine, batch.endLine);

    if (batchLines.length !== batch.count) {
        // labels.jsonl is append-only, so this should never happen unless
        // it was hand-edited. Fail loudly rather than upload a mismatched batch.
        throw new Error(
            `Pending batch #${batch.batchNumber} expects lines ${batch.startLine}-${batch.endLine} ` +
            `(${batch.count} lines) but labels.jsonl currently has ${allLines.length} total lines. ` +
            "labels.jsonl may have been modified — resolve this manually before retrying."
        );
    }

    const zipPath = path.join(config.paths.datasetTmpDir, `${path.basename(batch.key)}`);

    line(COLOR.cyan, "→", `Batch #${batch.batchNumber}: zipping ${batch.count} samples (lines ${batch.startLine}-${batch.endLine})...`);
    const startedAt = Date.now();

    try {
        const zippedBytes = await buildZip(batchLines, zipPath);
        line(COLOR.dim, "  ", `Zip built: ${formatBytes(zippedBytes)} in ${formatDuration(Date.now() - startedAt)}.`);

        line(COLOR.cyan, "→", `Uploading to s3://${config.s3.bucket}/${batch.key} ...`);
        const uploadStartedAt = Date.now();
        const sizeBytes = await uploadZip(s3Client, zipPath, batch.key);
        line(COLOR.green, "✔", `Uploaded ${formatBytes(sizeBytes)} in ${formatDuration(Date.now() - uploadStartedAt)}.`);

        const freshState = await loadState();
        freshState.uploadedLineCount = batch.endLine;
        freshState.nextBatchNumber = batch.batchNumber + 1;
        freshState.pendingBatch = null;
        freshState.completedBatches.push({
            batchNumber: batch.batchNumber,
            startLine: batch.startLine,
            endLine: batch.endLine,
            count: batch.count,
            key: batch.key,
            sizeBytes,
            uploadedAt: new Date().toISOString()
        });
        await saveState(freshState);

        line(COLOR.bold, "==", `Batch #${batch.batchNumber} complete. Total uploaded so far: ${freshState.uploadedLineCount} samples across ${freshState.completedBatches.length} batch(es).`);
        return true;

    } finally {
        await fsp.rm(zipPath, { force: true });
    }
}

async function processAllPendingBatches(s3Client, { flush }) {
    let processedAny = false;
    // Loop in case a lot of pending lines have piled up (e.g. resuming
    // after being offline a while) — upload every full batch available
    // in one run, not just one.
    while (await processOneBatch(s3Client, { flush })) {
        processedAny = true;
    }
    return processedAny;
}

async function main() {
    if (!config.s3.bucket) {
        line(COLOR.red, "✖", "S3_BUCKET is not set in .env. Nothing to do.");
        process.exitCode = 1;
        return;
    }

    const s3Client = new S3Client({ region: config.s3.region });

    console.log("");
    line(COLOR.bold, "==", `Dataset upload — bucket s3://${config.s3.bucket}/${config.s3.prefix}, batch size ${config.s3.batchSize}`);
    if (FLUSH) { line(COLOR.yellow, "!!", "Flushing: a final undersized batch will be uploaded if one is pending."); }
    console.log("");

    if (WATCH) {
        line(COLOR.dim, "  ", `Watch mode: checking every ${formatDuration(WATCH_INTERVAL_MS)}. Ctrl+C to stop. (--flush is ignored in --watch — run it separately once, by hand.)`);
        // eslint-disable-next-line no-constant-condition
        while (true) {
            try {
                const did = await processAllPendingBatches(s3Client, { flush: false });
                if (!did) { line(COLOR.dim, "  ", "Nothing new to upload this check."); }
            } catch (error) {
                line(COLOR.red, "✖", `Error during scheduled check: ${error.message}`);
            }
            await sleep(WATCH_INTERVAL_MS);
        }
    }

    try {
        const did = await processAllPendingBatches(s3Client, { flush: FLUSH });
        if (!did) {
            line(COLOR.dim, "  ", "Nothing to upload right now.");
        }
    } catch (error) {
        line(COLOR.red, "✖", error.message);
        process.exitCode = 1;
    }
}

main();
