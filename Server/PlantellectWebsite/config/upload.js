const multer = require('multer');
const path = require('path');
const crypto = require('crypto');

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
            if (config.allowedMimeTypes.includes(file.mimetype) && config.allowedExtensions.includes(ext)) {
                return cb(null, true);
            }
            return cb(new Error(
                `Invalid file type "${file.mimetype}" (${ext || 'no extension'}). ` +
                `Allowed: ${config.allowedMimeTypes.join(', ')}`
            ));
        }
    });
}

const uploadCertificate = createUploader(require('./settings').certificates);
const uploadPlantImages = createUploader(require('./settings').plantImages);

module.exports = { createUploader, uploadCertificate, uploadPlantImages };
