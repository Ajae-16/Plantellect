const express = require('express');
const bcrypt = require('bcrypt');
const { mysqlPool } = require('../config/mysql.js');
const {
    getPermissionsVersion,
    loadAccountPermissions,
    recordConsent
} = require('../config/mysql.js');
const { logAuthEvent } = require('../mongoose-schemas/Authlog');
const settings = require('../config/settings');
const { photoUrl } = require('../config/profile-mysql');

const router = express.Router();

const CONSENT_TYPES = ['terms', 'info_usage'];

/**
 * Replaces the session id before storing the authenticated session, so an id
 * planted before sign-in is not still valid afterwards. Fails the request rather
 * than falling back to the old id.
 */
function regenerateThenSet(req, sessionData) {
    return new Promise((resolve, reject) => {
        req.session.regenerate((err) => {
            if (err) return reject(err);
            Object.assign(req.session, sessionData);
            req.session.save((saveErr) => (saveErr ? reject(saveErr) : resolve()));
        });
    });
}

router.post('/register', async (req, res) => {
    const { email, username, password, firstName, lastName } = req.body;

    if (!email || !username || !password) {
        return res.status(400).json({ error: 'Email, username, and password are required' });
    }
    if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    if (username.length < 6) {
        return res.status(400).json({ error: 'Username must be at least 6 characters' });
    }

    // Consent is required from the server's point of view, not just the browser's.
    const acceptedTerms = ['true', 'on', '1'].includes(String(req.body.agreeTerms).toLowerCase());
    const acceptedInfo = ['true', 'on', '1'].includes(String(req.body.agreeInfo).toLowerCase());
    if (!acceptedTerms || !acceptedInfo) {
        return res.status(400).json({ error: 'You must agree to the terms and to the use of your information' });
    }

    // Every sign-up is a plain 'user'. The botanist role is retired: users hold
    // the contribution permissions themselves (community build), so there is no
    // role to request, no certificate to upload and nothing to wait on.
    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();

        const [existing] = await conn.query(
            'SELECT accountId FROM accounts WHERE email = ? OR username = ?',
            [email, username]
        );
        if (existing.length > 0) {
            await conn.rollback();
            return res.status(409).json({ error: 'Email or username already exists' });
        }

        const [userRows] = await conn.query('SELECT roleId FROM roles WHERE roleName = ?', ['user']);
        if (userRows.length === 0) {
            await conn.rollback();
            return res.status(500).json({ error: 'Default role not found' });
        }

        const passwordHash = await bcrypt.hash(password, 10);
        const accountId = await require('../config/ids.js').insertRow(
            conn,
            'accounts',
            ['email', 'username', 'passwordHash', 'roleId', 'status'],
            [email, username, passwordHash, userRows[0].roleId, 'active']
        );

        await conn.query(
            'INSERT INTO profiles (accountId, firstName, lastName) VALUES (?, ?, ?)',
            [accountId, firstName || null, lastName || null]
        );
        await recordConsent(conn, accountId, CONSENT_TYPES, settings.terms.version);

        await conn.commit();

        const perms = await loadAccountPermissions(accountId);
        const version = await getPermissionsVersion();
        await regenerateThenSet(req, {
            accountId,
            roles: perms.roles,
            permissions: perms.permissions,
            permissionsVersion: version
        });

        await logAuthEvent({
            accountId,
            action: 'register',
            ip: req.ip,
            userAgent: req.get('User-Agent') || ''
        });

        res.status(201).json({
            accountId,
            email: perms.email || email,
            username,
            roles: perms.roles,
            permissions: perms.permissions
        });
    } catch (err) {
        await conn.rollback();
        console.error('Register error:', err.message);
        res.status(500).json({ error: 'Registration failed' });
    } finally {
        conn.release();
    }
});

router.post('/login', async (req, res) => {
    const { email, username, password } = req.body;

    if (!password || (!email && !username)) {
        return res.status(400).json({ error: 'Username/email and password are required' });
    }

    try {
        const field = email ? 'email' : 'username';
        const [rows] = await mysqlPool.query(
            `SELECT accountId, email, username, passwordHash, status FROM accounts WHERE ${field} = ?`,
            [email || username]
        );
        const account = rows[0];

        if (!account) {
            await logAuthEvent({
                accountId: 0,
                action: 'failed_login',
                ip: req.ip,
                userAgent: req.get('User-Agent') || '',
                metadata: { username: username || email }
            });
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const passwordMatch = await bcrypt.compare(password, account.passwordHash);
        if (!passwordMatch) {
            await logAuthEvent({
                accountId: 0,
                action: 'failed_login',
                ip: req.ip,
                userAgent: req.get('User-Agent') || '',
                metadata: { username: email || username }
            });
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        if (account.status !== 'active') {
            return res.status(403).json({
                error: 'This account has been suspended. Contact an administrator.'
            });
        }

        await mysqlPool.query('UPDATE accounts SET lastLoginAt = NOW() WHERE accountId = ?', [account.accountId]);

        const perms = await loadAccountPermissions(account.accountId);
        const version = await getPermissionsVersion();
        const rememberMe = ['true', 'on', '1', true].includes(req.body.rememberMe);

        await regenerateThenSet(req, {
            accountId: account.accountId,
            roles: perms.roles,
            permissions: perms.permissions,
            permissionsVersion: version
        });
        req.session.cookie.maxAge = rememberMe ? settings.session.rememberMeTimeout : undefined;

        await logAuthEvent({
            accountId: account.accountId,
            action: 'login',
            ip: req.ip,
            userAgent: req.get('User-Agent') || ''
        });

        res.json({
            accountId: account.accountId,
            email: account.email,
            username: account.username,
            roles: perms.roles,
            permissions: perms.permissions
        });
    } catch (err) {
        console.error('Login error:', err.message);
        res.status(500).json({ error: 'Login failed' });
    }
});

router.post('/logout', async (req, res) => {
    try {
        if (req.session && req.session.accountId) {
            await logAuthEvent({
                accountId: req.session.accountId,
                action: 'logout',
                ip: req.ip,
                userAgent: req.get('User-Agent') || ''
            });
        }
        req.session.destroy((err) => {
            if (err) {
                console.error('Session destroy error:', err.message);
                return res.status(500).json({ error: 'Logout failed' });
            }
            res.clearCookie('connect.sid');
            res.json({ message: 'Logged out successfully' });
        });
    } catch (err) {
        console.error('Logout error:', err.message);
        res.status(500).json({ error: 'Logout failed' });
    }
});

router.get('/me', async (req, res) => {
    if (!req.session || !req.session.accountId) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    try {
        const currentVersion = await getPermissionsVersion();
        if (req.session.permissionsVersion !== currentVersion) {
            const perms = await loadAccountPermissions(req.session.accountId);
            req.session.roles = perms.roles;
            req.session.permissions = perms.permissions;
            req.session.permissionsVersion = currentVersion;
        }

        // bio, name and photoUrl are for the mobile profile screen. Additive: the website's
        // sidebar.js only reads the fields it already knew.
        const [accountRows] = await mysqlPool.query(
            `SELECT a.email, a.username, pr.firstName, pr.lastName, pr.bio, pr.imagePath, pr.updatedAt
             FROM accounts a
             LEFT JOIN profiles pr ON pr.accountId = a.accountId
             WHERE a.accountId = ?`,
            [req.session.accountId]
        );
        const account = accountRows[0];

        res.json({
            accountId: req.session.accountId,
            email: account ? account.email : '',
            username: account ? account.username : '',
            firstName: account ? account.firstName || null : null,
            lastName: account ? account.lastName || null : null,
            bio: account ? account.bio || null : null,
            photoUrl: account ? photoUrl(account.imagePath, account.updatedAt) : null,
            roles: req.session.roles,
            permissions: req.session.permissions
        });
    } catch (err) {
        console.error('Me error:', err.message);
        res.status(500).json({ error: 'Failed to load session' });
    }
});

module.exports = router;
