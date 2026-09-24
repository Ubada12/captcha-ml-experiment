# Experiment 6 — Execution Roadmap (Locked)

**Companion to:** `Experiment_6_CRNN_CTC_Specification.md` (the architecture/training source of truth)
**This document is:** the phase-by-phase execution plan — what gets built in what order, what must be proven true before moving to the next phase, and why each gate exists.
**Rule:** phases run strictly in order. No phase starts before the previous phase's gate passes. No architecture change mid-implementation without discussing it first.

---

## Why this document exists

Experiment 4 failed for two separable reasons — overfitting and a structural inability to use cross-position context — and both were only discovered *after* a full training run had already completed. That's an expensive way to find a bug. This roadmap exists to catch problems at the cheapest possible point: a shape mismatch gets caught in Phase F1 in seconds, instead of surfacing as a confusing accuracy number after hours of training in Phase G. Every gate below exists to stop a specific, previously-seen category of mistake from reaching full training.

---

## The 9 rules

These apply across every phase, not just one:

1. **Don't change the locked architecture without discussing it first.** The specification in the companion MD is frozen. If something in Phase C or D reveals it needs to change, that's a discussion, not a silent edit.
2. **Don't touch the fixed 32-image test set.** It's the only thing that makes Experiment 6's numbers comparable to Experiment 4's. It has already survived three experiments untouched — it survives this one too.
3. **Don't augment validation/test.** Augmentation is a training-only regularizer. Applying it to val/test would make the accuracy numbers measure something other than real generalization.
4. **Don't launch full training before F1 passes.** F1 is the cheap, fast check. Full training is the expensive, slow one. Never let the expensive step catch a bug the cheap step could have caught.
5. **Don't launch full training if F2 cannot learn a tiny set.** If the model can't memorize 8–32 samples, the problem is a wiring/data/loss bug, not a generalization problem — and no amount of full-dataset training time will fix a bug.
6. **Print actual tensor shapes and parameter counts; don't trust estimates.** The specification's parameter numbers (BiLSTM ≈3.4M, etc.) are planning estimates. The real numbers, printed by the code, are what decide whether the model is reasonably sized for the dataset.
7. **Don't judge Experiment 6 from training accuracy.** Experiment 4's training accuracy hit 100% and meant nothing about real performance. Validation/test numbers on the fixed set are the only numbers that count.
8. **Use the same test set and metrics for comparison.** Same 32 images, same digit/per-position/full-CAPTCHA accuracy definitions, same confusion-matrix format as Experiment 4 — otherwise "better" or "worse" isn't a real claim.
9. **Don't declare CRNN+CTC better until the measured results say so.** The architecture is well-reasoned and targets a real, diagnosed weakness — but reasoning is not a result. Phase J's numbers are what actually decide this.

---

## Status tracker

| Phase | Description | Status |
|---|---|---|
| A | Dataset finalization | ⏳ In progress |
| B | `dataset.py` | ⏸ Waiting |
| C | `model.py` | ⏸ Waiting |
| D | Parameter audit | ⏸ Waiting |
| E | CTC loss + greedy decoder | ⏸ Waiting |
| F1 | Engineering sanity test | ⏸ Waiting |
| F2 | Tiny-set learning test | ⏸ Waiting |
| G | Full training | ⏸ Waiting |
| H | Best checkpoint + inference | ⏸ Waiting |
| I | Final evaluation | ⏸ Waiting |
| J | Experiment 4 vs. Experiment 6 | ⏸ Waiting |

*(Update this table as each gate passes — paste results back and it gets marked ✅ here.)*

---

## Phase A — Finalize & verify dataset

**Status:** ⏳ Waiting for extraction to finish

**Why this phase exists:** every downstream phase assumes the dataset is clean. A silent duplicate image, a mislabeled sample, or accidental overlap between train and test would quietly invalidate every result that follows — and would be far harder to detect once training is underway than right now, before anything is built.

**Tasks:**
1. Finish extracting the new CAPTCHA samples.
2. Merge them into the canonical dataset.
3. Verify: image count, label count, unique IDs, unique image paths, every image file actually exists on disk, every label is exactly 6 digits.
4. Verify the fixed 32-image test set is present and correct.
5. Confirm those 32 images are byte-for-byte untouched since Experiment 3B/4.
6. Create the final train/validation split.
7. Confirm zero overlap between train, validation, and test.
8. Record the final counts.

**Expected, approximately** (actual counts win over this estimate):
```text
Total       ≈ 2,400
Train       ≈ 2,120
Validation  ≈ 250
Test        = 32
```

**🚫 Gate:** Do not implement or train against the expanded dataset until every check above passes.

---

## Phase B — Implement `dataset.py`

**Why this phase exists:** augmentation and data-loading bugs are among the hardest to diagnose once mixed in with model training — a mislabeled tensor shape or a transform applied to the wrong split can look exactly like a model or architecture problem. Isolating and testing this layer alone, before `model.py` exists, means any bug found here is unambiguously a data problem, not a model problem.

**Build:**
```text
CaptchaDataset
    ↓
train transform   → validation transform   → test transform
```

**Train augmentation** (settings locked in the specification):
```text
Resize → RandomAffine → ColorJitter → Controlled occlusion → ToTensor → ImageNet Normalize
```

**Validation/Test:**
```text
Resize → ToTensor → Normalize          (no augmentation)
```

**Tests to run:**
- Confirm `train image → [3, 50, 182]`, `val image → [3, 50, 182]`, `test image → [3, 50, 182]`.
- Confirm every target decodes to exactly six digits.
- Visually inspect several augmented training samples — confirm the digits are still legible and recognizably the correct labels (this is the manual check that catches an augmentation range set too aggressively, before it wastes a training run).

**🚫 Gate:**
```text
Dataset loading       ✅
Labels correct        ✅
Augmentation correct  ✅
Validation clean      ✅
Test clean            ✅
```
All five must hold before touching `model.py`.

---

## Phase C — Implement `model.py`

**Why this phase exists:** this is the architecture itself, exactly as frozen in the specification. Nothing here should be a new decision — it's a faithful implementation of what's already been decided, which is precisely what makes Phase D (the audit) meaningful as a check rather than a formality.

**1. ResNet-18 backbone**
```text
Pretrained ResNet-18

stem       ❄️ frozen
layer1     ❄️ frozen
layer2     ❄️ frozen
layer3     ❄️ frozen
layer4     🔥 trainable
```
Frozen layers stay in `eval()` mode throughout training so their BatchNorm running statistics don't drift from a small-batch training loop.

**2. Modify horizontal stride** — target `[B, 512, 2, W]` with `W ≈ 20–25`, achieved by changing the later `(2,2)` downsampling to `(2,1)` so width resolution is preserved while height still collapses. (Full reasoning and the CTC timestep-budget math behind this number are in the specification, §5.1.)

**3. CNN → sequence:** `[B, 512, 2, W] → [B, W, 1024]`

**4. BiLSTM:** 2 layers, hidden=256, bidirectional=True, dropout=0.3 → output `[B, W, 512]`

**5. Classifier:** `Dropout(0.3) → Linear(512 → 11)`, classes `0 1 2 3 4 5 6 7 8 9 BLANK`

Nothing in this phase is a new decision — it's a faithful build of what's already locked in the specification.

---

## Phase D — Parameter audit

**Why this phase exists:** Experiment 4's overfitting happened with 8.4M trainable parameters against 1,235 images. Experiment 6 adds a BiLSTM on top of that same backbone — an estimated ~3.4M more trainable parameters. Whether that total is reasonable for ~2,120 training images is exactly the kind of question that must be answered with a real printed number, not a plan-time estimate, before a single epoch is run.

**`model.py` must print, before any training:**
```text
Total parameters
Trainable parameters
Frozen parameters
```
and per-component:
```text
ResNet total | ResNet frozen | ResNet layer4
BiLSTM layer 1 | BiLSTM layer 2
Classifier
```

**Also verify explicitly:**
```text
stem       frozen        layer4     trainable
layer1     frozen        BiLSTM     trainable
layer2     frozen        classifier trainable
layer3     frozen
```

The specification's BiLSTM estimate (~3.4M) is a planning figure only — the runtime count is what's trusted.

**🚫 Gate:** parameter accounting must be printed and confirmed correct before Phase E.

---

## Phase E — Implement CTC

**Why this phase exists:** CTC is the one genuinely new piece of machinery in this whole project — everything else (CNN, LSTM, dropout) is standard supervised learning, but `nn.CTCLoss`'s tensor shape contract (`log_probs`, `targets`, `input_lengths`, `target_lengths`, all as distinct correctly-shaped tensors) is a common, easy place to introduce a subtle bug that still runs without crashing but trains on the wrong thing.

**Implement:**
```text
nn.CTCLoss
```
with correctly constructed `log_probs`, `targets`, `input_lengths`, `target_lengths`.

**Implement the first decoder — greedy, not beam search:**
```text
argmax per timestep → collapse consecutive repeats → remove BLANK → final string
```
Greedy decoding first is deliberate — it's simpler to verify correct, and beam search is an optimization to add later only if greedy proves to be the accuracy bottleneck, not a prerequisite for a first working version.

---

## Phase F1 — Engineering sanity test

**This is not training.** It's one batch, run once, to confirm every piece is wired together correctly.

**Why this phase exists:** this is the cheapest possible place to catch a shape mismatch, a wrong-dtype tensor, a frozen layer that's accidentally receiving gradients, or a CTC input/target length that's off by one. Every one of these failure modes is trivial to fix here and expensive to diagnose after Phase G has already run for hours.

**Run one batch through:**
```text
Dataset → augmentation → ResNet → sequence → BiLSTM → classifier → CTC loss → backward → optimizer.step()
```

**Verify every one of these explicitly:**
```text
Input shape                  ✅
CNN shape                    ✅
Actual W                     ✅
Sequence shape               ✅
BiLSTM shape                 ✅
Logit shape                  ✅
CTC loss finite              ✅
No NaN/Inf                   ✅
Backward succeeds            ✅
Trainable gradients exist    ✅
Frozen gradients absent      ✅
Optimizer step succeeds      ✅
Trainable parameters update  ✅
Frozen parameters unchanged  ✅
```

**🚫 Gate:** if anything on this list fails, stop and fix it. Do not proceed to F2 or G with an unresolved failure here.

---

## Phase F2 — Tiny-set learning test

**Why this phase exists:** this is the single most valuable cheap check in the whole roadmap. A model with millions of parameters should be able to memorize a tiny handful of examples trivially — if it can't, the problem is guaranteed to be a wiring, data, or loss-construction bug, not a generalization problem, and no amount of full-dataset training time will fix a bug that shows up here. This check isolates "is the machinery correct" from "does it generalize," which are two completely different questions that Experiment 4 never got to separate cleanly.

**Take 8–32 training samples. Train repeatedly on only those samples.**

The goal is **not** generalization — it's answering one question: *can the model actually learn these specific samples at all?*

**Watch for:**
```text
CTC loss           → generally decreasing
Decoded predictions → starting to become correct on this tiny set
```

**If the model cannot learn even this tiny set, stop and investigate:**
```text
CTC target construction
Sequence length (W too small?)
Decoder logic
Learning rates
Tensor ordering
Augmentation (too aggressive, corrupting labels?)
Model wiring
```

**🚫 Gate:** tiny-set learning must behave sensibly before Phase G.

---

## Phase G — Full Experiment 6 training

**Why this phase exists:** this is the actual experiment — everything before this point exists to make sure that when this run happens, any problem in the result is a real finding about the architecture or dataset, not a bug that should have been caught earlier.

**Dataset:** the full expanded set, ≈2,400 samples.

**Training recipe** (from the specification):
```text
ResNet layer4 LR = 1e-4
BiLSTM LR        = 1e-3
Classifier LR    = 1e-3

Weight decay     = 5e-4
Gradient clip    = 1.0

LSTM dropout     = 0.3
Post-LSTM        = 0.3
```

**Scheduler:** `ReduceLROnPlateau`, with early stopping following the same patience/min-delta philosophy locked in the specification.

**Monitor throughout:**
```text
Train CTC loss
Validation CTC loss
Validation decoded digit accuracy
Validation full-CAPTCHA accuracy
```

Specifically watch for the same train/validation divergence pattern that appeared in Experiment 4 (train loss falling to near-zero while validation loss rises) — the regularization stack is designed to prevent it, but that's a claim to verify against the actual curves, not assume.

---

## Phase H — Best checkpoint & inference

Save the best model by the chosen validation criterion, then run inference as a separate step:
```text
best_model.pt → inference.py → 32 fixed test images → greedy CTC decoder → predictions.csv
```

Keeping inference separate from training (as Experiment 4 already did) preserves the discipline of only evaluating the test set after model selection is finalized, never during training.

---

## Phase I — Final evaluation

**Same exact 32 images, no exceptions.**

Calculate:
```text
Overall digit accuracy
P1  P2  P3  P4  P5  P6
Full CAPTCHA accuracy
Confusion matrices
```

**Plus one addition specific to this architecture:** accuracy on the **adjacent repeated-digit subset** (labels like `112957`), tracked separately. This is the one CTC-specific failure mode that can hide inside an otherwise-healthy aggregate number, so it gets its own line rather than being folded into the overall average.

---

## Phase J — Experiment 4 vs. Experiment 6

```text
                    EXP 4        EXP 6
─────────────────────────────────────────
Digit accuracy      61.46%       ?
Full CAPTCHA        6.25%        ?
P1                  100%         ?
P2                  50%          ?
P3                  21.88%       ?
P4                  43.75%       ?
P5                  84.38%       ?
P6                  68.75%       ?
```

**Why this phase exists, and what it's actually for:** the point of Experiment 6 was never just "get a higher digit accuracy number" — it was to test a specific hypothesis, that the position-3/4 collapse in Experiment 4 was caused by the independent-heads architecture's inability to use cross-position context. So the real question in this phase isn't just whether the headline numbers went up — it's whether **P3 and P4 specifically** closed the gap with P1/P5/P6. If they did, that's direct evidence the BiLSTM+CTC context mechanism is doing what it was designed to do. If the headline number improves but P3/P4 are still the worst positions by a wide margin, that's evidence the positional weakness has a different cause than diagnosed, and the architecture change didn't address it — a result worth knowing plainly, not one to explain away.

Inspect where the errors moved, not just the headline number, before drawing any conclusion.
