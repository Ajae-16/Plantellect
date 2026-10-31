import numpy as np


class UnionFind:
    def __init__(self, n):
        self.p = list(range(n))

    def find(self, a):
        while self.p[a] != a:
            self.p[a] = self.p[self.p[a]]
            a = self.p[a]
        return a

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[rb] = ra

    def components(self, members=None):
        out = {}
        for i in (range(len(self.p)) if members is None else members):
            out.setdefault(self.find(i), []).append(i)
        return list(out.values())


def dhash_pairs(hashes, max_dist, bucket_cap=300):
    """Pairs (i, j, distance) of 64-bit hex hashes within max_dist bits.

    The 64 bits are cut into max_dist+1 bands; two hashes that differ in at most max_dist bits must
    agree completely in at least one band, so bucketing on bands finds every such pair."""
    if max_dist < 0:                      # -1 switches the near-copy test off
        return
    bands = max_dist + 1
    edges = [round(64 * k / bands) for k in range(bands + 1)]
    buckets = {}
    for i, h in enumerate(hashes):
        v = int(h, 16)
        for b in range(bands):
            lo, hi = edges[b], edges[b + 1]
            buckets.setdefault((b, (v >> lo) & ((1 << (hi - lo)) - 1)), []).append(i)
    seen = set()
    for idxs in buckets.values():
        if len(idxs) < 2 or len(idxs) > bucket_cap:
            continue
        for x in range(len(idxs)):
            for y in range(x + 1, len(idxs)):
                i, j = idxs[x], idxs[y]
                if (i, j) in seen:
                    continue
                seen.add((i, j))
                d = bin(int(hashes[i], 16) ^ int(hashes[j], 16)).count("1")
                if d <= max_dist:
                    yield i, j, d


def cosine_pairs(vecs, threshold, chunk=1024):
    """Pairs (i, j, cos) with i < j and cos >= threshold, without building the full matrix at once."""
    n = len(vecs)
    for s in range(0, n, chunk):
        sims = vecs[s:s + chunk] @ vecs.T
        rows, cols = np.where(sims >= threshold)
        for r, c in zip(rows, cols):
            i = s + int(r)
            if i < c:
                yield i, int(c), float(sims[r, c])


def nearest_stats(vecs, chunk=1024):
    """Percentiles of every photo's best match to a different photo: the data for choosing thresholds."""
    if len(vecs) < 2:
        return {}
    best = np.full(len(vecs), -1.0, dtype="float32")
    for s in range(0, len(vecs), chunk):
        sims = vecs[s:s + chunk] @ vecs.T
        for r in range(sims.shape[0]):
            sims[r, s + r] = -1.0
        best[s:s + chunk] = sims.max(axis=1)
    return {**{f"p{q}": round(float(np.percentile(best, q)), 3) for q in (50, 90, 99)}, "max": round(float(best.max()), 3)}
