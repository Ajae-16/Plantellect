/**
 * Plant profile page.
 *
 * Renders a single plant from GET /api/plants/:plantId. The id comes from the
 * ?plantId query parameter, which is what the library grid and the scan results
 * link to.
 *
 * Theme and the back button are handled by sidebar.js. Identity comes from
 * window.plantAuth (sidebar.js): ONE /api/auth/me request per page, shared by
 * the contributor links and the Contribute button.
 */

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str == null ? '' : str);
    return div.innerHTML;
}

/**
 * Renders a botanist's text with its paragraphs, bullets and emphasis (richtext.js).
 * An empty value reads "No information recorded yet."
 */
function renderList(el, text) {
    RichText.render(el, text, 'No information recorded yet.');
}

/** Who wrote a description: the full name, falling back to the username. */
function authorLabel(d) {
    return (d && d.author && d.author.name) || 'A botanist';
}

/**
 * The boxes for every description that is not the primary one. Each botanist has a colour
 * (RichText.contributorClass cycles through eight, so the ninth reuses the first). A box shows
 * only what that botanist actually recorded: no empty headings.
 */
function renderOtherDescriptions(others, firstColourIndex) {
    const section = document.getElementById('moreDetails');
    const list = document.getElementById('contribList');
    if (!section || !list) return;
    if (!others.length) { section.hidden = true; list.innerHTML = ''; return; }

    list.innerHTML = others.map((d, i) => {
        const cls = RichText.contributorClass(firstColourIndex + i);
        const looks = describeParts(d.parts);
        const blocks = [];
        if (looks) blocks.push(['What it looks like', `<div class="rt"><p>${escapeHtml(looks).replace(/\n/g, '<br>')}</p></div>`]);
        if (d.uses) blocks.push(['Common uses', `<div class="rt">${RichText.html(d.uses)}</div>`]);
        if (d.benefits) blocks.push(['Health benefits', `<div class="rt">${RichText.html(d.benefits)}</div>`]);
        if (d.harmful) blocks.push(['Things to watch out for', `<div class="rt">${RichText.html(d.harmful)}</div>`]);
        if (!blocks.length) return '';
        const spec = d.author && d.author.specialization
            ? `<span class="contrib-sub">${escapeHtml(d.author.specialization)}</span>` : '';
        return `<article class="contrib-box ${cls}">
            <div class="contrib-head">
                <span class="contrib-dot" aria-hidden="true"></span>
                <span class="contrib-name">${escapeHtml(authorLabel(d))}</span>${spec}
            </div>
            ${blocks.map(([title, body]) => `<div class="contrib-section"><h5>${title}</h5>${body}</div>`).join('')}
        </article>`;
    }).join('');
    section.hidden = !list.innerHTML.trim();
}

function formatRange(min, max, note, unit) {
    if (min == null && max == null) return note || '';
    if (min != null && max != null && min !== max) {
        return `${min}–${max}${unit}${note ? ' (' + note + ')' : ''}`;
    }
    const only = min != null ? min : max;
    return `${only}${unit}${note ? ' — ' + note : ''}`;
}

/**
 * "What it looks like" is built from the botanist's measurements. Lines are
 * joined with \n; #plantDescription uses white-space: pre-line to show them.
 */
function describeParts(parts) {
    if (!parts) return '';
    const lines = [];
    const height = formatRange(parts.heightMinCm, parts.heightMaxCm, parts.heightNote, ' cm');
    const width = formatRange(parts.widthMinCm, parts.widthMaxCm, parts.widthNote, ' cm');
    if (height) lines.push(`Height: ${height}`);
    if (width) lines.push(`Width: ${width}`);
    if (parts.color) lines.push(`Color: ${parts.color}`);
    if (parts.shape) lines.push(`Shape: ${parts.shape}`);
    if (parts.texture) lines.push(`Texture: ${parts.texture}`);
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Visitor identity (display only: the server enforces every real rule)
// ---------------------------------------------------------------------------

/** Resolves once with the signed-in user ({ roles, permissions, ... }) or null. */
let viewerPromise = null;
function getViewer() {
    if (!viewerPromise) {
        viewerPromise = (async () => {
            try {
                if (window.plantAuth && window.plantAuth.ready) return await window.plantAuth.ready;
            } catch (err) { /* treated as signed out */ }
            return null;
        })();
    }
    return viewerPromise;
}

function isAdminViewer(viewer) {
    const roles = (viewer && viewer.roles) || [];
    return roles.includes('admin') || roles.includes('superadmin');
}

const ADMIN_LABELS = { admin: 'Administrator', superadmin: 'Superadministrator' };

/**
 * 'botanist' | 'admin' | null (plain text). The role comes from the server
 * (person.role, or profileType / isBotanist from older responses), never from
 * a name, badge or label.
 */
function personKind(person) {
    if (!person) return null;
    if (person.role === 'botanist') return 'botanist';
    if (person.role === 'admin' || person.role === 'superadmin') return 'admin';
    const type = person.profileType || (person.isBotanist ? 'botanist' : null);
    return type === 'botanist' || type === 'admin' ? type : null;
}

// ---------------------------------------------------------------------------
// The three attribution rows. Each has its OWN link rule; they are not shared.
// ---------------------------------------------------------------------------

const SECTION_RECORDED = 'recordedBy';
const SECTION_REVIEWED = 'reviewedBy';
const SECTION_REPORTED = 'reportedBy';

/**
 * Where a person's name links for THIS visitor in THIS section, or null for
 * plain text. Anything not listed here is plain text (fails closed).
 *
 *   recordedBy   botanist             -> everyone, guests included
 *                admin / superadmin   -> admins and superadmins only
 *   reviewedBy   admin / superadmin   -> admins and superadmins only
 *                (anyone else named here is plain text)
 *   reportedBy   never linked, for any viewer, until a future update
 *
 * Administrators are served by botanist-profile.html too (it renders the
 * administrator layout from profile.role), so there is no second profile page.
 * This is display only: GET /api/botanists/:accountId enforces the same rule.
 */
function profileHref(person, viewer, section) {
    if (section === SECTION_REPORTED) return null;
    if (!person || !person.accountId) return null;

    const kind = personKind(person);
    const url = `botanist-profile.html?accountId=${encodeURIComponent(person.accountId)}`;

    if (section === SECTION_RECORDED) {
        if (kind === 'botanist') return url;
        if (kind === 'admin' && isAdminViewer(viewer)) return url;
        return null;
    }
    if (section === SECTION_REVIEWED) {
        if (kind === 'admin' && isAdminViewer(viewer)) return url;
        return null;
    }
    return null;
}

/**
 * The server may still send a row as one joined string, e.g.
 * "Ana Cruz, Ben Lee +2 more; Carla Diaz". Split it so each name is its own
 * entry. Strings carry no account, so they render as plain text.
 */
function splitNameString(value) {
    return String(value)
        .split(/\s*[;,]\s*/)
        .map(s => s.trim())
        .filter(Boolean)
        .map(name => ({ name }));
}

/**
 * Renders a list of people into a "Recorded by / Reviewed by / Reported by" row.
 * `section` picks the link rule (see profileHref); badges are the same in all:
 *  - botanist:           Verified Botanist badge
 *  - admin / superadmin: role tag, NO badge
 *  - user / system:      plain text
 * A name is a link only when profileHref() says so; otherwise it is a <span>
 * with no href, handler or pointer. Links are underlined (see .person-link in
 * public-theme.css), so an underlined name is always clickable and a plain one
 * never is. An empty list hides the whole row.
 */
function renderPeople(rowId, listId, people, viewer, section) {
    const row = document.getElementById(rowId);
    const list = document.getElementById(listId);
    if (!row || !list) return;

    let normalized;
    if (typeof people === 'string') {
        normalized = splitNameString(people);
    } else {
        normalized = (Array.isArray(people) ? people : people ? [people] : [])
            .flatMap(p => (typeof p === 'string' ? splitNameString(p) : [p]))
            .filter(p => p && p.name);
    }

    if (normalized.length === 0) {
        row.hidden = true;
        list.innerHTML = '';
        return;
    }

    list.innerHTML = normalized.map(p => {
        const name = escapeHtml(p.name);
        const kind = personKind(p);
        const href = profileHref(p, viewer, section);
        const badge = kind === 'botanist'
            ? '<span class="verified-badge"><span class="material-symbols-outlined" aria-hidden="true">check_circle</span>Verified Botanist</span>'
            : '';
        const roleTag = kind === 'admin' && ADMIN_LABELS[p.role]
            ? `<span class="role-tag">${ADMIN_LABELS[p.role]}</span>`
            : '';
        const label = href
            ? `<a class="person-link" href="${href}" title="View ${name}'s profile">${name}</a>`
            : `<span class="person-name">${name}</span>`;
        return `<span class="person">${label}${badge}${roleTag}</span>`;
    }).join('');
    row.hidden = false;
}

// ---------------------------------------------------------------------------
// Photo lightbox: zoom (wheel, pinch, double-click, buttons), pan, fullscreen.
// Built on first use, so plant-profile.html needs no extra markup.
// ---------------------------------------------------------------------------

const Lightbox = (() => {
    const MIN_SCALE = 1;
    const MAX_SCALE = 6;

    let root, stage, img, fsBtn, closeBtn, zoomLabel;
    let scale = 1, tx = 0, ty = 0;
    let lastFocus = null;
    const pointers = new Map();
    let dragOrigin = null;
    let pinchOrigin = null;

    function icon(name) {
        return `<span class="material-symbols-outlined" aria-hidden="true">${name}</span>`;
    }

    function build() {
        if (root) return;
        root = document.createElement('div');
        root.className = 'lightbox';
        root.hidden = true;
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-modal', 'true');
        root.setAttribute('aria-label', 'Plant photo viewer');
        root.innerHTML = `
            <div class="lightbox__stage">
                <img class="lightbox__img" alt="" draggable="false">
            </div>
            <div class="lightbox__bar">
                <span class="lightbox__zoom" aria-live="polite">100%</span>
                <button type="button" class="lightbox__btn" data-act="out" title="Zoom out" aria-label="Zoom out">${icon('zoom_out')}</button>
                <button type="button" class="lightbox__btn" data-act="in" title="Zoom in" aria-label="Zoom in">${icon('zoom_in')}</button>
                <button type="button" class="lightbox__btn" data-act="reset" title="Reset" aria-label="Reset zoom">${icon('fit_screen')}</button>
                <button type="button" class="lightbox__btn" data-act="fs" title="Full screen" aria-label="Full screen">${icon('fullscreen')}</button>
                <button type="button" class="lightbox__btn" data-act="close" title="Close" aria-label="Close">${icon('close')}</button>
            </div>`;
        document.body.appendChild(root);

        stage = root.querySelector('.lightbox__stage');
        img = root.querySelector('.lightbox__img');
        fsBtn = root.querySelector('[data-act="fs"]');
        closeBtn = root.querySelector('[data-act="close"]');
        zoomLabel = root.querySelector('.lightbox__zoom');

        root.querySelector('.lightbox__bar').addEventListener('click', (e) => {
            const btn = e.target.closest('[data-act]');
            if (!btn) return;
            const act = btn.dataset.act;
            if (act === 'in') zoomBy(1.5);
            else if (act === 'out') zoomBy(1 / 1.5);
            else if (act === 'reset') reset();
            else if (act === 'fs') toggleFullscreen();
            else if (act === 'close') close();
        });

        // A click on the dark backdrop (not the photo) closes the viewer.
        stage.addEventListener('click', (e) => {
            if (e.target === stage && !moved) close();
        });
        stage.addEventListener('wheel', onWheel, { passive: false });
        stage.addEventListener('dblclick', onDoubleClick);
        stage.addEventListener('pointerdown', onPointerDown);
        stage.addEventListener('pointermove', onPointerMove);
        stage.addEventListener('pointerup', onPointerEnd);
        stage.addEventListener('pointercancel', onPointerEnd);

        document.addEventListener('keydown', onKey);
        document.addEventListener('fullscreenchange', syncFullscreenIcon);
    }

    let moved = false;

    function limits() {
        const w = img.offsetWidth * (scale - 1) / 2;
        const h = img.offsetHeight * (scale - 1) / 2;
        return { w: Math.max(0, w), h: Math.max(0, h) };
    }

    function apply() {
        if (scale <= MIN_SCALE) { scale = MIN_SCALE; tx = 0; ty = 0; }
        const lim = limits();
        tx = Math.min(lim.w, Math.max(-lim.w, tx));
        ty = Math.min(lim.h, Math.max(-lim.h, ty));
        img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
        stage.classList.toggle('is-zoomed', scale > 1);
        zoomLabel.textContent = `${Math.round(scale * 100)}%`;
    }

    /** Zooms by `factor`, keeping the point (clientX, clientY) fixed on screen. */
    function zoomBy(factor, clientX, clientY) {
        const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
        if (next === scale) return;
        const rect = stage.getBoundingClientRect();
        const cx = (clientX == null ? rect.left + rect.width / 2 : clientX) - (rect.left + rect.width / 2);
        const cy = (clientY == null ? rect.top + rect.height / 2 : clientY) - (rect.top + rect.height / 2);
        const ratio = next / scale;
        tx = cx - (cx - tx) * ratio;
        ty = cy - (cy - ty) * ratio;
        scale = next;
        apply();
    }

    function reset() {
        scale = 1; tx = 0; ty = 0;
        apply();
    }

    function onWheel(e) {
        e.preventDefault();
        zoomBy(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
    }

    function onDoubleClick(e) {
        if (scale > 1) reset();
        else zoomBy(2.5, e.clientX, e.clientY);
    }

    function distance() {
        const [a, b] = [...pointers.values()];
        return Math.hypot(a.x - b.x, a.y - b.y);
    }

    function onPointerDown(e) {
        stage.setPointerCapture(e.pointerId);
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        moved = false;
        if (pointers.size === 1) {
            dragOrigin = { x: e.clientX, y: e.clientY, tx, ty };
        } else if (pointers.size === 2) {
            pinchOrigin = { dist: distance(), scale };
            dragOrigin = null;
        }
    }

    function onPointerMove(e) {
        if (!pointers.has(e.pointerId)) return;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (pointers.size === 2 && pinchOrigin) {
            const [a, b] = [...pointers.values()];
            const target = pinchOrigin.scale * (distance() / pinchOrigin.dist);
            zoomBy(target / scale, (a.x + b.x) / 2, (a.y + b.y) / 2);
            moved = true;
        } else if (pointers.size === 1 && dragOrigin && scale > 1) {
            const dx = e.clientX - dragOrigin.x;
            const dy = e.clientY - dragOrigin.y;
            if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
            tx = dragOrigin.tx + dx;
            ty = dragOrigin.ty + dy;
            apply();
        }
    }

    function onPointerEnd(e) {
        pointers.delete(e.pointerId);
        if (pointers.size < 2) pinchOrigin = null;
        if (pointers.size === 1) {
            const [p] = [...pointers.values()];
            dragOrigin = { x: p.x, y: p.y, tx, ty };
        } else {
            dragOrigin = null;
        }
        // Let the click that follows a drag be ignored, then clear the flag.
        setTimeout(() => { moved = false; }, 0);
    }

    function onKey(e) {
        if (!root || root.hidden) return;
        if (e.key === 'Escape') close();
        else if (e.key === '+' || e.key === '=') zoomBy(1.5);
        else if (e.key === '-') zoomBy(1 / 1.5);
        else if (e.key === '0') reset();
        else if (e.key === 'f' || e.key === 'F') toggleFullscreen();
    }

    function toggleFullscreen() {
        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else if (root.requestFullscreen) {
            root.requestFullscreen().catch(() => { /* not allowed: the overlay is already full-window */ });
        }
    }

    function syncFullscreenIcon() {
        if (!fsBtn) return;
        const on = Boolean(document.fullscreenElement);
        fsBtn.innerHTML = icon(on ? 'fullscreen_exit' : 'fullscreen');
        fsBtn.title = on ? 'Exit full screen' : 'Full screen';
        fsBtn.setAttribute('aria-label', fsBtn.title);
    }

    function open(src, alt) {
        if (!src) return;
        build();
        lastFocus = document.activeElement;
        img.src = src;
        img.alt = alt || '';
        reset();
        root.hidden = false;
        document.body.classList.add('lightbox-open');
        closeBtn.focus();
    }

    function close() {
        if (!root || root.hidden) return;
        if (document.fullscreenElement) document.exitFullscreen();
        root.hidden = true;
        document.body.classList.remove('lightbox-open');
        pointers.clear();
        if (lastFocus && lastFocus.focus) lastFocus.focus();
    }

    return { open, close };
})();

/** Adds the "view full size" button over the hero photo, once. */
function ensureZoomButton() {
    let btn = document.getElementById('zoomBtn');
    if (btn) return btn;
    const hero = document.querySelector('.profile-hero');
    if (!hero) return null;
    btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'zoomBtn';
    btn.className = 'zoom-btn';
    btn.title = 'View full size';
    btn.setAttribute('aria-label', 'View photo full size');
    btn.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">zoom_in</span> View photo';
    hero.appendChild(btn);
    return btn;
}

/** Shows the hero photo, or the placeholder when the plant has none. */
function setHeroImage(plant) {
    const image = document.getElementById('plantImage');
    const placeholder = document.getElementById('heroPlaceholder');
    const hasPhoto = plant && plant.images && plant.images.length > 0;
    const zoomBtn = ensureZoomButton();

    const openViewer = () => Lightbox.open(image.currentSrc || image.src, image.alt);
    if (!image.dataset.zoomBound) {
        image.dataset.zoomBound = '1';
        image.addEventListener('click', openViewer);
        if (zoomBtn) zoomBtn.addEventListener('click', openViewer);
    }

    if (hasPhoto) {
        image.src = plant.images[0].imageUrl;
        image.alt = `${plant.name} photo`;
        image.hidden = false;
        image.classList.add('is-zoomable');
        if (zoomBtn) zoomBtn.hidden = false;
        if (placeholder) placeholder.hidden = true;
        // A photo that fails to load falls back to the placeholder too.
        image.onerror = function () {
            image.hidden = true;
            image.classList.remove('is-zoomable');
            if (zoomBtn) zoomBtn.hidden = true;
            if (placeholder) placeholder.hidden = false;
        };
    } else {
        image.removeAttribute('src');
        image.alt = '';
        image.hidden = true;
        image.classList.remove('is-zoomable');
        if (zoomBtn) zoomBtn.hidden = true;
        if (placeholder) placeholder.hidden = false;
    }
}

async function loadPlantProfile() {
    const params = new URLSearchParams(window.location.search);
    const plantId = params.get('plantId') || params.get('plant');
    const titleEl = document.getElementById('commonName');

    if (!plantId) {
        titleEl.textContent = 'Plant not found';
        return;
    }

    const viewerReady = getViewer();   // runs in parallel with the plant request

    let plant;
    try {
        const response = await fetch(`/api/plants/${encodeURIComponent(plantId)}`, { credentials: 'include' });
        if (response.status === 404) {
            titleEl.textContent = 'Plant not found';
            document.getElementById('plantDescription').textContent =
                'This plant is not published yet, or it has no approved description.';
            return;
        }
        if (!response.ok) throw new Error('Failed to load plant');
        plant = await response.json();
    } catch (err) {
        console.error('Load plant profile error:', err);
        titleEl.textContent = 'Could not load plant';
        return;
    }

    document.title = `${plant.name} - Plantellect`;

    setHeroImage(plant);

    titleEl.textContent = plant.name;
    document.getElementById('scientificName').textContent = plant.scientificName || '';
    const typeBadgeEl = document.getElementById('plantTypeBadge');
    if (typeBadgeEl) typeBadgeEl.innerHTML = PlantBadge.html(plant.typeLabel || plant.type, plant.toxicityLevel);

    // Prefer the primary description, then the first approved one.
    const primary = (plant.descriptions || []).find(d => d.isPrimary) || (plant.descriptions || [])[0];
    const parts = primary ? primary.parts : null;
    document.getElementById('plantDescription').textContent = describeParts(parts) || 'No description recorded yet.';

    renderList(document.getElementById('plantUses'), primary && primary.uses);
    renderList(document.getElementById('plantBenefits'), primary && primary.benefits);

    // Who wrote the description the cards above show, then one box per other botanist.
    const byline = document.getElementById('primaryByline');
    const allDescriptions = plant.descriptions || [];
    if (byline) {
        if (primary && allDescriptions.length > 1) {
            byline.innerHTML = `<span class="contrib-box ${RichText.contributorClass(0)} byline-chip">` +
                `<span class="contrib-dot" aria-hidden="true"></span>Primary description by <strong>${escapeHtml(authorLabel(primary))}</strong></span>`;
            byline.hidden = false;
        } else {
            byline.hidden = true;
        }
    }
    renderOtherDescriptions(allDescriptions.filter(d => d !== primary), 1);

    // A harmful plant warns from its toxicity level even when no botanist wrote notes,
    // and the plant's caution note shows whenever it has one, harmful or not.
    const harmfulEl = document.getElementById('plantHarmful');
    const harmfulText = primary && primary.harmful;
    const cautionText = String(plant.cautionNote || '').trim();
    const levelText = plant.toxicityLevel && plant.toxicityLevel !== 'none'
        ? `Toxicity level: ${plant.toxicityLevel}.` : '';
    if (harmfulText || cautionText || levelText) {
        const partsHtml = [];
        if (levelText) partsHtml.push(`<p><strong>${escapeHtml(plant.typeLabel)}</strong> — ${escapeHtml(levelText)}</p>`);
        if (cautionText) partsHtml.push(`<div class="rt">${RichText.html(cautionText)}</div>`);
        if (harmfulText) partsHtml.push(`<div class="rt">${RichText.html(harmfulText)}</div>`);
        harmfulEl.innerHTML = partsHtml.join('');
    } else {
        harmfulEl.innerHTML = '<p class="muted">Nothing hazardous recorded.</p>';
    }

    document.getElementById('datasetSource').textContent =
        `Quantity on record: ${plant.quantity != null ? plant.quantity : '—'}`;

    // Which names are links depends on the visitor: wait for the single auth answer.
    // Three separate claims, three separate rows, three separate link rules;
    // each row hides when nobody is named.
    const viewer = await viewerReady;
    renderPeople('recordedByRow', 'recordedByList', plant.recordedBy, viewer, SECTION_RECORDED);
    renderPeople('reviewedByRow', 'reviewedByList', plant.reviewedBy, viewer, SECTION_REVIEWED);
    renderPeople('reportedByRow', 'reportedByList', plant.reportedBy, viewer, SECTION_REPORTED);

    showContributeLink(plantId, viewer);
}

/** Shows the Contribute button only when the session holds record_plant. */
function showContributeLink(plantId, viewer) {
    const link = document.getElementById('contributeLink');
    if (!link) return;
    if (!viewer || !(viewer.permissions || []).includes('record_plant')) {
        link.hidden = true;
        return;
    }
    link.href = `/record.html?tab=contribute&plantId=${encodeURIComponent(plantId)}`;
    link.hidden = false;
}

document.addEventListener('DOMContentLoaded', loadPlantProfile);