/**
 * Admin discovery-report queue (admin-plants.html).
 *
 * Self-initialising. Its <script> tag sits at the END of admin-plants.html,
 * after the markup it drives, so getElementById resolves at execution time and
 * nothing outside this file has to call anything inside it. It used to be called
 * from the page's inline script, which is a load-order argument that cannot work
 * for a function declared inside this module's IIFE — no ordering makes a name
 * global.
 *
 * This is an AUDIT surface, not the work surface. The botanist queue is
 * /discoveries.html; what an admin needs here is to see what the community
 * decided — and, in the one case where it is genuinely necessary, to override it.
 *
 * The admin override exists because the quorum is unreachable below two active
 * botanists: /vote answers 409 there, so a small team would otherwise have no
 * way to close a report at all. It is therefore offered on an OPEN report only.
 * Overriding one that a botanist has already resolved is not a judgement about
 * the species, it is a way to close a report nobody can act on.
 */

(function () {
    'use strict';

    const PAGE_SIZE = 10;

    const REASON_LABELS = {
        not_a_plant: 'Not a plant',
        not_a_photo_of_plant: 'Not a photo of a plant',
        unusable_image: 'Image cannot be used',
        already_recorded: 'Already in the library',
        duplicate: 'Duplicate of another report'
    };

    const OVERRIDE_REASONS = ['not_a_plant', 'not_a_photo_of_plant', 'unusable_image', 'already_recorded', 'duplicate'];

    let status = 'pending';
    let page = 1;
    let total = 0;
    let activeBotanists = 0;
    let threshold = 2;

    function byId(id) { return document.getElementById(id); }

    /** The admin pages have their own theme; this one file borrows the shared helper. */
    function escapeText(value) {
        const div = document.createElement('div');
        div.textContent = String(value == null ? '' : value);
        return div.innerHTML;
    }

    function setNotice(message, kind) {
        const notice = byId('discoveryNotice');
        if (!notice) return;
        if (!message) {
            notice.hidden = true;
            notice.textContent = '';
            notice.className = 'admin-notice';
            return;
        }
        notice.hidden = false;
        notice.textContent = message;
        notice.className = 'admin-notice' + (kind ? ' ' + kind : '');
    }

    function formatWhen(value) {
        if (!value) return '';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '';
        const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
        if (seconds < 60) return 'just now';
        if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
        if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
        return date.toLocaleDateString();
    }

    async function loadDiscoveryReports() {
        const list = byId('discoveryList');
        if (!list) return;
        try {
            const query = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
            if (status) query.set('status', status);
            const response = await fetch('/admin/api/discovery-reports?' + query.toString(), {
                credentials: 'include'
            });
            if (!response.ok) throw new Error('Failed to load discovery reports');
            const data = await response.json();
            total = data.total;
            activeBotanists = data.activeBotanists;
            threshold = data.notAPlantThreshold;
            setNotice('');

            // The electorate is named here too. An admin deciding whether to
            // override a verdict needs to know how many people it took.
            byId('discoveryQuorumNote').textContent =
                `A report is rejected when ${threshold} of the ${activeBotanists} active botanist` +
                `${activeBotanists === 1 ? '' : 's'} vote that it is not a plant.` +
                (activeBotanists < 2
                    ? ' With fewer than two, voting is refused and this override is the only way to close a report.'
                    : '');

            const badge = byId('discoveryQueueBadge');
            if (badge) {
                if (status === 'pending' && total > 0) {
                    badge.textContent = total;
                    badge.hidden = false;
                } else {
                    badge.hidden = true;
                }
            }

            list.innerHTML = (data.requests || []).length === 0
                ? '<p>No discovery reports match this filter.</p>'
                : data.requests.map(renderRow).join('');

            const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
            byId('discoveryPaginationInfo').textContent =
                `Page ${page} of ${pages} (${total} report${total === 1 ? '' : 's'})`;
            const controls = byId('discoveryPaginationControls');
            controls.innerHTML =
                `<button class="page-btn"${page <= 1 ? ' disabled' : ''} data-discovery-page="${page - 1}">Previous</button>` +
                `<button class="page-btn"${page >= pages ? ' disabled' : ''} data-discovery-page="${page + 1}">Next</button>`;

            if (typeof window.loadNavBadges === 'function') {
                // Only the OPEN count badges the sidebar: a rejected report is
                // decided and needs no admin attention, so badging it would make
                // the number never reach zero.
                //
                // On a non-open tab the count is fetched with pageSize=1 rather
                // than dropped: omitting the key makes loadNavBadges refetch the
                // dashboard and plant counts too, and passing `undefined`
                // suppresses its fetch entirely and clears the badge. One extra
                // request is cheaper than either.
                if (status === 'pending') {
                    await window.loadNavBadges({ discoveries: total });
                } else {
                    let open = 0;
                    try {
                        const response = await fetch('/admin/api/discovery-reports?status=pending&pageSize=1', {
                            credentials: 'include'
                        });
                        if (response.ok) open = (await response.json()).total || 0;
                    } catch (err) {
                        console.error('Discovery badge count failed:', err);
                    }
                    await window.loadNavBadges({ discoveries: open });
                }
            }
        } catch (err) {
            console.error('Load discovery reports error:', err);
            list.innerHTML = '';
            setNotice('Discovery reports could not be loaded.', 'error');
        }
    }

    function renderRow(row) {
        const flags = [];
        if (row.status === 'rejected') flags.push('<span class="discovery-flag flag-notaplant">Rejected</span>');
        if (row.status === 'cancelled') flags.push('<span class="discovery-flag">Withdrawn by the reporter</span>');
        if (row.status === 'approved') flags.push('<span class="discovery-flag flag-approved">Added to the library</span>');
        if (row.status === 'denied') flags.push('<span class="discovery-flag flag-denied">Not added</span>');
        if (row.disqualifiedBy) {
            flags.push(`<span class="discovery-flag flag-notaplant">` +
                `${escapeText(REASON_LABELS[row.disqualifyReason] || 'Not a plant')} ` +
                `by ${escapeText(row.disqualifiedBy)}</span>`);
        }

        const photos = (row.images || []).length > 0
            ? `<div class="discovery-admin-photos">${row.images.map((image) => `
                <a href="${escapeText(image.url)}" target="_blank" rel="noopener">
                    <img src="${escapeText(image.url)}" alt="Report photo">
                </a>`).join('')}</div>`
            : '<p class="admin-muted">No photos attached.</p>';

        // Open + live claim: the report is with a botanist right now, and
        // rejecting it under them is exactly what the quorum's own rule forbids.
        const claimLive = Boolean(row.claimedBy) && row.status === 'pending';
        const overrideControl = row.status === 'pending'
            ? (claimLive
                ? `<span class="admin-muted">Claimed by ${escapeText(row.claimedByName || row.claimedBy)} — the override is withheld while a botanist is on it.</span>`
                : `<button type="button" class="admin-btn-secondary" data-discovery-override="${escapeText(row.id)}">Override: not a plant</button>
                   <div class="discovery-override" id="override-${escapeText(row.id)}" hidden>
                       <select id="overrideReason-${escapeText(row.id)}">
                           ${OVERRIDE_REASONS.map((key) => `<option value="${key}">${escapeText(REASON_LABELS[key])}</option>`).join('')}
                       </select>
                       <button type="button" class="admin-btn-danger" data-discovery-override-confirm="${escapeText(row.id)}">Confirm</button>
                   </div>`)
            : '';

        return `
            <div class="pending-request-card discovery-admin-card" data-id="${escapeText(row.id)}">
                <div class="plant-request-body">
                    <span class="plant-request-icon" aria-hidden="true">🔎</span>
                    <div class="plant-request-text">
                        <h3>${escapeText(row.plantName)}</h3>
                        <p class="admin-muted">
                            From ${escapeText(row.submittedByName || row.submittedBy)} on ${formatWhen(row.requestedAt)}
                            ${row.location ? ' · ' + escapeText(row.location) : ''}
                        </p>
                        ${row.note ? `<p class="discovery-admin-note">${escapeText(row.note)}</p>` : ''}
                        <div class="discovery-admin-flags">${flags.join('')}</div>
                        ${photos}
                        <p class="admin-muted">
                            Votes: ${row.voteCount} of ${escapeText(threshold)}
                            ${row.claimedBy ? ' · Claimed by ' + escapeText(row.claimedByName || row.claimedBy) + (row.claimSource === 'auto' ? ' (assigned)' : '') : ' · Unclaimed'}
                        </p>
                        <div class="discovery-admin-actions">
                            <button type="button" class="admin-btn-secondary" data-discovery-votes="${escapeText(row.id)}">Who voted</button>
                            ${row.targetPlantId
                                ? `<a class="admin-btn-secondary" href="/plant-profile.html?plantId=${encodeURIComponent(row.targetPlantId)}">See the plant</a>`
                                : ''}
                            ${overrideControl}
                        </div>
                        <div class="discovery-votes" id="votes-${escapeText(row.id)}" hidden></div>
                    </div>
                </div>
            </div>`;
    }

    async function showVoters(requestId) {
        const box = byId(`votes-${requestId}`);
        if (!box) return;
        if (!box.hidden) {
            box.hidden = true;
            return;
        }
        box.hidden = false;
        box.textContent = 'Loading…';
        try {
            const response = await fetch(`/admin/api/discovery-reports/${encodeURIComponent(requestId)}/votes`, {
                credentials: 'include'
            });
            if (!response.ok) throw new Error('Failed to load the votes');
            const data = await response.json();
            // The ONLY place voter identities are shown. A reporter sees a
            // count and never names, which is why this needs an admin.
            box.innerHTML = data.voters.length === 0
                ? '<p class="admin-muted">Nobody has voted on this report.</p>'
                : `<ul class="discovery-voter-list">${data.voters.map((voter) =>
                    `<li>${escapeText(voter.fullName || voter.username)} <span class="admin-muted">${escapeText(voter.accountId)} · ${formatWhen(voter.votedAt)}</span></li>`
                ).join('')}</ul>`;
        } catch (err) {
            console.error('Load discovery votes error:', err);
            box.textContent = 'The votes could not be loaded.';
        }
    }

    async function confirmOverride(requestId) {
        const select = byId(`overrideReason-${requestId}`);
        try {
            const response = await fetch(`/admin/api/discovery-reports/${encodeURIComponent(requestId)}/disqualify`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ reason: select ? select.value : 'not_a_plant' })
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                setNotice(data.error || 'The override failed.', 'error');
                return;
            }
            setNotice('');
            await loadDiscoveryReports();
        } catch (err) {
            console.error('Admin override failed:', err);
            setNotice('The override failed.', 'error');
        }
    }

    function initDiscoveryQueue() {
        const section = byId('discoveryQueue');
        if (!section) return;

        section.querySelectorAll('[data-discovery-status]').forEach(function (chip) {
            chip.addEventListener('click', function () {
                section.querySelectorAll('[data-discovery-status]').forEach(function (other) {
                    other.classList.toggle('active', other === chip);
                });
                status = chip.getAttribute('data-discovery-status');
                page = 1;
                loadDiscoveryReports();
            });
        });

        section.addEventListener('click', function (event) {
            const target = event.target.closest('[data-discovery-page]');
            if (target && !target.disabled) {
                page = parseInt(target.getAttribute('data-discovery-page'), 10) || 1;
                loadDiscoveryRequestsGuard();
                return;
            }
            const votes = event.target.closest('[data-discovery-votes]');
            if (votes) {
                showVoters(votes.getAttribute('data-discovery-votes'));
                return;
            }
            const override = event.target.closest('[data-discovery-override]');
            if (override) {
                const panel = byId(`override-${override.getAttribute('data-discovery-override')}`);
                if (panel) panel.hidden = !panel.hidden;
                return;
            }
            const confirm = event.target.closest('[data-discovery-override-confirm]');
            if (confirm) {
                confirmOverride(confirm.getAttribute('data-discovery-override-confirm'));
            }
        });

        loadDiscoveryRequestsGuard();
    }

    /** Guards a page change from a stale total: never walk past the end. */
    function loadDiscoveryRequestsGuard() {
        const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
        if (page > pages) page = pages;
        loadDiscoveryReports();
    }

    // The module owns its own start. initDiscoveryQueue() returns immediately
    // when #discoveryQueue is absent, so loading this file on a page that has no
    // admin queue is still harmless.
    initDiscoveryQueue();
})();