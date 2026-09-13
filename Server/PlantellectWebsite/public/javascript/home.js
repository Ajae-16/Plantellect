async function openLibrary(event) {
    if (event) event.preventDefault();
    window.location.href = 'library.html';
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

function initCarousel() {
    const sliderWrapper = document.querySelector('.slider-wrapper');
    const sliderTrack = document.querySelector('.slider-track');
    if (!sliderWrapper || !sliderTrack) return;

    let isDragging = false;
    let startX = 0;
    let startScrollLeft = 0;
    let animationId = null;
    let autoScrollSpeed = 0.5; // pixels per frame
    let isAutoScrolling = true;

    function pauseAutoScroll() {
        isAutoScrolling = false;
        if (animationId) {
            cancelAnimationFrame(animationId);
            animationId = null;
        }
    }

    function resumeAutoScroll() {
        isAutoScrolling = true;
        startAutoScroll();
    }

    function startAutoScroll() {
        if (animationId) return;
        
        function animate() {
            if (!isAutoScrolling) {
                animationId = null;
                return;
            }
            const currentTransform = sliderTrack.style.transform;
            const currentX = currentTransform ? parseFloat(currentTransform.replace('translateX(', '').replace('px)', '')) : 0;
            sliderTrack.style.transform = `translateX(${currentX - autoScrollSpeed}px)`;
            animationId = requestAnimationFrame(animate);
        }
        animate();
    }

    // Set initial transform
    sliderTrack.style.transform = 'translateX(0)';

    // Mouse drag events
    sliderWrapper.addEventListener('mousedown', (e) => {
        isDragging = true;
        startX = e.clientX;
        const currentTransform = sliderTrack.style.transform;
        startScrollLeft = currentTransform ? parseFloat(currentTransform.replace('translateX(', '').replace('px)', '')) : 0;
        pauseAutoScroll();
        sliderWrapper.classList.add('dragging');
        e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        e.preventDefault();
        const deltaX = e.clientX - startX;
        sliderTrack.style.transform = `translateX(${startScrollLeft + deltaX}px)`;
    });

    window.addEventListener('mouseup', () => {
        if (!isDragging) return;
        isDragging = false;
        sliderWrapper.classList.remove('dragging');
        resumeAutoScroll();
    });

    // Touch events for mobile
    sliderWrapper.addEventListener('touchstart', (e) => {
        isDragging = true;
        startX = e.touches[0].clientX;
        const currentTransform = sliderTrack.style.transform;
        startScrollLeft = currentTransform ? parseFloat(currentTransform.replace('translateX(', '').replace('px)', '')) : 0;
        pauseAutoScroll();
    }, { passive: true });

    sliderWrapper.addEventListener('touchmove', (e) => {
        if (!isDragging) return;
        const deltaX = e.touches[0].clientX - startX;
        sliderTrack.style.transform = `translateX(${startScrollLeft + deltaX}px)`;
    }, { passive: true });

    sliderWrapper.addEventListener('touchend', () => {
        if (!isDragging) return;
        isDragging = false;
        resumeAutoScroll();
    }, { passive: true });

    // Pause on hover
    sliderWrapper.addEventListener('mouseenter', pauseAutoScroll);
    sliderWrapper.addEventListener('mouseleave', resumeAutoScroll);

    // Start auto-scroll
    startAutoScroll();

    // Handle window resize - reset if needed
    window.addEventListener('resize', () => {
        // The duplicated cards allow infinite scroll, no reset needed
    });
}

document.addEventListener('DOMContentLoaded', function () {
    checkAuth().then(function (user) {
        updateNavForAuthState(user);
    });
    initCarousel();
});