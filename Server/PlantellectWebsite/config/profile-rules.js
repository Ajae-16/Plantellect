// Pure validation for the mobile profile API (bio, password). No database, no Express, so
// tests/profile.test.js runs without either. The limits live in config/settings.js (userImages)
// and in the registration route (password length), and are repeated here only as defaults.

const settings = require('./settings');

// Same minimum as POST /api/auth/register, so a password that can be created can also be set.
const PASSWORD_MIN_LENGTH = 6;
// bcrypt only reads the first 72 BYTES of a password; anything after is silently ignored, which would
// let two different long passwords match each other. Refuse them instead of truncating.
const PASSWORD_MAX_BYTES = 72;

// Control characters other than tab and newline (those two are kept in a bio).
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * Cleans a bio.
 *   undefined          -> error (the field is required; send null or "" to clear it)
 *   null or blank text -> { value: null }, which clears the bio
 *   text               -> trimmed, line endings normalised to \n, control characters removed,
 *                         three or more line breaks in a row folded into one blank line
 * Length is counted in characters (code points), not UTF-16 units, so an emoji counts as one.
 * Returns { value } or { error }.
 */
function normalizeBio(input, maxLength = settings.userImages.bioMaxLength) {
    if (input === undefined) return { error: 'bio is required (send null or an empty string to clear it)' };
    if (input === null) return { value: null };
    if (typeof input !== 'string') return { error: 'bio must be text' };

    const cleaned = input
        .replace(/\r\n?/g, '\n')
        .replace(CONTROL_CHARS, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    if (cleaned === '') return { value: null };
    if (Array.from(cleaned).length > maxLength) {
        return { error: `bio is too long. The limit is ${maxLength} characters.` };
    }
    return { value: cleaned };
}

/**
 * Checks a password change request BEFORE the database is touched.
 * Returns an error string, or null when the shape is acceptable. Whether the current
 * password is actually right is decided by the route, with bcrypt.
 */
function passwordChangeProblem(currentPassword, newPassword) {
    if (typeof currentPassword !== 'string' || currentPassword === '') {
        return 'currentPassword is required';
    }
    if (typeof newPassword !== 'string' || newPassword === '') {
        return 'newPassword is required';
    }
    if (newPassword.length < PASSWORD_MIN_LENGTH) {
        return `New password must be at least ${PASSWORD_MIN_LENGTH} characters`;
    }
    if (Buffer.byteLength(newPassword, 'utf8') > PASSWORD_MAX_BYTES) {
        return `New password is too long (at most ${PASSWORD_MAX_BYTES} bytes)`;
    }
    if (newPassword === currentPassword) {
        return 'New password must be different from the current password';
    }
    return null;
}

module.exports = { PASSWORD_MIN_LENGTH, PASSWORD_MAX_BYTES, normalizeBio, passwordChangeProblem };
