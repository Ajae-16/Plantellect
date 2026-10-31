"""The dataset index: one SQLite file with a row per photo (identity = SHA-256) and cached embeddings.

Nothing here stores capture time, GPS or any other photo metadata. A rescan is cheap: a photo whose
size and modified time did not change keeps its hashes and its embedding."""
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

from .fingerprint import dhash_hex, load_rgb, sha256_file

SCHEMA = """
CREATE TABLE IF NOT EXISTS photos (
    path TEXT PRIMARY KEY, root TEXT NOT NULL, rel TEXT NOT NULL,
    split TEXT, kind TEXT NOT NULL, label TEXT NOT NULL, folder_label TEXT, part TEXT, source TEXT,
    size INTEGER, mtime_ns INTEGER,
    sha256 TEXT, dhash TEXT, ok INTEGER DEFAULT 1, err TEXT, group_key TEXT
);
CREATE INDEX IF NOT EXISTS photos_sha ON photos (sha256);
CREATE TABLE IF NOT EXISTS embeddings (
    sha256 TEXT NOT NULL, embedder TEXT NOT NULL, vec BLOB NOT NULL, PRIMARY KEY (sha256, embedder)
);
"""
COLS = ["path", "root", "rel", "split", "kind", "label", "folder_label", "part", "source", "size", "mtime_ns",
        "sha256", "dhash", "ok", "err", "group_key"]


class Index:
    def __init__(self, index_dir):
        self.dir = Path(index_dir)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.dir / "index.sqlite", timeout=30)   # an audit may be writing
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)

    def close(self):
        self.db.commit()
        self.db.close()

    # ---------------------------------------------------------------- sync
    def sync(self, recs, roots):
        """Make the table match the scanned records for these roots. Returns counts."""
        roots = [str(Path(r).resolve()) for r in roots]
        have = {r["path"]: r for r in self.db.execute(
            f"SELECT * FROM photos WHERE root IN ({','.join('?' * len(roots))})", roots)}
        seen, new, changed = set(), 0, 0
        for rec in recs:
            seen.add(rec["path"])
            old = have.get(rec["path"])
            same = old is not None and old["size"] == rec["size"] and old["mtime_ns"] == rec["mtime_ns"]
            sha, dh, ok, err = (old["sha256"], old["dhash"], old["ok"], old["err"]) if same else (None, None, 1, None)
            if old is None:
                new += 1
            elif not same:
                changed += 1
            self.db.execute(
                "INSERT INTO photos (path, root, rel, split, kind, label, folder_label, part, source, size, mtime_ns,"
                " sha256, dhash, ok, err, group_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
                " ON CONFLICT(path) DO UPDATE SET root=excluded.root, rel=excluded.rel, split=excluded.split,"
                " kind=excluded.kind, label=excluded.label, folder_label=excluded.folder_label, part=excluded.part,"
                " source=excluded.source, size=excluded.size, mtime_ns=excluded.mtime_ns, sha256=excluded.sha256,"
                " dhash=excluded.dhash, ok=excluded.ok, err=excluded.err",
                (rec["path"], rec["root"], rec["rel"], rec["split"], rec["kind"], rec["label"], rec["folder_label"],
                 rec["part"], rec["source"], rec["size"], rec["mtime_ns"], sha, dh, ok, err,
                 old["group_key"] if same else None))
        gone = [p for p in have if p not in seen]
        for p in gone:
            self.db.execute("DELETE FROM photos WHERE path = ?", (p,))
        self.db.commit()
        return {"photos": len(recs), "new": new, "changed": changed, "removed": len(gone)}

    # ---------------------------------------------------------------- fingerprints
    def fingerprint_pending(self, workers=4, progress=None):
        todo = [r["path"] for r in self.db.execute("SELECT path FROM photos WHERE sha256 IS NULL")]

        def work(path):
            try:
                return path, sha256_file(path), dhash_hex(path), 1, None
            except Exception as e:  # unreadable or corrupt: keep going, list it
                return path, "bad:" + path, "0" * 16, 0, str(e)[:160]

        done = 0
        with ThreadPoolExecutor(max_workers=workers) as pool:
            for path, sha, dh, ok, err in pool.map(work, todo):
                self.db.execute("UPDATE photos SET sha256=?, dhash=?, ok=?, err=? WHERE path=?", (sha, dh, ok, err, path))
                done += 1
                if progress and done % 200 == 0:
                    progress(f"fingerprinted {done}/{len(todo)}")
        self.db.commit()
        return len(todo)

    def rows(self, roots=None, ok_only=True):
        q, args = "SELECT * FROM photos", []
        cond = []
        if roots:
            roots = [str(Path(r).resolve()) for r in roots]
            cond.append(f"root IN ({','.join('?' * len(roots))})")
            args += roots
        if ok_only:
            cond.append("ok = 1")
        if cond:
            q += " WHERE " + " AND ".join(cond)
        return [dict(r) for r in self.db.execute(q + " ORDER BY path", args)]

    def set_groups(self, mapping):
        self.db.executemany("UPDATE photos SET group_key=? WHERE path=?", [(g, p) for p, g in mapping.items()])
        self.db.commit()

    # ---------------------------------------------------------------- embeddings
    def vectors(self, embedder_name, shas=None):
        out = {}
        for r in self.db.execute("SELECT sha256, vec FROM embeddings WHERE embedder = ?", (embedder_name,)):
            if shas is None or r["sha256"] in shas:
                out[r["sha256"]] = np.frombuffer(r["vec"], dtype="float32")
        return out

    def embed_missing(self, embedder, rows, batch=32, progress=None):
        have = set(self.vectors(embedder.name))
        first_path = {}
        for r in rows:
            if r["sha256"] not in have and r["sha256"] not in first_path:
                first_path[r["sha256"]] = r["path"]
        shas = list(first_path)
        for i in range(0, len(shas), batch):
            chunk = shas[i:i + batch]
            arr = []
            for sha in chunk:
                try:
                    arr.append(np.asarray(load_rgb(first_path[sha], embedder.size), dtype=np.uint8))
                except Exception:
                    arr.append(np.zeros((*embedder.size, 3), dtype=np.uint8))
            vecs = embedder(np.stack(arr))
            self.db.executemany("INSERT OR REPLACE INTO embeddings (sha256, embedder, vec) VALUES (?,?,?)",
                                [(s, embedder.name, v.astype("float32").tobytes()) for s, v in zip(chunk, vecs)])
            self.db.commit()
            if progress:
                progress(f"embedded {min(i + batch, len(shas))}/{len(shas)}")
        return len(shas)
