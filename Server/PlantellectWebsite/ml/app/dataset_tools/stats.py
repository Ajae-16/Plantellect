"""Counts per species, part and split, group counts, and the part-balance / gathering guidance."""
import math
from collections import defaultdict

from .config import SPLITS
from .scan import stratum


def _split(r):
    return r["split"] or "pool"


def dataset_stats(rows, cfg):
    by_label = defaultdict(list)
    for r in rows:
        if r["kind"] == "species":
            by_label[r["label"]].append(r)
    species, other = [], defaultdict(int)
    for r in rows:
        if r["kind"] != "species":
            other[f"{r['kind']}:{_split(r)}"] += 1

    for label in sorted(by_label):
        rs = by_label[label]
        grid = defaultdict(lambda: defaultdict(int))
        groups = defaultdict(set)
        for r in rs:
            grid[r["part"] or "(no part)"][_split(r)] += 1
            if r.get("group_key"):
                groups[_split(r)].add(r["group_key"])
        all_groups = {r["group_key"] for r in rs if r.get("group_key")}
        entry = {"label": label, "photos": len(rs),
                 "parts": {p: dict(c) for p, c in sorted(grid.items())},
                 "groups": len(all_groups) if all_groups else None,
                 "groupsPerSplit": {s: len(g) for s, g in groups.items()} if all_groups else None}
        entry["warnings"], entry["guidance"] = part_report(grid, entry["groups"], cfg)
        species.append(entry)
    return {"species": species, "otherKinds": dict(other)}


def part_report(grid, group_count, cfg):
    """(warnings, guidance) for one species. Never blocks anything."""
    warnings, guidance = [], []
    ref = "train" if any("train" in c for c in grid.values()) else "pool"
    counts = {p: c.get(ref, 0) for p, c in grid.items() if p != "(no part)"}
    live = {p: n for p, n in counts.items() if n > 0}
    if len(live) >= 2:
        hi, lo = max(live, key=live.get), min(live, key=live.get)
        if live[hi] > cfg["part_ratio_warn"] * live[lo]:
            warnings.append(f"{hi} has {live[hi]} photos but {lo} only {live[lo]} (more than {cfg['part_ratio_warn']:g} to 1) in {ref}")
    for p in cfg["parts"]:
        if counts.get(p, 0) == 0 and live:
            warnings.append(f"no {p} photos in {ref}")
    if ref == "train":
        total = {s: sum(c.get(s, 0) for p, c in grid.items() if p != "(no part)") for s in SPLITS}
        for s in ("val", "test"):
            if total[s] == 0:
                continue
            for p, n in live.items():
                if grid[p].get(s, 0) == 0:
                    warnings.append(f"{p} is missing from {s}")
                share_t = n / max(1, total["train"])
                share_s = grid[p].get(s, 0) / total[s]
                if abs(share_t - share_s) > cfg["part_mix_warn"]:
                    warnings.append(f"{p} is {share_s:.0%} of {s} but {share_t:.0%} of train")
    weights = {p: cfg["part_targets"].get(p, 1) for p in cfg["parts"]}
    if warnings and live:
        per_weight = {p: counts.get(p, 0) / weights[p] for p in cfg["parts"]}
        top = max(per_weight.values())
        for p in cfg["parts"]:
            need = math.ceil(top * weights[p] - counts.get(p, 0))
            if need > 0 and per_weight[p] < top:
                guidance.append(f"add about {need} more {p} photos to match the expected balance")
    if group_count is not None and group_count < cfg["min_groups"]:
        guidance.append(f"only {group_count} groups (sessions); {cfg['min_groups'] - group_count} more are needed before this species gets val and test")
    return warnings, guidance
