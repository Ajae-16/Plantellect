"""Everything the admin dataset page does to the dataset (plan stage 3).

All file work happens here, inside the ML container where the dataset is mounted. A request never carries a
path: photos are named by an opaque id (pid = hash of the path, resolved through the index), clusters by their
id, species by their name. Every path is checked to be inside one of the configured dataset roots.
Nothing is deleted: "remove" moves a photo to <root>/_quarantine/<stamp>/<same relative path>.
"""
import csv
import hashlib
import json
import re
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image, ImageOps

from .audit import pid_of
from .config import KIND_TO_FOLDER, SPLITS, atomic_write, load_config
from .fingerprint import load_rgb
from .index import Index
from .names import normalize_name, safe_folder_name
from .stats import dataset_stats

PID_RE = re.compile(r"^[0-9a-f]{16}$")
CLUSTER_RE = re.compile(r"^[0-9a-f]{12}$")
THUMB = 320
_report_cache = {"key": None, "data": None}


class OpError(ValueError):
    """A problem the caller can fix; routes turn it into a 400/404."""

    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def _roots(roots):
    return [Path(r).resolve() for r in roots]


def _inside(path, roots):
    p = Path(path).resolve()
    return any(root == p or root in p.parents for root in roots)


# ------------------------------------------------------------------------------------------ cached index reads
# Every page load asks for the same rows again and again, and a page of thumbnails asks 24 times at once.
# Rows are read once per change of index.sqlite (through a read-only connection, so a running audit is not
# disturbed) and kept in memory. A write by this module or by the audit changes the file and refreshes them.
_rows_lock = threading.Lock()
_rows_cache = {"key": None, "rows": [], "by_pid": {}}


def _all_rows(index_dir):
    db = Path(index_dir) / "index.sqlite"
    if not db.exists():
        return [], {}
    st = db.stat()
    key = (str(db), st.st_mtime_ns, st.st_size)
    with _rows_lock:
        if _rows_cache["key"] != key:
            con = sqlite3.connect(f"{db.resolve().as_uri()}?mode=ro", uri=True, timeout=30)
            con.row_factory = sqlite3.Row
            try:
                rows = [dict(r) for r in con.execute("SELECT * FROM photos ORDER BY path")]
            finally:
                con.close()
            for r in rows:
                r["pid"] = pid_of(r["path"])
            _rows_cache.update(key=key, rows=rows, by_pid={r["pid"]: r for r in rows})
        return _rows_cache["rows"], _rows_cache["by_pid"]


def _rows(index_dir, roots, ok_only=True):
    want = {str(r) for r in _roots(roots)}
    return [r for r in _all_rows(index_dir)[0] if r["root"] in want and (r["ok"] or not ok_only)]


def _lookup(index_dir, roots, pids):
    """pid -> index row, only for photos that sit inside a configured root."""
    for pid in pids:
        if not isinstance(pid, str) or not PID_RE.match(pid):
            raise OpError("bad photo id")
    by_pid = _all_rows(index_dir)[1]
    rs = _roots(roots)
    return {pid: by_pid[pid] for pid in pids if pid in by_pid and _inside(by_pid[pid]["path"], rs)}


def _report(index_dir):
    path = Path(index_dir) / "reports" / "latest.json"
    if not path.exists():
        return None
    key = path.stat().st_mtime_ns
    if _report_cache["key"] != key:
        _report_cache.update(key=key, data=json.loads(path.read_text(encoding="utf-8")))
    return _report_cache["data"]


def _json_file(path, default):
    p = Path(path)
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else default


def _page(items, page, size):
    size = max(1, min(int(size), 60))
    page = max(1, int(page))
    return items[(page - 1) * size: page * size], page, size


# ------------------------------------------------------------------------ read
def overview(index_dir, roots):
    cfg = load_config(index_dir)
    rows = _rows(index_dir, roots)
    report = _report(index_dir)
    by_split, by_kind = {}, {}
    for r in rows:
        by_split[r["split"] or "pool"] = by_split.get(r["split"] or "pool", 0) + 1
        by_kind[r["kind"]] = by_kind.get(r["kind"], 0) + 1
    review = _json_file(Path(index_dir) / "review.json", {})
    return {
        "photos": len(rows), "bySplit": by_split, "byKind": by_kind,
        "species": sorted({r["label"] for r in rows if r["kind"] == "species"}),
        "parts": cfg["parts"], "minGroups": cfg["min_groups"],
        "reviewed": len(review), "quarantined": len(quarantined(index_dir)),
        "report": None if not report else {
            "generatedAt": report["generatedAt"], "embedder": report["embedder"],
            "embedderDegraded": report["embedderDegraded"], "summary": report["summary"],
            "nearestNeighbour": report["nearestNeighbour"], "thresholds": report["thresholds"],
            "warnings": report["warnings"][:50], "warningCount": len(report["warnings"]),
            "softCapped": report.get("softCapped", False)},
    }


def clusters_page(index_dir, roots, category="", reviewed=False, page=1, size=10):
    report = _report(index_dir)
    if not report:
        return {"report": False, "total": 0, "clusters": []}
    review = _json_file(Path(index_dir) / "review.json", {})
    items = [c for c in report["clusters"]
             if (not category or c["category"] == category) and ((c["id"] in review) == bool(reviewed))]
    part, page, size = _page(items, page, size)
    live = {r["pid"] for r in _rows(index_dir, roots, ok_only=False)}
    out = []
    for c in part:
        members = [dict(m, gone=m.get("pid") not in live) for m in c["members"]]
        out.append(dict(c, members=members, decision=(review.get(c["id"]) or {}).get("decision")))
    return {"report": True, "total": len(items), "page": page, "pageSize": size, "clusters": out}


def mislabels_page(index_dir, roots, page=1, size=10):
    report = _report(index_dir)
    if not report:
        return {"report": False, "total": 0, "items": []}
    part, page, size = _page(report["mislabels"], page, size)
    return {"report": True, "total": len(report["mislabels"]), "page": page, "pageSize": size, "items": part}


def grid(index_dir, roots):
    cfg = load_config(index_dir)
    rows = _rows(index_dir, roots)
    stats = dataset_stats(rows, cfg)
    return {"parts": cfg["parts"], "minGroups": cfg["min_groups"], "species": stats["species"], "otherKinds": stats["otherKinds"]}


def browse(index_dir, roots, label="", part="", split="", kind="", page=1, size=24):
    rows = _rows(index_dir, roots)
    want_part = None if not part else ("" if part == "(no part)" else part)
    sel = [r for r in rows
           if (not label or r["label"].lower() == label.lower()) and (not kind or r["kind"] == kind)
           and (not split or (r["split"] or "pool") == split)
           and (want_part is None or (r["part"] or "") == want_part)]
    sel.sort(key=lambda r: (r["kind"], r["label"], r["part"] or "", r["split"] or "", r["rel"]))
    part_rows, page, size = _page(sel, page, size)
    return {"total": len(sel), "page": page, "pageSize": size,
            "items": [_photo(r) for r in part_rows]}


def _photo(r):
    return {"pid": r["pid"], "sha": r["sha256"], "split": r["split"], "kind": r["kind"], "label": r["label"],
            "part": r["part"], "source": r["source"], "name": Path(r["rel"]).name}


_KIND_ORDER = ["species", "other_plant", "non_plant"]
_LEVELS = ["split", "kind", "label", "part", "source"]


def _crumb(level, value):
    return KIND_TO_FOLDER.get(value, value) if level == "kind" else (value or "(no part)")


def folder(index_dir, roots, split="", kind="", label="", part="", source="", page=1, size=24):
    """One level of the dataset as folders, like a file manager.

    Levels: split -> kind (Plant / Other plant / Non plant) -> species -> part -> session folder -> photos.
    The parameters already chosen say where you are; the next level down is returned as `folders`, each with
    a photo count and a cover photo. Photos are listed where there is nothing deeper (or next to session folders).
    A dataset with no train/val/test split skips that level.
    """
    rows = _rows(index_dir, roots)
    has_split = any(r["split"] for r in rows)
    split_of = lambda r: r["split"] or "pool"
    cur = {"split": split, "kind": kind, "label": label, "part": part, "source": source}
    if not has_split and not split:
        cur["split"] = "pool"

    sel = [r for r in rows
           if (not cur["split"] or split_of(r) == cur["split"]) and (not cur["kind"] or r["kind"] == cur["kind"])
           and (not cur["label"] or r["label"] == cur["label"])
           and (not cur["part"] or (r["part"] or "(no part)") == cur["part"])
           and (not cur["source"] or r["source"] == cur["source"])]
    if not sel and any((split, kind, label, part, source)):
        raise OpError("folder not found", 404)

    def group(subset, level, keyfn, order=None):
        buckets = {}
        for r in subset:
            buckets.setdefault(keyfn(r), []).append(r)
        rank = (lambda n: (order.index(n) if n in order else 99, n.lower())) if order else (lambda n: (0, n.lower()))
        out = []
        for n in sorted(buckets, key=rank):
            first = min(buckets[n], key=lambda r: r["rel"])
            out.append({"name": _crumb(level, n), "value": n, "count": len(buckets[n]),
                        "cover": {"pid": first["pid"], "sha": first["sha256"]}})
        return out

    folders, loose, level = [], [], None
    if not cur["split"]:
        level = "split"
        folders = group(sel, "split", split_of, ["train", "val", "test", "pool"])
    elif not cur["kind"]:
        level = "kind"
        folders = group(sel, "kind", lambda r: r["kind"], _KIND_ORDER)
    elif not cur["label"]:
        level = "label"
        folders = group(sel, "label", lambda r: r["label"])
    elif cur["kind"] == "species" and not cur["part"]:
        level = "part"
        folders = group(sel, "part", lambda r: r["part"] or "(no part)", load_config(index_dir)["parts"] + ["(no part)"])
    elif not cur["source"] and any(r["source"] for r in sel):
        level = "source"
        folders = group([r for r in sel if r["source"]], "source", lambda r: r["source"])
        loose = [r for r in sel if not r["source"]]               # photos directly in the part, beside the folders
    else:
        loose = sel
    loose.sort(key=lambda r: r["rel"])
    shown, page, size = _page(loose, page, size)

    crumbs, chosen = [], {}
    for lv in _LEVELS:
        v = cur[lv]
        if not v or (lv == "split" and v == "pool" and not has_split):
            continue
        chosen[lv] = v
        crumbs.append({"label": _crumb(lv, v), "params": dict(chosen)})
    return {"crumbs": crumbs, "parent": dict(crumbs[-2]["params"]) if len(crumbs) > 1 else {},
            "atRoot": not crumbs, "level": level, "folders": folders, "photos": [_photo(r) for r in shown],
            "photoTotal": len(loose), "page": page, "pageSize": size, "photosInside": len(sel)}


def thumb_path(index_dir, sha):
    return Path(index_dir) / "thumbs" / sha[:2] / f"{sha}.jpg"


def make_thumbnail(src, dest):
    """320 px JPEG. A JPEG is first decoded at a reduced scale (PIL's draft mode), which is several times
    faster than decoding a full phone photo and is plenty for a thumbnail."""
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(src) as im:
        im.draft("RGB", (THUMB * 2, THUMB * 2))
        im = ImageOps.exif_transpose(im).convert("RGB")
        im.thumbnail((THUMB, THUMB))
        tmp = dest.with_name(dest.name + f".{threading.get_ident()}.tmp")
        im.save(tmp, format="JPEG", quality=80)
    tmp.replace(dest)


_thumb_locks, _thumb_guard = {}, threading.Lock()


def thumbnail(index_dir, roots, pid):
    """Path of the cached thumbnail for a photo, creating it on first use (once, however many ask at once)."""
    row = _lookup(index_dir, roots, [pid]).get(pid)
    if not row or not row["ok"]:
        raise OpError("photo not found", 404)
    dest = thumb_path(index_dir, row["sha256"])
    if dest.exists():
        return dest
    if not Path(row["path"]).exists():
        raise OpError("photo not found", 404)
    with _thumb_guard:
        lock = _thumb_locks.setdefault(row["sha256"], threading.Lock())
    with lock:
        if not dest.exists():
            make_thumbnail(row["path"], dest)
    return dest


def warm_thumbnails(index_dir, rows, workers=2, progress=None):
    """Make every missing thumbnail now, so the page never waits for one. Idempotent; bad files are skipped."""
    todo, seen = [], set()
    for r in rows:
        if r["ok"] and r["sha256"] not in seen:
            seen.add(r["sha256"])
            if not thumb_path(index_dir, r["sha256"]).exists():
                todo.append(r)
    made = failed = 0

    def work(r):
        try:
            make_thumbnail(r["path"], thumb_path(index_dir, r["sha256"]))
            return True
        except Exception:
            return False

    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        for i, ok in enumerate(pool.map(work, todo), 1):
            made += ok
            failed += not ok
            if progress and i % 500 == 0:
                progress(f"thumbnails {i}/{len(todo)}")
    return {"made": made, "failed": failed, "already": len(seen) - len(todo)}


# ----------------------------------------------------------------------- decide
def review(index_dir, roots, cluster_id, decision):
    if not isinstance(cluster_id, str) or not CLUSTER_RE.match(cluster_id):
        raise OpError("bad cluster id")
    if decision not in ("kept", "removed"):
        raise OpError("decision must be kept or removed")
    path = Path(index_dir) / "review.json"
    data = _json_file(path, {})
    data[cluster_id] = {"decision": decision, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    atomic_write(path, json.dumps(data, indent=1))
    return {"ok": True}


def _qlog(index_dir):
    return Path(index_dir) / "quarantine.jsonl"


def quarantined(index_dir):
    """Photos currently in quarantine (newest first)."""
    p = _qlog(index_dir)
    if not p.exists():
        return []
    live, order = {}, []
    for line in p.read_text(encoding="utf-8").splitlines():
        e = json.loads(line)
        if "restoredAt" in e:
            live.pop(e["qid"], None)
        else:
            live[e["qid"]] = e
            order.append(e["qid"])
    return [live[q] for q in reversed(order) if q in live]


def quarantine(index_dir, roots, pids, note=""):
    roots = _roots(roots)
    pids = list(dict.fromkeys(pids))[:50]
    if not pids:
        raise OpError("nothing to remove")
    index = Index(index_dir)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    moved, missing = 0, []
    try:
        found = _lookup(index_dir, roots, pids)
        for pid in pids:
            row = found.get(pid)
            if not row or not Path(row["path"]).exists():
                missing.append(pid)
                continue
            root = Path(row["root"]).resolve()
            src = Path(row["path"]).resolve()
            rel = src.relative_to(root)
            dest = root / "_quarantine" / stamp / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            src.replace(dest)
            entry = {"qid": hashlib.sha1(str(dest).encode()).hexdigest()[:16], "at": stamp, "root": str(root),
                     "rel": rel.as_posix(), "qpath": str(dest), "sha256": row["sha256"], "label": row["label"],
                     "split": row["split"], "note": str(note)[:200]}
            with open(_qlog(index_dir), "a", encoding="utf-8") as f:
                f.write(json.dumps(entry) + "\n")
            index.db.execute("DELETE FROM photos WHERE path = ?", (row["path"],))
            moved += 1
        index.db.commit()
    finally:
        index.close()
    return {"moved": moved, "missing": missing}


def restore(index_dir, roots, qid):
    roots = _roots(roots)
    entry = next((e for e in quarantined(index_dir) if e["qid"] == qid), None)
    if not entry:
        raise OpError("not in quarantine", 404)
    root = Path(entry["root"]).resolve()
    src, dest = Path(entry["qpath"]).resolve(), root / entry["rel"]
    if root not in roots or not _inside(src, [root]) or not _inside(dest, [root]):
        raise OpError("outside the dataset")
    if not src.exists():
        raise OpError("the quarantined file is gone", 404)
    if dest.exists():
        raise OpError("a file already exists at the original place", 409)
    dest.parent.mkdir(parents=True, exist_ok=True)
    src.replace(dest)
    with open(_qlog(index_dir), "a", encoding="utf-8") as f:
        f.write(json.dumps({"qid": qid, "restoredAt": time.strftime("%Y%m%d-%H%M%S")}) + "\n")
    return {"ok": True, "note": "It returns to the index at the next scan or audit."}


def destinations(index_dir, roots):
    """What the Move panel can offer: splits, kinds, the folders that exist under each kind, and the parts."""
    cfg = load_config(index_dir)
    rows = _rows(index_dir, roots)
    labels = {"species": set(), "other_plant": set(), "non_plant": set()}
    for r in rows:
        labels[r["kind"]].add(r["label"])
    return {"hasSplit": any(r["split"] for r in rows), "splits": list(SPLITS),
            "kinds": [{"value": k, "name": KIND_TO_FOLDER[k]} for k in ("species", "other_plant", "non_plant")],
            "labels": {k: sorted(v, key=str.lower) for k, v in labels.items()}, "parts": cfg["parts"]}


def _example_segments(rows, root, split, kind):
    """The folder names this dataset already uses for a split and a kind (so 'Other_plant' stays 'Other_plant')."""
    for r in rows:
        if r["root"] == str(root) and r["kind"] == kind and (split is None or r["split"] == split):
            parts = Path(r["rel"]).parts
            return (parts[0], parts[1]) if split is not None else (None, parts[0])
    return (split, KIND_TO_FOLDER[kind]) if split is not None else (None, KIND_TO_FOLDER[kind])


def _plan_one(row, dest, cfg, all_rows, keep_source):
    root = Path(row["root"]).resolve()
    in_root = [r for r in all_rows if r["root"] == str(root)]
    is_split_tree = any(r["split"] for r in in_root)
    kind = dest.get("kind")
    if kind not in KIND_TO_FOLDER:
        raise OpError("choose Plant, Other plant or Non plant")
    split = (dest.get("split") or "") if is_split_tree else None
    if is_split_tree and split not in SPLITS:
        raise OpError("choose train, val or test")
    label = " ".join(str(dest.get("label") or "").split())
    part = " ".join(str(dest.get("part") or "").split())
    folder_label = None
    if kind == "species":
        known = [r for r in in_root if r["label"].lower() == label.lower() and r["kind"] in ("species", "other_plant")]
        if not label or not known:
            raise OpError("unknown species folder", 404)
        label = next((r["label"] for r in known if r["kind"] == "species"), known[0]["label"])
        folder_label = next((r["folder_label"] for r in known if r["kind"] == "species"), safe_folder_name(label))
        match = [p for p in cfg["parts"] if p.lower() == part.lower()]
        if not match:
            raise OpError("choose one of the parts: " + ", ".join(cfg["parts"]))
        part = match[0]
    elif kind == "other_plant":
        known = [r for r in in_root if r["kind"] == "other_plant" and r["label"].lower() == label.lower()]
        if not label or not known:
            raise OpError("unknown Other plant folder", 404)
        label, folder_label, part = known[0]["label"], known[0]["folder_label"], None
    else:
        known = [r for r in in_root if r["kind"] == "non_plant" and r["label"].lower() == label.lower()]
        label = known[0]["label"] if known else "Non plant"
        folder_label = known[0]["folder_label"] if known and label != "Non plant" else None
        part = None
    split_folder, kind_folder = _example_segments(in_root, root, split, kind)
    segs = [s for s in (split_folder, kind_folder) if s]
    if folder_label and not (kind == "non_plant" and label == "Non plant"):
        segs.append(folder_label)
    if part:
        segs.append(safe_folder_name(part))
    source = row["source"] if (keep_source and kind == "species" and row["source"]) else ""
    if source:
        segs.append(source)
    target = root.joinpath(*segs, Path(row["path"]).name)
    return {"root": root, "split": split, "kind": kind, "label": label, "folder_label": folder_label or label,
            "part": part, "source": source, "target": target}


def move(index_dir, roots, pids, dest, preview=False, keep_source=True):
    """Move photos to another folder of the same dataset. preview=True only reports what would happen.

    Nothing is overwritten (a name clash gets -2, -3 ...). Each moved photo keeps its hashes; its group is cleared
    until the next audit. A photo that moves to a different split also updates splits.json, so the next split
    keeps your correction instead of restoring the old placement."""
    roots = _roots(roots)
    pids = list(dict.fromkeys(pids))[:50]
    if not pids:
        raise OpError("nothing to move")
    if not isinstance(dest, dict):
        raise OpError("choose a destination")
    cfg = load_config(index_dir)
    found = _lookup(index_dir, roots, pids)
    if len(found) != len(pids):
        raise OpError("one of the photos is no longer in the dataset", 404)
    all_rows = _rows(index_dir, roots)
    by_group = {}
    for r in all_rows:
        if r.get("group_key"):
            by_group.setdefault(r["group_key"], []).append(r)
    taken, plan, warnings = set(), [], []
    for pid in pids:
        row = found[pid]
        p = _plan_one(row, dest, cfg, all_rows, keep_source)
        target = p["target"]
        if not _inside(target, [p["root"]]):
            raise OpError("destination is outside the dataset")
        if Path(row["path"]).resolve() == target.resolve():
            plan.append(dict(p, pid=pid, row=row, skip=True, target=target))
            continue
        n = 2
        while (target.exists() or target in taken):
            target = target.with_name(f"{Path(row['path']).stem}-{n}{Path(row['path']).suffix}")
            n += 1
        taken.add(target)
        plan.append(dict(p, pid=pid, row=row, skip=False, target=target))
        same_sha = [r for r in all_rows if r["sha256"] == row["sha256"] and r["path"] != row["path"]]
        if same_sha:
            warnings.append(f"{Path(row['path']).name}: an identical photo already exists elsewhere in the dataset")
    moving = {x["row"]["path"] for x in plan if not x["skip"]}
    for x in plan:
        g = x["row"].get("group_key")
        if x["skip"] or not g or x["split"] is None:
            continue
        others = {r["split"] for r in by_group.get(g, []) if r["path"] not in moving and r["split"] and r["split"] != x["split"]}
        if others:
            warnings.append(f"{Path(x['row']['path']).name}: it shares a group with photos in {', '.join(sorted(others))}; "
                            f"moving it to {x['split']} would split that group (move the whole group)")
    summary = {"count": sum(1 for x in plan if not x["skip"]), "skipped": sum(1 for x in plan if x["skip"]),
               "to": {k: v for k, v in (("split", plan[0]["split"]), ("kind", KIND_TO_FOLDER[plan[0]["kind"]]),
                                        ("label", plan[0]["label"]), ("part", plan[0]["part"])) if v},
               "warnings": warnings}
    if preview:
        return dict(summary, preview=True)

    index = Index(index_dir)
    frozen_path = Path(index_dir) / "splits.json"
    frozen = _json_file(frozen_path, {})
    frozen_changed = False
    log = []
    try:
        for x in plan:
            if x["skip"]:
                continue
            row, target = x["row"], x["target"]
            target.parent.mkdir(parents=True, exist_ok=True)
            Path(row["path"]).replace(target)
            rel = target.relative_to(x["root"]).as_posix()
            index.db.execute(
                "UPDATE photos SET path=?, rel=?, split=?, kind=?, label=?, folder_label=?, part=?, source=?, group_key=NULL "
                "WHERE path=?", (str(target), rel, x["split"], x["kind"], x["label"], x["folder_label"], x["part"],
                                 x["source"], row["path"]))
            if x["split"] and row["sha256"] in frozen and frozen[row["sha256"]] != x["split"]:
                frozen[row["sha256"]] = x["split"]
                frozen_changed = True
            log.append({"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "sha256": row["sha256"],
                        "from": row["rel"], "to": rel, "root": str(x["root"])})
        index.db.commit()
    finally:
        index.close()
    if frozen_changed:
        atomic_write(frozen_path, json.dumps(frozen, indent=0, sort_keys=True))
    if log:
        with open(Path(index_dir) / "moves.jsonl", "a", encoding="utf-8") as f:
            f.writelines(json.dumps(e) + "\n" for e in log)
    return dict(summary, preview=False, moved=len(log), note="Run an audit to re-check for leaks and refresh the groups.")


def add_group(index_dir, roots, pids):
    """Photos that must always share a split (appended to groups_manual.csv; used by the next audit and split)."""
    roots = _roots(roots)
    pids = list(dict.fromkeys(pids))[:50]
    if len(pids) < 2:
        raise OpError("pick at least two photos")
    found = _lookup(index_dir, roots, pids)
    if len(found) != len(pids):
        raise OpError("one of the photos is no longer in the dataset", 404)
    name = "manual-" + hashlib.sha1("|".join(sorted(pids)).encode()).hexdigest()[:8]
    p = Path(index_dir) / "groups_manual.csv"
    new = not p.exists()
    with open(p, "a", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        if new:
            w.writerow(["group", "path"])
        for pid in pids:
            w.writerow([name, found[pid]["path"]])
    return {"group": name, "photos": len(pids)}


def add_part(index_dir, roots, part, species=""):
    """A new part row: add the name to config.json and, for a species, create its folder in every split."""
    roots = _roots(roots)
    part = " ".join(str(part).split())
    if not 2 <= len(part) <= 40 or normalize_name(part) != part or safe_folder_name(part) != part:
        raise OpError("part names start with an uppercase letter and use no special characters")
    cfg = load_config(index_dir)
    cfg_path = Path(index_dir) / "config.json"
    raw = _json_file(cfg_path, {})
    if part.lower() not in [p.lower() for p in cfg["parts"]]:
        raw["parts"] = cfg["parts"] + [part]
        raw.setdefault("part_targets", dict(cfg["part_targets"]))[part] = 1
        atomic_write(cfg_path, json.dumps(raw, indent=2))
    created = []
    if species:
        rows = [r for r in _rows(index_dir, roots) if r["kind"] == "species" and r["label"].lower() == species.lower()]
        if not rows:
            raise OpError("unknown species", 404)
        seen = set()
        for r in rows:
            root = Path(r["root"]).resolve()
            if (str(root)) in seen:
                continue
            seen.add(str(root))
            relp = Path(r["rel"]).parts
            if r["split"]:
                folder_parts = relp[1:3]                  # <Plant>/<Species folder>
                targets = [root / s / Path(*folder_parts) / part for s in SPLITS]
            else:
                targets = [root / Path(*relp[0:2]) / part]
            for t in targets:
                if _inside(t, [root]) and not t.exists():
                    t.mkdir(parents=True, exist_ok=True)
                    created.append(str(t.relative_to(root).as_posix()))
    return {"part": part, "created": created}
