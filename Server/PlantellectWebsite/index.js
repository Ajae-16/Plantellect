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

// Public photo copies. Mounted BEFORE the general static handler and it
// answers everything under its prefix, so nothing else in that folder (a temporary
// file, a stray upload) can ever be served by the generic handler below. Only the
// exact path of a generated WebP is served; see config/public-images.js.
app.use(settings.plantImages.publicUrlBase, publicImages.publicImageHandler());

// The website is for administrators, everyone else is sent to the app download page.
// Pages only (the root and *.html): /api, /admin and the css / js / resource files are
// not touched. Mounted BEFORE express.static and the '/' route so those never serve a
// page to a visitor first. See middleware/site-gate.js.
app.use(require('./middleware/site-gate').siteGate());

// The profile page was renamed when the botanist role was retired. Old links and
// bookmarks land on the new page with their query string intact.
app.get('/botanist-profile.html', (req, res) => {
    const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    res.redirect(301, '/contributor-profile.html' + query);
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'home.html'));
});

app.use('/api/auth', require('./routes/auth'));
// The signed-in user's own bio, password and profile photo (mobile app).
app.use('/api/profile', require('./routes/profile'));
// plant-changes first: /:plantId/editable and /:plantId/changes each have two
// segments, so they cannot shadow /mine, /lookup, /limits or /types.
app.use('/api/plants', require('./routes/plant-changes'));
// Thumbs up / down on a plant's descriptions. Two-segment paths again, so no clash with /mine etc.
app.use('/api/plants', require('./routes/description-votes'));
app.use('/api/plants', require('./routes/plants'));
// A separate router from routes/plants.js on purpose: these are a distinct
// feature with a distinct permission model, and keeping them apart means the
// two image-route rule sets (owner-only for a reporter's own photo, record_plant
// for the contributor view) can never be confused. A claim in routes/plants.js
// would also put /count and /images/:imageId behind /:plantId.
app.use('/api/discoveries', require('./routes/discoveries'));
const contributorsRouter = require('./routes/contributors');
app.use('/api/contributors', contributorsRouter);
// The old path, kept so a client built before the rename (the mobile app, a saved
// link) keeps working. Same router, same rules. Remove once nothing calls it.
app.use('/api/botanists', contributorsRouter);
app.use('/api/ml', require('./routes/ml'));
app.use('/admin/api/ml/usage', require('./routes/ml-usage'));
app.use('/admin', require('./routes/admin'));
app.use('/admin', require('./routes/admin-dataset'));
app.use('/admin', require('./routes/admin-description-feedback'));

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
    

    for (const dir of [settings.plantImages.storageDir]) {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }
    // plants/ and discoveries/, each with pending, approved and denied.
    require('./config/image-files').ensureImageTree();
    // administration/inventory/user-images (profile photos) and its temporary landing folder.
    require('./config/profile-mysql').ensureUserImageTree();
    // public/resource/plant-images/{thumbnail,display}, then reconcile it with the
    // database: delete files with no visible record, regenerate missing
    // copies and copies whose hash no longer matches. It never throws: a failure is
    // logged and the photo is retried at the next run. The same job, followed by the
    // denied-photo retention job, then runs every night.
    publicImages.ensurePublicTree();
    await maintenance.runReconcile();
    maintenance.scheduleNightly();
    // Dataset page, several admins at once: sweeps lapsed "working on this" markers and prunes the old change log.
    require('./config/dataset-sync').startHousekeeping();

    const PORT = settings.server.port;
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Server running on port ${PORT}`);
    });
}

startServer().catch((err) => {
    console.error('Startup failed:', err.message);
    process.exit(1);
});
