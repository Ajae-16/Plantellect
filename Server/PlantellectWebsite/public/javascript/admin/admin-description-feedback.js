/**
 * Admin Plants page, "Plant reports" section (before the discovery reports): community votes on
 * plant descriptions. The dashboard only shows a notification that links here.
 *
 * Self-initialising, like admin-discoveries.js: its <script> tag sits near the END of
 * admin-plants.html, after the markup it drives, and it returns at once when
 * #plantReportQueue is absent.
 *
 * What it shows (GET /admin/api/description-feedback):
 *   - descriptions the community HID (enough down votes),
 *   - descriptions with any down vote since the admin last cleared them, with the premade
 *     reasons counted and the voters' own notes ("Other") written out,
 *   - non-primary descriptions with enough up votes to be worth making the primary one.
 *
 * What the admin can do (POST /admin/api/description-feedback/:id/:action):
 *   Make primary, Keep as is (dismiss), Restore (a hidden one), Take it out.
 */
(function () {
    'use strict';

    const PAGE_SIZE = 6;
    const PREVIEW_CHARS = 220;

    let filter = 'attention';
    let page = 1;
    let total = 0;
    let upvoteAlert = 5;
    let downvoteHide = 5;

    const byId = (id) => document.getElementById(id);

    function esc(value) {
        const div = document.createElement('div');
        div.textContent = String(value == null ? '' : value);
        return div.innerHTML;
    }

    /** Contributor text may carry light markup; the admin preview is plain and short. */
    function preview(text) {
        const plain = String(text || '').replace(/<[^>]*>/g, ' ').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
        return plain.length > PREVIEW_CHARS ? plain.slice(0, PREVIEW_CHARS - 1) + '…' : plain;
    }

    function when(value) {
        const d = value ? new Date(value) : null;
        return d && !Number.isNaN(d.getTime()) ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
    }

    function setNotice(message, kind) {
        const el = byId('plantReportNotice');
        if (!el) return;
        el.hidden = !message;
        el.textContent = message || '';
        el.className = 'admin-notice' + (kind ? ' ' + kind : '');
    }

    function setBadge(count) {
        const badge = byId('plantReportQueueBadge');
        if (badge) {
            badge.hidden = !(count > 0);
            badge.textContent = count > 99 ? '99+' : String(count);
        }
        // The sidebar badge and the hamburger dot are drawn by admin-sidebar.js.
        if (typeof window.loadNavBadges === 'function') window.loadNavBadges({ feedback: count });
    }

    async function refreshCount() {
        try {
            const res = await fetch('/admin/api/description-feedback/count', { credentials: 'include' });
            if (res.ok) setBadge((await res.json()).total || 0);
        } catch (err) {
            console.error('Description feedback count failed:', err);
        }
    }

    function renderItem(d) {
        const flags = [];
        if (d.hidden) flags.push(`<span class="fb-flag is-hidden"><span class="material-symbols-outlined">visibility_off</span>Hidden from the public (${d.downTotal} downvotes)</span>`);
        else if (d.downNew > 0) flags.push(`<span class="fb-flag is-down"><span class="material-symbols-outlined">thumb_down</span>${d.downNew} downvote${d.downNew === 1 ? '' : 's'} (hides at ${downvoteHide})</span>`);
        if (d.reasonFlags.wantsPrimary) flags.push(`<span class="fb-flag is-up"><span class="material-symbols-outlined">thumb_up</span>${d.upNew} upvotes: consider making it primary</span>`);
        else if (d.upTotal > 0) flags.push(`<span class="fb-flag"><span class="material-symbols-outlined">thumb_up</span>${d.upTotal} upvote${d.upTotal === 1 ? '' : 's'}</span>`);
        if (d.isPrimary) flags.push('<span class="fb-flag"><span class="material-symbols-outlined">star</span>Primary description</span>');

        const parts = [['Uses', d.uses], ['Benefits', d.benefits], ['Watch out', d.harmful]]
            .map(([label, text]) => [label, preview(text)])
            .filter(([, text]) => text);
        const previewHtml = parts.length
            ? parts.map(([label, text]) => `<div><strong>${label}</strong>${esc(text)}</div>`).join('')
            : '<div class="admin-muted">This description has measurements only, no written text.</div>';

        const why = (d.reasons.length || d.notes.length) ? `
            <div class="fb-why">
                <strong>Why people downvoted it</strong>
                ${d.reasons.length ? `<div class="fb-reasons">${d.reasons.map((r) => `<span class="fb-reason">${esc(r.label)}<b>×${r.count}</b></span>`).join('')}</div>` : ''}
                ${d.notes.length ? `<ul class="fb-notes">${d.notes.map((n) => `<li>“${esc(n.note)}” <span class="who">· ${esc(n.username)}, ${esc(when(n.votedAt))}</span></li>`).join('')}</ul>` : ''}
            </div>` : '';

        const id = esc(d.descriptionId);
        const buttons = [];
        if (!d.isPrimary && !d.hidden) buttons.push(`<button type="button" class="fb-btn primary" data-fb="primary" data-id="${id}">Make primary</button>`);
        if (d.hidden) buttons.push(`<button type="button" class="fb-btn primary" data-fb="restore" data-id="${id}">Restore</button>`);
        else buttons.push(`<button type="button" class="fb-btn" data-fb="dismiss" data-id="${id}">Keep as is</button>`);
        buttons.push(`<button type="button" class="fb-btn danger" data-fb="remove" data-id="${id}" data-only="${d.onlyDescription ? '1' : '0'}">Take it out</button>`);
        buttons.push(`<button type="button" class="fb-btn" data-fb="voters" data-id="${id}">Who voted</button>`);

        return `
            <article class="fb-item${d.hidden ? ' is-hidden' : ''}${d.reasonFlags.wantsPrimary ? ' is-popular' : ''}" data-id="${id}">
                <div class="fb-head">
                    <span class="fb-title"><a href="/plant-profile.html?plantId=${encodeURIComponent(d.plantId)}" target="_blank" rel="noopener">${esc(d.plantName)}</a>${d.scientificName ? `<span class="fb-sci">${esc(d.scientificName)}</span>` : ''}</span>
                    <span class="fb-by">Written by ${esc(d.authorName)} · ${esc(when(d.createdAt))}</span>
                </div>
                <div class="fb-flags">${flags.join('')}</div>
                <div class="fb-preview">${previewHtml}</div>
                ${why}
                <div class="fb-actions">${buttons.join('')}</div>
                <ul class="fb-voters" id="fbVoters-${id}" hidden></ul>
            </article>`;
    }

    async function load() {
        const list = byId('plantReportList');
        if (!list) return;
        try {
            const q = new URLSearchParams({ filter, page: String(page), pageSize: String(PAGE_SIZE) });
            const res = await fetch('/admin/api/description-feedback?' + q, { credentials: 'include' });
            if (!res.ok) throw new Error('Failed to load plant reports');
            const data = await res.json();
            total = data.total;
            upvoteAlert = data.upvoteAlert;
            downvoteHide = data.downvoteHide;
            setNotice('');

            byId('plantReportNote').textContent =
                `${downvoteHide} downvotes hide a description from the public page at once. ` +
                `${upvoteAlert} upvotes on a description that is not the primary one raise a notice here.`;

            list.innerHTML = data.descriptions.length
                ? data.descriptions.map(renderItem).join('')
                : '<p class="feedback-empty">Nothing needs your attention. Votes on descriptions will show up here.</p>';

            const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
            byId('plantReportPager').innerHTML = total === 0 ? '' : `
                <span>Page ${page} of ${pages} (${total} description${total === 1 ? '' : 's'})</span>
                <span class="btns">
                    <button type="button" class="fb-btn" data-fb-page="${page - 1}"${page <= 1 ? ' disabled' : ''}>Previous</button>
                    <button type="button" class="fb-btn" data-fb-page="${page + 1}"${page >= pages ? ' disabled' : ''}>Next</button>
                </span>`;

            if (filter === 'attention') setBadge(total); else refreshCount();
        } catch (err) {
            console.error('Load plant reports error:', err);
            list.innerHTML = '';
            setNotice('Plant reports could not be loaded.', 'error');
        }
    }

    async function showVoters(id) {
        const box = byId('fbVoters-' + id);
        if (!box) return;
        if (!box.hidden) { box.hidden = true; return; }
        box.hidden = false;
        box.innerHTML = '<li>Loading…</li>';
        try {
            const res = await fetch(`/admin/api/description-feedback/${encodeURIComponent(id)}/votes`, { credentials: 'include' });
            if (!res.ok) throw new Error('Failed to load the votes');
            const data = await res.json();
            box.innerHTML = data.voters.length === 0
                ? '<li>Nobody has voted on this description.</li>'
                : data.voters.map((v) => `<li>
                        <span class="${v.value === 'up' ? 'v-up' : 'v-down'}">${v.value === 'up' ? '▲ Up' : '▼ Down'}</span>
                        ${esc(v.username)} <span class="when">${esc(v.accountId)} · ${esc(when(v.votedAt))}</span>
                        ${v.reasonLabel ? `<br>${esc(v.reasonLabel)}${v.reasonNote ? `: “${esc(v.reasonNote)}”` : ''}` : ''}
                    </li>`).join('');
        } catch (err) {
            console.error('Load description voters error:', err);
            box.innerHTML = '<li>The votes could not be loaded.</li>';
        }
    }

    const CONFIRM = {
        remove: (only) => only
            ? 'Take this description out? It is the ONLY description of this plant, so the plant will disappear from the library until someone adds another. This cannot be undone from here.'
            : 'Take this description out? It will no longer appear anywhere. If it is the primary description, the best remaining one takes its place.',
        restore: () => 'Restore this description? It will show on the public page again and its downvotes are cleared.'
    };

    async function act(button) {
        const action = button.dataset.fb;
        const id = button.dataset.id;
        if (action === 'voters') return showVoters(id);

        const ask = CONFIRM[action];
        if (ask && !window.confirm(ask(button.dataset.only === '1'))) return;

        button.disabled = true;
        try {
            const res = await fetch(`/admin/api/description-feedback/${encodeURIComponent(id)}/${encodeURIComponent(action)}`, {
                method: 'POST', credentials: 'include'
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                setNotice(data.error || 'That decision failed.', 'error');
                button.disabled = false;
                return;
            }
            setNotice(data.message || 'Done.', 'success');
            await load();
        } catch (err) {
            console.error('Plant report action failed:', err);
            setNotice('That decision failed.', 'error');
            button.disabled = false;
        }
    }

    function init() {
        const card = byId('plantReportQueue');
        if (!card) return;

        byId('plantReportFilter').addEventListener('change', (e) => {
            filter = e.target.value;
            page = 1;
            load();
        });

        card.addEventListener('click', (e) => {
            const pager = e.target.closest('[data-fb-page]');
            if (pager && !pager.disabled) {
                page = parseInt(pager.dataset.fbPage, 10) || 1;
                load();
                return;
            }
            const button = e.target.closest('[data-fb]');
            if (button && !button.disabled) act(button);
        });

        // Arriving from the dashboard notification: open the section and scroll to it.
        const openFromHash = () => {
            if (window.location.hash !== '#plantReportQueue') return;
            const details = card.querySelector('details.collapse');
            if (details) details.open = true;
            card.scrollIntoView({ block: 'start' });
        };
        openFromHash();
        window.addEventListener('hashchange', openFromHash);

        // Opens on what needs attention.
        load();
    }

    init();
})();
