"""
Model-agnostic image preprocessing, driven by the preprocessing.json that sits next to
each model (plantellect_model.keras, classes.json, preprocessing.json).

Admin switches model  ->  load that model's preprocessing.json  ->  set_active_config(cfg)
Existing call sites keep working unchanged: preprocess_image(image_bytes) uses the active
config. Pass cfg explicitly (preprocess_image(image_bytes, cfg)) if you hold several models
in memory at once. Nothing about image size, resize method or scaling is hardcoded here.

IMPORTANT: the current models (EfficientNet / ConvNeXtTiny) normalise INSIDE the network,
so the output of preprocess_image() is raw 0-255 float32. Do not divide by 255.
"""
import io
import json
import os
from dataclasses import dataclass
from typing import Tuple

import numpy as np
from PIL import Image

SCHEMA_VERSION = 1
FILENAME = "preprocessing.json"

_RESAMPLE = {
    "nearest": Image.Resampling.NEAREST,
    "bilinear": Image.Resampling.BILINEAR,
    "bicubic": Image.Resampling.BICUBIC,
    "lanczos": Image.Resampling.LANCZOS,
    "box": Image.Resampling.BOX,
    "hamming": Image.Resampling.HAMMING,
}


@dataclass(frozen=True)
class PreprocessConfig:
    model: str
    height: int
    width: int
    resize_method: str
    rescale: float
    mean: Tuple[float, float, float]
    std: Tuple[float, float, float]

    @property
    def input_shape(self) -> Tuple[int, int, int]:
        return (self.height, self.width, 3)


def load_config(path: str) -> PreprocessConfig:
    """Load and validate a preprocessing.json. `path` may be the file or its folder."""
    if os.path.isdir(path):
        path = os.path.join(path, FILENAME)
    try:
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
    except FileNotFoundError:
        raise ValueError(f"preprocessing config not found: {path}")
    except json.JSONDecodeError as e:
        raise ValueError(f"preprocessing config is not valid JSON ({path}): {e}")

    def bad(msg):
        return ValueError(f"invalid preprocessing config {path}: {msg}")

    if raw.get("schema_version") != SCHEMA_VERSION:
        raise bad(f"schema_version must be {SCHEMA_VERSION}, got {raw.get('schema_version')!r}")
    if raw.get("color_mode", "rgb") != "rgb" or raw.get("channels", 3) != 3:
        raise bad("only 3-channel rgb is supported")

    for key in ("height", "width"):
        v = raw.get(key)
        if not isinstance(v, int) or isinstance(v, bool) or v <= 0:
            raise bad(f"{key} must be a positive integer, got {v!r}")

    resize = raw.get("resize") or {}
    method = str(resize.get("method", "")).lower()
    if method not in _RESAMPLE:
        raise bad(f"resize.method must be one of {sorted(_RESAMPLE)}, got {method!r}")
    if resize.get("keep_aspect_ratio", False):
        raise bad("resize.keep_aspect_ratio=true is not supported (models are trained on stretched images)")

    rescale = raw.get("rescale", 1.0)
    if not isinstance(rescale, (int, float)) or isinstance(rescale, bool) or rescale <= 0:
        raise bad(f"rescale must be a positive number, got {rescale!r}")

    def triple(key, default):
        v = raw.get(key, default)
        if not (isinstance(v, list) and len(v) == 3 and all(isinstance(n, (int, float)) for n in v)):
            raise bad(f"{key} must be a list of 3 numbers, got {v!r}")
        return tuple(float(n) for n in v)

    mean = triple("mean", [0.0, 0.0, 0.0])
    std = triple("std", [1.0, 1.0, 1.0])
    if any(s == 0 for s in std):
        raise bad("std must not contain 0")

    return PreprocessConfig(
        model=str(raw.get("model", "")),
        height=raw["height"], width=raw["width"], resize_method=method,
        rescale=float(rescale), mean=mean, std=std,
    )


_active = None


def set_active_config(cfg: PreprocessConfig) -> None:
    """Make `cfg` the default for preprocess_image(). Call it whenever the active model changes."""
    global _active
    _active = cfg


def get_active_config() -> PreprocessConfig:
    if _active is None:
        raise RuntimeError("no preprocessing config is active - call set_active_config(load_config(...)) "
                           "when the model is loaded")
    return _active


def __getattr__(name):
    # Backwards compatibility: old code did `from preprocess import INPUT_SHAPE`.
    if name == "INPUT_SHAPE" and _active is not None:
        return _active.input_shape
    raise AttributeError(name)


def check_model_input(cfg: PreprocessConfig, model_input_shape) -> None:
    """Call once after loading a model: fails loudly if the JSON belongs to another model."""
    h, w = model_input_shape[1], model_input_shape[2]
    if (h, w) != (cfg.height, cfg.width):
        raise ValueError(
            f"preprocessing.json is {cfg.height}x{cfg.width} ({cfg.model}) but the model expects "
            f"{h}x{w}. The wrong preprocessing.json is paired with this model.")


def _prepare(img: Image.Image, cfg: PreprocessConfig) -> np.ndarray:
    if img.mode != "RGB":                      # RGBA, palette, grayscale, CMYK ...
        img = img.convert("RGB")
    img = img.resize((cfg.width, cfg.height), _RESAMPLE[cfg.resize_method])
    arr = np.asarray(img, dtype=np.float32)    # 0-255
    if cfg.rescale != 1.0 or any(cfg.mean) or any(s != 1.0 for s in cfg.std):
        arr = (arr * cfg.rescale - np.asarray(cfg.mean, dtype=np.float32)) / np.asarray(cfg.std, dtype=np.float32)
    return np.expand_dims(arr, axis=0)         # (1, H, W, 3)


def preprocess_image(image_bytes: bytes, cfg: PreprocessConfig = None) -> np.ndarray:
    """Raw image bytes -> float32 array of shape (1, H, W, 3), ready for model.predict()."""
    cfg = cfg or get_active_config()
    try:
        img = Image.open(io.BytesIO(image_bytes))
        img.load()                             # decode now so truncated files fail here
    except Exception as e:
        raise ValueError(f"Invalid image: {str(e)}")
    return _prepare(img, cfg)


def preprocess_image_from_path(image_path: str, cfg: PreprocessConfig = None) -> np.ndarray:
    """Image file path -> float32 array of shape (1, H, W, 3)."""
    cfg = cfg or get_active_config()
    try:
        img = Image.open(image_path)
        img.load()
    except Exception as e:
        raise ValueError(f"Invalid image at {image_path}: {str(e)}")
    return _prepare(img, cfg)