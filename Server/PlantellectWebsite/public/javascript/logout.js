function confirmLogout() {
    return new Promise((resolve) => {
        const existingModal = document.getElementById('logoutConfirmModal');
        if (existingModal) {
            existingModal.remove();
        }

        const modalHTML = `
            <div id="logoutConfirmModal" class="logout-popup-overlay" style="display: flex;">
                <div class="logout-popup-box">
                    <p>Are you sure you want to sign out?</p>
                    <div style="display: flex; gap: 10px; justify-content: center; margin-top: 20px;">
                        <button id="confirmLogoutBtn" class="guest-continue-btn" style="background-color: #2e6417; border-color: #2e6417;">Yes, Sign Out</button>
                        <button id="cancelLogoutBtn" class="guest-continue-btn">Cancel</button>
                    </div>
                </div>
            </div>
        `;
        document.body.insertAdjacentHTML('beforeend', modalHTML);

        document.getElementById('confirmLogoutBtn').addEventListener('click', () => {
            document.getElementById('logoutConfirmModal').remove();
            resolve(true);
        });

        document.getElementById('cancelLogoutBtn').addEventListener('click', () => {
            document.getElementById('logoutConfirmModal').remove();
            resolve(false);
        });
    });
}

async function logoutUser() {
    const confirmed = await confirmLogout();
    if (!confirmed) return;

    try {
        await fetch('/api/auth/logout', {
            method: 'POST',
            credentials: 'include'
        });
    } catch (err) {
        console.error('Logout request failed:', err);
    }

    sessionStorage.removeItem('username');
    sessionStorage.removeItem('roles');
    sessionStorage.removeItem('permissions');

    window.location.href = 'home.html';
}

document.addEventListener('DOMContentLoaded', function () {
    document.addEventListener('click', function (e) {
        const link = e.target.closest('.sidebar-logout-link');
        if (!link) return;
        e.preventDefault();
        logoutUser();
    });
});