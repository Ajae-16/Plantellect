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
const publicImages = require('./config/public-images');
const maintenance = require('./config/maintenance');

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

// Public photo copies (stage 6). Mounted BEFORE the general static handler and it
// answers everything under its prefix, so nothing else in that folder (a temporary
// file, a stray upload) can ever be served by the generic handler below. Only the
// exact path of a generated WebP is served; see config/public-images.js.
app.use(settings.plantImages.publicUrlBase, publicImages.publicImageHandler());

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'home.html'));
});

app.use('/api/auth', require('./routes/auth'));
// plant-changes first: /:plantId/editable and /:plantId/changes each have two
// segments, so they cannot shadow /mine, /lookup, /limits or /types.
app.use('/api/plants', require('./routes/plant-changes'));
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
app.use('/admin', require('./routes/admin-dataset'));
app.use('/admin', require('./routes/role-requests'));

app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    console.error(err.stack || err.message);
    res.status(500).json({ error: 'Something went wrong!' });
});

async function startServer() {
    await connectMongoDB();
    await runSeed();
    

    for (const dir of [settings.certificates.storageDir, settings.plantImages.storageDir]) {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }
    // plants/ and discoveries/, each with pending, approved and denied.
    require('./config/image-files').ensureImageTree();
    // public/resource/plant-images/{thumbnail,display}, then reconcile it with the
    // database (stage 7b): delete files with no visible record, regenerate missing
    // copies and copies whose hash no longer matches. It never throws: a failure is
    // logged and the photo is retried at the next run. The same job, followed by the
    // denied-photo retention job, then runs every night.
    publicImages.ensurePublicTree();
    await maintenance.runReconcile();
    maintenance.scheduleNightly();

    const PORT = settings.server.port;
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Server running on port ${PORT}`);
    });
}

startServer().catch((err) => {
    console.error('Startup failed:', err.message);
    process.exit(1);
});
