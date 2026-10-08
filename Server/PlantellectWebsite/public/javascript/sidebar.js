/* =========================================================
   sidebar.js (public)

   Load it in <head> WITHOUT defer so the saved theme and the
   collapsed state are applied before first paint (no flash).

   Who sees what:
     - guest              : no sidebar
     - user               : Discoveries, Plants, Scan, Profile      (no Record)
     - botanist           : Discoveries, Plants, Scan, Record, Profile
     - admin / superadmin : Discoveries, Plants, Scan, Record, Profile (all items they have permissions for)

   Record is decided by the record_plant permission, not the role name. Every
   item is a plain link to a real page — SCAN PLANT is capture-plant.html and
   RECORD PLANTS is record.html, not a modal and not a #scan hash.

   Handles: the auth authority (one /api/auth/me fetch, the .auth-links render
   and window.plantAuth), role-based sidebar rendering, dark / light mode,
   desktop icon rail, mobile off-canvas drawer, item badges and the
   "Sign in to unlock" popup.

   A page must NOT fetch /api/auth/me or render .auth-links itself. Doing so is
   what left record.html, capture-plant.html and discoveries.html with a
   permanently signed-out header: the session was fine, the header was simply
   never told. scripts/check-scripts.cjs asserts that.
   ========================================================= */
(function () {
    'use strict';

    var THEME_KEY = 'siteTheme';
    var COLLAPSE_KEY = 'siteSidebarCollapsed';
    var rootEl = document.documentElement;
    var desktopQuery = window.matchMedia('(min-width: 768px)');
    var darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

    function readStore(key) {
        try { return localStorage.getItem(key); } catch (e) { return null; }
    }
    function writeStore(key, value) {
        try { localStorage.setItem(key, value); } catch (e) {}
    }

    /* Sidebar markup is built from a static table, but a badge value could come
       from an API, so it is escaped rather than trusted. */
    function escapeText(str) {
        var div = document.createElement('div');
        div.textContent = String(str == null ? '' : str);
        return div.innerHTML;
    }

    /* ---------------------------------------------------------
       0. Apply saved theme + collapsed state immediately
       --------------------------------------------------------- */
    (function applySavedState() {
        var saved = readStore(THEME_KEY);
        rootEl.setAttribute(
            'data-theme',
            (saved === 'dark' || saved === 'light') ? saved : (darkQuery.matches ? 'dark' : 'light')
        );

        // First visit: tablets start as an icon rail, wide screens start expanded
        var savedCollapse = readStore(COLLAPSE_KEY);
        if (savedCollapse === '1' || (savedCollapse === null && window.innerWidth < 1024)) {
            rootEl.classList.add('sidebar-collapsed');
        }
    })();

    function currentTheme() {
        return rootEl.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    }

    function updateThemeSwitch() {
        var theme = currentTheme();

        // Floating theme button (guests only): shows the mode you would switch TO
        var fab = document.getElementById('guestThemeToggle');
        if (fab) {
            var fabIcon = fab.querySelector('.material-symbols-outlined');
            if (fabIcon) fabIcon.textContent = theme === 'dark' ? 'light_mode' : 'dark_mode';
            var fabLabel = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
            fab.setAttribute('aria-label', fabLabel);
            fab.title = fabLabel;
        }

        var box = document.getElementById('sidebarThemeSwitch');
        if (!box) return;
        box.querySelectorAll('[data-theme-option]').forEach(function (btn) {
            var isActive = btn.getAttribute('data-theme-option') === theme;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        });
    }

    function setTheme(theme, persist) {
        rootEl.setAttribute('data-theme', theme);
        if (persist) writeStore(THEME_KEY, theme);
        updateThemeSwitch();
    }

    // Follow the OS setting until the user picks a theme manually
    function onSystemThemeChange(e) {
        var saved = readStore(THEME_KEY);
        if (saved === 'dark' || saved === 'light') return;
        setTheme(e.matches ? 'dark' : 'light', false);
    }
    if (darkQuery.addEventListener) darkQuery.addEventListener('change', onSystemThemeChange);
    else if (darkQuery.addListener) darkQuery.addListener(onSystemThemeChange);

    function setCollapsed(collapsed) {
        rootEl.classList.toggle('sidebar-collapsed', collapsed);
        writeStore(COLLAPSE_KEY, collapsed ? '1' : '0');
    }

    /* ---------------------------------------------------------
       1. THE auth authority

       sidebar.js is loaded in <head> with no defer on every public page,
       before any page script, so it is the one file a page cannot forget to
       load. That is why identity lives here and not in a page script:

         - /api/auth/me is fetched ONCE, and the FULL user is kept.
         - .auth-links is rendered from that one answer, on DOMContentLoaded
           (this file runs before the header exists in the DOM).
         - window.plantAuth is the single awaitable for pages that gate.

       auth.js previously fetched the same endpoint independently and returned a
       different shape ({ permissions, roles } here vs the whole user there), and
       BOTH wrote the same three sessionStorage keys — so whichever resolved last
       won, and a page reading the cache could see permissions but no username.
       There is now exactly one writer of those keys: writeSessionUser below.
       --------------------------------------------------------- */

    /** Resolved once the single fetch has finished. null means signed out. */
    var plantAuthUser = null;

    function readSessionUser() {
        try {
            return {
                username: sessionStorage.getItem('username') || '',
                roles: JSON.parse(sessionStorage.getItem('roles') || '[]'),
                permissions: JSON.parse(sessionStorage.getItem('permissions') || '[]')
            };
        } catch (e) {
            return { username: '', roles: [], permissions: [] };
        }
    }

    function writeSessionUser(user) {
        try {
            sessionStorage.setItem('username', user.username || '');
            sessionStorage.setItem('roles', JSON.stringify(user.roles || []));
            sessionStorage.setItem('permissions', JSON.stringify(user.permissions || []));
        } catch (e) {}
    }

    function clearSessionUser() {
        try {
            sessionStorage.removeItem('username');
            sessionStorage.removeItem('roles');
            sessionStorage.removeItem('permissions');
        } catch (e) {}
    }

    /**
     * ONE shape for the whole app: { accountId, username, email, roles, permissions }
     * or null. Every consumer reads this, so a page cannot get a half user.
     *
     * A failure is null rather than a throw. This is a UI convenience layer — the
     * APIs are the real gate — and a rejected promise here would blank a header
     * on a page whose content is otherwise fine.
     * Returns a tri-state: { state: 'user', user: {...} } | { state: 'anonymous' } | { state: 'unknown' }
     */
    async function fetchCurrentUser() {
        try {
            var response = await fetch('/api/auth/me', { credentials: 'include' });
            if (response.status === 401) return { state: 'anonymous' };
            if (!response.ok) return { state: 'unknown' };
            var data = await response.json();
            return {
                state: 'user',
                user: {
                    accountId: data.accountId || null,
                    username: data.username || '',
                    email: data.email || '',
                    roles: data.roles || [],
                    permissions: data.permissions || []
                }
            };
        } catch (err) {
            console.error('Failed to fetch auth:', err);
            return { state: 'unknown' };
        }
    }

    // Started while <head> parses, resolved whenever the answer arrives. Nothing
    // here touches the DOM: the header is rendered on DOMContentLoaded below.
    var plantAuthReady = fetchCurrentUser().then(function (result) {
        if (result.state === 'user') {
            plantAuthUser = result.user;
            writeSessionUser(result.user);
        } else if (result.state === 'anonymous') {
            plantAuthUser = null;
            clearSessionUser();
        } else if (result.state === 'unknown') {
            // One automatic retry after 500ms
            return new Promise(function (r) { setTimeout(r, 500); })
                .then(function () { return fetchCurrentUser(); })
                .then(function (retryResult) {
                    if (retryResult.state === 'user') {
                        plantAuthUser = retryResult.user;
                        writeSessionUser(retryResult.user);
                    } else if (retryResult.state === 'anonymous') {
                        plantAuthUser = null;
                        clearSessionUser();
                    }else {
                        var cached = readSessionUser();
                        if (cached.username || cached.roles.length) {
                            plantAuthUser = {
                                account: null,
                                username: cached.username,
                                email: '',
                                roles: cached.roles,
                                permissions: cached.permissions

                            };
                        }
                    }
                    // Second unknown → give up, keep last known good
                    return plantAuthUser;
                });
        }
        return result.state === 'user' ? result.user : null;
    });

    /**
     * The header's SIGN OUT (username) / SIGN IN + SIGN UP, from session state.
     *
     * The username is escaped: it comes from an accounts row, and the sign-out
     * link carries a click handler, so it is the one piece of account data that
     * reaches an href-bearing element.
     */
    function renderAuthLinks(user) {
        var authLinks = document.querySelector('.auth-links');
        if (!authLinks) return;
        authLinks.setAttribute('data-ready', '1');
        if (!user) {
            authLinks.innerHTML =
                '<a href="auth.html#login">SIGN IN</a><a href="auth.html#register">SIGN UP</a>';
            return;
        }

        var roles = user.roles || [];
        var isAdmin = roles.indexOf('admin') !== -1 || roles.indexOf('superadmin') !== -1;
        var adminLink = isAdmin ? '<a href="/admin/dashboard">ADMIN</a>' : '';
        authLinks.innerHTML = adminLink +
            '<a href="#" id="navLogoutLink">SIGN OUT (' + escapeText(user.username) + ')</a>';

        var logoutLink = document.getElementById('navLogoutLink');
        if (logoutLink) {
            logoutLink.addEventListener('click', function (e) {
                e.preventDefault();
                if (typeof window.logoutUser === 'function') window.logoutUser();
            });
        }
    }

    window.plantAuth = {
        /** Resolves with the full user, or null when signed out. Never rejects. */
        ready: plantAuthReady,
        /** Synchronous read of the resolved user, for code already inside await ready. */
        user: function () { return plantAuthUser; }
    };

    /* ---------------------------------------------------------
       2. Sidebar items
       --------------------------------------------------------- */
    // icon = a Material Symbols name (https://fonts.google.com/icons)
    // Every item is a plain page link: no onclick handlers, so a click either
    // navigates or does not exist. `badge` is an optional marker set via
    // markSidebarBadge(); empty by default, so nothing is rendered unless
    // something asks for it.
    var SIDEBAR_ITEMS = [
        { id: 'plants', label: 'PLANTS', icon: 'potted_plant', href: 'library.html',
          show: function (c) { return c.loggedIn; } },
        { id: 'scan', label: 'SCAN PLANT', icon: 'center_focus_strong', href: 'capture-plant.html',
          show: function (c) { return c.permissions.includes('scan_plant'); } },
        // Before RECORD PLANTS on purpose: the dot is the "somebody has flagged
        // a plant you can help with" signal, and an item placed after RECORD is
        // the one that gets pushed off a short screen.
        { id: 'discoveries', label: 'DISCOVERIES', icon: 'travel_explore', href: 'discoveries.html',
          show: function (c) { return c.canDiscover; } },
        { id: 'record', label: 'RECORD PLANTS', icon: 'edit_note', href: 'record.html',
          show: function (c) { return c.canRecord; } },
        { id: 'profile', label: 'PROFILE', icon: 'person', href: 'profile.html', className: 'profile-link',
          show: function (c) { return c.loggedIn; } }
    ];

    function getSidebarItems(permissions, roles) {
        var isAdmin = roles.indexOf('admin') !== -1 || roles.indexOf('superadmin') !== -1;
        var ctx = {
            loggedIn: permissions.length > 0 || roles.length > 0,
            isAdmin: isAdmin,
            isBotanist: roles.indexOf('botanist') !== -1,
            permissions: permissions,
            // Driven by the permission, not the role name: who holds
            // record_plant is the question, and role names are not the source of
            // truth for it. Admins now get RECORD if they hold the permission.
            canRecord: permissions.indexOf('record_plant') !== -1,
            // Same rule as canRecord: the queue is botanist work, but admins
            // with record_plant can also see it.
            canDiscover: permissions.indexOf('record_plant') !== -1
        };
        return SIDEBAR_ITEMS.filter(function (item) { return item.show(ctx); });
    }

    // Only decides "logged in or not". The CSS decides where the hamburger shows.
    function updateBurgerVisibility(permissions, roles) {
        var burger = document.querySelector('.nav-hamburger');
        if (!burger) return;
        var isLoggedIn = permissions.length > 0 || roles.length > 0;
        burger.style.display = isLoggedIn ? '' : 'none';
    }

    // Guests have no sidebar, so give them a small floating theme button
    function setGuestThemeButton(show) {
        var fab = document.getElementById('guestThemeToggle');
        if (!show) {
            if (fab) fab.remove();
            return;
        }
        if (fab) return;
        fab = document.createElement('button');
        fab.id = 'guestThemeToggle';
        fab.type = 'button';
        fab.className = 'theme-fab';
        fab.innerHTML = '<span class="material-symbols-outlined"></span>';
        fab.addEventListener('click', function () {
            setTheme(currentTheme() === 'dark' ? 'light' : 'dark', true);
        });
        document.body.appendChild(fab);
        updateThemeSwitch();
    }

    // Which sidebar items carry a dot, and what it counts. Populated by
    // markSidebarBadge(); empty by default, so nothing is rendered unless
    // something asks for it.
    var sidebarBadges = {};

    /**
     * Marks (or clears) a badge on a sidebar item and re-renders. The fetch that
     * decides what the badge says is deliberately NOT in this file's render
     * path: a badge source is a feature concern, not a sidebar concern, and a
     * failing fetch must not take the sidebar down with it.
     */
    function markSidebarBadge(itemId, value) {
        if (value === null || value === undefined || value === '' || value === false) {
            delete sidebarBadges[itemId];
        } else {
            sidebarBadges[itemId] = String(value);
        }
        if (plantAuthUser) {
            renderSidebar(plantAuthUser.permissions, plantAuthUser.roles);
        }
    }

    function renderSidebar(permissions, roles) {
        var sidebar = document.getElementById('librarySidebar');
        if (!sidebar) return;

        updateBurgerVisibility(permissions, roles);
        var items = getSidebarItems(permissions, roles);
        var currentPage = window.location.pathname.split('/').pop() || 'home.html';

        if (items.length <= 1) {
            document.body.classList.add('no-sidebar');
            document.body.classList.remove('has-sidebar');
            sidebar.innerHTML = '';
            setGuestThemeButton(true);
            return;
        }

        setGuestThemeButton(false);

        document.body.classList.remove('no-sidebar');
        document.body.classList.add('has-sidebar');

        var linksHTML = items.map(function (item) {
            var isActive = item.href === currentPage;
            var cls = ['sidebar-item', item.className || '', isActive ? 'active' : '']
                .filter(Boolean).join(' ');
            var badge = sidebarBadges[item.id];
            var badgeHtml = badge
                ? '<span class="sidebar-badge">' + escapeText(badge) + '</span>'
                : '';
            return '<a href="' + item.href + '" class="' + cls + '" title="' + item.label + '"' +
                   (isActive ? ' aria-current="page"' : '') + '>' +
                   '<span class="icon material-symbols-outlined">' + item.icon + '</span>' +
                   '<span class="nav-link-text">' + item.label + '</span>' +
                   badgeHtml + '</a>';
        }).join('');

        sidebar.innerHTML =
            '<div class="sidebar-header">' +
                '<h3>MENU</h3>' +
                '<button class="sidebar-close" aria-label="Close sidebar">' +
                    '<span class="material-symbols-outlined">close</span></button>' +
            '</div>' +
            '<button type="button" class="sidebar-toggle" id="sidebarToggle" ' +
                    'aria-label="Toggle sidebar" title="Expand / collapse sidebar">' +
                '<span class="toggle-glyph material-symbols-outlined">keyboard_double_arrow_left</span>' +
            '</button>' +
            '<div class="sidebar-nav" role="navigation" aria-label="Main menu">' +
                linksHTML +
                '<a href="#" class="sidebar-item sidebar-logout-link" title="SIGN OUT">' +
                    '<span class="icon material-symbols-outlined">logout</span>' +
                    '<span class="nav-link-text">SIGN OUT</span></a>' +
            '</div>' +
            '<div class="sidebar-theme-switch" id="sidebarThemeSwitch" role="group" aria-label="Color theme">' +
                '<span class="sidebar-theme-label">Appearance</span>' +
                '<div class="sidebar-theme-options">' +
                    '<button type="button" data-theme-option="light" title="Light mode">' +
                        '<span class="material-symbols-outlined">light_mode</span>' +
                        '<span class="sidebar-theme-text">Light</span></button>' +
                    '<button type="button" data-theme-option="dark" title="Dark mode">' +
                        '<span class="material-symbols-outlined">dark_mode</span>' +
                        '<span class="sidebar-theme-text">Dark</span></button>' +
                '</div>' +
            '</div>';

        updateThemeSwitch();
    }

    async function ensureSidebar() {
        var user = await plantAuthReady;

        renderAuthLinks(user); // bug fix preventing the sign in/sign out in nav header from rendering and confuse user
        renderSidebar(user ? user.permissions : [], user ? user.roles : []);
        await loadDiscoveryBadge();
    }

    /**
     * The DISCOVERIES dot.
     *
     * Counts UNCLAIMED, not pending: the item is named after the queue rather than
     * after the reports, and a count of claims somebody is already working on
     * would be a badge that never goes away.
     *
     * A failure here clears the dot rather than leaving the previous value up, so
     * a revoked permission or a dead endpoint cannot leave a stale number on a
     * page that is otherwise working.
     */
    async function loadDiscoveryBadge() {
        var auth = plantAuthUser;
        if (!auth) return;
        // Show badge for anyone with record_plant permission (includes admins)
        if (auth.permissions.indexOf('record_plant') === -1) return;
        try {
            var response = await fetch('/api/discoveries/count', { credentials: 'include' });
            if (!response.ok) {
                markSidebarBadge('discoveries', null);
                return;
            }
            var data = await response.json();
            markSidebarBadge('discoveries', data.unclaimed > 0 ? data.unclaimed : null);
        } catch (err) {
            console.error('Failed to load discovery badge:', err);
            markSidebarBadge('discoveries', null);
        }
    }

    function clearSidebarCache() {
        clearSessionUser();
        plantAuthUser = null;
        renderSidebar([], []);
        renderAuthLinks(null);
    }

    function showRestrictedModal() {
        var modal = document.getElementById('restrictedModal');
        if (modal) modal.style.display = 'flex';
    }

    async function handleRestrictedClick(event, featureName) {
        if (featureName === 'discoveries') return;

        // Placeholder links (href="#") never jump to the top of the page.
        // Must run before the first await.
        event.preventDefault();

        // The shared answer: the ONE /api/auth/me fetch on the page, and the ONE
// renderer of the header. The single awaitable for a page's own gate is
// window.plantAuth.ready; nothing else should fetch the current user.
var loggedIn = !!(await plantAuthReady);
        if (!loggedIn) showRestrictedModal();
    }

    /* handleRestrictedClick stays: auth-script.js stubs it, and a future
       restricted link may still need it. But no sidebar item uses an onclick
       any more — SCAN PLANT and RECORD PLANTS are ordinary page links. */

    /* ---------------------------------------------------------
       3. Mobile drawer
       --------------------------------------------------------- */
    function setDrawer(open) {
        var sidebar = document.getElementById('librarySidebar');
        var scrim = document.querySelector('.sidebar-scrim');
        var burger = document.querySelector('.nav-hamburger');
        if (sidebar) sidebar.classList.toggle('open', open);
        if (scrim) scrim.classList.toggle('visible', open);
        document.body.classList.toggle('drawer-open', open);
        if (burger) {
            burger.setAttribute('aria-expanded', open ? 'true' : 'false');
            burger.setAttribute('aria-label', open ? 'Close sidebar' : 'Open sidebar');
        }
    }
    function openPublicSidebar() { setDrawer(true); }
    function closePublicSidebar() { setDrawer(false); }

    /* ---------------------------------------------------------
       4. Wire up the page
       --------------------------------------------------------- */
    document.addEventListener('DOMContentLoaded', async function () {
        document.body.insertAdjacentHTML('beforeend',
            '<div id="restrictedModal" class="restricted-popup-overlay" style="display: none;">' +
                '<div class="restricted-popup-box">' +
                    '<span class="close-btn" id="closeRestrictedModal">&times;</span>' +
                    '<p>Sign in to unlock all features</p>' +
                    '<button id="loginRedirectBtn" class="login-redirect-btn">Sign in</button>' +
                '</div>' +
            '</div>');

        var modal = document.getElementById('restrictedModal');
        document.getElementById('closeRestrictedModal').addEventListener('click', function () {
            modal.style.display = 'none';
        });
        document.getElementById('loginRedirectBtn').addEventListener('click', function () {
            window.location.href = 'auth.html#login';
        });
        modal.addEventListener('click', function (e) {
            if (e.target === modal) modal.style.display = 'none';
        });

        var navHamburger = document.querySelector('.nav-hamburger');
        var librarySidebar = document.getElementById('librarySidebar');
        var scrim = document.querySelector('.sidebar-scrim');
        var contentAreas = document.querySelectorAll(
            'main, .main-content, .page-content, .hero-container, .slider-wrapper, .library-container'
        );

        if (navHamburger && librarySidebar) {
            navHamburger.addEventListener('click', function () {
                setDrawer(!librarySidebar.classList.contains('open'));
            });
        }

        // The sidebar contents are re-rendered, so clicks use event delegation
        if (librarySidebar) {
            librarySidebar.addEventListener('click', function (e) {
                if (e.target.closest('.sidebar-close')) { closePublicSidebar(); return; }

                if (e.target.closest('.sidebar-toggle')) {
                    setCollapsed(!rootEl.classList.contains('sidebar-collapsed'));
                    return;
                }

                var themeBtn = e.target.closest('[data-theme-option]');
                if (themeBtn) {
                    setTheme(themeBtn.getAttribute('data-theme-option'), true);
                    return;
                }

                var link = e.target.closest('.sidebar-item');
                if (!link) return;

                if (link.classList.contains('sidebar-logout-link')) {
                    e.preventDefault();
                    clearSidebarCache();
                    if (typeof window.logoutUser === 'function') window.logoutUser();
                    return;
                }

                // Desktop: collapse the rail (state carries to the next page)
                if (desktopQuery.matches) setCollapsed(true);
                // Mobile: close the drawer
                closePublicSidebar();
            });
        }

        if (scrim) scrim.addEventListener('click', closePublicSidebar);

        // Clicking the page content collapses the rail (desktop)
        contentAreas.forEach(function (area) {
            area.addEventListener('click', function (e) {
                if (e.target.closest('.sidebar')) return;
                if (desktopQuery.matches && document.body.classList.contains('has-sidebar') &&
                    !rootEl.classList.contains('sidebar-collapsed')) {
                    setCollapsed(true);
                }
            });
        });

        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') closePublicSidebar();
        });

        // Growing past mobile width with the drawer open: reset it
        var onBreakpoint = function (e) { if (e.matches) closePublicSidebar(); };
        if (desktopQuery.addEventListener) desktopQuery.addEventListener('change', onBreakpoint);
        else if (desktopQuery.addListener) desktopQuery.addListener(onBreakpoint);

        // The header render is the ONE thing here that could not run while
        // <head> parsed: .auth-links does not exist yet.

        await ensureSidebar();
    });

    window.ensureSidebar = ensureSidebar;
    window.clearSidebarCache = clearSidebarCache;
    window.handleRestrictedClick = handleRestrictedClick;
    // Exported so capture-plant.html and record.html can show the same "Sign in
    // to unlock" popup for a guest instead of leaving it unreachable dead code.
    window.showRestrictedModal = showRestrictedModal;
    window.markSidebarBadge = markSidebarBadge;
    // Exported so discoveries-script.js can refresh the dot after a claim or a
    // vote without a full page reload, using the SAME function that built it.
    window.loadDiscoveryBadge = loadDiscoveryBadge;
    window.PublicSidebar = {
        setCollapsed: setCollapsed,
        setTheme: function (theme) { setTheme(theme, true); },
        getTheme: currentTheme
    };
})();