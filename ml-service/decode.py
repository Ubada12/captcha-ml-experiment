"""
============================================================
CTC GREEDY DECODING + PER-CHARACTER CONFIDENCE SCORING
============================================================

Turns the model's raw (1, T, 11) logits into an actual predicted
digit string, plus a confidence breakdown the pipeline can use to
decide whether to trust that prediction at all.

Decoding itself (argmax per timestep -> drop CTC blanks -> collapse
consecutive repeats) mirrors data/dataset/ml/inference.py's
ctc_greedy_decode exactly, since that's the same well-tested logic
Experiment 6 was evaluated with — no reason to invent a different
decoder for serving. What's new here is confidence: at the exact
timestep each character survives into the decoded output, this
also records the softmax probability the model assigned to that
winning class, so the caller gets a per-character confidence trail,
not just a bare string.

Two summary numbers matter more than the full per-character list:

    avg_confidence — mean confidence across decoded characters.
    min_confidence — the single weakest character.

min_confidence is the more important guard: a six-digit CAPTCHA
lookup fails completely on a single wrong digit, so five very
confident characters and one shaky one should read as an overall
LOW-confidence prediction, not a high one — averaging alone would
hide exactly that case.
"""

from dataclasses import dataclass, field

import torch

from model import CTC_BLANK, NUM_DIGITS

EXPECTED_CAPTCHA_LENGTH = 6


@dataclass
class DecodedPrediction:
    """Everything the caller needs to decide whether to trust a prediction."""

    text: str  # e.g. "358025", or "" if nothing was decoded
    digits: list = field(default_factory=list)  # e.g. [3, 5, 8, 0, 2, 5]
    per_char_confidence: list = field(default_factory=list)  # same length as `digits`
    avg_confidence: float = 0.0
    min_confidence: float = 0.0
    raw_sequence_length: int = 0  # T — the model's timestep count, for diagnostics
    length_ok: bool = False  # True only if exactly 6 digits were decoded


def decode_with_confidence(logits: torch.Tensor) -> DecodedPrediction:
    """
    Args:
        logits: Tensor of shape (1, T, 11) — a single sample's raw
            model output (batch dimension of exactly 1).

    Returns:
        A DecodedPrediction with the decoded string and its
        confidence breakdown.
    """
    if logits.dim() != 3 or logits.shape[0] != 1:
        raise ValueError(
            f"decode_with_confidence expects a (1, T, 11) tensor, got {tuple(logits.shape)}."
        )

    probabilities = torch.softmax(logits[0], dim=-1)  # (T, 11)
    raw_sequence_length = probabilities.shape[0]

    winning_classes = probabilities.argmax(dim=-1).tolist()  # length T
    winning_probabilities = probabilities.max(dim=-1).values.tolist()  # length T

    digits = []
    per_char_confidence = []
    previous = CTC_BLANK

    for timestep, token in enumerate(winning_classes):

        if token == CTC_BLANK:
            previous = CTC_BLANK
            continue

        # CTC collapse rule: a repeated non-blank token only counts
        # once, unless a blank separated the repeats.
        if token != previous:
            digits.append(token)
            per_char_confidence.append(winning_probabilities[timestep])

        previous = token

    text = "".join(str(digit) for digit in digits)

    avg_confidence = sum(per_char_confidence) / len(per_char_confidence) if per_char_confidence else 0.0
    min_confidence = min(per_char_confidence) if per_char_confidence else 0.0

    prediction = DecodedPrediction(
        text=text,
        digits=digits,
        per_char_confidence=per_char_confidence,
        avg_confidence=avg_confidence,
        min_confidence=min_confidence,
        raw_sequence_length=raw_sequence_length,
        length_ok=(len(digits) == EXPECTED_CAPTCHA_LENGTH),
    )

    # This can never actually fail given the collapse loop above (only
    # non-blank tokens 0-9 are ever appended to `digits`) — it's a
    # defense-in-depth trip-wire for a future refactor that breaks that
    # guarantee, not a check anyone expects to fire today. It was
    # previously written but never called, which made it dead code and
    # gave zero real protection; wiring it in here is what actually
    # makes it useful.
    _sanity_check_digit_range(prediction)

    return prediction


def _sanity_check_digit_range(prediction: DecodedPrediction) -> None:
    """Defensive check — every decoded digit must be a real digit (0-9), never the blank class."""
    for digit in prediction.digits:
        if not (0 <= digit < NUM_DIGITS):
            raise AssertionError(f"Decoded an out-of-range digit: {digit}")
