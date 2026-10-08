require('dotenv').config();

const express = require('express');
const path = require('path');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const fs = require('fs');

const connectMongoDB = require('./config/mongo');
const { runSeed } = require('./config/seed.cjs');
const { mysqlPool } = require('./config/mysql.js');
const settings = require('./config/settings');

const app = express();

if (!settings.session.secret) {
    throw new Error('SESSION_SECRET missing from environment variables');
}

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

app.use('/api/auth', require('./routes/auth'));
app.use('/api/plants', require('./routes/plants'));
// A separate router from routes/plants.js on purpose: these are a distinct
// feature with a distinct permission model, and keeping them apart means the
// two image-route rule sets (owner-only for a reporter's own photo, record_plant
// for the botanist view) can never be confused. A claim in routes/plants.js
// would also put /count and /images/:imageId behind /:plantId.
app.use('/api/discoveries', require('./routes/discoveries'));
app.use('/api/botanists', require('./routes/botanists'));
app.use('/api/ml', require('./routes/ml'));
app.use('/admin/api/ml/usage', require('./routes/ml-usage'));
app.use('/admin', require('./routes/admin'));
app.use('/admin', require('./routes/role-requests'));

app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    console.error(err.stack || err.message);
    res.status(500).json({ error: 'Something went wrong!' });
});

/**
 * Read-only schema preflight.
 *
 * `npm run db:migrate` is a MANUAL step, so a developer can otherwise start new
 * code against a stale schema and get a raw SQL error on a feature path rather
 * than a startup message. No DDL and no auto-repair here on purpose: this only
 * converts a confusing runtime failure into an actionable one. npm run
 * verify:db asserts the same state for anyone who wants the full report.
 *
 * This covers every column the discovery loop filters on, not just the two
 * document 1 originally checked. A missing column does not throw — it makes a
 * queue query return an empty list, which reads as "there is nothing to review"
 * rather than as a broken install.
 */
const PREFLIGHT_COLUMNS = [
    ['plant_description', 'partsId'],
    ['approval_requests', 'claimedBy'],
    ['approval_requests', 'claimedAt'],
    ['approval_requests', 'resolvedBy'],
    ['approval_requests', 'resolvedAt'],
    ['approval_requests', 'recordRequestId'],
    ['approval_requests', 'disqualifiedBy'],
    ['approval_requests', 'disqualifiedAt'],
    ['approval_requests', 'disqualifyReason'],
    ['approval_requests', 'claimSource']
];

const PREFLIGHT_TABLES = [
    'ml_scan_usage',
    'discovery_images',
    'discovery_votes'
];

// Exact value lists. An enum that still has the old three values passes any
// "does the column exist" check while the first report would 500 on insert.
const PREFLIGHT_ENUMS = [
    ['approval_requests', 'requestType', ['role_permission', 'plant_addition', 'plant_contribution', 'plant_discovery']],
    ['approval_requests', 'status', ['pending', 'approved', 'denied', 'cancelled', 'rejected']],
    // approvalMode is written on every approve and deny, so an
    // enum that does not yet carry 'auto' makes the automatic path write a value
    // the column rejects — inside a transaction, after the decision has already
    // been taken.
    ['approval_requests', 'approvalMode', ['manual', 'auto']]
];

async function preflightSchema() {
    const problems = [];

    const [tables] = await mysqlPool.query(
        `SELECT table_name AS name FROM information_schema.tables
         WHERE table_schema = DATABASE() AND table_name IN (${PREFLIGHT_TABLES.map(() => '?').join(',')})`,
        PREFLIGHT_TABLES
    );
    const present = new Set(tables.map((t) => t.name));
    for (const table of PREFLIGHT_TABLES) {
        if (!present.has(table)) problems.push(`${table} table is missing`);
    }

    const [cols] = await mysqlPool.query(
        `SELECT table_name AS tableName, column_name AS columnName, is_nullable AS isNullable,
                column_type AS columnType
         FROM information_schema.columns
         WHERE table_schema = DATABASE()
           AND (table_name, column_name) IN (${PREFLIGHT_COLUMNS.map(() => '(?, ?)').join(',')})`,
        PREFLIGHT_COLUMNS.flat()
    );
    const colMap = new Map(cols.map((c) => [`${c.tableName}.${c.columnName}`, c]));
    for (const [table, column] of PREFLIGHT_COLUMNS) {
        const found = colMap.get(`${table}.${column}`);
        if (!found) {
            problems.push(`${table}.${column} is missing`);
        } else if (table === 'plant_description' && column === 'partsId'
            && String(found.isNullable).toUpperCase() !== 'YES') {
            problems.push('plant_description.partsId is still NOT NULL');
        }
    }

    for (const [table, column, values] of PREFLIGHT_ENUMS) {
        const found = colMap.get(`${table}.${column}`);
        if (!found) continue;   // already reported as a missing column
        const wanted = `enum(${values.map((v) => `'${v}'`).join(',')})`;
        if (String(found.columnType).toLowerCase() !== wanted) {
            problems.push(`${table}.${column} must be ${wanted}, found ${found.columnType}`);
        }
    }

    if (problems.length > 0) {
        for (const problem of problems) console.error('  -', problem);
        throw new Error('Schema is out of date. Run: npm run db:migrate');
    }

    // The machine actor automatic approvals are recorded against, resolved HERE and
    // not only when auto mode first fires. Two reasons: the failure is silent
    // otherwise — switching a mode on appears to work and then every automatic
    // decision has nowhere to write its reviewer — and getSystemReviewerId caches
    // the resolved id, so doing it at boot means the AUTO/manual classification
    // never has to compare against an unresolved default. The permission matrix is
    // still NOT checked here, deliberately; it is much bigger and does not fail
    // loudly, which is what verify-db is for.
    await require('./config/approval-mode.js').getSystemReviewerId(mysqlPool);
    console.log('Schema preflight OK.');
}

async function startServer() {
    await connectMongoDB();
    await runSeed();
    await preflightSchema();

    for (const dir of [settings.certificates.storageDir, settings.plantImages.storageDir]) {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    const PORT = settings.server.port;
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Server running on port ${PORT}`);
    });
}

startServer().catch((err) => {
    console.error('Startup failed:', err.message);
    process.exit(1);
});
