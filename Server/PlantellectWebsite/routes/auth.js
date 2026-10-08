const express = require('express');
const bcrypt = require('bcrypt');
const fs = require('fs');
const { mysqlPool } = require('../config/mysql.js');
const {
    getPermissionsVersion,
    loadAccountPermissions,
    insertCertificate,
    insertRoleRequest,
    recordConsent,
    processNewRequest
} = require('../config/mysql.js');
const { logAuthEvent } = require('../mongoose-schemas/Authlog');
const settings = require('../config/settings');
const { uploadCertificate } = require('../config/upload');

const router = express.Router();

const CONSENT_TYPES = ['terms', 'info_usage'];

function discardUploadedFile(file) {
    if (file && file.path && fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
    }
}

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

router.post('/register', uploadCertificate.single('certificate'), async (req, res) => {
    const { email, username, password, firstName, lastName, role } = req.body;
    const certFile = req.file;

    if (!email || !username || !password) {
        discardUploadedFile(certFile);
        return res.status(400).json({ error: 'Email, username, and password are required' });
    }
    if (password.length < 6) {
        discardUploadedFile(certFile);
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    if (username.length < 6) {
        discardUploadedFile(certFile);
        return res.status(400).json({ error: 'Username must be at least 6 characters' });
    }

    // Consent is required from the server's point of view, not just the browser's.
    const acceptedTerms = ['true', 'on', '1'].includes(String(req.body.agreeTerms).toLowerCase());
    const acceptedInfo = ['true', 'on', '1'].includes(String(req.body.agreeInfo).toLowerCase());
    if (!acceptedTerms || !acceptedInfo) {
        discardUploadedFile(certFile);
        return res.status(400).json({ error: 'You must agree to the terms and to the use of your information' });
    }

    let selectedRole = 'user';
    if (role && ['user', 'botanist'].includes(role)) {
        selectedRole = role;
    }
    if (selectedRole === 'botanist' && !certFile) {
        return res.status(400).json({ error: 'Certificate is required for Botanist registration' });
    }

    const conn = await mysqlPool.getConnection();
    let roleRequestId = null;
    let autoDecision = null;
    try {
        const [existing] = await conn.query(
            'SELECT accountId FROM accounts WHERE email = ? OR username = ?',
            [email, username]
        );
        if (existing.length > 0) {
            await conn.rollback();
            discardUploadedFile(certFile);
            return res.status(409).json({ error: 'Email or username already exists' });
        }

        const [userRows] = await conn.query('SELECT roleId FROM roles WHERE roleName = ?', ['user']);
        if (userRows.length === 0) {
            await conn.rollback();
            discardUploadedFile(certFile);
            return res.status(500).json({ error: 'Default role not found' });
        }

        // A pending botanist gets a usable 'user' account straight away; the
        // botanist permissions arrive only when an admin approves.
        const isPending = selectedRole === 'botanist';
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

        if (isPending) {
            roleRequestId = await insertRoleRequest(conn, accountId, 'botanist');
            if (certFile) {
                await insertCertificate(conn, accountId, certFile);
            }
        } else {
            discardUploadedFile(certFile);
        }

        await conn.commit();

        // The automatic pass, AFTER the commit and AFTER the session is established.
        //
        // In that order deliberately: the session is created first so that if the
        // role really was granted automatically, this response already reports the
        // new permission set rather than a set that is one refresh out of date. And
        // because the account row is committed, a failure here cannot un-register
        // anybody — the registration stands as "pending review" with a reason.
        if (roleRequestId) {
            try {
                autoDecision = await processNewRequest(roleRequestId, { triggeredBy: 'registration' });
            } catch (err) {
                console.error('Automatic role approval error:', err.message);
                autoDecision = { autoDecided: false, reason: `Automatic approval could not run: ${err.message}` };
            }
        }

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
            permissions: perms.permissions,
            pending: isPending && perms.roles.length === 1,
            // When the role really was granted by the rule set, say so rather than
            // letting the client render "awaiting review" over a live permission.
            autoApproved: autoDecision && autoDecision.autoDecided === true,
            autoSkipReason: autoDecision && !autoDecision.autoDecided ? (autoDecision.reason || null) : null
        });
    } catch (err) {
        await conn.rollback();
        discardUploadedFile(certFile);
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

        const [accountRows] = await mysqlPool.query(
            'SELECT email, username FROM accounts WHERE accountId = ?',
            [req.session.accountId]
        );
        const account = accountRows[0];

        res.json({
            accountId: req.session.accountId,
            email: account ? account.email : '',
            username: account ? account.username : '',
            roles: req.session.roles,
            permissions: req.session.permissions
        });
    } catch (err) {
        console.error('Me error:', err.message);
        res.status(500).json({ error: 'Failed to load session' });
    }
});

module.exports = router;
