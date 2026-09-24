"""
============================================================
PREPROCESSING — BASE64 CAPTCHA IMAGE -> MODEL INPUT TENSOR
============================================================

Converts the raw base64 PNG that Node's captcha/capture.js
screenshots straight into the exact tensor shape/normalization
CaptchaCRNN expects.

This deliberately mirrors the EVALUATION_TRANSFORM in
data/dataset/ml/dataset.py — resize, to-tensor, ImageNet
normalize, no augmentation — because a live CAPTCHA being solved
is evaluation-time data, not training data. Nothing here is
copied wholesale from that file; it's the same three well-defined
steps re-stated for a single incoming image instead of a batch
loaded from disk, so this module has no dependency on
data/dataset/ml/ at all.
"""

import base64
import io

import torch
from PIL import Image
from torchvision import transforms

from model import IMAGE_HEIGHT, IMAGE_WIDTH

# ImageNet normalization statistics — the backbone is a
# (originally) ImageNet-pretrained ResNet-18, so inference must
# normalize the same way training did.
IMAGE_NET_MEAN = [0.485, 0.456, 0.406]
IMAGE_NET_STD = [0.229, 0.224, 0.225]

# Resize -> tensor -> normalize. No augmentation — this path only
# ever sees real CAPTCHAs being solved for real, never training data.
INFERENCE_TRANSFORM = transforms.Compose(
    [
        transforms.Resize((IMAGE_HEIGHT, IMAGE_WIDTH)),
        transforms.ToTensor(),
        transforms.Normalize(mean=IMAGE_NET_MEAN, std=IMAGE_NET_STD),
    ]
)


class InvalidImageError(ValueError):
    """Raised when the incoming base64 payload isn't a decodable image."""


def decode_base64_image(image_base64: str) -> Image.Image:
    """
    Decode a base64-encoded PNG (as produced by Puppeteer's
    `element.screenshot({ encoding: "base64" })`) into a PIL image.

    Raises InvalidImageError with a clear message on anything
    malformed, rather than letting a cryptic PIL/base64 traceback
    bubble up to the HTTP layer.
    """
    try:
        raw_bytes = base64.b64decode(image_base64, validate=True)
    except Exception as error:
        raise InvalidImageError(f"Could not base64-decode image payload: {error}") from error

    try:
        image = Image.open(io.BytesIO(raw_bytes))
        image.load()
    except Exception as error:
        raise InvalidImageError(f"Decoded bytes are not a readable image: {error}") from error

    return image.convert("RGB")


def image_to_tensor(image: Image.Image) -> torch.Tensor:
    """
    Apply the inference transform and add the batch dimension the
    model's forward() expects.

    Returns a tensor of shape (1, 3, 50, 182).
    """
    tensor = INFERENCE_TRANSFORM(image)
    return tensor.unsqueeze(0)


def prepare_input(image_base64: str) -> torch.Tensor:
    """Convenience wrapper: base64 string straight to a model-ready tensor."""
    image = decode_base64_image(image_base64)
    return image_to_tensor(image)
