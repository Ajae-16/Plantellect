"""Shared names and settings. One place, so the scanner, the split script and the notebook agree."""
import json
import os
from pathlib import Path

SPLITS = ("train", "val", "test")

# Folder name on disk -> kind used everywhere else (matches classes.json "kind" values).
KIND_FOLDERS = {"Plant": "species", "Other plant": "other_plant", "Non plant": "non_plant"}
KIND_TO_FOLDER = {v: k for k, v in KIND_FOLDERS.items()}

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff", ".heic", ".heif"}

# Editable: copy of this dict is written to <index dir>/config.json on first run.
DEFAULTS = {
    # Parts are organisation only, never labels. Adding a part = adding a name here.
    "parts": ["Leaves", "Whole plant"],
    # Expected relative amounts, used only to word the "gather more" guidance.
    "part_targets": {"Leaves": 1, "Whole plant": 2},
    "ratios": {"train": 0.70, "val": 0.15, "test": 0.15},
    "min_groups": 10,            # fewer groups than this: everything goes to train and is flagged
    "part_ratio_warn": 3.0,      # warn when one part has more than this times another (in train)
    "part_mix_warn": 0.15,       # warn when a part's share in val/test differs from train by more than this
    "oversize_group_share": 0.30,  # warn when one group is more than this share of a class
    # Similarity thresholds are STARTING values; calibrate on your own photos (see report "nearestNeighbour").
    "dhash_max": 4,              # -1 switches the near-copy test off
    "cos_same": 0.97,
    "cos_similar": 0.93,
    "group_cap": 40,             # max photos a similarity-built group may grow to
    "mislabel_margin": 0.12,
    "min_class_for_centroid": 8,
}


def norm_folder(name: str) -> str:
    """'Other_plant', 'other plant ' and 'Other plant' all compare equal."""
    return " ".join(name.replace("_", " ").replace("-", " ").lower().split())


def load_config(index_dir) -> dict:
    """Defaults, overridden by <index dir>/config.json. Writes the file the first time."""
    index_dir = Path(index_dir)
    index_dir.mkdir(parents=True, exist_ok=True)
    path = index_dir / "config.json"
    cfg = json.loads(json.dumps(DEFAULTS))
    if path.exists():
        user = json.loads(path.read_text(encoding="utf-8"))
        for k, v in user.items():
            if isinstance(v, dict) and isinstance(cfg.get(k), dict):
                cfg[k].update(v)
            else:
                cfg[k] = v
    else:
        path.write_text(json.dumps(DEFAULTS, indent=2), encoding="utf-8")
    total = sum(cfg["ratios"].values())
    if abs(total - 1.0) > 1e-6:
        raise ValueError(f"ratios must add up to 1 (got {total})")
    return cfg


def atomic_write(path, text: str):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)
