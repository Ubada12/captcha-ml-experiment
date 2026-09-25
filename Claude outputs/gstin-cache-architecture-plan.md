# GSTIN Result Cache — Architecture Plan (Review Draft)

Status: **proposal — not implemented yet**. This document is for review. Nothing in `scrapper/` has been changed to build this; the only completed, separate fix so far is the ml-service cold-start warm-up (see the note at the very end).

---

## 1. Why this document exists

Right now, `POST /api/taxpayer` always performs a full, live, browser-driven lookup — a CAPTCHA solve, a form submission, and up to "a couple of minutes" of wall-clock time (per the existing doc comment in `server/app.js`) — **every single time it's called**, regardless of whether that exact GSTIN was just looked up five minutes ago.

For this product's actual usage pattern — a textile company's invoicing, where a small set of client GSTINs repeats constantly and a business's registration details rarely change — that's expensive and wasteful in three concrete ways:

- Every repeat invoice for the same client re-pays the full CAPTCHA-solve cost (time, and money when it falls back to 2Captcha), for data that almost certainly hasn't changed.
- `data/results/` accumulates a new timestamped JSON file per lookup, forever, even when nothing new was learned — confirmed directly from your own screenshots and logs showing dozens of lookups of the same GSTIN piling up across a single day of testing.
- The one existing "cached" endpoint (`GET /api/taxpayer/:gstin/cached`) is a completely separate, disconnected path — nothing wires it into the main `POST` flow, so no caller benefit from it automatically.

This document lays out the current architecture in full, the specific gaps, and the proposed fix: a **disk-based, two-layer-gatekept cache**, keyed by GSTIN, that we designed and agreed on across several rounds of discussion (Redis was seriously considered and explicitly deferred — see §7 for why).

---

## 2. Current architecture (as it exists today)

### 2.1 Request path

```text
                          ┌───────────────────────────┐
                          │  server.js                │
                          │  (Express app.listen)     │
                          └─────────────┬─────────────┘
                                        │
                          ┌─────────────▼─────────────┐
                          │  server/app.js            │
                          │  createApp()              │
                          └─────────────┬─────────────┘
                                        │
                     ┌──────────────────┴──────────────────┐
                     │                                     │
     GET /api/taxpayer/:gstin/cached          POST /api/taxpayer   { gstin }
                     │                                     │
                     ▼                                     ▼
      storage/results-store.js               server/queue.js  runExclusive()
      getLatestResult(gstin)                                │
      (directory scan, no browser)                          ▼
                     │                        pipeline/pipeline.js  runLookup(gstin)
                     │                          │
                     │                          ├─ captcha/capture.js      (screenshot the CAPTCHA)
                     │                          ├─ captcha/own-model-solver.js → ml-service /predict
                     │                          ├─ captcha/solver.js       (2Captcha fallback)
                     │                          └─ intercept taxpayerDetails response
                     │                                      │
                     │                                      ▼
                     │                      storage/results-store.js  saveResult(gstin, data)
                     │                      → NEW file: data/results/<GSTIN>-<Date.now()>.json
                     │                                      │
                     ▼                                      ▼
                 response                               response
        (exact stored JSON, or 404)          (exact intercepted JSON, never reshaped)
```

### 2.2 Key files and what they actually do today

**`server/app.js`** — two independent routes:
- `GET /api/taxpayer/:gstin/cached` → `getLatestResult(gstin)`, no browser involved, 404 if nothing's ever been stored.
- `POST /api/taxpayer` → unconditionally `runExclusive(() => runLookup(gstin))`. No check of any kind against a previous result.

**`server/queue.js`** — `runExclusive(fn)`. A single, global, in-process, strictly-ordered promise chain. **Every** lookup job — regardless of GSTIN — runs one at a time, system-wide. Direct quote from its own doc comment:

> Running several Chromium instances and 2Captcha tasks concurrently on one machine is a resource and reliability risk we don't need to take on for a single-consumer internal API.

This detail matters a lot for the proposed design (§4.3) — it's the thing that lets us get correctness without Redis.

**`storage/results-store.js`** — `saveResult(gstin, data)` writes a brand-new file `<gstin>-<Date.now()>.json` on every successful lookup, forever (append-only growth, nothing ever pruned or overwritten). `getLatestResult(gstin)` scans the directory, filters by filename prefix, sorts lexicographically (works because `Date.now()` timestamps are fixed-width), and returns the most recent match. This is a genuinely useful **audit trail** — "what did this GSTIN look like on every date we ever checked it" — and nothing in this proposal removes it.

**`pipeline/pipeline.js`** — the actual browser-automation + CAPTCHA-solve + retry/fallback logic. Expensive: real browser, real CAPTCHA, real portal round-trip.

### 2.3 What's lagging (the concrete gaps)

1. **No cache-awareness in the write path.** `POST /api/taxpayer` has zero logic branching on "do we already have this." It always does the expensive thing.
2. **No freshness concept anywhere.** `getLatestResult` returns whatever's most recent, however old — there's no way to ask "is this recent enough to trust," and nothing computes an age.
3. **The two endpoints don't talk to each other.** A caller has to manually know to hit `/cached` first and fall back to `POST` themselves. Nothing does this automatically, so in practice nobody does, and every call goes to `POST`.
4. **Unbounded duplicate files for a GSTIN that hasn't changed.** Direct consequence of #1 — confirmed in your own `data/results/` screenshot.

*(A fifth issue — a one-time ml-service cold-start timeout getting misfiled as a solver failure — was diagnosed and fixed separately already, via a startup warm-up pass in `ml-service/serve.py`. Not part of this document; mentioned only for completeness.)*

---

## 3. Requirements this design has to satisfy

Pulled directly from the discussion that led here:

- **GSTIN is the canonical cache identity** — one record per GSTIN, never duplicated, refreshed in place.
- **Freshness is a policy decision, not a storage decision** — "how old is this" (a timestamp) is a different concern from "how old is acceptable for this call" (a policy), which is different again from "how long do we physically keep this around" (retention). These three must stay decoupled.
- **Freshness needs vary by situation** — sometimes hourly, sometimes daily, sometimes weekly, per your own description of the real usage pattern. A single hardcoded TTL can't serve all of those honestly, so the caller needs to be able to ask for a specific freshness bound, with a sane default when it doesn't care.
- **Never cache "forever, no expiry."** GST registration status is exactly the field that can change (active → cancelled) without warning, and this is a compliance-relevant invoicing system — indefinite caching risks silently invoicing against a dead GSTIN forever.
- **No duplicate concurrent live lookups** for the same GSTIN, even under a burst of near-simultaneous requests.
- **No new infrastructure dependency**, given the current single-process deployment and the fact that this repo has zero existing database/cache dependencies (`package.json` has no Redis, no Postgres — confirmed by inspection).
- **Keep the door open for Redis later** if/when deployment actually goes multi-instance — the design must not require a rewrite to get there.

---

## 4. Proposed architecture: disk cache, two-layer gatekeeping

### 4.1 The canonical record

One JSON file per GSTIN, in a new `data/taxpayer-cache/` directory:

```text
data/taxpayer-cache/
├── 27ABCDE1234F1Z5.json
├── 29ABCDE1234F1Z8.json
└── 07ABCDE1234F1Z2.json
```

Record shape:

```json
{
  "gstin": "27ABCDE1234F1Z5",
  "data": { "...": "exact taxpayerDetails payload, never reshaped" },
  "fetchedAt": 1758781200000,
  "source": "GST_PORTAL",
  "schemaVersion": 1
}
```

`gstin` is duplicated inside the payload (not just implied by the filename) so a read can self-verify — if something's ever wrong with the filesystem layer, the stored `gstin` field and the requested GSTIN can be checked against each other.

This directory does **not** grow unboundedly — unlike `data/results/`, this one file gets *overwritten* on every refresh. Its total size is bounded by "number of distinct GSTINs you've ever looked up," not "number of lookups ever performed."

### 4.2 New module: `storage/taxpayer-cache-store.js`

A small, focused interface — deliberately the *only* thing that knows this is a file on disk:

```js
async function getCached(gstin)        // -> { gstin, data, fetchedAt, source, schemaVersion } | null
async function setCached(gstin, data)  // -> overwrites the one record for this GSTIN, fetchedAt = now
function isFresh(record, maxAgeMs)     // -> Date.now() - record.fetchedAt <= maxAgeMs
```

Two implementation details that matter:

- **`setCached` writes atomically** — write to a temp file, then `fs.rename()` over the real path. Unlike every other store in this codebase (which write a file once and never touch it again), this file gets rewritten repeatedly over its life, so a plain overwrite creates a real (if narrow) window where a concurrent read could see a half-written file. Write-then-rename closes that window for free — `rename` is atomic on the same filesystem.
- Never throws — same discipline as every other store here (`results-store.js`, `dataset-store.js`, `captcha-failure-store.js`). A cache failure must never break a real lookup; worst case, it just behaves like a cache miss.

### 4.3 The two-layer gate (the part that replaces the need for Redis)

This is the piece that took a few rounds to get right, so it's worth spelling out precisely why a *naive* single-check design has a race, and how the fix works.

**The naive version (has a bug):** check the cache in the route handler; if stale, hand the lookup to the queue. Picture two requests for the same GSTIN landing 200ms apart — two invoices for the same client, back to back. Both check the cache before either one has finished refreshing it, both see "stale," and both get queued as full live lookups. You've re-created the exact duplicate-lookup problem caching was supposed to solve, just moved slightly later in the pipeline.

**The fix — validate at the moment you're about to act, not at the moment you asked:**

```text
                    ┌────────────────────┐
                    │  POST /api/taxpayer │
                    │  { gstin, maxCacheAgeMs? }
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌────────────────────────┐
                    │  GATE 1 — fast pre-check │
                    │  (outside the queue)     │
                    │                          │
                    │  getCached(gstin)        │
                    │  isFresh(record, maxAge) │
                    └──────────┬───────────────┘
                               │
                 ┌─────────────┴─────────────┐
                 │                           │
              FRESH                     STALE / MISSING
                 │                           │
                 ▼                           ▼
         return cached.data      ┌─────────────────────────┐
         (X-Cache: HIT)          │  enter server/queue.js   │
         no queue, no browser,   │  runExclusive(async () => │
         near-instant            └────────────┬─────────────┘
                                               │
                                               ▼
                                  ┌─────────────────────────────┐
                                  │  GATE 2 — re-check at        │
                                  │  execution time               │
                                  │                               │
                                  │  getCached(gstin) again       │
                                  │  isFresh(record, maxAge)?     │
                                  └──────────────┬────────────────┘
                                                 │
                               ┌─────────────────┴─────────────────┐
                               │                                   │
                        NOW FRESH                            STILL STALE
                    (someone ahead of us                  (genuinely nothing
                     in the queue just                     usable exists yet)
                     refreshed it)                                │
                               │                                   ▼
                               ▼                        pipeline/pipeline.js
                     return cached.data                   runLookup(gstin)
                     (X-Cache: HIT)                                │
                     zero browser cost,                            ▼
                     even though this                  results-store.js saveResult()
                     request thought it                (audit trail — unchanged)
                     needed a refresh                              │
                                                                    ▼
                                                    taxpayer-cache-store.js setCached()
                                                    (canonical record — new)
                                                                    │
                                                                    ▼
                                                          return fresh data
                                                          (X-Cache: MISS)
```

Walk the earlier two-requests-200ms-apart scenario through this: both pre-check as stale (Gate 1), both get queued. The queue is strictly ordered, so request A runs first, does the real lookup, writes the fresh record. When B's turn comes, Gate 2 re-checks the cache *right then* — finds A's write sitting there, seconds old — and returns it immediately, never touching the browser. **Exactly one live lookup happens per genuine staleness event, no matter how many requests pile up for that GSTIN while it's in flight** — and it costs nothing beyond the queue you already have. No distributed lock, no Redis, no new infrastructure.

(This is also, not coincidentally, the same "check → lock → re-check" shape a Redis-backed version would use later — swapping the queue for a distributed lock is a contained change, not a redesign, if that day ever comes.)

### 4.4 Policy layer — freshness is configurable, not hardcoded

```js
// config/config.js — new section, same style as ownModelSolver
resultCache: {
    enabled: process.env.RESULT_CACHE_ENABLED !== "false",   // kill switch — false restores today's always-live behavior exactly

    // Default acceptable staleness when a caller doesn't specify one.
    // Chosen to balance: your GSTIN pool repeats heavily and rarely
    // changes registration status, but status changes ARE the one
    // thing a compliance-relevant invoicing system can't silently
    // miss forever.
    defaultMaxAgeMs: intFromEnv(process.env.RESULT_CACHE_DEFAULT_MAX_AGE_MS, 24 * 60 * 60 * 1000), // 24h
}
```

Per-request override, since your own stated need varies by situation (hourly / daily / weekly):

```json
POST /api/taxpayer
{ "gstin": "27ABCDE1234F1Z5", "maxCacheAgeMs": 3600000 }
```

- Omit `maxCacheAgeMs` → falls back to `config.resultCache.defaultMaxAgeMs`.
- `maxCacheAgeMs: 0` → nothing on disk is ever "fresh enough" → always a live lookup. This is the "force refresh" case, and it falls out of the same knob for free — no separate flag needed.
- `config.resultCache.enabled = false` → cache is bypassed entirely, both gates skipped, identical to today's behavior. One env var to fully disable if something looks wrong in production.

### 4.5 Response signaling

A cache hit returns the **exact same JSON body** as a live lookup — nothing added, nothing reshaped, preserving the existing "never reshaped" contract. Whether it was a hit or miss is signaled out-of-band via a response header:

```
X-Cache: HIT
X-Cache: MISS
```

so you can observe/log cache behavior without touching the payload shape any existing consumer depends on.

### 4.6 `GET /api/taxpayer/:gstin/cached` — unchanged

Deliberately left as-is. Its contract ("give me whatever's on disk, however old, or 404 — never touch the browser") is a genuinely different concept from "give me a fresh-enough answer, refreshing if needed," and conflating the two would make both endpoints worse. It keeps reading from `results-store.js`'s audit trail exactly as it does today.

---

## 5. Two stores, two different jobs — not a replacement

Easy to conflate, so worth stating plainly:

| | `storage/results-store.js` (existing, unchanged) | `storage/taxpayer-cache-store.js` (new) |
|---|---|---|
| Purpose | Permanent audit history — every lookup ever done | Fast-path canonical cache — "current best known answer" |
| Records per GSTIN | One per lookup, forever (grows over time) | Exactly one, always (overwritten) |
| Used by | `GET /.../cached` (as it does today) | Gate 1 + Gate 2 (new) |
| Grows unboundedly? | Yes — already true today, unrelated to this change | No — bounded by distinct-GSTIN count |

Every successful live lookup writes to **both** — the audit trail gets its historical entry, and the cache gets its canonical record overwritten. Nothing about the existing audit behavior changes.

---

## 6. Worked example

```text
Monday, 10:00 AM  — invoice created for GSTIN 27ABCDE1234F1Z5
  Gate 1: no cached record exists → MISS
  → queued → Gate 2 confirms still missing → live lookup runs
  → results-store.js: new audit file 27ABCDE1234F1Z5-<ts>.json
  → taxpayer-cache-store.js: 27ABCDE1234F1Z5.json created, fetchedAt = Mon 10:00
  → response: X-Cache: MISS

Monday, 10:15 AM — second invoice, same client
  Gate 1: record exists, age = 15 min, default maxAge = 24h → FRESH
  → return immediately, no queue, no browser
  → response: X-Cache: HIT

Monday, 2:20 PM / 5:45 PM — same client, more invoices
  → same as above, instant HIT every time, zero portal load

Tuesday, 11:00 AM — same client again
  Gate 1: age = 25 hours, default maxAge = 24h → STALE
  → queued → Gate 2 re-checks (still 25h, nobody refreshed it in the meantime) → STILL STALE
  → live lookup runs → both stores updated, fetchedAt = Tue 11:00
  → response: X-Cache: MISS

Tuesday, 11:00:03 AM — a second invoice for the SAME client, 3 seconds later,
                       arrives while the Tuesday lookup above is still running
  Gate 1: age still 25h (the refresh above hasn't finished writing yet) → STALE
  → queued behind the in-flight job
  → by the time this job's turn comes, the job above has finished and written
  → Gate 2 re-checks → NOW FRESH (fetchedAt = Tue 11:00, just written) → HIT
  → response: X-Cache: HIT — this request never touched the browser at all
```

---

## 7. Redis — considered, and why it's deferred (not rejected)

This was debated at length, so the reasoning is worth keeping on record rather than just the conclusion:

- Redis's real advantages are (a) shared state across multiple processes/machines, (b) very high throughput, (c) surviving independent of any one process.
- **(a)** doesn't apply yet: there's exactly one Node process, serializing every lookup through `server/queue.js` by design. There's nothing to share state *between* right now.
- **(b)** doesn't apply: the bottleneck here is a browser solving a CAPTCHA against a live portal (up to a couple of minutes), not request throughput. A 2ms disk read vs a 0.1ms Redis read is not a measurable difference against that.
- **(c)** is actually a wash: a file on disk survives a process crash/restart exactly the same way a Redis-held key does. Neither lives inside the Node process's memory.
- Redis *does* cost something real right now: a new service to run and pay for, a new failure mode ("what does this API do if it can't reach Redis?") that doesn't exist for a local file, and a new dependency every dev environment needs.
- One genuinely correct future trigger for Redis: **if the eventual hosting platform uses an ephemeral filesystem** (wipes local disk on every restart/redeploy, common on some container/serverless platforms unless a persistent volume is attached) — a disk cache would get wiped on every deploy, while Redis wouldn't. This is a property of *where it's hosted*, not a flaw in this design, and deployment target is being decided separately.
- Because the whole cache sits behind the two-function `getCached`/`setCached` interface in §4.2, swapping the disk-backed implementation for a Redis-backed one later is a contained, mechanical change — not a rewrite of the policy layer, the routes, or the two-gate logic.

**Decision: build on disk now. Revisit only when there's a concrete, specific reason (confirmed ephemeral hosting, or an actual move to multiple instances) — not a general "production systems use Redis" instinct.**

---

## 8. Explicitly out of scope for this document

- **Deployment target** (Vercel or otherwise) — separate discussion, deliberately deferred. Nothing here assumes serverless or a persistent VM; the design works on a single persistent process, which is what exists today.
- **Negative caching** (caching "this GSTIN is invalid" to avoid hammering the portal with bad input) — good idea, explicitly agreed to defer until the main cache is working.
- **Any change to Hi Life Nx's main application database.** This repo has no customers table and no Postgres dependency — that uniqueness constraint concern belongs to the separate Hi Life Nx web app repo, not this one.
- **A retention/pruning policy for `data/results/`'s audit trail.** Pre-existing, unbounded growth, unrelated to this change — worth its own conversation eventually, not bundled in here.

---

## 9. Proposed file changes (for review — nothing built yet)

| File | Change |
|---|---|
| `storage/taxpayer-cache-store.js` | **New.** `getCached`, `setCached`, `isFresh`. Atomic writes. |
| `server/taxpayer-cache-gateway.js` (name open to bikeshedding) | **New.** The two-gate orchestration in §4.3 — the only place that knows about both gates, the queue, and the cache store. |
| `server/app.js` | **Modified.** `POST /api/taxpayer` delegates to the gateway instead of calling `runExclusive(() => runLookup(gstin))` directly. Adds `X-Cache` response header. Accepts optional `maxCacheAgeMs` in the body. |
| `config/config.js` | **Modified.** New `resultCache` section (§4.4). |
| `storage/results-store.js` | **Unchanged.** Still called on every successful live lookup, exactly as today. |
| `server/queue.js` | **Unchanged.** Reused as-is — it's the mechanism that makes Gate 2 correct. |
| `GET /api/taxpayer/:gstin/cached` route | **Unchanged.** |

---

## 10. Open items for your review

1. Is `data/taxpayer-cache/` the right location/name, or would you rather nest it differently relative to `data/results/`?
2. Any objection to the `X-Cache: HIT/MISS` header approach, versus wanting that signal inside the JSON body somewhere?
3. Default `defaultMaxAgeMs` — is 24h a reasonable starting point, or do you want a different default given real client behavior?
4. Naming: `server/taxpayer-cache-gateway.js` vs. folding this logic directly into `server/app.js` vs. some other placement you'd prefer.

Nothing gets touched until you've reviewed this and we've talked through any changes.
