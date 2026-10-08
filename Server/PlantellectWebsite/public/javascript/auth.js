/**
 * auth.js — shared auth helpers.
 *
 * The ONE implementation of identity lives in sidebar.js, which every public
 * page loads in <head> before any page script. This file delegates to it and
 * keeps nothing of its own, deliberately:
 *
 *   - checkAuth used to fetch /api/auth/me and return the whole user, while
 *     sidebar.js's fetchAuth fetched the same endpoint and returned only
 *     { permissions, roles }. Both wrote the same three sessionStorage keys, so
 *     whichever resolved last won and a page reading the cache could see
 *     permissions but no username.
 *   - updateNavForAuthState used to be a PER-PAGE duty with no gate. A page that
 *     forgot the call got a permanently signed-out header and nothing failed.
 *     sidebar.js renders .auth-links on DOMContentLoaded, on every page.
 *
 * checkAuth is kept as a wrapper so no caller breaks. It DELEGATES whenever
 * sidebar.js is present, which is every page that renders the shared nav — so a
 * nav page never reaches the fetch below, and check-scripts.cjs asserts that
 * both halves of that ("delegates" and "every nav page loads sidebar.js").
 * Prefer window.plantAuth.ready directly in new code.
 */

function fetchUserForStandalonePage() {
    // Only reachable on a page with its own shell and no shared nav —
    // plant-profile.html is the one, and it asks for a single button's
    // visibility, not for a header. It has no .auth-links, so it cannot have the
    // stale-header symptom this whole change is about.
    return fetch('/api/auth/me', { credentials: 'include' })
        .then(function (response) { return response.ok ? response.json() : null; })
        .catch(function () { return null; });
}

function checkAuth() {
    if (window.plantAuth && window.plantAuth.ready) {
        return window.plantAuth.ready;
    }
    return fetchUserForStandalonePage();
}

function clearAuthState() {
    if (typeof window.clearSidebarCache === 'function') {
        window.clearSidebarCache();
        return;
    }
    try {
        sessionStorage.removeItem('username');
        sessionStorage.removeItem('roles');
        sessionStorage.removeItem('permissions');
    } catch (e) {}
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str == null ? '' : str);
    return div.innerHTML;
}

window.checkAuth = checkAuth;
window.clearAuthState = clearAuthState;
window.escapeHtml = escapeHtml;