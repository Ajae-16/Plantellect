/**
 * Profile page.
 *
 * Two independent halves: who you are () and what you have reported (GET /api/discoveries/mine).
 * They are separate on purpose — a signed-out visitor gets the first and
 * nothing of the second, rather than one failing call blanking the whole page.
 *
 * Identity comes from window.plantAuth.ready, the app's ONE /api/auth/me fetch.
 * This page must not fetch it again or render the header itself: it did, and
 * three pages that did the same ended up with permanently signed-out headers.
 * scripts/check-scripts.cjs asserts that.
 */

const REPORT_STATE_LABELS = {
    waiting: 'Waiting for a botanist',
    recording: 'Recorded — awaiting admin review',
    not_recorded: 'Not recorded — you can record it instead',
    added: 'Added to the library',
    not_added: 'Not added — the species was refused',
    not_a_plant: 'Not a plant',
    cancelled: 'Withdrawn by you'
};

/**
 * The server sends a closed set of states. This is a display map over that set,
 * not a second source of truth: an unrecognised state renders its raw value
 * rather than disappearing, because a state nobody has seen is worth seeing.
 */
function reportStateLabel(state) {
    return REPORT_STATE_LABELS[state] || state;
}

let myReportsPage = 1;

async function initProfilePage() {
    const profileCard = document.getElementById('profileCard');
    const guestPrompt = document.getElementById('guestPrompt');
    const profileAvatar = document.getElementById('profileAvatar');
    const profileUsername = document.getElementById('profileUsername');
    const profileEmail = document.getElementById('profileEmail');
    const profileRoles = document.getElementById('profileRoles');

    // The same promise the header render awaited. Never rejects, so there is no
    // try/catch to collapse a failure into "signed out".
    const user = await window.plantAuth.ready;

    if (!user) {
        if (guestPrompt) guestPrompt.style.display = 'block';
        if (profileCard) profileCard.style.display = 'none';
        const reports = document.getElementById('myReports');
        if (reports) reports.hidden = true;
        return;
    }

    if (profileCard) profileCard.style.display = 'block';
    if (guestPrompt) guestPrompt.style.display = 'none';

    if (profileUsername) profileUsername.textContent = user.username || '-';
    if (profileEmail) profileEmail.textContent = user.email || '-';
    if (profileRoles) {
        const roles = (user.roles || []).join(', ') || 'None';
        profileRoles.textContent = roles;
    }

    if (profileAvatar && user.username) {
        const initials = user.username.slice(0, 2).toUpperCase();
        profileAvatar.textContent = initials;
    }

    await loadMyReports();
}

function setReportsNotice(message) {
    const notice = document.getElementById('myReportsNotice');
    if (!notice) return;
    notice.hidden = !message;
    notice.textContent = message || '';
}

/**
 * Rendered with escaping on every field, including the note: it is the
 * REPORTER'S own text, and a report row is the one place on this page where
 * user-authored content is displayed back to the same user. Still escaped —
 * defence in depth costs nothing here.
 */
function renderReport(report) {
    const parts = [];
    parts.push(`<article class="report-card report-${escapeHtml(report.state)}">`);
    parts.push(`<header><h3>${escapeHtml(reportStateLabel(report.state))}</h3>`);
    parts.push(`<span class="report-when">${escapeHtml(formatWhen(report.submittedAt))}</span></header>`);

    if (report.photoUrl) {
        parts.push(`<a href="${escapeHtml(report.photoUrl)}" target="_blank" rel="noopener">` +
            `<img class="report-photo" src="${escapeHtml(report.photoUrl)}" alt="The photo you sent with this report"></a>`);
    }

    if (report.note) {
        parts.push(`<p class="report-note">${escapeHtml(report.note)}</p>`);
    }
    if (report.location) {
        parts.push(`<p class="report-muted">Where: ${escapeHtml(report.location)}</p>`);
    }

    // Only for a community rejection. A single botanist's verdict is a private
    // working note to the claimer, and publishing that would put a message
    // nobody authorised for public consumption into a user's own profile.
    if (report.state === 'not_a_plant' && report.voterCount > 0) {
        parts.push(`<p class="report-muted">${report.voterCount} botanist${report.voterCount === 1 ? '' : 's'} ` +
            'agreed this is not a plant.</p>');
    }

    if (report.plantUrl) {
        parts.push(`<a class="btn profile-btn" href="${escapeHtml(report.plantUrl)}">See the plant</a>`);
    }

    // Withdraw is offered only while the server would accept it: pending, no
    // record submitted, and inside the grace window. The client cannot know the
    // third of those without asking, so it is phrased as a possibility and the
    // server's 409 carries the truth when it is too late.
    if (report.state === 'waiting') {
        parts.push(`<button type="button" class="btn profile-btn-secondary" data-withdraw="${escapeHtml(report.requestId)}">Withdraw</button>`);
    }

    parts.push('</article>');
    return parts.join('');
}

function formatWhen(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
    if (seconds < 1728000) return `${Math.round(seconds / 86400)}d ago`;
    return date.toLocaleDateString();
}

async function loadMyReports() {
    const section = document.getElementById('myReports');
    if (!section) return;
    section.hidden = false;

    const list = document.getElementById('myReportsList');
    try {
        const response = await fetch(`/api/discoveries/mine?page=${myReportsPage}`, { credentials: 'include' });
        if (!response.ok) {
            list.innerHTML = '';
            setReportsNotice('Your reports could not be loaded.');
            return;
        }
        const data = await response.json();
        myReportsPage = data.page;
        setReportsNotice('');

        const summary = document.getElementById('myReportsSummary');
        if (summary) {
            summary.textContent = data.total === 0
                ? 'You have not reported any unidentified plants yet. You can do that from the Scan page.'
                : `${data.total} report${data.total === 1 ? '' : 's'} filed.`;
        }

        list.innerHTML = data.reports.length === 0
            ? '<p class="profile-muted">Nothing here yet.</p>'
            : data.reports.map(renderReport).join('');

        const pager = document.getElementById('myReportsPagination');
        pager.hidden = data.total <= data.pageSize;
        document.getElementById('myReportsInfo').textContent =
            `Page ${data.page} of ${Math.max(1, Math.ceil(data.total / data.pageSize))}`;
        document.getElementById('myReportsPrev').disabled = data.page <= 1;
        document.getElementById('myReportsNext').disabled = data.page * data.pageSize >= data.total;
    } catch (err) {
        console.error('Failed to load my reports:', err);
        list.innerHTML = '';
        setReportsNotice('Your reports could not be loaded.');
    }
}

document.addEventListener('DOMContentLoaded', function () {
    initProfilePage();

    document.addEventListener('click', async function (event) {
        const button = event.target.closest('[data-withdraw]');
        if (!button) return;
        const requestId = button.dataset.withdraw;
        button.disabled = true;
        try {
            const response = await fetch(`/api/discoveries/${encodeURIComponent(requestId)}/cancel`, {
                method: 'POST',
                credentials: 'include'
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                setReportsNotice(data.error || 'That report could not be withdrawn.');
            } else {
                setReportsNotice('');
            }
        } catch (err) {
            console.error('Withdraw failed:', err);
            setReportsNotice('Could not reach the server. Nothing was withdrawn.');
        }
        await loadMyReports();
    });

    const prev = document.getElementById('myReportsPrev');
    const next = document.getElementById('myReportsNext');
    if (prev) {
        prev.addEventListener('click', function () {
            if (myReportsPage > 1) {
                myReportsPage -= 1;
                loadMyReports();
            }
        });
    }
    if (next) {
        next.addEventListener('click', function () {
            myReportsPage += 1;
            loadMyReports();
        });
    }
});