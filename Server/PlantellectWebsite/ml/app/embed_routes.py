"""FastAPI routes for the Other plant tools on the admin dataset page: /embed/*.

What they are for: photos that scans contributed as "Other plant" have no plant yet. The website sends small copies of
them (and of the photos of the plants that already exist); this service embeds them with the chosen embedder, keeps the
vectors by photo id, and answers which existing plants each photo (or each group of look-alikes) resembles. A person
decides; nothing is moved here and nothing but vectors is stored.

    GET  /embed/embedders   what can be chosen, what is chosen, what is loaded
    POST /embed/embedder    choose one (MobileNet, or a saved model such as model:convnexttiny)
    POST /embed/missing     which of these photo ids have no vector yet
    POST /embed/add         embed these photos (multipart, file name = photo id)
    POST /embed/suggest     closest existing plants for each photo
    POST /embed/cluster     group look-alike photos, and name the closest existing plants for each group
    POST /embed/forget      drop the vectors of photos that no longer exist

Safety is the same as the rest of the service: no request carries a path, ids are letters, digits, '_' and '-', sizes
are bounded, and one job runs at a time at low CPU use so /predict stays responsive.
"""
import asyncio
import os
from typing import List

from fastapi import APIRouter, File, HTTPException, UploadFile
from starlette.concurrency import run_in_threadpool

import lookalike
from dataset_tools import suggest as sg
from dataset_tools.fingerprint import list_embedders, parse_kind
from dataset_tools.holder import holder
from dataset_tools.vectors import VectorCache, read_choice, valid_key, write_choice

router = APIRouter(prefix="/embed", tags=["embed"])

INDEX_DIR = os.getenv("DATASET_INDEX_DIR", "")
ENV_KIND = os.getenv("DATASET_EMBEDDER", "auto")

MAX_UPLOAD = 40                  # photos per /embed/add request
MAX_QUERIES = 300                # photos asked about in one /embed/suggest or /embed/cluster
MAX_REFERENCE_KEYS = 6000        # reference photos named in one request
MAX_PLANTS = 1500

_slot = asyncio.Semaphore(1)


def _configured():
    if not INDEX_DIR:
        raise HTTPException(status_code=503, detail="Set DATASET_INDEX_DIR for the ML service")


def current_kind():
    _configured()
    return read_choice(INDEX_DIR, ENV_KIND)


def _embedder():
    """The chosen embedder, loaded. A problem loading it is a 409 the admin can act on, not a crash."""
    kind = current_kind()
    try:
        return holder.get(kind)
    except Exception as e:      # TensorFlow missing, model file missing or broken, ...
        raise HTTPException(status_code=409, detail=f"The embedder '{kind}' could not be loaded: {e}")


def _keys(value, limit, what="photo ids"):
    if not isinstance(value, list) or len(value) > limit:
        raise HTTPException(status_code=400, detail=f"{what} must be a list of at most {limit}")
    if not all(valid_key(k) for k in value):
        raise HTTPException(status_code=400, detail=f"{what} may only contain letters, digits, '_' and '-'")
    return list(dict.fromkeys(value))


def _references(value):
    if not isinstance(value, dict) or len(value) > MAX_PLANTS:
        raise HTTPException(status_code=400, detail=f"references must be an object of at most {MAX_PLANTS} plants")
    out, total = {}, 0
    for plant_id, keys in value.items():
        if not valid_key(plant_id):
            raise HTTPException(status_code=400, detail="plant ids may only contain letters, digits, '_' and '-'")
        out[plant_id] = _keys(keys, MAX_REFERENCE_KEYS, "reference photo ids")
        total += len(out[plant_id])
    if total > MAX_REFERENCE_KEYS:
        raise HTTPException(status_code=400, detail=f"at most {MAX_REFERENCE_KEYS} reference photos per request")
    return out


def _int(value, default, low, high):
    try:
        return max(low, min(high, int(value)))
    except (TypeError, ValueError):
        return default


def _float(value, default, low, high):
    try:
        return max(low, min(high, float(value)))
    except (TypeError, ValueError):
        return default


# ------------------------------------------------------------------------------------------------ choosing

@router.get("/embedders")
def embedders():
    kind = current_kind()
    loaded_kind, loaded_name = holder.loaded()
    with VectorCache(INDEX_DIR) as cache:
        stored = cache.counts()
    return {"current": kind, "available": list_embedders(), "loaded": {"kind": loaded_kind, "name": loaded_name}, "stored": stored}


@router.post("/embedder")
def choose(body: dict):
    _configured()
    try:
        kind = parse_kind(body.get("kind"))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    try:
        emb = holder.get(kind)          # load it now, so a broken choice is refused here and not at the next request
    except Exception as e:
        raise HTTPException(status_code=409, detail=f"The embedder '{kind}' could not be loaded: {e}")
    write_choice(INDEX_DIR, kind)
    return {"current": kind, "name": getattr(emb, "name", kind), "degraded": bool(getattr(emb, "degraded", False))}


# ------------------------------------------------------------------------------------------------ vectors

@router.post("/missing")
def missing(body: dict):
    keys = _keys(body.get("keys"), 5000)
    emb = _embedder()
    with VectorCache(INDEX_DIR) as cache:
        have = cache.have(emb.name, keys)
    return {"embedder": emb.name, "missing": [k for k in keys if k not in have], "have": len(have)}


@router.post("/add")
async def add(photos: List[UploadFile] = File(...)):
    _configured()
    if len(photos) > MAX_UPLOAD:
        raise HTTPException(status_code=400, detail=f"At most {MAX_UPLOAD} photos per request")
    items = []
    for f in photos:
        data = await f.read(lookalike.MAX_FILE_BYTES + 1)
        key = os.path.splitext(f.filename or "")[0]
        if not valid_key(key):
            raise HTTPException(status_code=400, detail="Photo ids may only contain letters, digits, '_' and '-'")
        items.append((key, data))
    async with _slot:
        emb = await run_in_threadpool(_embedder)

        def work():
            ids, vectors, skipped = lookalike._embed(emb, items)
            with VectorCache(INDEX_DIR) as cache:
                cache.put(emb.name, {i: v for i, v in zip(ids, vectors)})
            return {"embedder": emb.name, "added": len(ids), "skipped": skipped}
        return await run_in_threadpool(work)


@router.post("/forget")
def forget(body: dict):
    _configured()
    keys = _keys(body.get("keys"), 5000)
    with VectorCache(INDEX_DIR) as cache:
        cache.forget(keys)
    return {"forgotten": len(keys)}


# ------------------------------------------------------------------------------------------------ answers

def _gather(emb, queries, references):
    """Vectors for the queries and every reference photo, and what is still missing (counted, not an error)."""
    want = list(queries) + [k for keys in references.values() for k in keys]
    with VectorCache(INDEX_DIR) as cache:
        vecs = cache.get(emb.name, want)
    return vecs, {
        "queries": [k for k in queries if k not in vecs],
        "references": sum(1 for keys in references.values() for k in keys if k not in vecs),
    }


@router.post("/suggest")
def suggest(body: dict):
    queries = _keys(body.get("candidates"), MAX_QUERIES, "candidates")
    refs = _references({} if body.get("references") is None else body["references"])
    emb = _embedder()
    vecs, missing_ = _gather(emb, queries, refs)
    found = {k: vecs[k] for k in queries if k in vecs}
    result = sg.suggest(found, refs, vecs, top_k=_int(body.get("topK"), 3, 1, 10), knn=_int(body.get("knn"), sg.DEFAULT_KNN, 1, 10))
    return {"embedder": emb.name, "degraded": bool(getattr(emb, "degraded", False)), "suggestions": result, "missing": missing_}


@router.post("/cluster")
def cluster(body: dict):
    queries = _keys(body.get("keys"), MAX_QUERIES, "keys")
    refs = _references({} if body.get("references") is None else body["references"])
    emb = _embedder()
    vecs, missing_ = _gather(emb, queries, refs)
    found = {k: vecs[k] for k in queries if k in vecs}
    groups = sg.cluster(found, threshold=_float(body.get("threshold"), 0.80, 0.5, 0.999), cap=_int(body.get("cap"), 60, 2, 200))
    named = sg.suggest({str(i): g["centroid"] for i, g in enumerate(groups)}, refs, vecs,
                       top_k=_int(body.get("topK"), 3, 1, 10), knn=_int(body.get("knn"), sg.DEFAULT_KNN, 1, 10))
    out = [{"ids": g["ids"], "size": g["size"], "cohesion": g["cohesion"], "suggestions": named.get(str(i), [])} for i, g in enumerate(groups)]
    return {"embedder": emb.name, "degraded": bool(getattr(emb, "degraded", False)), "groups": out, "missing": missing_}
