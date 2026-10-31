/**
 * Dataset page (admin-dataset.html). Every value from the server goes onto the page with textContent,
 * never innerHTML. Photos are shown by an opaque id (pid); no file path is ever used.
 */
(function () {
    'use strict';

    var LABEL = { CROSS_CLASS: 'Other plant', LEAK: 'Split leak', SIMILAR_LEAK: 'Similar across splits', REDUNDANT: 'Duplicate in a split' };
    var HELP = {
        CROSS_CLASS: 'The same photo is filed under two different classes, so at least one label is wrong. Remove the wrong one.',
        LEAK: 'The same photo (or a copy) sits in two of train / val / test. Keep it in train and remove the copy from val or test. If they should stay together instead, use "Keep together".',
        SIMILAR_LEAK: 'Very alike but not identical (a burst or a re-crop) in different splits. Remove one, keep both, or tick them and use "Keep together" so the next split puts them in the same place.',
        REDUNDANT: 'The same photo twice inside one split and class. Keep one; the copy only adds weight.'
    };
    var state = { cat: '', reviewed: false, page: 1, mPage: 1, parts: [], timer: null };
    var ex = { params: {}, page: 1, selected: {}, parent: null, dest: null };

    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
    }
    function $(id) { return document.getElementById(id); }
    function when(iso) { return iso ? new Date(iso).toLocaleString() : ''; }

    function note(text, isError) {
        var n = $('dsNotice');
        n.hidden = !text;
        n.textContent = text || '';
        n.className = 'admin-notice' + (isError ? ' error' : '');
        if (text) n.scrollIntoView({ block: 'nearest' });
    }
    function fail(err) { note(err.message, true); }

    async function api(url, options) {
        var response = await fetch(url, Object.assign({ credentials: 'include' }, options || {}));
        var data = null;
        try { data = await response.json(); } catch (e) { /* no body */ }
        if (!response.ok) throw new Error((data && data.error) || 'Request failed (' + response.status + ')');
        return data;
    }
    function post(url, body) {
        return api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    }
    function qs(o) {
        var p = new URLSearchParams();
        Object.keys(o).forEach(function (k) { if (o[k] !== '' && o[k] != null) p.set(k, o[k]); });
        var s = p.toString();
        return s ? '?' + s : '';
    }
    // The hash lets the server send a thumbnail that already exists straight from disk.
    function thumbUrl(pid, sha) { return '/admin/api/dataset/thumb/' + encodeURIComponent(pid) + (sha ? '?s=' + encodeURIComponent(sha) : ''); }

    function thumb(pid, alt, sha) {
        var img = el('img', 'ds-thumb');
        img.loading = 'lazy';
        img.decoding = 'async';
        img.alt = alt || '';
        img.src = thumbUrl(pid, sha);
        img.addEventListener('error', function () { img.classList.add('missing'); });
        return img;
    }

    function pager(host, total, page, size, onPage) {
        host.innerHTML = '';
        var pages = Math.max(1, Math.ceil(total / size));
        if (pages <= 1) return;
        var prev = el('button', 'btn', 'Previous'); prev.type = 'button'; prev.disabled = page <= 1;
        var next = el('button', 'btn', 'Next'); next.type = 'button'; next.disabled = page >= pages;
        prev.addEventListener('click', function () { onPage(page - 1); });
        next.addEventListener('click', function () { onPage(page + 1); });
        host.appendChild(prev);
        host.appendChild(el('span', 'ds-muted', 'Page ' + page + ' of ' + pages));
        host.appendChild(next);
    }

    // ------------------------------------------------------------------ overview
    function stat(label, value, tone) {
        var box = el('div', 'ds-stat' + (tone ? ' ' + tone : ''));
        box.appendChild(el('strong', null, String(value)));
        box.appendChild(el('span', null, label));
        return box;
    }

    async function loadOverview() {
        var d = await api('/admin/api/dataset/overview');
        var host = $('dsOverview');
        host.innerHTML = '';
        state.parts = d.parts || [];
        host.appendChild(stat('photos', d.photos));
        ['train', 'val', 'test', 'pool'].forEach(function (s) { if (d.bySplit[s]) host.appendChild(stat(s, d.bySplit[s])); });
        host.appendChild(stat('species', d.species.length));
        host.appendChild(stat('removed (quarantine)', d.quarantined));
        var r = d.report;
        if (r) {
            var s = r.summary || {};
            host.appendChild(stat('other-plant clashes', s.CROSS_CLASS || 0, s.CROSS_CLASS ? 'bad' : 'good'));
            host.appendChild(stat('split leaks', s.LEAK || 0, s.LEAK ? 'bad' : 'good'));
            host.appendChild(stat('similar across splits', s.SIMILAR_LEAK || 0, s.SIMILAR_LEAK ? 'warn' : 'good'));
            host.appendChild(stat('duplicates in a split', s.REDUNDANT || 0, s.REDUNDANT ? 'warn' : 'good'));
            host.appendChild(stat('label suspects', s.MISLABEL || 0, s.MISLABEL ? 'warn' : 'good'));
            $('dsMislabelCount').hidden = !(s.MISLABEL || 0);
            $('dsMislabelCount').textContent = String(s.MISLABEL || 0);
        }
        $('dsDegraded').hidden = !(r && r.embedderDegraded);
        var info = r ? 'Last audit ' + when(r.generatedAt) + ' using ' + r.embedder + '.' : 'No audit has run yet.';
        if (r && r.nearestNeighbour && r.nearestNeighbour.p99 != null) {
            info += ' Nearest-neighbour similarity p50 ' + r.nearestNeighbour.p50 + ', p99 ' + r.nearestNeighbour.p99 +
                ' (compare with the thresholds ' + r.thresholds.cos_similar + ' / ' + r.thresholds.cos_same + ').';
        }
        $('dsAuditInfo').textContent = info;
        var list = $('dsWarnings');
        list.innerHTML = '';
        ((r && r.warnings) || []).forEach(function (w) { list.appendChild(el('li', null, w)); });
        if (r && r.warningCount > r.warnings.length) list.appendChild(el('li', 'ds-muted', '... and ' + (r.warningCount - r.warnings.length) + ' more'));
        applyRun(d.run);
    }

    function applyRun(run) {
        $('dsRunAudit').disabled = !!(run && run.running);
        var line = run && run.running ? 'Audit running since ' + when(run.startedAt) + (run.tail && run.tail.length ? ' - ' + run.tail[run.tail.length - 1] : '') : '';
        if (!run.running && run.exitCode != null && run.exitCode !== 0 && run.exitCode !== 2) line = 'The last audit failed: ' + (run.tail || []).slice(-1);
        $('dsRunState').textContent = line;
        if (run && run.running) { if (!state.timer) state.timer = setInterval(poll, 4000); }
        else if (state.timer) { clearInterval(state.timer); state.timer = null; }
    }

    async function poll() {
        try {
            var run = await api('/admin/api/dataset/status');
            applyRun(run);
            if (!run.running) await refreshAll();
        } catch (e) { /* try again next tick */ }
    }

    async function runAudit() {
        $('dsRunAudit').disabled = true;
        try {
            await post('/admin/api/dataset/audit');
            note('The audit started. It runs in the background; this page updates when it finishes.');
            applyRun({ running: true, startedAt: new Date().toISOString() });
        } catch (e) { fail(e); $('dsRunAudit').disabled = false; }
    }

    // ------------------------------------------------------------------ clusters
    function preselect(cluster, m, i) {
        if (cluster.decision || m.gone) return false;
        if (cluster.category === 'LEAK') return m.split !== 'train';
        if (cluster.category === 'REDUNDANT') return i > 0;
        return false;
    }

    function memberCell(m, checked, enabled) {
        var cell = el('label', 'ds-member');
        cell.appendChild(thumb(m.pid, m.label, m.sha256));
        var box = document.createElement('input');
        box.type = 'checkbox'; box.checked = checked; box.disabled = !enabled; box.dataset.pid = m.pid;
        cell.appendChild(box);
        var meta = el('div', 'ds-meta');
        meta.appendChild(el('strong', null, m.label));
        meta.appendChild(el('span', null, [m.split || 'pool', m.part].filter(Boolean).join(' / ')));
        if (m.gone) meta.appendChild(el('span', 'ds-tag done', 'already removed'));
        cell.appendChild(meta);
        return cell;
    }

    function clusterCard(c) {
        var card = el('article', 'ds-card ' + c.category.toLowerCase());
        var head = el('header', 'ds-card-head');
        head.appendChild(el('span', 'ds-tag ' + c.category.toLowerCase(), LABEL[c.category] || c.category));
        head.appendChild(el('span', 'ds-muted', 'match ' + Math.round(c.bestScore * 100) + '% (' + c.how.join(', ') + ')'));
        if (c.decision) head.appendChild(el('span', 'ds-tag done', c.decision));
        card.appendChild(head);
        card.appendChild(el('p', 'ds-help', HELP[c.category] || ''));
        var grid = el('div', 'ds-members');
        var boxes = [];
        c.members.forEach(function (m, i) {
            var cell = memberCell(m, preselect(c, m, i), !c.decision && !m.gone);
            boxes.push(cell.querySelector('input'));
            grid.appendChild(cell);
        });
        card.appendChild(grid);
        if (!c.decision) {
            var actions = el('div', 'ds-card-actions');
            var ticked = function () { return boxes.filter(function (b) { return b.checked; }).map(function (b) { return b.dataset.pid; }); };
            actions.appendChild(button('Remove ticked from the dataset', 'btn-deny', async function () {
                var pids = ticked();
                if (!pids.length) return note('Tick the photo(s) to remove first.', true);
                if (pids.length >= c.members.length && !window.confirm('Every photo of this set is ticked, so none would remain. Continue?')) return;
                var out = await post('/admin/api/dataset/remove', { pids: pids, clusterId: c.id, note: LABEL[c.category] });
                note('Moved ' + out.moved + ' photo(s) to quarantine.');
                await refreshAll();
            }));
            actions.appendChild(button('Keep together', '', async function () {
                var pids = ticked();
                if (pids.length < 2) return note('Tick at least two photos to keep together.', true);
                var out = await post('/admin/api/dataset/group', { pids: pids, clusterId: c.id });
                note('Saved as ' + out.group + '. The next split keeps these photos in the same place.');
                await refreshAll();
            }));
            actions.appendChild(button('Keep all (not a problem)', '', async function () {
                await post('/admin/api/dataset/review', { clusterId: c.id, decision: 'kept' });
                await refreshAll();
            }));
            card.appendChild(actions);
        }
        return card;
    }

    function button(text, cls, fn) {
        var b = el('button', 'btn' + (cls ? ' ' + cls : ''), text);
        b.type = 'button';
        b.addEventListener('click', async function () {
            b.disabled = true;
            try { await fn(); } catch (e) { fail(e); }
            b.disabled = false;
        });
        return b;
    }

    async function loadClusters() {
        var d = await api('/admin/api/dataset/clusters' + qs({ page: state.page, category: state.cat, reviewed: state.reviewed ? 1 : '' }));
        var host = $('dsClusters');
        host.innerHTML = '';
        $('dsClusterCount').hidden = !d.total;
        $('dsClusterCount').textContent = String(d.total);
        if (!d.report) { host.appendChild(el('p', 'ds-muted', 'Run an audit to see results.')); $('dsPager').innerHTML = ''; return; }
        if (!d.clusters.length) host.appendChild(el('p', 'ds-muted', state.reviewed ? 'Nothing reviewed yet.' : 'Nothing to review here.'));
        d.clusters.forEach(function (c) { host.appendChild(clusterCard(c)); });
        pager($('dsPager'), d.total, d.page, d.pageSize, function (p) { state.page = p; loadClusters().catch(fail); });
    }

    // ------------------------------------------------------------------ label suspects
    async function loadMislabels() {
        var d = await api('/admin/api/dataset/mislabels' + qs({ page: state.mPage }));
        var host = $('dsMislabels');
        host.innerHTML = '';
        if (!d.items.length) host.appendChild(el('p', 'ds-muted', d.report ? 'No suspects.' : 'Run an audit to see results.'));
        d.items.forEach(function (it) {
            var cell = el('div', 'ds-member');
            cell.appendChild(thumb(it.a.pid, it.a.label, it.a.sha256));
            var meta = el('div', 'ds-meta');
            meta.appendChild(el('strong', null, 'Filed as ' + it.a.label));
            meta.appendChild(el('span', null, 'looks more like ' + it.closerTo));
            meta.appendChild(el('span', 'ds-muted', (it.a.split || 'pool') + ' - gap ' + it.score.toFixed(2)));
            cell.appendChild(meta);
            cell.appendChild(button('Remove from the dataset', 'btn-deny', async function () {
                await post('/admin/api/dataset/remove', { pids: [it.a.pid], note: 'label suspect' });
                await refreshAll();
            }));
            host.appendChild(cell);
        });
        pager($('dsMislabelPager'), d.total, d.page, d.pageSize, function (p) { state.mPage = p; loadMislabels().catch(fail); });
    }

    // ------------------------------------------------------------------ species x parts
    async function addPart(part, species) {
        var out = await post('/admin/api/dataset/parts', { part: part, species: species || '' });
        note('Part "' + out.part + '" is in the list' + (out.created.length ? '; created ' + out.created.length + ' folder(s).' : '.'));
        await loadGrid();
    }

    async function loadGrid() {
        var d = await api('/admin/api/dataset/grid');
        state.parts = d.parts;
        var extra = [];
        d.species.forEach(function (s) { Object.keys(s.parts).forEach(function (p) { if (d.parts.indexOf(p) === -1 && extra.indexOf(p) === -1) extra.push(p); }); });
        var cols = d.parts.concat(extra);
        $('dsGridIntro').textContent = 'Photos per split (train / val / test) for each part. A species needs at least ' + d.minGroups +
            ' groups before it gets val and test. Parts are for organisation only; the model predicts the species.';
        var head = $('dsGrid').tHead;
        head.innerHTML = '';
        var hr = document.createElement('tr');
        ['Species', 'Photos', 'Groups'].concat(cols).concat(['Notes', '']).forEach(function (h) { hr.appendChild(el('th', null, h)); });
        head.appendChild(hr);
        var body = $('dsGrid').tBodies[0];
        body.innerHTML = '';
        d.species.forEach(function (s) {
            var tr = document.createElement('tr');
            tr.appendChild(el('td', null, s.label));
            tr.appendChild(el('td', null, String(s.photos)));
            var g = el('td', s.groups != null && s.groups < d.minGroups ? 'ds-low' : null, s.groups == null ? '-' : String(s.groups));
            tr.appendChild(g);
            cols.forEach(function (p) {
                var c = s.parts[p];
                tr.appendChild(el('td', c ? null : 'ds-low', c ? ['train', 'val', 'test'].map(function (k) { return c[k] || 0; }).join(' / ') : '0'));
            });
            var notes = el('td');
            s.warnings.concat(s.guidance).forEach(function (w) { notes.appendChild(el('div', 'ds-note', w)); });
            tr.appendChild(notes);
            var act = el('td');
            var sel = document.createElement('select');
            sel.setAttribute('aria-label', 'Part to add to ' + s.label);
            d.parts.forEach(function (p) { var o = document.createElement('option'); o.value = p; o.textContent = p; sel.appendChild(o); });
            act.appendChild(sel);
            act.appendChild(button('Add part folders', '', async function () { await addPart(sel.value, s.label); }));
            tr.appendChild(act);
            body.appendChild(tr);
        });
    }

    // ------------------------------------------------------------------ folders (like a file manager)
    function exKey() { return ['split', 'kind', 'label', 'part', 'source'].map(function (k) { return ex.params[k] || ''; }).join('|'); }
    function exCount() { return Object.keys(ex.selected).length; }

    function exGo(params) {
        ex.params = params || {};
        ex.page = 1;
        ex.selected = {};
        loadFolder().catch(fail);
    }

    function renderSelectBar() {
        var n = exCount();
        $('exSelectBar').hidden = n === 0;
        $('exSelCount').textContent = n + ' selected';
    }

    async function loadFolder() {
        var d = await api('/admin/api/dataset/folder' + qs(Object.assign({ page: ex.page }, ex.params)));
        ex.parent = d.atRoot ? null : d.parent;
        $('exUp').disabled = d.atRoot;

        var crumbs = $('exCrumbs');
        crumbs.innerHTML = '';
        var root = el('button', 'ds-crumb', 'Dataset');
        root.type = 'button';
        root.addEventListener('click', function () { exGo({}); });
        crumbs.appendChild(root);
        d.crumbs.forEach(function (c, i) {
            crumbs.appendChild(el('span', 'ds-crumb-sep', '/'));
            var b = el('button', 'ds-crumb' + (i === d.crumbs.length - 1 ? ' current' : ''), c.label);
            b.type = 'button';
            b.addEventListener('click', function () { exGo(c.params); });
            crumbs.appendChild(b);
        });

        var tiles = $('exFolders');
        tiles.innerHTML = '';
        d.folders.forEach(function (f) {
            var t = el('button', 'ds-tile');
            t.type = 'button';
            t.dataset.name = f.name.toLowerCase();
            var cover = el('div', 'ds-tile-cover');
            cover.appendChild(thumb(f.cover.pid, '', f.cover.sha));
            t.appendChild(cover);
            t.appendChild(el('strong', null, f.name));
            t.appendChild(el('span', 'ds-muted', f.count + (f.count === 1 ? ' photo' : ' photos')));
            t.addEventListener('click', function () {
                var next = Object.assign({}, ex.params);
                next[d.level] = f.value;
                exGo(next);
            });
            tiles.appendChild(t);
        });
        applyFind();

        var host = $('exPhotos');
        host.innerHTML = '';
        if (!d.folders.length && !d.photos.length) host.appendChild(el('p', 'ds-muted', 'This folder is empty.'));
        d.photos.forEach(function (m) {
            var cell = el('label', 'ds-member');
            cell.appendChild(thumb(m.pid, m.label, m.sha));
            var box = document.createElement('input');
            box.type = 'checkbox'; box.checked = !!ex.selected[m.pid]; box.dataset.pid = m.pid;
            box.addEventListener('change', function () {
                if (box.checked) ex.selected[m.pid] = true; else delete ex.selected[m.pid];
                cell.classList.toggle('selected', box.checked);
                renderSelectBar();
            });
            cell.classList.toggle('selected', box.checked);
            cell.appendChild(box);
            var meta = el('div', 'ds-meta');
            meta.appendChild(el('strong', 'ds-name', m.name));
            if (m.source) meta.appendChild(el('span', 'ds-muted', m.source));
            cell.appendChild(meta);
            host.appendChild(cell);
        });
        renderSelectBar();
        pager($('exPager'), d.photoTotal, d.page, d.pageSize, function (p) { ex.page = p; loadFolder().catch(fail); });
    }


    // ------------------------------------------------------------------ move photos to another folder
    function fill(select, values, keep) {
        select.innerHTML = '';
        values.forEach(function (v) {
            var o = document.createElement('option');
            o.value = v.value; o.textContent = v.name;
            select.appendChild(o);
        });
        if (keep && values.some(function (v) { return v.value === keep; })) select.value = keep;
    }

    function refreshMoveChoices(kindChanged) {
        var d = ex.dest;
        var kind = $('mvKind').value;
        var labels = (d.labels[kind] || []).map(function (l) { return { value: l, name: l }; });
        if (kind === 'non_plant') labels.unshift({ value: '', name: '(no sub-folder)' });
        fill($('mvLabel'), labels, kindChanged ? '' : $('mvLabel').value);
        $('mvLabel').disabled = labels.length === 0;
        $('mvPartWrap').hidden = kind !== 'species';
    }

    async function openMove() {
        if (!chosen() || !Object.keys(ex.selected).length) return;
        if (!ex.dest) ex.dest = await api('/admin/api/dataset/destinations');
        var d = ex.dest, p = ex.params;
        $('mvSplitWrap').hidden = !d.hasSplit;
        fill($('mvSplit'), d.splits.map(function (s) { return { value: s, name: s }; }), p.split);
        fill($('mvKind'), d.kinds.map(function (k) { return { value: k.value, name: k.name }; }), p.kind);
        fill($('mvPart'), d.parts.map(function (x) { return { value: x, name: x }; }), p.part);
        refreshMoveChoices(true);
        if (p.label) $('mvLabel').value = p.label;
        $('exMovePanel').hidden = false;
    }

    function moveRequest(preview) {
        var kind = $('mvKind').value;
        return {
            pids: Object.keys(ex.selected), preview: preview,
            dest: { split: ex.dest.hasSplit ? $('mvSplit').value : '', kind: kind, label: $('mvLabel').value, part: kind === 'species' ? $('mvPart').value : '' }
        };
    }

    async function doMove() {
        var check = await post('/admin/api/dataset/move', moveRequest(true));
        var to = [check.to.split, check.to.kind, check.to.label, check.to.part].filter(Boolean).join(' / ');
        if (!check.count) return note('Those photos are already in that folder.');
        var text = 'Move ' + check.count + ' photo(s) to ' + to + '?' + (check.skipped ? '\n(' + check.skipped + ' already there)' : '');
        if (check.warnings.length) text += '\n\nWarnings:\n- ' + check.warnings.slice(0, 6).join('\n- ');
        if (!window.confirm(text)) return;
        var out = await post('/admin/api/dataset/move', moveRequest(false));
        note('Moved ' + out.moved + ' photo(s) to ' + to + '. ' + (out.note || ''));
        $('exMovePanel').hidden = true;
        ex.selected = {};
        ex.dest = null;
        await refreshAll();
    }

    function applyFind() {
        var q = $('exFind').value.trim().toLowerCase();
        Array.prototype.forEach.call(document.querySelectorAll('#exFolders .ds-tile'), function (t) {
            t.hidden = !!q && t.dataset.name.indexOf(q) === -1;
        });
    }

    function chosen() {
        var pids = Object.keys(ex.selected);
        if (pids.length > 50) { note('Select at most 50 photos at a time (you have ' + pids.length + ').', true); return null; }
        return pids;
    }

    async function exRemove() {
        var pids = chosen();
        if (!pids || !pids.length) return;
        if (!window.confirm('Move ' + pids.length + ' photo(s) to quarantine? They can be put back from the Removed section.')) return;
        var out = await post('/admin/api/dataset/remove', { pids: pids, note: 'removed from the folder view' });
        note('Moved ' + out.moved + ' photo(s) to quarantine.');
        ex.selected = {};
        await refreshAll();
    }

    async function exGroup() {
        var pids = chosen();
        if (!pids) return;
        if (pids.length < 2) return note('Select at least two photos to keep together.', true);
        var out = await post('/admin/api/dataset/group', { pids: pids });
        note('Saved as ' + out.group + '. The next split keeps these photos in the same place.');
        ex.selected = {};
        renderSelectBar();
        Array.prototype.forEach.call(document.querySelectorAll('#exPhotos input'), function (b) { b.checked = false; b.parentNode.classList.remove('selected'); });
    }

    // ------------------------------------------------------------------ removed
    async function loadRemoved() {
        var d = await api('/admin/api/dataset/quarantine');
        var host = $('dsRemoved');
        host.innerHTML = '';
        $('dsRemovedCount').hidden = !d.items.length;
        $('dsRemovedCount').textContent = String(d.items.length);
        if (!d.items.length) host.appendChild(el('p', 'ds-muted', 'Nothing removed.'));
        d.items.forEach(function (it) {
            var line = el('div', 'ds-removed');
            line.appendChild(el('span', null, it.label + ' - ' + (it.split || 'pool') + ' - ' + it.rel));
            line.appendChild(el('span', 'ds-muted', it.at + (it.note ? ' - ' + it.note : '')));
            line.appendChild(button('Put back', '', async function () {
                var out = await post('/admin/api/dataset/restore', { qid: it.qid });
                note(out.note || 'Restored.');
                await loadRemoved();
            }));
            host.appendChild(line);
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

    // ------------------------------------------------------------------ wiring
    async function refreshAll() {
        await Promise.all([loadOverview(), loadClusters(), loadMislabels(), loadGrid(), loadFolder(), loadRemoved()].map(function (p) { return p.catch(fail); }));
    }

    function init() {
        $('dsRunAudit').addEventListener('click', runAudit);
        $('dsAddPart').addEventListener('click', async function () {
            var v = $('dsNewPart').value.trim();
            if (!v) return note('Type the new part name first.', true);
            try { await addPart(v, ''); $('dsNewPart').value = ''; } catch (e) { fail(e); }
        });
        $('dsFilters').addEventListener('click', function (e) {
            var chip = e.target.closest('.ds-chip');
            if (!chip) return;
            Array.prototype.forEach.call(document.querySelectorAll('.ds-chip'), function (c) { c.classList.remove('active'); });
            chip.classList.add('active');
            state.cat = chip.dataset.cat || '';
            state.reviewed = chip.dataset.reviewed === '1';
            state.page = 1;
            loadClusters().catch(fail);
        });
        $('exUp').addEventListener('click', function () { if (ex.parent) exGo(ex.parent); });
        $('exFind').addEventListener('input', applyFind);
        $('exMove').addEventListener('click', function () { openMove().catch(fail); });
        $('mvKind').addEventListener('change', function () { refreshMoveChoices(true); });
        $('mvCancel').addEventListener('click', function () { $('exMovePanel').hidden = true; });
        $('mvGo').addEventListener('click', function () { doMove().catch(fail); });
        $('exRemove').addEventListener('click', function () { exRemove().catch(fail); });
        $('exGroup').addEventListener('click', function () { exGroup().catch(fail); });
        $('exClear').addEventListener('click', function () { ex.selected = {}; loadFolder().catch(fail); });
        fillUser();
        refreshAll();
    }

    document.addEventListener('DOMContentLoaded', init);
})();
