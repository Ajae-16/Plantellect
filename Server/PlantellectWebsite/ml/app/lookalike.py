"""Look-alike comparison for the admin's approval screen (dataset handler plan, stage 7a).

Given the pending photos of a submission (candidates) and some already-approved photos (references), returns for each
candidate the references it resembles, using the same MobileNetV3Large embeddings as the dataset audit. Nothing is
stored: the website sends small copies, this answers with similarity numbers, and the copies are dropped.

Privacy rule, same as everywhere: only pixels are read. No metadata is parsed or kept; the orientation flag is applied
so a rotated copy still matches.

This module has no web framework in it, so it can be tested with the weak thumbnail embedder (no TensorFlow).
"""
import io
import os
import re

import numpy as np
from PIL import Image, ImageOps

MAX_PIXELS = int(os.getenv("LOOKALIKE_MAX_PIXELS", str(25_000_000)))
MAX_FILE_BYTES = int(os.getenv("LOOKALIKE_MAX_FILE_BYTES", str(2 * 1024 * 1024)))
MAX_CANDIDATES = 40
MAX_REFERENCES = 60
SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class LookalikeError(ValueError):
    """A bad request. `status` is the HTTP status to answer with."""
    status = 400


def _to_array(data, size):
    """Bytes -> uint8 RGB array of `size`, or None when the file is not a readable picture."""
    if not data or len(data) > MAX_FILE_BYTES:
        return None
    try:
        with Image.open(io.BytesIO(data)) as im:
            if im.width * im.height > MAX_PIXELS:
                return None
            im = ImageOps.exif_transpose(im).convert("RGB").resize(size, Image.Resampling.BILINEAR)
            return np.asarray(im, dtype=np.uint8)
    except Exception:
        return None


def _embed(embedder, items):
    """items: [(id, bytes)] -> (ids, matrix of L2-normalised vectors, ids that could not be read)."""
    ids, arrays, skipped = [], [], []
    for item_id, data in items:
        arr = _to_array(data, embedder.size)
        if arr is None:
            skipped.append(item_id)
        else:
            ids.append(item_id)
            arrays.append(arr)
    if not arrays:
        return ids, np.zeros((0, 1), dtype="float32"), skipped
    vectors = np.asarray(embedder(np.stack(arrays)), dtype="float32")
    return ids, vectors, skipped


def compare(candidates, references, embedder, min_similarity=0.9, top_k=5):
    """candidates, references: lists of (id, bytes).

    Returns {"embedder": name, "degraded": bool, "skipped": [ids], "matches": {candidateId: [{"id", "similarity"}]}}
    with at most `top_k` references per candidate, best first, each at or above `min_similarity`.
    A candidate that looks like nothing has an empty list. A candidate is never matched to a reference with the same
    id (the website may send the same photo on both sides).
    """
    if len(candidates) > MAX_CANDIDATES or len(references) > MAX_REFERENCES:
        raise LookalikeError(f"At most {MAX_CANDIDATES} candidates and {MAX_REFERENCES} references per request")
    for item_id, _ in list(candidates) + list(references):
        if not SAFE_ID.match(str(item_id)):
            raise LookalikeError("Photo ids may only contain letters, digits, '_' and '-'")

    c_ids, c_vec, c_skipped = _embed(embedder, candidates)
    r_ids, r_vec, r_skipped = _embed(embedder, references)
    out = {cid: [] for cid in c_ids}
    if c_ids and r_ids:
        sims = c_vec @ r_vec.T
        for i, cid in enumerate(c_ids):
            order = np.argsort(-sims[i])
            for j in order:
                if len(out[cid]) >= top_k or sims[i, j] < min_similarity:
                    break
                if r_ids[j] == cid:
                    continue
                out[cid].append({"id": r_ids[j], "similarity": round(float(sims[i, j]), 4)})
    return {
        "embedder": getattr(embedder, "name", "unknown"),
        "degraded": bool(getattr(embedder, "degraded", False)),
        "skipped": c_skipped + r_skipped,
        "matches": out,
    }
