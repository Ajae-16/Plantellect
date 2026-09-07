require('dotenv').config();

const express = require('express');
const path = require('path');
const session = require('express-session');
const MongoStore = require('connect-mongo');

const connectMongoDB = require('./config/mongo');
const { runSeed } = require('./config/seed.cjs');

const app = express();

const sessionTimeout = 24;

if (!process.env.SESSION_SECRET) {
    throw new Error('SESSION_SECRET missing from environment variables');
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
        mongoUrl: process.env.MONGO_URI || 'mongodb://superadmin:plantpassword@localhost:27017/plantellectmongodb?authSource=admin',
        ttl: sessionTimeout * 60 * 60,
        autoRemove: 'native',
    }),
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: false,
        maxAge: sessionTimeout * 60 * 60 * 1000
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
    await runSeed();

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Server running on port ${PORT}`);
    });
}

startServer();
