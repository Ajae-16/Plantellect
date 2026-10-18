/**
 * Plant profile page.
 *
 * Renders a single plant from GET /api/plants/:plantId. The id comes from the
 * ?plantId query parameter, which is what the library grid and the scan results
 * link to.
 */

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str == null ? '' : str);
    return div.innerHTML;
}

/** Renders a text block as list items, or a single item when it is one line. */
function renderList(el, text) {
    if (!el) return;
    if (!text) {
        el.innerHTML = '<li class="muted">No information recorded yet.</li>';
        return;
    }
    const items = String(text)
        .split(/\n+/)
        .map(s => s.replace(/^[-*•]\s*/, '').trim())
        .filter(Boolean);
    el.innerHTML = (items.length > 1 ? items : [text]).map(item => `<li>${escapeHtml(item)}</li>`).join('');
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

/**
 * Where a person's name should link, or null for plain text.
 *
 * The server decides via profileType, because it is the one that knows which
 * roles are privileged:
 *   'botanist' -> botanist-profile.html
 *   'admin'    -> admin-profile.html (admin and superadmin)
 *   anything else (user, system) -> no link
 */
function profileHref(person) {
    if (!person || !person.accountId) return null;
    const id = encodeURIComponent(person.accountId);
    // An older server only sends isBotanist, so keep botanist links working.
    const type = person.profileType || (person.isBotanist ? 'botanist' : null);
    if (type === 'botanist') return `/botanist-profile.html?accountId=${id}`;
    if (type === 'admin') return `/admin-profile.html?accountId=${id}`;
    return null;
}

/**
 * The server currently sends each row as one joined string, e.g.
 * "Ana Cruz, Ben Lee +2 more; Carla Diaz" (names joined with ", ", roles'
 * groups with "; "). Split it so each name is its own entry instead of one long
 * unlinked name. A trailing "+N more" overflow marker stays attached to the
 * name before it.
 */
function splitNameString(value) {
    return String(value)
        .split(/\s*[;,]\s*/)
        .map(s => s.trim())
        .filter(Boolean)
        .map(name => ({ name, isBotanist: false }));
}

/**
 * Renders a list of people into a "Recorded by / Reviewed by / Reported by" row.
 *
 *  - botanist:           clickable name -> botanist profile, plus Verified Botanist badge
 *  - admin / superadmin: clickable name -> admin profile, NO badge
 *  - user / system:      plain text, no badge
 *
 * An empty list hides the whole row, so "Reported by" only appears on a plant
 * that was created from a discovery report.
 */
function renderPeople(rowId, listId, people) {
    const row = document.getElementById(rowId);
    const list = document.getElementById(listId);
    if (!row || !list) return;

    // Accept the old string shape too, so the page keeps working until the
    // server sends the object shape.
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
        const href = profileHref(p);
        const badge = p.isBotanist
            ? `<span class="verified-badge">
                    <span class="material-symbols-outlined" style="font-size: 15px;">check_circle</span> Verified Botanist
                </span>`
            : '';
        if (href) {
            return `<span class="person"><a href="${href}">${name}</a>${badge}</span>`;
        }
        return `<span class="person"><span class="person-name">${name}</span>${badge}</span>`;
    }).join('');
    row.hidden = false;
}

/** Shows the hero photo, or the placeholder when the plant has none. */
function setHeroImage(plant) {
    const image = document.getElementById('plantImage');
    const placeholder = document.getElementById('heroPlaceholder');
    const hasPhoto = plant && plant.images && plant.images.length > 0;

    if (hasPhoto) {
        image.src = plant.images[0].imageUrl;
        image.alt = `${plant.name} photo`;
        image.hidden = false;
        if (placeholder) placeholder.hidden = true;
        // A photo that fails to load falls back to the placeholder too.
        image.onerror = function () {
            image.hidden = true;
            if (placeholder) placeholder.hidden = false;
        };
    } else {
        image.removeAttribute('src');
        image.alt = '';
        image.hidden = true;
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

    // Prefer the primary description, then the first approved one.
    const primary = (plant.descriptions || []).find(d => d.isPrimary) || (plant.descriptions || [])[0];
    const parts = primary ? primary.parts : null;
    document.getElementById('plantDescription').textContent = describeParts(parts) || 'No description recorded yet.';

    renderList(document.getElementById('plantUses'), primary && primary.uses);
    renderList(document.getElementById('plantBenefits'), primary && primary.benefits);

    // A harmful plant warns from its type even when no botanist wrote notes.
    const harmfulEl = document.getElementById('plantHarmful');
    const harmfulText = primary && primary.harmful;
    const typeWarning = plant.toxicityLevel && plant.toxicityLevel !== 'none' ? plant.cautionNote : null;
    if (harmfulText || typeWarning) {
        const partsHtml = [];
        if (typeWarning) partsHtml.push(`<p><strong>${escapeHtml(plant.typeLabel)}</strong> — ${escapeHtml(typeWarning)}</p>`);
        if (harmfulText) partsHtml.push(`<p>${escapeHtml(harmfulText)}</p>`);
        harmfulEl.innerHTML = partsHtml.join('');
    } else {
        harmfulEl.innerHTML = '<p class="muted">Nothing hazardous recorded.</p>';
    }

    document.getElementById('datasetSource').textContent =
        `Quantity on record: ${plant.quantity != null ? plant.quantity : '—'}`;

    // Three separate claims, three separate rows. Each is hidden when nobody is
    // named for it (most plants have no discovery report, so no "Reported by").
    renderPeople('recordedByRow', 'recordedByList', plant.recordedBy);
    renderPeople('reviewedByRow', 'reviewedByList', plant.reviewedBy);
    renderPeople('reportedByRow', 'reportedByList', plant.reportedBy);

    await showContributeLink(plantId);
}

/**
 * Shows the Contribute button only when the session holds record_plant, and
 * points it straight at this plant's contribute tab.
 */
async function showContributeLink(plantId) {
    const link = document.getElementById('contributeLink');
    if (!link) return;

    // plant-profile.html has its own shell: no sidebar.js, no shared nav, no
    // .auth-links. auth.js's checkAuth therefore falls back to its own fetch
    // here — the ONE page allowed to do that, and only because there is no
    // authority to delegate to. It cannot have the stale-header symptom this
    // exists to prevent, since it renders no header.
    let user = null;
    try {
        if (typeof window.checkAuth === 'function') user = await window.checkAuth();
    } catch (err) {
        user = null;
    }
    if (!user || !(user.permissions || []).includes('record_plant')) {
        link.hidden = true;
        return;
    }
    link.href = `/record.html?tab=contribute&plantId=${encodeURIComponent(plantId)}`;
    link.hidden = false;
}

document.addEventListener('DOMContentLoaded', loadPlantProfile);