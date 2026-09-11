function handleRestrictedClick(event, featureName) {
    if (featureName === 'discoveries') return;

    const cachedPermissions = JSON.parse(sessionStorage.getItem('permissions') || '[]');
    const cachedRoles = JSON.parse(sessionStorage.getItem('roles') || '[]');

    if (cachedPermissions.length === 0 && cachedRoles.length === 0) {
        event.preventDefault();
        const modal = document.getElementById('restrictedModal');
        if (modal) {
            modal.style.display = 'flex';
        }
    }
}

function updateNavForAuthState(user) {
    const authLinks = document.querySelector('.auth-links');
    if (!authLinks) return;

    if (user) {
        const isAdmin = (user.roles || []).includes('superadmin') || (user.roles || []).includes('admin');
        const adminLink = isAdmin
            ? `<a href="/admin/dashboard">ADMIN</a>`
            : '';
        authLinks.innerHTML = `${adminLink}<a href="#" id="navLogoutLink">LOG OUT (${escapeHtml(user.username)})</a>`;
        const logoutLink = document.getElementById('navLogoutLink');
        if (logoutLink) {
            logoutLink.addEventListener('click', function(e) {
                e.preventDefault();
                if (typeof logoutUser === 'function') {
                    logoutUser();
                }
            });
        }
    } else {
        authLinks.innerHTML = `<a href="auth.html#login">LOG IN</a><a href="auth.html#register">SIGN UP</a>`;
    }
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str == null ? '' : str);
    return div.innerHTML;
}

async function checkAuth() {
    try {
        const response = await fetch('/api/auth/me', { credentials: 'include' });
        if (response.ok) {
            const data = await response.json();
            sessionStorage.setItem('username', data.username);
            sessionStorage.setItem('roles', JSON.stringify(data.roles || []));
            sessionStorage.setItem('permissions', JSON.stringify(data.permissions || []));
            return data;
        }
        clearAuthState();
        return null;
    } catch (err) {
        return null;
    }
}

function clearAuthState() {
    sessionStorage.removeItem('username');
    sessionStorage.removeItem('roles');
    sessionStorage.removeItem('permissions');
}

function setActiveSidebarItem() {
    const sidebar = document.getElementById('librarySidebar');
    if (!sidebar) return;

    const links = sidebar.querySelectorAll('.sidebar-item');
    links.forEach(link => {
        link.classList.remove('active');
        if (link.getAttribute('href') === 'library.html') {
            link.classList.add('active');
        }
    });
}

document.addEventListener('DOMContentLoaded', async function() {
    const user = await checkAuth();
    updateNavForAuthState(user);
    setActiveSidebarItem();
});

window.handleRestrictedClick = handleRestrictedClick;