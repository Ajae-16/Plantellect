"""Stage 2, step 2: assign whole groups to train / val / test and write a numbered snapshot.

Rules
  * The unit is a group, never a photo, so a group can never straddle two splits.
  * Ratio (default 70/15/15) is applied per class: each species, and Other plant / Non plant as one class each.
  * FROZEN SPLITS: every assignment is saved in splits.json (by SHA-256). A later run keeps them and only places
    new groups, so a photo that was in test for one model cannot land in train for the next.
  * --adopt reads the splits of a hand-made train/val/test tree as the frozen starting point.
  * Leaks already present (a group in two splits) are repaired toward the larger side and every move is listed.
  * A class with fewer than min_groups groups (and nothing frozen) goes entirely to train and is flagged.
  * Same input -> same output: there is no randomness.
  * The source folders are never edited. The snapshot is a new folder of hard links (copies if the drive
    cannot link), with files named by their hash, so no original file name (which can carry a timestamp) is kept.
"""
import json
import os
import shutil
import time
from collections import Counter, defaultdict
from pathlib import Path

from .config import KIND_TO_FOLDER, SPLITS, atomic_write
from .names import safe_folder_name
from .scan import stratum
from .stats import dataset_stats


def load_frozen(index_dir):
    p = Path(index_dir) / "splits.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}


def plan_split(rows, groups, cfg, frozen=None, adopt=False, repair=True, keep_duplicates=False, group_info=None):
    frozen = dict(frozen or {})
    ratios = cfg["ratios"]
    flags, moves, leaks, conflicts, dropped = [], [], [], [], []

    # the same bytes under two classes: label conflict, left out entirely
    classes_by_sha = defaultdict(set)
    for r in rows:
        classes_by_sha[r["sha256"]].add(stratum(r))
    bad = {s for s, c in classes_by_sha.items() if len(c) > 1}
    for s in sorted(bad):
        conflicts.append([{"path": r["path"], "rel": r["rel"], "label": r["label"], "kind": r["kind"]}
                          for r in rows if r["sha256"] == s])
    work = [dict(r, group=groups.get(r["path"]) or "solo:" + r["path"]) for r in rows if r["sha256"] not in bad]

    sha_splits = defaultdict(set)
    for r in work:
        if r["split"] in SPLITS:
            sha_splits[r["sha256"]].add(r["split"])
    for sha, sp in sorted(sha_splits.items()):    # the same file already sits in two splits of a hand-made tree
        if len(sp) > 1:
            leaks.append({"class": "exact copy", "group": sha[:12], "splits": {s: 1 for s in sorted(sp)}})
    if not keep_duplicates:                       # identical bytes: keep one path (the train copy first)
        seen, kept = set(), []
        order = {s: i for i, s in enumerate(SPLITS)}
        for r in sorted(work, key=lambda x: (order.get(x["split"], 9), x["path"])):
            if r["sha256"] in seen:
                dropped.append(r["path"])
            else:
                seen.add(r["sha256"])
                kept.append(r)
        work = kept

    for r in work:                                # starting point for each photo
        r["start"] = frozen.get(r["sha256"]) or (r["split"] if adopt and r["split"] in SPLITS else None)

    by_class = defaultdict(list)
    for r in work:
        by_class[stratum(r)].append(r)

    for key, members in sorted(by_class.items()):
        label = "/".join(key)
        by_group = defaultdict(list)
        for r in members:
            by_group[r["group"]].append(r)
        total = len(members)
        resolved = {}                              # group -> split
        for g, rs in by_group.items():
            starts = Counter(r["start"] for r in rs if r["start"])
            if not starts:
                continue
            if len(starts) > 1:
                leaks.append({"class": label, "group": g, "splits": dict(starts)})
            if repair or len(starts) == 1:
                win = max(SPLITS, key=lambda s: (starts.get(s, 0), -SPLITS.index(s)))
                resolved[g] = win
                for r in rs:
                    if r["start"] and r["start"] != win:
                        moves.append({"rel": r["rel"], "from": r["start"], "to": win, "class": label})
                    r["final"] = win
            else:
                for r in rs:
                    r["final"] = r["start"] or max(SPLITS, key=lambda s: (starts.get(s, 0), -SPLITS.index(s)))
        current = {s: 0 for s in SPLITS}
        for g, win in resolved.items():
            current[win] += len(by_group[g])
        if not repair:
            for g, rs in by_group.items():
                if g not in resolved and any("final" in r for r in rs):
                    for r in rs:
                        if "final" in r:
                            current[r["final"]] += 1

        todo = sorted((g for g in by_group if not any("final" in r for r in by_group[g])),
                      key=lambda g: (-len(by_group[g]), g))
        frozen_any = len(todo) < len(by_group)
        if len(by_group) < cfg["min_groups"] and not frozen_any:
            flags.append({"class": label, "flag": "too_few_groups",
                          "detail": f"{len(by_group)} groups (minimum {cfg['min_groups']}): all {total} photos go to train"})
            for g in todo:
                for r in by_group[g]:
                    r["final"] = "train"
            continue
        targets = {s: ratios[s] * total for s in SPLITS}
        for g in todo:
            pick = max(SPLITS, key=lambda s: (targets[s] - current[s], -SPLITS.index(s)))
            for r in by_group[g]:
                r["final"] = pick
            current[pick] += len(by_group[g])
        if key[0] == "species":
            for s in ("val", "test"):
                if total >= 20 and not any(r["final"] == s for r in members if "final" in r):
                    flags.append({"class": label, "flag": f"empty_{s}", "detail": f"no photos in {s}"})
        biggest = max(by_group.values(), key=len)
        if total >= 20 and len(biggest) > cfg["oversize_group_share"] * total:
            flags.append({"class": label, "flag": "oversize_group",
                          "detail": f"one group holds {len(biggest)} of {total} photos; it cannot be split"})

    out = [dict(r, split_final=r["final"]) for r in work if "final" in r]
    stat_rows = [dict(r, split=r["final"], group_key=r["group"]) for r in out]
    return {"photos": out, "flags": flags, "moves": moves, "leaks": leaks, "conflicts": conflicts,
            "droppedDuplicates": dropped, "stats": dataset_stats(stat_rows, cfg),
            "oversizeGroups": (group_info or {}).get("oversize", [])}


def _dest(r, out):
    folder = KIND_TO_FOLDER[r["kind"]]
    ext = Path(r["path"]).suffix.lower()
    base = out / r["split_final"] / folder
    if r["kind"] == "species":
        base = base / safe_folder_name(r["label"]) / safe_folder_name(r["part"] or "No part")
    elif r["kind"] == "other_plant":
        base = base / safe_folder_name(r["label"])
    return base / f"{r['sha256'][:16]}{ext}"


def write_snapshot(plan, out_dir, copy=False):
    out = Path(out_dir)
    if out.exists() and any(out.iterdir()):
        raise FileExistsError(f"{out} is not empty; a snapshot is never mixed with another")
    manifest, used = [], Counter()
    for r in sorted(plan["photos"], key=lambda x: x["path"]):
        dest = _dest(r, out)
        used[dest] += 1
        if used[dest] > 1:                          # only with --keep-duplicates
            dest = dest.with_name(f"{dest.stem}-{used[dest]}{dest.suffix}")
        dest.parent.mkdir(parents=True, exist_ok=True)
        if copy:
            shutil.copy2(r["path"], dest)
        else:
            try:
                os.link(r["path"], dest)
            except OSError:
                shutil.copy2(r["path"], dest)
        manifest.append({"sha256": r["sha256"], "source": r["rel"], "dest": dest.relative_to(out).as_posix(),
                         "split": r["split_final"], "kind": r["kind"], "label": r["label"], "part": r["part"],
                         "group": r["group"]})
    return manifest


def summarize(plan):
    """Plain-text report: counts, flags, moves, warnings. Printed and saved next to the snapshot."""
    lines = []
    per = Counter(r["split_final"] for r in plan["photos"])
    total = sum(per.values())
    lines.append(f"Photos placed: {total}  " + "  ".join(f"{s}: {per.get(s, 0)} ({per.get(s, 0) / max(1, total):.0%})" for s in SPLITS))
    lines.append(f"Duplicates dropped: {len(plan['droppedDuplicates'])}   Label conflicts left out: {len(plan['conflicts'])}"
                 f"   Leaks repaired: {len(plan['leaks'])} groups ({len(plan['moves'])} photos moved)")
    if plan["flags"]:
        lines.append("\nFlags:")
        lines += [f"  - {f['class']}: {f['detail']}" for f in plan["flags"]]
    if plan["oversizeGroups"]:
        lines.append("\nGroups too big to split well:")
        lines += [f"  - {o['class']}: {o['photos']} of {o['classPhotos']} photos in one group" for o in plan["oversizeGroups"]]
    lines.append("\nSpecies by part and split:")
    for sp in plan["stats"]["species"]:
        parts = "; ".join(f"{p} " + "/".join(str(c.get(s, 0)) for s in SPLITS) for p, c in sp["parts"].items())
        lines.append(f"  {sp['label']}: {sp['photos']} photos, {sp['groups']} groups  [{parts}]  (train/val/test)")
        lines += [f"      warning: {w}" for w in sp["warnings"]]
        lines += [f"      to gather: {g}" for g in sp["guidance"]]
    return "\n".join(lines)


def save_state(index_dir, plan):
    """Remember every placement (by sha256) so the next run keeps it."""
    frozen = load_frozen(index_dir)
    for r in plan["photos"]:
        frozen[r["sha256"]] = r["split_final"]
    atomic_write(Path(index_dir) / "splits.json", json.dumps(frozen, indent=0, sort_keys=True))
