/**
 * download-app.html
 *
 * Loaded in <head> WITHOUT defer: the first part applies the saved theme before the
 * page paints (so there is no light/dark flash). The rest waits for the DOM.
 *
 * The theme button switches light / dark like any other page. Five clicks in a row,
 * each within CLICK_GAP_MS of the one before, send the visitor to the admin sign-in.
 */
(function () {
    'use strict';

    var THEME_KEY = 'siteTheme';            // the same key sidebar.js uses
    var ADMIN_PAGE = 'admin-auth.html';
    var CLICKS_NEEDED = 5;
    var CLICK_GAP_MS = 1500;                // a pause longer than this starts the count again

    var root = document.documentElement;
    var darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

    function readStore(key) {
        try { return localStorage.getItem(key); } catch (e) { return null; }
    }
    function writeStore(key, value) {
        try { localStorage.setItem(key, value); } catch (e) { /* private mode: theme just is not remembered */ }
    }

    var saved = readStore(THEME_KEY);
    root.setAttribute('data-theme', (saved === 'dark' || saved === 'light') ? saved : (darkQuery.matches ? 'dark' : 'light'));

    function paintButton() {
        var dark = root.getAttribute('data-theme') === 'dark';
        var icon = document.getElementById('themeIcon');
        var button = document.getElementById('themeButton');
        if (icon) icon.textContent = dark ? 'light_mode' : 'dark_mode';
        if (button) button.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    }

    document.addEventListener('DOMContentLoaded', function () {
        var button = document.getElementById('themeButton');
        var qr = document.getElementById('qrImage');
        paintButton();

        // No QR file yet: hide the broken-image icon instead of showing it.
        if (qr) {
            qr.addEventListener('error', function () { qr.hidden = true; });
        }

        if (!button) return;

        var count = 0;
        var lastClick = 0;

        button.addEventListener('click', function () {
            var now = Date.now();
            count = (now - lastClick <= CLICK_GAP_MS) ? count + 1 : 1;
            lastClick = now;

            var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
            root.setAttribute('data-theme', next);
            writeStore(THEME_KEY, next);
            paintButton();

            if (count >= CLICKS_NEEDED) {
                count = 0;
                window.location.href = ADMIN_PAGE;
            }
        });
    });
})();
