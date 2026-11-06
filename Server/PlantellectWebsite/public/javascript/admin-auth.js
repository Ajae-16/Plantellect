/**
 * admin-auth.html: sign-in for administrators only.
 *
 * It uses the normal POST /api/auth/login, then checks the answer: an account without
 * the access_admin permission is signed straight back out, so this page can never leave a
 * regular user holding a web session. The check here is a courtesy; the real gate is
 * requirePermission('access_admin') on every /admin route.
 */
(function () {
    'use strict';

    var ADMIN_HOME = '/admin/dashboard';

    var form = document.getElementById('adminLoginForm');
    var errorBox = document.getElementById('adminAuthError');
    var submitBtn = document.getElementById('adminLoginBtn');
    var eye = document.getElementById('toggleLoginPassword');
    var passwordInput = document.getElementById('loginPassword');

    function showError(text) {
        errorBox.textContent = text || '';
        errorBox.hidden = !text;
    }

    function setBusy(busy) {
        submitBtn.disabled = busy;
        submitBtn.textContent = busy ? 'Signing in...' : 'Sign in';
    }

    function togglePassword() {
        var show = passwordInput.type === 'password';
        passwordInput.type = show ? 'text' : 'password';
        eye.style.opacity = show ? '1' : '0.6';
        eye.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    }

    async function signOutQuietly() {
        try {
            await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
        } catch (err) { /* nothing more to do */ }
    }

    async function handleLogin(event) {
        event.preventDefault();
        showError('');

        var identifier = document.getElementById('loginIdentifier').value.trim();
        var password = passwordInput.value;
        if (!identifier || !password) {
            showError('Enter your username or email and your password.');
            return;
        }

        var payload = identifier.indexOf('@') !== -1
            ? { email: identifier, password: password }
            : { username: identifier, password: password };

        setBusy(true);
        try {
            var response = await fetch('/api/auth/login', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            var data = await response.json().catch(function () { return {}; });

            if (!response.ok) {
                showError(data.error || 'Sign in failed. Please try again.');
                setBusy(false);
                return;
            }

            var permissions = Array.isArray(data.permissions) ? data.permissions : [];
            if (permissions.indexOf('access_admin') === -1) {
                await signOutQuietly();
                showError('This page is for administrators only. Please use the Plantellect app.');
                setBusy(false);
                return;
            }

            // The sidebar caches who is signed in; drop it so the admin pages start clean.
            try {
                ['accountId', 'username', 'roles', 'permissions'].forEach(function (key) { sessionStorage.removeItem(key); });
            } catch (err) { /* storage unavailable */ }

            window.location.href = ADMIN_HOME;
        } catch (err) {
            showError('Unable to connect to the server. Please try again.');
            setBusy(false);
        }
    }

    form.addEventListener('submit', handleLogin);
    eye.addEventListener('click', togglePassword);
    eye.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePassword(); }
    });
})();
