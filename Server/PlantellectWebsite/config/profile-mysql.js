// The signed-in user's own profile, for the mobile app: read it, change the bio, change the
// password, and keep one profile photo.
//
// Photo layout (same idea as the plant photos, which are plants/masters/<plantId>/<imageId>.webp):
//
//   administration/inventory/user-images/<accountId>.webp        e.g. acc_000007.webp
//
// The file is named after the account, so a photo is found from the user id alone. profiles.imagePath
// holds the file name ('acc_000007.webp'); NULL = no photo. The file is the metadata-free master produced by
// config/image-ingest.js, never the raw upload. These files are private: routes/profile.js streams them.
//
// Replacing a photo reuses the same name, so the new file is built beside it (<accountId>.new.webp, verified)
// and only then renamed over the old one: a failed copy can never destroy the photo that is already there.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const bcrypt = require('bcrypt');
const { mysqlPool } = require('./pool-mysql');
const settings = require('./settings');
const { copyVerified } = require('./image-files');
const { normalizeBio, passwordChangeProblem } = require('./profile-rules');

const imageRoot = () => path.resolve(settings.userImages.storageDir);
const incomingDir = () => path.join(imageRoot(), settings.userImages.incomingSubdir);

/** Creates user-images/ and its temporary landing folder. Called at startup and before each upload. */
function ensureUserImageTree() {
    fs.mkdirSync(incomingDir(), { recursive: true });
}

/**
 * The absolute path of a stored photo, or null when the stored value would point outside
 * user-images (a damaged row must never turn into a file read elsewhere on the disk).
 */
function resolveStoredPath(relative) {
    if (!relative || typeof relative !== 'string') return null;
    const resolved = path.resolve(imageRoot(), relative);
    return resolved.startsWith(imageRoot() + path.sep) ? resolved : null;
}

/**
 * '?v=<time>' is the profile's last-update time. The file name never changes (it is the account id),
 * so this is what tells the app that the picture is new and its cached copy is stale.
 */
function photoUrl(imagePath, updatedAt) {
    if (!imagePath) return null;
    const stamp = updatedAt ? new Date(updatedAt).getTime() : 0;
    return `/api/profile/photo?v=${Number.isFinite(stamp) ? stamp : 0}`;
}

/**
 * The address of ANOTHER person's profile photo, as shown beside their name on a plant page.
 * Same file and same '?v=<time>' cache-buster as photoUrl() above, but served by
 * GET /api/contributors/:accountId/photo, which applies the public profile's visibility rule
 * (so an administrator's photo is only served to administrators).
 */
function contributorPhotoUrl(accountId, imagePath, updatedAt) {
    if (!accountId || !imagePath) return null;
    const stamp = updatedAt ? new Date(updatedAt).getTime() : 0;
    return `/api/contributors/${encodeURIComponent(accountId)}/photo?v=${Number.isFinite(stamp) ? stamp : 0}`;
}

function shapeProfile(row) {
    return {
        accountId: row.accountId,
        username: row.username,
        email: row.email,
        firstName: row.firstName || null,
        lastName: row.lastName || null,
        bio: row.bio || null,
        photoUrl: photoUrl(row.imagePath, row.updatedAt)
    };
}

/** The signed-in user's profile. null when the account no longer exists. */
async function getOwnProfile(accountId, executor = mysqlPool) {
    const [rows] = await executor.query(
        `SELECT a.accountId, a.username, a.email, pr.firstName, pr.lastName, pr.bio, pr.imagePath, pr.updatedAt
         FROM accounts a
         LEFT JOIN profiles pr ON pr.accountId = a.accountId
         WHERE a.accountId = ?`,
        [accountId]
    );
    return rows.length === 0 ? null : shapeProfile(rows[0]);
}

async function getPhotoPath(accountId) {
    const [rows] = await mysqlPool.query('SELECT imagePath FROM profiles WHERE accountId = ?', [accountId]);
    return rows.length === 0 ? null : rows[0].imagePath || null;
}

/** Sets or clears the bio. Returns { bio } or { error, code }. */
async function updateBio(accountId, input) {
    const cleaned = normalizeBio(input);
    if (cleaned.error) return { error: cleaned.error, code: 400 };

    // Accounts older than the profiles table may have no row yet.
    await mysqlPool.query('INSERT IGNORE INTO profiles (accountId) VALUES (?)', [accountId]);
    await mysqlPool.query('UPDATE profiles SET bio = ? WHERE accountId = ?', [cleaned.value, accountId]);
    return { bio: cleaned.value };
}

/**
 * Changes the password after checking the current one. The new hash is made the same way as at
 * registration (bcrypt, cost 10).
 * Returns { ok: true } or { error, code, reason } where reason 'wrong_password' is the one the
 * route counts towards its attempt limit.
 */
async function changePassword(accountId, currentPassword, newPassword) {
    const problem = passwordChangeProblem(currentPassword, newPassword);
    if (problem) return { error: problem, code: 400, reason: 'invalid' };

    const [rows] = await mysqlPool.query('SELECT passwordHash FROM accounts WHERE accountId = ?', [accountId]);
    if (rows.length === 0) return { error: 'Account not found', code: 404, reason: 'missing' };

    const matches = await bcrypt.compare(currentPassword, rows[0].passwordHash);
    if (!matches) return { error: 'Current password is incorrect', code: 403, reason: 'wrong_password' };

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await mysqlPool.query('UPDATE accounts SET passwordHash = ? WHERE accountId = ?', [passwordHash, accountId]);
    return { ok: true };
}

/** Deletes one stored photo. Never throws: a leftover file is harmless. */
async function removeStoredFile(relative) {
    const file = resolveStoredPath(relative);
    if (!file) return;
    try {
        await fsp.unlink(file);
    } catch (err) {
        if (err.code !== 'ENOENT') console.error('Could not delete a profile photo:', err.message);
    }
}

/**
 * Stores an ALREADY INGESTED upload (file.path is the master WebP, see ingestUploads) as the
 * account's profile photo, <accountId>.webp, and returns { photoUrl }. The caller deletes file.path afterwards.
 */
async function setPhoto(accountId, file) {
    const fileName = `${accountId}.webp`;
    const finalPath = path.join(imageRoot(), fileName);
    const staging = path.join(imageRoot(), `${accountId}.new.webp`);

    const conn = await mysqlPool.getConnection();
    try {
        await conn.beginTransaction();
        await conn.query('INSERT IGNORE INTO profiles (accountId) VALUES (?)', [accountId]);
        // Row lock: two uploads from the same account take turns instead of racing on one file name.
        await conn.query('SELECT imagePath FROM profiles WHERE accountId = ? FOR UPDATE', [accountId]);

        const copy = await copyVerified(file.path, staging, { mimeType: 'image/webp' });
        if (!copy.ok) throw new Error(`could not store the photo: ${copy.error}`);
        await fsp.rename(staging, finalPath);

        // updatedAt is set by hand: re-sending the same file name would not otherwise change the row,
        // and the app tells a new picture from its cached one by that time.
        await conn.query('UPDATE profiles SET imagePath = ?, updatedAt = NOW() WHERE accountId = ?', [fileName, accountId]);
        await conn.commit();
    } catch (err) {
        await conn.rollback().catch(() => {});
        await fsp.unlink(staging).catch(() => {});
        throw err;
    } finally {
        conn.release();
    }

    const [rows] = await mysqlPool.query('SELECT updatedAt FROM profiles WHERE accountId = ?', [accountId]);
    return { photoUrl: photoUrl(fileName, rows[0] && rows[0].updatedAt) };
}

/** Removes the profile photo (row first, then the file). Returns true when there was one. */
async function removePhoto(accountId) {
    const [rows] = await mysqlPool.query('SELECT imagePath FROM profiles WHERE accountId = ?', [accountId]);
    const previous = rows.length > 0 ? rows[0].imagePath : null;
    if (!previous) return false;
    await mysqlPool.query('UPDATE profiles SET imagePath = NULL, updatedAt = NOW() WHERE accountId = ?', [accountId]);
    await removeStoredFile(previous);
    return true;
}

module.exports = {
    ensureUserImageTree,
    incomingDir,
    imageRoot,
    resolveStoredPath,
    photoUrl,
    contributorPhotoUrl,
    getOwnProfile,
    getPhotoPath,
    updateBio,
    changePassword,
    setPhoto,
    removePhoto
};
