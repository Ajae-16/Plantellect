/* =========================================================
   admin-sidebar.js
   Shared by the Dashboard, Users and Plants pages.

   Load it in <head> WITHOUT defer/async so the saved theme and
   collapsed state are applied before first paint (no flash).

   Handles:
     - Dark / light mode (a separate "Appearance" switch is added
       at the bottom of the sidebar, apart from the nav links)
     - Desktop collapsible icon rail (manual toggle only)
     - Desktop sidebar height (header edge to bottom of screen)
     - Mobile off-canvas drawer
     - Sidebar notification badges (window.loadNavBadges)
   ========================================================= */
(function () {
    'use strict';

    var root = document.documentElement;
    var COLLAPSE_KEY = 'adminSidebarCollapsed';
    var THEME_KEY = 'adminTheme';
    var desktop = window.matchMedia('(min-width: 768px)');
    var darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

    function read(key) {
        try { return localStorage.getItem(key); } catch (e) { return null; }
    }
    function write(key, value) {
        try { localStorage.setItem(key, value); } catch (e) {}
    }

    /* ---------------------------------------------------------
       1. Apply saved state immediately (runs while <head> parses)
       --------------------------------------------------------- */
    var savedTheme = read(THEME_KEY);
    root.setAttribute(
        'data-theme',
        (savedTheme === 'dark' || savedTheme === 'light')
            ? savedTheme
            : (darkQuery.matches ? 'dark' : 'light')
    );

    if (read(COLLAPSE_KEY) === '1') {
        root.classList.add('sidebar-collapsed');
    }

    /* ---------------------------------------------------------
       2. Theme
       --------------------------------------------------------- */
    function currentTheme() {
        return root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    }

    // Highlights the active option in the Appearance switch
    function updateThemeSwitch() {
        var box = document.getElementById('adminThemeSwitch');
        if (!box) return;
        var theme = currentTheme();
        box.querySelectorAll('[data-theme-option]').forEach(function (btn) {
            var isActive = btn.getAttribute('data-theme-option') === theme;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        });
    }

    function setTheme(theme, persist) {
        root.setAttribute('data-theme', theme);
        if (persist) write(THEME_KEY, theme);
        updateThemeSwitch();
    }

    // Follow the OS setting until the user picks a theme manually
    function onSystemThemeChange(e) {
        var saved = read(THEME_KEY);
        if (saved === 'dark' || saved === 'light') return;
        setTheme(e.matches ? 'dark' : 'light', false);
    }
    if (darkQuery.addEventListener) {
        darkQuery.addEventListener('change', onSystemThemeChange);
    } else if (darkQuery.addListener) {
        darkQuery.addListener(onSystemThemeChange);
    }

    /* ---------------------------------------------------------
       3. Desktop collapsible rail
       --------------------------------------------------------- */
    function setCollapsed(collapsed) {
        root.classList.toggle('sidebar-collapsed', collapsed);
        write(COLLAPSE_KEY, collapsed ? '1' : '0');
    }

    /* ---------------------------------------------------------
       4. Sidebar notification badges
          Pass already-known counts to skip a fetch:
            loadNavBadges({ dashboard: 3 })
            loadNavBadges({ plants: 2 })
            loadNavBadges()            // fetches all
       --------------------------------------------------------- */
    async function fetchCount(url, key) {
        try {
            var response = await fetch(url, { credentials: 'include' });
            if (!response.ok) return 0;
            var data = await response.json();
            return (data[key] || []).length;
        } catch (err) {
            return 0;
        }
    }

    function applyBadge(elId, count) {
        var el = document.getElementById(elId);
        if (!el) return;
        if (count > 0) {
            el.textContent = count > 99 ? '99+' : String(count);
            el.hidden = false;
        } else {
            el.hidden = true;
        }
    }

    async function loadNavBadges(known) {
        known = known || {};
        var dashCount = ('dashboard' in known)
            ? known.dashboard
            : await fetchCount('/admin/api/role-requests', 'requests');
        var plantCount = ('plants' in known)
            ? known.plants
            : await fetchCount('/admin/api/plant-requests', 'requests');
        // the discovery queue has its own endpoint and its own badge,
        // because it is NOT part of the plant review queue — a report is closed
        // by its record's approval, so folding it into the plants count would
        // double-count the same work and promise an admin a queue item that
        // resolves itself.
        var discoveryCount = ('discoveries' in known)
            ? known.discoveries
            : await fetchTotal('/admin/api/discovery-reports', 'requests');

        // A caller that cannot supply a count omits the key entirely rather than
        // passing undefined, so `'discoveries' in known` means the number is real.
        applyBadge('navBadgeDashboard', dashCount);
        applyBadge('navBadgePlants', plantCount);
        // The Discoveries link moved out of the sidebar into the Plants topbar,
        // so its badge lives there now. Pages without these ids simply skip them.
        applyBadge('plantsTabBadgePending', plantCount);
        applyBadge('plantsTabBadgeDiscoveries', discoveryCount);

        var hamburger = document.querySelector('.admin-hamburger');
        if (hamburger) {
            hamburger.classList.toggle(
                'has-notifications',
                (dashCount + plantCount + discoveryCount) > 0
            );
        }
    }

    /**
     * Counts `data.total`, for endpoints that paginate. fetchCount above counts
     * `(data[key] || []).length`, which reads 0 for any page of a paginated
     * list — so a discovery queue with 30 reports on page one and none shown
     * would badge as empty. Two count helpers, because the two response shapes
     * genuinely differ.
     */
    async function fetchTotal(url, key) {
        try {
            var response = await fetch(url, { credentials: 'include' });
            if (!response.ok) return 0;
            var data = await response.json();
            return data.total || 0;
        } catch (err) {
            return 0;
        }
    }

    /* ---------------------------------------------------------
       5. Wire up the DOM once it exists
       --------------------------------------------------------- */
    function init() {
        var sidebar = document.getElementById('adminSidebar');
        var hamburger = document.querySelector('.admin-hamburger');
        var scrim = document.querySelector('.admin-sidebar-scrim');
        var closeBtn = document.querySelector('.admin-sidebar-close');
        var toggleBtn = document.getElementById('adminSidebarToggle');

        /* ----- Appearance switch: its own block below the nav ----- */
        if (sidebar && !document.getElementById('adminThemeSwitch')) {
            var box = document.createElement('div');
            box.id = 'adminThemeSwitch';
            box.className = 'admin-theme-switch';
            box.setAttribute('role', 'group');
            box.setAttribute('aria-label', 'Color theme');
            box.innerHTML =
                '<span class="admin-theme-label">Appearance</span>' +
                '<div class="admin-theme-options">' +
                    '<button type="button" data-theme-option="light" title="Light mode">' +
                        '<span class="material-symbols-outlined">light_mode</span>' +
                        '<span class="admin-theme-text">Light</span>' +
                    '</button>' +
                    '<button type="button" data-theme-option="dark" title="Dark mode">' +
                        '<span class="material-symbols-outlined">dark_mode</span>' +
                        '<span class="admin-theme-text">Dark</span>' +
                    '</button>' +
                '</div>';
            sidebar.appendChild(box);

            // Each button sets a specific theme, so there is nothing to guess
            box.addEventListener('click', function (e) {
                var btn = e.target.closest('[data-theme-option]');
                if (!btn) return;
                setTheme(btn.getAttribute('data-theme-option'), true);
            });
        }
        updateThemeSwitch();

        /* ----- Desktop: collapse / expand (manual toggle only) ----- */
        if (toggleBtn) {
            toggleBtn.addEventListener('click', function () {
                setCollapsed(!root.classList.contains('sidebar-collapsed'));
            });
        }

        /* ----- Mobile: close the drawer when a nav link is tapped ----- */
        if (sidebar) {
            sidebar.addEventListener('click', function (e) {
                var link = e.target.closest('nav a');
                if (!link) return;

                // Mobile: close the drawer (except when signing out)
                if (link.id !== 'adminLogoutLink') closeDrawer();
            });
        }

        /* ----- Mobile: off-canvas drawer ----- */
        if (sidebar && hamburger && scrim && closeBtn) {
            hamburger.addEventListener('click', function () {
                sidebar.classList.contains('open') ? closeDrawer() : openDrawer();
            });
            closeBtn.addEventListener('click', closeDrawer);
            scrim.addEventListener('click', closeDrawer);
        }

        function openDrawer() {
            sidebar.classList.add('open');
            scrim.classList.add('visible');
            document.body.style.overflow = 'hidden';
            hamburger.setAttribute('aria-expanded', 'true');
            hamburger.setAttribute('aria-label', 'Close sidebar');
            document.addEventListener('keydown', onKeydown);
        }

        function closeDrawer() {
            if (!sidebar || !scrim || !hamburger) return;
            sidebar.classList.remove('open');
            scrim.classList.remove('visible');
            document.body.style.overflow = '';
            hamburger.setAttribute('aria-expanded', 'false');
            hamburger.setAttribute('aria-label', 'Open sidebar');
            document.removeEventListener('keydown', onKeydown);
        }

        function onKeydown(e) {
            if (e.key === 'Escape') closeDrawer();
        }

        sizeSidebar();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    /* ---------------------------------------------------------
       5b. Desktop sidebar height
           Runs from the header's bottom edge (or the top of the screen
           once the header has scrolled away) down to the bottom of the
           screen, so Sign out and the Appearance switch always sit at
           the very bottom with no gap.
       --------------------------------------------------------- */
    var sizeQueued = false;

    function sizeSidebar() {
        sizeQueued = false;
        var sidebar = document.getElementById('adminSidebar');
        var header = document.querySelector('.admin-header');
        if (!sidebar) return;

        if (!desktop.matches) {
            sidebar.style.height = '';      // mobile drawer uses its own CSS
            return;
        }
        var top = header ? Math.max(0, header.getBoundingClientRect().bottom) : 0;
        sidebar.style.height = (window.innerHeight - top) + 'px';
    }

    function queueSizeSidebar() {
        if (sizeQueued) return;
        sizeQueued = true;
        window.requestAnimationFrame(sizeSidebar);
    }

    // Capture phase, so it also fires if the page scrolls inside a container
    document.addEventListener('scroll', queueSizeSidebar, true);
    window.addEventListener('resize', queueSizeSidebar);
    window.addEventListener('load', queueSizeSidebar);
    document.addEventListener('DOMContentLoaded', queueSizeSidebar);

    /* ---------------------------------------------------------
       6. Public API
       --------------------------------------------------------- */
    window.loadNavBadges = loadNavBadges;
    window.AdminSidebar = {
        setCollapsed: setCollapsed,
        setTheme: function (theme) { setTheme(theme, true); },
        getTheme: currentTheme
    };
})();