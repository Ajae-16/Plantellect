async function initProfilePage() {
    const profileCard = document.getElementById('profileCard');
    const guestPrompt = document.getElementById('guestPrompt');
    const profileAvatar = document.getElementById('profileAvatar');
    const profileUsername = document.getElementById('profileUsername');
    const profileEmail = document.getElementById('profileEmail');
    const profileRoles = document.getElementById('profileRoles');

    let user = null;
    try {
        const response = await fetch('/api/auth/me', { credentials: 'include' });
        if (response.ok) {
            user = await response.json();
        }
    } catch (err) {
        console.error('Failed to fetch profile:', err);
    }

    updateNavForAuthState(user);

    if (!user) {
        if (guestPrompt) guestPrompt.style.display = 'block';
        if (profileCard) profileCard.style.display = 'none';
        return;
    }

    if (profileCard) profileCard.style.display = 'block';
    if (guestPrompt) guestPrompt.style.display = 'none';

    if (profileUsername) profileUsername.textContent = user.username || '-';
    if (profileEmail) profileEmail.textContent = user.email || '-';
    if (profileRoles) {
        const roles = (user.roles || []).join(', ') || 'None';
        profileRoles.textContent = roles;
    }

    if (profileAvatar && user.username) {
        const initials = user.username.slice(0, 2).toUpperCase();
        profileAvatar.textContent = initials;
    }
}

document.addEventListener('DOMContentLoaded', initProfilePage);