// Smart Plant Library routing using sessionStorage
function openLibrary(event) {
    event.preventDefault();
    const role = sessionStorage.getItem('userRole');
    const isRoot = window.location.pathname.endsWith('index.html') || window.location.pathname.endsWith('/');
    const prefix = isRoot ? 'Page/' : '';

    if (role === 'member') {
        window.location.href = prefix + 'library-login.html';  // Fully logged in
    } else if (role === 'guest') {
        window.location.href = prefix + 'library-guess.html';  // Logged in as guest
    } else {
        window.location.href = prefix + 'library-error.html';  // Visitor / Not signed in
    }
}

// Logout function
function logoutUser() {
    sessionStorage.removeItem('userRole');
    const isRoot = window.location.pathname.endsWith('index.html') || window.location.pathname.endsWith('/');
    window.location.href = isRoot ? 'index.html' : '../index.html';
}

// Automatically inject the restricted popup HTML and handle guest limitations
document.addEventListener("DOMContentLoaded", function() {
    // 1. Inject the popup HTML into the body dynamically
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

    // 2. Select the modal elements
    const modal = document.getElementById('restrictedModal');
    const closeBtn = document.getElementById('closeRestrictedModal');
    const loginBtn = document.getElementById('loginRedirectBtn');

    // Close modal on 'X' click
    if (closeBtn && modal) {
        closeBtn.addEventListener('click', function() {
            modal.style.display = 'none';
        });
    }

    // Redirect to login page on button click
    if (loginBtn) {
        loginBtn.addEventListener('click', function() {
            const isRoot = window.location.pathname.endsWith('index.html') || window.location.pathname.endsWith('/');
            window.location.href = isRoot ? 'login.html' : '../login.html';
        });
    }
});

// Function to control guest clicks on sidebar items
function handleRestrictedClick(event, featureName) {
    // Allow 'DISCOVERIES' and 'PLANTS' to work normally
    if (featureName === 'discoveries') {
        return;
    }
    // Block others and show the injected popup for Guest mode
    event.preventDefault();
    const modal = document.getElementById('restrictedModal');
    if (modal) {
        modal.style.display = 'flex';
    }
}