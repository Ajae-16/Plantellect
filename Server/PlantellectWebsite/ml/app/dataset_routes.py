"""FastAPI routes for the admin dataset page.

Safety: no request carries a path. The folders to audit come from the DATASET_ROOTS environment variable
(several roots separated by '|'), so a caller can only ever audit the dataset, never an arbitrary folder.

The audit runs as a CHILD PROCESS at low priority, not as a thread inside this server, so a long audit
cannot slow down plant identification (/predict) or hold its memory.
"""
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from dataset_tools import admin_ops as ops
from dataset_tools import audit_settings
from dataset_tools.config import atomic_write
from dataset_tools.vectors import read_choice

router = APIRouter(prefix="/dataset", tags=["dataset"])

ROOTS = [r for r in os.getenv("DATASET_ROOTS", "").split("|") if r.strip()]
INDEX_DIR = os.getenv("DATASET_INDEX_DIR", "")
EMBEDDER = os.getenv("DATASET_EMBEDDER", "auto")

_lock = threading.Lock()
# The last audit, running or finished. It is also written to <index dir>/last_audit.json at the start and at the end, so
# that EVERY admin sees who ran it, when, with which model, even after the ML service restarts (the page's "last run" icon).
_state = {"running": False, "startedAt": None, "startedBy": "", "finishedAt": None, "exitCode": None, "tail": [],
          "embedder": None, "thresholds": None}
_STATE_FILE = "last_audit.json"


def _now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _persist():
    """Caller holds _lock. A failure to write must never stop an audit, so it is only reported."""
    if not INDEX_DIR:
        return
    try:
        atomic_write(Path(INDEX_DIR) / _STATE_FILE, json.dumps(_state))
    except OSError as e:
        print(f"[warn] could not save the last audit state: {e}")


def _load_last():
    """Picks up the last audit after a restart. A run that was still going when the service stopped is shown as interrupted."""
    if not INDEX_DIR:
        return
    try:
        saved = json.loads((Path(INDEX_DIR) / _STATE_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    if not isinstance(saved, dict):
        return
    with _lock:
        _state.update({k: saved[k] for k in _state if k in saved})
        if _state["running"]:
            _state.update(running=False, exitCode=-2, tail=(list(_state["tail"]) + ["interrupted: the ML service restarted"])[-30:])


_load_last()


def _configured():
    if not ROOTS or not INDEX_DIR:
        raise HTTPException(status_code=503, detail="Set DATASET_ROOTS and DATASET_INDEX_DIR for the ML service")


def _run(cmd):
    def low_priority():
        try:
            os.nice(10)
        except Exception:
            pass
    # One TensorFlow thread, so the audit cannot take the CPU away from /predict (the container has a CPU limit).
    env = {**os.environ, "TF_NUM_INTRAOP_THREADS": "1", "TF_NUM_INTEROP_THREADS": "1", "OMP_NUM_THREADS": "1"}
    try:
        child = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env,
                                 preexec_fn=low_priority if os.name == "posix" else None,
                                 cwd=str(Path(__file__).resolve().parent))
        for line in child.stdout:
            with _lock:
                _state["tail"] = (_state["tail"] + [line.rstrip()[:300]])[-30:]
        code = child.wait()
    except Exception as e:  # could not even start
        code = -1
        with _lock:
            _state["tail"].append(f"could not start the audit: {e}")
    with _lock:
        _state.update(running=False, finishedAt=_now(), exitCode=code)
        _persist()


@router.post("/audit", status_code=202)
async def start_audit(body: dict = None):
    """Body (optional): { by } the name of the admin who started it, shown to the others. Not used for anything else."""
    _configured()
    by = "".join(c for c in str((body or {}).get("by") or "") if c.isprintable())[:64].strip()
    kind = read_choice(INDEX_DIR, EMBEDDER)
    try:
        cfg = audit_settings.read(INDEX_DIR, EMBEDDER)
        used = {"cosSimilar": cfg["cosSimilar"], "cosSame": cfg["cosSame"]}
    except (OSError, ValueError):
        used = None                  # an unreadable config.json: the audit itself will say so
    with _lock:
        if _state["running"]:
            raise HTTPException(status_code=409, detail="An audit is already running")
        _state.update(running=True, startedAt=_now(), startedBy=by, finishedAt=None, exitCode=None, tail=[],
                      embedder=kind, thresholds=used)
        _persist()
    cmd = [sys.executable, "-m", "dataset_tools.cli", "audit", "--index-dir", INDEX_DIR, "--embedder", kind]
    for root in ROOTS:
        cmd += ["--root", root]
    threading.Thread(target=_run, args=(cmd,), daemon=True).start()
    return {"started": True}


@router.get("/status")
async def audit_status():
    with _lock:
        return dict(_state)


@router.get("/audit-settings")
def get_audit_settings():
    _configured()
    return {**audit_settings.read(INDEX_DIR, EMBEDDER), "available": audit_settings.available()}


@router.put("/audit-settings")
def put_audit_settings(body: dict):
    """Body: any of { embedder, cosSimilar, cosSame }. Applies from the next audit."""
    _configured()
    try:
        saved = audit_settings.write(INDEX_DIR, body, EMBEDDER)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {**saved, "available": audit_settings.available()}


@router.get("/report")
async def audit_report():
    _configured()
    path = Path(INDEX_DIR) / "reports" / "latest.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail="No audit has run yet")
    return json.loads(path.read_text(encoding="utf-8"))


# ------------------------------------------------------------------------------------------------
# what the admin dataset page uses. Plain `def` so FastAPI runs them in its thread pool.
# ------------------------------------------------------------------------------------------------

def _call(fn, *args, **kwargs):
    _configured()
    try:
        return fn(INDEX_DIR, ROOTS, *args, **kwargs)
    except ops.OpError as e:
        raise HTTPException(status_code=e.status, detail=str(e))


def _not_while_auditing():
    with _lock:
        if _state["running"]:
            raise HTTPException(status_code=409, detail="An audit is running; try again when it has finished")


@router.get("/overview")
def overview():
    return _call(ops.overview)


@router.get("/clusters")
def clusters(category: str = "", reviewed: int = 0, page: int = 1, size: int = 10):
    return _call(ops.clusters_page, category=category, reviewed=bool(reviewed), page=page, size=size)


@router.get("/mislabels")
def mislabels(page: int = 1, size: int = 10):
    return _call(ops.mislabels_page, page=page, size=size)


@router.get("/grid")
def grid():
    return _call(ops.grid)


@router.get("/browse")
def browse(label: str = "", part: str = "", split: str = "", kind: str = "", page: int = 1, size: int = 24):
    return _call(ops.browse, label=label, part=part, split=split, kind=kind, page=page, size=size)


@router.get("/folder")
def folder(split: str = "", kind: str = "", label: str = "", part: str = "", source: str = "", page: int = 1, size: int = 24):
    return _call(ops.folder, split=split, kind=kind, label=label, part=part, source=source, page=page, size=size)


@router.get("/thumb/{pid}")
def thumb(pid: str):
    path = _call(ops.thumbnail, pid)
    return FileResponse(str(path), media_type="image/jpeg", headers={"Cache-Control": "private, max-age=86400"})


@router.post("/review")
def review(body: dict):
    return _call(ops.review, body.get("clusterId"), body.get("decision"))


@router.get("/quarantine")
def quarantine_list():
    _configured()
    return {"items": ops.quarantined(INDEX_DIR)}


@router.post("/quarantine")
def quarantine(body: dict):
    _not_while_auditing()
    pids = body.get("pids")
    if not isinstance(pids, list):
        raise HTTPException(status_code=400, detail="pids must be a list")
    return _call(ops.quarantine, pids, note=body.get("note") or "")


@router.post("/restore")
def restore(body: dict):
    _not_while_auditing()
    return _call(ops.restore, body.get("qid"))


@router.get("/destinations")
def destinations():
    return _call(ops.destinations)


@router.post("/labels")
def labels(body: dict):
    """Which species (label and kind) each photo is filed under. Read-only; the web server uses it for species locks."""
    pids = body.get("pids")
    if not isinstance(pids, list) or len(pids) > 200:
        raise HTTPException(status_code=400, detail="pids must be a list of at most 200")
    return _call(ops.labels_of, pids)


@router.post("/move")
def move(body: dict):
    pids = body.get("pids")
    dest = body.get("dest")
    if not isinstance(pids, list) or not isinstance(dest, dict):
        raise HTTPException(status_code=400, detail="pids must be a list and dest an object")
    preview = bool(body.get("preview"))
    if not preview:
        _not_while_auditing()
    return _call(ops.move, pids, dest, preview=preview)


@router.post("/group")
def group(body: dict):
    pids = body.get("pids")
    if not isinstance(pids, list):
        raise HTTPException(status_code=400, detail="pids must be a list")
    return _call(ops.add_group, pids)


@router.post("/parts")
def parts(body: dict):
    return _call(ops.add_part, body.get("part") or "", body.get("species") or "")
