# GST Portal Automation

Puppeteer-based automation for `xyz.com`'s GST lookup form: fills in a GSTIN,
captures the CAPTCHA, solves it via 2Captcha, submits the form, and
intercepts the `taxpayerDetails` API response.

This is the Level 2 ("engineer the application") refactor of the original
single-file `scrapper.js` prototype into a modular project. `scrapper.js` is
left untouched in the project root as a known-working reference — nothing
here has been run against the live site yet, since the site is currently
down. Review the code before running it for the first time.

## Project layout

```
main.js                 CLI entry point — one-shot run for the single
                         GSTIN in config/config.js. Thin: just calls
                         pipeline/pipeline.js.

server.js               HTTP entry point (node server.js /
                         npm run server). Starts the API defined in
                         server/app.js.

pipeline/
  pipeline.js            The actual orchestrated workflow (launch ->
                          navigate -> GSTIN -> CAPTCHA -> solve ->
                          validate -> submit/intercept -> store ->
                          cleanup). Both main.js and server.js call
                          this — one implementation, two entry points.

server/
  app.js                 Express routes: GET /health, POST /api/taxpayer,
                          GET /api/taxpayer/:gstin/cached.
  auth.js                 X-API-Key check guarding every /api/* route.
  queue.js                Serializes lookup jobs so only one browser/
                           2Captcha run is ever in flight at once.

utils/
  gstin.js                GSTIN format validation (shape only, not
                           whether it's actually registered).

config/
  config.js              All non-secret configuration: URLs, selectors,
                          timeouts, solver settings, filesystem paths,
                          and where the API key list gets read from.

logger/
  logger.js               Pino-based logger. Pretty/colorized output to
                           the terminal, structured NDJSON to
                           logs/application.log. Custom "success" level
                           between info and warn.

browser/
  browser.js               Puppeteer lifecycle: launch, new page,
                            navigate, cleanup.

captcha/
  capture.js                Locates the CAPTCHA image on the page and
                             screenshots it as base64.
  solver.js                  2Captcha integration: create task, poll
                              for result. The only module that speaks
                              2Captcha's HTTP contract.
  validator.js                Confirms a solver's output is exactly
                               N numeric digits before it's used.

taxpayer/
  taxpayer.js                 GSTIN entry, CAPTCHA entry, submit, and
                               interception of the taxpayerDetails API
                               response.

storage/
  captcha-store.js             Saves a raw debug copy of every captured
                                CAPTCHA image (data/captchas/).
  dataset-store.js              Saves verified (image, label) pairs for
                                 future model training (data/dataset/),
                                 as append-only JSONL with date-
                                 partitioned images. Disabled by default.
  failure-store.js               Saves a full-page screenshot on
                                  workflow failure, organized by date
                                  (data/failures/<YYYY-MM-DD>/).
  results-store.js                Saves successful lookup results as
                                   JSON (data/results/) and reads the
                                   latest one back for the /cached
                                   endpoint.

scripts/
  collect-dataset.js                  Bulk-runs POST /api/taxpayer to
                                       rack up successful CAPTCHA
                                       solves for the dataset.
  upload-dataset.js                    Zips completed batches of
                                        data/dataset/ and uploads
                                        them to S3. See "S3 batch
                                        upload" below.

data/                              Created at runtime, gitignored.
  captchas/
  failures/<date>/
  dataset/images/<date>/, dataset/labels.jsonl,
    dataset/.upload-state.json (upload-dataset.js's own progress
    cursor), dataset/.tmp/ (scratch space for in-progress zips)
  results/

logs/
  application.log                  Created at runtime, gitignored.

.env                                Secrets only (TWOCAPTCHA_API_KEY).
.env.example                        Template — copy to .env and fill in.
```

## Setup

```
npm install
cp .env.example .env   # fill in TWOCAPTCHA_API_KEY and API_KEYS
node main.js            # one-shot CLI run
node server.js           # or: npm run server — start the API instead
```

`axios`, `pino`, `pino-pretty`, and `express` were added to
`package.json` — the original `scrapper.js` used `axios` without it
being listed as a dependency, so run `npm install` before the first run.

The API server refuses every request with a 503 until `API_KEYS` is set
in `.env` — see Authentication below.

## Running on Linux (e.g. a long unattended collection run)

This runs on Ubuntu/Linux with no code changes needed — headless
launch is now the default (see `HEADLESS` above) specifically so this
works on a server/VM with no display, not just a desktop with one.
A few things matter for a real run there, though:

- **`npm install` fresh on that machine.** Never copy `node_modules`
  over from Windows (or any other machine) — Puppeteer's bundled
  Chromium binary is platform-specific. `node_modules/` is gitignored
  for exactly this reason; get the source there (git clone, or `scp`
  the folder minus `node_modules`) and install there.
- **Running inside a container (Docker, Vast.ai, etc.), not just a
  bare VM.** Chrome refuses to launch as root without
  `--no-sandbox` (containers almost always run as root), and a
  container's default 64MB `/dev/shm` is easy for headless Chrome
  to outgrow mid-run. Both are already handled —
  `browser.launchOptions.args` in `config/config.js` always
  includes `--no-sandbox`, `--disable-setuid-sandbox`, and
  `--disable-dev-shm-usage` — so no extra setup is needed here,
  this is just why they're there.
- **Missing shared libraries on a minimal Ubuntu install.** A bare
  server image often lacks the libraries headless Chrome needs to
  launch at all — you'll see an error naming a missing `.so` file if
  so. The official Puppeteer-documented dependency list for
  Debian/Ubuntu:
  ```
  sudo apt-get install -y ca-certificates fonts-liberation libasound2 \
    libatk-bridge2.0-0 libatk1.0-0 libc6 libcairo2 libcups2 \
    libdbus-1-3 libexpat1 libfontconfig1 libgbm1 libgcc1 \
    libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 \
    libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 \
    libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 \
    libxrandr2 libxrender1 libxss1 libxtst6 lsb-release wget xdg-utils
  ```
  A couple of these package names changed on newer Ubuntu releases
  (e.g. `libasound2` → `libasound2t64`, `libgcc1` → `libgcc-s1` on
  24.04) — if `apt-get` says a package doesn't exist, search for its
  renamed equivalent rather than dropping it.
- **Keep the process alive for the full run.** If you're SSH'd in
  (including to a remote VM), a `node scripts/collect-dataset.js` you
  just run in that shell dies the moment the connection drops. Run it
  inside `tmux` or `screen` (`tmux new -s collect`, run the script,
  detach with `Ctrl+B D`, reattach later with `tmux attach -t
  collect`), or use `pm2` the same way the API server would run in
  production. Sitting at the machine directly with a stable terminal
  is fine as-is.
- **Node version.** Make sure Node itself is reasonably current (18+ —
  `scripts/collect-dataset.js` uses the built-in `fetch`, and Puppeteer
  25.x expects a modern Node regardless). `nvm` or NodeSource's setup
  script both work fine for getting one installed.

## Bulk dataset collection

`scripts/collect-dataset.js` is an admin tool, not part of the app
itself: it repeatedly calls your own running `POST /api/taxpayer` with
a real GSTIN, purely to rack up successful CAPTCHA solves for the
Level 3 dataset. It's a plain HTTP client — same as Postman was —
so it never touches Puppeteer, 2Captcha, or the dataset store
directly; the server does all of that exactly as it would for any
other caller.

```
npm run server                       # in one terminal
npm run collect-dataset              # in another — defaults to 100
npm run collect-dataset -- --count=25 --delay-ms=5000
```

**Before running it:** the server must have been *started* with
`DATASET_COLLECTION_ENABLED=true` in `.env` — env vars are read once
at startup, not live, so if the server's already running without it,
add it to `.env` and restart `node server.js` first. This script has
no way to check that from the outside; skip it and every lookup below
will still succeed, but nothing lands in `data/dataset/labels.jsonl`.

It targets a number of *successes*, not attempts — it keeps going past
occasional failures until it hits the count, and aborts early (default:
after 5 failures in a row) rather than quietly burning through 2Captcha
credits on a run that's actually broken (wrong API key, server down,
etc.). Each attempt prints its own progress line plus the full response
body, and it prints a done/succeeded/failed/left tally after every
single request. Worth knowing going in: 100 successes means 100 real
2Captcha charges, and each lookup can take anywhere from ~15 seconds to
~2 minutes, so a full run can easily take over an hour.

## S3 batch upload

`scripts/upload-dataset.js` is another standalone admin tool, like
`collect-dataset.js` — it never touches Puppeteer, 2Captcha, or the
live pipeline. It only reads `data/dataset/labels.jsonl` and the
image files it references, zips whatever hasn't been uploaded yet,
and ships it to S3, so a long collection run doesn't have to keep
its entire dataset sitting on local disk until the very end.

```
npm run upload-dataset                              # upload every full batch pending
npm run upload-dataset -- --flush                   # + a final undersized batch (run once, at the end)
npm run upload-dataset -- --watch                   # loop forever, checking every 5 min
npm run upload-dataset -- --watch --interval-ms=600000
```

Requires in `.env`: `S3_BUCKET`, `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY` (the last two are read by the AWS SDK's own
default provider chain, not this app — see `.env.example`).
`AWS_REGION`, `S3_PREFIX`, and `DATASET_BATCH_SIZE` are optional.

How batching works, since `labels.jsonl` is a live, growing,
append-only file:

- `data/dataset/.upload-state.json` tracks a single cursor —
  how many lines from the top of `labels.jsonl` have already been
  uploaded. Because new samples only ever get *appended*, "the
  first N lines" never changes retroactively, so a line-count
  cursor is all the state that's needed.
- Once `DATASET_BATCH_SIZE` (default 1000) new lines have piled up,
  the next batch of exactly that many lines is zipped (just those
  lines' `labels.jsonl` entries + the images they reference, not
  the whole dataset) and uploaded to
  `<S3_PREFIX>/batch-0001_1000samples_<UTC-timestamp>.zip`, then the
  cursor advances.
- **Crash-safe by construction**: the batch is recorded as
  "pending" in the state file *before* zipping/uploading starts, and
  only marked "completed" (cursor advanced) after S3 confirms the
  upload. If the process dies mid-upload, the next run finds that
  pending batch and re-uploads that exact same line range to that
  exact same S3 key — never a new one — so nothing is duplicated or
  lost.
- Run `--watch` in its own terminal/tmux pane alongside a long
  collection run to upload each batch as it crosses the threshold,
  automatically. It deliberately never flushes on its own — run
  `--flush` once, by hand, after the collection run actually
  finishes, to ship the last partial batch.

## API

Start with `node server.js` (or `npm run server`). Default port `4000`,
override with `PORT` in `.env`.

### Authentication

Every route under `/api/*` requires a valid key in the `X-API-Key`
header. Keys are a comma-separated list in `.env`:

```
API_KEYS=some-long-random-string,another-clients-key
```

Generate one with:

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`GET /health` is the only unauthenticated route (so uptime checks don't
need a key). A request to `/api/*` with a missing or wrong key gets
`401`; if `API_KEYS` isn't configured at all, every `/api/*` request
gets `503` instead of silently being let through.

CORS is deliberately not configured — the API key, not the calling
origin, is what authorizes a request. One technical note worth knowing:
CORS only ever applies to browser JavaScript making a cross-origin
`fetch`/`XHR` call — a server calling this API (e.g. Hi Life Nx's own
backend calling it directly) is never affected by CORS either way, key
or no key. It would only matter if a browser running on some other
domain tried to call this API directly from client-side JS; if that
ever happens, CORS headers would need to be added back in `server/app.js`.

### Endpoints

- `POST /api/taxpayer` — body `{ "gstin": "27AOHPA6448R1ZC" }`. Runs a
  real lookup: launches a browser, solves a real CAPTCHA via 2Captcha
  (a paid call), submits, intercepts `taxpayerDetails`. This is a
  `POST`, deliberately, not a `GET` — it has real side effects (cost,
  time, disk writes), so it shouldn't be something a cache or a crawler
  could trigger by accident. Concurrent requests are queued and served
  one at a time (`server/queue.js`) rather than launching multiple
  browsers at once. Can take up to a couple of minutes; the HTTP server
  timeout is set accordingly (`config.server.requestTimeoutMs`).
  Responds `400` on a malformed GSTIN (checked locally, before any
  browser/2Captcha cost is spent), `401`/`503` on a bad/missing/
  unconfigured API key, `502` if the portal lookup itself fails, `200`
  with the raw `taxpayerDetails` JSON on success.
- `GET /api/taxpayer/:gstin/cached` — returns the most recently stored
  result for that GSTIN straight from `data/results/`, no browser
  involved. `404` if nothing has been looked up for that GSTIN yet.
- `GET /health` — `{ status: "ok", queueLength: <n> }`. No API key
  required.

Example:

```
curl -X POST http://localhost:4000/api/taxpayer \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <one of the keys from API_KEYS>" \
  -d '{"gstin":"27AOHPA6448R1ZC"}'
```

Nothing here reshapes the taxpayer JSON — see the design note below.

## Design decisions carried over from the original script

- The taxpayerDetails response listener is armed with
  `page.waitForResponse(...)` **immediately before** clicking submit, so
  its timeout window doesn't start early while earlier `waitForSelector`
  calls are still running. See `taxpayer/submitAndIntercept`.
- The 2Captcha solution text is never logged — only "a valid N-digit
  solution was received" is logged. The verified answer is only ever
  written to the dataset store (when enabled), never to the general
  application log.
- Saving debug images, failure screenshots, and results are all
  best-effort: a storage failure logs a warning and returns `null`
  rather than throwing, so it can never mask or replace the real
  workflow error.
- The `taxpayerDetails` JSON handed back by `submitAndIntercept` is never
  reshaped, renamed, or filtered anywhere in the pipeline —
  `pipeline/pipeline.js` passes it straight to `results-store.js`, and
  `server/app.js` sends it straight to the HTTP response, exactly as the
  network response contained it.
- The live lookup endpoint is a `POST`, not a `GET`, because it isn't
  safe/idempotent in the HTTP sense — it costs a 2Captcha credit and
  writes files on every call. Reading back a previous result (`/cached`)
  has no side effects, so that one is a `GET`.
- Lookup jobs run through a single-lane queue (`server/queue.js`) rather
  than in parallel — one Chromium instance and one 2Captcha task at a
  time. This is a deliberate simplicity choice for a single-consumer
  internal API, not a hard limitation of the design.
- API key comparison in `server/auth.js` uses `crypto.timingSafeEqual`
  rather than `===`, and the middleware fails closed (rejects
  everything) if `API_KEYS` isn't set, rather than failing open.

## Roadmap (per our architecture discussion)

- **Level 1 — Done.** Working prototype: Puppeteer → CAPTCHA → 2Captcha →
  submit → API interception.
- **Level 2 — This refactor.** Modular structure, structured logging,
  centralized config, organized failure storage.
- **Level 3 — Data collection. Done.** Flip `DATASET_COLLECTION_ENABLED=true`
  in `.env` to start (leave it unset/`false` and the dataset store never
  touches the filesystem). Every successful solve then gets stored as
  `data/dataset/images/<YYYY-MM-DD>/<id>.png` plus one appended line in
  `data/dataset/labels.jsonl` — append-only NDJSON, not a JSON array that
  gets read and rewritten on every sample, so a crash mid-write can never
  corrupt the whole dataset, only cost the one in-flight line.
- **Level 3.5 — API server. Done.** `node server.js` / `npm run server`.
  `POST /api/taxpayer` runs a live lookup and returns exactly what
  `taxpayer/taxpayer.js` intercepted — no reshaping. `GET
  /api/taxpayer/:gstin/cached` serves the last stored result with no
  browser involved. Every `/api/*` route requires an `X-API-Key` header
  (see Authentication above). See the API section above for the full
  contract.
- **Level 4 — Dataset engineering.** Once there's enough data: check for
  duplicates (the `sha256` field in each label record makes this easy),
  invalid/corrupt samples, digit distribution, and do a train/val/test
  split.
- **Level 5 — Train our own CAPTCHA model.** Only after Level 4 looks
  healthy. Evaluate on whole-CAPTCHA accuracy (all 6 digits correct), not
  just per-character accuracy — a single wrong digit still fails the
  lookup.
- **Level 6 — Hybrid solver. Built, pending a live-portal validation
  pass.** Our own trained model (`ml-service/` — a standalone FastAPI
  process serving the CRNN+CTC checkpoint) is tried first via
  `captcha/own-model-solver.js`. A prediction is only trusted pre-submit
  if it's exactly 6 digits and clears both confidence thresholds
  (`config.ownModelSolver.confidenceThreshold`); otherwise — or if the
  portal itself rejects it (`SWEB_9000`, the confirmed wrong-CAPTCHA
  code) — a fresh CAPTCHA is recaptured and retried, up to
  `config.ownModelSolver.maxRetries` times, before falling back to
  2Captcha. Every attempt that isn't a clean first-try success is logged
  to `storage/captcha-failure-store.js` (image + full confidence
  breakdown), and successful/rejected own-model attempts feed back into
  the Level 3 dataset store with `portalConfirmed`/`solverConfidence` set
  accordingly. `pipeline/pipeline.js`'s `solveAndSubmitWithRetries` is
  where all of this is sequenced. See `ml-service/`'s own module
  docstrings for the serving side. **Still open:** the confidence
  thresholds are starting values, not calibrated ones, and this hasn't
  yet been run against the live portal end-to-end.

Levels 4-5 aren't built yet. The Level 3 dataset store is live and wired
into `pipeline/pipeline.js` (so both `main.js` and `server.js` feed it),
but stays a strict no-op until `DATASET_COLLECTION_ENABLED=true` is set,
per the "don't rush into training" plan.

## Not yet handled — worth deciding on before this leaves your machine

- **CORS is intentionally left unconfigured** — access is controlled by
  API key, not by calling origin, per how this is meant to be used
  (server-to-server, not directly from browser JS on another site). See
  the Authentication section above for the one case where that would
  need to change.
- **`browser.launchOptions.headless` now defaults to `true`**
  (`config/config.js`: `process.env.HEADLESS !== "false"`) — this used to
  default to `false` (carried over from the original `scrapper.js`,
  written for a one-off interactive run) but that's since been switched.
  Set `HEADLESS=false` in `.env` when you deliberately want to watch a
  run (e.g. while validating the own-model CAPTCHA path above); leave it
  unset for normal/server use.
- **No rate limiting.** A valid API key can currently fire lookups back
  to back through the queue, each one a paid 2Captcha call. Not an issue
  for one trusted client (Hi Life Nx); worth adding if more keys get
  handed out.
- **`ml-service/` is real code, not generated data.** Unlike `data/`
  (blanket-ignored), `ml-service/*.py` is tracked normally in git — only
  its own generated/large artifacts are excluded: `ml-service/checkpoint/`
  (the ~150MB `best_model.pt`, synced onto each machine directly rather
  than committed) and the usual Python venv/`__pycache__` patterns. See
  `.gitignore` for the exact rules.
