/**
 * Archive page (admin-archive.html).
 *
 * Plant archive first; the User archive switch is a placeholder for now. One row per plant that has anything in
 * the archive, like the plant library: open a row to see its photos and descriptions.
 *   - an ARCHIVED or DELETED plant lists ALL its pieces, so each one can be deleted on its own;
 *   - an ACTIVE plant lists only the pieces that were archived (the plant itself stays public).
 * Restore / Unarchive reuse the Plants page endpoints; Delete moves an archived item to the Deleted status (it is
 * removed for good after the retention days in Settings) and Undo delete takes it back to archived. All reads and
 * the permission rules are enforced by the server (routes/admin-archive.js); this page only shows what it allows.
 */
(function () {
    'use strict';

    var $ = function (id) { return document.getElementById(id); };
    var esc = function (s) { return window.escapeHtml ? window.escapeHtml(String(s == null ? '' : s)) : String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };

    var state = { status: 'all', search: '', page: 1, expanded: null, retentionDays: 30, lastPlants: [] };

    function note(text, isError) {
        var box = $('arNotice');
        box.hidden = !text;
        box.textContent = text || '';
        box.className = 'admin-notice' + (isError ? ' error' : '');
    }

    async function api(url, options) {
        var res = await fetch(url, Object.assign({ credentials: 'include' }, options || {}));
        var data = await res.json().catch(function () { return {}; });
        if (!res.ok) throw new Error(data.error || 'Request failed');
        return data;
    }

    function post(url, body) {
        return api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    }

    function date(value) {
        if (!value) return '';
        var d = new Date(value);
        return isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    }

    function badge(s) {
        var label = s.state === 'deleted'
            ? 'Pending deletion' + (s.daysLeft != null ? ' \u00b7 ' + s.daysLeft + ' day' + (s.daysLeft === 1 ? '' : 's') + ' left' : '')
            : s.state === 'archived' ? 'Archived' : 'Active';
        var title = s.state === 'deleted' ? 'Removed for good on ' + date(s.purgeAt) : s.state === 'archived' ? 'Archived ' + date(s.archivedAt) : '';
        return '<span class="ar-badge ' + esc(s.state) + '" title="' + esc(title) + '">' + esc(label) + '</span>';
    }

    function tile(value, label, cls) {
        return '<div class="ds-stat ' + (cls || '') + '"><strong>' + esc(value) + '</strong><span>' + esc(label) + '</span></div>';
    }

    async function loadSummary() {
        var s = await api('/admin/api/archive/summary');
        state.retentionDays = s.retentionDays;
        $('arStats').innerHTML =
            tile(s.plants.archived, 'Archived plants', s.plants.archived ? 'warn' : '') +
            tile(s.photos.archived, 'Archived photos', s.photos.archived ? 'warn' : '') +
            tile(s.descriptions.archived, 'Archived descriptions', s.descriptions.archived ? 'warn' : '') +
            tile(s.plants.deleted + s.photos.deleted + s.descriptions.deleted, 'Pending deletion', (s.plants.deleted + s.photos.deleted + s.descriptions.deleted) ? 'bad' : '') +
            tile(s.retentionDays + ' days', 'Kept before removal');
    }

    function countCell(c) {
        if (!c.total) return '<span class="ar-muted">none</span>';
        var parts = [];
        if (c.archived) parts.push(c.archived + ' archived');
        if (c.deleted) parts.push(c.deleted + ' pending deletion');
        return '<span class="ar-count">' + c.total + ' total' + (parts.length ? '<span class="ar-sub">' + esc(parts.join(', ')) + '</span>' : '') + '</span>';
    }

    function plantActions(p) {
        var id = esc(p.id);
        if (p.plant.state === 'deleted') return '<button type="button" class="btn" data-act="plant-undelete" data-plant="' + id + '">Undo delete</button>';
        if (p.plant.state === 'archived') {
            return '<button type="button" class="btn" data-act="plant-restore" data-plant="' + id + '">Restore</button>' +
                '<button type="button" class="btn btn-deny" data-act="plant-delete" data-plant="' + id + '">Delete</button>';
        }
        return '<span class="ar-muted">Plant is active</span>';
    }

    function renderRows(data) {
        state.lastPlants = data.plants;
        var body = $('arBody');
        $('arEmpty').hidden = data.plants.length > 0;
        body.innerHTML = data.plants.map(function (p) {
            var open = state.expanded === p.id;
            var row = '<tr class="ar-row" data-plant="' + esc(p.id) + '">' +
                '<td><button type="button" class="ar-expand" data-act="toggle" data-plant="' + esc(p.id) + '" aria-expanded="' + open + '" aria-label="Show the pieces">\u25B8</button></td>' +
                '<td><span class="ar-plant">' + esc(p.name) + '</span><span class="ar-sub">' + esc(p.scientificName) + '</span></td>' +
                '<td>' + badge(p.plant) +
                    (p.plant.archivedByName && p.plant.state !== 'active' ? '<span class="ar-sub">by ' + esc(p.plant.archivedByName) + '</span>' : '') +
                    (p.plant.archiveReason ? '<span class="ar-sub">' + esc(p.plant.archiveReason) + '</span>' : '') + '</td>' +
                '<td>' + countCell(p.counts.photos) + '</td>' +
                '<td>' + countCell(p.counts.descriptions) + '</td>' +
                '<td>' + esc(p.recordedBy || '\u2014') + '</td>' +
                '<td><div class="ar-actions">' + plantActions(p) + '</div></td></tr>';
            if (open) row += '<tr class="ar-detail" data-detail-for="' + esc(p.id) + '"><td colspan="7"><div class="ar-pieces" id="arPieces"><p class="ds-muted">Loading...</p></div></td></tr>';
            return row;
        }).join('');

        var pages = Math.max(1, Math.ceil(data.total / data.pageSize));
        $('arPager').innerHTML = pages > 1
            ? '<button type="button" class="btn" data-page="prev"' + (data.page <= 1 ? ' disabled' : '') + '>Previous</button>' +
              '<span>Page ' + data.page + ' of ' + pages + ' (' + data.total + ' plants)</span>' +
              '<button type="button" class="btn" data-page="next"' + (data.page >= pages ? ' disabled' : '') + '>Next</button>'
            : (data.total ? '<span class="ds-muted">' + data.total + ' plant' + (data.total === 1 ? '' : 's') + '</span>' : '');
        if (state.expanded) loadPieces(state.expanded);
    }

    async function loadPlants() {
        var qs = '?status=' + encodeURIComponent(state.status) + '&page=' + state.page + (state.search ? '&search=' + encodeURIComponent(state.search) : '');
        var data = await api('/admin/api/archive/plants' + qs);
        if (state.page > 1 && data.plants.length === 0 && data.total > 0) {
            state.page = Math.max(1, Math.ceil(data.total / data.pageSize));
            return loadPlants();
        }
        renderRows(data);
    }

    function pieceButtons(kind, plantId, piece) {
        var base = 'data-kind="' + kind + '" data-plant="' + esc(plantId) + '" data-id="' + esc(piece.id) + '"';
        var out = '';
        if (piece.actions.restore) out += '<button type="button" class="btn" data-act="piece-restore" ' + base + '>' + (kind === 'photo' ? 'Unarchive' : 'Unarchive') + '</button>';
        if (piece.actions.delete) out += '<button type="button" class="btn btn-deny" data-act="piece-delete" ' + base + '>Delete</button>';
        if (piece.actions.undoDelete) out += '<button type="button" class="btn" data-act="piece-undelete" ' + base + '>Undo delete</button>';
        return out;
    }

    function ownerLine(piece) {
        var who = piece.owner && piece.owner.name ? esc(piece.owner.name) : '';
        var by = piece.archivedByName ? ' \u00b7 archived by ' + esc(piece.archivedByName) : '';
        var why = piece.archiveReason ? ' \u00b7 ' + esc(piece.archiveReason) : '';
        return '<span class="ar-muted">' + who + by + why + '</span>';
    }

    function stateBadge(piece, plant) {
        // A piece that was never touched but sits in an archived plant shows the plant's status.
        if (piece.state === 'active') return '<span class="ar-badge ' + esc(plant.state) + '">Plant ' + esc(plant.state) + '</span>';
        return badge(piece);
    }

    async function loadPieces(plantId) {
        var host = $('arPieces');
        if (!host) return;
        try {
            var d = await api('/admin/api/archive/plants/' + encodeURIComponent(plantId) + '/pieces');
            var html = '<p class="ds-muted">' + (d.scope === 'all'
                ? 'The plant is ' + esc(d.plant.state) + ', so every photo and description is listed. Each can be deleted on its own.'
                : 'The plant is still active. Only the archived photos and descriptions are listed.') + '</p>';
            html += '<h4>Photos (' + d.photos.length + ')</h4>';
            html += d.photos.length ? '<div class="ar-photos">' + d.photos.map(function (ph) {
                return '<div class="ar-piece ' + esc(ph.state) + '">' +
                    '<a href="' + esc(ph.previewUrl) + '" target="_blank" rel="noopener"><img src="' + esc(ph.previewUrl) + '" alt="Plant photo" loading="lazy"></a>' +
                    stateBadge(ph, d.plant) +
                    (ph.scanContribution ? '<span class="ar-muted">Scan contribution</span>' : '') +
                    ownerLine(ph) +
                    '<div class="ar-actions">' + pieceButtons('photo', plantId, ph) + '</div></div>';
            }).join('') + '</div>' : '<p class="ar-muted">No photos.</p>';
            html += '<h4>Descriptions (' + d.descriptions.length + ')</h4>';
            html += d.descriptions.length ? '<div class="ar-desc-list">' + d.descriptions.map(function (de) {
                return '<div class="ar-piece ar-desc ' + esc(de.state) + '"><div class="ar-text">' +
                    stateBadge(de, d.plant) + (de.isPrimary ? ' <span class="ar-muted">Primary</span>' : '') +
                    '<div>' + esc(de.excerpt || '(measurements only)') + '</div>' + ownerLine(de) + '</div>' +
                    '<div class="ar-actions">' + pieceButtons('description', plantId, de) + '</div></div>';
            }).join('') + '</div>' : '<p class="ar-muted">No descriptions.</p>';
            host.innerHTML = html;
        } catch (err) {
            host.innerHTML = '<p class="admin-notice error">' + esc(err.message) + '</p>';
        }
    }

    function findPlant(id) { return state.lastPlants.filter(function (p) { return p.id === id; })[0]; }

    var DONE = {
        'plant-restore': 'Plant restored.',
        'plant-delete': 'Plant moved to the Deleted status.',
        'plant-undelete': 'Deletion undone. The plant is archived again.',
        'piece-restore': 'Unarchived.',
        'piece-delete': 'Moved to the Deleted status.',
        'piece-undelete': 'Deletion undone. It is archived again.'
    };

    function urlFor(act, el) {
        var plant = encodeURIComponent(el.dataset.plant);
        var id = el.dataset.id ? encodeURIComponent(el.dataset.id) : '';
        var kind = el.dataset.kind;
        var seg = kind === 'photo' ? 'photos' : 'descriptions';
        switch (act) {
            case 'plant-restore': return '/admin/api/plants/' + plant + '/restore';
            case 'plant-delete': return '/admin/api/archive/plants/' + plant + '/delete';
            case 'plant-undelete': return '/admin/api/archive/plants/' + plant + '/undelete';
            case 'piece-restore': return '/admin/api/plants/' + plant + '/' + seg + '/' + id + '/unarchive';
            case 'piece-delete': return '/admin/api/archive/plants/' + plant + '/' + seg + '/' + id + '/delete';
            case 'piece-undelete': return '/admin/api/archive/plants/' + plant + '/' + seg + '/' + id + '/undelete';
        }
        return null;
    }

    function confirmText(act, el) {
        var days = state.retentionDays + ' day' + (state.retentionDays === 1 ? '' : 's');
        if (act === 'plant-delete') {
            var p = findPlant(el.dataset.plant);
            return 'Delete "' + (p ? p.name : 'this plant') + '"?\n\nIt moves to the Deleted status. It, its photos and its descriptions are removed for good after ' + days + ' (Settings). Until then you can undo it.';
        }
        if (act === 'piece-delete') {
            return 'Delete this ' + el.dataset.kind + '?\n\nIt moves to the Deleted status and is removed for good after ' + days + ' (Settings). Until then you can undo it.';
        }
        return null;
    }

    async function onAction(el) {
        var act = el.dataset.act;
        var text = confirmText(act, el);
        if (text && !window.confirm(text)) return;
        var url = urlFor(act, el);
        if (!url) return;
        el.disabled = true;
        note('');
        try {
            await post(url);
            note(DONE[act] || 'Done.', false);
            await Promise.all([loadSummary(), loadPlants()]);
        } catch (err) {
            note(err.message, true);
            el.disabled = false;
        }
    }

    function wire() {
        document.addEventListener('click', function (e) {
            var el = e.target.closest('[data-act]');
            if (!el || !$('arBody').contains(el)) return;
            if (el.dataset.act === 'toggle') {
                state.expanded = state.expanded === el.dataset.plant ? null : el.dataset.plant;
                loadPlants().catch(function (err) { note(err.message, true); });
                return;
            }
            onAction(el);
        });

        $('arFilters').addEventListener('click', function (e) {
            var chip = e.target.closest('.ds-chip');
            if (!chip) return;
            state.status = chip.dataset.status;
            state.page = 1;
            state.expanded = null;
            Array.prototype.forEach.call($('arFilters').querySelectorAll('.ds-chip'), function (c) {
                var on = c === chip;
                c.classList.toggle('active', on);
                c.setAttribute('aria-pressed', String(on));
            });
            loadPlants().catch(function (err) { note(err.message, true); });
        });

        var timer = null;
        $('arSearch').addEventListener('input', function () {
            clearTimeout(timer);
            timer = setTimeout(function () {
                state.search = $('arSearch').value.trim();
                state.page = 1;
                loadPlants().catch(function (err) { note(err.message, true); });
            }, 300);
        });

        $('arPager').addEventListener('click', function (e) {
            var b = e.target.closest('[data-page]');
            if (!b || b.disabled) return;
            state.page += b.dataset.page === 'next' ? 1 : -1;
            state.expanded = null;
            loadPlants().catch(function (err) { note(err.message, true); });
        });

        // Plant archive is the only view for now; the User archive button is disabled until it is built.
        $('arViewSwitch').addEventListener('click', function (e) {
            var b = e.target.closest('.ds-view');
            if (!b || b.disabled) return;
            Array.prototype.forEach.call($('arViewSwitch').querySelectorAll('.ds-view'), function (x) {
                var on = x === b;
                x.classList.toggle('active', on);
                x.setAttribute('aria-pressed', String(on));
            });
            $('arPlantsSection').hidden = b.dataset.view !== 'plants';
            $('arUsersSection').hidden = b.dataset.view !== 'users';
        });
    }

    async function fillUser() {
        var box = $('adminUser');
        if (!box) return;
        try {
            var u = await api('/api/auth/me');
            box.textContent = u.username || u.email || 'Admin';
        } catch (e) { box.textContent = 'Admin'; }
    }

    document.addEventListener('DOMContentLoaded', function () {
        wire();
        fillUser();
        Promise.all([loadSummary(), loadPlants()]).catch(function (err) { note(err.message, true); });
    });
})();
