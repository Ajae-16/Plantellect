require('dotenv').config(); // Load the root .env file once
const path = require('path');

// configurable settings
// sessionTimeout = MongoDB TTL duration (session cleanup after inactivity)
const sessionTimeout = 24 // hours
// rememberTimeout = persistent cookie duration when "remember me" is checked
const rememberTimeout = 720 // hours

const timezone = 'Asia/Manila' // timezone
// File directory for storing botanist certificates.
const certificateDir = path.join(__dirname, '..', 'administration', 'botanist', 'certificates' ); 
// File size to accept for thr certificares.
const maxCertificatesSize = 20 // start with MB

module.exports = {
    server: {
        port: parseInt(process.env.PORT, 10) || 3000,
        env: process.env.NODE_ENV || 'development'
    },
    database: {
        mongoUri: process.env.MONGO_URI || 'mongodb://superadmin:plantpassword@localhost:27017/plantellectmongodb?authSource=admin',
        mysqlHost: process.env.DB_HOST || 'localhost'
    },
    session: {
        secret: process.env.SESSION_SECRET,
        cookieTimeout: sessionTimeout * 60 * 60 * 1000, // session timeout in milliseconds (used for MongoDB TTL)
        rememberMeTimeout: rememberTimeout * 60 * 60 * 1000, // remember me persistent cookie duration in milliseconds
        cookieSecure: process.env.SESSION_COOKIE_SECURE === 'true'
    },
    system: {
        // Exposing this in config lets you easily check the active timezone across entire project
        timezone: timezone || env.TZ
    },
    certificates: {
        storageDir: certificateDir,
        maxSizeBytes: maxCertificatesSize * 1024 * 1024, // KB, B
        allowedMimeTypes: ['application/pdf', 'image/jpeg', 'image/png'],
        allowedExtensions: ['.pdf', '.jpg', '.jpeg', '.png'],
        maxFilenameLength: 255,
        filenameStrategy: 'uuid'
    }
};