(function () {
    const sidebar = document.getElementById('librarySidebar');
    const hamburger = document.querySelector('.nav-hamburger');
    const scrim = document.querySelector('.sidebar-scrim');
    const closeBtn = document.querySelector('.sidebar-close');

    if (!sidebar || !hamburger || !scrim || !closeBtn) {
        return;
    }

    let wasScrolling = false;

    function openDrawer() {
        sidebar.classList.add('open');
        scrim.classList.add('visible');
        document.body.classList.add('drawer-open');
        hamburger.setAttribute('aria-expanded', 'true');
        hamburger.setAttribute('aria-label', 'Close sidebar');
        document.addEventListener('keydown', handleKeydown);
    }

    function closeDrawer() {
        sidebar.classList.remove('open');
        scrim.classList.remove('visible');
        document.body.classList.remove('drawer-open');
        hamburger.setAttribute('aria-expanded', 'false');
        hamburger.setAttribute('aria-label', 'Open sidebar');
        document.removeEventListener('keydown', handleKeydown);
    }

    function toggleDrawer() {
        if (sidebar.classList.contains('open')) {
            closeDrawer();
        } else {
            openDrawer();
        }
    }

    function handleKeydown(e) {
        if (e.key === 'Escape') {
            closeDrawer();
        }
    }

    function handleScrimClick() {
        closeDrawer();
    }

    function handleSidebarLinkClick(e) {
        const link = e.target.closest('.sidebar-item, .sidebar-logout-link');
        if (link) {
            closeDrawer();
        }
    }

    hamburger.addEventListener('click', toggleDrawer);
    closeBtn.addEventListener('click', closeDrawer);
    scrim.addEventListener('click', handleScrimClick);
    sidebar.addEventListener('click', handleSidebarLinkClick);

    document.addEventListener('DOMContentLoaded', function () {
        hamburger.setAttribute('aria-label', 'Open sidebar');
        hamburger.setAttribute('aria-expanded', 'false');
        hamburger.setAttribute('aria-controls', 'librarySidebar');
    });
})();