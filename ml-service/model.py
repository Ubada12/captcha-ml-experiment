"""
============================================================
CAPTCHA CRNN — MODEL ARCHITECTURE (SERVING COPY)
============================================================

Defines CaptchaCRNN: the ResNet-18 + BiLSTM + CTC architecture
used to read this project's 6-digit numeric CAPTCHAs.

This is a deliberately separate, inference-only copy of the
architecture that lives in `data/dataset/ml/model.py` (Experiment
6). That copy is for training/research and stays untouched; this
one exists purely so `ml-service` can build the exact same network
shape, load the deployed checkpoint's weights into it, and run
forward passes — nothing here trains, freezes layers on purpose,
or downloads pretrained ImageNet weights (the checkpoint already
contains fully fine-tuned weights, so there's no reason for a
serving process to hit the network for anything).

Architecture, in one line:

    CAPTCHA image (3x50x182)
        -> ResNet-18 backbone (stride-modified to preserve
           horizontal resolution instead of collapsing it)
        -> collapse height only, keep width as the sequence axis
        -> 2-layer bidirectional LSTM
        -> dropout
        -> linear classifier over 11 classes (digits 0-9 + CTC blank)

The output is a (batch, sequence_length, 11) tensor of logits —
decoding that into an actual 6-digit string is `decode.py`'s job,
not this module's.
"""

import torch.nn as nn
from torchvision.models import resnet18

# ============================================================
# Configuration — must match the checkpoint being loaded exactly.
# Kept in sync with data/dataset/ml/model.py by hand; if that
# architecture ever changes, this file and the deployed checkpoint
# both need updating together.
# ============================================================

IMAGE_HEIGHT = 50
IMAGE_WIDTH = 182

NUM_DIGITS = 10
NUM_CLASSES = 11  # 10 digits + 1 CTC blank
CTC_BLANK = 10

LSTM_INPUT_SIZE = 512
LSTM_HIDDEN_SIZE = 256
LSTM_NUM_LAYERS = 2

DROPOUT = 0.30


class CaptchaCRNN(nn.Module):
    """
    ResNet-18 (stride-modified) -> BiLSTM -> CTC classifier.

    Always constructed with pretrained=False here — a serving
    process loads its weights entirely from the deployed
    checkpoint (checkpoint/best_model.pt), so there's nothing for
    ImageNet-pretrained weights to contribute and no reason to
    depend on being able to reach the network at startup.
    """

    def __init__(self, pretrained=False, dropout=DROPOUT):
        super().__init__()

        # --------------------------------------------------
        # ResNet-18 backbone, stride-modified
        # --------------------------------------------------
        # Standard ResNet-18 downsamples 182px width down to
        # roughly 6 positions, too short for CTC to decode a
        # 6-digit sequence reliably. layer3/layer4 strides are
        # changed so horizontal resolution survives instead.
        backbone = resnet18(weights=None if not pretrained else "DEFAULT")

        backbone.layer3[0].conv1.stride = (1, 2)
        backbone.layer3[0].downsample[0].stride = (1, 2)

        backbone.layer4[0].conv1.stride = (1, 1)
        backbone.layer4[0].downsample[0].stride = (1, 1)

        # Drop the original average-pool + fully-connected head —
        # this model reads out through the BiLSTM/classifier below
        # instead of a single-label classifier.
        self.backbone = nn.Sequential(*list(backbone.children())[:-2])

        # --------------------------------------------------
        # Collapse height only — width stays as the sequence
        # (time) dimension the BiLSTM reads across.
        # --------------------------------------------------
        self.height_pool = nn.AdaptiveAvgPool2d((1, None))

        # --------------------------------------------------
        # BiLSTM: 512 features in (one 512-channel feature per
        # horizontal position) -> 512 out (256 hidden x 2
        # directions).
        # --------------------------------------------------
        self.lstm = nn.LSTM(
            input_size=LSTM_INPUT_SIZE,
            hidden_size=LSTM_HIDDEN_SIZE,
            num_layers=LSTM_NUM_LAYERS,
            batch_first=True,
            bidirectional=True,
            dropout=dropout if LSTM_NUM_LAYERS > 1 else 0.0,
        )

        self.dropout = nn.Dropout(p=dropout)

        # 256 forward + 256 backward -> 10 digits + 1 CTC blank
        self.classifier = nn.Linear(LSTM_HIDDEN_SIZE * 2, NUM_CLASSES)

    def forward(self, x):
        """
        Args:
            x: Tensor of shape (B, 3, 50, 182).

        Returns:
            logits: Tensor of shape (B, T, 11), where T is the
                horizontal sequence length (fixed by the
                architecture — 12 for this checkpoint's input
                size, verified at load time by serve.py rather
                than assumed here).
        """
        features = self.backbone(x)  # (B, 512, H, T)
        features = self.height_pool(features)  # (B, 512, 1, T)
        features = features.squeeze(2)  # (B, 512, T)
        features = features.permute(0, 2, 1)  # (B, T, 512)

        sequence, _ = self.lstm(features)  # (B, T, 512)
        sequence = self.dropout(sequence)

        logits = self.classifier(sequence)  # (B, T, 11)
        return logits


def count_parameters(model):
    """Return (total, trainable) parameter counts for logging at startup."""
    total = sum(parameter.numel() for parameter in model.parameters())
    trainable = sum(
        parameter.numel() for parameter in model.parameters() if parameter.requires_grad
    )
    return total, trainable
