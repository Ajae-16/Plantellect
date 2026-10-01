require('dotenv').config(); // Load the root .env file once
const path = require('path');

// configurable settings
// sessionTimeout = MongoDB TTL duration (session cleanup after inactivity)
const sessionTimeout = 24 // hours
// rememberTimeout = persistent cookie duration when "remember me" is checked
const rememberTimeout = 720 // hours

const timezone = process.env.TZ || '+08:00'; // timezone (Asia/Manila)
// File directory for storing botanist certificates.
const certificateDir = path.join(__dirname, '..', 'administration', 'botanist', 'certificates'); 
// File size to accept for thr certificares.
const maxCertificatesSize = 20 // start with MB
// File directory for community-uploaded plant photos. These are NOT served
// statically; routes/plants.js streams approved ones on request.
const plantImageDir = path.join(__dirname, '..', 'administration', 'botanist', 'plant-images');
const maxPlantImageSize = 10 // MB

module.exports = {
    server: {
        port: parseInt(process.env.PORT, 10) || 3000,
        env: process.env.NODE_ENV || 'development'
    },
    database: {
        mongoUri: process.env.MONGO_URI,
        mysqlHost: process.env.DB_HOST
    },
    session: {
        secret: process.env.SESSION_SECRET,
        cookieTimeout: sessionTimeout * 60 * 60 * 1000, // session timeout in milliseconds (used for MongoDB TTL)
        rememberMeTimeout: rememberTimeout * 60 * 60 * 1000, // remember me persistent cookie duration in milliseconds
        cookieSecure: process.env.SESSION_COOKIE_SECURE === 'true'
    },
    system: {
        // Exposing this in config lets you easily check the active timezone across entire project
        timezone: timezone
    },
    certificates: {
        storageDir: certificateDir,
        maxSizeBytes: maxCertificatesSize * 1024 * 1024, // KB, B
        allowedMimeTypes: ['application/pdf', 'image/jpeg', 'image/png'],
        allowedExtensions: ['.pdf', '.jpg', '.jpeg', '.png'],
        maxFilenameLength: 255,
        filenameStrategy: 'uuid'
    },
    plantImages: {
        storageDir: plantImageDir,
        maxSizeBytes: maxPlantImageSize * 1024 * 1024, // per file
        maxFilesPerRequest: 20,
        allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
        allowedExtensions: ['.jpg', '.jpeg', '.png', '.webp'],
        filenameStrategy: 'uuid'
    },
    pagination: {
        // Every list route clamps to these instead of hardcoding a page size.
        defaultPageSize: 10,
        maxPageSize: 50,
        allowClientOverride: true
    },
    terms: {
        // Bump when the terms text in auth.html changes so stored consents
        // become visibly stale and can be re-collected.
        version: '1.0'
    },
    ml: {
        serviceUrl: process.env.ML_SERVICE_URL || 'http://localhost:8001',
        timeoutMs: 30000
    }
};
