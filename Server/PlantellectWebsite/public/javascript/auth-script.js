let selectedRole = 'user';
let usernameValid = false;
let passwordValid = false;
let passwordsMatch = false;

// Terms state lives at file level so handleRegister can reach it too
let hasScrolledToBottom = false;

/* ------------------------------------------------------------------ */
/* Panel switching                                                     */
/* ------------------------------------------------------------------ */

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
            clearCertificate(); // a plain user has no certificate, drop any preview
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

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* Modals                                                              */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* Terms & Conditions: unlock after reading                            */
/* ------------------------------------------------------------------ */

function unlockConsentControls() {
    if (hasScrolledToBottom) return;
    hasScrolledToBottom = true;

    const checkbox1 = document.getElementById('agreeTerms');
    const checkbox2 = document.getElementById('agreeInfo');
    const labelBox1 = document.getElementById('labelBox1');
    const labelBox2 = document.getElementById('labelBox2');
    const closeBtn = document.getElementById('closeTermsBtn');
    const progress = document.getElementById('termsProgress');
    const hint = document.getElementById('termsHint');

    // Removing `disabled` also removes the greyed-out look (CSS keys off it)
    if (checkbox1) checkbox1.disabled = false;
    if (checkbox2) checkbox2.disabled = false;
    if (labelBox1) { labelBox1.style.cursor = ''; labelBox1.style.color = ''; }
    if (labelBox2) { labelBox2.style.cursor = ''; labelBox2.style.color = ''; }

    if (closeBtn) {
        closeBtn.disabled = false;
        closeBtn.style.opacity = '';
    }
    if (progress) progress.textContent = 'You can now close this window.';
    if (hint) hint.textContent = 'Thanks for reading. Tick both boxes to continue.';
}

function updateTermsProgress() {
    // A hidden modal measures 0 height, which would look like "nothing left to
    // scroll", so never unlock while the modal is closed.
    const modal = document.getElementById('termsModal');
    if (!modal || modal.style.display === 'none' || modal.style.display === '') return;

    const scrollBox = document.getElementById('termsScrollBox');
    const progress = document.getElementById('termsProgress');
    if (!scrollBox || hasScrolledToBottom) return;

    const max = scrollBox.scrollHeight - scrollBox.clientHeight;
    const pct = max <= 0 ? 100 : Math.min(100, Math.round(scrollBox.scrollTop / max * 100));
    if (progress) progress.textContent = 'Scroll to the end to continue (' + pct + '%)';

    if (max <= 5 || scrollBox.scrollHeight - scrollBox.scrollTop <= scrollBox.clientHeight + 5) {
        unlockConsentControls();
    }
}

/* ------------------------------------------------------------------ */
/* Certificate preview                                                 */
/* ------------------------------------------------------------------ */

const CERT_MAX_BYTES = 5 * 1024 * 1024; // keep in sync with the server upload limit
let certObjectUrl = null;

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function clearCertificate() {
    const input = document.getElementById('registerCertificate');
    const label = document.querySelector('label[for="registerCertificate"]');
    const preview = document.getElementById('certificatePreview');
    const thumb = document.getElementById('certificateThumb');

    if (certObjectUrl) {
        URL.revokeObjectURL(certObjectUrl);
        certObjectUrl = null;
    }
    if (input) input.value = '';
    if (thumb) thumb.removeAttribute('src');
    if (preview) preview.classList.remove('visible', 'is-pdf');
    if (label) label.textContent = 'Upload Certificate';
}

function handleCertificateChange() {
    const input = document.getElementById('registerCertificate');
    const label = document.querySelector('label[for="registerCertificate"]');
    const preview = document.getElementById('certificatePreview');
    const thumb = document.getElementById('certificateThumb');
    const nameEl = document.getElementById('certificateName');
    const sizeEl = document.getElementById('certificateSize');

    const file = input.files && input.files[0];

    // Reset the preview but keep the chosen file
    if (certObjectUrl) {
        URL.revokeObjectURL(certObjectUrl);
        certObjectUrl = null;
    }
    if (thumb) thumb.removeAttribute('src');
    if (preview) preview.classList.remove('visible', 'is-pdf');

    if (!file) {
        if (label) label.textContent = 'Upload Certificate';
        return;
    }

    if (file.size > CERT_MAX_BYTES) {
        showError('That file is larger than 5 MB. Please choose a smaller one.');
        clearCertificate();
        return;
    }

    nameEl.textContent = file.name;
    nameEl.title = file.name;
    sizeEl.textContent = formatFileSize(file.size);
    label.textContent = 'Change certificate';

    if (/^image\//.test(file.type)) {
        certObjectUrl = URL.createObjectURL(file);
        thumb.src = certObjectUrl;
    } else {
        preview.classList.add('is-pdf'); // PDF: show the icon instead of a thumbnail
    }
    preview.classList.add('visible');
}

function initCertificatePreview() {
    const input = document.getElementById('registerCertificate');
    const removeBtn = document.getElementById('certificateRemove');
    const thumb = document.getElementById('certificateThumb');
    const lightbox = document.getElementById('certificateLightbox');

    if (!input) return;

    input.addEventListener('change', handleCertificateChange);

    if (removeBtn) {
        removeBtn.addEventListener('click', clearCertificate);
    }

    if (thumb && lightbox) {
        thumb.addEventListener('click', function () {
            if (!thumb.src) return;
            lightbox.querySelector('img').src = thumb.src;
            lightbox.classList.add('visible');
        });
        lightbox.addEventListener('click', function () {
            lightbox.classList.remove('visible');
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') lightbox.classList.remove('visible');
        });
    }
}

/* ------------------------------------------------------------------ */
/* Login / register                                                    */
/* ------------------------------------------------------------------ */

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
            // No session cache write here: sidebar.js is the one writer of those
            // three keys, and it owns the next page's fetch of /api/auth/me. This
            // used to write `username` and then clear it on the next line.
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
        // Neither checked - open the terms so they can be read first
        const modal = document.getElementById('termsModal');
        if (modal) {
            modal.style.display = 'flex';
            requestAnimationFrame(updateTermsProgress);
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
            // Same as login: the session cache belongs to sidebar.js alone.
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

/* ------------------------------------------------------------------ */
/* Page init                                                           */
/* ------------------------------------------------------------------ */

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

    // Terms & Conditions modal
    const openModalBtn = document.getElementById('openTermsModal');
    const modal = document.getElementById('termsModal');
    const scrollBox = document.getElementById('termsScrollBox');
    const closeBtn = document.getElementById('closeTermsBtn');

    const checkbox1 = document.getElementById('agreeTerms');
    const checkbox2 = document.getElementById('agreeInfo');

    if (openModalBtn && modal) {
        openModalBtn.addEventListener('click', function(e) {
            e.preventDefault();
            modal.style.display = 'flex';
            // Wait a frame so the box has its real size, then check if it
            // needs scrolling at all (short content unlocks immediately)
            requestAnimationFrame(updateTermsProgress);
        });
    }

    if (scrollBox) {
        scrollBox.addEventListener('scroll', updateTermsProgress, { passive: true });
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

    // Certificate upload preview
    initCertificatePreview();

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