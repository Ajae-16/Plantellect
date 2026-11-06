"""One embedder in memory, shared by every route that needs one (look-alike hints, Other plant suggestions).

A saved model is a few hundred MB once loaded, so two routes must not each load their own copy. Asking for a different
kind replaces the loaded one. Loading happens on first use, so the service starts fast and a missing TensorFlow or a
missing model file only affects the routes that need it."""
import threading

from .fingerprint import make_embedder, parse_kind


class EmbedderHolder:
    def __init__(self, factory=make_embedder):
        self._factory = factory
        self._lock = threading.Lock()
        self._kind = None
        self._obj = None

    def get(self, kind):
        kind = parse_kind(kind)
        with self._lock:
            if self._obj is None or self._kind != kind:
                self._obj = None            # free the old one before the new one loads
                self._obj = self._factory(kind)
                self._kind = kind
            return self._obj

    def loaded(self):
        """(kind, embedder name) of what is in memory, or (None, None)."""
        with self._lock:
            return (self._kind, getattr(self._obj, "name", None)) if self._obj is not None else (None, None)


holder = EmbedderHolder()
