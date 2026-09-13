const SIDEBAR_Items = [
    { id: 'discoveries', label: 'DISCOVERIES', icon: '🔍', permissions: [], href: 'home.html' },
    { id: 'plants', label: 'PLANTS', icon: '🌱', permissions: ['view_plants'], href: 'library.html' },
    { id: 'record', label: 'RECORD PLANTS', icon: '🎥', permissions: ['record_plant'], href: '#' },
    { id: 'users', label: 'USERS', icon: '👥', permissions: ['view_logs'], href: '#' },
    { id: 'profile', label: 'PROFILE', icon: '👤', permissions: [], href: '#', className: 'profile-link' }
];

function getCachedAuth() {
    try {
        const permissions = JSON.parse(sessionStorage.getItem('permissions') || '[]');
        const roles = JSON.parse(sessionStorage.getItem('roles') || '[]');
        return { permissions, roles };
    } catch (e) {
        return { permissions: [], roles: [] };
    }
}

function hasPermission(userPermissions, requiredPermissions) {
    if (!requiredPermissions || requiredPermissions.length === 0) return true;
    return requiredPermissions.some(p => userPermissions.includes(p));
}

function hasRole(userRoles, requiredRoles) {
    if (!requiredRoles || requiredRoles.length === 0) return true;
    return requiredRoles.some(r => userRoles.includes(r));
}

function getSidebarItems(permissions, roles) {
    return SIDEBAR_Items.filter(item => {
        if (item.id === 'discoveries') return true;
        if (item.id === 'profile') return permissions.length > 0 || roles.length > 0;
        if (item.id === 'plants') return hasPermission(permissions, item.permissions) || roles.length > 0;
        if (item.id === 'record') return hasPermission(permissions, item.permissions);
        if (item.id === 'users') return hasPermission(permissions, item.permissions) || hasRole(roles, ['admin', 'botanist', 'superadmin']);
        return false;
    });
}

function renderSidebar(permissions, roles) {
    const sidebar = document.getElementById('librarySidebar');
    if (!sidebar) return;

    const items = getSidebarItems(permissions, roles);
    const currentPage = window.location.pathname.split('/').pop() || 'library.html';
    const isLibraryPage = currentPage === 'library.html';

    if (items.length === 0 || (items.length === 1 && items[0].id === 'discoveries')) {
        document.body.classList.add('no-sidebar');
        sidebar.innerHTML = '';
        return;
    }

    document.body.classList.remove('no-sidebar');

    const sidebarHTML = items.map(item => {
        const isActive = isLibraryPage && item.id === 'discoveries';
        const itemClass = ['sidebar-item', item.className || '', isActive ? 'active' : ''].filter(Boolean).join(' ');
        const onclick = item.href === '#' ? `onclick="handleRestrictedClick(event, '${item.id}')"` : '';
        return `<a href="${item.href}" class="${itemClass}" ${onclick}><span class="icon">${item.icon}</span> ${item.label}</a>`;
    }).join('');

    const logoutLink = `
        <a href="#" class="sidebar-item sidebar-logout-link" style="margin-top: 40px; border-top: 1px solid #ccc; padding-top: 20px;">
            <span class="icon">🚪</span> SIGN OUT
        </a>
    `;

    sidebar.innerHTML = sidebarHTML + logoutLink;
    attachLogoutListeners();
}

async function fetchAuth() {
    try {
        const response = await fetch('/api/auth/me', { credentials: 'include' });
        if (response.ok) {
            const data = await response.json();
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
    const cached = getCachedAuth();
    if (cached.permissions.length > 0 || cached.roles.length > 0) {
        renderSidebar(cached.permissions, cached.roles);
    } else {
        const auth = await fetchAuth();
        renderSidebar(auth.permissions, auth.roles);
    }
}

function clearSidebarCache() {
    sessionStorage.removeItem('username');
    sessionStorage.removeItem('roles');
    sessionStorage.removeItem('permissions');
}

function handleRestrictedClick(event, featureName) {
    if (featureName === 'discoveries') return;

    const cached = getCachedAuth();
    if (cached.permissions.length === 0 && cached.roles.length === 0) {
        event.preventDefault();
        const modal = document.getElementById('restrictedModal');
        if (modal) {
            modal.style.display = 'flex';
        }
    }
}

document.addEventListener('DOMContentLoaded', async function() {
    const popupHTML = `
        <div id="restrictedModal" class="restricted-popup-overlay" style="display: none;">
            <div class="restricted-popup-box">
                <span class="close-btn" id="closeRestrictedModal">&times;</span>
                <p>Sign in to unlock all features</p>
                <button id="loginRedirectBtn" class="login-redirect-btn">Sign in</button>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', popupHTML);

    const modal = document.getElementById('restrictedModal');
    const closeBtn = document.getElementById('closeRestrictedModal');
    const loginBtn = document.getElementById('loginRedirectBtn');

    if (closeBtn && modal) {
        closeBtn.addEventListener('click', function() {
            modal.style.display = 'none';
        });
    }
    if (loginBtn) {
        loginBtn.addEventListener('click', function() {
            window.location.href = 'auth.html#login';
        });
    }

    await ensureSidebar();
});

function attachLogoutListeners() {
    const logoutLinks = document.querySelectorAll('.sidebar-logout-link');
    logoutLinks.forEach(link => {
        link.addEventListener('click', function(e) {
            e.preventDefault();
            if (typeof logoutUser === 'function') {
                logoutUser();
            }
        });
    });
}

window.ensureSidebar = ensureSidebar;
window.clearSidebarCache = clearSidebarCache;
window.handleRestrictedClick = handleRestrictedClick;