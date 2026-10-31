const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

/**
 * Builds a multer instance from a settings block (certificates or plantImages).
 *
 * The on-disk filename is always a fresh UUID plus the validated extension, so a
 * client-supplied name never reaches the filesystem. originalFilename is kept
 * only for display.
 */
function createUploader(config) {
    const storage = multer.diskStorage({
        destination(req, file, cb) {
            cb(null, config.storageDir);
        },
        filename(req, file, cb) {
            const ext = path.extname(file.originalname).toLowerCase();
            cb(null, `${crypto.randomUUID()}${ext}`);
        }
    });

    return multer({
        storage,
        limits: {
            fileSize: config.maxSizeBytes,
            files: config.maxFilesPerRequest || 1
        },
        fileFilter(req, file, cb) {
            const ext = path.extname(file.originalname).toLowerCase();
            // Browsers on Windows often send no type (or application/octet-stream) for
            // a .heic file. For the extensions listed in genericMimeExtensions only, that
            // generic type passes this first gate; the real type is checked from the
            // bytes by config/image-ingest.js.
            const generic = (config.genericMimeExtensions || []).includes(ext)
                && (file.mimetype === '' || file.mimetype === 'application/octet-stream');
            if ((config.allowedMimeTypes.includes(file.mimetype) || generic) && config.allowedExtensions.includes(ext)) {
                return cb(null, true);
            }
            // Marked so handleUploadError can answer 400 with this message
            // instead of letting it fall through to the generic 500 handler.
            const err = new Error(
                `Invalid file type "${file.mimetype}" (${ext || 'no extension'}). ` +
                `Allowed: ${config.allowedMimeTypes.join(', ')}`
            );
            err.isUploadRejection = true;
            return cb(err);
        }
    });
}

const settings = require('./settings');

const uploadCertificate = createUploader(settings.certificates);
const uploadPlantImages = createUploader(settings.plantImages);

/**
 * The discovery-report uploader.
 *
 * Same fileFilter and same maxSizeBytes as a plant image — a report cannot
 * become a way to upload something the library would reject — but its own file
 * count, because settings.plantImages.maxFilesPerRequest (20) is a botanist's
 * submission allowance and ten open reports at 20 photos each is not a
 * per-account disk bound anyone intended.
 *
 * diskStorage, not memoryStorage: these files must survive the request. The
 * storedPath is recorded relative to the DISCOVERY root, so the same uuid
 * filename in two different roots is never confused.
 */
const discoveryUploadConfig = {
    // The temp landing zone. Files are COPIED (verified) into
    // <discoverySubdir>/pending/<requestId>/ once the request
    // row exists, and discovery_images.storedPath is relative to that folder.
    storageDir: settings.plantImages.storageDir,
    maxSizeBytes: settings.plantImages.maxSizeBytes,
    maxFilesPerRequest: settings.plantImages.maxDiscoveryFiles,
    allowedMimeTypes: settings.plantImages.allowedMimeTypes,
    allowedExtensions: settings.plantImages.allowedExtensions,
    genericMimeExtensions: settings.plantImages.genericMimeExtensions
};
const uploadDiscoveryImages = createUploader(discoveryUploadConfig);

/**
 * Plant-photo upload middleware whose file-count ceiling is read per request.
 *
 * multer fixes `limits.files` when the instance is built, so a module-level
 * uploadPlantImages can never follow an admin edit. This builds the instance
 * after the live limit is known (cheap: it is only an object), records the limit
 * on req so handleUploadError words its message with the SAME number, and passes
 * non-multipart requests straight through — which is what lets one route accept
 * both a JSON body and a multipart one.
 *
 * `getLimits` is injected rather than required here so this file keeps no
 * dependency on the database layer.
 */
function plantImageUpload(getLimits) {
    return async function (req, res, next) {
        let limits;
        try {
            limits = await getLimits();
        } catch (err) {
            return next(err);
        }
        req.uploadMaxFiles = limits.maxFilesPerRequest;
        createUploader({ ...settings.plantImages, maxFilesPerRequest: limits.maxFilesPerRequest })
            .array('images', limits.maxFilesPerRequest)(req, res, next);
    };
}

/**
 * Maps a multer rejection to a 400 carrying the message the fileFilter already
 * builds. Without this, index.js's error handler turned every rejected upload
 * into a flat "Something went wrong!" and threw away the reason.
 *
 * Anything that is not a MulterError is passed on untouched.
 */
function handleUploadError(config) {
    const maxSizeMb = Math.round(config.maxSizeBytes / (1024 * 1024));

    // eslint-disable-next-line no-unused-vars
    return function (err, req, res, next) {
        // The live admin limit when plantImageUpload set one, else the static one.
        const maxFiles = (req && req.uploadMaxFiles) || config.maxFilesPerRequest || 1;
        // The fileFilter's own rejection, already worded for the user.
        if (err && err.isUploadRejection) return res.status(400).json({ error: err.message });
        if (!(err instanceof multer.MulterError)) return next(err);

        let message;
        if (err.code === 'LIMIT_FILE_SIZE') {
            message = `File is too large. Maximum size is ${maxSizeMb} MB.`;
        } else if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
            message = `Too many files. Maximum is ${maxFiles} file(s) per request.`;
        } else {
            message = err.message;
        }

        // Multer may have already written a partial file to disk.
        if (err.file && err.file.path) {
            try {
                if (fs.existsSync(err.file.path)) fs.unlinkSync(err.file.path);
            } catch (cleanupErr) {
                console.error('Could not remove rejected upload:', cleanupErr.message);
            }
        }

        res.status(400).json({ error: message });
    };
}

module.exports = {
    createUploader,
    uploadCertificate,
    uploadPlantImages,
    uploadDiscoveryImages,
    plantImageUpload,
    discoveryUploadConfig,
    handleUploadError
};
