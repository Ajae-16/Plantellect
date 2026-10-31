"""FastAPI route for the website's upload pipeline (plan stage 5): POST /convert/heic."""
import asyncio

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import Response
from starlette.concurrency import run_in_threadpool

import heic_convert

router = APIRouter(prefix="/convert", tags=["convert"])

# A 48-megapixel photo needs about 150 MB while it is decoded. Two at a time keeps the container well inside its limit,
# and the website queues the rest (it waits up to its own timeout).
_slots = asyncio.Semaphore(2)


@router.post("/heic")
async def convert_heic(image: UploadFile = File(...)):
    data = await image.read(heic_convert.MAX_BYTES + 1)   # never reads more than the limit, plus one byte to notice
    async with _slots:
        try:
            jpeg = await run_in_threadpool(heic_convert.heic_to_jpeg, data)
        except heic_convert.HeicError as e:
            raise HTTPException(status_code=e.status, detail=str(e))
    return Response(content=jpeg, media_type="image/jpeg", headers={"Cache-Control": "no-store"})
