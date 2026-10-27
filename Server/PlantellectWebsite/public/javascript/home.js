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

    /** The plant's creation time in ms, or null when the API gave none (or an invalid one). */
    function dateOf(p) {
        const raw = p && (p.dateUploaded || p.createdAt);
        const t = raw ? new Date(raw).getTime() : NaN;
        return isNaN(t) ? null : t;
    }

    /** The plant's creation date as { iso, text }, or null when the API gave none. */
    function addedOn(p, detail) {
        const t = dateOf(p) !== null ? dateOf(p) : dateOf(detail);
        if (t === null) return null;
        const when = new Date(t);
        return {
            iso: when.toISOString(),
            text: when.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
        };
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
                const text = RichText.plain(d.uses || d.benefits);
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

    /**
     * Every plant row the API will give us. Page 1 is asked for with sort=newest,
     * but the 10 newest are decided HERE from the creation date, so the carousel
     * is right even when the server ignores sort (or sorts by something else).
     * The remaining pages are fetched in parallel; MAX_PAGES keeps it bounded.
     */
    const MAX_PAGES = 40;

    async function fetchPlantRows() {
        const first = await fetchJson(API_BASE + '?page=1&pageSize=' + LATEST_LIMIT + '&sort=newest');
        if (Array.isArray(first)) return first;

        let rows = first.plants || [];
        const pageSize = first.pageSize || rows.length || LATEST_LIMIT;
        const totalPages = Math.min(MAX_PAGES, Math.ceil((first.total || rows.length) / pageSize));

        if (totalPages > 1) {
            const pages = [];
            for (let page = 2; page <= totalPages; page++) pages.push(page);
            const rest = await Promise.all(pages.map(function (page) {
                return fetchJson(API_BASE + '?page=' + page + '&pageSize=' + pageSize + '&sort=newest')
                    .then(function (d) { return Array.isArray(d) ? d : (d.plants || []); })
                    .catch(function () { return []; });   // one failed page must not empty the carousel
            }));
            rest.forEach(function (list) { rows = rows.concat(list); });
        }
        return rows;
    }

    /** The 10 most recently CREATED plants, newest first. */
    async function fetchLatestPlants() {
        let plants = await fetchPlantRows();

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

        // Newest created first. A plant with no usable date sorts last. The sort is
        // stable, so plants created at the same moment keep the server's order.
        plants.sort(function (a, b) {
            const ta = dateOf(a);
            const tb = dateOf(b);
            return (tb === null ? -1 : tb) - (ta === null ? -1 : ta);
        });
        plants = plants.slice(0, LATEST_LIMIT);

        // A list row may not carry a photo, description or date; the detail route does.
        await Promise.all(plants.map(async function (p) {
            const id = plantIdOf(p);
            if (!id) return;
            if (imageUrlFrom(p, id) && blurbOf(p) && dateOf(p) !== null) return;
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
        // The type name is free text now ("Non-Herbal & Flower"). The placeholder art
        // and the per-type styling are keyed by a slug, so derive one from it.
        const rawType = p.type || (d && d.type) || '';
        const type = String(rawType).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        const typeLabel = p.typeLabel || (d && d.typeLabel) || rawType || TYPE_LABELS[type] || '';
        const toxicity = p.toxicityLevel || (d && d.toxicityLevel) || 'none';
        const image = imageUrlFrom(p, id) || imageUrlFrom(d, id);
        const blurb = blurbOf(p, d);
        const added = addedOn(p, d);

        const img = image
            ? '<img src="' + esc(image) + '" alt="' + esc(name) + '" decoding="async" draggable="false">'
            : '';

        const href = id ? 'plant-profile.html?plantId=' + encodeURIComponent(id) : '';
        const tag = href ? 'a' : 'article';
        const attrs = href ? ' href="' + esc(href) + '" draggable="false" aria-label="' + esc(name) + ' - view plant profile"' : '';

        // The outer .pc-float div is the ONLY element the scroll-float effect
        // moves. The card inside keeps its own transform (entrance animation,
        // hover tilt, lift) and the track keeps the horizontal slide, so the
        // three movements never overwrite each other.
        return '<div class="pc-float">' +
            '<' + tag + attrs + ' class="plant-card" data-type="' + esc(type) + '" style="--i:' + index + '">' +
                '<div class="pc-media">' + placeholderHtml(type) + img + '</div>' +
                '<div class="pc-shine"></div>' +
                (typeLabel ? '<span class="pc-type pc-type--badge">' + PlantBadge.html(typeLabel, toxicity) + '</span>' : '') +
                '<div class="pc-info">' +
                    '<h3>' + esc(name) + '</h3>' +
                    '<span class="pc-bar"></span>' +
                    (scientific ? '<p class="pc-sci">' + esc(scientific) + '</p>' : '') +
                    (added ? '<p class="pc-date"><span class="material-symbols-outlined" aria-hidden="true">calendar_today</span>' +
                        '<time datetime="' + esc(added.iso) + '">Added ' + esc(added.text) + '</time></p>' : '') +
                    (blurb ? '<div class="pc-more"><div><p class="pc-text">' + esc(blurb) + '</p></div></div>' : '') +
                '</div>' +
            '</' + tag + '>' +
        '</div>';
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
        let loopW = 0;           // width of one full set of cards (0 = not looping: everything fits)

        function measure() {
            maxShift = Math.max(0, track.offsetWidth - viewport.clientWidth);
        }

        /**
         * Infinite loop: the cards are followed by clones of themselves (one or more
         * full sets). When the track has moved exactly one set to the left, the view
         * looks identical to the start, so x jumps back by one set and the scroll
         * carries on 1 ... N, 1 ... N without a visible seam.
         * Clones are skipped when all the cards already fit on screen.
         */
        function buildLoop() {
            const originals = track.querySelectorAll('.pc-float:not(.is-clone)');
            const clones = track.querySelectorAll('.pc-float.is-clone');
            const n = originals.length;
            let sets = 0;
            loopW = 0;

            if (n) {
                const cs = window.getComputedStyle(track);
                const gap = parseFloat(cs.columnGap) || 0;
                const first = originals[0];
                const last = originals[n - 1];
                const realW = last.offsetLeft + last.offsetWidth - first.offsetLeft;
                // Loops whenever there are 2+ cards, even if they all fit on screen,
                // so the slider always keeps moving (a ticker with a few plants).
                if (n >= 2 && realW > 0) {
                    loopW = realW + gap;                                         // distance from card 1 to its clone
                    const view = Math.max(viewport.clientWidth, window.innerWidth || 0);
                    sets = Math.max(1, Math.ceil(view / loopW));                 // enough clones to fill the view
                }
            }

            if (clones.length === sets * n) return;   // already right: no DOM change (resize, reload)

            clones.forEach(function (c) { c.remove(); });
            for (let s = 0; s < sets; s++) {
                originals.forEach(function (el) {
                    const c = el.cloneNode(true);
                    c.classList.add('is-clone');
                    c.setAttribute('aria-hidden', 'true');                       // screen readers hear each plant once
                    c.querySelectorAll('a').forEach(function (a) { a.setAttribute('tabindex', '-1'); });
                    c.style.transform = '';
                    c.style.opacity = '';
                    track.appendChild(c);
                });
            }
        }

        function clamp(value) {
            if (loopW) return value;     // looping: no ends to clamp to; apply() wraps instead
            return Math.min(0, Math.max(value, -maxShift));
        }

        /** Keeps x inside one set. Anything tied to x (glide target, drag origin) moves with it. */
        function wrapX() {
            if (!loopW) return;
            while (x <= -loopW) { x += loopW; startX += loopW; if (glideTo !== null) glideTo += loopW; }
            while (x > 0)       { x -= loopW; startX -= loopW; if (glideTo !== null) glideTo -= loopW; }
        }

        function apply() {
            wrapX();
            track.style.transform = 'translate3d(' + x + 'px,0,0)';
            // Arrow buttons: hidden when everything fits, dimmed at either end (never in a loop)
            if (prevBtn) {
                if (loopW) {
                    prevBtn.classList.remove('is-off');
                    nextBtn.classList.remove('is-off');
                    prevBtn.hidden = nextBtn.hidden = false;
                } else {
                    prevBtn.classList.toggle('is-off', x >= -0.5);
                    nextBtn.classList.toggle('is-off', x <= -maxShift + 0.5);
                    prevBtn.hidden = nextBtn.hidden = !maxShift;
                }
            }
        }

        // Auto-scroll always moves toward the end. With enough cards to scroll it loops
        // forever (see buildLoop); with few cards that all fit, nothing moves.
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

            const heading = loopW ? -1 : dir;
            const dx = heading * BASE_SPEED * factor * dt + inertia * dt;
            inertia *= Math.pow(0.04, dt);
            if (Math.abs(inertia) < 5) inertia = 0;

            if (dx) {
                x += dx;
                if (!loopW) {
                    // Everything fits only barely: no loop, so turn around at the ends
                    if (x <= -maxShift) { x = -maxShift; dir = 1; inertia = 0; }
                    else if (x >= 0)    { x = 0;         dir = -1; inertia = 0; }
                }
                apply();     // in a loop, apply() wraps x back by one set
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
            buildLoop();
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
    /* Pinned scroll transition: tagline -> plant cards                    */
    /*                                                                     */
    /*   .pin-track  tall box; its extra height is the scroll distance     */
    /*   .pin-stage  position: sticky, so the hero stays put while the     */
    /*               page scrolls through the track                        */
    /*   .pin-cards  overlay holding the slider; this is the ONLY thing    */
    /*               the scroll progress moves as a whole                  */
    /*                                                                     */
    /* Nothing here intercepts wheel or touch input. The browser scrolls   */
    /* as usual; we only read scrollY and turn it into progress P (0..1):  */
    /*   P = 0   hero fully visible, cards below the screen                */
    /*   P = 1   cards in place, tagline gone, sticky released             */
    /* The same P drives the tagline fade, the layer rise and a staggered  */
    /* per-card rise, so scrolling back up simply runs it in reverse.      */
    /* Three layers still move independently (never share a transform):    */
    /*   .pin-cards (vertical, here) > .slider-track (horizontal,          */
    /*   carousel) and .pc-float (small per-card float, here) > .plant-card*/
    /*   (entrance, hover tilt, lift)                                      */
    /* ------------------------------------------------------------------ */

    function initPinned(carousel) {
        // Reduced motion: no pinning at all; the page keeps the plain layout
        if (!carousel || reduceMotion) return null;

        const trackEl = document.querySelector('.pin-track');
        const stage = trackEl && trackEl.querySelector('.pin-stage');
        const layer = stage && stage.querySelector('.pin-cards');
        const tagline = stage && stage.querySelector('.hero-content');
        const wrapper = carousel.wrapper;
        const viewport = wrapper.querySelector('.slider-viewport');
        const track = carousel.track;
        if (!layer || !viewport) return null;

        const CFG = {
            RISE_END: 0.9,        // cards are in place at 90% of the progress; the rest is a short hold
            FADE_START: 0.12,     // the tagline stays fully visible until here...
            FADE_LEN: 0.58,       // ...then fades out gradually over this much progress
            TAG_SHIFT: 28,        // px the tagline drifts up while it fades
            LAYER_RATE: 9,        // easing speed of the whole card layer (1/s)
            TAG_RATE: 7,          // easing speed of the tagline (1/s)
            STAGGER: 0.18,        // how late the latest card starts rising (share of progress)
            VEL_GAIN: 0.012,      // small extra lift while scrolling fast, px per px/s
            VEL_MAX: 14,
            ROT_GAIN: 0.0006,     // tiny sway, deg per px/s
            ROT_MAX: 1,
            VEL_SMOOTH: 10,
            EDGE_GAP: 14,         // px kept free inside the clip
            MAX_OFFSET: 56
        };

        let items = [];
        let pinStart = 0;         // scrollY at which the stage becomes pinned
        let travel = 1;           // scroll distance while pinned
        let startOff = 600;       // px the layer sits below its final place at P = 0
        let maxOff = 0;           // clip room for the per-card offsets
        let scrollY = window.pageYOffset || 0;
        let prevScrollY = scrollY;
        let vel = 0;
        let layerR = 0;           // eased rise progress of the layer
        let tagO = 1, tagY = 0;   // eased tagline opacity / shift
        let layerWY = NaN, layerWV = '';
        let tagWO = NaN, tagWY = NaN;
        let running = false;
        let lastTs = 0;
        let snap = true;          // jump straight to the target (first frame)

        function frac(n) { return n - Math.floor(n); }
        function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
        function clampTo(v, lim) { return Math.max(-lim, Math.min(lim, v)); }
        function smoothstep(t) { return t * t * (3 - 2 * t); }
        function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
        function easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }

        function measure() {
            // offsetTop ignores transforms, so the moving layer cannot skew it
            let top = 0;
            let el = trackEl;
            while (el) { top += el.offsetTop; el = el.offsetParent; }
            const pinTop = parseFloat(window.getComputedStyle(stage).top) || 0;   // = the sticky top bar height
            pinStart = top - pinTop;
            travel = Math.max(1, trackEl.offsetHeight - stage.offsetHeight);
            startOff = stage.clientHeight / 2 + wrapper.offsetHeight / 2 + 24;
            const sample = items.length ? items[0].el : null;
            const slack = sample ? (viewport.clientHeight - sample.offsetHeight) / 2 : 0;
            maxOff = Math.max(0, Math.min(CFG.MAX_OFFSET, slack - CFG.EDGE_GAP));
        }

        function collect() {
            const els = track.querySelectorAll('.pc-float');
            // Clones of the looping carousel reuse their original's parameters (index modulo the
            // number of real cards), so a card and its clone are always at the same height.
            const realCount = track.querySelectorAll('.pc-float:not(.is-clone)').length || 1;
            items = Array.prototype.map.call(els, function (el, n) {
                const i = n % realCount;
                return {
                    el: el,
                    depth: 0.7 + 0.6 * frac(i * 0.618034),
                    rate: 4 + 4 * frac(i * 0.381966 + 0.2),
                    delay: CFG.STAGGER * frac(i * 0.618034 + 0.3),
                    tilt: (i % 2 ? 1 : -1) * (0.4 + 0.6 * frac(i * 0.754878)),
                    y: 0, rot: 0, o: 1,
                    fresh: true,                       // new cards start at their target, no pop
                    wy: NaN, wr: NaN, wo: NaN
                };
            });
            measure();
            start();
        }

        function writeLayer() {
            const y = Math.round((1 - easeInOutCubic(layerR)) * startOff * 10) / 10;
            const vis = layerR < 0.002 ? 'hidden' : 'visible';   // off screen: not focusable, not clickable
            if (y !== layerWY) { layerWY = y; layer.style.transform = 'translate3d(0,' + y + 'px,0)'; }
            if (vis !== layerWV) { layerWV = vis; layer.style.visibility = vis; }
        }

        function writeTag() {
            if (!tagline) return;
            const o = Math.round(tagO * 1000) / 1000;
            const y = Math.round(tagY * 100) / 100;
            if (o === tagWO && y === tagWY) return;
            tagWO = o;
            tagWY = y;
            tagline.style.opacity = o >= 0.999 ? '' : String(o);
            tagline.style.translate = y ? '0 ' + y + 'px' : '';   // `translate` leaves any `transform` alone
        }

        function writeItem(it) {
            const y = Math.round(it.y * 100) / 100;
            const r = Math.round(it.rot * 100) / 100;
            const o = Math.round(it.o * 1000) / 1000;
            if (y !== it.wy || r !== it.wr) {
                it.wy = y;
                it.wr = r;
                it.el.style.transform = 'translate3d(0,' + y + 'px,0) rotate(' + r + 'deg)';
            }
            if (o !== it.wo) {
                it.wo = o;
                it.el.style.opacity = o >= 0.999 ? '' : String(o);
            }
        }

        function start() {
            if (running) return;
            running = true;
            lastTs = performance.now();
            requestAnimationFrame(frame);
        }

        function frame(ts) {
            const dt = Math.min(0.05, Math.max(0.001, (ts - lastTs) / 1000));
            lastTs = ts;

            const dy = scrollY - prevScrollY;
            prevScrollY = scrollY;
            vel += (dy / dt - vel) * (1 - Math.exp(-CFG.VEL_SMOOTH * dt));
            if (Math.abs(vel) < 1 && dy === 0) vel = 0;

            // Progress through the pinned distance, and the share of it used for rising
            const P = clamp01((scrollY - pinStart) / travel);
            const r = clamp01(P / CFG.RISE_END);
            let moving = vel !== 0;

            // 1. the card layer rises as a whole
            if (snap) {
                layerR = r;
            } else {
                layerR += (r - layerR) * (1 - Math.exp(-CFG.LAYER_RATE * dt));
                if (Math.abs(r - layerR) > 0.0005) moving = true;
            }
            writeLayer();

            // 2. the tagline stays fully visible first, then fades gradually
            const fe = smoothstep(clamp01((P - CFG.FADE_START) / CFG.FADE_LEN));
            const tagTO = 1 - fe;
            const tagTY = -fe * CFG.TAG_SHIFT;
            if (snap) {
                tagO = tagTO;
                tagY = tagTY;
            } else {
                const kt = 1 - Math.exp(-CFG.TAG_RATE * dt);
                tagO += (tagTO - tagO) * kt;
                tagY += (tagTY - tagY) * kt;
                if (Math.abs(tagTO - tagO) > 0.002 || Math.abs(tagTY - tagY) > 0.05) moving = true;
            }
            writeTag();

            // 3. each card rises a little later / faster than its neighbours
            const lift = -clampTo(vel * CFG.VEL_GAIN, CFG.VEL_MAX);
            const sway = clampTo(vel * CFG.ROT_GAIN, CFG.ROT_MAX);
            for (let i = 0; i < items.length; i++) {
                const it = items[i];
                const q = clamp01((r - it.delay) / (1 - it.delay));
                const arrive = (1 - easeOutCubic(q)) * maxOff * it.depth;
                const ty = clampTo(arrive + lift * it.depth, maxOff);
                const tr = sway * it.tilt;
                const to = smoothstep(clamp01(q * 2.5));

                if (snap || it.fresh) {
                    it.y = ty; it.rot = tr; it.o = to;
                    it.fresh = false;
                } else {
                    const k = 1 - Math.exp(-it.rate * dt);
                    it.y += (ty - it.y) * k;
                    it.rot += (tr - it.rot) * k;
                    it.o += (to - it.o) * k;
                    if (Math.abs(ty - it.y) > 0.05 || Math.abs(tr - it.rot) > 0.005 || Math.abs(to - it.o) > 0.005) moving = true;
                }
                it._ty = ty; it._tr = tr; it._to = to;
                writeItem(it);
            }
            snap = false;

            if (moving || dy !== 0) {
                requestAnimationFrame(frame);
                return;
            }

            // Settled: land exactly on the targets and stop the loop (no idle cost, no drift)
            layerR = r;
            tagO = tagTO;
            tagY = tagTY;
            writeLayer();
            writeTag();
            for (let j = 0; j < items.length; j++) {
                items[j].y = items[j]._ty || 0;
                items[j].rot = items[j]._tr || 0;
                items[j].o = items[j]._to === undefined ? 1 : items[j]._to;
                writeItem(items[j]);
            }
            running = false;
        }

        // Passive: only records the scroll position. The browser keeps full control of scrolling.
        window.addEventListener('scroll', function () {
            scrollY = window.pageYOffset || 0;
            start();
        }, { passive: true });

        let measureTimer = null;
        function scheduleMeasure() {
            clearTimeout(measureTimer);
            measureTimer = setTimeout(function () { measure(); start(); }, 150);
        }
        window.addEventListener('resize', scheduleMeasure);
        window.addEventListener('load', scheduleMeasure);
        if ('ResizeObserver' in window) {
            new ResizeObserver(scheduleMeasure).observe(document.body);
        }

        // Cards arrive later from the API (and again on "Try again"): pick them up.
        if ('MutationObserver' in window) {
            new MutationObserver(collect).observe(track, { childList: true });
        }

        // Turn the pinned layout on (CSS is keyed to .pin-active, so no JS / reduced
        // motion keeps the plain stacked layout), then re-measure the carousel,
        // because the slider's width just changed.
        trackEl.classList.add('pin-active');
        carousel.refresh();
        collect();
        return { refresh: collect };
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

        // (The old scroll-reveal of the slider box is not used: the pinned transition replaces it.)
        initPinned(carousel);       // before loading, so it sees the cards the moment they appear

        carousel.track.addEventListener('click', function (e) {
            if (e.target.closest('.plant-retry')) loadLatestPlants(carousel);
        });

        loadLatestPlants(carousel);
    });
})();