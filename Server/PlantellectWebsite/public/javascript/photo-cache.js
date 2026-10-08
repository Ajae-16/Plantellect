/**
 * Cross-page photo handoff for the capture -> record flow.
 *
 * The flow is now a real page navigation (capture-plant.html -> record.html), and
 * neither a File handle nor an object URL survives one. IndexedDB is the only
 * thing that carries the photo across, and this module is the entire reason the
 * two-step "photos after approval" flow does not end in a dead end: without it a
 * botanist holds the photo, cannot attach it, and can only upload it days later.
 *
 * Rules:
 *   - browser-local only; nothing is uploaded until the botanist explicitly
 *     submits it;
 *   - files above the server's own plantImages.maxSizeBytes ceiling are skipped,
 *     because they could not be uploaded anyway;
 *   - entries expire after a few days on read;
 *   - the entry is dropped once the photo has actually been submitted.
 *
 * Every function degrades to a no-op when IndexedDB is unavailable (private
 * mode in some browsers, or storage pressure). The file picker is always the
 * fallback, so losing the cache costs a step, not the feature.
 */
(function () {
    'use strict';

    var DB_NAME = 'plantellect-photos';
    var STORE = 'scanPhotos';
    var DB_VERSION = 1;
    var EXPIRY_DAYS = 3;

    // Mirrors settings.plantImages.maxSizeBytes. The browser cannot read
    // settings.js, so a stale value here is only a worse error message — the
    // server still enforces the real limit.
    var MAX_BYTES = 10 * 1024 * 1024;

    var MAX_FILES_PER_REQUEST = 20;

    function available() {
        try {
            return typeof indexedDB !== 'undefined' && indexedDB !== null;
        } catch (err) {
            return false;
        }
    }

    function openDb() {
        return new Promise(function (resolve, reject) {
            if (!available()) return reject(new Error('IndexedDB unavailable'));
            var request;
            try {
                request = indexedDB.open(DB_NAME, DB_VERSION);
            } catch (err) {
                return reject(err);
            }
            request.onupgradeneeded = function () {
                var db = request.result;
                if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
            };
            request.onsuccess = function () { resolve(request.result); };
            request.onerror = function () { reject(request.error || new Error('IndexedDB open failed')); };
        });
    }

    function tx(db, mode) {
        return db.transaction(STORE, mode).objectStore(STORE);
    }

    function wrap(request) {
        return new Promise(function (resolve, reject) {
            request.onsuccess = function () { resolve(request.result); };
            request.onerror = function () { reject(request.error || new Error('IndexedDB request failed')); };
        });
    }

    function keyFor(scientificName) {
        return String(scientificName || '').trim().toLowerCase();
    }

    /**
     * Caches a scanned photo under its scientific name. Never throws: failing to
     * cache a photo must not break the scan that produced it.
     */
    async function saveScanPhoto(file, options) {
        if (!file || !file.size) return false;
        if (file.size > MAX_BYTES) {
            console.info('Scan photo is larger than the upload limit; not cached.');
            return false;
        }
        var key = keyFor(options && options.scientificName);
        if (!key) return false;

        try {
            var db = await openDb();
            var record = {
                key: key,
                scientificName: (options && options.scientificName) || '',
                blob: file,
                filename: file.name || 'scan-photo.jpg',
                mimeType: file.type || 'image/jpeg',
                size: file.size,
                savedAt: Date.now(),
                expiresAt: Date.now() + EXPIRY_DAYS * 24 * 60 * 60 * 1000
            };
            await wrap(tx(db, 'readwrite').put(record));
            db.close();
            return true;
        } catch (err) {
            console.info('Could not cache the scan photo:', err.message);
            return false;
        }
    }

    /**
     * Reads the cached photo for a scientific name, or null. Expired entries are
     * deleted on the way out rather than merely ignored, so the store does not
     * accumulate.
     */
    async function takeScanPhoto(scientificName) {
        var key = keyFor(scientificName);
        if (!key) return null;

        try {
            var db = await openDb();
            var store = tx(db, 'readwrite');
            var record = await wrap(store.get(key));
            db.close();
            if (!record || !record.blob) return null;

            if (record.expiresAt && Date.now() > record.expiresAt) {
                await dropScanPhoto(scientificName);
                return null;
            }
            return record;
        } catch (err) {
            console.info('Could not read the cached scan photo:', err.message);
            return null;
        }
    }

    /** Removes the entry. Called once the photo has actually been submitted. */
    async function dropScanPhoto(scientificName) {
        var key = keyFor(scientificName);
        if (!key) return false;
        try {
            var db = await openDb();
            await wrap(tx(db, 'readwrite').delete(key));
            db.close();
            return true;
        } catch (err) {
            console.info('Could not drop the cached scan photo:', err.message);
            return false;
        }
    }

    // Both forms: the namespaced object for clarity, and the bare globals the
    // project's other shared scripts publish (window.checkAuth, window.escapeHtml).
    window.PhotoCache = {
        saveScanPhoto: saveScanPhoto,
        takeScanPhoto: takeScanPhoto,
        dropScanPhoto: dropScanPhoto,
        maxBytes: MAX_BYTES,
        maxFilesPerRequest: MAX_FILES_PER_REQUEST,
        expiryDays: EXPIRY_DAYS
    };
    window.saveScanPhoto = saveScanPhoto;
    window.takeScanPhoto = takeScanPhoto;
    window.dropScanPhoto = dropScanPhoto;
})();