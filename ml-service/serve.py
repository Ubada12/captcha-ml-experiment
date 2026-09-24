"""
============================================================
ML-SERVICE — CAPTCHA INFERENCE API
============================================================

A small, always-on FastAPI service that keeps the trained CRNN+CTC
CAPTCHA model loaded in memory and answers prediction requests over
plain HTTP. This is the ONLY thing captcha/own-model-solver.js
(the Node side) talks to — it never imports Python or the model
directly.

Why a standing service instead of spawning a Python process per
CAPTCHA: the checkpoint is ~150MB and loading it takes real time.
Reloading it on every single lookup would add several seconds to
every attempt and defeat the entire point of solving CAPTCHAs
locally instead of paying for 2Captcha. Loading it once at startup
and keeping it warm is the whole design.

Endpoints:

    GET  /health
        Liveness + whether the model actually finished loading.
        No auth — this service is only ever reachable from
        localhost, called by the Node app running on the same
        machine, same trust boundary as calling 2Captcha's API
        used to be simpler (this is simpler still: nothing here
        leaves the machine at all).

    POST /predict
        body: { "image_base64": "<base64 PNG>" }
        Runs one CAPTCHA image through the model and returns the
        decoded text plus a full confidence breakdown. Does NOT
        decide whether the prediction is "good enough" to use —
        that threshold decision belongs to the Node side
        (captcha/own-model-solver.js), which knows about retries,
        fallback policy, and config. This service's only job is:
        given an image, what does the model think, and how sure
        does it look.

Run with:
    uvicorn serve:app --host 127.0.0.1 --port 8001

(the default port matches config.ownModelSolver.serviceUrl's
default in config/config.js — see that file if this ever needs to
run on a different port.)
"""

import logging
import time
from pathlib import Path

import torch
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from decode import decode_with_confidence
from model import CaptchaCRNN, count_parameters
from preprocess import InvalidImageError, prepare_input

# ============================================================
# Logging — colorized, matches the spirit of the Node side's
# pino-pretty terminal output so both processes read the same
# way in a terminal/screen session.
# ============================================================

_LEVEL_COLORS = {
    logging.DEBUG: "\033[34m",  # blue
    logging.INFO: "\033[36m",  # cyan
    logging.WARNING: "\033[33m",  # yellow
    logging.ERROR: "\033[31m",  # red
}
_RESET = "\033[0m"


class _ColorFormatter(logging.Formatter):
    def format(self, record):
        color = _LEVEL_COLORS.get(record.levelno, "")
        prefix = f"{color}[{record.levelname}]{_RESET}"
        timestamp = self.formatTime(record, "%H:%M:%S")
        return f"[{timestamp}] {prefix} {record.getMessage()}"


handler = logging.StreamHandler()
handler.setFormatter(_ColorFormatter())

logger = logging.getLogger("ml-service")
logger.setLevel(logging.INFO)
logger.addHandler(handler)
logger.propagate = False

# ============================================================
# Configuration
# ============================================================

SERVICE_DIR = Path(__file__).resolve().parent
CHECKPOINT_PATH = SERVICE_DIR / "checkpoint" / "best_model.pt"

# ============================================================
# Model loading — happens once, at import time, so the very
# first request doesn't pay a multi-second cold-start cost.
# ============================================================

_device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
_model = None
_model_load_error = None


def _load_model():
    global _model, _model_load_error

    logger.info(f"Loading CAPTCHA model onto device: {_device}")

    if not CHECKPOINT_PATH.exists():
        raise FileNotFoundError(
            f"Deployed checkpoint not found at {CHECKPOINT_PATH}. "
            "Copy a trained best_model.pt into ml-service/checkpoint/ before starting this service."
        )

    model = CaptchaCRNN(pretrained=False)

    checkpoint = torch.load(CHECKPOINT_PATH, map_location=_device)
    model.load_state_dict(checkpoint["model_state_dict"])

    model = model.to(_device)
    model.eval()  # inference only — no dropout, no BatchNorm updates

    # Note: this serving copy never sets requires_grad=False anywhere
    # (there's no training happening here), so count_parameters()'s
    # "trainable" figure would just equal the total and isn't
    # meaningful in this context — only the total is logged.
    total_params, _ = count_parameters(model)
    logger.info(f"Model loaded. Total parameters: {total_params:,}.")

    checkpoint_epoch = checkpoint.get("epoch")
    if checkpoint_epoch is not None:
        logger.info(f"Checkpoint metadata: trained through epoch {checkpoint_epoch}.")

    return model


try:
    _model = _load_model()
    logger.info("ml-service is ready to accept /predict requests.")
except Exception as error:  # noqa: BLE001 — deliberately broad: we want /health to report ANY load failure
    _model_load_error = str(error)
    logger.error(f"Model failed to load at startup: {error}")
    logger.error("The service will start, but /predict will return 503 until this is fixed.")


# ============================================================
# FastAPI app
# ============================================================

app = FastAPI(title="captcha-ml-service", version="1.0.0")


class PredictRequest(BaseModel):
    image_base64: str


class PredictResponse(BaseModel):
    text: str
    length_ok: bool
    avg_confidence: float
    min_confidence: float
    per_char_confidence: list
    raw_sequence_length: int
    inference_ms: float


@app.get("/health")
def health():
    return {
        "status": "ok" if _model is not None else "model_not_loaded",
        "model_loaded": _model is not None,
        "device": str(_device),
        "load_error": _model_load_error,
    }


@app.post("/predict", response_model=PredictResponse)
def predict(request: PredictRequest):

    if _model is None:
        logger.error("Rejected /predict request — model never finished loading.")
        return JSONResponse(
            status_code=503,
            content={"error": "Model is not loaded. Check /health for details."},
        )

    start_time = time.monotonic()

    try:
        input_tensor = prepare_input(request.image_base64)
    except InvalidImageError as error:
        logger.warning(f"Rejected /predict request — bad image payload: {error}")
        return JSONResponse(status_code=400, content={"error": str(error)})

    input_tensor = input_tensor.to(_device)

    with torch.no_grad():
        logits = _model(input_tensor)

    prediction = decode_with_confidence(logits)

    inference_ms = (time.monotonic() - start_time) * 1000

    # Deliberately does NOT log the predicted digits themselves —
    # same discipline captcha/solver.js already applies to 2Captcha's
    # answer. Confidence numbers and timing are useful operational
    # signal on their own and don't reveal the actual CAPTCHA text.
    logger.info(
        f"Predicted in {inference_ms:.1f}ms | "
        f"length_ok={prediction.length_ok} | "
        f"avg_confidence={prediction.avg_confidence:.3f} | "
        f"min_confidence={prediction.min_confidence:.3f}"
    )

    return PredictResponse(
        text=prediction.text,
        length_ok=prediction.length_ok,
        avg_confidence=prediction.avg_confidence,
        min_confidence=prediction.min_confidence,
        per_char_confidence=prediction.per_char_confidence,
        raw_sequence_length=prediction.raw_sequence_length,
        inference_ms=inference_ms,
    )
