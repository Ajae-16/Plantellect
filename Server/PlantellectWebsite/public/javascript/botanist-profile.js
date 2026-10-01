/**
 * Botanist profile page.
 *
 * Renders one botanist from GET /api/botanists/:accountId. The id comes from
 * the ?accountId query parameter, which is what the plant profile links to.
 */

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str == null ? '' : str);
    return div.innerHTML;
}

function initialsFor(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '—';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// The page markup calls toggleTheme() from the header button, so it has to be
// on the global scope. Icon shows what you will switch TO.
function applyTheme(mode) {
    const body = document.body;
    const themeIcon = document.getElementById('themeIcon');
    const themeBtn = document.getElementById('themeToggleBtn');
    if (!themeIcon || !themeBtn) return;

    if (mode === 'light') {
        body.classList.add('light-mode');
        themeIcon.textContent = 'dark_mode';
        themeBtn.title = 'Switch to Dark Mode';
    } else {
        body.classList.remove('light-mode');
        themeIcon.textContent = 'light_mode';
        themeBtn.title = 'Switch to Light Mode';
    }
    localStorage.setItem('plantellect-theme', mode);
}

function toggleTheme() {
    const isLight = document.body.classList.contains('light-mode');
    applyTheme(isLight ? 'dark' : 'light');
}

window.toggleTheme = toggleTheme;

function renderContributions(contributions) {
    const grid = document.getElementById('contributionGrid');
    if (!grid) return;

    if (!contributions || contributions.length === 0) {
        grid.innerHTML = '<p class="muted">No verified contributions yet.</p>';
        return;
    }

    grid.innerHTML = contributions.map(function (c) {
        const image = c.imageUrl
            ? `<img src="${escapeHtml(c.imageUrl)}" alt="${escapeHtml(c.name)}">`
            : '<div class="plant-card-placeholder" aria-hidden="true">🌿</div>';
        const role = c.role === 'reviewer' ? 'Reviewed' : 'Contributed';
        return `
        <a href="plant-profile.html?plantId=${encodeURIComponent(c.id)}" class="plant-card">
            ${image}
            <div class="plant-card-content">
                <h4>${escapeHtml(c.name)}</h4>
                <p>${escapeHtml(c.scientificName)}</p>
                <small>${role} · ${escapeHtml(c.typeLabel || c.type)}</small>
            </div>
        </a>`;
    }).join('');
}

async function loadBotanistProfile() {
    const params = new URLSearchParams(window.location.search);
    const accountId = params.get('accountId') || params.get('id');
    const nameEl = document.getElementById('botanistName');

    if (!accountId) {
        nameEl.textContent = 'Botanist not found';
        return;
    }

    let profile;
    try {
        const response = await fetch(`/api/botanists/${encodeURIComponent(accountId)}`, { credentials: 'include' });
        if (response.status === 404) {
            nameEl.textContent = 'Botanist not found';
            return;
        }
        if (!response.ok) throw new Error('Failed to load profile');
        profile = await response.json();
    } catch (err) {
        console.error('Load botanist profile error:', err);
        nameEl.textContent = 'Could not load profile';
        return;
    }

    document.title = `${profile.name} - Plantellect`;
    nameEl.textContent = profile.name;
    document.getElementById('botanistAvatar').textContent = initialsFor(profile.name);
    document.getElementById('botanistBio').textContent = profile.bio || 'No biography recorded yet.';

    document.getElementById('botanistPlantCount').textContent = profile.metrics.verifiedPlants;
    document.getElementById('botanistSpecialization').textContent = profile.specialization || '—';

    // Per-plant CNN accuracy is still hardcoded on the design; the metric is not
    // persisted yet, so show a dash rather than a stale number.
    document.getElementById('botanistAccuracy').textContent = '—';

    renderContributions(profile.contributions);
}

document.addEventListener('DOMContentLoaded', function () {
    applyTheme(localStorage.getItem('plantellect-theme') || 'dark');
    loadBotanistProfile();
});
