# Experiment 6 — CRNN + CTC Specification

**Project:** GST-portal CAPTCHA solver (fixed 6-digit, single-site font/background)
**Supersedes:** Experiment 4 (ResNet-18, independent per-position heads)
**Status:** Architecture + training recipe frozen. Awaiting dataset expansion completion before Phase F (sanity test) and Phase G (full training).

---

## 0. Why Experiment 6 exists — recap of the Experiment 4 diagnosis

Experiment 4 (ResNet-18 backbone, layers 1–3 frozen, layer4 trainable, six independent per-position classification heads) was trained on 1,405 images (1,235 / 138 / 32 train/val/test) and produced:

| Metric | Value |
|---|---|
| Train digit accuracy | 100% (by epoch ~45) |
| Validation digit accuracy | 63.4% (best, epoch 59) |
| Test digit accuracy | 61.5% |
| Test full-CAPTCHA accuracy | 6.25% (2/32 correct) |
| Validation loss trend | Rose steadily from ~9–12 to ~17–18 while train loss fell to near-zero |
| Per-position test accuracy | P1 100%, P2 50%, P3 21.9%, P4 43.75%, P5 84.4%, P6 68.75% |

Two independent, evidence-backed root causes were identified:

1. **Overfitting.** 8.4M trainable parameters against 1,235 training images, zero data augmentation, rising validation loss while train loss went to ~0 — the classic memorization signature.
2. **Positional/structural weakness.** Accuracy collapsed specifically at positions 3–4 (image center, where digit overlap and the diagonal strike-through line are worst), while positions 1/5/6 stayed strong. The independent-per-position heads have no mechanism to use neighboring-digit context to resolve an occluded or overlapping digit — each head decides in isolation.

Confusion matrices additionally showed digit-shape confusion clusters (6↔9, 8↔9, 3/5/8 group), consistent with the model overfitting to pixel-level noise rather than learning rotation/shape-invariant digit representations.

**Experiment 6 targets both causes at once:** a sequence-aware architecture (BiLSTM + CTC) replaces the independent heads to fix the structural weakness, and an expanded, explicit regularization stack (augmentation, dropout, weight decay) fixes the overfitting — rather than assuming the new architecture alone solves generalization.

---

## 1. Goal

Take one CAPTCHA image and produce the correct 6-digit string, without ever labeling individual character positions or bounding boxes.

```text
Input image (182×50×3)
        ↓
    "358025"
```

---

## 2. Complete architecture

```text
                 CAPTCHA IMAGE
                  182 × 50 × 3
                       │
                       ▼
        ┌───────────────────────────────┐
        │   TRAIN-TIME AUGMENTATION      │
        │   (train split only)           │
        │                                │
        │   RandomAffine                 │
        │     rotation   ±3°             │
        │     translate  ±3%             │
        │     scale      0.97–1.03       │
        │                                │
        │   ColorJitter                  │
        │     brightness 0.10            │
        │     contrast   0.10            │
        │                                │
        │   Controlled random occlusion  │
        │     (probabilistic, thin       │
        │      strokes/erasing)          │
        └──────────────┬─────────────────┘
                        │
                        ▼
              ┌───────────────────┐
              │    ResNet-18       │
              │  pretrained CNN    │
              │                    │
              │  layer1–3 FROZEN   │
              │  layer4 TRAINABLE  │
              │                    │
              │  stride modified   │
              │  to preserve       │
              │  horizontal        │
              │  resolution        │
              └─────────┬──────────┘
                        │
                        ▼
              feature map: 512 × 2 × W
                        │
                        ▼
                CNN → Sequence
              (reshape 512×2 → 1024
               per horizontal step)
                        │
                        ▼
                 W × 1024 features
              F1  F2  F3  ...  FW
                        │
                        ▼
              ┌────────────────────┐
              │      BiLSTM         │
              │  2 layers            │
              │  hidden_size = 256   │
              │  bidirectional       │
              │  internal dropout 0.3│
              └─────────┬───────────┘
                        │
                        ▼
                    W × 512
              (256 forward + 256 backward)
                        │
                        ▼
                 Dropout(p = 0.3)
                        │
                        ▼
                Linear(512 → 11)
                        │
                        ▼
              11 classes per timestep
           0 1 2 3 4 5 6 7 8 9  BLANK
                        │
                        ▼
                    CTC Loss
                  (training)
                        │
                  CTC Decoding
                  (inference)
                        │
                        ▼
                    "358025"
```

---

## 3. Dataset

| Split | Size (approx., post-expansion) | Notes |
|---|---|---|
| Train | ≈ 2,120 | Recalculated exactly once new samples merge |
| Validation | ≈ 250 | Enlarged vs. Experiment 4's 138 — that was too small for stable per-position accuracy estimates (≈14 samples/digit/position) |
| Test | 32 (fixed, unchanged since Experiment 3B) | Never touched by augmentation. This is what keeps Experiment 6 comparable to Experiment 4. |

---

## 4. Augmentation — train split only

Validation and test receive **resize + ImageNet normalization only.** No random augmentation is ever applied to them — that is what keeps the accuracy numbers comparable across experiments.

### A. Geometric — `RandomAffine`
```python
transforms.RandomAffine(
    degrees=3,
    translate=(0.03, 0.03),
    scale=(0.97, 1.03),
)
```
Kept deliberately small. Digit identity is orientation-sensitive (unlike a photo of a cat) — a 6 rotated too far starts to look like a 9. This range compensates for minor rendering variance without ever risking a label/image mismatch. **No horizontal or vertical flips, ever** — a flipped digit isn't the same digit, and a flipped 6-digit string reverses reading order.

### B. Photometric — `ColorJitter`
```python
transforms.ColorJitter(
    brightness=0.10,
    contrast=0.10,
)
```

### C. Controlled occlusion (highest-value augmentation for this dataset specifically)
Random erasing / thin synthetic strokes, applied probabilistically (not to every image), sized and styled to resemble the CAPTCHA's actual interference (the diagonal strike-through, the grid/mesh distortion) rather than generic large black rectangles.

```text
normal:      3 5 8 0 2 5
augmented:   3 5̸ 8 0 2 5      (thin stroke through one digit)
```

This is the augmentation most directly aimed at the actual diagnosed failure mode: it forces the model to rely on the BiLSTM's cross-position context to recover an occluded digit during *training*, rather than hoping that skill emerges only from naturally-occurring overlap examples.

---

## 5. ResNet-18 backbone

### 5.1 Preserving horizontal resolution — the critical fix

A stock ResNet-18 downsamples 32× total (stem: 4×, then layer2/3/4 each 2×). That is exactly what produced Experiment 4's real output shape of ~512×2×6 (182/32 ≈ 5.7 → 6) — confirmed against the actual `inference.py` image dimensions (182×50). **Six timesteps is far too few for CTC**: it barely exceeds the 6-character target length, leaves no room for the blank tokens CTC needs to insert between adjacent repeated digits (the dataset genuinely has these — e.g. label `112957` has an adjacent double-1), and gives the BiLSTM almost nothing to model.

**Concrete fix:** change the stride in two of the later downsampling stages (layer3 and/or layer4's first block) from `(2, 2)` to `(2, 1)` — i.e., continue halving height each time (so it still collapses to ≈2) but stop halving width there. That reduces the *width* downsampling factor from 32× to 8×:

```text
182 / 8 ≈ 22.75  →  W ≈ 20–25
```

This lands exactly in the target range and is the same asymmetric-pooling trick the original CRNN paper uses for this exact reason.

**CTC timestep-budget check:** CTC requires an input length of at least `label_length + number_of_adjacent_repeated_character_pairs`. Worst case for a 6-digit label is ~11 (e.g. `111111`). At W≈20–25, there is comfortable margin even for the worst case — this was a real risk at W=6 and is resolved at this target width.

### 5.2 Freeze policy

```text
ResNet stem   FROZEN
layer1        FROZEN
layer2        FROZEN
layer3        FROZEN
layer4        TRAINABLE
```

Kept identical to Experiment 4's policy deliberately, for architectural comparability — the goal is to isolate the effect of adding the BiLSTM/CTC sequence model, not conflate it with an unrelated backbone-capacity change. Frozen layers are kept in `eval()` mode during training so their BatchNorm running statistics don't drift from a small-batch training loop.

**Do not automatically widen this to "unfreeze the whole backbone"** just because a sequence model was added — the BiLSTM itself already adds meaningful new trainable capacity (see §7), and total trainable capacity must be weighed against dataset size, not decided per-component in isolation.

---

## 6. CNN → sequence conversion

```text
CNN output:  [B, 512, 2, W]
                    │
                    │  reshape: combine channel × height per timestep
                    ▼
Sequence:    [B, W, 1024]        (512 × 2 = 1024)
```

Combining the two height rows into the per-timestep feature vector (rather than average-pooling height away to 1) is a deliberate choice — it preserves top/bottom visual detail per column instead of blending it, which matters given the vertical structure of the actual noise pattern (mesh distortion, diagonal strike line).

---

## 7. BiLSTM

```python
nn.LSTM(
    input_size=1024,
    hidden_size=256,
    num_layers=2,
    bidirectional=True,
    batch_first=True,
    dropout=0.3,   # applied between the 2 stacked layers
)
```

Each timestep gets forward context (left-to-right) and backward context (right-to-left) combined, giving every position visibility into its neighbors — this is the direct fix for the position-3/4 occlusion collapse, since a head resolving an ambiguous, partially-occluded digit can now use the shape/spacing of adjacent digits, which Experiment 4's independent heads structurally could not do.

**Parameter estimate** (verify exactly via code before training, never trust this number blindly):

| Component | Approx. parameters |
|---|---|
| Layer 1 (input 1024 → hidden 256, bidirectional) | ≈ 2.63M |
| Layer 2 (input 512 → hidden 256, bidirectional) | ≈ 0.79M |
| **Total BiLSTM** | **≈ 3.4M** |

This is why the parameter-accounting step in §9 matters: adding ~3.4M new trainable parameters on top of ResNet's layer4 (8.4M) is not free, on a dataset that is still only ~2,000–2,400 images.

---

## 8. Classifier + CTC

```python
nn.Sequential(
    nn.Dropout(0.3),
    nn.Linear(512, 11)   # 256 forward + 256 backward = 512 in
)
```

**11 = 10 digit classes + 1 CTC blank** — not 11 digits. The blank means "no character is being emitted at this timestep," which is what lets CTC represent a 6-character label across 20–25 timesteps without manual alignment:

```text
BLANK BLANK 3 3 BLANK 5 5 BLANK 8 8 BLANK 0 0 BLANK 2 2 BLANK 5 5 BLANK
                              │
                     CTC collapse (merge repeats, drop blanks)
                              ▼
                          "358025"
```

**Loss:** `nn.CTCLoss`. **Decoding (Phase E, first pass):** greedy — take the argmax class per timestep, collapse consecutive repeats, remove blanks. Beam search decoding is a possible later improvement, not required for the first working version.

**Evaluation caveat to build in from day one:** filter out and separately report accuracy on test/validation samples whose label contains adjacent repeated digits (e.g. `112957`). This is exactly the case CTC can fail silently on if timestep budget or blank-prediction isn't learned correctly, and it will not show up as a distinct number in aggregate accuracy alone.

---

## 9. Full parameter accounting (printed at runtime, never assumed)

| Component | Parameters | Trainable? |
|---|---|---|
| ResNet-18 total | ≈ 11.7M | — |
| ResNet stem + layer1–3 | (exact count printed) | Frozen |
| ResNet layer4 | ≈ 8.4M | Trainable |
| BiLSTM (2-layer, bidirectional) | ≈ 3.4M | Trainable |
| Linear classifier | ≈ 5.6K | Trainable |
| **Total model** | **≈ 15M** | — |
| **Total trainable** | **≈ 11–12M (estimate — verify exactly)** | — |

This must be printed and inspected before Phase F. The modified stride and exact LSTM configuration both shift these numbers — the estimate above is a planning figure, not a target to hit.

---

## 10. Optimizer, learning rates, regularization

| Setting | Value | Rationale |
|---|---|---|
| ResNet layer4 LR | 1e-4 | Pretrained, already useful — small updates |
| BiLSTM LR | 1e-3 | Randomly initialized — needs faster learning |
| Classifier LR | 1e-3 | Randomly initialized — needs faster learning |
| Weight decay | 5e-4 | Raised from Experiment 4's 1e-4 — extra regularization given added BiLSTM capacity |
| Gradient clipping | 1.0 | Carried forward from Experiment 4 |
| LSTM internal dropout | 0.3 | Between the 2 stacked BiLSTM layers |
| Post-BiLSTM dropout | 0.3 | Before the final classifier |
| Scheduler | ReduceLROnPlateau, tracking **decoded validation accuracy** (not raw CTC loss) | CTC loss doesn't map intuitively to accuracy the way cross-entropy did in Experiment 4 — tracking decoded digit/full-sequence accuracy keeps the selection metric interpretable and comparable to Experiment 4's `validation_digit_accuracy` |
| Early stopping | Same patience/min_delta philosophy as Experiment 4 | Prevents the same runaway-overfitting pattern seen before |

---

## 11. One-image walkthrough (worked example)

**Ground truth:** `358025`

1. **Augmentation** (this iteration, hypothetically): +1.2° rotation, +1% translation, slight contrast change, small random occlusion on one digit.
2. **ResNet** → `512 × 2 × 23` (23 is illustrative; actual W is confirmed after the stride change, per §5.1).
3. **Reshape** → `23 × 1024` sequence: `F1 F2 F3 ... F23`.
4. **BiLSTM** → `23 × 512` contextualized sequence (each `Hi` now aware of both left and right neighbors).
5. **Classifier** → `23 × 11` logits, conceptually:
   ```text
   t1  BLANK   t2  BLANK   t3  3   t4  3   t5  BLANK
   t6  5       t7  5       t8  BLANK  t9  8  t10 8  ...
   ```
6. **CTC decode** → collapse repeats, drop blanks → `358025`.

---

## 12. Implementation phases

| Phase | Task |
|---|---|
| A — Dataset | Merge expanded dataset, verify labels/images, confirm the fixed 32-image test set is untouched, compute new train/val split sizes |
| B — Augmentation | Implement `RandomAffine` + `ColorJitter` + controlled occlusion; confirm train=augmented, val/test=clean only |
| C — Backbone | Modify ResNet-18 stride per §5.1; print `[B, 3, 50, 182] → [B, 512, 2, W]` and confirm actual W |
| D — Sequence + BiLSTM | Implement reshape to `[B, W, 1024]`, build BiLSTM, print `[B, W, 512]` output shape |
| E — CTC | Implement `nn.CTCLoss` with correct input/target length tensors; implement greedy decoder |
| F — Sanity test | **Before any real training:** one batch → forward pass → CTC loss → backward pass → optimizer step. Also print the full parameter table from §9. Only proceed to Phase G once this is clean. |
| G — Full training | Train on the expanded dataset with the recipe in §10 |
| H — Evaluation | Same fixed 32-image test set as Experiment 4. Report: overall digit accuracy, per-position accuracy (P1–P6, computed by aligning decoded output length to 6 for comparability), full-CAPTCHA accuracy, confusion matrices, adjacent-repeated-digit subset accuracy (§8), and a direct side-by-side comparison table against Experiment 4's numbers |

---

## 13. Complete configuration reference

| Component | Experiment 6 |
|---|---|
| Input | 182×50 RGB |
| Backbone | Pretrained ResNet-18 |
| ResNet layer1–3 | Frozen (eval mode, BatchNorm stats fixed) |
| ResNet layer4 | Trainable |
| Horizontal stride | Modified `(2,2)→(2,1)` in later stage(s) to preserve sequence resolution |
| CNN output | `512 × 2 × W` (target W ≈ 20–25) |
| Sequence | `W × 1024` |
| BiLSTM | 2 layers, hidden 256, bidirectional |
| BiLSTM output | `W × 512` |
| LSTM internal dropout | 0.3 |
| Post-LSTM dropout | 0.3 |
| Classifier | `Linear(512 → 11)` |
| Classes | 0–9 + CTC blank |
| Loss | CTC Loss |
| Decoding | Greedy (collapse repeats, drop blanks) — first pass |
| Backbone LR | 1e-4 |
| BiLSTM LR | 1e-3 |
| Classifier LR | 1e-3 |
| Weight decay | 5e-4 |
| Gradient clipping | 1.0 |
| Scheduler | ReduceLROnPlateau on decoded validation accuracy |
| Train augmentation | RandomAffine + ColorJitter + controlled occlusion |
| Validation/test augmentation | None (resize + normalize only) |
| Test set | Fixed 32 images (unchanged since Experiment 3B) |
| Evaluation | Digit accuracy, P1–P6, full-CAPTCHA accuracy, confusion matrices, repeated-adjacent-digit subset accuracy, vs. Experiment 4 comparison |

---

## 14. The two problems this design attacks, and how

```text
PROBLEM 1 — positional / alignment limitation
  6 independent classification heads, no cross-position context
                          ↓
  high-resolution sequence (W≈20–25) → BiLSTM → CTC
                          ↓
  every position can use its neighbors to resolve occlusion


PROBLEM 2 — overfitting
  large trainable capacity (layer4 + new BiLSTM) vs. small dataset (~2,000–2,400 images)
                          ↓
  more data + augmentation (incl. occlusion-specific) + dropout (0.3×2)
  + weight decay (5e-4) + differential LR + frozen pretrained layers
  + early stopping
```

Both are addressed deliberately and explicitly — the architecture change alone does not solve overfitting, and the regularization stack alone does not solve the positional blindness. Experiment 4 showed both failure modes independently; Experiment 6 is designed against both, not just the one that happens to be more interesting architecturally.

---

## 15. Known risks / what to watch for when results come in

- **This is still a small dataset for a sequence model.** CRNN+CTC systems in the literature are typically trained on tens of thousands to millions of samples. ~2,000–2,400 images is workable given how constrained this problem is (one site, one font, one background), but it does not remove overfitting risk just because the architecture is more sophisticated — watch the same train/val loss divergence signature from Experiment 4 during Phase G, don't assume it's fixed by construction.
- **Check the repeated-adjacent-digit subset specifically** (§8) — this is the one CTC-specific failure mode that won't show up in an aggregate accuracy number.
- **Don't skip Phase F.** Verifying tensor shapes and running one real batch through loss + backward + optimizer step before committing to a full training run is what catches shape mismatches, incorrect CTC input/target length tensors, and stride-modification mistakes cheaply, before spending real training time on them.
- **Compare against Experiment 4 on the same fixed 32-image test set, with the same metrics.** That is the only way to know whether this is a real improvement rather than a different-looking failure.
