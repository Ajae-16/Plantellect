"""SHA-256, difference hash and embeddings. Reads pixels only; no metadata is parsed or kept
(the orientation flag is applied so a rotated copy still matches)."""
import hashlib
import sys

import numpy as np
from PIL import Image, ImageOps

try:  # iPhone photos in a manual import: optional, only if pillow-heif is installed
    from pillow_heif import register_heif_opener
    register_heif_opener()
except Exception:
    pass


def sha256_file(path, buf=1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(buf):
            h.update(chunk)
    return h.hexdigest()


def load_rgb(path, size=None):
    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im).convert("RGB")
        if size:
            im = im.resize(size, Image.Resampling.BILINEAR)
        else:
            im = im.copy()
    return im


def dhash_hex(path) -> str:
    """64-bit difference hash, 16 hex chars."""
    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im).convert("L").resize((9, 8), Image.Resampling.LANCZOS)
    a = np.asarray(im, dtype=np.int16)
    bits = (a[:, 1:] > a[:, :-1]).flatten()
    return f"{int(''.join('1' if b else '0' for b in bits), 2):016x}"


def hamming_hex(a: str, b: str) -> int:
    return bin(int(a, 16) ^ int(b, 16)).count("1")


class ThumbEmbedder:
    """Weak fallback (16x16 colour thumbnail). Only for tests or when TensorFlow is missing."""
    name = "thumb16"
    size = (16, 16)
    degraded = True

    def __call__(self, batch_uint8):
        v = batch_uint8.reshape(len(batch_uint8), -1).astype("float32")
        v -= v.mean(axis=1, keepdims=True)
        return v / (np.linalg.norm(v, axis=1, keepdims=True) + 1e-9)


class MobileNetEmbedder:
    """MobileNetV3Large, ImageNet weights, global-average-pooled, L2-normalised."""
    name = "mobilenetv3large"
    size = (224, 224)
    degraded = False

    def __init__(self, weights="imagenet"):
        import tensorflow as tf
        self.tf = tf
        self.model = tf.keras.applications.MobileNetV3Large(
            input_shape=(224, 224, 3), include_top=False, weights=weights, pooling="avg")

    def __call__(self, batch_uint8):
        x = self.tf.keras.applications.mobilenet_v3.preprocess_input(batch_uint8.astype("float32"))
        v = self.model.predict(x, verbose=0)
        return v / (np.linalg.norm(v, axis=1, keepdims=True) + 1e-9)


def make_embedder(kind="auto", weights="imagenet"):
    """auto: MobileNet if it loads, else the weak fallback (the report says which was used)."""
    if kind == "thumb":
        return ThumbEmbedder()
    try:
        return MobileNetEmbedder(weights)
    except Exception as e:
        if kind == "mobilenet":
            raise
        print(f"[warn] MobileNetV3Large unavailable ({e}); using the weak thumbnail embedder.", file=sys.stderr)
        return ThumbEmbedder()
