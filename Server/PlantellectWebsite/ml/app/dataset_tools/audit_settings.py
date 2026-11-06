"""The audit's quick settings: which embedder compares the photos, and the two similarity thresholds.

One source of truth, read by the audit itself every time it starts:
  * the embedder is the admin's choice file (embedder.json, see vectors.py), the same one the Other plant tools use,
    so the page can never show one model while the audit uses another;
  * the thresholds are cos_similar / cos_same in <index dir>/config.json (see config.py DEFAULTS).
The Dataset page's quick row and the Settings page's Dataset Audit section are two editors of these same values.

A change applies to the NEXT audit. A running audit has already read them, and old reports keep the values they used.
Only the keys that are changed are written, so anything else an admin put in config.json is kept.
"""
import json
from pathlib import Path

from .config import DEFAULTS, atomic_write, load_config
from .fingerprint import list_embedders, parse_kind
from .vectors import read_choice, write_choice

LOW, HIGH = 0.5, 0.999          # a cosine similarity below 0.5 means "not alike at all"; 1.0 would only match identical vectors
AUTO = {"kind": "auto", "label": "Automatic (MobileNet, weak fallback if it cannot load)", "degraded": False, "builtin": True}


def available(root=None):
    """The embedders that can be chosen for the audit (the built-in ones, then every saved model)."""
    return [AUTO] + list_embedders(root)


def read(index_dir, env_default="auto"):
    cfg = load_config(index_dir)
    return {
        "embedder": read_choice(index_dir, env_default),
        "cosSimilar": cfg["cos_similar"],
        "cosSame": cfg["cos_same"],
        "defaults": {"cosSimilar": DEFAULTS["cos_similar"], "cosSame": DEFAULTS["cos_same"]},
        "limits": {"min": LOW, "max": HIGH},
    }


def _number(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a number")
    if not (LOW <= float(value) <= HIGH):
        raise ValueError(f"{name} must be between {LOW} and {HIGH}")
    return round(float(value), 4)


def write(index_dir, values, env_default="auto", root=None):
    """values: any of embedder, cosSimilar, cosSame. Validates everything first, then writes. Raises ValueError."""
    if not isinstance(values, dict):
        raise ValueError("expected an object")
    current = read(index_dir, env_default)

    kind = None
    if values.get("embedder") is not None:
        kind = parse_kind(values["embedder"])
        if kind != "saved" and kind not in {e["kind"] for e in available(root)}:
            raise ValueError(f"'{kind}' is not available: there is no such model folder with a model file")
    similar = _number(values["cosSimilar"], "Similar") if values.get("cosSimilar") is not None else current["cosSimilar"]
    same = _number(values["cosSame"], "Same photo") if values.get("cosSame") is not None else current["cosSame"]
    if similar > same:
        raise ValueError("Similar cannot be higher than Same photo: a photo that is the same is also similar")

    if similar != current["cosSimilar"] or same != current["cosSame"]:
        path = Path(index_dir) / "config.json"
        user = json.loads(path.read_text(encoding="utf-8")) if path.exists() else json.loads(json.dumps(DEFAULTS))
        user["cos_similar"], user["cos_same"] = similar, same
        atomic_write(path, json.dumps(user, indent=2))
    if kind is not None and kind != current["embedder"]:
        write_choice(index_dir, kind)
    return read(index_dir, env_default)
