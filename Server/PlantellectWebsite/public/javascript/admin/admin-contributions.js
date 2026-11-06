/**
 * "Scan contributions" section of the admin Plants page.
 *
 * Every scan contribution is filed under the plant the model named, so a wrong prediction puts a photo of one
 * plant into another plant's dataset (a leak). This section lists the contributions grouped by the plant they are
 * assigned to, so an admin can look at them, MOVE the wrong ones to the right plant, and include a whole page of
 * checked photos in the dataset.
 *
 * Light on the server by design: nothing loads until the section is opened; the plants are one page of 10 at a
 * time; a plant's photos load only when its row is opened, one page at a time (the size is Settings > Plant Photos >
 * "Photos per page in the plant editor").
 *
 * Talks to /admin/api/dataset/db/contributions/* (see routes/admin-dataset.js). Self-initialising; returns at once
 * when #contributionsSection is absent.
 */
(function () {
    'use strict';

    var API = '/admin/api/dataset/db/';
    var section = null;
    var state = { loaded: false, page: 1, review: true, groups: [], totals: null, pages: 1, total: 0, open: null };
    // The open plant: { plantId, page, review, data, selected: Set, target: {plantId, label}|null, busy }
    var panel = null;

    function esc(value) {
        var div = document.createElement('div');
        div.textContent = String(value == null ? '' : value);
        return div.innerHTML;
    }

    function byId(id) { return document.getElementById(id); }

    function date(value) {
        var d = new Date(value);
        return isNaN(d) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    }

    function percent(value) {
        return typeof value === 'number' && isFinite(value) ? (value * 100).toFixed(1) + '%' : '';
    }

    async function api(path, options) {
        var response = await fetch(path.charAt(0) === '/' ? path : API + path, Object.assign({ credentials: 'include' }, options || {}));
        var data = await response.json().catch(function () { return {}; });
        if (!response.ok) {
            if (response.status === 401) { window.location.href = '/auth.html'; }
            throw new Error(data.error || 'Request failed');
        }
        return data;
    }

    function post(path, body) {
        return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    }

    function message(kind, text) {
        var el = byId('contribNotice');
        if (!el) return;
        el.hidden = !text;
        el.textContent = text || '';
        el.className = 'admin-notice' + (kind === 'error' ? ' error' : '');
    }

    function plantLabel(g) {
        return g.scientificName + (g.commonName && g.commonName !== g.scientificName ? ' (' + g.commonName + ')' : '');
    }

    /* ------------------------------------------------------------------ the plant list */

    async function loadGroups() {
        var body = byId('contribBody');
        try {
            var data = await api('contributions/groups?page=' + state.page + (state.review ? '&review=1' : ''));
            state.page = data.page;
            state.pages = data.pages;
            state.total = data.total;
            state.groups = data.groups;
            state.totals = data.totals;
            state.loaded = true;
            renderGroups();
        } catch (err) {
            body.innerHTML = '<tr><td colspan="7"><p class="admin-notice error">' + esc(err.message) + '</p></td></tr>';
        }
    }

    function renderGroups() {
        var t = state.totals || { total: 0, candidate: 0, included: 0, excluded: 0 };
        byId('contribTotals').innerHTML =
            '<strong>' + t.total + '</strong> contribution' + (t.total === 1 ? '' : 's') +
            ' &middot; <strong>' + t.candidate + '</strong> waiting &middot; ' + t.included + ' included &middot; ' + t.excluded + ' excluded';
        var badge = byId('contribCount');
        if (badge) { badge.hidden = !(t.candidate > 0); badge.textContent = t.candidate > 99 ? '99+' : String(t.candidate); }

        var body = byId('contribBody');
        if (state.groups.length === 0) {
            body.innerHTML = '<tr><td colspan="7" class="request-detail-muted">' +
                (state.review ? 'No plant has a contribution waiting for review.' : 'No scan contributions yet.') + '</td></tr>';
        } else {
            body.innerHTML = state.groups.map(function (g) {
                var isOpen = panel && panel.plantId === g.plantId;
                return '<tr class="contrib-row ' + (isOpen ? 'is-open' : '') + '" data-plant="' + esc(g.plantId) + '">' +
                    '<td><button type="button" class="btn-expand ' + (isOpen ? 'expanded' : '') + '" data-open="' + esc(g.plantId) + '" aria-expanded="' + (isOpen ? 'true' : 'false') + '" aria-label="Show the photos of ' + esc(g.scientificName) + '">' +
                        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"></path></svg></button></td>' +
                    '<td class="plant-name-cell" data-label="Plant">' + (g.unassigned ? '<em>' + esc(g.scientificName) + '</em>' : esc(plantLabel(g))) +
                        (g.plantArchived ? ' <span class="archived-badge">Archived</span>' : '') + '</td>' +
                    '<td data-label="Photos">' + g.total + '</td>' +
                    '<td data-label="Waiting">' + (g.candidate > 0 ? '<strong>' + g.candidate + '</strong>' : '0') + '</td>' +
                    '<td data-label="Included">' + g.included + '</td>' +
                    '<td data-label="Excluded">' + g.excluded + '</td>' +
                    '<td data-label="Avg confidence">' + esc(percent(g.avgConfidence)) + '</td>' +
                '</tr>' + (isOpen ? '<tr class="contrib-detail-row"><td colspan="7"><div class="contrib-detail" id="contribDetail"></div></td></tr>' : '');
            }).join('');
        }
        renderGroupPager();
        if (panel) renderPanel();
    }

    function renderGroupPager() {
        var info = byId('contribPageInfo');
        var controls = byId('contribPageControls');
        if (state.total === 0) { info.textContent = ''; controls.innerHTML = ''; return; }
        info.innerHTML = 'Page <strong>' + state.page + '</strong> of <strong>' + state.pages + '</strong> &middot; ' + state.total + ' plant' + (state.total === 1 ? '' : 's');
        var buttons = '<button type="button" class="page-btn" data-gpage="prev" ' + (state.page <= 1 ? 'disabled' : '') + '>Prev</button>';
        var from = Math.max(1, state.page - 2);
        var to = Math.min(state.pages, from + 4);
        from = Math.max(1, to - 4);
        for (var p = from; p <= to; p += 1) {
            buttons += '<button type="button" class="page-btn ' + (p === state.page ? 'active' : '') + '" data-gpage="' + p + '">' + p + '</button>';
        }
        buttons += '<button type="button" class="page-btn" data-gpage="next" ' + (state.page >= state.pages ? 'disabled' : '') + '>Next</button>';
        controls.innerHTML = buttons;
    }

    /* ------------------------------------------------------------------ one plant's photos */

    async function openPlant(plantId) {
        if (panel && panel.plantId === plantId) {      // the same row again closes it
            panel = null;
            renderGroups();
            return;
        }
        panel = { plantId: plantId, page: 1, review: false, data: null, selected: new Set(), target: null, results: [], busy: false, moving: null, moveSearch: '', moveResults: [] };
        renderGroups();
        await loadPanel();
    }

    async function loadPanel() {
        if (!panel) return;
        var current = panel;
        try {
            var data = await api('contributions/' + encodeURIComponent(current.plantId) + '/photos?page=' + current.page + (current.review ? '&review=1' : ''));
            if (panel !== current) return;             // another plant was opened meanwhile
            current.page = data.page;
            current.data = data;
            // A selection only ever holds photos of the page on screen.
            current.selected = new Set(Array.from(current.selected).filter(function (id) {
                return data.photos.some(function (p) { return p.imageId === id; });
            }));
            renderPanel();
        } catch (err) {
            var host = byId('contribDetail');
            if (host) host.innerHTML = '<p class="admin-notice error">' + esc(err.message) + '</p>';
        }
    }

    var STATUS_LABEL = { candidate: 'Waiting', included: 'Included', excluded: 'Excluded' };

    function renderPanel() {
        var host = byId('contribDetail');
        if (!host || !panel) return;
        var d = panel.data;
        if (!d) { host.innerHTML = '<p class="request-detail-muted">Loading&hellip;</p>'; return; }

        var waitingOnPage = d.photos.filter(function (p) { return p.trainingStatus === 'candidate'; }).length;
        var parts = d.parts || [];
        var partOptions = '<option value="">(keep part)</option>' + parts.map(function (p) {
            return '<option value="' + esc(p) + '">' + esc(p) + '</option>';
        }).join('');
        var allSelected = d.photos.length > 0 && panel.selected.size === d.photos.length;
        var target = panel.target;

        var head =
            '<div class="contrib-detail-head">' +
                '<strong>' + esc(plantLabel(d)) + '</strong>' +
                '<span>' + d.counts.total + ' photos &middot; ' + d.counts.candidate + ' waiting &middot; ' + d.counts.included + ' included &middot; ' + d.counts.excluded + ' excluded</span>' +
                '<label class="contrib-inline">Show <select id="contribReview">' +
                    '<option value="0" ' + (panel.review ? '' : 'selected') + '>All photos</option>' +
                    '<option value="1" ' + (panel.review ? 'selected' : '') + '>Waiting only</option></select></label>' +
            '</div>';

        var tools =
            '<div class="contrib-tools">' +
                '<div class="contrib-tool">' +
                    '<label class="contrib-inline"><input type="checkbox" id="contribSelectAll" ' + (allSelected ? 'checked' : '') + ' ' + (d.photos.length ? '' : 'disabled') + '> Select all on this page</label>' +
                    '<span class="contrib-selected">' + panel.selected.size + ' selected</span>' +
                '</div>' +
                '<div class="contrib-tool contrib-move">' +
                    '<label for="contribTargetSearch">Move selected to</label>' +
                    '<input type="text" id="contribTargetSearch" placeholder="Search a plant name&hellip;" autocomplete="off" value="' + esc(panel.search || '') + '">' +
                    (panel.results.length ? '<ul class="contrib-results">' + panel.results.map(function (r) {
                        return '<li><button type="button" data-target="' + esc(r.plantId) + '" data-label="' + esc(plantLabel(r)) + '">' + esc(plantLabel(r)) + '</button></li>';
                    }).join('') + '</ul>' : '') +
                    (target ? '<div class="contrib-target">&rarr; <strong>' + esc(target.label) + '</strong> <button type="button" class="plant-photo-btn" data-clear-target>Clear</button></div>' : '') +
                    '<button type="button" class="plant-photo-btn contrib-move-btn" data-move ' + (target && panel.selected.size && !panel.busy ? '' : 'disabled') + '>Move ' + panel.selected.size + ' photo' + (panel.selected.size === 1 ? '' : 's') + '</button>' +
                '</div>' +
                '<div class="contrib-tool contrib-include">' +
                    '<label for="contribPart">Part (optional)</label>' +
                    '<select id="contribPart">' + partOptions + '</select>' +
                    '<button type="button" class="plant-photo-btn contrib-include-btn" data-include ' + (waitingOnPage && !panel.busy && !d.unassigned ? '' : 'disabled') + ' title="' + (d.unassigned ? 'These photos have no plant yet: move them to the right plant first' : 'Every photo on this page is correct: put the waiting ones in the dataset') + '">Include this page in dataset (' + waitingOnPage + ')</button>' +
                '</div>' +
            '</div>';

        var grid;
        if (d.photos.length === 0) {
            grid = '<p class="request-detail-muted">' + (panel.review ? 'No photos waiting for this plant.' : 'No contributions for this plant.') + '</p>';
        } else {
            grid = '<div class="contrib-grid">' + d.photos.map(function (p) {
                var checked = panel.selected.has(p.imageId);
                return '<figure class="contrib-photo ' + (checked ? 'is-selected' : '') + ' status-' + esc(p.trainingStatus) + '" data-image="' + esc(p.imageId) + '">' +
                    '<label class="contrib-pick"><input type="checkbox" data-pick="' + esc(p.imageId) + '" ' + (checked ? 'checked' : '') + ' aria-label="Select this photo"></label>' +
                    '<a href="' + esc(p.previewUrl) + '" target="_blank" rel="noopener" title="Open the photo in a new tab"><img src="' + esc(p.previewUrl) + '" alt="Scan contribution" loading="lazy"></a>' +
                    '<figcaption>' +
                        '<div class="plant-photo-badges">' +
                            '<span class="plant-photo-badge scan-badge">' + esc(percent(p.confidence) || 'Scan') + '</span>' +
                            '<span class="plant-photo-badge contrib-status ' + esc(p.trainingStatus) + '">' + esc(STATUS_LABEL[p.trainingStatus] || p.trainingStatus) + '</span>' +
                            (p.part ? '<span class="plant-photo-badge">' + esc(p.part) + '</span>' : '') +
                        '</div>' +
                        '<div class="plant-photo-by">' + esc(p.uploadedByName || '') + ' &middot; ' + esc(date(p.uploadedAt)) + (p.modelId ? ' &middot; ' + esc(p.modelId) : '') + '</div>' +
                        (p.trainingStatus === 'excluded' && p.trainingReason ? '<div class="plant-photo-by">Excluded: ' + esc(p.trainingReason) + '</div>' : '') +
                        '<div class="contrib-actions">' +
                            '<button type="button" class="plant-photo-btn" data-move-one="' + esc(p.imageId) + '" aria-expanded="' + (panel.moving === p.imageId ? 'true' : 'false') + '" title="Move this photo to the right plant">Move</button>' +
                            (p.trainingStatus !== 'excluded'
                                ? '<button type="button" class="plant-photo-btn" data-exclude="' + esc(p.imageId) + '" title="Keep this photo out of the dataset (it fits no plant, or it is bad)">Exclude</button>' : '') +
                        '</div>' +
                        (panel.moving === p.imageId
                            ? '<div class="contrib-move-one">' +
                                '<input type="text" data-move-search placeholder="Move to plant&hellip;" autocomplete="off" value="' + esc(panel.moveSearch || '') + '">' +
                                (panel.moveResults.length ? '<ul class="contrib-results">' + panel.moveResults.map(function (r) {
                                    return '<li><button type="button" data-move-to="' + esc(r.plantId) + '" data-label="' + esc(plantLabel(r)) + '">' + esc(plantLabel(r)) + '</button></li>';
                                }).join('') + '</ul>' : (panel.moveSearch && panel.moveSearch.trim().length >= 2 && !panel.moveBusySearch ? '<p class="plant-photo-by">No plant found.</p>' : '')) +
                              '</div>' : '') +
                    '</figcaption></figure>';
            }).join('') + '</div>';
        }

        var pager = d.pages > 1
            ? '<div class="plant-photo-pager"><button type="button" class="plant-photo-btn" data-ppage="prev" ' + (d.page <= 1 ? 'disabled' : '') + '>&lsaquo; Prev</button>' +
              '<span>Page ' + d.page + ' of ' + d.pages + ' &middot; ' + d.total + ' photo' + (d.total === 1 ? '' : 's') + '</span>' +
              '<button type="button" class="plant-photo-btn" data-ppage="next" ' + (d.page >= d.pages ? 'disabled' : '') + '>Next &rsaquo;</button></div>'
            : '';

        // Keep the typing position and the chosen part while the panel redraws.
        var keepFocus = document.activeElement && document.activeElement.id === 'contribTargetSearch';
        var keepMoveFocus = document.activeElement && document.activeElement.hasAttribute && document.activeElement.hasAttribute('data-move-search');
        var keepPart = byId('contribPart') ? byId('contribPart').value : '';
        host.innerHTML = head + tools + grid + pager;
        if (keepPart && byId('contribPart')) byId('contribPart').value = keepPart;
        if (keepMoveFocus) { var mi = host.querySelector('[data-move-search]'); if (mi) { mi.focus(); mi.setSelectionRange(mi.value.length, mi.value.length); } }
        if (keepFocus) { var input = byId('contribTargetSearch'); input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    }

    /* ------------------------------------------------------------------ actions */

    var searchTimer = null;
    function searchTargets(text) {
        panel.search = text;
        clearTimeout(searchTimer);
        if (text.trim().length < 2) { panel.results = []; renderPanel(); return; }
        var current = panel;
        searchTimer = setTimeout(async function () {
            try {
                var data = await api('plant-search?q=' + encodeURIComponent(text.trim()));
                if (panel !== current || current.search !== text) return;
                // The plant the photos are on is never a target.
                current.results = (data.plants || []).filter(function (p) { return p.plantId !== current.plantId; });
                renderPanel();
            } catch (err) { message('error', err.message); }
        }, 250);
    }

    var moveTimer = null;
    function searchMoveTargets(text) {
        panel.moveSearch = text;
        clearTimeout(moveTimer);
        if (text.trim().length < 2) { panel.moveResults = []; renderPanel(); return; }
        var current = panel;
        moveTimer = setTimeout(async function () {
            try {
                var data = await api('plant-search?q=' + encodeURIComponent(text.trim()));
                if (panel !== current || current.moveSearch !== text) return;
                current.moveResults = (data.plants || []).filter(function (p) { return p.plantId !== current.plantId; });
                renderPanel();
            } catch (err) { message('error', err.message); }
        }, 250);
    }

    function toggleMoveOne(imageId) {
        panel.moving = panel.moving === imageId ? null : imageId;
        panel.moveSearch = ''; panel.moveResults = [];
        renderPanel();
        var input = section.querySelector('[data-move-search]');
        if (input) input.focus();
    }

    async function moveOne(imageId, toPlantId, label) {
        if (!panel || panel.busy) return;
        var from = panel.data ? plantLabel(panel.data) : panel.plantId;
        if (!window.confirm('Move this photo from ' + from + ' to ' + label + '?\n\n' +
            'It goes back to "waiting" and has to be checked again under the new plant.')) return;
        panel.busy = true; message('none');
        try {
            await post('contributions/move', { fromPlantId: panel.plantId, toPlantId: toPlantId, imageIds: [imageId] });
            panel.busy = false; panel.moving = null; panel.moveSearch = ''; panel.moveResults = [];
            panel.selected.delete(imageId);
            await afterChange('Moved the photo to ' + label + '.');
        } catch (err) {
            panel.busy = false; message('error', err.message);
        }
    }

    async function afterChange(okText) {
        message('ok', okText);
        await loadGroups();          // counts changed, and a plant with no photos left drops out of the list
        if (panel && !state.groups.some(function (g) { return g.plantId === panel.plantId; }) && panel.data && panel.data.counts.total === 0) panel = null;
        if (panel) { await loadPanel(); } else { renderGroups(); }
    }

    async function moveSelected() {
        if (!panel || !panel.target || panel.selected.size === 0 || panel.busy) return;
        var ids = Array.from(panel.selected);
        var from = panel.data ? plantLabel(panel.data) : panel.plantId;
        if (!window.confirm('Move ' + ids.length + ' photo' + (ids.length === 1 ? '' : 's') + ' from ' + from + ' to ' + panel.target.label + '?\n\n' +
            'They go back to "waiting" and have to be checked again under the new plant.')) return;
        panel.busy = true; renderPanel(); message('none');
        var target = panel.target;
        try {
            var result = await post('contributions/move', { fromPlantId: panel.plantId, toPlantId: target.plantId, imageIds: ids });
            panel.selected = new Set(); panel.target = null; panel.results = []; panel.search = '';
            panel.busy = false;
            await afterChange('Moved ' + result.moved + ' photo' + (result.moved === 1 ? '' : 's') + ' to ' + target.label + '.');
        } catch (err) {
            panel.busy = false; renderPanel(); message('error', err.message);
        }
    }

    async function includePage() {
        if (!panel || !panel.data || panel.busy) return;
        var ids = panel.data.photos.map(function (p) { return p.imageId; });
        var waiting = panel.data.photos.filter(function (p) { return p.trainingStatus === 'candidate'; }).length;
        if (waiting === 0) return;
        var part = byId('contribPart') ? byId('contribPart').value : '';
        if (!window.confirm('Include the ' + waiting + ' waiting photo' + (waiting === 1 ? '' : 's') + ' on this page of ' + plantLabel(panel.data) + ' in the dataset?\n\n' +
            'Check first that every photo on this page really is this plant. Photos already included or excluded are left as they are.')) return;
        panel.busy = true; renderPanel(); message('none');
        try {
            var result = await post('contributions/include', { plantId: panel.plantId, imageIds: ids, part: part });
            panel.busy = false;
            await afterChange('Included ' + result.included + ' photo' + (result.included === 1 ? '' : 's') + ' in the dataset' +
                (result.leftAlone ? ' (' + result.leftAlone + ' already decided, left alone)' : '') + '.');
        } catch (err) {
            panel.busy = false; renderPanel(); message('error', err.message);
        }
    }

    async function excludeOne(imageId) {
        if (!panel || panel.busy) return;
        var reason = window.prompt('Exclude this photo from the dataset?\n\nReason (optional):', '');
        if (reason === null) return;
        panel.busy = true; message('none');
        try {
                await post('contributions/exclude', { plantId: panel.plantId, imageIds: [imageId], reason: reason.trim().slice(0, 255) });
            panel.busy = false;
            await afterChange('Photo excluded.');
        } catch (err) {
            panel.busy = false; message('error', err.message);
        }
    }

    /* ------------------------------------------------------------------ wiring */

    function wire() {
        var details = section.querySelector('details.collapse');

        details.addEventListener('toggle', function () {
            if (details.open && !state.loaded) loadGroups();
        });
        if (details.open && !state.loaded) loadGroups();

        byId('contribFilter').addEventListener('change', function (e) {
            state.review = e.target.value === '1';
            state.page = 1;
            panel = null;
            loadGroups();
        });

        section.addEventListener('click', function (e) {
            var open = e.target.closest('[data-open]');
            if (open) { openPlant(open.dataset.open); return; }
            var gpage = e.target.closest('[data-gpage]');
            if (gpage && !gpage.disabled) {
                var v = gpage.dataset.gpage;
                state.page = v === 'prev' ? Math.max(1, state.page - 1) : v === 'next' ? Math.min(state.pages, state.page + 1) : parseInt(v, 10);
                panel = null;
                loadGroups();
                return;
            }
            if (!panel) return;
            var ppage = e.target.closest('[data-ppage]');
            if (ppage && !ppage.disabled) {
                panel.page = ppage.dataset.ppage === 'prev' ? Math.max(1, panel.page - 1) : panel.page + 1;
                panel.data = null; renderPanel(); loadPanel();
                return;
            }
            var pick = e.target.closest('[data-target]');
            if (pick) {
                panel.target = { plantId: pick.dataset.target, label: pick.dataset.label };
                panel.results = []; panel.search = ''; renderPanel();
                return;
            }
            if (e.target.closest('[data-clear-target]')) { panel.target = null; renderPanel(); return; }
            if (e.target.closest('[data-move]')) { moveSelected(); return; }
            if (e.target.closest('[data-include]')) { includePage(); return; }
            var mo = e.target.closest('[data-move-one]');
            if (mo) { toggleMoveOne(mo.dataset.moveOne); return; }
            var mt = e.target.closest('[data-move-to]');
            if (mt && panel.moving) { moveOne(panel.moving, mt.dataset.moveTo, mt.dataset.label); return; }
            var ex = e.target.closest('[data-exclude]');
            if (ex) { excludeOne(ex.dataset.exclude); }
        });

        section.addEventListener('change', function (e) {
            if (!panel) return;
            if (e.target.id === 'contribReview') {
                panel.review = e.target.value === '1'; panel.page = 1; panel.data = null; panel.selected = new Set();
                renderPanel(); loadPanel();
                return;
            }
            if (e.target.id === 'contribSelectAll') {
                panel.selected = e.target.checked && panel.data ? new Set(panel.data.photos.map(function (p) { return p.imageId; })) : new Set();
                renderPanel();
                return;
            }
            if (e.target.matches && e.target.matches('[data-pick]')) {
                if (e.target.checked) panel.selected.add(e.target.dataset.pick); else panel.selected.delete(e.target.dataset.pick);
                renderPanel();
            }
        });

        section.addEventListener('input', function (e) {
            if (!panel) return;
            if (e.target.id === 'contribTargetSearch') searchTargets(e.target.value);
            else if (e.target.hasAttribute && e.target.hasAttribute('data-move-search')) searchMoveTargets(e.target.value);
        });
    }

    document.addEventListener('DOMContentLoaded', function () {
        section = byId('contributionsSection');
        if (!section) return;
        wire();
    });
})();
