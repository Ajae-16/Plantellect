/* =========================================================
   sidebar.js (public)

   Load it in <head> WITHOUT defer so the saved theme and the
   collapsed state are applied before first paint (no flash).

   Who sees what:
     - guest              : no sidebar
     - user               : Discoveries, Plants, Scan, Profile      (no Record)
     - botanist           : Discoveries, Plants, Scan, Record, Profile
     - admin / superadmin : Discoveries, Plants, Profile            (no Scan, no Record)

   Handles: role-based rendering, dark / light mode, desktop icon rail,
   mobile off-canvas drawer and the "Sign in to unlock" popup.
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
       1. Sidebar items + auth
       --------------------------------------------------------- */
    // icon = a Material Symbols name (https://fonts.google.com/icons)
    var SIDEBAR_ITEMS = [
        { id: 'discoveries', label: 'DISCOVERIES', icon: 'home', href: 'home.html',
          show: function () { return true; } },
        { id: 'plants', label: 'PLANTS', icon: 'potted_plant', href: 'library.html',
          show: function (c) { return c.loggedIn; } },
        { id: 'scan', label: 'SCAN PLANT', icon: 'center_focus_strong', href: 'library.html#scan',
          show: function (c) { return c.loggedIn && !c.isAdmin; } },
        { id: 'record', label: 'RECORD PLANTS', icon: 'videocam', href: '#',
          show: function (c) { return c.isBotanist && !c.isAdmin; } },
        { id: 'profile', label: 'PROFILE', icon: 'person', href: 'profile.html', className: 'profile-link',
          show: function (c) { return c.loggedIn; } }
    ];

    function getCachedAuth() {
        try {
            return {
                permissions: JSON.parse(sessionStorage.getItem('permissions') || '[]'),
                roles: JSON.parse(sessionStorage.getItem('roles') || '[]')
            };
        } catch (e) {
            return { permissions: [], roles: [] };
        }
    }

    function getSidebarItems(permissions, roles) {
        var isAdmin = roles.indexOf('admin') !== -1 || roles.indexOf('superadmin') !== -1;
        var ctx = {
            loggedIn: permissions.length > 0 || roles.length > 0,
            isAdmin: isAdmin,
            isBotanist: roles.indexOf('botanist') !== -1
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
            // Only plain page links can be "active" (the #scan link never is)
            var isActive = item.href.indexOf('#') === -1 && item.href === currentPage;
            var cls = ['sidebar-item', item.className || '', isActive ? 'active' : '']
                .filter(Boolean).join(' ');
            var onclick = '';
            if (item.id === 'scan') onclick = 'onclick="handleScanClick(event)"';
            else if (item.href === '#') onclick = 'onclick="handleRestrictedClick(event, \'' + item.id + '\')"';
            return '<a href="' + item.href + '" class="' + cls + '" title="' + item.label + '"' +
                   (isActive ? ' aria-current="page"' : '') + ' ' + onclick + '>' +
                   '<span class="icon material-symbols-outlined">' + item.icon + '</span>' +
                   '<span class="nav-link-text">' + item.label + '</span></a>';
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

    async function fetchAuth() {
        try {
            var response = await fetch('/api/auth/me', { credentials: 'include' });
            if (response.ok) {
                var data = await response.json();
                sessionStorage.setItem('username', data.username);
                sessionStorage.setItem('roles', JSON.stringify(data.roles || []));
                sessionStorage.setItem('permissions', JSON.stringify(data.permissions || []));
                return { permissions: data.permissions || [], roles: data.roles || [] };
            }
        } catch (err) {
            console.error('Failed to fetch auth:', err);
        }
        return { permissions: [], roles: [] };
    }

    async function ensureSidebar() {
        var cached = getCachedAuth();
        if (cached.permissions.length > 0 || cached.roles.length > 0) {
            renderSidebar(cached.permissions, cached.roles);
        } else {
            var auth = await fetchAuth();
            renderSidebar(auth.permissions, auth.roles);
        }
    }

    function clearSidebarCache() {
        sessionStorage.removeItem('username');
        sessionStorage.removeItem('roles');
        sessionStorage.removeItem('permissions');
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

        var loggedIn;
        if (typeof window.checkAuth === 'function') {
            loggedIn = !!(await window.checkAuth());
        } else {
            var cached = getCachedAuth();
            loggedIn = cached.permissions.length > 0 || cached.roles.length > 0;
        }
        if (!loggedIn) showRestrictedModal();
    }

    /* Scan Plant lives only in the sidebar. On the library page it opens the
       scan modal through the hidden #scanPlantBtn that scan.js listens to;
       from any other page the link goes to library.html#scan, which opens it. */
    function handleScanClick(event) {
        var trigger = document.getElementById('scanPlantBtn');
        if (trigger) {
            event.preventDefault();
            trigger.click();
        }
    }

    window.addEventListener('load', function () {
        if (window.location.hash !== '#scan') return;
        var trigger = document.getElementById('scanPlantBtn');
        if (!trigger) return;
        trigger.click();
        history.replaceState(null, '', window.location.pathname + window.location.search);
    });

    /* ---------------------------------------------------------
       2. Mobile drawer
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
       3. Wire up the page
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

        await ensureSidebar();
    });

    window.ensureSidebar = ensureSidebar;
    window.clearSidebarCache = clearSidebarCache;
    window.handleRestrictedClick = handleRestrictedClick;
    window.handleScanClick = handleScanClick;
    window.PublicSidebar = {
        setCollapsed: setCollapsed,
        setTheme: function (theme) { setTheme(theme, true); },
        getTheme: currentTheme
    };
})();