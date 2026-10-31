"""HEIC/HEIF -> upright JPEG with no metadata (dataset handler plan, stage 5).

The website cannot decode HEIC itself (sharp does not fully support it), so its upload pipeline sends an iPhone
photo here and gets back a plain JPEG, which sharp then turns into the master WebP.

Privacy rule: no photo metadata is read or kept. The only thing used is the orientation, to turn the picture
upright. The JPEG that comes back carries no EXIF, GPS, capture time or thumbnail, and only the primary image of
the file is decoded (never a burst, a depth map or a thumbnail).

Limits (a bad file must not be able to exhaust the container):
  - HEIC_MAX_BYTES   largest upload accepted (default 25 MB; the website's own limit is 10 MB)
  - HEIC_MAX_PIXELS  largest picture decoded (default 80 million), checked from the header BEFORE decoding
The website also stops waiting after its own timeout.
"""
import io
import os

from PIL import Image, ImageOps

MAX_BYTES = int(os.getenv("HEIC_MAX_BYTES", str(25 * 1024 * 1024)))
MAX_PIXELS = int(os.getenv("HEIC_MAX_PIXELS", str(80_000_000)))
JPEG_QUALITY = 95

# Brands that mark a HEIC/HEIF file (bytes 8..12, right after "ftyp").
HEIF_BRANDS = {b"heic", b"heix", b"heim", b"heis", b"hevc", b"hevx", b"hevm", b"hevs", b"mif1", b"msf1"}


class HeicError(ValueError):
    """The photo cannot be converted. `status` is the HTTP status to answer with."""
    status = 400


class HeicTooLarge(HeicError):
    status = 413


def looks_like_heif(data: bytes) -> bool:
    return len(data) >= 12 and data[4:8] == b"ftyp" and data[8:12] in HEIF_BRANDS


_registered = False


def _open_heif(data: bytes) -> Image.Image:
    """Opens the PRIMARY image only. pillow-heif is imported here so the rest of the service starts without it."""
    global _registered
    import pillow_heif
    if not _registered:
        pillow_heif.register_heif_opener()
        _registered = True
    return Image.open(io.BytesIO(data))


def _to_srgb(im: Image.Image) -> Image.Image:
    """iPhones shoot in Display P3. With no profile kept, colours would look washed out, so convert to sRGB first."""
    profile = im.info.get("icc_profile")
    if not profile:
        return im
    try:
        from PIL import ImageCms
        source = ImageCms.ImageCmsProfile(io.BytesIO(profile))
        if ImageCms.getProfileDescription(source).strip().lower().startswith("srgb"):
            return im
        return ImageCms.profileToProfile(im, source, ImageCms.createProfile("sRGB"), outputMode="RGB")
    except Exception:
        return im  # an unreadable profile is not a reason to refuse the photo


def heic_to_jpeg(data: bytes, max_pixels: int = None, opener=None) -> bytes:
    """Returns JPEG bytes. `opener` (bytes -> PIL image) is for tests only."""
    max_pixels = MAX_PIXELS if max_pixels is None else max_pixels
    if len(data) > MAX_BYTES:
        raise HeicTooLarge("the photo is too large")
    if opener is None and not looks_like_heif(data):
        raise HeicError("not a HEIC/HEIF file")

    try:
        im = (opener or _open_heif)(data)
        width, height = im.size  # from the header: nothing is decoded yet
    except HeicError:
        raise
    except Exception:
        raise HeicError("the photo could not be read")
    if width * height > max_pixels:
        raise HeicTooLarge("the photo has too many pixels")

    try:
        im.load()                           # decodes the primary image only
        im = ImageOps.exif_transpose(im)    # the orientation flag, the only metadata used
        im = im.convert("RGB")
        im = _to_srgb(im)
        im.info = {}                        # nothing the file carried goes into the output
        out = io.BytesIO()
        im.save(out, format="JPEG", quality=JPEG_QUALITY, subsampling=0)  # no exif=, no icc_profile=
        return out.getvalue()
    except HeicError:
        raise
    except Exception:
        raise HeicError("the photo could not be decoded")
