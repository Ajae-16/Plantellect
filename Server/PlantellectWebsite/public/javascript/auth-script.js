let selectedRole = 'user';
let usernameValid = false;
let passwordValid = false;
let passwordsMatch = false;

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
    document.title = 'Plantellect - Sign In';
    history.replaceState(null, '', 'auth.html#login');
}

function selectRole(role) {
    selectedRole = role;
    document.querySelectorAll('.role-btn').forEach(btn => btn.classList.remove('active'));
    const btnId = role === 'botanist' ? 'roleExpertBtn' : 'roleUserBtn';
    const btn = document.getElementById(btnId);
    if (btn) btn.classList.add('active');

    const certBlock = document.querySelector('.certificate-attachment');
    const certInput = document.getElementById('registerCertificate');
    if (certBlock && certInput) {
        if (role === 'botanist') {
            certBlock.style.display = 'block';
            certInput.required = true;
        } else {
            certBlock.style.display = 'none';
            certInput.required = false;
        }
    }
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

function validateUsername(username) {
    const checks = {
        length: username.length >= 6
    };

    const lengthItem = document.getElementById('req-username-length');

    if (lengthItem) lengthItem.classList.toggle('valid', checks.length);

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
            showSuccess('You are now signed in!');
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
    const firstName = document.getElementById('registerFirstName').value.trim();
    const lastName = document.getElementById('registerLastName').value.trim();
    const certFile = document.getElementById('registerCertificate').files[0];
    
    const checkbox1 = document.getElementById('agreeTerms');
    const checkbox2 = document.getElementById('agreeInfo');

    if (!validateUsername(username)) {
        showError('Username must be at least 6 characters');
        return;
    }

    if (!validatePassword(password)) {
        showError('Password does not meet requirements');
        return;
    }

    const confirmPassword = document.getElementById('registerConfirmPassword').value;
    if (password !== confirmPassword) {
        showError('Passwords do not match');
        return;
    }

    if (selectedRole === 'botanist' && !certFile) {
        showError('Certificate is required for Botanist registration');
        return;
    }

    const termsChecked = checkbox1 && checkbox1.checked;
    const infoChecked = checkbox2 && checkbox2.checked;
    
    if (!termsChecked && !infoChecked) {
        // Neither checked - prompt to read terms
        const modal = document.getElementById('termsModal');
        if (modal) {
            modal.style.display = 'flex';
            const scrollBox = document.getElementById('termsScrollBox');
            if (scrollBox && scrollBox.scrollHeight <= scrollBox.clientHeight + 5) {
                unlockConsentControls();
            }
        }
        showError('Please read the Terms & Conditions and check both agreement boxes');
        return;
    }
    
    if (!termsChecked) {
        showError('You must agree to the Terms & Conditions');
        return;
    }
    
    if (!infoChecked) {
        showError('You must agree to the Information Usage');
        return;
    }

    try {
        const formData = new FormData();
        formData.append('email', email);
        formData.append('username', username);
        formData.append('password', password);
        formData.append('firstName', firstName);
        formData.append('lastName', lastName);
        formData.append('role', selectedRole);
        formData.append('agreeTerms', checkbox1 && checkbox1.checked ? 'true' : 'false');
        formData.append('agreeInfo', checkbox2 && checkbox2.checked ? 'true' : 'false');
        if (certFile) {
            formData.append('certificate', certFile);
        }

        const response = await fetch('/api/auth/register', {
            method: 'POST',
            credentials: 'include',
            body: formData
        });

        const data = await response.json();

        if (response.ok) {
            sessionStorage.setItem('username', data.username);
            if (typeof clearSidebarCache === 'function') {
                clearSidebarCache();
            }
            if (data.pending === true) {
                showSuccess('Your request is pending admin approval');
            } else {
                showSuccess('Account created successfully!');
                setTimeout(() => {
                    closeErrorModal();
                    switchToLogin();
                }, 1500);
            }
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

    const forgotPasswordLink = document.getElementById('forgotPasswordLink');
    if (forgotPasswordLink) {
        forgotPasswordLink.addEventListener('click', function(event) {
            event.preventDefault();
            window.location.href = 'forgot-pass.html';
        });
    }

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

    // Terms & Conditions Modal Interactivity Logic
    const openModalBtn = document.getElementById('openTermsModal');
    const modal = document.getElementById('termsModal');
    const scrollBox = document.getElementById('termsScrollBox');
    const closeBtn = document.getElementById('closeTermsBtn');
    
    const checkbox1 = document.getElementById('agreeTerms');
    const checkbox2 = document.getElementById('agreeInfo');
    const labelBox1 = document.getElementById('labelBox1');
    const labelBox2 = document.getElementById('labelBox2');

    let hasScrolledToBottom = false;

    if (openModalBtn && modal) {
        openModalBtn.addEventListener('click', function(e) {
            e.preventDefault();
            modal.style.display = 'flex';
            if (scrollBox && checkbox1 && checkbox2) {
                if (scrollBox.scrollHeight <= scrollBox.clientHeight + 5) {
                    unlockConsentControls();
                }
            }
        });
    }

    function unlockConsentControls() {
        if (!hasScrolledToBottom) {
            hasScrolledToBottom = true;
            
            checkbox1.disabled = false;
            checkbox2.disabled = false;
            if (labelBox1) {
                labelBox1.style.cursor = 'pointer';
                labelBox1.style.color = '#fff';
            }
            if (labelBox2) {
                labelBox2.style.cursor = 'pointer';
                labelBox2.style.color = '#fff';
            }

            if (closeBtn) {
                closeBtn.disabled = false;
                closeBtn.style.opacity = '1';
            }
        }
    }

    if (scrollBox && checkbox1 && checkbox2) {
        scrollBox.addEventListener('scroll', function() {
            if (scrollBox.scrollHeight - scrollBox.scrollTop <= scrollBox.clientHeight + 5) {
                unlockConsentControls();
            }
        });
    }

    if (closeBtn && modal) {
        closeBtn.addEventListener('click', function() {
            if (hasScrolledToBottom) {
                modal.style.display = 'none';
            } else {
                alert('Please read and scroll to the bottom of the terms first.');
            }
        });
    }

    if (checkbox1) {
        checkbox1.addEventListener('change', updateSignupButtonState);
    }
    if (checkbox2) {
        checkbox2.addEventListener('change', updateSignupButtonState);
    }

    const registerPassword = document.getElementById('registerPassword');
    const confirmPassword = document.getElementById('registerConfirmPassword');

    if (registerPassword) {
        registerPassword.addEventListener('input', function() {
            passwordValid = validatePassword(this.value);
            
            const confirmVal = confirmPassword ? confirmPassword.value : '';
            const matchItem = document.getElementById('req-match');
            
            passwordsMatch = (this.value === confirmVal) && (confirmVal.length > 0) && passwordValid;
            
            if (matchItem) {
                matchItem.classList.toggle('valid', passwordsMatch);
            }
            updateSignupButtonState();
        });
    }

    const registerUsername = document.getElementById('registerUsername');
    if (registerUsername) {
        registerUsername.addEventListener('input', function() {
            usernameValid = validateUsername(this.value);
            updateSignupButtonState();
        });
    }

    if (confirmPassword) {
        confirmPassword.addEventListener('input', function() {
            const password = registerPassword ? registerPassword.value : '';
            const matchItem = document.getElementById('req-match');
            
            passwordsMatch = (this.value === password) && (this.value.length > 0) && passwordValid;
            
            if (matchItem) {
                matchItem.classList.toggle('valid', passwordsMatch);
            }
            updateSignupButtonState();
        });
    }

    function updateSignupButtonState() {
        const signupBtn = document.querySelector('.signup-btn');
        const chk1 = document.getElementById('agreeTerms');
        const chk2 = document.getElementById('agreeInfo');
        const termsChecked = chk1 && chk2 && chk1.checked && chk2.checked;
        const ready = usernameValid && passwordValid && passwordsMatch && termsChecked;

        if (signupBtn) {
            signupBtn.disabled = false;
            signupBtn.setAttribute('aria-disabled', ready ? 'false' : 'true');
        }
    }

    selectRole('user');

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