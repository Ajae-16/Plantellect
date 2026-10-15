async function openLibrary(event) {
    if (event) event.preventDefault();
    window.location.href = 'library.html';
}

// Everything below lives in an IIFE so its names cannot collide with other
// scripts that share this file's page (admin pages also load home.js).
(function () {
    'use strict';

    const API_BASE = '/api/plants';
    const LATEST_LIMIT = 10;
    const SKELETON_COUNT = 6;
    const SKELETON_TYPES = ['herbal', 'flower', 'non-herbal-flower'];

    const TYPE_ICONS = {
        'herbal': '🌿',
        'flower': '🌸',
        'non-herbal-flower': '🌳'
    };
    const TYPE_LABELS = {
        'herbal': 'Herbal',
        'flower': 'Flower',
        'non-herbal-flower': 'Non-Herbal & Flower'
    };

    const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    const canHover = !!(window.matchMedia && window.matchMedia('(hover: hover)').matches);

    function esc(str) {
        const div = document.createElement('div');
        div.textContent = String(str == null ? '' : str);
        return div.innerHTML;
    }

    /* ------------------------------------------------------------------ */
    /* Placeholder artwork (shown while a photo loads, or when there is    */
    /* none): a swaying plant on a coloured gradient with drifting leaves  */
    /* ------------------------------------------------------------------ */

    const ART = {
        sprig:
            '<svg class="ph-svg" viewBox="0 0 120 120" fill="currentColor" aria-hidden="true">' +
                '<path d="M60 114V34" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" fill="none"/>' +
                '<path d="M60 34c-2-14 6-24 18-26 2 14-4 24-18 26z"/>' +
                '<path d="M60 58c-14 0-24-8-26-20 14 0 24 6 26 20z" opacity=".88"/>' +
                '<path d="M60 74c14 0 24-8 26-20-14 0-24 6-26 20z" opacity=".88"/>' +
                '<path d="M60 94c-12 0-20-7-22-17 12 0 20 5 22 17z" opacity=".72"/>' +
                '<path d="M60 100c12 0 20-6 22-16-12 0-20 5-22 16z" opacity=".72"/>' +
            '</svg>',
        flower:
            '<svg class="ph-svg" viewBox="0 0 120 120" fill="currentColor" aria-hidden="true">' +
                '<path d="M60 114V56" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" fill="none"/>' +
                '<path d="M60 94c-13 0-21-6-23-17 13 0 21 5 23 17z"/>' +
                '<path d="M60 82c12 0 20-5 22-15-12 0-20 4-22 15z" opacity=".85"/>' +
                '<g transform="translate(60 38)">' +
                    '<ellipse cx="0" cy="-16" rx="9" ry="15"/>' +
                    '<ellipse cx="0" cy="-16" rx="9" ry="15" transform="rotate(72)"/>' +
                    '<ellipse cx="0" cy="-16" rx="9" ry="15" transform="rotate(144)"/>' +
                    '<ellipse cx="0" cy="-16" rx="9" ry="15" transform="rotate(216)"/>' +
                    '<ellipse cx="0" cy="-16" rx="9" ry="15" transform="rotate(288)"/>' +
                    '<circle r="9" style="fill:var(--ph-b)"/>' +
                '</g>' +
            '</svg>',
        tree:
            '<svg class="ph-svg" viewBox="0 0 120 120" fill="currentColor" aria-hidden="true">' +
                '<path d="M60 114V70" stroke="currentColor" stroke-width="7" stroke-linecap="round" fill="none"/>' +
                '<path d="M60 92L45 78M60 86L75 73" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" fill="none"/>' +
                '<circle cx="60" cy="44" r="26"/>' +
                '<circle cx="37" cy="62" r="19" opacity=".9"/>' +
                '<circle cx="83" cy="62" r="19" opacity=".9"/>' +
            '</svg>'
    };

    const BITS = [
        '--x:14%;--s:9px;--t:9s;--d:-1s;--dx:26px',
        '--x:32%;--s:6px;--t:11s;--d:-5s;--dx:-18px',
        '--x:58%;--s:10px;--t:8s;--d:-3s;--dx:20px',
        '--x:76%;--s:7px;--t:12s;--d:-8s;--dx:-24px',
        '--x:90%;--s:5px;--t:10s;--d:-6s;--dx:-10px'
    ];

    function artFor(type) {
        if (type === 'flower') return ART.flower;
        if (type === 'non-herbal-flower') return ART.tree;
        return ART.sprig;
    }

    function placeholderHtml(type) {
        return '<div class="pc-ph" aria-hidden="true">' +
            '<span class="ph-art">' + artFor(type) + '</span>' +
            BITS.map(function (b) { return '<span class="ph-bit" style="' + b + '"></span>'; }).join('') +
        '</div>';
    }

    /* ------------------------------------------------------------------ */
    /* Data                                                                */
    /* ------------------------------------------------------------------ */

    function plantIdOf(p) {
        return p && (p.id || p.plantId);
    }

    function dateOf(p) {
        const raw = p && (p.dateUploaded || p.createdAt || p.approvedAt || p.updatedAt);
        const t = raw ? new Date(raw).getTime() : NaN;
        return isNaN(t) ? null : t;
    }

    /** Finds a usable photo URL on either a list row or a detail response. */
    function imageUrlFrom(source, plantId) {
        if (!source) return null;

        const direct = source.imageUrl || source.thumbnailUrl || source.thumbnail ||
                       source.coverImage || source.primaryImageUrl;
        if (typeof direct === 'string' && direct) return direct;

        const first = source.image || (Array.isArray(source.images) && source.images[0]);
        if (!first) {
            return source.primaryImageId
                ? API_BASE + '/' + encodeURIComponent(plantId) + '/images/' + encodeURIComponent(source.primaryImageId)
                : null;
        }
        if (typeof first === 'string') return first;
        if (first.imageUrl) return first.imageUrl;
        if (first.url) return first.url;

        const imageId = first.id || first.imageId;
        return imageId
            ? API_BASE + '/' + encodeURIComponent(plantId) + '/images/' + encodeURIComponent(imageId)
            : null;
    }

    /** A short blurb: a plain description, or the "uses" / "benefits" text. */
    function blurbOf() {
        for (let i = 0; i < arguments.length; i++) {
            const source = arguments[i];
            if (!source) continue;
            const d = source.description;
            if (typeof d === 'string' && d.trim()) return d.trim();
            if (d && typeof d === 'object') {
                const text = d.uses || d.benefits;
                if (text && String(text).trim()) return String(text).trim();
            }
        }
        return '';
    }

    async function fetchJson(url) {
        const response = await fetch(url);
        if (!response.ok) throw new Error('Request failed with ' + response.status);
        return response.json();
    }

    /** The newest plants, at most LATEST_LIMIT, newest first. */
    async function fetchLatestPlants() {
        const data = await fetchJson(API_BASE + '?page=1&pageSize=' + LATEST_LIMIT + '&sort=newest');
        let plants = Array.isArray(data) ? data : (data.plants || []);

        // If the rows carry a date, make sure newest really is first.
        if (plants.some(function (p) { return dateOf(p) !== null; })) {
            plants = plants.slice().sort(function (a, b) { return (dateOf(b) || 0) - (dateOf(a) || 0); });
        }
        // Never show the same plant twice (same id, or same scientific name)
        const seen = new Set();
        plants = plants.filter(function (p) {
            const keys = [];
            const id = plantIdOf(p);
            if (id) keys.push('id:' + id);
            if (p.scientificName) keys.push('sci:' + String(p.scientificName).trim().toLowerCase());
            if (keys.some(function (k) { return seen.has(k); })) return false;
            keys.forEach(function (k) { seen.add(k); });
            return true;
        });
        plants = plants.slice(0, LATEST_LIMIT);

        // A list row may not carry a photo or description; the detail route does.
        await Promise.all(plants.map(async function (p) {
            const id = plantIdOf(p);
            if (!id) return;
            if (imageUrlFrom(p, id) && blurbOf(p)) return;
            try {
                p._detail = await fetchJson(API_BASE + '/' + encodeURIComponent(id));
            } catch (err) {
                // Keep the card; it just falls back to the artwork and no blurb.
            }
        }));

        return plants;
    }

    /* ------------------------------------------------------------------ */
    /* Rendering                                                           */
    /* ------------------------------------------------------------------ */

    function skeletonHtml() {
        let html = '';
        for (let i = 0; i < SKELETON_COUNT; i++) {
            const type = SKELETON_TYPES[i % SKELETON_TYPES.length];
            html += '<div class="plant-card is-skeleton" data-type="' + type + '" aria-hidden="true">' +
                '<div class="pc-media">' + placeholderHtml(type) + '</div>' +
                '<div class="pc-info">' +
                    '<span class="sk-line sk-title"></span>' +
                    '<span class="sk-line sk-short"></span>' +
                '</div>' +
            '</div>';
        }
        return html;
    }

    function cardHtml(p, index) {
        const id = plantIdOf(p);
        const d = p._detail || null;

        const name = p.name || p.commonName || (d && (d.name || d.commonName)) || 'Unnamed plant';
        const scientific = p.scientificName || (d && d.scientificName) || '';
        const type = p.type || (d && d.type) || '';
        const typeLabel = p.typeLabel || (d && d.typeLabel) || TYPE_LABELS[type] || '';
        const icon = TYPE_ICONS[type] || '🌱';
        const image = imageUrlFrom(p, id) || imageUrlFrom(d, id);
        const blurb = blurbOf(p, d);

        const img = image
            ? '<img src="' + esc(image) + '" alt="' + esc(name) + '" decoding="async" draggable="false">'
            : '';

        const href = id ? 'plant-profile.html?plantId=' + encodeURIComponent(id) : '';
        const tag = href ? 'a' : 'article';
        const attrs = href ? ' href="' + esc(href) + '" draggable="false" aria-label="' + esc(name) + ' - view plant profile"' : '';

        return '<' + tag + attrs + ' class="plant-card" data-type="' + esc(type) + '" style="--i:' + index + '">' +
            '<div class="pc-media">' + placeholderHtml(type) + img + '</div>' +
            '<div class="pc-shine"></div>' +
            (typeLabel ? '<span class="pc-type">' + icon + ' ' + esc(typeLabel) + '</span>' : '') +
            (index === 0 ? '<span class="pc-new">Newest</span>' : '') +
            '<div class="pc-info">' +
                '<h3>' + esc(name) + '</h3>' +
                '<span class="pc-bar"></span>' +
                (scientific ? '<p class="pc-sci">' + esc(scientific) + '</p>' : '') +
                (blurb ? '<div class="pc-more"><div><p class="pc-text">' + esc(blurb) + '</p></div></div>' : '') +
            '</div>' +
        '</' + tag + '>';
    }

    function messageHtml(text, withRetry) {
        return '<div class="plant-empty">' +
            '<span class="plant-empty-icon" aria-hidden="true">🌱</span>' +
            '<p>' + esc(text) + '</p>' +
            (withRetry ? '<button type="button" class="plant-retry">Try again</button>' : '') +
        '</div>';
    }

    /** Photos that finished loading before the load listener existed (cache) */
    function markLoadedImages(track) {
        track.querySelectorAll('.pc-media img').forEach(function (img) {
            if (img.complete && img.naturalWidth > 0) {
                const media = img.closest('.pc-media');
                if (media) media.classList.add('has-img');
            }
        });
    }

    /* ------------------------------------------------------------------ */
    /* Carousel: auto-scroll (back and forth), drag + momentum, click-to-open */
    /* ------------------------------------------------------------------ */

    function initCarousel() {
        const wrapper = document.querySelector('.slider-wrapper');
        const viewport = wrapper && wrapper.querySelector('.slider-viewport');
        const track = viewport && viewport.querySelector('.slider-track');
        if (!wrapper || !viewport || !track) return null;

        const pauseBtn = wrapper.querySelector('.slider-pause');

        // Auto-scroll always runs; reduced motion only makes it slower.
        const BASE_SPEED = reduceMotion ? 16 : 42;   // px per second
        const HOVER_FACTOR = 0.3;                    // hovering slows down, it does not stop
        const TAP_SLOP = 6;                          // px of movement that still counts as a click

        let x = 0;               // current translateX of the track (0 = start, -maxShift = end)
        let maxShift = 0;        // how far the track can move (0 = everything fits, no scrolling)
        let dir = -1;            // auto-scroll direction: -1 = toward the end, 1 = back to the start
        let factor = 1;          // current speed multiplier (eased)
        let inertia = 0;         // px/s left over from a flick
        let lastTs = performance.now();
        let isDragging = false;
        let isHovering = false;
        let userPaused = false;
        let inView = true;
        let startPointer = 0;
        let startX = 0;
        let lastPointer = 0;
        let lastMoveTime = 0;
        let velocity = 0;
        let downCard = null;     // the card the pointer went down on (for click-to-open)
        let moved = 0;           // furthest the pointer travelled during this press
        let glideTo = null;      // target x of an arrow-button / keyboard glide (null = none)

        function measure() {
            maxShift = Math.max(0, track.offsetWidth - viewport.clientWidth);
        }

        function clamp(value) {
            return Math.min(0, Math.max(value, -maxShift));
        }

        function apply() {
            track.style.transform = 'translate3d(' + x + 'px,0,0)';
            // Arrow buttons: hidden when everything fits, dimmed at either end
            if (prevBtn) {
                prevBtn.classList.toggle('is-off', x >= -0.5);
                nextBtn.classList.toggle('is-off', x <= -maxShift + 0.5);
                prevBtn.hidden = nextBtn.hidden = !maxShift;
            }
        }

        // No cloned cards: each plant appears once. At the end the slider turns
        // around and scrolls back instead of looping the same plants again.
        function tick(ts) {
            requestAnimationFrame(tick);
            const dt = Math.min(0.05, (ts - lastTs) / 1000 || 0);
            lastTs = ts;
            if (!inView || !maxShift || isDragging) return;
            if (wrapper.getAttribute('aria-busy') === 'true') return;

            // A glide (arrow button / keyboard) takes over until it arrives
            if (glideTo !== null) {
                x += (glideTo - x) * Math.min(1, dt * 9);
                if (Math.abs(glideTo - x) < 0.5) { x = glideTo; glideTo = null; }
                apply();
                return;
            }

            const target = userPaused ? 0 : (isHovering ? HOVER_FACTOR : 1);
            factor += (target - factor) * Math.min(1, dt * 6);

            const dx = dir * BASE_SPEED * factor * dt + inertia * dt;
            inertia *= Math.pow(0.04, dt);
            if (Math.abs(inertia) < 5) inertia = 0;

            if (dx) {
                x += dx;
                if (x <= -maxShift) { x = -maxShift; dir = 1; inertia = 0; }
                else if (x >= 0)    { x = 0;         dir = -1; inertia = 0; }
                apply();
            }
        }

        function setPaused(paused) {
            userPaused = paused;
            if (!pauseBtn) return;
            pauseBtn.setAttribute('aria-pressed', String(paused));
            pauseBtn.setAttribute('aria-label', paused ? 'Resume auto-scroll' : 'Pause auto-scroll');
            const icon = pauseBtn.querySelector('.material-symbols-outlined');
            if (icon) icon.textContent = paused ? 'play_arrow' : 'pause';
        }

        if (pauseBtn) {
            pauseBtn.addEventListener('click', function () { setPaused(!userPaused); });
        }

        /** Call after the cards change or the size changes. */
        function refresh() {
            measure();
            const cards = track.querySelectorAll('.plant-card:not(.is-skeleton)');
            wrapper.classList.toggle('is-empty', cards.length === 0);
            x = clamp(x);
            apply();
        }

        function openCard(card, e) {
            const href = card.getAttribute('href');
            if (!href) return;
            if (e && (e.ctrlKey || e.metaKey)) window.open(href, '_blank', 'noopener');
            else window.location.href = href;
        }

        /* ----- Manual scrolling: arrow buttons, keyboard, trackpad / wheel ----- */

        function makeArrow(side) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'slider-arrow slider-arrow-' + side;
            b.setAttribute('aria-label', side === 'prev' ? 'Scroll left' : 'Scroll right');
            b.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">' +
                (side === 'prev' ? 'chevron_left' : 'chevron_right') + '</span>';
            wrapper.appendChild(b);
            return b;
        }
        const prevBtn = makeArrow('prev');
        const nextBtn = makeArrow('next');

        /** Glides about 80% of the visible width: sign -1 = toward the end, 1 = back. */
        function glideBy(sign) {
            if (!maxShift) return;
            inertia = 0;
            dir = sign;
            const step = Math.max(200, viewport.clientWidth * 0.8);
            glideTo = clamp((glideTo !== null ? glideTo : x) + sign * step);
        }

        prevBtn.addEventListener('click', function () { glideBy(1); });
        nextBtn.addEventListener('click', function () { glideBy(-1); });

        wrapper.addEventListener('keydown', function (e) {
            if (e.key === 'ArrowLeft')  { e.preventDefault(); glideBy(1); }
            if (e.key === 'ArrowRight') { e.preventDefault(); glideBy(-1); }
        });

        // Trackpad two-finger swipe, tilt wheels, or Shift + mouse wheel.
        // A plain vertical wheel is left alone so the page still scrolls.
        wrapper.addEventListener('wheel', function (e) {
            if (!maxShift) return;
            const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY);
            const amount = horizontal ? e.deltaX : (e.shiftKey ? e.deltaY : 0);
            if (!amount) return;
            e.preventDefault();
            glideTo = null;
            inertia = 0;
            dir = amount > 0 ? -1 : 1;
            x = clamp(x - amount);
            apply();
        }, { passive: false });

        /* ----- Drag (mouse, touch and pen) with momentum ----- */

        wrapper.addEventListener('pointerdown', function (e) {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            if (e.target.closest('.slider-pause, .slider-arrow')) return;
            glideTo = null;
            isDragging = true;
            downCard = e.target.closest('a.plant-card');
            moved = 0;
            startPointer = e.clientX;
            lastPointer = e.clientX;
            startX = x;
            velocity = 0;
            inertia = 0;
            lastMoveTime = performance.now();
            wrapper.classList.add('dragging');
            try { wrapper.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        });

        wrapper.addEventListener('pointermove', function (e) {
            if (!isDragging) return;
            const now = performance.now();
            const dt = (now - lastMoveTime) / 1000;
            if (dt > 0) {
                const instant = (e.clientX - lastPointer) / dt;
                velocity = velocity * 0.7 + instant * 0.3;
            }
            lastPointer = e.clientX;
            lastMoveTime = now;
            moved = Math.max(moved, Math.abs(e.clientX - startPointer));
            x = clamp(startX + (e.clientX - startPointer));
            apply();
        });

        function endDrag(e, cancelled) {
            if (!isDragging) return;
            isDragging = false;
            wrapper.classList.remove('dragging');

            // A press that barely moved is a click: open that plant's profile.
            // (Pointer capture sends the click event to the wrapper, so the
            // card is remembered from pointerdown instead.)
            if (!cancelled && downCard && moved < TAP_SLOP) {
                openCard(downCard, e);
                downCard = null;
                return;
            }
            downCard = null;

            // A held-still release is not a flick
            if (performance.now() - lastMoveTime > 90) velocity = 0;
            inertia = Math.max(-2500, Math.min(2500, velocity));
            if (inertia) dir = inertia < 0 ? -1 : 1;
        }
        wrapper.addEventListener('pointerup', function (e) { endDrag(e, false); });
        wrapper.addEventListener('pointercancel', function (e) { endDrag(e, true); });

        // The card is a real link (keyboard, middle-click, status bar), but the
        // pointer handler above does the opening, so block the native follow.
        // Enter on a focused card is a click with detail 0: open it here.
        track.addEventListener('click', function (e) {
            const card = e.target.closest('a.plant-card');
            if (!card) return;
            e.preventDefault();
            if (e.detail === 0) openCard(card, e);
        });

        // Focusing a card with Tab must not scroll the clipped viewport sideways.
        viewport.addEventListener('scroll', function () { viewport.scrollLeft = 0; });

        wrapper.addEventListener('pointerenter', function (e) {
            if (e.pointerType === 'mouse') isHovering = true;
        });
        wrapper.addEventListener('pointerleave', function (e) {
            if (e.pointerType === 'mouse') isHovering = false;
        });

        /* ----- Card tilt + light sheen that follows the cursor ----- */

        if (canHover && !reduceMotion) {
            track.addEventListener('mousemove', function (e) {
                if (isDragging) return;
                const card = e.target.closest('.plant-card');
                if (!card || card.classList.contains('is-skeleton')) return;
                const r = card.getBoundingClientRect();
                const px = (e.clientX - r.left) / r.width;
                const py = (e.clientY - r.top) / r.height;
                card.style.setProperty('--mx', (px * 100).toFixed(1) + '%');
                card.style.setProperty('--my', (py * 100).toFixed(1) + '%');
                card.style.setProperty('--ry', ((px - 0.5) * 10).toFixed(2) + 'deg');
                card.style.setProperty('--rx', ((0.5 - py) * 8).toFixed(2) + 'deg');
            });

            track.addEventListener('mouseout', function (e) {
                const card = e.target.closest('.plant-card');
                if (!card || card.contains(e.relatedTarget)) return;
                card.style.removeProperty('--mx');
                card.style.removeProperty('--my');
                card.style.removeProperty('--rx');
                card.style.removeProperty('--ry');
            });
        }

        /* ----- Photos: fade in over the artwork, fall back to it on error ----- */

        track.addEventListener('load', function (e) {
            const img = e.target;
            if (!img || img.tagName !== 'IMG') return;
            const media = img.closest('.pc-media');
            if (media) media.classList.add('has-img');
        }, true);

        track.addEventListener('error', function (e) {
            const img = e.target;
            if (img && img.tagName === 'IMG') img.remove();
        }, true);

        /* ----- Only animate while the slider is on screen ----- */

        if ('IntersectionObserver' in window) {
            new IntersectionObserver(function (entries) {
                inView = entries[0].isIntersecting;
            }, { threshold: 0 }).observe(wrapper);
        }

        let resizeTimer = null;
        window.addEventListener('resize', function () {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(refresh, 200);
        });

        requestAnimationFrame(tick);

        return { refresh: refresh, wrapper: wrapper, track: track };
    }

    /* ------------------------------------------------------------------ */
    /* Scroll reveal for the slider box (the box rises and fades in when   */
    /* it scrolls into view; the cards inside are not touched)             */
    /* ------------------------------------------------------------------ */

    function initReveal(wrapper) {
        if (!wrapper) return;

        // No observer support: just leave the box visible.
        if (!('IntersectionObserver' in window)) return;

        wrapper.classList.add('reveal');

        const observer = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (!entry.isIntersecting) return;
                wrapper.classList.add('is-visible');
                observer.unobserve(wrapper);          // play once
            });
        }, { threshold: 0.15 });

        observer.observe(wrapper);
    }

    /* ------------------------------------------------------------------ */
    /* Wiring                                                              */
    /* ------------------------------------------------------------------ */

    async function loadLatestPlants(carousel) {
        const track = carousel.track;
        const wrapper = carousel.wrapper;

        wrapper.setAttribute('aria-busy', 'true');
        track.innerHTML = skeletonHtml();
        carousel.refresh();

        try {
            const plants = await fetchLatestPlants();
            track.innerHTML = plants.length === 0
                ? messageHtml('No plants have been added yet. Check back soon!', false)
                : plants.map(cardHtml).join('');
        } catch (err) {
            console.error('Load latest plants error:', err);
            track.innerHTML = messageHtml('We couldn\u2019t load the latest plants.', true);
        } finally {
            wrapper.setAttribute('aria-busy', 'false');
            markLoadedImages(track);
            carousel.refresh();
        }
    }

    // The header's SIGN OUT / SIGN IN is rendered by sidebar.js on every page.
    // A page has no auth duty of its own; its only job here is the carousel.
    document.addEventListener('DOMContentLoaded', function () {
        const carousel = initCarousel();
        if (!carousel) return;

        initReveal(carousel.wrapper);

        carousel.track.addEventListener('click', function (e) {
            if (e.target.closest('.plant-retry')) loadLatestPlants(carousel);
        });

        loadLatestPlants(carousel);
    });
})();