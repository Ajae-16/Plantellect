/**
 * Discoveries queue (discoveries.html).
 *
 * Renders GET /api/discoveries and drives every per-report action. Two rules the
 * rendering follows without exception:
 *
 *   1. The server is the authority for what may be clicked. Each control is
 *      rendered from a field the card actually carries (claimedBy === myAccountId,
 *      resolvedBy, disqualifyReason), never from an assumption that keeps the
 *      view tidy. Where the server could refuse, the client is not invited to ask.
 *   2. After every action the list is refetched. Local mutation of a card is how
 *      two clients end up disagreeing about a claim, and the claim is the one
 *      thing in this feature that must never be double-issued.
 */

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str == null ? '' : str);
    return div.innerHTML;
}

/** The reason enum is server-owned; this is a readable label, not a decision. */
const REASON_LABELS = {
    not_a_plant: 'Not a plant',
    not_a_photo_of_plant: 'Not a photo of a plant',
    unusable_image: 'Image cannot be used',
    already_recorded: 'Already in the library',
    duplicate: 'Duplicate of another report'
};

let myAccountId = null;
let currentPage = 1;
const params = new URLSearchParams(window.location.search);
if (params.get('page')) currentPage = parseInt(params.get('page'), 10) || 1;

function setNotice(message, kind) {
    const notice = document.getElementById('discoveryNotice');
    if (!notice) return;
    if (!message) {
        notice.hidden = true;
        notice.textContent = '';
        notice.className = 'discoveries-notice';
        return;
    }
    notice.hidden = false;
    notice.textContent = message;
    notice.className = 'discoveries-notice' + (kind ? ' ' + kind : '');
}

async function apiCall(path, options) {
    const response = await fetch(path, Object.assign({ credentials: 'include' }, options));
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(data.error || 'Something went wrong');
        error.status = response.status;
        throw error;
    }
    return data;
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

/** The report's own photos, from the botanist route. */
function renderPhotos(card) {
    if (!card.images || card.images.length === 0) {
        return card.photosPurged
            ? '<p class="discovery-muted">The photos for this report were removed after it was closed.</p>'
            : '<p class="discovery-muted">No photos were attached.</p>';
    }
    return `<div class="discovery-photos">${card.images.map((image) => `
        <a href="${escapeHtml(image.url)}" target="_blank" rel="noopener">
            <img src="${escapeHtml(image.url)}" alt="Photo from this report">
        </a>`).join('')}</div>`;
}

/** What the model guessed, as a hint. Never pre-fills anything. */
function renderPredictions(card) {
    if (!card.predictions || card.predictions.length === 0) return '';
    const items = card.predictions.slice(0, 3).map((p) => `
        <li>
            <span class="discovery-pred-name">${escapeHtml(p.scientificName || '')}</span>
            <span class="discovery-pred-common">${escapeHtml(p.commonName || '')}</span>
            <span class="discovery-pred-conf">${Math.round((p.confidence || 0) * 100)}%</span>
        </li>`).join('');
    return `
        <div class="discovery-predictions">
            <p class="discovery-label">What the model suggested</p>
            <ul>${items}</ul>
        </div>`;
}

/**
 * What you may DO with the report: claim it, work on it, or override a dead claim.
 * Rendered from the card's own fields, so it can only offer what the server would
 * accept.
 */
function renderActions(card) {
    const mine = card.claimedBy && card.claimedBy === myAccountId;
    const buttons = [];

    if (mine) {
        buttons.push(`<button type="button" class="btn discoveries-btn" data-action="resolve" data-id="${escapeHtml(card.requestId)}">Mark resolved</button>`);
        if (card.resolvedBy === myAccountId) {
            buttons.push(`<button type="button" class="btn discoveries-btn-secondary" data-action="reopen" data-id="${escapeHtml(card.requestId)}">Undo resolve</button>`);
        }
        buttons.push(`<a class="btn discoveries-btn" href="record.html?from=${encodeURIComponent(card.requestId)}">Record it</a>`);
        buttons.push(`<button type="button" class="btn discoveries-btn-secondary" data-action="unclaim" data-id="${escapeHtml(card.requestId)}">Release</button>`);
    } else if (card.claimable) {
        buttons.push(`<button type="button" class="btn discoveries-btn" data-action="claim" data-id="${escapeHtml(card.requestId)}">Claim</button>`);
    }

    if (card.disqualifiedBy) {
        buttons.push(`<button type="button" class="btn discoveries-btn-secondary" data-action="reinstate" data-id="${escapeHtml(card.requestId)}">Disagree? Reinstate</button>`);
    }

    // A live claim is the admin's business, not a dead one: releaseDiscovery
    // refuses for a non-admin while the holder can still authenticate, so
    // offering the button to a botanist would only ever produce a 403.
    if (card.claimedBy) {
        buttons.push(`<button type="button" class="btn discoveries-btn-quiet" data-action="release" data-id="${escapeHtml(card.requestId)}">Release claim</button>`);
    }

    return `<div class="discovery-actions">${buttons.join('')}</div>` + renderJudgementMenu(card);
}

/**
 * What you may JUDGE the report to be, for every botanist.
 *
 * Kept out of renderActions on purpose. A verdict is not a task: it is an opinion
 * about a photo, and the person best placed to hold one is often NOT the person
 * working on the report. So both entries are visible on every card, whether or not
 * the viewer holds the claim — hiding them until you claimed would make the
 * quorum reachable only by people willing to take ownership of work they may not
 * want.
 *
 * Visibility is not permission. Recording a verdict still requires holding the
 * claim (disqualifyDiscovery guards on claimedBy), so a botanist who reveals this
 * menu without a claim gets the reason list, the reason for the requirement, and a
 * 409 that says the same thing — rather than a button that was never there.
 */
function renderJudgementMenu(card) {
    const votingClosed = Boolean(card.claimedBy) || card.recordRequestId !== null;
    const entries = [];

    if (!card.disqualifiedBy) {
        entries.push(`<button type="button" class="discovery-menu-item" data-action="open-disqualify" data-id="${escapeHtml(card.requestId)}">
            <span class="discovery-menu-label">Not a plant</span>
            <span class="discovery-menu-hint">Claim it first to record a verdict</span>
        </button>`);
    }

    entries.push(`<button type="button" class="discovery-menu-item" data-action="vote" data-id="${escapeHtml(card.requestId)}"${votingClosed ? ' disabled' : ''}>
        <span class="discovery-menu-label">Vote not a plant</span>
        <span class="discovery-menu-hint">${card.voteCount} of ${card.notAPlantThreshold} so far${votingClosed ? ' &middot; a claimed report cannot be voted on' : ''}</span>
    </button>`);

    // A native <details>, so the disclosure is keyboard reachable and its open
    // state is the browser's, not a variable this file has to keep in sync across
    // the refetch that follows every action.
    return `
        <details class="discovery-menu">
            <summary class="discovery-menu-summary">Discovery actions</summary>
            <div class="discovery-menu-list">${entries.join('')}</div>
        </details>`;
}

function renderCard(card) {
    const flags = [];
    if (card.claimedBy) {
        const source = card.claimSource === 'auto' ? ' (assigned)' : '';
        flags.push(`<span class="discovery-flag flag-claimed">Claimed by ${escapeHtml(card.claimedByName || card.claimedBy)}${source} ${formatWhen(card.claimedAt)}</span>`);
    }
    if (card.resolvedBy) {
        flags.push(`<span class="discovery-flag flag-resolved">Resolved by ${escapeHtml(card.resolverName || card.resolvedBy)} ${formatWhen(card.resolvedAt)}</span>`);
    }
    if (card.recordRequestId) {
        flags.push(`<span class="discovery-flag flag-recording">Recorded &mdash; awaiting admin review</span>`);
    }
    if (card.disqualifiedBy) {
        flags.push(`<span class="discovery-flag flag-notaplant">${escapeHtml(REASON_LABELS[card.disqualifyReason] || 'Not a plant')} &mdash; ${escapeHtml(card.disqualifierName || card.disqualifiedBy)}</span>`);
    }

    return `
        <article class="discovery-card" data-request="${escapeHtml(card.requestId)}">
            <header class="discovery-card-head">
                <div>
                    <h2 class="discovery-reporter">${escapeHtml(card.reporterName || card.reporterId)}</h2>
                    <p class="discovery-muted">Reported ${formatWhen(card.submittedAt)}${card.location ? ' &middot; ' + escapeHtml(card.location) : ''}</p>
                </div>
                <a class="discovery-id" href="record.html?from=${encodeURIComponent(card.requestId)}">${escapeHtml(card.requestId)}</a>
            </header>
            ${flags.length ? `<div class="discovery-flags">${flags.join('')}</div>` : ''}
            ${card.note ? `<p class="discovery-note">${escapeHtml(card.note)}</p>` : ''}
            ${renderPhotos(card)}
            ${renderPredictions(card)}
            ${renderActions(card)}
            <div class="discovery-disqualify" id="disq-${escapeHtml(card.requestId)}" hidden>
                <p class="discovery-label">Why is this not a plant?</p>
                <select id="disqReason-${escapeHtml(card.requestId)}">
                    ${Object.keys(REASON_LABELS).map((key) => `<option value="${key}">${escapeHtml(REASON_LABELS[key])}</option>`).join('')}
                </select>
                <p class="discovery-muted">${card.claimedBy === myAccountId
                    ? 'Recording the verdict hands the report back to the queue and releases your claim, so the rest of the team can vote on it.'
                    : 'You have to claim this report before you can record a verdict &mdash; a verdict must belong to somebody responsible for the report. Claim it, or ask the holder to release it.'}</p>
                <button type="button" class="btn discoveries-btn" data-action="disqualify" data-id="${escapeHtml(card.requestId)}">Record verdict</button>
                <button type="button" class="btn discoveries-btn-secondary" data-action="cancel-disqualify" data-id="${escapeHtml(card.requestId)}">Cancel</button>
            </div>
        </article>`;
}

async function load() {
    const list = document.getElementById('discoveryList');
    try {
        const data = await apiCall(`/api/discoveries?page=${currentPage}`);
        currentPage = data.page;
        setNotice('');

        const quorum = document.getElementById('discoveryQuorum');
        if (quorum) {
            quorum.hidden = false;
            quorum.textContent = `A "not a plant" verdict closes a report when ${data.notAPlantThreshold} of the ` +
                `${data.activeBotanists} active botanist${data.activeBotanists === 1 ? '' : 's'} agree. ` +
                'You do not need to hold the claim to vote.';
        }

        if (data.requests.length === 0) {
            list.innerHTML = '<p class="discoveries-muted">Nothing is waiting. New reports appear here as soon as they are filed.</p>';
        } else {
            list.innerHTML = data.requests.map(renderCard).join('');
        }

        const pager = document.getElementById('discoveryPagination');
        pager.hidden = data.total <= data.pageSize;
        document.getElementById('discoveryInfo').textContent =
            `Page ${data.page} of ${Math.max(1, Math.ceil(data.total / data.pageSize))} (${data.total} report${data.total === 1 ? '' : 's'})`;
        document.getElementById('discoveryPrev').disabled = data.page <= 1;
        document.getElementById('discoveryNext').disabled = data.page * data.pageSize >= data.total;
    } catch (err) {
        list.innerHTML = '';
        if (err.status === 403) {
            setNotice('The discoveries queue is for botanists. Your account can file a report from the Scan page instead.', 'warning');
        } else {
            setNotice(err.message, 'warning');
        }
    }
}

async function act(action, requestId, extra) {
    try {
        await apiCall(`/api/discoveries/${encodeURIComponent(requestId)}/${action}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(extra || {})
        });
        setNotice('');
        // Refetch rather than mutate the card: the claim is the one thing in this
        // feature that must never be double-issued, and only the server knows.
        await load();
        if (typeof window.loadDiscoveryBadge === 'function') await window.loadDiscoveryBadge();
    } catch (err) {
        setNotice(err.message, 'warning');
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    // Identity comes from sidebar.js's single /api/auth/me fetch. This page used
    // to make its own call in a try/catch that turned every failure into
    // myAccountId = null — and then, having never rendered the header either,
    // showed a botanist a queue with the nav still saying SIGN IN.
    const me = await window.plantAuth.ready;
    myAccountId = (me && me.accountId) || null;
    document.addEventListener('click', (event) => {
        const button = event.target.closest('[data-action]');
        if (!button) return;
        const action = button.dataset.action;
        const requestId = button.dataset.id;

        if (action === 'open-disqualify') {
            const panel = document.getElementById(`disq-${requestId}`);
            if (panel) panel.hidden = !panel.hidden;
            return;
        }
        if (action === 'cancel-disqualify') {
            const panel = document.getElementById(`disq-${requestId}`);
            if (panel) panel.hidden = true;
            return;
        }
        if (action === 'disqualify') {
            const select = document.getElementById(`disqReason-${requestId}`);
            act('disqualify', requestId, { reason: select ? select.value : 'not_a_plant' });
            return;
        }
        event.preventDefault();
        act(action, requestId);
    });

    document.getElementById('discoveryPrev').addEventListener('click', () => {
        if (currentPage > 1) {
            currentPage -= 1;
            load();
        }
    });
    document.getElementById('discoveryNext').addEventListener('click', () => {
        currentPage += 1;
        load();
    });

    await load();
});