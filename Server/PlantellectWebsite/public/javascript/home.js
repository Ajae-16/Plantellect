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
        authLinks.innerHTML = `${adminLink}<a href="#" id="navLogoutLink">LOG OUT (${escapeHtml(user.username)})</a>`;
        const logoutLink = document.getElementById('navLogoutLink');
        if (logoutLink) {
            logoutLink.addEventListener('click', function (e) {
                e.preventDefault();
                logoutUser();
            });
        }
    } else {
        authLinks.innerHTML = `<a href="login.html">LOG IN</a><a href="signup.html">SIGN UP</a>`;
    }
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str == null ? '' : str);
    return div.innerHTML;
}

async function openLibrary(event) {
    if (event) event.preventDefault();
    const user = await checkAuth();
    if (user) {
        window.location.href = 'discoveries.html';
        return;
    }
    if (sessionStorage.getItem('guestMode') === 'true') {
        window.location.href = 'library-guess.html';
        return;
    }
    window.location.href = 'library-error.html';
}

async function handleRestrictedClick(event, featureName) {
    if (featureName === 'discoveries') {
        return;
    }
    const user = await checkAuth();
    if (!user) {
        if (event) event.preventDefault();
        const modal = document.getElementById('restrictedModal');
        if (modal) {
            modal.style.display = 'flex';
        }
    }
}

async function logoutUser() {
    try {
        await fetch('/api/auth/logout', {
            method: 'POST',
            credentials: 'include'
        });
    } catch (err) {
        // ignore network errors during logout
    }
    clearAuthState();
    window.location.href = 'home.html';
}

document.addEventListener('DOMContentLoaded', function () {
    const popupHTML = `
        <div id="restrictedModal" class="restricted-popup-overlay" style="display: none;">
            <div class="restricted-popup-box">
                <span class="close-btn" id="closeRestrictedModal">&times;</span>
                <p>Log in to unlock all features</p>
                <button id="loginRedirectBtn" class="login-redirect-btn">Log in</button>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', popupHTML);

    const modal = document.getElementById('restrictedModal');
    const closeBtn = document.getElementById('closeRestrictedModal');
    const loginBtn = document.getElementById('loginRedirectBtn');

    if (closeBtn && modal) {
        closeBtn.addEventListener('click', function () {
            modal.style.display = 'none';
        });
    }
    if (loginBtn) {
        loginBtn.addEventListener('click', function () {
            window.location.href = 'login.html';
        });
    }

    checkAuth().then(function (user) {
        updateNavForAuthState(user);
    });
});
