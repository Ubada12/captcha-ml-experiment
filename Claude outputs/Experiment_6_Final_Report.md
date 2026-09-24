# Experiment 6 — Final Report: CRNN + CTC for Fixed 6-Digit CAPTCHA Recognition

**Companions:** `Experiment_6_CRNN_CTC_Specification.md` (architecture design) and `Experiment_6_Execution_Roadmap.md` (phase gates)
**Status:** All phases (A–J) complete. Results independently verified against primary source files — code re-executed, parameter counts reproduced from scratch, training history cross-checked line-by-line, evaluation output traced back to its exact source dataset. Not accepted on the strength of a written summary alone.

---

## 1. Headline result

| Metric | Experiment 4 (independent heads) | Experiment 6 (CRNN + BiLSTM + CTC) |
|---|---:|---:|
| Full CAPTCHA accuracy | 6.25% (2/32) | **96.88% (31/32)** |
| Digit accuracy | 61.46% | **98.44% (189/192)** |
| P1 | 100.00% | 100.00% |
| P2 | 50.00% | 100.00% |
| P3 | 21.88% | **100.00%** |
| P4 | 43.75% | 96.88% |
| P5 | 84.38% | 96.88% |
| P6 | 68.75% | 96.88% |

Both rows are measured on the identical, unchanged 32-image fixed test set (`prepared/test.jsonl`) — confirmed by direct label comparison, not assumed.

---

## 2. What Experiment 6 was actually testing

Experiment 4 diagnosed two independent failure modes: overfitting (100% train accuracy against 61% validation/test, with rising validation loss), and a structural inability to use cross-position context, visible as a collapse at positions 3–4 — exactly where digit overlap and the diagonal strike-through interference were worst. The central scientific question for Experiment 6 was not "does accuracy go up" but specifically: **does giving the model cross-position context (via a BiLSTM feeding a CTC decoder) close the P3/P4 gap that independent per-position heads could not close?**

The measured answer is yes, unambiguously: P3 went from 21.88% to 100%, P4 from 43.75% to 96.88%. That is the real finding of this experiment — not the headline accuracy number by itself.

---

## 3. Architecture, as actually implemented (verified by execution, not by reading comments)

```text
CAPTCHA (182×50×3)
        │
   Train-time augmentation (train split only)
        │
        ▼
   ResNet-18 backbone
     stem + layer4: trainable
     layer1–3: frozen (eval mode)
     layer3[0].conv1 stride → (1,2)   [preserves height, keeps normal width downsampling]
     layer4[0].conv1 stride → (1,1)   [removes downsampling entirely]
        │
        ▼
   Feature map: (B, 512, 7, 12)
        │
   AdaptiveAvgPool2d((1, None))  — collapse height only
        │
        ▼
   (B, 512, 12) → permute → (B, 12, 512)
        │
        ▼
   BiLSTM: 2 layers, hidden=256, bidirectional, internal dropout 0.3
        │
        ▼
   (B, 12, 512) → Dropout(0.3) → Linear(512 → 11)
        │
        ▼
   (B, 12, 11) logits → CTC loss (training) / greedy CTC decode (inference)
```

**One verified deviation from the original specification, worth recording plainly:** the specification called for preserving *width* resolution (targeting W≈20–25) by leaving height reduction alone. The actual implementation did the opposite — it preserves *height* (via the layer3 stride change) and removes downsampling in layer4 entirely, which nets out differently than planned. Running the real model against a dummy input confirms the true output is **W=12**, not the ~20–25 the specification targeted or the "≈23" claimed in the code's own comments. This was not caught by inspection — it was caught by actually executing the model and reading the tensor shape it produced.

This matters because CTC needs an input length of at least `label_length + number_of_adjacent_repeated_pairs`. At W=12 against a 6-digit label, the margin is real but tighter than planned: comfortably sufficient for the CAPTCHAs actually seen (worst case in this dataset needed only 7), but with far less headroom than the specification assumed for a hypothetical CAPTCHA with several repeated digits in a row (worst case, all six digits identical, would need 11 — just one shy of the ceiling). The result stands on its own merits, but this is worth knowing before assuming the same margin would hold on a harder dataset.

**Verified parameter counts** (reproduced independently by loading `model.py` and running `count_parameters()`, not copied from a log):

| Component | Parameters |
|---|---:|
| Total | 14,336,075 |
| Trainable | 11,562,827 |
| Frozen | 2,773,248 |

These match the checkpoint's own reported figures and the final evaluation report's `parameter_summary` block exactly, across three independent sources.

---

## 4. Dataset

| Split | Count | Verified |
|---|---:|---|
| Train | 3,035 | `dataset.py`'s own runtime assertion; confirmed zero overlap with val/test image paths |
| Validation | 338 | Same |
| Test (fixed) | 32 | Confirmed identical label set to Experiment 3B/4's original benchmark |

Augmentation (train split only, verified in `dataset.py`): `RandomAffine` (rotation ±4°, translate up to 6%, scale 0.97–1.03, shear ±2°), `ColorJitter` (brightness/contrast 0.12, saturation 0.08, hue 0.02), and a deliberately conservative `RandomErasing` (p=0.25, erased area 0.5–2% of the image, narrow horizontal-ish regions) — the code explicitly notes the erasing scale is kept small because the 50px image height means an aggressive erase could delete an entire digit while leaving the label unchanged. Validation and test use resize + normalize only, confirmed unaugmented.

A leakage check was run directly against the raw manifests (train/val/test/test_extra all pairwise compared by image path): zero overlap anywhere.

---

## 5. Training

| Setting | Value | Source |
|---|---|---|
| Backbone (layer4) LR | 1e-4 | `experiment_summary.json` |
| BiLSTM LR | 1e-3 | Same |
| Classifier LR | 1e-3 | Same |
| Weight decay | 5e-4 | Same |
| Gradient clip | 1.0 | Same |
| Scheduler | ReduceLROnPlateau, monitoring validation full-CAPTCHA accuracy | Same |
| Early stopping | Patience 7, min delta 1e-4, monitoring validation full-CAPTCHA accuracy | Same |
| Epochs run | 42 of 50 max | Same |
| Best epoch | 35 | Same |

**Best epoch (35), independently confirmed against the raw `training_history.json`, not just the summary file:**

```text
Train loss              : 0.02912
Validation loss          : 0.02693
Validation full accuracy : 96.746%
Validation digit accuracy: 99.162%
Layer4 LR at this point  : 2.5e-5   (decayed from 1e-4)
BiLSTM/classifier LR     : 2.5e-4   (decayed from 1e-3)
```

Epochs 36–42 were individually checked: none exceeded epoch 35's validation full-accuracy (best competing epoch was 42 at 96.15%), confirming early stopping correctly preserved the right checkpoint rather than a later, worse one.

**Train/validation divergence — the exact failure mode Experiment 4 exhibited — did not reproduce here.** Experiment 4's validation loss rose steadily from ~9–12 to ~17–18 while train loss fell to near-zero. Experiment 6's train and validation loss stayed close together throughout (0.029 vs 0.027 at the best epoch), which is direct evidence the regularization stack (augmentation, dropout, weight decay, differential LR, frozen early layers) did what it was intended to do.

**Phase F2 (tiny-set learning test) — verified from raw history, not description.** Trained repeatedly on a small fixed subset: started at epoch 1 with 0% exact accuracy, loss 3.23, 100% empty (all-blank) predictions — a genuinely untrained state. By epoch 85: 100% exact accuracy (32/32), 0.0 average edit distance, loss 0.023. This confirms the model, loss construction, and decoder were wired correctly before any time was spent on full training.

---

## 6. Final evaluation on the fixed 32-image test set

This is the result that matters for comparison to Experiment 4, and the one that required the most care to verify — see §7 for why.

```text
Full CAPTCHA correct   : 31 / 32  (96.88%)
Digit correct          : 189 / 192 (98.44%)
Average CTC loss        : 0.014369
Average edit distance   : 0.03125
Adjacent repeated-digit subset : 15 / 16 correct (93.75%)
```

**Per-position accuracy:**

| Position | Accuracy |
|---|---:|
| P1 | 100.00% |
| P2 | 100.00% |
| P3 | 100.00% |
| P4 | 96.88% |
| P5 | 96.88% |
| P6 | 96.88% |

**The one failure:**

```text
Ground truth : 633367
Prediction   : 63367
```

The digit sequence `633367` contains an adjacent repeat (`33`). The model's greedy CTC decoding collapsed one of the repeated `3`s, producing a 5-character output instead of 6. By Levenshtein edit distance, this is exactly **one deletion** — a single, well-understood, well-isolated failure, not a broad recognition error.

**Confusion matrix:** every off-diagonal entry in the entire 32-image test set traces back to this one sample. There are exactly two off-diagonal entries: ground-truth `3→predicted 6` (×1) and ground-truth `6→predicted 7` (×1). No systematic digit-shape confusion cluster survived from Experiment 4 (the earlier 6↔9, 8↔9, 3/5/8 confusion group is gone).

---

## 7. A verified methodological caveat — read this before quoting P4/P5/P6 elsewhere

While tracing this result back to its source, two things were checked that are easy to get wrong when trusting a summary alone, and worth recording here so they don't need re-discovering later.

**(a) The evaluation script's per-position and confusion-matrix accounting uses fixed-index comparison, not edit-distance alignment.** For the one sample where the prediction is shorter than the target (`63367` vs `633367`), the code compares digit-by-digit at the same index — meaning everything *after* the deletion point is compared against the wrong digit. Concretely: position 4 (`P4`, 1-indexed) compares the model's `6` against the target's `3` (a spurious mismatch — the model's `6` is actually correct, just shifted one place early after the deletion), position 5 (`P5`) compares `7` against `6` (same shift artifact), and position 6 (`P6`) is never compared at all, since the prediction ran out of length. This mechanically produces "3 digit errors" and two confusion-matrix entries from what is, by the edit-distance metric computed separately in the same report, truly **one clean deletion**. The P4–P6 = 96.88% figures are therefore a slight artifact of the counting method for this one sample, not evidence of three independent near-misses at those positions. The `average_edit_distance` figure (0.03125 = 1/32) is the more accurate single-number summary of what actually went wrong.

**(b) The first version of this evaluation file was overwritten by an unrelated run before being caught.** Earlier in this verification, `test_evaluation_report.json` and `test_predictions.csv` on disk did not match the 96.88% result at all — they contained a perfect 32/32 result against a *different*, non-overlapping 32-image set (`prepared/test_extra.jsonl`), almost certainly the separate "unseen images" spot-check run afterward. `inference.py` writes to a fixed output path with no versioning, so that second run silently overwrote the original locked-benchmark evaluation's output files. This was only caught by directly comparing the labels inside the saved JSON against the labels in `prepared/test.jsonl` — they didn't match. `test.jsonl` itself was never touched, so re-running `inference.py` reproduced the real result exactly (confirmed above, in §6). Going forward, each evaluation run should be saved to a uniquely named file (e.g. timestamped, or suffixed with the dataset it ran against) rather than overwriting the same path — this is the one process gap this whole exercise surfaced.

Neither of these caveats changes the conclusion. Both are exactly the kind of thing "verify the primary files, don't just trust the summary" is supposed to catch, and both did get caught before being written into a final record — which is the point.

---

## 8. Verified against the two failure modes Experiment 6 was designed to fix

```text
PROBLEM 1 — positional / alignment limitation (Experiment 4's real weakness)
  Diagnosed: P3=21.88%, P4=43.75%, independent heads with no cross-position context
  Fix applied: horizontal sequence (W=12, verified) → BiLSTM → CTC
  Measured outcome: P3=100%, P4=96.88% — gap closed

PROBLEM 2 — overfitting (Experiment 4's other, independent weakness)
  Diagnosed: 100% train accuracy vs 61% val/test, validation loss rising continuously
  Fix applied: augmentation + dropout(0.3×2) + weight decay(5e-4) + differential LR
              + frozen early layers + larger dataset (1,405 → 3,405 total)
  Measured outcome: train loss 0.029 / val loss 0.027 at best epoch — no divergence
```

Both diagnosed problems were addressed, and both show measured, verified improvement — not just an improved headline number that could theoretically hide one problem persisting.

---

## 9. What this result does and does not establish

**Established, with verified evidence:** on the fixed 32-image benchmark — the same benchmark Experiment 4 was measured against — the CRNN + BiLSTM + CTC architecture achieves 96.88% full-CAPTCHA accuracy and 98.44% digit accuracy, with the specific structural weakness diagnosed in Experiment 4 (positional collapse at P3/P4) fully resolved and no overfitting signature in the training curve. The architecture, parameter counts, training procedure, and final evaluation were all independently re-derived from the actual code and data files, not accepted from a written description alone.

**Not established, and shouldn't be claimed:** that the model is "96.88% accurate" as a general real-world statement. The test set is 32 images — informative and consistent with the training/validation trends, but still a small sample. The one failure mode identified (CTC collapsing an adjacent repeated digit) is a known, specific limitation, not a mystery — and worth keeping an eye on precisely because the sequence-length margin (W=12) is tighter than originally planned, per §3.

---

## 10. Conclusion

Experiment 6 successfully replaced Experiment 4's independent per-position classification heads with a sequence-aware CRNN + BiLSTM + CTC architecture, directly targeting the positional-context blindness that caused Experiment 4's P3 collapse (21.88%) — and the fix worked (100% on the same position). Independently, the added regularization stack addressed Experiment 4's overfitting, visible in a training curve that no longer diverges. The one remaining, well-characterized weakness — CTC collapsing an adjacent repeated digit under a tighter-than-planned sequence-length margin — is a specific, understood failure mode rather than a broad accuracy problem, and is now a known target for any future iteration (a wider sequence length, or beam-search decoding in place of greedy, are the two most direct next levers if this needs to improve further).

**Experiment 6 is frozen as the completed baseline**, with its results now verified against primary source files rather than resting on a written summary.
