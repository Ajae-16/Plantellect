const express = require('express');
const bcrypt = require('bcrypt');
const { mysqlPool } = require('../config/mysql.js');
const { getPermissionsVersion, loadAccountPermissions } = require('../config/mysql.js');
const { logAuthEvent } = require('../models/Authlog');
const settings = require('../config/settings');

const router = express.Router();

router.post('/register', async (req, res) => {
    const { email, username, password, firstName, lastName } = req.body;

    if (!email || !username || !password) {
        return res.status(400).json({ error: 'Email, username, and password are required' });
    }

    if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    try {
        const [existing] = await mysqlPool.query(
            'SELECT accountId FROM accounts WHERE email = ? OR username = ?',
            [email, username]
        );
        if (existing.length > 0) {
            return res.status(409).json({ error: 'Email or username already exists' });
        }

        const passwordHash = await bcrypt.hash(password, 10);

        const [userRows] = await mysqlPool.query('SELECT roleId FROM roles WHERE roleName = ?', ['user']);
        if (userRows.length === 0) {
            return res.status(500).json({ error: 'Default role not found' });
        }
        const userRoleId = userRows[0].roleId;

        const [result] = await mysqlPool.query(
            'INSERT INTO accounts (email, username, password_hash, roleId) VALUES (?, ?, ?, ?)',
            [email, username, passwordHash, userRoleId]
        );

        const accountId = result.insertId;

        await mysqlPool.query(
            'INSERT INTO profiles (accountId, firstName, lastName) VALUES (?, ?, ?)',
            [accountId, firstName || null, lastName || null]
        );

        const perms = await loadAccountPermissions(accountId);
        const version = await getPermissionsVersion();

        req.session.accountId = accountId;
        req.session.roles = perms.roles;
        req.session.permissions = perms.permissions;
        req.session.permissionsVersion = version;

        await logAuthEvent({
            accountId,
            action: 'register',
            ip: req.ip,
            userAgent: req.get('User-Agent') || ''
        });

        res.json({
            accountId,
            email: perms.email || email,
            username,
            roles: perms.roles,
            permissions: perms.permissions
        });
    } catch (err) {
        console.error('Register error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

router.post('/login', async (req, res) => {
    const { email, username, password } = req.body;

    if (!password || (!email && !username)) {
        return res.status(400).json({ error: 'Username/email and password are required' });
    }

    try {
        let account;
        if (email) {
            const [rows] = await mysqlPool.query(
                'SELECT accountId, email, username, password_hash FROM accounts WHERE email = ?',
                [email]
            );
            account = rows[0];
        } else {
            const [rows] = await mysqlPool.query(
                'SELECT accountId, email, username, password_hash FROM accounts WHERE username = ?',
                [username]
            );
            account = rows[0];
        }

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

        const passwordMatch = await bcrypt.compare(password, account.password_hash);
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

        const perms = await loadAccountPermissions(account.accountId);
        const version = await getPermissionsVersion();

        req.session.accountId = account.accountId;
        req.session.roles = perms.roles;
        req.session.permissions = perms.permissions;
        req.session.permissionsVersion = version;

        const rememberMe = ['true', 'on', '1', true].includes(req.body.rememberMe);
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
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
