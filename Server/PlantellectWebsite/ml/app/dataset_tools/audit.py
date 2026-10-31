"""Stage 1 audit: duplicates, leaks across splits, the same photo under two classes, label suspects.

Cheapest test first:  identical SHA-256  ->  dHash within a few bits  ->  embedding cosine.
Categories (worst first):
    CROSS_CLASS   the same photo is filed under two different classes (a label is wrong)
    LEAK          the same photo (or a copy) is in two splits, or one group spans two splits
    SIMILAR_LEAK  not identical but very alike (bursts, re-crops) in different splits of one class
    REDUNDANT     the same photo twice inside one split and class
    MISLABEL      (separate list) a photo far closer to another species' centroid than to its own
"""
import hashlib
import time
from collections import defaultdict

import numpy as np

from .scan import stratum
from .stats import dataset_stats
from .util import UnionFind, cosine_pairs, dhash_pairs, nearest_stats

SEVERITY = {"CROSS_CLASS": 0, "LEAK": 1, "SIMILAR_LEAK": 2, "REDUNDANT": 3}
MAX_SOFT_CLUSTERS = 300


def pid_of(path) -> str:
    """Opaque photo id used by the admin page, so no request ever carries a file path."""
    return hashlib.sha1(str(path).encode("utf-8")).hexdigest()[:16]


def member(r):
    m = {k: r[k] for k in ("path", "rel", "root", "split", "kind", "label", "part", "sha256")}
    m["pid"] = pid_of(r["path"])
    return m


def _cid(members):
    return hashlib.sha1("|".join(sorted(m["path"] for m in members)).encode()).hexdigest()[:12]


def run_audit(rows, vecs_by_sha, cfg, embedder_name, warnings=(), degraded=False, roots=()):
    n = len(rows)
    uf = UnionFind(n)
    edges = []
    by_sha = defaultdict(list)
    for i, r in enumerate(rows):
        by_sha[r["sha256"]].append(i)
    for idxs in by_sha.values():
        for k in idxs[1:]:
            uf.union(idxs[0], k)
            edges.append((idxs[0], k, "exact", 1.0))
    unique = [idxs[0] for idxs in by_sha.values()]

    for a, b, d in dhash_pairs([rows[i]["dhash"] for i in unique], cfg["dhash_max"]):
        uf.union(unique[a], unique[b])
        edges.append((unique[a], unique[b], "dhash", round(1 - d / 64, 4)))

    soft, nn = [], {}
    have = [k for k, i in enumerate(unique) if rows[i]["sha256"] in vecs_by_sha]
    if have:
        mat = np.stack([vecs_by_sha[rows[unique[k]]["sha256"]] for k in have])
        for a, b, c in cosine_pairs(mat, cfg["cos_similar"]):
            ia, ib = unique[have[a]], unique[have[b]]
            if c >= cfg["cos_same"]:
                uf.union(ia, ib)
                edges.append((ia, ib, "embedding", round(c, 4)))
            else:
                soft.append((ia, ib, c))
        nn = nearest_stats(mat)

    hows, best = defaultdict(set), defaultdict(float)
    for i, j, how, score in edges:
        root = uf.find(i)
        hows[root].add(how)
        best[root] = max(best[root], score)

    clusters = []
    comp_of = {}
    for comp in uf.components():
        for i in comp:
            comp_of[i] = uf.find(comp[0])
        if len(comp) < 2:
            continue
        classes = {stratum(rows[i]) for i in comp}
        splits = {rows[i]["split"] for i in comp}
        cat = "CROSS_CLASS" if len(classes) > 1 else "LEAK" if len(splits) > 1 else "REDUNDANT"
        root = uf.find(comp[0])
        mem = [member(rows[i]) for i in comp]
        clusters.append({"id": _cid(mem), "category": cat, "how": sorted(hows[root]),
                         "bestScore": round(best[root], 4), "members": mem})

    # soft: alike but not copies, same class, different splits
    soft.sort(key=lambda t: -t[2])
    used = defaultdict(int)
    uf2, pairs2 = UnionFind(n), []
    for ia, ib, c in soft:
        ra, rb = rows[ia], rows[ib]
        if comp_of.get(ia) == comp_of.get(ib) or stratum(ra) != stratum(rb):
            continue
        if ra["split"] is None or rb["split"] is None or ra["split"] == rb["split"]:
            continue
        if used[ia] >= 3 or used[ib] >= 3:
            continue
        used[ia] += 1
        used[ib] += 1
        uf2.union(ia, ib)
        pairs2.append((ia, ib, c))
    groups2 = defaultdict(lambda: {"idx": set(), "best": 0.0})
    for ia, ib, c in pairs2:
        g = groups2[uf2.find(ia)]
        g["idx"].update((ia, ib))
        g["best"] = max(g["best"], c)
    soft_clusters = []
    for g in groups2.values():
        mem = [member(rows[i]) for i in sorted(g["idx"])][:8]
        soft_clusters.append({"id": _cid(mem), "category": "SIMILAR_LEAK", "how": ["embedding"],
                              "bestScore": round(g["best"], 4), "members": mem})
    soft_clusters.sort(key=lambda c: -c["bestScore"])
    soft_capped = len(soft_clusters) > MAX_SOFT_CLUSTERS
    clusters += soft_clusters[:MAX_SOFT_CLUSTERS]

    # a group that spans two splits (Stage 2 fills group_key)
    by_group = defaultdict(list)
    for i, r in enumerate(rows):
        if r.get("group_key"):
            by_group[r["group_key"]].append(i)
    for key, idxs in by_group.items():
        if len({rows[i]["split"] for i in idxs}) > 1 and len({comp_of[i] for i in idxs}) > 1:
            mem = [member(rows[i]) for i in idxs][:12]
            clusters.append({"id": _cid(mem), "category": "LEAK", "how": ["group"], "bestScore": 1.0, "members": mem})

    clusters.sort(key=lambda c: (SEVERITY[c["category"]], -c["bestScore"]))
    summary = defaultdict(int)
    for c in clusters:
        summary[c["category"]] += 1

    mislabels = _mislabels(rows, vecs_by_sha, cfg)
    summary["MISLABEL"] = len(mislabels)
    return {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "roots": list(roots), "embedder": embedder_name, "embedderDegraded": degraded,
        "photos": n, "uniqueFiles": len(by_sha),
        "perSplit": {(s or "pool"): sum(1 for r in rows if r["split"] == s) for s in {r["split"] for r in rows}},
        "summary": dict(summary), "softCapped": soft_capped,
        "thresholds": {k: cfg[k] for k in ("dhash_max", "cos_same", "cos_similar", "mislabel_margin")},
        "nearestNeighbour": nn, "clusters": clusters, "mislabels": mislabels,
        "warnings": list(warnings), "stats": dataset_stats(rows, cfg),
    }


def _mislabels(rows, vecs, cfg):
    sp = [i for i, r in enumerate(rows) if r["kind"] == "species" and r["sha256"] in vecs]
    has_train = any(rows[i]["split"] == "train" for i in sp)
    cent = {}
    for label in {rows[i]["label"].lower() for i in sp}:
        idx = [i for i in sp if rows[i]["label"].lower() == label and (not has_train or rows[i]["split"] == "train")]
        if len(idx) >= cfg["min_class_for_centroid"]:
            c = np.mean([vecs[rows[i]["sha256"]] for i in idx], axis=0)
            cent[label] = c / (np.linalg.norm(c) + 1e-9)
    if len(cent) < 2:
        return []
    names = list(cent)
    C = np.stack([cent[k] for k in names])
    out = []
    for i in sp:
        own = rows[i]["label"].lower()
        if own not in cent:
            continue
        s = C @ vecs[rows[i]["sha256"]]
        k = int(np.argmax(s))
        gap = float(s[k] - s[names.index(own)])
        if names[k] != own and gap >= cfg["mislabel_margin"]:
            out.append({"category": "MISLABEL", "score": round(gap, 4), "closerTo": names[k], "a": member(rows[i])})
    return sorted(out, key=lambda m: -m["score"])
