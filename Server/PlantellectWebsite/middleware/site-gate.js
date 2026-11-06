const { refreshSession } = require('./authMiddleware');

/**
 * The website is for people with public_access (the admin roles); everyone else uses the
 * mobile app.
 *
 * Every request for a PAGE (the site root or any .html file) is answered like this:
 *  1. an account holding public_access is let through to the page it asked for, so an admin
 *     can use the public site normally. The one exception is the admin sign-in page: an
 *     admin who is already signed in is sent to the dashboard instead of seeing it;
 *  2. everyone else is sent to the download page, except that the download page and the
 *     admin sign-in page are served as they are.
 *
 * Deliberately NOT a lockdown. Only pages are redirected. /api/* (the mobile app),
 * /admin/* (guarded by requirePermission), and the css, javascript and resource files are
 * untouched, so the mobile app and the download page itself keep working. Anyone who types
 * the exact URL of a script or image can still fetch it, as before.
 *
 * Redirects are 302 + no-store, so a browser never remembers one after this is changed.
 */

const DOWNLOAD_PAGE = '/download-app.html';
const ADMIN_HOME = '/admin/dashboard';

// Pages a visitor who is not an administrator may still see.
const ADMIN_SIGN_IN_PAGE = '/admin-auth.html';
const OPEN_PAGES = new Set(['/download-app.html', ADMIN_SIGN_IN_PAGE]);

/** The request path as the static handler would see it: decoded, lower-cased. null if undecodable. */
function normalisedPath(req) {
    try {
        return decodeURIComponent(req.path).toLowerCase();
    } catch (err) {
        return null;
    }
}

function isPage(path) {
    return path === '/' || path.endsWith('.html');
}

/** The permissions of a live session, or [] for no session, a dead one, or a failed check. */
async function sessionPermissions(req) {
    if (!req.session || !req.session.accountId) return []; // no cookie: skip the database
    try {
        if (!(await refreshSession(req))) return [];
    } catch (err) {
        console.error('site gate session check failed:', err.message);
        return [];
    }
    return req.session.permissions || [];
}

function siteGate() {
    return async function siteGateMiddleware(req, res, next) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();

        const path = normalisedPath(req);
        if (path === null || !isPage(path)) return next();

        res.setHeader('Cache-Control', 'no-store');

        const permissions = await sessionPermissions(req);
        if (permissions.includes('access_admin') && path === ADMIN_SIGN_IN_PAGE) {
            return res.redirect(302, ADMIN_HOME);
        }
        if (permissions.includes('public_access')) return next();
        if (OPEN_PAGES.has(path)) return next();
        return res.redirect(302, DOWNLOAD_PAGE);
    };
}

module.exports = { siteGate, DOWNLOAD_PAGE, ADMIN_HOME, OPEN_PAGES };
