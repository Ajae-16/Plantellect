/**
 * Cross-page photo handoff for the capture -> record flow.
 *
 * The flow is now a real page navigation (capture-plant.html -> record.html), and
 * neither a File handle nor an object URL survives one. IndexedDB is the only
 * thing that carries the photo across, and this module is the entire reason the
 * two-step "photos after approval" flow does not end in a dead end: without it a
 * contributor holds the photo, cannot attach it, and can only upload it days later.
 *
 * Rules:
 *   - browser-local only; nothing is uploaded until the contributor explicitly
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

    // Starting values only. The real ones come from GET /api/plants/limits and
    // are handed in with setLimits() by the page that fetched them (record-script
    // does, after the contributor gate). The browser cannot read settings.js and the
    // file-count cap is an admin setting, so nothing here may be treated as the
    // limit: a stale value is only a worse error message, because the server still
    // enforces the real one. maxFilesPerRequest has no default on purpose — null
    // means "not known yet", which is different from "20".
    var maxBytes = 10 * 1024 * 1024;
    var maxFilesPerRequest = null;

    function setLimits(limits) {
        if (!limits) return;
        var bytes = Number(limits.maxSizeBytes);
        if (isFinite(bytes) && bytes > 0) maxBytes = bytes;
        var files = Number(limits.maxFilesPerRequest);
        if (isFinite(files) && files >= 1) maxFilesPerRequest = Math.floor(files);
    }

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
        if (file.size > maxBytes) {
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

    // ---- the scanned photo the "Not identified?" report re-uses --------------------------
    // One slot, under a name no species can have, in the same store and with the same expiry as
    // the record-page handoff. It lets the report form use the photo that was just scanned
    // (even after a reload) instead of asking for another one. Dropped once the report is sent.
    var REPORT_SLOT = '__discovery_report__';

    function saveReportPhoto(file) {
        return saveScanPhoto(file, { scientificName: REPORT_SLOT });
    }

    /** The cached scan photo as a File, or null (none, expired, or no IndexedDB). */
    async function takeReportPhoto() {
        var record = await takeScanPhoto(REPORT_SLOT);
        if (!record || !record.blob) return null;
        try {
            return new File([record.blob], record.filename || 'scan-photo.jpg', { type: record.mimeType || 'image/jpeg' });
        } catch (err) {
            return null;
        }
    }

    function dropReportPhoto() {
        return dropScanPhoto(REPORT_SLOT);
    }

    // Both forms: the namespaced object for clarity, and the bare globals the
    // project's other shared scripts publish (window.checkAuth, window.escapeHtml).
    window.PhotoCache = {
        saveScanPhoto: saveScanPhoto,
        takeScanPhoto: takeScanPhoto,
        dropScanPhoto: dropScanPhoto,
        saveReportPhoto: saveReportPhoto,
        takeReportPhoto: takeReportPhoto,
        dropReportPhoto: dropReportPhoto,
        setLimits: setLimits,
        expiryDays: EXPIRY_DAYS
    };
    // Getters, so a value set by setLimits() is what a later reader sees.
    Object.defineProperty(window.PhotoCache, 'maxBytes', { enumerable: true, get: function () { return maxBytes; } });
    Object.defineProperty(window.PhotoCache, 'maxFilesPerRequest', { enumerable: true, get: function () { return maxFilesPerRequest; } });
    window.saveScanPhoto = saveScanPhoto;
    window.takeScanPhoto = takeScanPhoto;
    window.dropScanPhoto = dropScanPhoto;
})();