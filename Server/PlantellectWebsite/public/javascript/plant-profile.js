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

/** "What it looks like" is built from the botanist's measurements. */
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

    const image = document.getElementById('plantImage');
    if (plant.images && plant.images.length > 0) {
        image.src = plant.images[0].imageUrl;
        image.alt = `${plant.name} photo`;
    } else {
        image.removeAttribute('src');
        image.alt = '';
    }

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

    // A verified botanist link is only meaningful when we can resolve one.
    const author = primary && primary.author;
    const reviewerLink = document.getElementById('reviewerLink');
    if (author && author.accountId) {
        reviewerLink.textContent = author.name || author.accountId;
        reviewerLink.href = `/botanist-profile.html?accountId=${encodeURIComponent(author.accountId)}`;
    } else {
        const contributorInfo = reviewerLink.closest('.contributor-info');
        if (contributorInfo) contributorInfo.style.display = 'none';
    }

    const badge = document.getElementById('confidenceBadge');
    if (badge) badge.hidden = true;
}

document.addEventListener('DOMContentLoaded', loadPlantProfile);
