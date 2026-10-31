"""Walk a dataset folder and describe every photo from its path alone.

Two layouts are understood (and may be mixed by passing several roots):
    split tree   <root>/<train|val|test>/<Plant|Other plant|Non plant>/...
    pool tree    <root>/<Plant|Other plant|Non plant>/...            (no split yet)
Below the kind folder:
    Plant/<Species>/<Part>/[<session folders>/]<photo>
    Other plant/<Species>/<photo>
    Non plant/[<subfolder>/]<photo>
Folders that start with '_' or '.' (for example _quarantine) are ignored.
"""
import os
from pathlib import Path

from .config import IMAGE_EXT, KIND_FOLDERS, KIND_TO_FOLDER, SPLITS, norm_folder
from .names import collision_key, normalize_name

_KIND_BY_NORM = {norm_folder(k): v for k, v in KIND_FOLDERS.items()}
_SKIP_FILES = {"thumbs.db", "desktop.ini", ".ds_store"}


def stratum(rec) -> tuple:
    """The class a photo belongs to for splitting and for cross-class checks."""
    return ("species", rec["label"].lower()) if rec["kind"] == "species" else (rec["kind"],)


def _match_part(name, parts):
    n = norm_folder(name)
    for p in parts:
        if norm_folder(p) == n:
            return p
    return None


def _visible(p: Path) -> bool:
    return not p.name.startswith(("_", "."))


def scan_root(root, cfg):
    """Returns (records, warnings). Records are plain dicts."""
    root = Path(root).resolve()
    if not root.is_dir():
        raise ValueError(f"not a folder: {root}")
    warnings, recs = [], []
    tops = [d for d in sorted(root.iterdir()) if d.is_dir() and _visible(d)]
    split_dirs = {norm_folder(d.name): d for d in tops if norm_folder(d.name) in SPLITS}
    kind_dirs = {d: _KIND_BY_NORM[norm_folder(d.name)] for d in tops if norm_folder(d.name) in _KIND_BY_NORM}
    if split_dirs:
        pairs = []
        for sname, sdir in split_dirs.items():
            for kdir in sorted(d for d in sdir.iterdir() if d.is_dir() and _visible(d)):
                kind = _KIND_BY_NORM.get(norm_folder(kdir.name))
                if kind is None:
                    warnings.append(f"unknown folder (not Plant / Other plant / Non plant): {kdir}")
                    continue
                pairs.append((sname, kdir, kind))
        for d in tops:
            if norm_folder(d.name) not in SPLITS:
                warnings.append(f"ignored folder next to train/val/test: {d.name}")
    elif kind_dirs:
        pairs = [(None, d, k) for d, k in kind_dirs.items()]
    else:
        raise ValueError(f"{root} has neither train/val/test nor Plant/Other plant/Non plant folders")

    labels_seen = {}
    for split, kdir, kind in pairs:
        for dirpath, dirnames, filenames in os.walk(kdir):
            dirnames[:] = sorted(d for d in dirnames if not d.startswith(("_", ".")))
            for fn in sorted(filenames):
                p = Path(dirpath) / fn
                if fn.lower() in _SKIP_FILES or fn.startswith("."):
                    continue
                if p.suffix.lower() not in IMAGE_EXT:
                    warnings.append(f"not an image, skipped: {p}")
                    continue
                dirs = list(p.relative_to(kdir).parts[:-1])
                rec = _describe(p, root, split, kind, dirs, cfg, warnings, labels_seen)
                if rec:
                    recs.append(rec)
    # two folders that differ only by case or by characters Windows treats alike are one species
    by_key = {}
    for (kind, folder) in labels_seen:
        by_key.setdefault((kind, collision_key(folder)), set()).add(folder)
    for (kind, _), folders in by_key.items():
        if len(folders) > 1:
            warnings.append(f"these folders are the same name to Windows and are merged: {sorted(folders)}")
    return recs, sorted(set(warnings))


def _describe(p, root, split, kind, dirs, cfg, warnings, labels_seen):
    st = p.stat()
    base = {"path": str(p), "root": str(root), "rel": p.relative_to(root).as_posix(), "split": split,
            "kind": kind, "size": st.st_size, "mtime_ns": st.st_mtime_ns, "part": None, "source": ""}
    if kind == "species":
        if not dirs:
            warnings.append(f"photo directly inside Plant/ (needs a species folder): {p}")
            return None
        folder = dirs[0]
        rest = dirs[1:]
        if rest:
            part = _match_part(rest[0], cfg["parts"])
            if part is None:
                part = rest[0]
                warnings.append(f"part '{part}' is not in config.json parts (add it as a row): {folder}/{part}")
            base["part"], base["source"] = part, "/".join(rest[1:])
        else:
            warnings.append(f"photos with no part folder in Plant/{folder}/ (put them in a part folder)")
    elif kind == "other_plant":
        folder = dirs[0] if dirs else "Other plant"
    else:
        folder = dirs[0] if dirs else "Non plant"
    label = normalize_name(folder)
    if folder != label:
        if folder[:1] == label[:1]:
            warnings.append(f"folder name has extra or unusual spaces: {folder!r} (treated as {label!r})")
        else:
            warnings.append(f"name does not start with an uppercase first letter: {folder!r} (treated as {label!r})")
    labels_seen[(kind, folder)] = True
    base.update(label=label, folder_label=folder)
    return base
