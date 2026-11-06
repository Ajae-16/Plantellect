/**
 * Contributor / administrator profile page.
 *
 * Renders one account from GET /api/contributors/:accountId. The id comes from the
 * ?accountId query parameter, which is what the plant profile links to.
 *
 * The same page serves two kinds of account. profile.role decides which:
 *   user                 a contributor: what this member added to the library
 *   admin / superadmin   an administrator profile (reviewing statistics)
 *
 * An administrator profile is only returned to an administrator. Everyone else
 * gets a 404 from the server, which this page shows as "not available" rather
 * than revealing that the account exists.
 *
 * Theme and the back button are handled by sidebar.js.
 */

const UNAVAILABLE = 'Profile not found or not available to you.';

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

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

function setHidden(id, hidden) {
    const el = document.getElementById(id);
    if (el) el.hidden = hidden;
}

/** Shows only the message, so a failed or restricted load never shows stale "—" stats. */
function showUnavailable(message) {
    document.body.classList.add('profile-unavailable');
    setText('profileName', message);
    setText('profileBio', '');
    setText('profileAvatar', '—');
    const grid = document.getElementById('contributionGrid');
    if (grid) grid.innerHTML = '';
    setHidden('reportedSection', true);
}

/**
 * One plant card. Uses its own .profile-plant-card classes (NOT .plant-card),
 * so none of the library card styling can leak into the profile page.
 */
function renderPlantCard(c, role) {
    const name = c && c.name ? c.name : 'Unnamed plant';
    const cardImage = c && (c.thumbnailUrl || c.imageUrl);
    const media = cardImage
        ? `<img class="profile-plant-card__media" src="${escapeHtml(cardImage)}" alt="${escapeHtml(name)}" loading="lazy">`
        : '<div class="profile-plant-card__media profile-plant-card__placeholder" aria-hidden="true">🌿</div>';
    const sci = c && c.scientificName
        ? `<p class="profile-plant-card__sci">${escapeHtml(c.scientificName)}</p>`
        : '';
    const meta = [role, c && (c.typeLabel || c.type)].filter(Boolean).join(' · ');

    return `
        <a href="plant-profile.html?plantId=${encodeURIComponent(c && c.id)}" class="profile-plant-card">
            ${media}
            <div class="profile-plant-card__body">
                <h4>${escapeHtml(name)}</h4>
                ${sci}
                <small>${escapeHtml(meta)}</small>
            </div>
        </a>`;
}

/**
 * The contributions grid, filtered to role = 'contributor'.
 *
 * The label is part of the claim: a species this member REPORTED is not one
 * they recorded, so rendering both under one heading would assert something
 * false. The reported grid below is a separate grid over role = 'reporter' for
 * the same reason.
 *
 * For an administrator the same grid lists the plants they reviewed, labelled
 * "Reviewed".
 */
function renderContributions(contributions, cardLabel, emptyText) {
    const grid = document.getElementById('contributionGrid');
    if (!grid) return;

    if (!Array.isArray(contributions) || contributions.length === 0) {
        grid.innerHTML = `<p class="muted">${escapeHtml(emptyText)}</p>`;
        return;
    }
    grid.innerHTML = contributions.map(c => renderPlantCard(c, cardLabel)).join('');
}

/** Species this account flagged, over role = 'reporter'. */
function renderReported(reported) {
    const grid = document.getElementById('reportedGrid');
    const section = document.getElementById('reportedSection');
    if (!grid || !section) return;

    if (!Array.isArray(reported) || reported.length === 0) {
        section.hidden = true;
        return;
    }
    section.hidden = false;
    grid.innerHTML = reported.map(c => renderPlantCard(c, 'Reported')).join('');
}

function formatJoined(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
}

const ADMIN_ROLE_LABELS = {
    admin: 'Administrator',
    superadmin: 'Superadministrator'
};

/** The contributor layout: what this member has added to the library. */
function renderContributor(profile) {
    const metrics = profile.metrics || {};

    setText('roleBadgeIcon', 'volunteer_activism');
    setText('roleBadgeText', 'Community Contributor');
    setText('metricLabelPlants', 'Plants Contributed');
    setText('metricLabelReported', 'Species Reported');
    setText('metricLabelThird', 'Member Since');
    setText('contributionsIcon', 'eco');
    setText('contributionsTitle', 'Plant Contributions');

    setText('profilePlantCount', metrics.verifiedPlants || 0);
    setText('profileThirdMetric', formatJoined(profile.joinedAt));

    // Per-plant CNN accuracy is not persisted anywhere, so the metric is hidden
    // for contributors instead of showing a permanent dash.
    setHidden('metricAccuracyItem', true);

    // A reported species is credited, so the number counts it — and only it.
    // It is deliberately NOT added into the contributed count: the two are
    // different claims and the metrics row must not blur them.
    setText('profileReportedCount', metrics.reportedPlants || 0);

    renderContributions(profile.contributions, 'Contributed', 'No contributions yet.');
    renderReported(profile.reported);
}

/** The administrator / superadmin layout: reviewing, not contributing. */
function renderAdministrator(profile) {
    const metrics = profile.metrics || {};

    setText('roleBadgeIcon', 'shield_person');
    setText('roleBadgeText', ADMIN_ROLE_LABELS[profile.role] || 'Administrator');
    setText('metricLabelPlants', 'Plants Reviewed');
    setText('metricLabelReported', 'Requests Approved');
    setText('metricLabelAccuracy', 'Requests Denied');
    setText('metricLabelThird', 'Member Since');
    setText('contributionsIcon', 'fact_check');
    setText('contributionsTitle', 'Plants Reviewed');

    setHidden('metricAccuracyItem', false);

    setText('profilePlantCount', metrics.reviewedPlants || 0);
    setText('profileReportedCount', metrics.approvedRequests || 0);
    setText('profileAccuracy', metrics.deniedRequests || 0);
    setText('profileThirdMetric', formatJoined(profile.joinedAt));

    renderContributions(profile.contributions, 'Reviewed', 'No reviewed plants yet.');

    // Administrators report no species, so the second grid never applies.
    setHidden('reportedSection', true);
}

async function loadContributorProfile() {
    const params = new URLSearchParams(window.location.search);
    const accountId = params.get('accountId') || params.get('id');

    if (!accountId) {
        showUnavailable('Profile not found.');
        return;
    }

    let profile;
    try {
        const response = await fetch(`/api/contributors/${encodeURIComponent(accountId)}`, { credentials: 'include' });
        if (response.status === 404) {
            // Missing, deleted, or an administrator profile this visitor may not see.
            showUnavailable(UNAVAILABLE);
            return;
        }
        if (!response.ok) throw new Error('Failed to load profile');
        profile = await response.json();
    } catch (err) {
        console.error('Load contributor profile error:', err);
        showUnavailable('Could not load profile. Check your connection and try again.');
        return;
    }

    if (!profile || typeof profile !== 'object') {
        showUnavailable(UNAVAILABLE);
        return;
    }

    const name = profile.name || 'Unnamed account';
    document.title = `${name} - Plantellect`;
    setText('profileName', name);
    setText('profileAvatar', initialsFor(name));
    // An empty bio hides itself (.contributor-bio:empty), so a member who never
    // wrote one does not get a placeholder sentence.
    setText('profileBio', profile.bio || '');

    if (profile.role === 'user') {
        renderContributor(profile);
    } else if (profile.role === 'admin' || profile.role === 'superadmin') {
        renderAdministrator(profile);
    } else {
        showUnavailable(UNAVAILABLE);   // no other role has a public profile
    }
}

document.addEventListener('DOMContentLoaded', loadContributorProfile);