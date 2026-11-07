// /api/profile: the signed-in user's own profile, for the mobile app.
//
//   GET    /api/profile            name, email, bio, photoUrl
//   PUT    /api/profile/bio        { bio }                          (null or "" clears it)
//   POST   /api/profile/password   { currentPassword, newPassword }
//   POST   /api/profile/email      { currentPassword, newEmail }
//   GET    /api/profile/photo      the caller's own photo (image/webp)
//   POST   /api/profile/photo      multipart/form-data, field "image", at most 10 MB
//   DELETE /api/profile/photo
//   GET    /api/profile/approvals              { awaitingMe, mine, badge }   (Pending approval tab)
//   GET    /api/profile/approvals/count        { count }                     (the number next to Profile)
//   POST   /api/profile/approvals/seen         the requester looked at their requests
//   POST   /api/profile/approvals/:id/approve  { note? }  the author approves a change to their description
//   POST   /api/profile/approvals/:id/deny     { note? }  the author declines it (the request ends)
//
// Everything here needs a signed-in session (the same connect.sid cookie as the rest of the API)
// and only ever touches the caller's own account: there is no accountId in any path or body.

const express = require('express');
const fs = require('fs');
const { requireAuth } = require('../middleware/authMiddleware');
const settings = require('../config/settings');
const { createUploader, handleUploadError } = require('../config/upload');
const { ingestUploads } = require('../config/image-ingest');
const { logAuthEvent } = require('../mongoose-schemas/Authlog');
const profile = require('../config/profile-mysql');
const approvals = require('../config/owner-approval-mysql');

const router = express.Router();
router.use(requireAuth);

const photoField = () => settings.userImages.fieldName;

function audit(req, action, metadata) {
    return logAuthEvent({
        accountId: req.session.accountId,
        action,
        ip: req.ip,
        userAgent: req.get('User-Agent') || '',
        metadata
    });
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

router.get('/', async (req, res) => {
    try {
        const own = await profile.getOwnProfile(req.session.accountId);
        if (!own) return res.status(404).json({ error: 'Account not found' });
        res.setHeader('Cache-Control', 'private, no-store');
        res.json(own);
    } catch (err) {
        console.error('Get profile error:', err.message);
        res.status(500).json({ error: 'Failed to load profile' });
    }
});

// ---------------------------------------------------------------------------
// Bio
// ---------------------------------------------------------------------------

async function saveBio(req, res) {
    try {
        const result = await profile.updateBio(req.session.accountId, (req.body || {}).bio);
        if (result.error) return res.status(result.code).json({ error: result.error });
        await audit(req, 'profile_updated', { field: 'bio', cleared: result.bio === null });
        res.json({ bio: result.bio, message: 'Bio updated' });
    } catch (err) {
        console.error('Update bio error:', err.message);
        res.status(500).json({ error: 'Failed to update bio' });
    }
}
router.put('/bio', saveBio);
router.patch('/bio', saveBio);

// ---------------------------------------------------------------------------
// Password
// ---------------------------------------------------------------------------

// A stolen session must not be able to guess the current password at full speed. Counted per
// account, in memory (one server process): 5 wrong guesses lock the endpoint for 15 minutes.
// A restart clears it, which is acceptable for a brake whose job is to slow guessing, not to be a ledger.
const MAX_WRONG_PASSWORDS = 5;
const LOCK_MS = 15 * 60 * 1000;
const wrongGuesses = new Map(); // accountId -> { count, firstAt }

function lockedFor(accountId, now = Date.now()) {
    const entry = wrongGuesses.get(accountId);
    if (!entry) return 0;
    if (now - entry.firstAt >= LOCK_MS) { wrongGuesses.delete(accountId); return 0; }
    return entry.count >= MAX_WRONG_PASSWORDS ? LOCK_MS - (now - entry.firstAt) : 0;
}

function countWrongGuess(accountId, now = Date.now()) {
    const entry = wrongGuesses.get(accountId);
    if (!entry || now - entry.firstAt >= LOCK_MS) wrongGuesses.set(accountId, { count: 1, firstAt: now });
    else entry.count += 1;
}

router.post('/password', async (req, res) => {
    const accountId = req.session.accountId;
    const { currentPassword, newPassword } = req.body || {};

    try {
        const wait = lockedFor(accountId);
        if (wait > 0) {
            res.setHeader('Retry-After', String(Math.ceil(wait / 1000)));
            return res.status(429).json({ error: 'Too many wrong passwords. Try again later.' });
        }

        const result = await profile.changePassword(accountId, currentPassword, newPassword);
        if (result.error) {
            if (result.reason === 'wrong_password') {
                countWrongGuess(accountId);
                await audit(req, 'password_change_failed', { reason: 'wrong_password' });
            }
            return res.status(result.code).json({ error: result.error });
        }

        wrongGuesses.delete(accountId);
        await audit(req, 'password_changed', {});
        res.json({ message: 'Password changed' });
    } catch (err) {
        console.error('Change password error:', err.message);
        res.status(500).json({ error: 'Failed to change password' });
    }
});

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

// Asking for the current password makes this a password guess too, so it shares the password brake.
router.post('/email', async (req, res) => {
    const accountId = req.session.accountId;
    const { currentPassword, newEmail } = req.body || {};

    try {
        const wait = lockedFor(accountId);
        if (wait > 0) {
            res.setHeader('Retry-After', String(Math.ceil(wait / 1000)));
            return res.status(429).json({ error: 'Too many wrong passwords. Try again later.' });
        }

        const result = await profile.changeEmail(accountId, currentPassword, newEmail);
        if (result.error) {
            if (result.reason === 'wrong_password') {
                countWrongGuess(accountId);
                await Promise.resolve(audit(req, 'email_change_failed', { reason: 'wrong_password' })).catch(() => {});
            }
            return res.status(result.code).json({ error: result.error });
        }

        wrongGuesses.delete(accountId);
        await Promise.resolve(audit(req, 'email_changed', {})).catch(() => {});
        res.json({ email: result.email, message: 'Email changed' });
    } catch (err) {
        console.error('Change email error:', err.message);
        res.status(500).json({ error: 'Failed to change email' });
    }
});

// ---------------------------------------------------------------------------
// Photo
// ---------------------------------------------------------------------------

/**
 * Serves the caller's own photo. The URL carries ?v=<time> (see photoUrl), which changes with every new
 * photo, and the answer is revalidated with its ETag each time, so a replaced photo never shows stale.
 * 404 with no photo set. The stored path is checked to stay inside user-images before anything is read.
 */
router.get('/photo', async (req, res) => {
    try {
        const stored = await profile.getPhotoPath(req.session.accountId);
        const file = profile.resolveStoredPath(stored);
        if (!file || !fs.existsSync(file)) return res.status(404).json({ error: 'No profile photo' });
        res.setHeader('Content-Type', 'image/webp');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'private, no-cache');
        res.sendFile(file);
    } catch (err) {
        console.error('Serve profile photo error:', err.message);
        res.status(500).json({ error: 'Failed to load photo' });
    }
});

/** multer is built per request: the landing folder is created first and settings can be pointed elsewhere in tests. */
function receivePhoto(req, res, next) {
    try {
        profile.ensureUserImageTree();
    } catch (err) {
        return next(err);
    }
    const config = {
        ...settings.userImages,
        storageDir: profile.incomingDir()
    };
    return createUploader(config).single(photoField())(req, res, next);
}

router.post(
    '/photo',
    receivePhoto,
    // Real type check, HEIC conversion, upright metadata-free WebP. No duplicate check: a user may
    // put the same picture back. Nothing is written to the database before this has passed.
    ingestUploads({ options: { masterLongEdge: settings.userImages.masterLongEdge } }),
    async (req, res) => {
        const file = req.file;
        if (!file) {
            return res.status(400).json({
                error: `No photo was sent. Send it as multipart/form-data in the "${photoField()}" field.`
            });
        }
        try {
            const result = await profile.setPhoto(req.session.accountId, file);
            await audit(req, 'profile_updated', { field: 'photo', action: 'set' });
            res.status(201).json({ photoUrl: result.photoUrl, message: 'Photo updated' });
        } catch (err) {
            console.error('Save profile photo error:', err.message);
            res.status(500).json({ error: 'Failed to save the photo' });
        } finally {
            // The ingested temporary master; the stored copy is a separate file.
            await fs.promises.unlink(file.path).catch(() => {});
        }
    }
);

router.delete('/photo', async (req, res) => {
    try {
        const removed = await profile.removePhoto(req.session.accountId);
        if (!removed) return res.status(404).json({ error: 'No profile photo' });
        await audit(req, 'profile_updated', { field: 'photo', action: 'removed' });
        res.json({ photoUrl: null, message: 'Photo removed' });
    } catch (err) {
        console.error('Remove profile photo error:', err.message);
        res.status(500).json({ error: 'Failed to remove the photo' });
    }
});

// ---------------------------------------------------------------------------
// Pending approvals (changes to descriptions: the ones I asked for, and the ones waiting for me)
// ---------------------------------------------------------------------------

router.get('/approvals', async (req, res) => {
    try {
        const result = await approvals.getApprovals(req.session.accountId);
        res.setHeader('Cache-Control', 'private, no-store');
        res.json(result);
    } catch (err) {
        console.error('List approvals error:', err.message);
        res.status(500).json({ error: 'Failed to load your pending approvals' });
    }
});

router.get('/approvals/count', async (req, res) => {
    try {
        const count = await approvals.getBadgeCount(req.session.accountId);
        res.setHeader('Cache-Control', 'private, no-store');
        res.json({ count });
    } catch (err) {
        console.error('Approvals count error:', err.message);
        res.status(500).json({ error: 'Failed to load the count' });
    }
});

router.post('/approvals/seen', async (req, res) => {
    try {
        res.json(await approvals.markSeen(req.session.accountId));
    } catch (err) {
        console.error('Approvals seen error:', err.message);
        res.status(500).json({ error: 'Failed to update your notifications' });
    }
});

function decide(decision) {
    return async (req, res) => {
        try {
            const result = await approvals.decideAsOwner(
                req.session.accountId, req.params.requestId, decision, (req.body || {}).note
            );
            if (result.error) return res.status(result.code).json({ error: result.error });
            // The audit log is best effort here: its action list may not know this event yet.
            await Promise.resolve(audit(req, 'change_request_answered', { requestId: req.params.requestId, decision })).catch(() => {});
            res.json({
                ...result,
                message: decision === 'approve'
                    ? 'Approved. The change now waits for an admin.'
                    : 'Declined. The change was cancelled.'
            });
        } catch (err) {
            console.error('Answer approval error:', err.message);
            res.status(500).json({ error: 'Failed to save your answer' });
        }
    };
}
router.post('/approvals/:requestId/approve', decide('approve'));
router.post('/approvals/:requestId/deny', decide('deny'));

// A wrong field name is not "too many files": say what the app should send.
// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
    if (err && err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(400).json({ error: `Send exactly one photo, in the "${photoField()}" field.` });
    }
    return next(err);
});
// File too large (10 MB), wrong type, and the other upload refusals -> 400 with the real reason.
router.use(handleUploadError(settings.userImages));

module.exports = router;
module.exports.lockedFor = lockedFor;
module.exports.countWrongGuess = countWrongGuess;
