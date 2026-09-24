# Replacing 2Captcha with the Own-Trained Model — Implementation Plan (v2)

**Decisions locked in from discussion:**
1. On a confirmed-wrong prediction: recapture a fresh CAPTCHA, retry our own model up to N times, then fall back to 2Captcha.
2. The portal issues a new CAPTCHA image after a wrong submission (confirmed) — retries always work against a freshly captured image, never the same one.
3. The new solver module gets a single, honest function (`solveCaptcha`) instead of preserving 2Captcha's task/poll shape.
4. **New this revision:** the serving code is its own, purpose-built project folder — it does not live in or import from `data/dataset/ml/`. That folder stays exactly what it's always been: training/experimentation scripts and reference checkpoints, useful for re-training later, not something the live scraper depends on.
5. **New this revision:** config gets explicit, named knobs (retry count, thresholds, fallback toggle) rather than values buried in code.
6. **New this revision:** every own-model CAPTCHA attempt that isn't a clean first-try success gets a full forensic record preserved on disk — image, prediction, confidence breakdown, and what happened — so nothing fails silently and everything is retrievable for later debugging.
7. **New this revision:** terminal logging follows the existing pino/pino-pretty colorized style throughout, at a professional/operational level of detail — status and outcomes, not raw predicted digits (same discipline `solver.js` already applies to 2Captcha's answer).

This plan still doesn't touch any file — it's the blueprint. Nothing gets implemented until you say go.

---

## 1. Project layout — a new, separate service folder

`data/dataset/ml/` remains untouched: `model.py`, `dataset.py`, `train.py`, `inference.py`, `best_model.pt` stay exactly as they are, for training and offline evaluation. Nothing under the live pipeline imports from this folder.

A new top-level folder, sibling to `captcha/`, `pipeline/`, `config/`, etc., holds the actual serving code:

```
scrapper/
├── ml-service/                      ← NEW — purpose-built for serving, not training
│   ├── serve.py                       FastAPI app: /predict, /health
│   ├── model.py                       CaptchaCRNN architecture — a clean copy,
│   │                                   trimmed to inference-only (no training-
│   │                                   related code, no dataset imports)
│   ├── preprocess.py                  The exact eval-time transform (resize
│   │                                   182x50, ImageNet normalize, no
│   │                                   augmentation) applied to an incoming
│   │                                   base64 image
│   ├── decode.py                      CTC greedy decode + per-character
│   │                                   confidence scoring
│   ├── checkpoint/
│   │   └── best_model.pt              The DEPLOYED checkpoint — a copy placed
│   │                                   here deliberately, not referenced from
│   │                                   data/dataset/ml/. Promoting a newly
│   │                                   trained checkpoint later means copying
│   │                                   the new file here, an explicit,
│   │                                   reviewable step, not an automatic link.
│   └── requirements.txt               torch, torchvision, fastapi, uvicorn, pillow
│
├── captcha/
│   ├── solver.js                      2Captcha — unchanged, kept as fallback
│   ├── own-model-solver.js            NEW — calls ml-service over HTTP
│   ├── capture.js                     unchanged
│   └── validator.js                   unchanged
│
├── storage/
│   ├── captcha-failure-store.js       NEW — forensic record of every non-clean attempt
│   ├── dataset-store.js               existing, extended (see §9)
│   ├── failure-store.js               unchanged (generic workflow failures)
│   └── captcha-store.js               unchanged (debug copy of every capture)
│
└── (pipeline/, taxpayer/, config/ — modified, not replaced, see below)
```

Why a real copy of the checkpoint rather than pointing at the training folder: it makes "what is currently live" an explicit, single, reviewable file, independent of whatever training experiment is in progress in `data/dataset/ml/runs/...` at any given time. Promoting a better checkpoint later is a deliberate copy-and-restart-the-service action, not something that silently changes behavior because a training run touched a shared path.

`ml-service` runs as its own process (`python serve.py` or `uvicorn serve:app`), independently of `node server.js` — two processes on the same machine, same relationship 2Captcha already has (an external HTTP dependency `captcha/` talks to), just local instead of remote.

---

## 2. Confidence scoring (`ml-service/decode.py`)

Unchanged from the previous draft, now living in its own module instead of a copy of `inference.py`:

Mirrors the greedy CTC decode loop (argmax per timestep → skip blanks → collapse consecutive repeats), additionally recording the softmax probability of the winning class at the exact timestep each output character gets accepted. Two numbers reported per prediction:

- **`avg_confidence`** — mean across decoded characters.
- **`min_confidence`** — the single weakest character. This is the more important one: a single wrong digit fails the whole lookup, so five confident characters and one shaky one should read as low confidence overall, not high.

If the decoded length isn't exactly 6, that's an automatic reject regardless of confidence (the `633367→63367` collapse failure mode from the Experiment 6 report).

**Threshold — still a placeholder.** `avg >= 0.90` and `min >= 0.60`, both configurable (§8). Real numbers need the full labeled dataset scored end-to-end, which depends on you having that data available again (Kaggle download, or wherever it lives now) — flagged again at the end of this doc.

---

## 3. `captcha/own-model-solver.js`

```js
async function solveCaptcha(base64Image) {
  // POST { image_base64 } to config.ownModelSolver.serviceUrl + "/predict"
  // returns { text, lengthOk, avgConfidence, minConfidence, perCharConfidence, confident }
}
module.exports = { solveCaptcha };
```

`solver.js` (2Captcha) stays exactly as-is, used only as the fallback path.

---

## 4. Three-layer verification stack (unchanged)

| Layer | Checks | When | Status |
|---|---|---|---|
| 1. Format | Exactly 6 digits | Pre-submit, free | Existing `validator.js`, unchanged |
| 2. Confidence | Model's own uncertainty (avg + min) | Pre-submit, free | New — `ml-service` computes it, `own-model-solver.js` applies the threshold |
| 3. Portal response | `errorCode: SWEB_9000` + `.err` DOM text | Post-submit, ground truth | New — extend `taxpayer.js` |

Layers 1–2 are heuristics; layer 3 is the only certain one, which is why the retry loop is anchored to it.

---

## 5. `taxpayer.js` — typed error instead of message-string matching

```js
const KNOWN_PORTAL_ERROR_CODES = {
    SWEB_9035: "The GSTIN/UIN entered is invalid.",
    SWEB_9000: "The CAPTCHA entered is invalid.",   // confirmed from logs/application.log
};

const error = new Error(...);
error.isCaptchaRejection = (errorCode === "SWEB_9000");
throw error;
```

`pipeline.js` branches on `error.isCaptchaRejection`, not on parsing message text.

---

## 6. `pipeline.js` — the retry loop

```
attempt = 0
solverUsed = "own-model"

loop:
    attempt += 1
    captcha = captureCaptcha(page)                       # fresh capture every attempt
    prediction = ownModelSolver.solveCaptcha(captcha.base64Image)

    if not prediction.lengthOk or not prediction.confident:
        recordCaptchaFailure({                            # §9 — always, never skipped
            stage: "pre-submit",
            reason: !prediction.lengthOk ? "malformed-length" : "low-confidence",
            image: captcha.base64Image,
            prediction, attempt, gstin
        })
        logger.warn(`Own-model attempt ${attempt}/${maxOwnModelAttempts + 1} ` +
                     `rejected pre-submit (reason logged, confidence withheld from terminal).`)

        if attempt > maxOwnModelAttempts:
            solverUsed = "2captcha"
            solution = solver.js's createCaptchaTask + pollCaptchaResult   # existing, unchanged
            logger.warn("Own model exhausted retries — falling back to 2Captcha.")
            break
        else:
            continue                                       # recapture, try again

    validateSolution(prediction.text)                       # cheap format re-check
    solution = prediction.text
    break

enterCaptchaSolution(page, solution)

try:
    result = submitAndIntercept(page)
    if solverUsed == "own-model":
        logger.success(`CAPTCHA solved by own model on attempt ${attempt}.`)
    saveDatasetSample({ image, label: solution, solver: solverUsed, portalConfirmed: "correct", ... })
    return result

catch (error):
    if error.isCaptchaRejection and solverUsed === "own-model" and attempt <= maxOwnModelAttempts:
        recordCaptchaFailure({ stage: "post-submit", reason: "portal-rejected",
                                image, prediction: solution, attempt, gstin,
                                errorCode: "SWEB_9000" })
        saveDatasetSample({ image, label: solution, solver: "own-model", portalConfirmed: "wrong", ... })
        logger.warn(`Own-model prediction rejected by portal on attempt ${attempt} — retrying.`)
        # loop back: recapture, retry own model
    else if error.isCaptchaRejection and solverUsed === "2captcha":
        recordCaptchaFailure({ stage: "post-submit", reason: "2captcha-also-wrong", ... })
        logger.error("2Captcha's own answer was rejected by the portal — no further automatic recovery.")
        throw error
    else:
        throw error   # unrelated failure (bad GSTIN, timeout) — unchanged
```

Every branch that isn't a clean success calls `recordCaptchaFailure` — nothing is allowed to fail quietly.

---

## 7. Logging standard — professional terminal, full forensic file

Two different audiences, two different levels of detail, matching the discipline `solver.js` already applies to the 2Captcha answer (never logs the raw text, only "a valid N-digit solution was received"):

**Terminal / `logs/application.log` (pino, colorized, existing levels)** — status and flow, never the raw predicted digits:
```
logger.info(`Own-model CAPTCHA attempt ${attempt}/${max + 1}...`)
logger.debug(`Confidence check: avg/min thresholds applied (values withheld from log; see failure record if rejected).`)
logger.warn(`Attempt ${attempt} rejected: ${reason}. Retrying with a fresh CAPTCHA.`)
logger.success(`CAPTCHA solved by own model on attempt ${attempt}.`)
logger.error(`Own model and 2Captcha fallback both failed for GSTIN ${gstin}.`)
```
This is what you watch scroll by in a `screen` session — clean, colorized, tells you what's happening and how often retries/fallbacks are firing, without spilling a CAPTCHA answer into a log file.

**`storage/captcha-failure-store.js` (new, disk, always-on)** — the full forensic detail, for going back and actually fixing a specific failure later:
```
data/captcha-failures/
  failures.jsonl                      append-only, one line per non-clean attempt
  images/<YYYY-MM-DD>/<id>.png        the exact image that produced that attempt
```
Each `failures.jsonl` line:
```json
{
  "id": "captchafail_1790..._1",
  "gstin": "27AOHPA6448R1ZC",
  "image": "images/2026-09-24/captchafail_....png",
  "stage": "pre-submit | post-submit",
  "reason": "malformed-length | low-confidence | portal-rejected | 2captcha-also-wrong",
  "predictedText": "358025",
  "avgConfidence": 0.71,
  "minConfidence": 0.31,
  "perCharConfidence": [0.99, 0.95, 0.94, 0.98, 0.31, 0.81],
  "attemptNumber": 2,
  "solver": "own-model",
  "portalErrorCode": "SWEB_9000",
  "createdAt": "2026-09-24T12:03:11.482Z"
}
```
Same append-only-NDJSON + date-partitioned-images pattern `dataset-store.js` and `failure-store.js` already use, so it's consistent with the rest of the project and crash-safe the same way. Never throws — a failure to write this record must never mask the real workflow error, exactly like every other `storage/` module.

This is what makes failures *retrievable and fixable* rather than just visible in a scrolling log: every rejected attempt has its exact image and full confidence breakdown sitting on disk, ready to review in bulk later (which characters are we actually weak on, which GSTINs needed a fallback, etc.) without having to reproduce anything.

---

## 8. `config/config.js` — explicit knobs

```js
ownModelSolver: {
    serviceUrl: process.env.OWN_MODEL_SERVICE_URL || "http://127.0.0.1:8001",
    requestTimeoutMs: parseInt(process.env.OWN_MODEL_REQUEST_TIMEOUT_MS, 10) || 5000,

    // How many times to retry OUR OWN model (on a fresh recaptured image)
    // before giving up on it for this lookup.
    maxRetries: parseInt(process.env.OWN_MODEL_MAX_RETRIES, 10) || 2,

    confidenceThreshold: {
        avg: parseFloat(process.env.OWN_MODEL_AVG_CONFIDENCE_THRESHOLD) || 0.90,
        min: parseFloat(process.env.OWN_MODEL_MIN_CONFIDENCE_THRESHOLD) || 0.60,
    },

    // Master switch — if false, own-model-solver.js is never called at all
    // and every lookup goes straight to 2Captcha (instant rollback lever).
    enabled: process.env.OWN_MODEL_SOLVER_ENABLED !== "false",

    // Whether exhausting maxRetries should fall back to 2Captcha, or just
    // fail the lookup outright. Kept separate from `enabled` so "always use
    // our model, never spend a 2Captcha credit" is also an option.
    fallbackTo2CaptchaEnabled: process.env.OWN_MODEL_FALLBACK_ENABLED !== "false",
},
```

`captchaSolver` (2Captcha) config is untouched — still required whenever the fallback path can fire.

---

## 9. `storage/dataset-store.js` — extended, not replaced

Same idea as the previous draft: every own-model attempt (not just fallback cases) gets logged with its eventual portal-confirmed outcome, since the portal now gives a free, authoritative label for every attempt.

```js
{
    id, image, label, length, numeric, sha256, source, solver, taskId, createdAt,
    solverConfidence: { avg, min } | null,        // null for 2captcha-sourced samples
    portalConfirmed: "correct" | "wrong",
    attemptNumber: 1
}
```

This is the training-data side (gated by `DATASET_COLLECTION_ENABLED`, same as today). `captcha-failure-store.js` (§7) is the always-on operational/debugging side. They serve different purposes and are allowed to overlap in what they capture — one is "data to retrain on," the other is "evidence to debug an incident."

---

## 10. Testing plan before this touches real traffic

1. **`ml-service` standalone** — start it, `curl` a few known-labeled images through `/predict`, confirm predicted text matches and confidence numbers look sane.
2. **`own-model-solver.js` standalone** — call `solveCaptcha` against the running service, no Puppeteer involved.
3. **`captcha-failure-store.js` standalone** — force a fake rejection record through it, confirm the JSONL line and image both land correctly and the module never throws even if the disk write fails.
4. **One live end-to-end lookup**, own-model path only, watched manually.
5. **One deliberate wrong-CAPTCHA live test** — force a wrong string once, confirm `SWEB_9000` + `.err` text appear as expected and the page does reload with a fresh CAPTCHA image.
6. Only after 1–5 pass: enable the retry loop for real traffic.

---

## Open item carried forward

Confidence thresholds (§2, §8) are still placeholders. Calibrating them properly needs the full labeled dataset scored end-to-end (correct vs. incorrect confidence distributions) — worth doing once you've got that dataset back in hand (Kaggle download or otherwise), before these ship with real numbers instead of guesses.
