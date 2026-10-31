"""Command line. Run inside the ML container (it has TensorFlow):

    docker exec -it <ml container> sh -c "cd /app/app && python -m dataset_tools.cli audit --root '/data/datasets/plantellect training'"

    scan    index the folder and list warnings (no embeddings, quick)
    thumbs  make the thumbnails the admin page shows (also done by scan, audit and split)
    audit   scan + embeddings + duplicates / leaks / label suspects -> <index>/reports/latest.json
    split   group photos, then build a leak-free snapshot (use --dry-run first)
"""
import argparse
import json
import os
import sys
import time
from collections import Counter
from pathlib import Path

from .audit import run_audit
from .config import atomic_write
from .groups import assign_groups, read_manual
from .pipeline import prepare
from .split import load_frozen, plan_split, save_state, summarize, write_snapshot

BLOCKING = ("LEAK", "CROSS_CLASS")


def default_index(roots):
    return os.environ.get("DATASET_INDEX_DIR") or str(Path(roots[0]).resolve().parent / "index")


def print_summary(report):
    s = report["summary"]
    print(f"\n{report['photos']} photos ({report['uniqueFiles']} unique files), embedder {report['embedder']}")
    print("  ".join(f"{k}: {s.get(k, 0)}" for k in ("CROSS_CLASS", "LEAK", "SIMILAR_LEAK", "REDUNDANT", "MISLABEL")))
    if report["embedderDegraded"]:
        print("WARNING: the weak thumbnail embedder was used (TensorFlow missing). Visual copies are NOT reliably found.")
    if report["nearestNeighbour"]:
        print("nearest-neighbour similarity (use it to tune cos_same / cos_similar):", report["nearestNeighbour"])
    for w in report["warnings"][:20]:
        print("  warning:", w)
    if len(report["warnings"]) > 20:
        print(f"  ... and {len(report['warnings']) - 20} more in the report")


def save_report(index_dir, report):
    atomic_write(Path(index_dir) / "reports" / "latest.json", json.dumps(report))
    with open(Path(index_dir) / "reports" / "runs.jsonl", "a", encoding="utf-8") as f:
        f.write(json.dumps({"at": report["generatedAt"], "photos": report["photos"], "summary": report["summary"]}) + "\n")


def cmd_scan(a):
    ctx = prepare(a.root, a.index_dir or default_index(a.root), need_vectors=False, workers=a.workers)
    rows = ctx["rows"]
    print(f"{len(rows)} readable photos")
    print("by split:", dict(Counter(r["split"] or "pool" for r in rows)))
    print("by kind: ", dict(Counter(r["kind"] for r in rows)))
    species = Counter(r["label"] for r in rows if r["kind"] == "species")
    print(f"{len(species)} species; fewest photos: {species.most_common()[-1] if species else '-'}")
    parts = Counter(r["part"] or "(no part)" for r in rows if r["kind"] == "species")
    print("by part: ", dict(parts))
    for w in ctx["warnings"]:
        print("  warning:", w)
    ctx["index"].close()
    return 0


def cmd_thumbs(a):
    ctx = prepare(a.root, a.index_dir or default_index(a.root), need_vectors=False, workers=a.workers)
    print(f"{len(ctx['rows'])} photos; thumbnails are ready.")
    ctx["index"].close()
    return 0


def cmd_audit(a):
    index_dir = a.index_dir or default_index(a.root)
    ctx = prepare(a.root, index_dir, a.embedder, a.weights, a.workers)
    if not ctx["rows"]:
        print("no photos found")
        return 1
    manual = read_manual(index_dir)
    groups, _ = assign_groups(ctx["rows"], ctx["vecs"], ctx["cfg"], manual)
    ctx["index"].set_groups(groups)
    rows = ctx["index"].rows(ctx["roots"])
    report = run_audit(rows, ctx["vecs"], ctx["cfg"], ctx["embedder"].name, ctx["warnings"],
                       ctx["embedder"].degraded, ctx["roots"])
    save_report(index_dir, report)
    print_summary(report)
    ctx["index"].close()
    blocking = sum(report["summary"].get(k, 0) for k in BLOCKING)
    return 2 if (a.fail_on_leak and blocking) else 0


def cmd_split(a):
    index_dir = a.index_dir or default_index(a.root)
    ctx = prepare(a.root, index_dir, a.embedder, a.weights, a.workers)
    rows, cfg = ctx["rows"], ctx["cfg"]
    if not rows:
        print("no photos found")
        return 1
    groups, info = assign_groups(rows, ctx["vecs"], cfg, read_manual(index_dir))
    plan = plan_split(rows, groups, cfg, load_frozen(index_dir), a.adopt, not a.no_repair, a.keep_duplicates, info)
    text = summarize(plan)
    print("\n" + text)
    for w in ctx["warnings"][:10]:
        print("  warning:", w)
    if a.dry_run:
        print("\nDry run: nothing was written.")
        ctx["index"].close()
        return 0
    out = Path(a.out_dir) / time.strftime("snapshot-%Y%m%d-%H%M%S")
    manifest = write_snapshot(plan, out, a.copy)
    atomic_write(out / "report.txt", text)
    atomic_write(out / "plan.json", json.dumps({"flags": plan["flags"], "moves": plan["moves"], "leaks": plan["leaks"],
                                                "conflicts": plan["conflicts"], "photos": manifest}))
    ctx["index"].set_groups(groups)
    save_state(index_dir, plan)
    atomic_write(Path(a.out_dir) / "latest.txt", str(out))
    print(f"\nSnapshot written: {out}")
    # independent second look at what was just written
    check = prepare([out], index_dir, a.embedder, a.weights, a.workers, progress=lambda m: None)
    report = run_audit(check["rows"], check["vecs"], cfg, check["embedder"].name, [], check["embedder"].degraded, [str(out)])
    atomic_write(out / "audit.json", json.dumps(report))
    s = report["summary"]
    print("Audit of the snapshot:", {k: s.get(k, 0) for k in ("LEAK", "CROSS_CLASS", "SIMILAR_LEAK", "REDUNDANT", "MISLABEL")})
    ctx["index"].close()
    check["index"].close()
    return 2 if sum(s.get(k, 0) for k in BLOCKING) else 0


def main(argv=None):
    ap = argparse.ArgumentParser(prog="dataset_tools.cli", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p):
        p.add_argument("--root", action="append", required=True, help="dataset folder (repeat for several)")
        p.add_argument("--index-dir", help="where index.sqlite, config.json and splits.json live (default: next to the first root)")
        p.add_argument("--embedder", choices=["auto", "mobilenet", "thumb"], default="auto")
        p.add_argument("--weights", default="imagenet", help="'imagenet' or a weights file path (offline use)")
        p.add_argument("--workers", type=int, default=4)

    s = sub.add_parser("scan"); common(s); s.set_defaults(fn=cmd_scan)
    s = sub.add_parser("thumbs"); common(s); s.set_defaults(fn=cmd_thumbs)
    s = sub.add_parser("audit"); common(s)
    s.add_argument("--fail-on-leak", action="store_true", help="exit 2 if a LEAK or CROSS_CLASS exists"); s.set_defaults(fn=cmd_audit)
    s = sub.add_parser("split"); common(s)
    s.add_argument("--out-dir", required=True, help="folder that will hold snapshot-<date> folders")
    s.add_argument("--dry-run", action="store_true")
    s.add_argument("--adopt", action="store_true", help="treat the splits of a hand-made train/val/test tree as frozen")
    s.add_argument("--no-repair", action="store_true", help="keep leaks as they are instead of moving them to the larger side")
    s.add_argument("--keep-duplicates", action="store_true")
    s.add_argument("--copy", action="store_true", help="copy files instead of hard-linking")
    s.set_defaults(fn=cmd_split)
    a = ap.parse_args(argv)
    sys.exit(a.fn(a))


if __name__ == "__main__":
    main()
