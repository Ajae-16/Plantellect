/**
 * "Other plant inbox" section of the admin Dataset page (Database view).
 *
 * Scan contributions the model called "Other plant" have no plant yet. This section lists all of them, lets the model
 * suggest which EXISTING plant each one (or each group of look-alikes) resembles, and files a whole batch under a plant
 * in one step. Afterwards it says whether that plant now has enough unique photos to be promoted.
 *
 * Talks to /admin/api/dataset/db/other-plant* (routes/admin-dataset.js). Self-initialising; returns at once when
 * #otherSection is absent. Nothing is changed without a confirmation, and the server re-checks every id.
 */
(function () {
    'use strict';

    var API = '/admin/api/dataset/db/';
    var section = document.getElementById('otherSection');
    if (!section) return;

    var st = {
        page: 1, data: null, selected: new Set(), cap: 500, target: null, suggestions: {}, groups: null,
        busy: false, results: [], loaded: false
    };
    var searchTimer = null;

    function $(id) { return document.getElementById(id); }
    function esc(value) { var d = document.createElement('div'); d.textContent = String(value == null ? '' : value); return d.innerHTML; }
    function percent(v) { return typeof v === 'number' && isFinite(v) ? (v * 100).toFixed(1) + '%' : ''; }
    function whole(v) { return typeof v === 'number' && isFinite(v) ? Math.round(v * 100) + '%' : ''; }
    function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }
    function label(p) { return p.scientificName + (p.commonName && p.commonName !== p.scientificName ? ' (' + p.commonName + ')' : ''); }
    function previewUrl(id) { return '/admin/api/plant-images/' + encodeURIComponent(id); }

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
        var el = $('opNotice');
        el.hidden = !text;
        el.textContent = text || '';
        el.className = 'admin-notice' + (kind === 'error' ? ' error' : '');
    }

    // ------------------------------------------------------------------ the list
    function query() {
        var p = new URLSearchParams();
        p.set('page', st.page);
        if ($('opReview').value === '1') p.set('review', '1');
        p.set('sort', $('opSort').value);
        if ($('opModel').value) p.set('modelId', $('opModel').value);
        var min = parseFloat($('opMin').value);
        if (isFinite(min) && min > 0) p.set('min', String(Math.min(100, min) / 100));
        return p.toString();
    }

    async function load() {
        try {
            var d = await api('other-plant?' + query());
            st.data = d;
            st.page = d.page;
            st.loaded = true;
            fillModels(d.models || []);
            fillParts(d.parts || []);
            var badge = $('opCount');
            badge.hidden = !(d.counts.candidate > 0);
            badge.textContent = d.counts.candidate > 99 ? '99+' : String(d.counts.candidate);
            renderGrid();
        } catch (err) {
            $('opGrid').innerHTML = '<p class="admin-notice error">' + esc(err.message) + '</p>';
        }
    }

    function fillModels(models) {
        var sel = $('opModel'), keep = sel.value;
        sel.innerHTML = '<option value="">Any model</option>' + models.map(function (m) { return '<option value="' + esc(m) + '">' + esc(m) + '</option>'; }).join('');
        sel.value = models.indexOf(keep) >= 0 ? keep : '';
    }
    function fillParts(parts) {
        var sel = $('opPart'), keep = sel.value;
        sel.innerHTML = '<option value="">(none)</option>' + parts.map(function (p) { return '<option value="' + esc(p) + '">' + esc(p) + '</option>'; }).join('');
        sel.value = parts.indexOf(keep) >= 0 ? keep : '';
    }

    var STATUS = { candidate: 'Waiting', excluded: 'Excluded', included: 'Included' };

    function suggestionButtons(id) {
        var list = st.suggestions[id];
        if (!list || !list.length) return st.suggestions[id] ? '<span class="ds-muted">No close plant</span>' : '';
        return list.slice(0, 2).map(function (s) {
            var picked = st.target && st.target.plantId === s.plantId;
            return '<button type="button" class="op-suggest ' + (picked ? 'picked' : '') + '" data-suggest="' + esc(s.plantId) + '" data-label="' + esc(label(s)) + '" title="Best single match ' + esc(whole(s.best)) + '">&rarr; ' +
                esc(s.scientificName) + ' &middot; ' + esc(whole(s.score)) + '</button>';
        }).join('');
    }

    function renderGrid() {
        var d = st.data, grid = $('opGrid');
        if (!d) return;
        if (d.photos.length === 0) {
            grid.innerHTML = '<p class="ds-muted">' + (d.counts.total === 0 ? 'The inbox is empty. Photos arrive here when a scan contribution is labelled Other plant.' : 'No photo matches this filter.') + '</p>';
        } else {
            grid.innerHTML = d.photos.map(function (p) {
                var on = st.selected.has(p.imageId);
                return '<figure class="op-photo ' + (on ? 'is-selected' : '') + ' status-' + esc(p.trainingStatus) + '" data-lockkey="photo:' + esc(p.imageId) + '">' +
                    '<label class="op-pick"><input type="checkbox" data-pick="' + esc(p.imageId) + '" ' + (on ? 'checked' : '') + ' aria-label="Select this photo"></label>' +
                    '<a href="' + esc(p.previewUrl) + '" target="_blank" rel="noopener" title="Open the photo"><img src="' + esc(p.previewUrl) + '" alt="Other plant contribution" loading="lazy"></a>' +
                    '<figcaption><div><span class="op-badge">' + esc(percent(p.confidence) || 'Scan') + '</span> <span class="op-badge">' + esc(STATUS[p.trainingStatus] || p.trainingStatus) + '</span></div>' +
                    '<div class="ds-muted">' + esc(p.uploadedByName || '') + (p.modelId ? ' &middot; ' + esc(p.modelId) : '') + '</div>' +
                    (p.trainingStatus === 'excluded' && p.trainingReason ? '<div class="ds-muted">Excluded: ' + esc(p.trainingReason) + '</div>' : '') +
                    suggestionButtons(p.imageId) + '</figcaption></figure>';
            }).join('');
        }
        if (window.DatasetSync) window.DatasetSync.paint(grid);      // "Ben is working on this" on photos another admin has selected
        var pager = $('opPager');
        pager.innerHTML = d.pages > 1
            ? '<button type="button" class="btn" data-ppage="prev" ' + (d.page <= 1 ? 'disabled' : '') + '>Prev</button> <span>Page ' + d.page + ' of ' + d.pages + ' &middot; ' + plural(d.total, 'photo') + '</span> <button type="button" class="btn" data-ppage="next" ' + (d.page >= d.pages ? 'disabled' : '') + '>Next</button>'
            : '<span class="ds-muted">' + plural(d.total, 'photo') + '</span>';
        updateBar();
    }

    // ------------------------------------------------------------------ selection and target
    function updateBar() {
        var n = st.selected.size;
        $('opSelCount').textContent = n + ' selected';
        // The selection is what this admin is working on: other admins see it marked, and the server refuses their changes to it.
        if (window.DatasetSync) {
            window.DatasetSync.setClaims('inbox', Array.from(st.selected).map(function (id) { return 'photo:' + id; }), 'filing');
        }
        var chosen = $('opTarget');
        chosen.innerHTML = st.target ? '&rarr; <strong>' + esc(st.target.label) + '</strong> <button type="button" class="btn" data-clear-target>Clear</button>' : '<span class="ds-muted">no plant chosen</span>';
        var move = $('opMove');
        move.disabled = !(st.target && n > 0 && !st.busy);
        move.textContent = st.target ? 'File ' + plural(n, 'photo') + ' under this plant' : 'File under plant';
        $('opExclude').disabled = !(n > 0 && !st.busy);
        $('opSuggest').disabled = st.busy || !st.data || st.data.photos.length === 0;
        $('opGroup').disabled = st.busy || !st.data || st.data.counts.candidate === 0;
        var list = $('opResults');
        list.hidden = st.results.length === 0;
        list.innerHTML = st.results.map(function (r) {
            return '<li><button type="button" data-target="' + esc(r.plantId) + '" data-label="' + esc(label(r)) + '">' + esc(label(r)) + '</button></li>';
        }).join('');
    }

    function setTarget(plantId, text) {
        st.target = { plantId: plantId, label: text };
        st.results = [];
        $('opTargetSearch').value = '';
        renderGrid();
        renderGroups();
    }

    async function selectAllMatching() {
        try {
            var d = await api('other-plant/ids?' + query());
            d.ids.forEach(function (id) { st.selected.add(id); });
            st.cap = d.cap;
            message(d.capped ? 'error' : 'ok', d.capped
                ? 'Selected the first ' + d.ids.length + ' of ' + d.total + ' matching photos (the most one step can file is ' + d.cap + '). File these, then select again.'
                : 'Selected all ' + plural(d.ids.length, 'matching photo') + '.');
            renderGrid();
        } catch (err) { message('error', err.message); }
    }

    // ------------------------------------------------------------------ suggestions and groups
    function learning(l, embedder, degraded) {
        var el = $('opLearning');
        if (!l) { el.textContent = ''; return; }
        var text = 'Compared with ' + plural(l.referencePhotos, 'photo') + ' of ' + plural(l.referencePlants, 'plant') + ' using ' + embedder + '.';
        if (l.remaining > 0) text += ' ' + plural(l.remaining, 'photo') + ' still to learn: press the button again to continue; the answer gets better each time.';
        if (l.unreadable > 0) text += ' ' + plural(l.unreadable, 'photo') + ' could not be read.';
        if (l.truncated) text += ' Some plants were left out (too many to compare in one go).';
        if (degraded) text += ' This is the weak fallback embedder, so the suggestions are not reliable.';
        el.textContent = text;
    }

    async function guard(fn, button, busyText) {
        if (st.busy) return;
        st.busy = true;
        var old = button && button.textContent;
        if (button) button.textContent = busyText;
        updateBar();
        try { await fn(); } catch (err) { message('error', err.message); } finally {
            st.busy = false;
            if (button) button.textContent = old;
            updateBar();
        }
    }

    function suggest() {
        return guard(async function () {
            var ids = st.data.photos.map(function (p) { return p.imageId; });
            var d = await post('other-plant/suggest', { imageIds: ids, topK: 3 });
            Object.keys(d.suggestions).forEach(function (id) { st.suggestions[id] = d.suggestions[id]; });
            ids.forEach(function (id) { if (!d.suggestions[id] && d.learning.unreadable === 0 && d.learning.remaining === 0) st.suggestions[id] = []; });
            learning(d.learning, d.embedder, d.degraded);
            message('none');
            renderGrid();
        }, $('opSuggest'), 'Comparing...');
    }

    function group() {
        return guard(async function () {
            var pct = parseFloat($('opThreshold').value);
            var d = await post('other-plant/groups', { threshold: isFinite(pct) ? pct / 100 : undefined, topK: 3 });
            st.groups = d.groups;
            learning(d.learning, d.embedder, d.degraded);
            message('none');
            renderGroups();
        }, $('opGroup'), 'Grouping...');
    }

    function stateText(s) {
        if (s.state === 'supported') return 'already supported';
        if (s.state === 'promoted') return 'promoted, waiting for a retrain';
        return s.uniquePhotos === null ? '' : s.uniquePhotos + ' of ' + s.minimum + ' unique photos';
    }

    function renderGroups() {
        var host = $('opGroups');
        if (!st.groups) { host.innerHTML = ''; return; }
        if (st.groups.length === 0) { host.innerHTML = '<p class="ds-muted">No waiting photos to group.</p>'; return; }
        host.innerHTML = st.groups.map(function (g, gi) {
            var sug = (g.suggestions || []).map(function (s) {
                var picked = st.target && st.target.plantId === s.plantId;
                var after = s.state === 'other_plant' && s.uniquePhotos !== null ? ' &rarr; about ' + (s.uniquePhotos + g.size) + '/' + s.minimum + ' after filing' : '';
                return '<button type="button" class="op-suggest ' + (picked ? 'picked' : '') + '" data-group-use="' + gi + '" data-plant="' + esc(s.plantId) + '" data-label="' + esc(label(s)) + '">' +
                    esc(label(s)) + ' &middot; ' + esc(whole(s.score)) + ' (' + esc(stateText(s)) + after + ')</button>';
            }).join('');
            var close = g.suggestions && g.suggestions[1] && g.suggestions[0].margin !== undefined && g.suggestions[0].margin < 0.05
                ? '<div class="ds-muted">Close call between the first two plants: look at the photos.</div>' : '';
            return '<div class="op-group"><div class="op-group-head"><strong>' + plural(g.size, 'photo') + '</strong>' +
                '<span class="ds-muted">' + esc(whole(g.cohesion)) + ' alike</span>' +
                '<button type="button" class="btn" data-group-select="' + gi + '">Select this group</button></div>' +
                '<div class="op-thumbs">' + g.ids.slice(0, 8).map(function (id) { return '<img src="' + esc(previewUrl(id)) + '" alt="" loading="lazy">'; }).join('') +
                (g.ids.length > 8 ? '<span class="ds-muted">+' + (g.ids.length - 8) + ' more</span>' : '') + '</div>' +
                (sug || '<div class="ds-muted">Looks like no existing plant. It may be a new species: add the plant first (Plants page), then file the group under it.</div>') + close + '</div>';
        }).join('');
    }

    // ------------------------------------------------------------------ changing things
    function afterFiled(ids) {
        ids.forEach(function (id) { st.selected.delete(id); delete st.suggestions[id]; });
        if (st.groups) {
            var gone = new Set(ids);
            st.groups = st.groups.map(function (g) {
                var left = g.ids.filter(function (id) { return !gone.has(id); });
                return Object.assign({}, g, { ids: left, size: left.length });
            }).filter(function (g) { return g.size > 0; });
        }
        document.dispatchEvent(new CustomEvent('dataset:changed'));
    }

    function showPromotion(plant, moved) {
        var host = $('opPromo');
        if (!host) {
            host = document.createElement('div');
            host.id = 'opPromo';
            $('opNotice').insertAdjacentElement('afterend', host);
        }
        if (!plant) { host.hidden = true; return; }
        var text;
        if (plant.state === 'supported') text = 'The active model already lists ' + plant.scientificName + '. The photos will help the next retrain.';
        else if (plant.state === 'promoted') text = plant.scientificName + ' is already promoted and waits for a retrain.';
        else if (plant.minimumMet) text = plant.scientificName + ' now has ' + plant.uniquePhotos + ' unique photos (the minimum is ' + plant.minimum + '). It can be promoted.';
        else text = plant.scientificName + ' has ' + plant.uniquePhotos + ' of the ' + plant.minimum + ' unique photos it needs before it can be promoted.';
        host.hidden = false;
        host.className = 'op-promo';
        host.innerHTML = '<span>' + esc(text) + '</span> ' + (plant.canPromote ? '<button type="button" class="btn btn-primary" data-promote="' + esc(plant.plantId) + '">Promote now</button>' : '');
    }

    async function assign() {
        if (!st.target || st.selected.size === 0) return;
        var ids = Array.from(st.selected), include = $('opInclude').checked, target = st.target;
        var ok = window.confirm('File ' + plural(ids.length, 'photo') + ' under ' + target.label + '?\n\n' +
            (include ? 'Photos that are waiting are also INCLUDED in the dataset, so check first that every one really is this plant.\n' : 'They go to "waiting" and have to be included under the plant afterwards.\n') +
            'The photos leave the Other plant inbox.');
        if (!ok) return;
        await guard(async function () {
            var r = await post('other-plant/assign', { toPlantId: target.plantId, imageIds: ids, include: include, part: $('opPart').value });
            message('ok', 'Filed ' + plural(r.moved, 'photo') + ' under ' + target.label + (include ? '; ' + r.included + ' included in the dataset' + (r.leftForReview ? ', ' + r.leftForReview + ' left to check' : '') : '') + '.');
            showPromotion(r.plant, r.moved);
            afterFiled(ids);
            await load();
            renderGroups();
        }, $('opMove'), 'Filing...');
    }

    async function exclude() {
        if (st.selected.size === 0) return;
        var reason = window.prompt('Exclude ' + plural(st.selected.size, 'photo') + ' from the dataset?\n\nReason (optional):', '');
        if (reason === null) return;
        var ids = Array.from(st.selected);
        await guard(async function () {
            for (var i = 0; i < ids.length; i += 200) {          // one request may name at most DATASET_MAX_BULK photos
                await post('contributions/exclude', { plantId: '_unassigned', imageIds: ids.slice(i, i + 200), reason: reason.trim().slice(0, 255) });
            }
            ids.forEach(function (id) { st.selected.delete(id); });
            message('ok', 'Excluded ' + plural(ids.length, 'photo') + '.');
            await load();
        }, $('opExclude'), 'Excluding...');
    }

    async function promote(plantId) {
        await guard(async function () {
            var r = await post('/admin/api/dataset/species/promote', { plantId: plantId });
            message('ok', r.species && r.species.scientificName ? r.species.scientificName + ' is promoted. A retrained model will make scans identify it.' : 'Promoted.');
            showPromotion(null);
            document.dispatchEvent(new CustomEvent('dataset:changed'));
        });
    }

    // ------------------------------------------------------------------ the embedder
    async function loadEmbedders() {
        var sel = $('opEmbedder');
        try {
            var d = await api('other-plant/embedders');
            sel.innerHTML = d.available.map(function (e) { return '<option value="' + esc(e.kind) + '">' + esc(e.label) + '</option>'; }).join('');
            var current = d.current;
            if (current === 'auto' || current === 'saved') current = (d.loaded && d.loaded.kind) || 'mobilenet';
            sel.value = d.available.some(function (e) { return e.kind === current; }) ? current : 'mobilenet';
            var stored = Object.keys(d.stored || {}).map(function (k) { return k + ': ' + d.stored[k]; }).join(', ');
            $('opEmbedderState').textContent = (d.loaded && d.loaded.name ? 'Loaded: ' + d.loaded.name + '. ' : 'Not loaded yet. ') + (stored ? 'Photos learned: ' + stored + '.' : '');
            sel.disabled = false;
            $('opEmbedderSave').disabled = false;
        } catch (err) {
            sel.disabled = true;
            $('opEmbedderSave').disabled = true;
            $('opEmbedderState').textContent = err.message;
        }
    }

    async function chooseEmbedder() {
        await guard(async function () {
            var r = await post('other-plant/embedder', { kind: $('opEmbedder').value });
            st.suggestions = {};
            st.groups = null;
            learning(null);
            message('ok', 'Now comparing photos with ' + r.name + '.' + (r.degraded ? ' This is the weak fallback.' : ''));
            await loadEmbedders();
            renderGrid();
            renderGroups();
            document.dispatchEvent(new CustomEvent('dataset:embedder', { detail: { source: 'other-plant' } }));
        }, $('opEmbedderSave'), 'Loading...');
    }

    // ------------------------------------------------------------------ wiring
    function reset() { st.page = 1; st.selected = new Set(); load(); }

    function wire() {
        ['opReview', 'opSort', 'opModel'].forEach(function (id) { $(id).addEventListener('change', reset); });
        $('opMin').addEventListener('change', reset);
        $('opSuggest').addEventListener('click', suggest);
        $('opGroup').addEventListener('click', group);
        $('opEmbedderSave').addEventListener('click', chooseEmbedder);
        $('opSelPage').addEventListener('click', function () {
            st.data.photos.forEach(function (p) { st.selected.add(p.imageId); });
            renderGrid();
        });
        $('opSelAll').addEventListener('click', selectAllMatching);
        $('opSelClear').addEventListener('click', function () { st.selected = new Set(); renderGrid(); });
        $('opMove').addEventListener('click', assign);
        $('opExclude').addEventListener('click', exclude);
        $('opTargetSearch').addEventListener('input', function (e) {
            var text = e.target.value.trim();
            clearTimeout(searchTimer);
            if (text.length < 2) { st.results = []; updateBar(); return; }
            searchTimer = setTimeout(async function () {
                try { st.results = (await api('plant-search?q=' + encodeURIComponent(text))).plants || []; updateBar(); } catch (err) { message('error', err.message); }
            }, 250);
        });

        section.addEventListener('change', function (e) {
            var pick = e.target.closest('[data-pick]');
            if (!pick) return;
            if (pick.checked) st.selected.add(pick.dataset.pick); else st.selected.delete(pick.dataset.pick);
            pick.closest('.op-photo').classList.toggle('is-selected', pick.checked);
            updateBar();
        });
        section.addEventListener('click', function (e) {
            var t;
            if ((t = e.target.closest('[data-target]'))) { setTarget(t.dataset.target, t.dataset.label); return; }
            if ((t = e.target.closest('[data-suggest]'))) { setTarget(t.dataset.suggest, t.dataset.label); return; }
            if (e.target.closest('[data-clear-target]')) { st.target = null; renderGrid(); renderGroups(); return; }
            if ((t = e.target.closest('[data-ppage]'))) {
                if (t.disabled) return;
                st.page = t.dataset.ppage === 'prev' ? Math.max(1, st.page - 1) : st.page + 1;
                load();
                return;
            }
            if ((t = e.target.closest('[data-group-select]'))) {
                st.groups[+t.dataset.groupSelect].ids.forEach(function (id) { st.selected.add(id); });
                message('ok', 'Group selected. Choose the plant, then file it.');
                renderGrid();
                return;
            }
            if ((t = e.target.closest('[data-group-use]'))) {
                var g = st.groups[+t.dataset.groupUse];
                st.selected = new Set(g.ids);
                setTarget(t.dataset.plant, t.dataset.label);
                message('ok', plural(g.ids.length, 'photo') + ' selected for ' + t.dataset.label + '. Look at them, then press "File under this plant".');
                return;
            }
            if ((t = e.target.closest('[data-promote]'))) { promote(t.dataset.promote); }
        });
    }

    function start() {
        wire();
        var details = section.querySelector('details.collapse');
        var embeddersLoaded = false;
        var onOpen = function () {
            if (embeddersLoaded) return;
            embeddersLoaded = true;
            loadEmbedders();                  // asks the ML service: only when the section is actually opened
        };
        details.addEventListener('toggle', function () { if (details.open) onOpen(); });
        if (details.open) onOpen();
        load();                               // one cheap query, so the tab's count shows while the section is still closed
        // The banner's Refresh button (admin-dataset.js): another admin filed or excluded photos, so the inbox is stale.
        document.addEventListener('dataset:refresh', function () {
            st.suggestions = {};
            load().then(function () {
                // Photos that are gone from the inbox cannot stay selected.
                var here = new Set((st.data ? st.data.photos : []).map(function (p) { return p.imageId; }));
                st.selected.forEach(function (id) { if (!here.has(id)) st.selected.delete(id); });
                renderGrid();
            });
        });
        // The audit's quick settings (Dataset > Overview) use the same model: keep both in step.
        document.addEventListener('dataset:embedder', function (e) {
            if (e.detail && e.detail.source === 'other-plant') return;
            st.suggestions = {};
            st.groups = null;
            learning(null);
            if (embeddersLoaded) loadEmbedders();
            renderGrid();
            renderGroups();
        });
        updateBar();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
