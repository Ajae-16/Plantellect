"""Embeddings of the website's DATABASE photos, kept between requests, and the admin's choice of embedder.

The folder dataset has its own embedding cache inside index.sqlite (keyed by the file's SHA-256). Database photos are
not in that folder: the website sends small copies, the ML service embeds them and keeps the vector under the photo's
id (plant_images.imageId). A master file is written once and never changes, so an imageId always means the same pixels.

The cache is keyed by (imageId, embedder name). The name carries the model id and the model file's date, so a retrained
model, or a different embedder, simply has no vectors yet and the photos are embedded again. Old vectors are never
mixed with new ones.

Nothing here reads photo metadata, and nothing here knows about plants: it stores vectors by id.
"""
import json
import re
import sqlite3
import time
from pathlib import Path

import numpy as np

from .config import atomic_write
from .fingerprint import parse_kind

SAFE_KEY = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
SCHEMA = """
CREATE TABLE IF NOT EXISTS vectors (
    key TEXT NOT NULL, embedder TEXT NOT NULL, vec BLOB NOT NULL, added INTEGER NOT NULL,
    PRIMARY KEY (key, embedder)
);
"""
_SQL_VARS = 500          # SQLite allows at least 999 host parameters; stay well below


def valid_key(key) -> bool:
    return isinstance(key, str) and bool(SAFE_KEY.match(key))


class VectorCache:
    def __init__(self, index_dir):
        self.dir = Path(index_dir)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.dir / "photo_vectors.sqlite", timeout=30)
        self.db.executescript(SCHEMA)

    def close(self):
        self.db.commit()
        self.db.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def have(self, embedder, keys):
        """The subset of `keys` that already has a vector for this embedder."""
        keys = list(dict.fromkeys(keys))
        found = set()
        for i in range(0, len(keys), _SQL_VARS):
            chunk = keys[i:i + _SQL_VARS]
            marks = ",".join("?" * len(chunk))
            for (k,) in self.db.execute(f"SELECT key FROM vectors WHERE embedder = ? AND key IN ({marks})", [embedder, *chunk]):
                found.add(k)
        return found

    def get(self, embedder, keys):
        """{key: float32 vector} for the keys that have one."""
        keys = list(dict.fromkeys(keys))
        out = {}
        for i in range(0, len(keys), _SQL_VARS):
            chunk = keys[i:i + _SQL_VARS]
            marks = ",".join("?" * len(chunk))
            for k, blob in self.db.execute(f"SELECT key, vec FROM vectors WHERE embedder = ? AND key IN ({marks})", [embedder, *chunk]):
                out[k] = np.frombuffer(blob, dtype="float32")
        return out

    def put(self, embedder, vectors):
        now = int(time.time())
        self.db.executemany(
            "INSERT OR REPLACE INTO vectors (key, embedder, vec, added) VALUES (?,?,?,?)",
            [(k, embedder, np.asarray(v, dtype="float32").tobytes(), now) for k, v in vectors.items()])
        self.db.commit()

    def forget(self, keys):
        """Drops the vectors of photos that no longer exist (any embedder)."""
        keys = list(dict.fromkeys(keys))
        for i in range(0, len(keys), _SQL_VARS):
            chunk = keys[i:i + _SQL_VARS]
            self.db.execute(f"DELETE FROM vectors WHERE key IN ({','.join('?' * len(chunk))})", chunk)
        self.db.commit()

    def counts(self):
        return {name: n for name, n in self.db.execute("SELECT embedder, COUNT(*) FROM vectors GROUP BY embedder")}


# ---------------------------------------------------------------------------------------------- the admin's choice

def read_choice(index_dir, fallback="auto"):
    """The embedder the admin chose on the dataset page, else `fallback` (the DATASET_EMBEDDER environment value)."""
    path = Path(index_dir) / "embedder.json"
    try:
        kind = json.loads(path.read_text(encoding="utf-8")).get("kind")
        return parse_kind(kind)
    except Exception:           # no file, unreadable, or a kind that no longer exists: the fallback is always safe
        try:
            return parse_kind(fallback)
        except ValueError:
            return "auto"


def write_choice(index_dir, kind):
    kind = parse_kind(kind)
    atomic_write(Path(index_dir) / "embedder.json", json.dumps({"kind": kind, "setAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}))
    return kind
