function switchToRegister(event) {
    if (event) event.preventDefault();
    const container = document.getElementById('authContainer');
    container.classList.add('active');
    document.title = 'Plantellect - Sign Up';
    history.replaceState(null, '', 'auth.html#register');
}

function switchToLogin(event) {
    if (event) event.preventDefault();
    const container = document.getElementById('authContainer');
    container.classList.remove('active');
    document.title = 'Plantellect - Log In';
    history.replaceState(null, '', 'auth.html#login');
}

function togglePasswordVisibility(inputId, iconId) {
    const passwordInput = document.getElementById(inputId);
    const toggleIcon = document.getElementById(iconId);
    if (passwordInput.type === 'password') {
        passwordInput.type = 'text';
        toggleIcon.style.opacity = '1';
    } else {
        passwordInput.type = 'password';
        toggleIcon.style.opacity = '0.6';
    }
}

function validatePassword(password) {
    const checks = {
        length: password.length >= 6,
        lowercase: /[a-z]/.test(password),
        uppercase: /[A-Z]/.test(password),
        number: /[0-9]/.test(password)
    };

    const lengthItem = document.getElementById('req-length');
    const lowerItem = document.getElementById('req-lowercase');
    const upperItem = document.getElementById('req-uppercase');
    const numberItem = document.getElementById('req-number');

    if (lengthItem) lengthItem.classList.toggle('valid', checks.length);
    if (lowerItem) lowerItem.classList.toggle('valid', checks.lowercase);
    if (upperItem) upperItem.classList.toggle('valid', checks.uppercase);
    if (numberItem) numberItem.classList.toggle('valid', checks.number);

    return Object.values(checks).every(v => v);
}

function redirectToHome() {
    window.location.href = 'home.html';
}

function closeErrorModal() {
    const errorModal = document.getElementById('errorModal');
    if (errorModal) {
        errorModal.style.display = 'none';
    }
}

function showSuccess(message) {
    document.getElementById('successMessage').textContent = message;
    document.getElementById('successModal').style.display = 'flex';
}

function showError(message) {
    document.getElementById('errorMessage').textContent = message;
    document.getElementById('errorModal').style.display = 'flex';
}

function showGuestModal() {
    document.getElementById('guestModal').style.display = 'flex';
}

function closeGuestModal() {
    document.getElementById('guestModal').style.display = 'none';
}

async function handleLogin(event) {
    event.preventDefault();

    const identifier = document.getElementById('loginIdentifier').value.trim();
    const password = document.getElementById('loginPassword').value;
    const rememberMe = document.getElementById('rememberMe').checked;

    const payload = identifier.includes('@')
        ? { email: identifier, password, rememberMe }
        : { username: identifier, password, rememberMe };

    try {
        const response = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(payload)
        });

        const data = await response.json();

        if (response.ok) {
            sessionStorage.setItem('username', data.username);
            if (typeof clearSidebarCache === 'function') {
                clearSidebarCache();
            }
            showSuccess('You are now logged in!');
            setTimeout(redirectToHome, 1500);
        } else {
            showError(data.error || 'Invalid username or password! Kindly use a valid credential');
        }
    } catch (err) {
        showError('Unable to connect to the server. Please try again.');
    }
}

async function handleRegister(event) {
    event.preventDefault();

    const email = document.getElementById('registerEmail').value.trim();
    const username = document.getElementById('registerUsername').value.trim();
    const password = document.getElementById('registerPassword').value;

    if (!validatePassword(password)) {
        showError('Password does not meet requirements');
        return;
    }

    try {
        const response = await fetch('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ email, username, password })
        });

        const data = await response.json();

        if (response.ok) {
            sessionStorage.setItem('username', data.username);
            if (typeof clearSidebarCache === 'function') {
                clearSidebarCache();
            }
            showSuccess('Account created successfully!');
            setTimeout(() => {
                closeErrorModal();
                switchToLogin();
            }, 1500);
        } else {
            showError(data.error || 'Sign up failed. Please try again.');
        }
    } catch (err) {
        showError('Unable to connect to the server. Please try again.');
    }
}

function handleGuestContinue() {
    sessionStorage.setItem('guestMode', 'true');
    redirectToHome();
}

function initAuthPage() {
    const hash = window.location.hash;
    if (hash === '#register') {
        switchToRegister(null);
    } else {
        switchToLogin(null);
    }

    document.getElementById('loginForm').addEventListener('submit', handleLogin);
    document.getElementById('registerForm').addEventListener('submit', handleRegister);

    const guestLink = document.getElementById('guestLink');
    if (guestLink) {
        guestLink.addEventListener('click', function(event) {
            event.preventDefault();
            showGuestModal();
        });
    }

    const guestContinueBtn = document.getElementById('guestContinueBtn');
    if (guestContinueBtn) {
        guestContinueBtn.addEventListener('click', handleGuestContinue);
    }

    const registerPassword = document.getElementById('registerPassword');
    if (registerPassword) {
        registerPassword.addEventListener('input', function() {
            validatePassword(this.value);
        });
    }

    if (typeof ensureSidebar === 'function') {
        ensureSidebar();
    }
}

document.addEventListener('DOMContentLoaded', initAuthPage);

window.switchToRegister = switchToRegister;
window.switchToLogin = switchToLogin;
window.togglePasswordVisibility = togglePasswordVisibility;
window.redirectToHome = redirectToHome;
window.closeErrorModal = closeErrorModal;
window.handleRestrictedClick = function() {};