const express = require('express');
const bcrypt = require('bcrypt');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { mysqlPool } = require('../config/mysql.js');
const { getPermissionsVersion, loadAccountPermissions, insertCertificate, insertRoleRequest } = require('../config/mysql.js');
const { logAuthEvent } = require('../models/Authlog');
const settings = require('../config/settings');

const router = express.Router();

const certificateStorage = multer.diskStorage({
    destination: function (req, file, cb) {
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

router.post('/register', uploadCertificate.single('certificate'), async (req, res) => {
    const { email, username, password, firstName, lastName, role } = req.body;
    const certFile = req.file;

    if (!email || !username || !password) {
        if (certFile && fs.existsSync(certFile.path)) fs.unlinkSync(certFile.path);
        return res.status(400).json({ error: 'Email, username, and password are required' });
    }

    if (password.length < 6) {
        if (certFile && fs.existsSync(certFile.path)) fs.unlinkSync(certFile.path);
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    let selectedRole = 'user';
    if (role && ['user', 'botanist'].includes(role)) {
        selectedRole = role;
    }

    if (selectedRole === 'botanist' && !certFile) {
        return res.status(400).json({ error: 'Certificate is required for Botanist registration' });
    }

    try {
        const [existing] = await mysqlPool.query(
            'SELECT accountId FROM accounts WHERE email = ? OR username = ?',
            [email, username]
        );
        if (existing.length > 0) {
            if (certFile && fs.existsSync(certFile.path)) fs.unlinkSync(certFile.path);
            return res.status(409).json({ error: 'Email or username already exists' });
        }

        const passwordHash = await bcrypt.hash(password, 10);

        const [userRows] = await mysqlPool.query('SELECT roleId FROM roles WHERE roleName = ?', ['user']);
        if (userRows.length === 0) {
            if (certFile && fs.existsSync(certFile.path)) fs.unlinkSync(certFile.path);
            return res.status(500).json({ error: 'Default role not found' });
        }
        const userRoleId = userRows[0].roleId;

        let isPending = false;
        let accountRoleId = userRoleId;

        if (selectedRole === 'botanist') {
            const [botanistRows] = await mysqlPool.query('SELECT roleId FROM roles WHERE roleName = ?', ['botanist']);
            if (botanistRows.length === 0) {
                if (certFile && fs.existsSync(certFile.path)) fs.unlinkSync(certFile.path);
                return res.status(500).json({ error: 'Botanist role not found' });
            }
            accountRoleId = userRoleId;
            isPending = true;
        }

        const [result] = await mysqlPool.query(
            'INSERT INTO accounts (email, username, password_hash, roleId) VALUES (?, ?, ?, ?)',
            [email, username, passwordHash, accountRoleId]
        );

        const accountId = result.insertId;

        await mysqlPool.query(
            'INSERT INTO profiles (accountId, firstName, lastName) VALUES (?, ?, ?)',
            [accountId, firstName || null, lastName || null]
        );

        if (isPending) {
            await insertRoleRequest(mysqlPool, accountId, 'botanist');
            
            if (certFile) {
                const accountDir = path.join(settings.certificates.storageDir, String(accountId));
                if (!fs.existsSync(accountDir)) {
                    fs.mkdirSync(accountDir, { recursive: true });
                }
                const ext = path.extname(certFile.originalname).toLowerCase();
                const uniqueName = `${crypto.randomUUID()}${ext}`;
                const relativePath = path.join(String(accountId), uniqueName);
                const fullPath = path.join(settings.certificates.storageDir, relativePath);
                
                fs.renameSync(certFile.path, fullPath);
                
                await mysqlPool.query(
                    `INSERT INTO certificates (accountId, original_filename, stored_filename, stored_path, mime_type, size)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    [accountId, certFile.originalname, uniqueName, relativePath, certFile.mimetype, certFile.size]
                );
            }
        } else if (certFile && fs.existsSync(certFile.path)) {
            fs.unlinkSync(certFile.path);
        }

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
            permissions: perms.permissions,
            pending: isPending
        });
    } catch (err) {
        if (certFile && fs.existsSync(certFile.path)) fs.unlinkSync(certFile.path);
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
