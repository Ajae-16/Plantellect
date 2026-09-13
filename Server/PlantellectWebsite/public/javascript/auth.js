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

function updateNavForAuthState(user) {
    const authLinks = document.querySelector('.auth-links');
    if (!authLinks) return;

    if (user) {
        const isAdmin = (user.roles || []).includes('superadmin') || (user.roles || []).includes('admin');
        const adminLink = isAdmin
            ? `<a href="/admin/dashboard">ADMIN</a>`
            : '';
        authLinks.innerHTML = `${adminLink}<a href="#" id="navLogoutLink">SIGN OUT (${escapeHtml(user.username)})</a>`;
        const logoutLink = document.getElementById('navLogoutLink');
        if (logoutLink) {
            logoutLink.addEventListener('click', function (e) {
                e.preventDefault();
                if (typeof logoutUser === 'function') {
                    logoutUser();
                }
            });
        }
    } else {
        authLinks.innerHTML = `<a href="auth.html#login">SIGN IN</a><a href="auth.html#register">SIGN UP</a>`;
    }
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str == null ? '' : str);
    return div.innerHTML;
}

window.checkAuth = checkAuth;
window.clearAuthState = clearAuthState;
window.updateNavForAuthState = updateNavForAuthState;
window.escapeHtml = escapeHtml;