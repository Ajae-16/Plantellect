"""SHA-256, difference hash and embeddings. Reads pixels only; no metadata is parsed or kept
(the orientation flag is applied so a rotated copy still matches)."""
import datetime
import hashlib
import os
import re
import sys
from pathlib import Path

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


# ---------------------------------------------------------------------------------------------------------------
# Saved (trained) models as embedders
# ---------------------------------------------------------------------------------------------------------------
# The website's own trained models live in <MODEL_ROOT>/<model_id>/{plantellect_model.keras, preprocessing.json,
# classes.json}. A model trained on the project's plants "sees" plants far better than ImageNet MobileNet does, so
# it can be used as the embedder too: the photo is run through the network and the vector is the input of the final
# classifier layer (the same global-pooled features the classifier decides from), L2-normalised.
#
# The embedder's name carries the model id and the model file's date. Vectors are cached by (photo, embedder name),
# so a retrained model gets a new name and its photos are embedded again, never mixed with the old vectors.

MODEL_FILE = "plantellect_model.keras"
MODEL_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
BUILTIN_KINDS = ("auto", "mobilenet", "thumb", "saved")


def model_root() -> Path:
    return Path(os.getenv("MODEL_ROOT", "/app/model"))


def default_model_id() -> str:
    return os.getenv("DATASET_MODEL_ID") or os.getenv("DEFAULT_MODEL_ID") or "efficientnetv2b1"


def parse_kind(kind: str) -> str:
    """'auto' | 'mobilenet' | 'thumb' | 'saved' | 'model:<id>' -> the same string, cleaned. Raises ValueError otherwise."""
    k = str(kind or "").strip()
    if k.lower() in BUILTIN_KINDS:
        return k.lower()
    if k.lower().startswith("model:"):
        model_id = k[6:].strip()
        if MODEL_ID.match(model_id):
            return f"model:{model_id}"
    raise ValueError(f"unknown embedder '{kind}' (use auto, mobilenet, thumb, saved or model:<model id>)")


def find_embedding_tensor(layers):
    """The tensor that feeds the classifier head: the input of the LAST Dense layer.

    Trailing Softmax / Activation / Dropout layers are skipped on the way back. Raises ValueError when no Dense layer
    exists (a model that is not a classifier has nothing to cut). Works on any object list with .input and a class
    name, so it can be tested without TensorFlow."""
    for layer in reversed(list(layers)):
        kind = type(layer).__name__
        if kind == "Dense":
            tensor = getattr(layer, "input", None)
            if tensor is None:
                break
            return tensor
        if kind in ("Softmax", "Activation", "Dropout"):
            continue
        break
    raise ValueError("this model has no final Dense layer to take features from")


class SavedModelEmbedder:
    """One of the website's trained models, cut before its classifier. See the notes above."""
    degraded = False

    def __init__(self, model_id, root=None):
        if not MODEL_ID.match(str(model_id or "")):
            raise ValueError(f"bad model id: {model_id!r}")
        root = Path(root) if root else model_root()
        folder = (root / model_id).resolve()
        if root.resolve() not in folder.parents:
            raise ValueError(f"bad model id: {model_id!r}")
        model_path = folder / MODEL_FILE
        if not model_path.is_file():
            raise FileNotFoundError(f"model '{model_id}' has no {MODEL_FILE} in {root}")
        import tensorflow as tf
        self.tf = tf
        from preprocess import load_config            # the service's own preprocessing reader (same folder as dataset_tools)
        self.cfg = load_config(str(folder))
        model = tf.keras.models.load_model(str(model_path), compile=False)
        self.model = tf.keras.Model(inputs=model.inputs, outputs=find_embedding_tensor(model.layers))
        self.size = (self.cfg.width, self.cfg.height)  # PIL wants (width, height)
        stamp = datetime.datetime.fromtimestamp(model_path.stat().st_mtime, datetime.timezone.utc)
        self.model_id = model_id
        self.name = f"model-{model_id}-{stamp.strftime('%Y%m%d%H%M')}"

    def __call__(self, batch_uint8):
        x = batch_uint8.astype("float32")
        cfg = self.cfg
        if cfg.rescale != 1.0 or any(cfg.mean) or any(s != 1.0 for s in cfg.std):
            x = (x * cfg.rescale - np.asarray(cfg.mean, dtype="float32")) / np.asarray(cfg.std, dtype="float32")
        v = np.asarray(self.model.predict(x, batch_size=16, verbose=0), dtype="float32")
        if v.ndim > 2:                                 # a feature map, not a vector: average over the picture
            v = v.mean(axis=tuple(range(1, v.ndim - 1)))
        return v / (np.linalg.norm(v, axis=1, keepdims=True) + 1e-9)


def list_embedders(root=None):
    """What can be chosen: the two built-in embedders and every model folder that holds a model file."""
    root = Path(root) if root else model_root()
    out = [
        {"kind": "mobilenet", "label": "MobileNetV3 (ImageNet, general purpose)", "degraded": False, "builtin": True},
        {"kind": "thumb", "label": "Thumbnail (very weak, tests only)", "degraded": True, "builtin": True},
    ]
    try:
        folders = sorted(p for p in root.iterdir() if p.is_dir() and (p / MODEL_FILE).is_file() and MODEL_ID.match(p.name))
    except OSError:
        folders = []
    for p in folders:
        out.append({"kind": f"model:{p.name}", "label": f"Saved model: {p.name}", "degraded": False, "builtin": False,
                    "modelId": p.name})
    return out


def make_embedder(kind="auto", weights="imagenet", root=None):
    """auto: MobileNet if it loads, else the weak fallback (the report says which was used).
    mobilenet / thumb: exactly that one. saved: the default saved model. model:<id>: that saved model.
    An embedder that was asked for by name is never replaced silently: only 'auto' falls back."""
    kind = parse_kind(kind)
    if kind == "thumb":
        return ThumbEmbedder()
    if kind == "saved":
        return SavedModelEmbedder(default_model_id(), root)
    if kind.startswith("model:"):
        return SavedModelEmbedder(kind[6:], root)
    try:
        return MobileNetEmbedder(weights)
    except Exception as e:
        if kind == "mobilenet":
            raise
        print(f"[warn] MobileNetV3Large unavailable ({e}); using the weak thumbnail embedder.", file=sys.stderr)
        return ThumbEmbedder()
