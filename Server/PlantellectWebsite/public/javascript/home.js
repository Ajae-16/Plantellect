async function openLibrary(event) {
    if (event) event.preventDefault();
    window.location.href = 'library.html';
}

function initCarousel() {
    const sliderWrapper = document.querySelector('.slider-wrapper');
    const sliderTrack = document.querySelector('.slider-track');
    if (!sliderWrapper || !sliderTrack) return;

    let isDragging = false;
    let startX = 0;
    let startScrollLeft = 0;
    let animationId = null;
    let autoScrollSpeed = 0.5;
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

    sliderTrack.style.transform = 'translateX(0)';

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

    sliderWrapper.addEventListener('mouseenter', pauseAutoScroll);
    sliderWrapper.addEventListener('mouseleave', resumeAutoScroll);

    startAutoScroll();

    window.addEventListener('resize', () => {
    });
}

// The header's SIGN OUT / SIGN IN is rendered by sidebar.js on every page.
// A page has no auth duty of its own; its only job here is the carousel.
document.addEventListener('DOMContentLoaded', function () {
    initCarousel();
});