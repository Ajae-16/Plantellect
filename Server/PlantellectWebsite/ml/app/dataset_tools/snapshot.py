""" read a DATABASE snapshot (written by the website's config/db-snapshot.js).

A database snapshot is a folder in the same layout the scanner already understands, plus two files:

    <snapshot>/Plant/<Species>/<Part>/<imageId>.webp       (or Other plant/<Species>/...)
    <snapshot>/manifest.json   one entry per photo: ids, kind, part, group, SHA-256 of the file
    <snapshot>/groups.csv      "group,path" rows; path is the SHA-256 of the file. These photos must stay together.

So the audit and the split script read the PHOTOS exactly as they read any folder (pass the snapshot as one more
root), and this module adds the two things a folder cannot say:

  * the groups (a manual group, or one submission, from the database), merged into the manual groups, and
  * a check that the folder is still what the manifest says it is. A snapshot is never edited, so a file whose
    hash differs, or a listed file that is gone, stops the run instead of quietly producing a wrong split.

Nothing here reads photo metadata, and the manifest holds no account, filename, GPS or capture time.
"""
import csv
import json
from collections import defaultdict
from pathlib import Path

SUPPORTED_VERSION = 1


class SnapshotError(ValueError):
    """The snapshot cannot be used. The message says what to fix."""


def resolve_snapshot_dir(value, index_dir=None):
    """A path, or a bare snapshot name looked up in <index dir>/../db-snapshots."""
    p = Path(value)
    if p.is_dir():
        return p.resolve()
    if len(p.parts) == 1 and index_dir:
        cand = Path(index_dir).resolve().parent / "db-snapshots" / value
        if cand.is_dir():
            return cand
    raise SnapshotError(f"snapshot folder not found: {value}")


def read_groups_csv(path):
    """group -> [sha256, ...]. Missing file means no groups."""
    out = defaultdict(list)
    p = Path(path)
    if p.exists():
        with open(p, newline="", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                g, ref = (row.get("group") or "").strip(), (row.get("path") or "").strip()
                if g and ref:
                    out[g].append(ref)
    return out


def load_snapshot(folder):
    """Reads manifest.json and groups.csv. Returns {dir, name, manifest, groups}."""
    folder = Path(folder).resolve()
    mpath = folder / "manifest.json"
    if not mpath.is_file():
        raise SnapshotError(f"{folder} has no manifest.json, so it is not a database snapshot")
    try:
        manifest = json.loads(mpath.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise SnapshotError(f"manifest.json could not be read: {e}")
    if not isinstance(manifest, dict) or manifest.get("version") != SUPPORTED_VERSION:
        raise SnapshotError(f"manifest.json has version {manifest.get('version') if isinstance(manifest, dict) else '?'}; "
                            f"this tool reads version {SUPPORTED_VERSION}")
    photos = manifest.get("photos")
    if not isinstance(photos, list) or not all(isinstance(p, dict) and p.get("path") and p.get("sha256") for p in photos):
        raise SnapshotError("manifest.json has a photo entry without a path or a sha256")
    return {"dir": folder, "name": manifest.get("name") or folder.name, "manifest": manifest,
            "groups": read_groups_csv(folder / "groups.csv")}


def manual_groups(snapshots):
    """The groups of every snapshot, named '<snapshot>:<group>' so they can never merge with another source's."""
    out = {}
    for s in snapshots:
        for g, refs in s["groups"].items():
            out[f"{s['name']}:{g}"] = list(refs)
    return out


def check_against_index(snapshots, rows):
    """Compares each manifest with the scanned rows. Returns warnings; raises SnapshotError on a real mismatch.

    rows: the index rows for the snapshot roots (each has root, rel, sha256).
    """
    warnings = []
    for s in snapshots:
        root = str(s["dir"])
        scanned = {r["rel"]: r for r in rows if r["root"] == root}
        problems = []
        listed = set()
        for p in s["manifest"]["photos"]:
            rel = p["path"]
            listed.add(rel)
            row = scanned.get(rel)
            if row is None:
                problems.append(f"listed but not found: {rel}")
            elif row["sha256"] != p["sha256"]:
                problems.append(f"changed since the snapshot was built: {rel}")
        if problems:
            shown = "; ".join(problems[:5]) + (f"; and {len(problems) - 5} more" if len(problems) > 5 else "")
            raise SnapshotError(f"snapshot {s['name']} is not what its manifest says ({shown}). "
                                "A snapshot is never edited: build a new one from the website.")
        extra = sorted(set(scanned) - listed)
        if extra:
            warnings.append(f"snapshot {s['name']}: {len(extra)} file(s) are not in the manifest and are treated as ordinary photos "
                            f"(first: {extra[0]})")
        parts = [p for p in s["manifest"]["photos"] if p.get("kind") == "species" and not p.get("part")]
        if parts:
            warnings.append(f"snapshot {s['name']}: {len(parts)} photo(s) of supported species have no part")
    return warnings


def describe(snapshots):
    """One line per snapshot for the printed summary and the training snapshot's report."""
    lines = []
    for s in snapshots:
        c = s["manifest"].get("counts") or {}
        lines.append(f"Database snapshot {s['name']}: {c.get('photos', len(s['manifest']['photos']))} photos, "
                     f"{c.get('groups', len(set(s['groups'])))} database groups, "
                     f"{c.get('otherPlantPhotos', 0)} Other plant")
    return lines
