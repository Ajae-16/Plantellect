function confirmLogout() {
    return new Promise((resolve) => {
        const existingModal = document.getElementById('logoutConfirmModal');
        if (existingModal) {
            existingModal.remove();
        }

        const modalHTML = `
            <div id="logoutConfirmModal" class="logout-popup-overlay" style="display: flex; position: fixed; inset: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.6); align-items: center; justify-content: center; z-index: 99999;">
                <div class="logout-popup-box" style="background: #2b3a2f; color: #fff; padding: 24px 28px; border-radius: 12px; max-width: 320px; width: 90%; text-align: center; box-shadow: 0 4px 20px rgba(0,0,0,0.3); font-family: sans-serif;">
                    <p style="margin: 0 0 20px; font-size: 15px;">Are you sure you want to sign out?</p>
                    <div style="display: flex; gap: 10px; justify-content: center;">
                        <button id="confirmLogoutBtn" class="guest-continue-btn" style="background-color: #2e6417; border: 1px solid #2e6417; color: #fff; padding: 10px 18px; border-radius: 6px; cursor: pointer; font-size: 14px;">Yes, Sign Out</button>
                        <button id="cancelLogoutBtn" class="guest-continue-btn" style="background-color: transparent; border: 1px solid #fff; color: #fff; padding: 10px 18px; border-radius: 6px; cursor: pointer; font-size: 14px;">Cancel</button>
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

    window.location.href = '/home.html';
}

document.addEventListener('DOMContentLoaded', function () {
    document.addEventListener('click', function (e) {
        const link = e.target.closest('.sidebar-logout-link');
        if (!link) return;
        e.preventDefault();
        logoutUser();
    });
});