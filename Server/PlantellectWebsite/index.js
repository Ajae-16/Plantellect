require('dotenv').config();

const express = require('express');
const path = require('path');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const multer = require('multer');
const fs = require('fs');
const crypto = require('crypto');

const connectMongoDB = require('./config/mongo');
const { runSeed } = require('./config/seed.cjs');
const settings = require('./config/settings');
const { mysqlPool } = require('./config/mysql.js');
const { insertCertificate, insertRoleRequest } = require('./config/mysql.js');

const app = express();

if (!settings.session.secret) {
    throw new Error('SESSION_SECRET missing from environment variables');
}

// Multer disk storage for certificate uploads
const certificateStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        // Destination will be set per-request based on accountId in the register route
        cb(null, settings.certificates.storageDir);
    },
    filename: function (req, file, cb) {
        const ext = path.extname(file.originalname).toLowerCase();
        const uniqueName = `${crypto.randomUUID()}${ext}`;
        cb(null, uniqueName);
    }
});

const uploadCertificate = multer({
    storage: certificateStorage,
    limits: {
        fileSize: settings.certificates.maxSizeBytes
    },
    fileFilter: function (req, file, cb) {
        const allowedMimeTypes = settings.certificates.allowedMimeTypes;
        const allowedExtensions = settings.certificates.allowedExtensions;
        const ext = path.extname(file.originalname).toLowerCase();
        
        if (allowedMimeTypes.includes(file.mimetype) && allowedExtensions.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only PDF, JPG, JPEG, PNG allowed.'), false);
        }
    }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
    secret: settings.session.secret,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
        mongoUrl: settings.database.mongoUri,
        ttl: settings.session.cookieTimeout / 1000,
        autoRemove: 'native',
    }),
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: settings.session.cookieSecure
    }
}));

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'home.html'));
});

const authRoutes = require('./routes/auth');
app.use('/api/auth', authRoutes);

const adminRoutes = require('./routes/admin');
app.use('/admin', adminRoutes);

const roleRequestRoutes = require('./routes/role-requests');
app.use('/admin', roleRequestRoutes);

app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Something went wrong!' });
});

async function ensureTablesExist() {
    const conn = await mysqlPool.getConnection();
    try {
        await conn.query(`
            CREATE TABLE IF NOT EXISTS certificates (
                certificateId INT AUTO_INCREMENT PRIMARY KEY,
                accountId INT NOT NULL,
                original_filename VARCHAR(255) NOT NULL,
                stored_filename VARCHAR(255) NOT NULL,
                stored_path VARCHAR(500) NOT NULL,
                mime_type VARCHAR(100) NOT NULL,
                size BIGINT NOT NULL,
                uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (accountId) REFERENCES accounts(accountId) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        await conn.query(`
            CREATE TABLE IF NOT EXISTS role_requests (
                requestId INT AUTO_INCREMENT PRIMARY KEY,
                accountId INT NOT NULL,
                requested_role VARCHAR(50) NOT NULL,
                status ENUM('pending', 'approved', 'denied') NOT NULL DEFAULT 'pending',
                reviewed_by INT DEFAULT NULL,
                reviewed_at TIMESTAMP NULL DEFAULT NULL,
                note TEXT DEFAULT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (accountId) REFERENCES accounts(accountId) ON DELETE CASCADE,
                FOREIGN KEY (reviewed_by) REFERENCES accounts(accountId) ON DELETE SET NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        // Ensure botanist has view_plants + record_plant permissions
        const [botanistRole] = await conn.query('SELECT roleId FROM roles WHERE roleName = ?', ['botanist']);
        if (botanistRole.length > 0) {
            const botanistRoleId = botanistRole[0].roleId;
            const [viewPlantsPerm] = await conn.query('SELECT permissionId FROM permissions WHERE permissionName = ?', ['view_plants']);
            const [recordPlantPerm] = await conn.query('SELECT permissionId FROM permissions WHERE permissionName = ?', ['record_plant']);
            if (viewPlantsPerm.length > 0) {
                await conn.query('INSERT IGNORE INTO role_permissions (roleId, permissionId) VALUES (?, ?)', [botanistRoleId, viewPlantsPerm[0].permissionId]);
            }
            if (recordPlantPerm.length > 0) {
                await conn.query('INSERT IGNORE INTO role_permissions (roleId, permissionId) VALUES (?, ?)', [botanistRoleId, recordPlantPerm[0].permissionId]);
            }
        }
        // Ensure certificates storage directory exists
        if (!fs.existsSync(settings.certificates.storageDir)) {
            fs.mkdirSync(settings.certificates.storageDir, { recursive: true });
        }
        console.log('Database tables verified/created successfully.');
    } catch (err) {
        console.error('Failed to ensure tables exist:', err.message);
        throw err;
    } finally {
        conn.release();
    }
}

async function startServer() {
    await connectMongoDB();
    await runSeed();
    await ensureTablesExist();

    const PORT = settings.server.port;
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Server running on port ${PORT}`);
    });
}

startServer();
