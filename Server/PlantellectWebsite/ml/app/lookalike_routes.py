"""FastAPI route for the approval screen's look-alike hint (plan stage 7a): POST /lookalike/compare.

The website sends small copies of the pending photos and of some approved photos; the answer is a list of similarity
numbers. No path is accepted and nothing is written to disk. One comparison runs at a time and at low CPU use, so
plant identification (/predict) stays responsive.
"""
import asyncio
import os
import threading
from typing import List

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from starlette.concurrency import run_in_threadpool

import lookalike

router = APIRouter(prefix="/lookalike", tags=["lookalike"])

EMBEDDER_KIND = os.getenv("LOOKALIKE_EMBEDDER", os.getenv("DATASET_EMBEDDER", "auto"))

_slot = asyncio.Semaphore(1)
_embedder = None
_embedder_lock = threading.Lock()


def _get_embedder():
    """Loaded on first use, so the service starts fast and a missing TensorFlow only affects this route."""
    global _embedder
    with _embedder_lock:
        if _embedder is None:
            from dataset_tools.fingerprint import make_embedder
            _embedder = make_embedder(EMBEDDER_KIND)
        return _embedder


async def _read_all(files):
    items = []
    for f in files:
        data = await f.read(lookalike.MAX_FILE_BYTES + 1)
        items.append((os.path.splitext(f.filename or "")[0], data))
    return items


@router.post("/compare")
async def compare(
    candidates: List[UploadFile] = File(...),
    references: List[UploadFile] = File(default=[]),
    min_similarity: float = Form(0.9),
):
    if not 0.0 <= min_similarity <= 1.0:
        raise HTTPException(status_code=400, detail="min_similarity must be between 0 and 1")
    if len(candidates) > lookalike.MAX_CANDIDATES or len(references) > lookalike.MAX_REFERENCES:
        raise HTTPException(status_code=400, detail="Too many photos in one request")
    cand = await _read_all(candidates)
    refs = await _read_all(references)
    async with _slot:
        try:
            embedder = await run_in_threadpool(_get_embedder)
            return await run_in_threadpool(lookalike.compare, cand, refs, embedder, min_similarity)
        except lookalike.LookalikeError as e:
            raise HTTPException(status_code=e.status, detail=str(e))
