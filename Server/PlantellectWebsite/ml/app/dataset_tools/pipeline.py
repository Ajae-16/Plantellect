"""Glue used by the command line and the FastAPI routes: scan -> index -> fingerprint -> embed."""
from pathlib import Path

from .admin_ops import warm_thumbnails
from .config import load_config
from .fingerprint import make_embedder
from .index import Index
from .scan import scan_root


def prepare(roots, index_dir, embedder_kind="auto", weights="imagenet", workers=4, progress=print, need_vectors=True, thumbs=True):
    cfg = load_config(index_dir)
    roots = [str(Path(r).resolve()) for r in roots]
    index = Index(index_dir)
    recs, warnings = [], []
    for root in roots:
        r, w = scan_root(root, cfg)
        recs += r
        warnings += w
    counts = index.sync(recs, roots)
    progress(f"scanned {counts['photos']} photos ({counts['new']} new, {counts['changed']} changed, {counts['removed']} removed)")
    index.fingerprint_pending(workers, progress)
    rows = index.rows(roots)
    if thumbs:
        t = warm_thumbnails(index_dir, rows, min(workers, 2), progress)
        if t["made"]:
            progress(f"made {t['made']} thumbnails ({t['failed']} failed)")
    bad = [r for r in index.rows(roots, ok_only=False) if not r["ok"]]
    for b in bad:
        warnings.append(f"unreadable image, left out: {b['rel']} ({b['err']})")
    embedder, vecs = None, {}
    if need_vectors and rows:
        embedder = make_embedder(embedder_kind, weights)
        index.embed_missing(embedder, rows, progress=progress)
        vecs = index.vectors(embedder.name, {r["sha256"] for r in rows})
    return {"cfg": cfg, "index": index, "rows": rows, "vecs": vecs, "embedder": embedder,
            "warnings": sorted(set(warnings)), "roots": roots}
