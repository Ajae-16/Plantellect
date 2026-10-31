"""Name rules: first character uppercase only, and a safe folder name for Windows."""
import re

_FORBIDDEN = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_RESERVED = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}


def normalize_name(name: str) -> str:
    """Trim, collapse repeated spaces, uppercase the FIRST character only.

    'mangifera  indica' -> 'Mangifera indica'. Not title-case: 'Mangifera Indica' is wrong botanically,
    so everything after the first character is left exactly as given.
    """
    s = " ".join(str(name).split())
    return s[:1].upper() + s[1:] if s else s


def safe_folder_name(name: str, max_len: int = 100) -> str:
    """A name Windows accepts as a folder. The real name stays in the index / classes.json."""
    s = _FORBIDDEN.sub("-", normalize_name(name)).rstrip(" .")
    s = s[:max_len].rstrip(" .")
    if not s:
        return "_"
    if s.split(".")[0].upper() in _RESERVED:
        s = s + "_"
    return s


def collision_key(name: str) -> str:
    """Windows ignores case: two names with the same key cannot be separate folders."""
    return safe_folder_name(name).lower()
