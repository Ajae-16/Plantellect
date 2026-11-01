"""Command line. Run inside the ML container (it has TensorFlow):

    docker exec -it <ml container> sh -c "cd /app/app && python -m dataset_tools.cli audit --root '/data/datasets/plantellect training'"

    scan    index the folder and list warnings (no embeddings, quick)
    thumbs  make the thumbnails the admin page shows (also done by scan, audit and split)
    audit   scan + embeddings + duplicates / leaks / label suspects -> <index>/reports/latest.json
    split   group photos, then build a leak-free snapshot (use --dry-run first)

audit and split also take --snapshot <folder or name> (repeatable): a DATABASE snapshot built on the admin
dataset page. It is read like one more root, and its groups from the database are kept together. Example:

    python -m dataset_tools.cli split --root '/data/datasets/plantellect training' \\
        --snapshot snapshot-20261031-214305 --out-dir /data/datasets/snapshots --dry-run
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
from .snapshot import SnapshotError, check_against_index, describe, load_snapshot, manual_groups, resolve_snapshot_dir
from .split import load_frozen, plan_split, save_state, summarize, write_snapshot

BLOCKING = ("LEAK", "CROSS_CLASS")


def default_index(roots):
    return os.environ.get("DATASET_INDEX_DIR") or str(Path(roots[0]).resolve().parent / "index")


def index_dir_for(a):
    """--index-dir, else DATASET_INDEX_DIR, else next to the first root (or, with only a snapshot, next to db-snapshots)."""
    if a.index_dir:
        return a.index_dir
    if os.environ.get("DATASET_INDEX_DIR"):
        return os.environ["DATASET_INDEX_DIR"]
    if a.root:
        return default_index(a.root)
    for value in getattr(a, "snapshot", None) or []:
        if Path(value).is_dir():
            return str(Path(value).resolve().parent.parent / "index")
    sys.exit("give --index-dir (or set DATASET_INDEX_DIR), or a --root")


def gather(a, index_dir):
    """The folders to read: every --root plus every --snapshot, and the loaded snapshots. Stops with a clear message."""
    try:
        snaps = [load_snapshot(resolve_snapshot_dir(v, index_dir)) for v in (getattr(a, "snapshot", None) or [])]
    except SnapshotError as e:
        sys.exit(f"snapshot problem: {e}")
    roots = list(a.root) + [str(s["dir"]) for s in snaps]
    if not roots:
        sys.exit("give at least one --root or --snapshot")
    return roots, snaps


def manual_with_snapshots(index_dir, snaps):
    manual = read_manual(index_dir)
    manual.update(manual_groups(snaps))
    return manual


def verify_snapshots(snaps, rows):
    try:
        return check_against_index(snaps, rows)
    except SnapshotError as e:
        sys.exit(f"snapshot problem: {e}")


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
    if not a.root:
        sys.exit("give at least one --root")
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
    if not a.root:
        sys.exit("give at least one --root")
    ctx = prepare(a.root, a.index_dir or default_index(a.root), need_vectors=False, workers=a.workers)
    print(f"{len(ctx['rows'])} photos; thumbnails are ready.")
    ctx["index"].close()
    return 0


def cmd_audit(a):
    index_dir = index_dir_for(a)
    roots, snaps = gather(a, index_dir)
    ctx = prepare(roots, index_dir, a.embedder, a.weights, a.workers)
    if not ctx["rows"]:
        print("no photos found")
        return 1
    ctx["warnings"] = sorted(set(ctx["warnings"] + verify_snapshots(snaps, ctx["rows"])))
    for line in describe(snaps):
        print(line)
    manual = manual_with_snapshots(index_dir, snaps)
    groups, _ = assign_groups(ctx["rows"], ctx["vecs"], ctx["cfg"], manual)
    ctx["index"].set_groups(groups)
    rows = ctx["index"].rows(ctx["roots"])
    report = run_audit(rows, ctx["vecs"], ctx["cfg"], ctx["embedder"].name, ctx["warnings"],
                       ctx["embedder"].degraded, ctx["roots"])
    if a.report_out:      # keep the admin page's latest.json for the hand-made dataset
        atomic_write(a.report_out, json.dumps(report))
    else:
        save_report(index_dir, report)
    print_summary(report)
    ctx["index"].close()
    blocking = sum(report["summary"].get(k, 0) for k in BLOCKING)
    return 2 if (a.fail_on_leak and blocking) else 0


def cmd_split(a):
    index_dir = index_dir_for(a)
    roots, snaps = gather(a, index_dir)
    ctx = prepare(roots, index_dir, a.embedder, a.weights, a.workers)
    rows, cfg = ctx["rows"], ctx["cfg"]
    if not rows:
        print("no photos found")
        return 1
    ctx["warnings"] = sorted(set(ctx["warnings"] + verify_snapshots(snaps, rows)))
    groups, info = assign_groups(rows, ctx["vecs"], cfg, manual_with_snapshots(index_dir, snaps))
    plan = plan_split(rows, groups, cfg, load_frozen(index_dir), a.adopt, not a.no_repair, a.keep_duplicates, info)
    text = "\n".join(describe(snaps) + [summarize(plan)])
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
                                                "conflicts": plan["conflicts"], "snapshots": [x["name"] for x in snaps], "photos": manifest}))
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
        p.add_argument("--root", action="append", default=[], help="dataset folder (repeat for several)")
        p.add_argument("--index-dir", help="where index.sqlite, config.json and splits.json live (default: next to the first root)")
        p.add_argument("--embedder", choices=["auto", "mobilenet", "thumb"], default="auto")
        p.add_argument("--weights", default="imagenet", help="'imagenet' or a weights file path (offline use)")
        p.add_argument("--workers", type=int, default=4)

    s = sub.add_parser("scan"); common(s); s.set_defaults(fn=cmd_scan)
    s = sub.add_parser("thumbs"); common(s); s.set_defaults(fn=cmd_thumbs)
    def snapshots(p):
        p.add_argument("--snapshot", action="append", default=[],
                       help="a database snapshot (folder path, or the name of a folder in <datasets>/db-snapshots); repeat for several")

    s = sub.add_parser("audit"); common(s); snapshots(s)
    s.add_argument("--report-out", help="write the report to this file instead of <index>/reports/latest.json")
    s.add_argument("--fail-on-leak", action="store_true", help="exit 2 if a LEAK or CROSS_CLASS exists"); s.set_defaults(fn=cmd_audit)
    s = sub.add_parser("split"); common(s); snapshots(s)
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
