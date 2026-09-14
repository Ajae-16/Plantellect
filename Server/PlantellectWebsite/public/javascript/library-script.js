function initSliderAutoplayPause() {
    const sliderWrapper = document.querySelector('.slider-wrapper');
    const sliderTrack = document.querySelector('.slider-track');
    if (!sliderWrapper || !sliderTrack) return;

    let resumeTimer = null;
    const RESUME_DELAY = 1500;

    function pauseAnimation() {
        sliderTrack.classList.add('paused');
        sliderWrapper.classList.add('paused');
    }

    function resumeAnimation() {
        if (resumeTimer) {
            clearTimeout(resumeTimer);
        }
        resumeTimer = setTimeout(function() {
            sliderTrack.classList.remove('paused');
            sliderWrapper.classList.remove('paused');
        }, RESUME_DELAY);
    }

    sliderWrapper.addEventListener('pointerdown', pauseAnimation, { passive: true });
    sliderWrapper.addEventListener('pointerup', resumeAnimation, { passive: true });
    sliderWrapper.addEventListener('pointerleave', resumeAnimation, { passive: true });
    sliderWrapper.addEventListener('pointercancel', resumeAnimation, { passive: true });
    sliderWrapper.addEventListener('touchstart', pauseAnimation, { passive: true });
    sliderWrapper.addEventListener('touchend', resumeAnimation, { passive: true });
    sliderWrapper.addEventListener('touchcancel', resumeAnimation, { passive: true });

    if (window.matchMedia('(hover: hover)').matches) {
        sliderWrapper.addEventListener('mouseenter', pauseAnimation);
        sliderWrapper.addEventListener('mouseleave', resumeAnimation);
    }
}

document.addEventListener('DOMContentLoaded', async function() {
    initSliderAutoplayPause();

    const user = await checkAuth();
    updateNavForAuthState(user);
});