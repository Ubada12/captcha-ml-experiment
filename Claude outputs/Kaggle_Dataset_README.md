# CAPTCHA Digit Recognition Dataset

A dataset of **3,437 six-digit numeric CAPTCHA images** with verified ground-truth labels, collected for training and evaluating digit-sequence OCR models.

---

## Overview

This dataset contains PNG images of six-digit numeric CAPTCHAs, each paired with its correct digit sequence as a ground-truth label. It was built to support machine learning research on sequence-based CAPTCHA/OCR recognition — specifically, models that read a short, fixed-length numeric sequence directly from an image.

| | |
|---|---|
| **Total images** | 3,437 |
| **Total labeled records** | 3,437 (100% coverage — every image has a label) |
| **Label type** | Fixed-length numeric string, always exactly 6 digits (`0`–`9`) |
| **Image format** | PNG, RGB |
| **Collection period** | 2026-09-13 to 2026-09-23 (four collection sessions) |
| **Ready-made splits included** | Yes — train / validation / test / a separate unseen test set |

---

## How the data was generated

The CAPTCHA images were produced with a custom-built CAPTCHA generator (`own-captcha-generator`), created to reproduce a real-world six-digit numeric CAPTCHA style for research purposes — these are **not scraped images taken from a live third-party website**.

Ground-truth labels were obtained by submitting each generated image to the **2Captcha** solving API (`solver: 2captcha`) and recording the returned digit sequence as the label. Every one of the 3,437 records was labeled this way — there is no manual transcription step, so label quality is consistent across the whole dataset (verified: 100% of labels are exactly six numeric digits, with no malformed or non-numeric entries).

Each record also carries a `sha256` hash of its image (useful for integrity checks or de-duplication) and a `createdAt` timestamp recording when that CAPTCHA was generated and solved.

---

## Folder structure

```text
captcha-dataset/
│
├── labels.jsonl              ← canonical metadata for all 3,437 images
│
├── images/
│   ├── 2026-09-13/           ← 205 images
│   ├── 2026-09-14/           ← 1,200 images
│   ├── 2026-09-17/           ← 2,000 images
│   └── 2026-09-23/           ← 32 images
│
└── prepared/                 ← ready-to-use train/val/test splits
    ├── train.jsonl           ← 3,035 records
    ├── val.jsonl             ← 338 records
    ├── test.jsonl            ← 32 records
    └── test_extra.jsonl      ← 32 records
```

Each date-named folder under `images/` represents one collection session. The images inside are referenced by relative path from `labels.jsonl` and from every file under `prepared/` (e.g. `"images/2026-09-13/captcha_1789310571839.png"`) — file paths are consistent across all manifests, so any manifest can be used directly against the `images/` folder without renaming or moving files.

---

## `labels.jsonl` — record schema

Every line in `labels.jsonl`, and in each file under `prepared/`, is one JSON object with the same fields:

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique identifier for the sample (matches the image filename without extension) |
| `image` | string | Relative path to the image file, from the dataset root |
| `label` | string | Ground-truth six-digit sequence, e.g. `"358025"` |
| `length` | integer | Length of the label (always `6` in this dataset) |
| `numeric` | boolean | Whether the label contains digits only (always `true` in this dataset) |
| `sha256` | string | SHA-256 hash of the image file, for integrity checking |
| `source` | string | How the image was produced (always `"own-captcha-generator"`) |
| `solver` | string | Service used to obtain the ground-truth label (always `"2captcha"`) |
| `taskId` | integer | Internal reference ID for the solving job — not meaningful outside the original pipeline |
| `createdAt` | string (ISO 8601) | UTC timestamp of when the sample was generated and labeled |

Example record:

```json
{
  "id": "captcha_1789326881447",
  "image": "images/2026-09-13/captcha_1789326881447.png",
  "label": "358025",
  "length": 6,
  "numeric": true,
  "sha256": "9c1b760b9946cc8e6543db0988d56b7c5fabde8a41ffd181287e9c8195afc611",
  "source": "own-captcha-generator",
  "solver": "2captcha",
  "taskId": 83840433753,
  "createdAt": "2026-09-13T19:14:41.448Z"
}
```

---

## Image properties

- **Format:** PNG, RGB (no alpha channel)
- **Dimensions:** the large majority of images (3,430 of 3,437 — 99.8%) are exactly **182 × 50 pixels**. A small number (7 images total) differ slightly — 2 images at 228 × 63 and 5 images at 184 × 52 — left as-is rather than resized, so users who require a single fixed input size should resize on load rather than assume uniform dimensions.
- **Content:** each image shows a six-digit numeric sequence rendered with the visual noise/distortion typical of a CAPTCHA (this dataset does not include any non-numeric or variable-length CAPTCHAs).

---

## Included splits (`prepared/`)

For convenience, the dataset ships with pre-defined splits so results are reproducible without needing to re-split the data:

| File | Records | Notes |
|---|---:|---|
| `train.jsonl` | 3,035 | Drawn from the 2026-09-13 / 09-14 / 09-17 collection sessions |
| `val.jsonl` | 338 | Drawn from the same sessions as `train.jsonl` |
| `test.jsonl` | 32 | A fixed, held-out set drawn from the same sessions, kept separate from training |
| `test_extra.jsonl` | 32 | All 32 images from the 2026-09-23 session — a later, independently-collected batch, useful as an additional generalization check beyond the main test set |

These four files were verified to be a **clean, non-overlapping partition** of the full dataset:

- Zero image-path overlap between every pair of splits (train↔val, train↔test, val↔test, and each against `test_extra`).
- Together, the four files account for all 3,437 images in `labels.jsonl` exactly once each — no image is missing from every split, and no image appears in more than one.

Users who want a different split are free to re-partition `labels.jsonl` directly; the `prepared/` files are provided only as a reproducible default.

---

## Label distribution notes

- All 3,437 labels are exactly six characters long and contain digits only — verified programmatically, no exceptions.
- 3,428 of the 3,437 labels are unique digit sequences; 9 sequences repeat (a different image renders the same six-digit string as another image elsewhere in the dataset). This is expected for a six-digit numeric space and does not indicate duplicate images — each repeated label's images are visually distinct renders, confirmed by their differing `sha256` hashes.

---

## Suggested use cases

- Training or benchmarking sequence-recognition / OCR models on short, fixed-length numeric CAPTCHAs.
- Studying CAPTCHA robustness and the effect of visual noise/distortion on digit-sequence recognition.
- General small-scale digit-sequence classification or CTC-based sequence modeling practice.

---

## Limitations

- All images originate from a single custom CAPTCHA generator rather than a range of real-world CAPTCHA providers, so a model trained purely on this dataset may not generalize to visually different CAPTCHA styles.
- The dataset is exclusively six-digit numeric sequences — it does not include letters, variable-length sequences, or non-numeric characters.
- `test_extra.jsonl` is a single collection session (2026-09-23) rather than a large, diverse external test set — treat it as a small additional sanity check, not a statistically robust generalization benchmark.

---

## License and attribution

Please set the dataset's license during upload according to how you'd like it used and cited. If you'd like a suggested line for this section (e.g. crediting the CAPTCHA generation and 2Captcha-based labeling pipeline), let me know and I'll add it.
