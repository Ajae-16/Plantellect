require('dotenv').config();

const express = require('express');
const path = require('path');
const session = require('express-session');
const MongoStore = require('connect-mongo');

const connectMongoDB = require('./config/mongo');
const { runSeed } = require('./config/seed.cjs');
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

const authRoutes = require('./routes/auth');
app.use('/api/auth', authRoutes);

const adminRoutes = require('./routes/admin');
app.use('/admin', adminRoutes);

app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Something went wrong!' });
});

async function startServer() {
    await connectMongoDB();
    // await runSeed();

    const PORT = settings.server.port;
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Server running on port ${PORT}`);
    });
}

startServer();
