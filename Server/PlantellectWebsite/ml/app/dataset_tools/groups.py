"""Stage 2, step 1: decide which photos must stay together (a "group") before any split.

Inside one class (a species, or Other plant, or Non plant) photos are joined when they are
    1. byte-identical (same SHA-256), or near-exact copies (dHash within a few bits)
    2. in the same session folder (Plant/<Species>/<Part>/<session>/...). The folder name is the group,
       and the same session name under Leaves and Whole plant joins both parts. No photo metadata is read.
    3. listed together in groups_manual.csv (an admin's decision, always honoured)
    4. very alike by embedding (cosine >= cos_same). This is a LEADER clustering, not a chain: a photo joins a
       group only if it is similar to that group's first photo, and a group stops growing at group_cap,
       so similar-looking leaves can never snowball into one giant group.
Photos of different classes are never grouped together; the same bytes under two classes is a label
conflict and is left out of any build.
"""
import csv
import hashlib
from collections import defaultdict
from pathlib import Path

import numpy as np

from .scan import stratum
from .util import UnionFind, dhash_pairs


def read_manual(index_dir):
    """groups_manual.csv: header 'group,path'. path may be a relative path, an absolute path or a sha256."""
    p = Path(index_dir) / "groups_manual.csv"
    out = defaultdict(list)
    if p.exists():
        with open(p, newline="", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                if row.get("group") and row.get("path"):
                    out[row["group"].strip()].append(row["path"].strip())
    return out


def assign_groups(rows, vecs_by_sha, cfg, manual=None):
    """Returns (mapping path -> group_key, info). info lists locked/oversize groups for the report."""
    manual = manual or {}
    ref_to_group = {}
    for g, refs in manual.items():
        for ref in refs:
            ref_to_group[ref] = g

    buckets = defaultdict(list)
    for i, r in enumerate(rows):
        buckets[stratum(r)].append(i)

    mapping, info = {}, {"oversize": [], "locked": 0}
    for key, idxs in buckets.items():
        local = {i: k for k, i in enumerate(idxs)}
        uf = UnionFind(len(idxs))
        locked = set()

        by_sha = defaultdict(list)
        for i in idxs:
            by_sha[rows[i]["sha256"]].append(i)
        for same in by_sha.values():
            for i in same[1:]:
                uf.union(local[same[0]], local[i])
        reps = [same[0] for same in by_sha.values()]
        for a, b, _ in dhash_pairs([rows[i]["dhash"] for i in reps], cfg["dhash_max"]):
            uf.union(local[reps[a]], local[reps[b]])

        by_source = defaultdict(list)
        by_manual = defaultdict(list)
        for i in idxs:
            r = rows[i]
            if r["kind"] == "species" and r.get("source"):
                by_source[r["source"].lower()].append(i)
            for ref in (r["rel"], r["path"], r["sha256"]):
                if ref in ref_to_group:
                    by_manual[ref_to_group[ref]].append(i)
        for members in list(by_source.values()) + list(by_manual.values()):
            for i in members[1:]:
                uf.union(local[members[0]], local[i])
            locked.add(members[0])

        comps = uf.components()
        locked_roots = {uf.find(local[i]) for i in locked}
        groups = []                              # each: list of local indices
        free = []
        for comp in comps:
            (groups if uf.find(comp[0]) in locked_roots else free).append(comp)
        info["locked"] += len(groups)

        free.sort(key=lambda c: (-len(c), rows[idxs[c[0]]]["sha256"]))
        leaders = []                             # (vector, group list)
        for comp in free:
            sha = rows[idxs[comp[0]]]["sha256"]
            v = vecs_by_sha.get(sha)
            placed = False
            if v is not None and leaders:
                mat = np.stack([lv for lv, _ in leaders])
                sims = mat @ v
                for k in np.argsort(-sims):
                    if sims[k] < cfg["cos_same"]:
                        break
                    if len(leaders[k][1]) + len(comp) <= cfg["group_cap"]:
                        leaders[k][1].extend(comp)
                        placed = True
                        break
            if not placed:
                grp = list(comp)
                if v is not None:                # a photo without a vector is simply its own group
                    leaders.append((v, grp))
                groups.append(grp)

        total = len(idxs)
        for grp in groups:
            shas = sorted(rows[idxs[k]]["sha256"] for k in grp)
            gkey = "g" + hashlib.sha1(shas[0].encode()).hexdigest()[:12]
            for k in grp:
                mapping[rows[idxs[k]]["path"]] = gkey
            if total >= 20 and len(grp) > cfg["oversize_group_share"] * total:
                info["oversize"].append({"group": gkey, "class": "/".join(key), "photos": len(grp), "classPhotos": total})
    return mapping, info
