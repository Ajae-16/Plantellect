/**
 * Record page controller for record.html.
 *
 * Four tabs, all query-param based (?tab=), never hash based: a hash has no
 * consumer on this page and would be a trap for the next reader.
 *
 *   - NEW PLANT      -> POST /api/plants/requests              (multipart: text + photos)
 *   - ADD TO EXISTING-> POST /api/plants/:plantId/contributions (multipart)
 *                       POST /api/plants/:plantId/taxonomy      (JSON, its own request)
 *   - REQUEST CHANGE -> GET  /api/plants/:plantId/editable      (current values)
 *                       POST /api/plants/:plantId/changes       (JSON, reviewed by an admin)
 *   - MY SUBMISSIONS -> GET  /api/plants/mine
 *
 * Reuses window.escapeHtml and window.checkAuth from public/javascript/auth.js
 * rather than adding a fifth local escapeHtml copy.
 *
 * Upload limits come from GET /api/plants/limits: the photo COUNT is an admin
 * setting, so nothing here hardcodes it. The values below are only the fallback
 * for a failed fetch, and a stale client limit is only a worse error message —
 * the server's upload middleware enforces the real one.
 */

(function () {
    'use strict';

    var PAGE_SIZE = 10;     // settings.pagination.defaultPageSize
    var MAX_PAGE_SIZE = 50; // settings.pagination.maxPageSize
    var DEBOUNCE_MS = 300;

    // Fallback only; replaced by loadLimits().
    var limits = {
        maxFilesPerRequest: 20,
        maxSizeBytes: 10 * 1024 * 1024,
        allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp']
    };

    // Taxonomy levels as the form shows them. `key` is the name the API uses for
    // the level (plantClass, because `class` is awkward as a field name).
    var TAXONOMY_FIELDS = [
        { key: 'kingdom', level: 'kingdom', label: 'Kingdom' },
        { key: 'phylum', level: 'phylum', label: 'Phylum' },
        { key: 'plantClass', level: 'class', label: 'Class' },
        { key: 'order', level: 'order', label: 'Order' },
        { key: 'family', level: 'family', label: 'Family' },
        { key: 'genus', level: 'genus', label: 'Genus' },
        { key: 'species', level: 'species', label: 'Species (epithet)' }
    ];
    var UNSPECIFIED = 'Unspecified';

    // Fields a change request can touch. A request has two independent halves:
    //   BASE         the plant's shared record: names, type (own editor) and taxonomy
    //   DESCRIPTION  one description the botanist wrote: text plus its measurements.
    //                `part` fields live under `parts` in the request body and under
    //                'parts.<key>' in the server's value map.
    var BASE_TEXT_FIELDS = [
        { key: 'commonName', label: 'Common name' },
        { key: 'scientificName', label: 'Scientific name' }
    ];
    var DESC_FIELDS = [
        { key: 'uses', label: 'Uses', kind: 'area' },
        { key: 'benefits', label: 'Benefits', kind: 'area' },
        { key: 'harmful', label: 'Things to watch out for', kind: 'area', harmful: true },
        { key: 'heightMinCm', label: 'Height min (cm)', kind: 'num', part: true },
        { key: 'heightMaxCm', label: 'Height max (cm)', kind: 'num', part: true },
        { key: 'heightNote', label: 'Height note', kind: 'text', part: true },
        { key: 'widthMinCm', label: 'Width min (cm)', kind: 'num', part: true },
        { key: 'widthMaxCm', label: 'Width max (cm)', kind: 'num', part: true },
        { key: 'widthNote', label: 'Width note', kind: 'text', part: true },
        { key: 'color', label: 'Color', kind: 'text', part: true },
        { key: 'shape', label: 'Shape', kind: 'text', part: true },
        { key: 'texture', label: 'Texture', kind: 'text', part: true }
    ];

    var el = {};
    var activeTab = 'new';
    var minePage = 1;
    var mineTotal = 0;
    var mineStale = false;
    var typeNames = [];             // [{ typeName, plantCount }] from /api/plants/types, most used first
    var contributePlant = null;     // { id, name, scientificName, lookup }
    var changePlant = null;         // the /editable payload for the plant chosen on the change tab
    var changeDescription = null;   // the one of the botanist's own descriptions the description half edits
    var existingForNew = null;      // the library plant a new-plant draft collides with
    var searchTimer = null;
    var changeTimer = null;
    var selectToken = 0;
    var changeToken = 0;
    var duplicateToken = 0;
    var newList = null;             // image lists, see createImageList()
    var contributeList = null;
    var discoveryRequestId = null;
    var discoveryImages = [];       // the claimed report's photos: [{ imageId, url, originalFilename }]
    var chosenReportPhotos = { 'new': {}, contribute: {} };
    var modalOpener = null;

    // ------------------------------------------------------------ helpers ----
    function byId(id) { return document.getElementById(id); }

    function setNotice(text, kind) {
        if (!el.notice) return;
        el.notice.textContent = text || '';
        el.notice.className = 'record-notice' + (kind ? ' ' + kind : '');
        el.notice.hidden = !text;
    }

    function setGate(text) {
        if (!el.gate) return;
        el.gate.textContent = text || '';
        el.gate.hidden = !text;
    }

    /** Serialises the measurement inputs a panel owns, skipping blanks. */
    function readParts(prefix) {
        var parts = {};
        var numeric = ['heightMinCm', 'heightMaxCm', 'widthMinCm', 'widthMaxCm'];
        numeric.forEach(function (key) {
            var node = byId(prefix + key.charAt(0).toUpperCase() + key.slice(1));
            if (node && node.value !== '') parts[key] = Number(node.value);
        });
        ['heightNote', 'widthNote', 'color', 'shape', 'texture'].forEach(function (key) {
            var node = byId(prefix + key.charAt(0).toUpperCase() + key.slice(1));
            if (node && node.value.trim()) parts[key] = node.value.trim();
        });
        return parts;
    }

    var PART_KEYS = ['heightMinCm', 'heightMaxCm', 'heightNote', 'widthMinCm', 'widthMaxCm', 'widthNote', 'color', 'shape', 'texture'];

    function partNode(prefix, key) {
        return byId(prefix + key.charAt(0).toUpperCase() + key.slice(1));
    }

    function hasAnyPartValue(parts) {
        return Object.keys(parts).some(function (k) {
            var v = parts[k];
            return v !== null && v !== undefined && v !== '';
        });
    }

    function value(id) {
        var node = byId(id);
        return node ? node.value.trim() : '';
    }

    function megabytes(bytes) {
        return Math.round((bytes / (1024 * 1024)) * 10) / 10;
    }

    async function api(pathname, options) {
        var response = await fetch(pathname, Object.assign({ credentials: 'include' }, options || {}));
        var body = null;
        try { body = await response.json(); } catch (err) { body = null; }
        if (!response.ok) {
            var message = (body && body.error) || ('Request failed (' + response.status + ')');
            var error = new Error(message);
            error.status = response.status;
            error.body = body;
            throw error;
        }
        return body;
    }

    /** Disables every submit button so an impatient double-click cannot create
     *  two pending requests for one species. */
    function setBusy(busy) {
        [el.newSubmit, el.contributeSubmit, el.taxonomySubmit, el.changeSubmit].forEach(function (button) {
            if (button) button.disabled = busy;
        });
    }

    /** "Safe" is whatever plant_types says: not harmful and no toxicity level.
     *  Never inferred from a name. The server applies the same rule. */
    function isSafeType(type) {
        return Boolean(type) && !type.isHarmful && (type.toxicityLevel || 'none') === 'none';
    }

    /** The typed type name: trimmed, single spaces, the case it was typed in. */
    function normalizeTypeName(text) {
        return String(text == null ? '' : text).trim().replace(/\s+/g, ' ');
    }

    /**
     * The list of type names already in use, attached to a text box. It opens on
     * click or focus, narrows as you type, and a pick fills the box. Nothing is
     * locked: a name that is not listed is simply a new one. The list is only there
     * so two botanists land on "Herbal" instead of "Herbal" and "Medical Herb".
     */
    function attachTypeSuggest(input, listEl) {
        function render() {
            var query = normalizeTypeName(input.value).toLowerCase();
            var matches = typeNames.filter(function (t) {
                return !query || t.typeName.toLowerCase().indexOf(query) !== -1;
            }).slice(0, 12);
            listEl.innerHTML = '';
            if (matches.length === 0) { listEl.hidden = true; return; }
            matches.forEach(function (t) {
                var button = document.createElement('button');
                button.type = 'button';
                button.className = 'record-picker-item';
                button.innerHTML = escapeHtml(t.typeName) +
                    ' <em>(' + t.plantCount + ' plant' + (t.plantCount === 1 ? '' : 's') + ')</em>';
                // Keep focus in the box, so picking does not blur it first.
                button.addEventListener('mousedown', function (e) { e.preventDefault(); });
                button.addEventListener('click', function () {
                    input.value = t.typeName;
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    listEl.hidden = true;
                });
                listEl.appendChild(button);
            });
            listEl.hidden = false;
        }
        input.addEventListener('focus', render);
        input.addEventListener('click', render);
        input.addEventListener('input', render);
        input.addEventListener('blur', function () { listEl.hidden = true; });
        input.addEventListener('keydown', function (e) { if (e.key === 'Escape') listEl.hidden = true; });
    }

    // ------------------------------------------------------- preview modal ----
    function openPreview(src, alt, opener) {
        if (!el.modal || !src) return;
        modalOpener = opener || null;
        el.modalImg.src = src;
        el.modalImg.alt = alt || '';
        el.modal.hidden = false;
        document.body.style.overflow = 'hidden';
        el.modalClose.focus();
    }

    function closePreview() {
        if (!el.modal || el.modal.hidden) return;
        el.modal.hidden = true;
        el.modalImg.removeAttribute('src');
        document.body.style.overflow = '';
        // Back to the thumbnail that opened it, unless a re-render removed it.
        if (modalOpener && document.body.contains(modalOpener)) modalOpener.focus();
        modalOpener = null;
    }

    function initModal() {
        el.modal.addEventListener('click', function (event) {
            // Backdrop only: a click on the image itself must not close it.
            if (event.target === el.modal) closePreview();
        });
        el.modalClose.addEventListener('click', closePreview);
        document.addEventListener('keydown', function (event) {
            if (el.modal.hidden) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                closePreview();
            } else if (event.key === 'Tab') {
                // The close button is the only control in the dialog; keep focus on it.
                event.preventDefault();
                el.modalClose.focus();
            }
        });
    }

    // ---------------------------------------------------------- image lists ----
    /**
     * A list of photos the botanist has picked for one form.
     *
     * The <input type="file"> is only a way to ADD to it: its own FileList cannot
     * drop a single file, and a list that cannot drop one photo is a list the
     * botanist has to throw away and rebuild. Everything that is sent is read from
     * `items`, never from the input.
     *
     * An empty list hides its grid. `reserved()` is how many report photos the
     * same form has ticked, because the cap counts both.
     */
    function createImageList(options) {
        var items = [];

        function keyOf(file) { return file.name + '|' + file.size + '|' + file.lastModified; }

        function remaining() {
            return Math.max(0, limits.maxFilesPerRequest - items.length - (options.reserved ? options.reserved() : 0));
        }

        function render() {
            options.grid.innerHTML = '';
            options.grid.hidden = items.length === 0;
            items.forEach(function (item, index) {
                var li = document.createElement('li');
                li.className = 'record-thumb';

                var open = document.createElement('button');
                open.type = 'button';
                open.className = 'record-thumb-open';
                open.setAttribute('data-index', String(index));
                open.setAttribute('aria-label', 'Preview ' + item.file.name);
                var img = document.createElement('img');
                img.src = item.url;
                img.alt = '';
                open.appendChild(img);

                var remove = document.createElement('button');
                remove.type = 'button';
                remove.className = 'record-thumb-remove';
                remove.setAttribute('data-index', String(index));
                remove.setAttribute('aria-label', 'Remove ' + item.file.name);
                remove.textContent = '\u00d7';

                var label = document.createElement('span');
                label.className = 'record-thumb-label';
                label.textContent = item.file.name;

                li.appendChild(open);
                li.appendChild(remove);
                li.appendChild(label);
                options.grid.appendChild(li);
            });
        }

        function removeAt(index) {
            var item = items[index];
            if (!item) return;
            URL.revokeObjectURL(item.url);
            items.splice(index, 1);
            render();
            if (item.fromCache && options.onCacheItemRemoved) options.onCacheItemRemoved(item.fromCache);
            if (options.onChange) options.onChange();
        }

        options.grid.addEventListener('click', function (event) {
            var open = event.target.closest('.record-thumb-open');
            var remove = event.target.closest('.record-thumb-remove');
            if (open) {
                var item = items[Number(open.getAttribute('data-index'))];
                if (item) openPreview(item.url, item.file.name, open);
            } else if (remove) {
                removeAt(Number(remove.getAttribute('data-index')));
            }
        });

        return {
            /** Adds files, returning what was refused and why. */
            add: function (files, fromCache) {
                var problems = [];
                var overflow = 0;
                files.forEach(function (file) {
                    if (limits.allowedMimeTypes.indexOf(file.type) === -1) {
                        problems.push('"' + file.name + '" is not a JPEG, PNG or WebP.');
                        return;
                    }
                    if (file.size > limits.maxSizeBytes) {
                        problems.push('"' + file.name + '" is larger than ' + megabytes(limits.maxSizeBytes) + ' MB.');
                        return;
                    }
                    if (items.some(function (existing) { return keyOf(existing.file) === keyOf(file); })) return;
                    if (remaining() <= 0) { overflow++; return; }
                    items.push({ file: file, url: URL.createObjectURL(file), fromCache: fromCache || null });
                });
                if (overflow > 0) {
                    problems.push('At most ' + limits.maxFilesPerRequest + ' photos per submission — ' +
                        overflow + ' not added.');
                }
                render();
                if (options.onChange) options.onChange();
                return problems;
            },
            files: function () { return items.map(function (item) { return item.file; }); },
            count: function () { return items.length; },
            cacheKeys: function () {
                return items.filter(function (item) { return item.fromCache; })
                    .map(function (item) { return item.fromCache; });
            },
            hasCache: function (key) {
                return items.some(function (item) { return item.fromCache === key; });
            },
            /** Empties the list WITHOUT revoking, so the photos can move to another list. */
            detach: function () {
                var moved = items;
                items = [];
                render();
                if (options.onChange) options.onChange();
                return moved;
            },
            attach: function (moved) {
                var refused = 0;
                moved.forEach(function (item) {
                    if (remaining() <= 0) { URL.revokeObjectURL(item.url); refused++; return; }
                    items.push(item);
                });
                render();
                if (options.onChange) options.onChange();
                return refused;
            },
            clear: function () {
                items.forEach(function (item) { URL.revokeObjectURL(item.url); });
                items = [];
                render();
                if (options.onChange) options.onChange();
            },
            render: render
        };
    }

    function updateFileHints() {
        var text = 'JPEG, PNG or WebP. Up to ' + limits.maxFilesPerRequest + ' photos, ' +
            megabytes(limits.maxSizeBytes) + ' MB each.';
        ['newFileHint', 'contributeFileHint'].forEach(function (id) {
            var node = byId(id);
            if (node) node.textContent = text;
        });
        [el.newImages, el.contributeImages].forEach(function (input) {
            if (input) input.accept = limits.allowedMimeTypes.join(',');
        });
    }

    async function loadLimits() {
        try {
            var data = await api('/api/plants/limits');
            if (data && data.maxFilesPerRequest >= 1) limits.maxFilesPerRequest = data.maxFilesPerRequest;
            if (data && data.maxSizeBytes > 0) limits.maxSizeBytes = data.maxSizeBytes;
            if (data && Array.isArray(data.allowedMimeTypes) && data.allowedMimeTypes.length) {
                limits.allowedMimeTypes = data.allowedMimeTypes;
            }
        } catch (err) {
            // Keep the fallback: the server still enforces the real limit.
        }
        if (window.PhotoCache && typeof window.PhotoCache.setLimits === 'function') {
            window.PhotoCache.setLimits(limits);
        }
        updateFileHints();
    }

    // --------------------------------------------------------------- tabs ----
    var TAB_IDS = ['new', 'contribute', 'change', 'mine'];

    /** Deep-link precedence: plantId picks contribute (or change, when ?tab=change),
     *  a scanned name forces new, else ?tab=, else new. */
    function initialTab() {
        var params = new URLSearchParams(window.location.search);
        if (params.get('plantId')) return params.get('tab') === 'change' ? 'change' : 'contribute';
        if (params.get('scientificName') || params.get('commonName')) return 'new';
        var tab = params.get('tab');
        if (TAB_IDS.indexOf(tab) !== -1) return tab;
        return 'new';
    }

    function showTab(tab, updateUrl) {
        if (TAB_IDS.indexOf(tab) === -1) tab = 'new';
        activeTab = tab;

        TAB_IDS.forEach(function (id) {
            var button = byId('tab-' + id);
            var panel = byId('panel-' + id);
            if (button) button.setAttribute('aria-selected', id === tab ? 'true' : 'false');
            if (panel) panel.hidden = id !== tab;
        });

        if (updateUrl) {
            var params = new URLSearchParams(window.location.search);
            params.set('tab', tab);
            // replaceState, never push: switching tabs is not navigation, and
            // filling the back button with tab history is a trap.
            history.replaceState(null, '', window.location.pathname + '?' + params.toString());
        }

        if (tab === 'mine') loadMine();
    }

    // ------------------------------------------- the discovery report link ----
    /**
     * A record made from a claimed report carries the report's id exactly once.
     * After a submission lands the link is spent: keeping it would make the NEXT
     * submission from this page (an "Add photos" follow-up, say) re-link the
     * report to a different record and wipe its votes again. So it is cleared,
     * the banner is hidden and ?from= is removed from the address.
     */
    function finishDiscovery() {
        if (!discoveryRequestId) return;
        discoveryRequestId = null;
        discoveryImages = [];
        chosenReportPhotos = { 'new': {}, contribute: {} };
        renderReportPhotoPickers();
        var banner = byId('discoveryBanner');
        if (banner) banner.hidden = true;
        var params = new URLSearchParams(window.location.search);
        if (params.has('from')) {
            params.delete('from');
            var query = params.toString();
            history.replaceState(null, '', window.location.pathname + (query ? '?' + query : ''));
        }
    }

    function chosenIds(target) {
        return Object.keys(chosenReportPhotos[target]).filter(function (id) {
            return chosenReportPhotos[target][id];
        });
    }

    function reportReserved(target) { return chosenIds(target).length; }

    /** The report's photos as tickable thumbnails, in both forms. Hidden when
     *  there is no claimed report or it has no photos. */
    function renderReportPhotoPickers() {
        ['new', 'contribute'].forEach(function (target) {
            var wrap = byId(target + 'DiscoveryPhotos');
            var list = byId(target + 'DiscoveryList');
            if (!wrap || !list) return;
            list.innerHTML = '';
            wrap.hidden = !(discoveryRequestId && discoveryImages.length > 0);
            if (wrap.hidden) return;
            discoveryImages.forEach(function (image) {
                var li = document.createElement('li');
                li.className = 'record-thumb';

                var open = document.createElement('button');
                open.type = 'button';
                open.className = 'record-thumb-open';
                open.setAttribute('data-preview', image.url);
                open.setAttribute('aria-label', 'Preview report photo ' + (image.originalFilename || ''));
                var img = document.createElement('img');
                img.src = image.url;
                img.alt = '';
                open.appendChild(img);

                var box = document.createElement('input');
                box.type = 'checkbox';
                box.className = 'record-thumb-choice';
                box.setAttribute('data-target', target);
                box.setAttribute('data-image-id', image.imageId);
                box.setAttribute('aria-label', 'Attach report photo ' + (image.originalFilename || image.imageId));
                box.checked = Boolean(chosenReportPhotos[target][image.imageId]);

                li.appendChild(open);
                li.appendChild(box);
                list.appendChild(li);
            });
        });
    }

    function initReportPhotoPickers() {
        ['new', 'contribute'].forEach(function (target) {
            var list = byId(target + 'DiscoveryList');
            if (!list) return;
            list.addEventListener('click', function (event) {
                var open = event.target.closest('.record-thumb-open');
                if (open) openPreview(open.getAttribute('data-preview'), 'Report photo', open);
            });
            list.addEventListener('change', function (event) {
                var box = event.target;
                if (!box || !box.classList || !box.classList.contains('record-thumb-choice')) return;
                var imageList = target === 'new' ? newList : contributeList;
                if (box.checked && imageList.count() + chosenIds(target).length >= limits.maxFilesPerRequest) {
                    box.checked = false;
                    setNotice('At most ' + limits.maxFilesPerRequest + ' photos per submission, counting report photos.', 'warning');
                    return;
                }
                chosenReportPhotos[target][box.getAttribute('data-image-id')] = box.checked;
            });
        });
    }

    // ----------------------------------------------------- harmful checkbox ----
    /**
     * "Things to watch out for" is shown only while "This plant is harmful" is
     * ticked. Unticking (or hiding) empties the textarea, so nothing typed earlier
     * can be sent.
     */
    function syncHarmful(prefix) {
        var check = byId(prefix + 'IsHarmful');
        var field = byId(prefix + 'HarmfulField');
        var textarea = byId(prefix + 'Harmful');
        if (!check || !field) return;
        var show = check.checked && !check.disabled;
        field.hidden = !show;
        if (!show && textarea) textarea.value = '';
        // Only the new-plant form has a toxicity level: it is part of the plant's own type.
        var toxicity = byId(prefix + 'ToxicityField');
        if (toxicity) {
            toxicity.hidden = !show;
            if (!show) byId(prefix + 'ToxicityLevel').value = '';
        }
    }

    /** A type marked safe forces the box off and locks it; otherwise it is free. */
    function applyHarmfulVisibility(prefix, safe) {
        var check = byId(prefix + 'IsHarmful');
        var note = byId(prefix + 'HarmfulNote');
        if (check) {
            check.disabled = safe;
            if (safe) check.checked = false;
        }
        if (note) note.hidden = !safe;
        syncHarmful(prefix);
    }

    function harmfulVisible(prefix) {
        var field = byId(prefix + 'HarmfulField');
        return Boolean(field) && !field.hidden;
    }

    // --------------------------------------------------------- new plant ----
    function validateNewPlant(parts) {
        var problems = [];
        if (!value('newCommonName')) problems.push('Common name is required.');
        if (!value('newScientificName')) problems.push('Scientific name is required.');
        var typeName = normalizeTypeName(el.newTypeName.value);
        if (!typeName) problems.push('Type a plant type.');
        else if (typeName.length > 50) problems.push('The plant type is at most 50 characters.');
        if (byId('newIsHarmful').checked && !el.newToxicityLevel.value) {
            problems.push('Choose a toxicity level for a harmful plant.');
        }
        var min = el.newHeightMinCm.value;
        var max = el.newHeightMaxCm.value;
        if (min !== '' && max !== '' && Number(min) > Number(max)) {
            problems.push('Height min cannot exceed height max.');
        }
        var wmin = el.newWidthMinCm.value;
        var wmax = el.newWidthMaxCm.value;
        if (wmin !== '' && wmax !== '' && Number(wmin) > Number(wmax)) {
            problems.push('Width min cannot exceed width max.');
        }
        // Mirrors validatePlantDraft: public visibility requires an approved
        // primary description, so names and photos alone would be "Approved" and
        // invisible.
        var caution = harmfulVisible('new') ? value('newHarmful') : '';
        if (byId('newIsHarmful').checked && !caution) {
            problems.push('Describe the things to watch out for, or untick "harmful".');
        }
        if (!hasAnyPartValue(parts) && !value('newUses') && !value('newBenefits') && !caution) {
            problems.push('Add a description or some measurements — names and photos alone are never published.');
        }
        return problems;
    }

    async function submitNewPlant(event) {
        event.preventDefault();
        setNotice('', null);

        // Looked up again at submit: the blur check can be stale, and the answer
        // decides whether this is a plant or a contribution.
        await refreshExistingForNew();
        if (existingForNew) {
            setNotice('"' + existingForNew.scientificName + '" is already in the library. ' +
                'Use "Add to it instead" so your description and photos go to that plant.', 'warning');
            return;
        }

        var parts = readParts('new');
        var problems = validateNewPlant(parts);
        if (problems.length > 0) {
            setNotice(problems.join(' '), 'error');
            return;
        }

        var form = new FormData();
        form.append('commonName', value('newCommonName'));
        form.append('scientificName', value('newScientificName'));
        var typeHarmful = byId('newIsHarmful').checked;
        form.append('typeName', normalizeTypeName(el.newTypeName.value));
        form.append('isMedicinal', el.newTypeMedicinal.checked ? '1' : '0');
        form.append('isHarmful', typeHarmful ? '1' : '0');
        form.append('toxicityLevel', typeHarmful ? el.newToxicityLevel.value : 'none');
        form.append('cautionNote', el.newCautionNote.value.trim());
        form.append('kingdom', value('newKingdom'));
        form.append('phylum', value('newPhylum'));
        form.append('plantClass', value('newPlantClass'));
        form.append('order', value('newOrder'));
        form.append('family', value('newFamily'));
        form.append('genus', value('newGenus'));
        form.append('species', value('newSpecies'));
        form.append('parts', JSON.stringify(parts));
        form.append('uses', value('newUses'));
        form.append('benefits', value('newBenefits'));
        // Omitted, not sent empty, when the plant is not marked harmful.
        if (harmfulVisible('new')) form.append('harmful', value('newHarmful'));
        // Present ONLY when the botanist arrived from the queue. The server
        // verifies the claim in the submit transaction, so this is provenance
        // and not a permission.
        if (discoveryRequestId) {
            form.append('discoveryRequestId', discoveryRequestId);
            form.append('discoveryImageIds', JSON.stringify(chosenIds('new')));
        }
        newList.files().forEach(function (file) { form.append('images', file, file.name); });

        var typedScientific = value('newScientificName');
        var cachedKeys = newList.cacheKeys();
        setBusy(true);
        try {
            var result = await api('/api/plants/requests', { method: 'POST', body: form });

            // The scan photo is only really submitted now; before this the cache
            // entry was the botanist's only copy.
            if (typeof window.dropScanPhoto === 'function') {
                for (var i = 0; i < cachedKeys.length; i++) await window.dropScanPhoto(cachedKeys[i]);
            }

            var text = result.autoApproved
                ? 'Approved automatically as ' + result.requestId + ' — no human reviewed it.'
                : 'Submitted for review as ' + result.requestId + '.';
            // The server rewrites scientificName to the model's exact casing, so
            // report what was actually stored rather than what was typed.
            if (result.scientificName && result.scientificName !== typedScientific) {
                text += ' Stored as "' + result.scientificName + '".';
            }
            var photoCount = (result.imageIds || []).length;
            if (photoCount > 0) text += ' ' + photoCount + ' photo' + (photoCount === 1 ? '' : 's') + ' sent for approval.';
            var warnings = result.warnings || [];
            if (!result.autoApproved && result.autoSkipReason && /^a submitter/.test(result.autoSkipReason)) {
                text += ' A person will review it, because it is your first submission of this kind.';
            }
            setNotice(text + (warnings.length ? ' ' + warnings.join(' ') : ''), warnings.length ? 'warning' : 'success');

            el.newPlantForm.reset();
            newList.clear();
            hideCarried('new');
            existingForNew = null;
            renderDuplicate();
            applyHarmfulVisibility('new', false);
            await loadTypes();
            finishDiscovery();
            mineStale = true;
            showTab('mine');
        } catch (err) {
            // The species turned out to exist: turn the draft into a contribution
            // instead of leaving the botanist with a dead end.
            if (err.status === 409 && err.body && err.body.existingPlantId) {
                try {
                    var data = await api('/api/plants/lookup?plantId=' + encodeURIComponent(err.body.existingPlantId));
                    if (data.exists) {
                        existingForNew = data.plant;
                        renderDuplicate();
                    }
                } catch (lookupErr) { /* the message below still tells them */ }
            }
            // Surfaced verbatim: the server's 400/409 message is specific, and a
            // generic failure string would throw that away.
            setNotice(err.message, 'error');
        } finally {
            setBusy(false);
        }
    }

    /** Asks the server whether the typed scientific name is already a plant. The
     *  lookup finds unpublished plants too, which the public search cannot. */
    async function refreshExistingForNew() {
        var name = value('newScientificName');
        var token = ++duplicateToken;
        if (!name) {
            existingForNew = null;
            renderDuplicate();
            return;
        }
        try {
            var data = await api('/api/plants/lookup?scientificName=' + encodeURIComponent(name));
            if (token !== duplicateToken) return;
            existingForNew = data.exists ? data.plant : null;
        } catch (err) {
            // A failed lookup is not a validation failure: say nothing and let
            // the server decide on submit (it refuses a duplicate with 409).
            return;
        }
        renderDuplicate();
    }

    function renderDuplicate() {
        if (!el.newDuplicateWarning) return;
        if (!existingForNew) {
            el.newDuplicateWarning.hidden = true;
            el.newDuplicateWarning.innerHTML = '';
            return;
        }
        el.newDuplicateWarning.hidden = false;
        el.newDuplicateWarning.innerHTML =
            'Already in the library &mdash; <strong>' + escapeHtml(existingForNew.name) + '</strong> (' +
            escapeHtml(existingForNew.scientificName) + '). Recording it again would create a second copy, so ' +
            'your text and photos can go to that plant as a contribution. ' +
            '<button type="button" class="btn record-btn-secondary" id="duplicateJumpButton">Add to it instead</button>';
        var jump = byId('duplicateJumpButton');
        if (jump) jump.addEventListener('click', moveNewToContribute);
    }

    /** Turns the new-plant draft into a contribution to the plant it collides with:
     *  the text, measurements, photos and ticked report photos all move across. */
    async function moveNewToContribute() {
        var plant = existingForNew;
        if (!plant) return;

        [['newUses', 'contributeUses'], ['newBenefits', 'contributeBenefits'], ['newHarmful', 'contributeHarmful']]
            .forEach(function (pair) {
                var from = byId(pair[0]);
                var to = byId(pair[1]);
                if (from && to && from.value.trim() && !to.value.trim()) to.value = from.value;
            });
        PART_KEYS.forEach(function (key) {
            var from = partNode('new', key);
            var to = partNode('contribute', key);
            if (from && to && from.value !== '' && to.value === '') to.value = from.value;
        });

        // Carry the harmful box across, then show/hide the caution field to match.
        byId('contributeIsHarmful').checked = byId('newIsHarmful').checked;
        syncHarmful('contribute');

        var refused = contributeList.attach(newList.detach());
        chosenReportPhotos.contribute = Object.assign({}, chosenReportPhotos['new']);
        chosenReportPhotos['new'] = {};
        renderReportPhotoPickers();

        el.newPlantForm.reset();
        hideCarried('new');
        existingForNew = null;
        renderDuplicate();
        applyHarmfulVisibility('new', false);

        // selectPlant fills the Find box, loads the taxonomy and applies the type's
        // safe/caution rule — and it may untick the harmful box, which is the point.
        await selectPlant({ id: plant.id, name: plant.name, scientificName: plant.scientificName });
        showTab('contribute', true);
        setNotice('Moved to "Add to existing" for ' + plant.name + '. Check it and submit.' +
            (refused > 0 ? ' ' + refused + ' photo(s) did not fit under the limit.' : ''), 'success');
    }

    // -------------------------------------------------------- contribute ----
    function plantLabel(plant) {
        return plant.scientificName ? plant.name + ' (' + plant.scientificName + ')' : plant.name;
    }

    /** Library plants for the pickers. Empty term lists everything (first 50). */
    function plantsUrl(term, typeName) {
        var url = '/api/plants?pageSize=50';
        if (term) url += '&search=' + encodeURIComponent(term);
        if (typeName) url += '&type=' + encodeURIComponent(typeName);
        return url;
    }

    function renderPicker(plants) {
        if (!el.contributeResults) return;
        el.contributeResults.innerHTML = '';
        if (!plants.length) {
            el.contributeResults.innerHTML = '<p class="record-muted">Nothing matched.</p>';
        } else {
            plants.forEach(function (plant) {
                var button = document.createElement('button');
                button.type = 'button';
                button.className = 'record-picker-item';
                button.innerHTML = '<strong>' + escapeHtml(plant.name) + '</strong> ' +
                    '<em>' + escapeHtml(plant.scientificName) + '</em>' +
                    (plant.typeLabel ? '<span class="record-picker-type">' + PlantBadge.html(plant.typeLabel, plant.toxicityLevel) + '</span>' : '');
                button.addEventListener('click', function () {
                    selectPlant({ id: plant.id, name: plant.name, scientificName: plant.scientificName });
                    el.contributeResults.hidden = true;
                });
                el.contributeResults.appendChild(button);
            });
        }
        el.contributeResults.hidden = false;
    }

    /** Forgets the chosen plant without touching what the botanist is typing. */
    function clearSelection() {
        selectToken++;
        contributePlant = null;
        el.contributePlantId.value = '';
        if (el.contributeSelected) el.contributeSelected.hidden = true;
        renderTaxonomy(null);
        applyHarmfulVisibility('contribute', false);
        hideCarried('contribute');
    }

    /**
     * Chooses the plant a contribution goes to.
     *
     * The Find box is FILLED with the plant, not just annotated: the botanist
     * should be able to read what they picked in the place they typed it. Typing
     * over it clears the choice (see the input handler), so the box and the choice
     * can never disagree.
     */
    async function selectPlant(plant) {
        if (!plant) {
            clearSelection();
            return;
        }
        var token = ++selectToken;
        contributePlant = { id: plant.id, name: plant.name, scientificName: plant.scientificName || '', lookup: null };
        el.contributePlantId.value = plant.id;
        el.contributeSearch.value = plantLabel(contributePlant);
        el.contributeSelected.textContent = 'Adding to: ' + plantLabel(contributePlant);
        el.contributeSelected.hidden = false;

        try {
            var data = await api('/api/plants/lookup?plantId=' + encodeURIComponent(plant.id));
            if (token !== selectToken) return;   // the botanist moved on
            if (data.exists) {
                var found = data.plant;
                contributePlant.name = found.name;
                contributePlant.scientificName = found.scientificName;
                contributePlant.lookup = found;
                el.contributeSearch.value = plantLabel(contributePlant);
                el.contributeSelected.textContent = 'Adding to: ' + plantLabel(contributePlant);
                applyHarmfulVisibility('contribute', Boolean(found.isSafeType));
                renderTaxonomy(found);
            }
        } catch (err) {
            if (token !== selectToken) return;
            // Without the lookup the form still works; the server applies the
            // safe-type rule and the taxonomy lock regardless.
            renderTaxonomy(null);
        }
        await loadCarried('contribute', contributePlant.scientificName);
    }

    function debouncedSearch(immediate) {
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(async function () {
            // A chosen plant fills the box with its label, which would match
            // nothing, so browse the whole list instead.
            var typed = value('contributeSearch');
            var term = (contributePlant && typed === plantLabel(contributePlant)) ? '' : typed;
            try {
                var data = await api(plantsUrl(term, value('contributeTypeFilter')));
                renderPicker(data.plants || []);
            } catch (err) {
                renderPicker([]);
            }
        }, immediate ? 0 : DEBOUNCE_MS);
    }

    // ---------------------------------------------------- the scan photo ----
    /**
     * Looks for a photo cached by capture-plant.html. A File handle cannot cross
     * a page navigation, so IndexedDB is the only thing that can carry it. The
     * block is shown only while a cached photo exists and is not already in the
     * list — an empty slot is never rendered.
     */
    async function loadCarried(target, scientificName) {
        hideCarried(target);
        if (typeof window.takeScanPhoto !== 'function' || !scientificName) return;
        var list = target === 'new' ? newList : contributeList;
        if (list.hasCache(scientificName)) return;
        var record = await window.takeScanPhoto(scientificName);
        if (!record || !record.blob) return;
        var block = byId(target + 'CarriedPhoto');
        var img = byId(target + 'CarriedImg');
        if (!block || !img) return;
        block.carried = {
            scientificName: record.scientificName || scientificName,
            blob: record.blob,
            filename: record.filename || 'scan-photo.jpg',
            mimeType: record.mimeType || record.blob.type || 'image/jpeg'
        };
        img.src = URL.createObjectURL(record.blob);
        block.hidden = false;
    }

    function hideCarried(target) {
        var block = byId(target + 'CarriedPhoto');
        var img = byId(target + 'CarriedImg');
        if (img && img.getAttribute('src')) {
            URL.revokeObjectURL(img.getAttribute('src'));
            img.removeAttribute('src');
        }
        if (block) {
            block.carried = null;
            block.hidden = true;
        }
    }

    function useCarried(target) {
        var block = byId(target + 'CarriedPhoto');
        var carried = block && block.carried;
        if (!carried) return;
        var list = target === 'new' ? newList : contributeList;
        var file = new File([carried.blob], carried.filename, { type: carried.mimeType, lastModified: Date.now() });
        var problems = list.add([file], carried.scientificName);
        if (problems.length > 0) {
            setNotice(problems.join(' '), 'error');
            return;
        }
        hideCarried(target);
        setNotice('The scanned photo was added to this submission.', 'success');
    }

    async function dropCarried(target) {
        var block = byId(target + 'CarriedPhoto');
        var carried = block && block.carried;
        if (carried && typeof window.dropScanPhoto === 'function') {
            await window.dropScanPhoto(carried.scientificName);
        }
        hideCarried(target);
    }

    // ------------------------------------------------------------ taxonomy ----
    /**
     * The chosen plant's taxonomy, read-only. It belongs to the plant, so no
     * contribution can change it; the only way is a separate request, which this
     * panel also hosts. Hidden until a plant is chosen.
     */
    function renderTaxonomy(plant) {
        if (!el.taxonomyPanel) return;
        if (!plant) {
            el.taxonomyPanel.hidden = true;
            return;
        }
        el.taxonomyPanel.hidden = false;
        el.taxonomyGrid.innerHTML = '';
        el.taxonomyEditGrid.innerHTML = '';
        TAXONOMY_FIELDS.forEach(function (field) {
            var current = plant.taxonomy ? plant.taxonomy[field.level] : '';
            var gap = current === UNSPECIFIED;

            var wrap = document.createElement('div');
            wrap.className = 'record-field';
            var label = document.createElement('label');
            label.setAttribute('for', 'taxonomy-' + field.key);
            label.textContent = field.label;
            var input = document.createElement('input');
            input.type = 'text';
            input.id = 'taxonomy-' + field.key;
            input.value = current || '';
            input.readOnly = true;
            input.setAttribute('aria-readonly', 'true');
            if (gap) input.className = 'record-gap';
            wrap.appendChild(label);
            wrap.appendChild(input);
            el.taxonomyGrid.appendChild(wrap);

            var editWrap = document.createElement('div');
            editWrap.className = 'record-field';
            var editLabel = document.createElement('label');
            editLabel.setAttribute('for', 'taxonomyEdit-' + field.key);
            editLabel.textContent = field.label;
            var edit = document.createElement('input');
            edit.type = 'text';
            edit.id = 'taxonomyEdit-' + field.key;
            edit.autocomplete = 'off';
            edit.maxLength = 100;
            // A gap starts blank (blank = no change); a recorded level starts as
            // its current value, so a correction is an edit, not a retype.
            edit.value = gap ? '' : (current || '');
            edit.setAttribute('data-current', current || '');
            if (gap) edit.placeholder = 'Unspecified — add it';
            edit.addEventListener('keydown', function (event) {
                // Enter here must not submit the contribution form around this panel.
                if (event.key === 'Enter') event.preventDefault();
            });
            editWrap.appendChild(editLabel);
            editWrap.appendChild(edit);
            el.taxonomyEditGrid.appendChild(editWrap);
        });
        el.taxonomyRequest.hidden = true;
        el.taxonomyReason.value = '';
        var pending = Boolean(plant.hasPendingTaxonomyRequest);
        el.taxonomyPendingNote.hidden = !pending;
        el.taxonomyToggle.hidden = pending;
    }

    async function submitTaxonomy() {
        setNotice('', null);
        if (!contributePlant) return;
        var body = { reason: el.taxonomyReason.value.trim() };
        var changed = 0;
        TAXONOMY_FIELDS.forEach(function (field) {
            var input = byId('taxonomyEdit-' + field.key);
            var next = input ? input.value.trim().replace(/\s+/g, ' ') : '';
            if (next && next !== input.getAttribute('data-current')) {
                body[field.key] = next;
                changed++;
            }
        });
        if (changed === 0) {
            setNotice('Change at least one level before sending an update.', 'error');
            return;
        }
        setBusy(true);
        try {
            var result = await api('/api/plants/' + encodeURIComponent(contributePlant.id) + '/taxonomy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            setNotice('Taxonomy update sent for review as ' + result.requestId + '. ' +
                'It is reviewed separately from any description or photos.', 'success');
            if (contributePlant.lookup) {
                contributePlant.lookup.hasPendingTaxonomyRequest = true;
                renderTaxonomy(contributePlant.lookup);
            }
            mineStale = true;
        } catch (err) {
            setNotice(err.message, 'error');
        } finally {
            setBusy(false);
        }
    }

    // ------------------------------------------------------- contribution ----
    function validateContribution(parts) {
        var problems = [];
        if (!contributePlant) problems.push('Choose a plant to add to.');
        var caution = harmfulVisible('contribute') ? value('contributeHarmful') : '';
        if (byId('contributeIsHarmful').checked && !caution) {
            problems.push('Describe the things to watch out for, or untick "harmful".');
        }
        var photos = contributeList.count() + chosenIds('contribute').length;
        if (!hasAnyPartValue(parts) && !value('contributeUses') && !value('contributeBenefits') &&
            !caution && photos === 0) {
            problems.push('Add a description, some measurements, or one photo.');
        }
        if (photos > limits.maxFilesPerRequest) {
            problems.push('At most ' + limits.maxFilesPerRequest + ' photos per submission.');
        }
        return problems;
    }

    async function submitContribution(event) {
        event.preventDefault();
        setNotice('', null);

        var parts = readParts('contribute');
        var problems = validateContribution(parts);
        if (problems.length > 0) {
            setNotice(problems.join(' '), 'error');
            return;
        }

        var form = new FormData();
        form.append('parts', JSON.stringify(parts));
        form.append('uses', value('contributeUses'));
        form.append('benefits', value('contributeBenefits'));
        if (harmfulVisible('contribute')) form.append('harmful', value('contributeHarmful'));
        contributeList.files().forEach(function (file) { form.append('images', file, file.name); });
        // Same provenance field as the new-plant form, and for the same reason: a
        // report can be worked through either tab, and the link has to be
        // recorded whichever route was taken.
        if (discoveryRequestId) {
            form.append('discoveryRequestId', discoveryRequestId);
            form.append('discoveryImageIds', JSON.stringify(chosenIds('contribute')));
        }

        var cachedKeys = contributeList.cacheKeys();
        setBusy(true);
        try {
            var result = await api('/api/plants/' + encodeURIComponent(contributePlant.id) + '/contributions', {
                method: 'POST',
                body: form
            });
            if (typeof window.dropScanPhoto === 'function') {
                for (var i = 0; i < cachedKeys.length; i++) await window.dropScanPhoto(cachedKeys[i]);
            }

            var text = result.autoApproved
                ? 'Approved automatically as ' + result.requestId + ' — no human reviewed it.'
                : 'Contribution submitted for review as ' + result.requestId + '.';
            var warnings = result.warnings || [];
            setNotice(text + (warnings.length ? ' ' + warnings.join(' ') : ''), warnings.length ? 'warning' : 'success');

            el.contributeForm.reset();
            contributeList.clear();
            hideCarried('contribute');
            clearSelection();
            finishDiscovery();
            mineStale = true;
            showTab('mine');
        } catch (err) {
            setNotice(err.message, 'error');
        } finally {
            setBusy(false);
        }
    }

    // ------------------------------------------------------ request change ----
    /**
     * "Request change": the botanist picks an existing plant, edits what is wrong
     * and says why; an admin approves or denies it. Nothing changes until then.
     *
     * The form is built from the plant's CURRENT values (GET .../editable), and
     * only fields that differ are sent. A blank field means "no change": a
     * botanist cannot clear a value, so removal has to be explained in the reason.
     * The server stores each change with the value it was compared against, so an
     * approval can refuse a request that has gone stale.
     */
    function normalizeText(text) {
        return String(text == null ? '' : text).trim().replace(/\s+/g, ' ');
    }

    function changeInput(key) { return byId('change-' + key); }

    function resetChangeForm() {
        changeToken++;
        changePlant = null;
        changeDescription = null;
        if (el.changeForm) el.changeForm.hidden = true;
        if (el.changeBaseFields) el.changeBaseFields.innerHTML = '';
        if (el.changeDescFields) el.changeDescFields.innerHTML = '';
        if (el.changeSelected) el.changeSelected.hidden = true;
        if (el.changeBaseReason) el.changeBaseReason.value = '';
        if (el.changeDescReason) el.changeDescReason.value = '';
        if (el.changeBaseToggle) el.changeBaseToggle.checked = false;
        if (el.changeDescToggle) el.changeDescToggle.checked = false;
        if (el.changeBaseBody) el.changeBaseBody.hidden = true;
        if (el.changeDescBody) el.changeDescBody.hidden = true;
    }

    async function selectChangePlant(plant) {
        var token = ++changeToken;
        changePlant = null;
        el.changeForm.hidden = true;
        el.changeSearch.value = plantLabel(plant);
        try {
            var data = await api('/api/plants/' + encodeURIComponent(plant.id) + '/editable');
            if (token !== changeToken) return;   // the botanist moved on
            if (data.archived) {
                setNotice('That plant is archived and cannot be changed.', 'error');
                return;
            }
            changePlant = data;
            el.changeSelected.textContent = 'Requesting a change to: ' + plantLabel(plant);
            el.changeSelected.hidden = false;
            renderChangeForm(data);
        } catch (err) {
            if (token !== changeToken) return;
            setNotice(err.message, 'error');
        }
    }

    /**
     * The plant's OWN type, edited in place: name, medicinal, harmful + toxicity
     * level, caution note. It is pre-filled with what the plant has now and sent as
     * `type` only when something differs. It cannot affect any other plant.
     */
    function buildChangeTypeEditor(data) {
        var current = data.type;
        var box = document.createElement('fieldset');
        box.className = 'record-field record-field-wide record-checklist';
        box.id = 'change-type';
        box.setAttribute('data-current', JSON.stringify({
            typeName: current.typeName,
            isMedicinal: Boolean(current.isMedicinal),
            isHarmful: Boolean(current.isHarmful),
            toxicityLevel: current.isHarmful ? current.toxicityLevel : 'none',
            cautionNote: current.cautionNote || ''
        }));
        box.innerHTML =
            '<legend>This plant\u2019s type</legend>' +
            '<input type="text" id="change-typeName" maxlength="50" autocomplete="off" spellcheck="false">' +
            '<div id="change-typeSuggest" class="record-picker" hidden></div>' +
            '<label><input type="checkbox" id="change-isMedicinal"> Medicinal plant</label>' +
            '<label><input type="checkbox" id="change-isHarmful"> Harmful plant</label>' +
            '<div id="change-toxicityField" hidden>' +
                '<label for="change-toxicityLevel">Toxicity level *</label>' +
                '<select id="change-toxicityLevel">' +
                    '<option value="">Select\u2026</option>' +
                    '<option value="mild">Mild (yellow)</option>' +
                    '<option value="moderate">Moderate (orange)</option>' +
                    '<option value="severe">Severe (red)</option>' +
                '</select>' +
            '</div>' +
            '<label for="change-cautionNote">Caution note</label>' +
            '<textarea id="change-cautionNote" rows="2" maxlength="1000"></textarea>' +
            '<p class="record-muted" id="change-typeHint"></p>';
        box.querySelector('#change-typeName').value = current.typeName;
        box.querySelector('#change-isMedicinal').checked = Boolean(current.isMedicinal);
        box.querySelector('#change-isHarmful').checked = Boolean(current.isHarmful);
        box.querySelector('#change-toxicityLevel').value = current.isHarmful ? current.toxicityLevel : '';
        box.querySelector('#change-toxicityField').hidden = !current.isHarmful;
        box.querySelector('#change-cautionNote').value = current.cautionNote || '';
        if (window.RichText) RichText.attach(box.querySelector('#change-cautionNote'));

        attachTypeSuggest(box.querySelector('#change-typeName'), box.querySelector('#change-typeSuggest'));
        function refresh() {
            var harmful = box.querySelector('#change-isHarmful').checked;
            box.querySelector('#change-toxicityField').hidden = !harmful;
            if (!harmful) box.querySelector('#change-toxicityLevel').value = '';
            var name = normalizeTypeName(box.querySelector('#change-typeName').value);
            box.querySelector('#change-typeHint').innerHTML = name
                ? 'Badge preview: ' + PlantBadge.html(name, harmful ? box.querySelector('#change-toxicityLevel').value : 'none')
                : '';
        }
        box.addEventListener('input', refresh);
        box.addEventListener('change', refresh);
        refresh();
        return box;
    }

    function readChangeType() {
        var harmful = byId('change-isHarmful').checked;
        return {
            typeName: normalizeTypeName(byId('change-typeName').value),
            isMedicinal: byId('change-isMedicinal').checked,
            isHarmful: harmful,
            toxicityLevel: harmful ? byId('change-toxicityLevel').value : 'none',
            cautionNote: byId('change-cautionNote').value.trim()
        };
    }

    /** One labelled input, remembering what the plant records now in data-current. */
    function buildChangeField(id, label, kind, current, wide) {
        var text = current == null ? '' : String(current);
        var wrap = document.createElement('div');
        wrap.className = 'record-field' + (wide ? ' record-field-wide' : '');
        var labelEl = document.createElement('label');
        labelEl.setAttribute('for', id);
        labelEl.textContent = label;
        var input;
        if (kind === 'area') {
            input = document.createElement('textarea');
            input.rows = 3;
            input.setAttribute('data-richtext', '');
        } else {
            input = document.createElement('input');
            input.type = kind === 'num' ? 'number' : 'text';
            if (kind === 'num') input.step = 'any';
        }
        input.id = id;
        input.value = text;
        input.setAttribute('data-current', text);
        input.setAttribute('autocomplete', 'off');
        wrap.appendChild(labelEl);
        wrap.appendChild(input);
        if (kind === 'area' && window.RichText) RichText.attach(input);   // toolbar + preview
        return wrap;
    }

    /**
     * The plant's OWN taxonomy, one box per level. A recorded level starts as its
     * value; a gap (Unspecified) starts blank. Blank or unchanged means "no change".
     */
    function buildChangeTaxonomyEditor(data) {
        var box = document.createElement('fieldset');
        box.className = 'record-field record-field-wide record-checklist';
        var legend = document.createElement('legend');
        legend.textContent = 'Taxonomy';
        box.appendChild(legend);
        var grid = document.createElement('div');
        grid.className = 'record-grid';
        TAXONOMY_FIELDS.forEach(function (field) {
            var recorded = data.taxonomy ? data.taxonomy[field.level] : '';
            var current = recorded === UNSPECIFIED ? '' : recorded;
            var wrap = buildChangeField('change-tax-' + field.key, field.label, 'text', current, false);
            if (recorded === UNSPECIFIED) wrap.querySelector('input').placeholder = UNSPECIFIED;
            grid.appendChild(wrap);
        });
        box.appendChild(grid);
        return box;
    }

    /** The fields of ONE of the botanist's own descriptions. */
    function renderChangeDescriptionFields(data, description) {
        el.changeDescFields.innerHTML = '';
        DESC_FIELDS.forEach(function (field) {
            // A safe plant has no harmful text to record.
            if (field.harmful && data.isSafeType) return;
            var current = description.values[field.part ? 'parts.' + field.key : field.key];
            el.changeDescFields.appendChild(
                buildChangeField('changeDesc-' + field.key, field.label, field.kind, current, field.kind === 'area')
            );
        });
        el.changeDescReason.value = '';
    }

    function descriptionOptionLabel(description, index) {
        var snippet = RichText.plain(description.values.uses || description.values.benefits || description.values.harmful || '');
        snippet = snippet.length > 40 ? snippet.slice(0, 40) + '\u2026' : snippet;
        return 'Description ' + (index + 1) + (description.isPrimary ? ' (shown first)' : '') +
            ' \u00b7 ' + formatDate(description.createdAt).split(',')[0] +
            (snippet ? ' \u00b7 ' + snippet : '') +
            (description.hasPendingChange ? ' \u00b7 change pending' : '');
    }

    function renderChangeForm(data) {
        // ---- the plant info half ----
        el.changeBaseFields.innerHTML = '';
        BASE_TEXT_FIELDS.forEach(function (field) {
            el.changeBaseFields.appendChild(
                buildChangeField('change-' + field.key, field.label, 'text', data.values[field.key], false)
            );
        });
        el.changeBaseFields.appendChild(buildChangeTypeEditor(data));
        el.changeBaseFields.appendChild(buildChangeTaxonomyEditor(data));
        el.changeBaseReason.value = '';
        el.changeBaseToggle.checked = false;
        el.changeBaseToggle.disabled = Boolean(data.hasPendingBase);
        el.changeBaseBody.hidden = true;
        byId('changeBaseHint').textContent = data.hasPendingBase
            ? 'A change to this plant\u2019s info is already waiting for review (' + data.pendingBaseRequestId + ').'
            : 'Common name, scientific name, plant type and taxonomy. This is the plant\u2019s shared record.';

        // ---- the description half: only descriptions this botanist wrote ----
        var own = data.descriptions || [];
        var free = own.filter(function (d) { return !d.hasPendingChange; });
        changeDescription = free[0] || null;
        el.changeDescFields.innerHTML = '';
        el.changeDescReason.value = '';
        el.changeDescToggle.checked = false;
        el.changeDescToggle.disabled = !changeDescription;
        el.changeDescBody.hidden = true;
        el.changeDescPick.innerHTML = '';
        own.forEach(function (description, index) {
            var option = document.createElement('option');
            option.value = description.descriptionId;
            option.textContent = descriptionOptionLabel(description, index);
            option.disabled = description.hasPendingChange;
            el.changeDescPick.appendChild(option);
        });
        if (changeDescription) el.changeDescPick.value = changeDescription.descriptionId;
        el.changeDescPickWrap.hidden = own.length < 2;
        byId('changeDescHint').textContent = own.length === 0
            ? 'You have no approved description on this plant yet, so there is nothing of yours to change. Add one under Contribute.'
            : !changeDescription
                ? 'Every description of yours on this plant already has a change waiting for review.'
                : 'Uses, benefits, things to watch out for and measurements. Each botanist\u2019s description is separate, so this only changes one you wrote.';
        if (changeDescription) renderChangeDescriptionFields(data, changeDescription);

        el.changeForm.hidden = false;
    }

    /** Reads the plant-info half. Returns { section } or { error }. */
    function readBaseChange() {
        var section = { taxonomy: {}, reason: normalizeText(el.changeBaseReason.value) };
        var changed = 0;
        BASE_TEXT_FIELDS.forEach(function (field) {
            var input = changeInput(field.key);
            var next = normalizeText(input.value);
            if (next === '' || next === normalizeText(input.getAttribute('data-current'))) return;
            section[field.key] = next;
            changed++;
        });
        TAXONOMY_FIELDS.forEach(function (field) {
            var input = byId('change-tax-' + field.key);
            var next = normalizeText(input.value);
            if (next === '' || next === normalizeText(input.getAttribute('data-current'))) return;
            section.taxonomy[field.key] = next;
            changed++;
        });

        var typeBox = byId('change-type');
        if (typeBox) {
            var wanted = readChangeType();
            var was = JSON.parse(typeBox.getAttribute('data-current'));
            var typeChanged = ['typeName', 'isMedicinal', 'isHarmful', 'toxicityLevel', 'cautionNote']
                .some(function (key) { return wanted[key] !== was[key]; });
            if (typeChanged) {
                // The box is pre-filled, so a blank name is a mistake, not "no change".
                if (!wanted.typeName) return { error: 'The plant type cannot be blank.' };
                if (wanted.isHarmful && !wanted.toxicityLevel) {
                    return { error: 'Choose a toxicity level for a harmful plant.' };
                }
                section.type = wanted;
                changed++;
            }
        }
        if (changed === 0) {
            return { error: 'Plant info: edit at least one field, or untick it to leave the plant info alone.' };
        }
        if (!section.reason) return { error: 'Say why the plant info needs changing.' };
        return { section: section };
    }

    /** Reads the description half. Returns { section } or { error }. */
    function readDescriptionChange() {
        if (!changeDescription) return { error: 'Choose which of your descriptions to change.' };
        var section = {
            descriptionId: changeDescription.descriptionId,
            parts: {},
            reason: normalizeText(el.changeDescReason.value)
        };
        var changed = 0;
        DESC_FIELDS.forEach(function (field) {
            var input = byId('changeDesc-' + field.key);
            if (!input) return;
            var next = normalizeText(input.value);
            // Blank or unchanged is "no change"; the server ignores blanks too.
            if (next === '' || next === normalizeText(input.getAttribute('data-current'))) return;
            if (field.part) section.parts[field.key] = next; else section[field.key] = next;
            changed++;
        });
        if (changed === 0) {
            return { error: 'Your description: edit at least one field, or untick it to leave your description alone.' };
        }
        if (!section.reason) return { error: 'Say why your description needs changing.' };
        return { section: section };
    }

    async function submitChange(event) {
        event.preventDefault();
        setNotice('', null);
        if (!changePlant) {
            setNotice('Choose a plant first.', 'error');
            return;
        }

        // Only the halves the botanist ticked are sent. An unticked half is not
        // requested, so the record it covers is never touched.
        var baseOn = el.changeBaseToggle.checked && !el.changeBaseToggle.disabled;
        var descOn = el.changeDescToggle.checked && !el.changeDescToggle.disabled;
        if (!baseOn && !descOn) {
            setNotice('Tick what you want to change: the plant info, your description, or both.', 'error');
            return;
        }

        var body = {};
        if (baseOn) {
            var base = readBaseChange();
            if (base.error) { setNotice(base.error, 'error'); return; }
            body.base = base.section;
        }
        if (descOn) {
            var desc = readDescriptionChange();
            if (desc.error) { setNotice(desc.error, 'error'); return; }
            body.description = desc.section;
        }

        setBusy(true);
        try {
            var result = await api('/api/plants/' + encodeURIComponent(changePlant.id) + '/changes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            var ids = (result.requests || []).map(function (r) { return r.requestId; }).join(' and ');
            setNotice('Change request' + ((result.requests || []).length > 1 ? 's' : '') +
                ' sent for review as ' + (ids || result.requestId) + '. ' +
                'Nothing changes until an admin decides each one.', 'success');
            el.changeSearch.value = '';
            resetChangeForm();
            mineStale = true;
            showTab('mine');
        } catch (err) {
            // Surfaced verbatim: a 409 here usually means a change is already waiting.
            setNotice(err.message, 'error');
        } finally {
            setBusy(false);
        }
    }

    function renderChangePicker(plants) {
        var box = el.changeResults;
        if (!box) return;
        box.innerHTML = '';
        if (!plants.length) {
            box.innerHTML = '<p class="record-muted">Nothing matched.</p>';
        } else {
            plants.forEach(function (plant) {
                var button = document.createElement('button');
                button.type = 'button';
                button.className = 'record-picker-item';
                button.innerHTML = '<strong>' + escapeHtml(plant.name) + '</strong> ' +
                    '<em>' + escapeHtml(plant.scientificName) + '</em>' +
                    (plant.typeLabel ? '<span class="record-picker-type">' + PlantBadge.html(plant.typeLabel, plant.toxicityLevel) + '</span>' : '');
                button.addEventListener('click', function () {
                    box.hidden = true;
                    selectChangePlant({ id: plant.id, name: plant.name, scientificName: plant.scientificName });
                });
                box.appendChild(button);
            });
        }
        box.hidden = false;
    }

    function debouncedChangeSearch(immediate) {
        if (changeTimer) clearTimeout(changeTimer);
        changeTimer = setTimeout(async function () {
            var typed = value('changeSearch');
            var chosenLabel = changePlant ? plantLabel({
                name: changePlant.values.commonName, scientificName: changePlant.values.scientificName
            }) : null;
            var term = (chosenLabel && typed === chosenLabel) ? '' : typed;
            try {
                var data = await api(plantsUrl(term, value('changeTypeFilter')));
                renderChangePicker(data.plants || []);
            } catch (err) {
                renderChangePicker([]);
            }
        }, immediate ? 0 : DEBOUNCE_MS);
    }

    // ----------------------------------------------------- my submissions ----
    var STATUS_CLASS = { pending: 'pending', approved: 'approved', denied: 'denied', cancelled: 'cancelled' };

    function requestTypeLabel(type) {
        if (type === 'plant_addition') return 'New plant submission';
        if (type === 'plant_contribution') return 'Contribution';
        if (type === 'plant_taxonomy') return 'Taxonomy update';
        if (type === 'plant_change') return 'Change request';
        if (type === 'plant_discovery') return 'Discovery report';
        return type;
    }

    /** A change request names which half it covers; older ones have no scope. */
    function changeScopeLabel(request) {
        if (request.changeScope === 'base') return 'Change request \u00b7 plant info';
        if (request.changeScope === 'description') return 'Change request \u00b7 my description';
        return 'Change request';
    }

    var CHANGE_FIELD_LABELS = {
        commonName: 'Common name', scientificName: 'Scientific name',
        'type.typeName': 'Type', 'type.isMedicinal': 'Medicinal', 'type.isHarmful': 'Harmful',
        'type.toxicityLevel': 'Toxicity level', 'type.cautionNote': 'Caution note',
        'taxonomy.kingdom': 'Kingdom', 'taxonomy.phylum': 'Phylum', 'taxonomy.class': 'Class',
        'taxonomy.order': 'Order', 'taxonomy.family': 'Family', 'taxonomy.genus': 'Genus',
        'taxonomy.species': 'Species',
        uses: 'Uses', benefits: 'Benefits', harmful: 'Things to watch out for',
        'parts.heightMinCm': 'Height min', 'parts.heightMaxCm': 'Height max',
        'parts.widthMinCm': 'Width min', 'parts.widthMaxCm': 'Width max',
        'parts.heightNote': 'Height note', 'parts.widthNote': 'Width note',
        'parts.color': 'Color', 'parts.shape': 'Shape', 'parts.texture': 'Texture'
    };

    function formatDate(raw) {
        if (!raw) return '';
        var date = new Date(raw);
        return isNaN(date.getTime()) ? String(raw) : date.toLocaleString();
    }

    function renderMine(data) {
        if (!el.mineList) return;
        if (!data.requests.length) {
            el.mineList.innerHTML = '<p class="record-muted">You have not submitted anything yet.</p>';
            return;
        }

        el.mineList.innerHTML = data.requests.map(function (request) {
            var html = '<article class="record-submission">';
            html += '<h3>' + escapeHtml(request.requestType === 'plant_change' ? changeScopeLabel(request) : requestTypeLabel(request.requestType)) + '</h3>';
            html += '<p><span class="record-badge ' + (STATUS_CLASS[request.status] || 'pending') + '">' +
                escapeHtml(request.status) + '</span>';
            if (request.status === 'approved' && request.approvalMode === 'auto') {
                html += ' <span class="record-badge">auto &middot; no human review</span>';
            }
            html += '</p>';

            if (request.targetPlantName) {
                if (request.targetPlantId) {
                    html += '<p>Plant: <a href="plant-profile.html?plantId=' +
                        encodeURIComponent(request.targetPlantId) + '">' +
                        escapeHtml(request.targetPlantName) + '</a></p>';
                } else {
                    html += '<p>Plant: ' + escapeHtml(request.targetPlantName) + '</p>';
                }
            }

            if (request.taxonomyChanges) {
                html += '<ul class="record-muted">';
                Object.keys(request.taxonomyChanges).forEach(function (level) {
                    var change = request.taxonomyChanges[level];
                    html += '<li>' + escapeHtml(level) + ': ' + escapeHtml(change.from) +
                        ' &rarr; <strong>' + escapeHtml(change.to) + '</strong></li>';
                });
                html += '</ul>';
            }

            // A change request: each field it asks to change, before and after.
            if (request.changes) {
                html += '<ul class="record-muted">';
                Object.keys(request.changes).forEach(function (key) {
                    var change = request.changes[key] || {};
                    var from = change.fromLabel != null ? change.fromLabel : change.from;
                    var to = change.toLabel != null ? change.toLabel : change.to;
                    if (key === 'uses' || key === 'benefits' || key === 'harmful' || key === 'type.cautionNote') {
                        from = from == null ? from : RichText.plain(from);
                        to = to == null ? to : RichText.plain(to);
                    }
                    html += '<li>' + escapeHtml(CHANGE_FIELD_LABELS[key] || key) + ': ' +
                        escapeHtml(from == null || from === '' ? '(empty)' : from) +
                        ' &rarr; <strong>' + escapeHtml(to == null || to === '' ? '(empty)' : to) + '</strong></li>';
                });
                html += '</ul>';
                if (request.changeReason) {
                    html += '<p class="record-note">Reason: ' + escapeHtml(request.changeReason) + '</p>';
                }
            }

            html += '<p class="record-muted">Submitted ' + escapeHtml(formatDate(request.createdAt));
            if (request.reviewedAt) html += ' &middot; reviewed ' + escapeHtml(formatDate(request.reviewedAt));
            var reviewer = request.reviewerLabel || request.reviewerName;
            if (reviewer) html += ' by ' + escapeHtml(reviewer);
            html += '</p>';

            if (request.note) html += '<p class="record-note">' + escapeHtml(request.note) + '</p>';

            // A record made from a claimed discovery report loses its link to that
            // report the moment the botanist leaves the banner screen, and the
            // note field is not a reliable substitute: the report is the evidence.
            if (request.discoveryRequestId) {
                html += '<p class="record-muted">From discovery report ' +
                    '<a href="discoveries.html?report=' +
                    encodeURIComponent(request.discoveryRequestId) + '">' +
                    escapeHtml(request.discoveryRequestId) + '</a></p>';
            }

            // The submitter's own photos, whatever the status, through the OWNER
            // route. The public library still shows approved photos only. Each
            // photo has its own status, because the admin decides them one by one.
            if (request.images && request.images.length) {
                html += '<div class="record-images">';
                request.images.forEach(function (image) {
                    html += '<figure class="record-submission-image">' +
                        '<a class="record-image-link" href="' + escapeHtml(image.url) + '" target="_blank" rel="noopener">' +
                        '<img src="' + escapeHtml(image.url) + '" alt="' +
                        escapeHtml(image.originalFilename || 'Submitted photo') + '"></a>' +
                        '<figcaption><span class="record-badge ' +
                        (STATUS_CLASS[image.status] || (image.status === 'rejected' ? 'denied' : 'pending')) + '">' +
                        escapeHtml(image.status) + '</span></figcaption>' +
                        '</figure>';
                });
                html += '</div>';
            }

            // Photos can still be added to an approved species later.
            if (request.status === 'approved' && request.requestType === 'plant_addition' &&
                request.targetPlantId) {
                html += '<button type="button" class="btn record-btn-secondary record-add-photos" ' +
                    'data-plant-id="' + escapeHtml(request.targetPlantId) + '" ' +
                    'data-plant-name="' + escapeHtml(request.targetPlantName || '') + '">Add photos</button>';
            }

            // Only the submitter can withdraw, and only while nobody has decided it yet.
            if (request.status === 'pending') {
                html += '<button type="button" class="btn record-btn-secondary record-withdraw" ' +
                    'data-request-id="' + escapeHtml(request.id) + '">Withdraw submission</button>';
            }

            html += '</article>';
            return html;
        }).join('');

        el.mineList.querySelectorAll('.record-withdraw').forEach(function (button) {
            button.addEventListener('click', async function () {
                if (!window.confirm('Withdraw this submission? Reviewers will no longer see it, and its photos will not be published.')) return;
                button.disabled = true;
                try {
                    await api('/api/plants/requests/' + encodeURIComponent(button.getAttribute('data-request-id')) + '/withdraw', { method: 'POST' });
                    setNotice('Submission withdrawn.', 'success');
                    loadMine();
                } catch (err) {
                    setNotice(err.message, 'error');
                    button.disabled = false;
                    loadMine();   // a 409 means it was decided meanwhile: show its real status
                }
            });
        });

        el.mineList.querySelectorAll('.record-add-photos').forEach(function (button) {
            button.addEventListener('click', function () {
                selectPlant({
                    id: button.getAttribute('data-plant-id'),
                    name: button.getAttribute('data-plant-name')
                });
                showTab('contribute');
                el.contributeImages.focus();
            });
        });
    }

    async function loadMine() {
        if (!el.mineList) return;
        mineStale = false;
        if (!el.mineList.querySelector('.record-submission')) {
            el.mineList.innerHTML = '<p class="record-muted">Loading your submissions…</p>';
        }
        try {
            var data = await api('/api/plants/mine?page=' + minePage + '&pageSize=' + PAGE_SIZE);
            mineTotal = data.total;
            renderMine(data);

            if (el.minePagination) {
                var pages = totalPages(mineTotal);
                el.minePagination.hidden = pages <= 1;
                el.mineInfo.textContent = 'Page ' + data.page + ' of ' + pages +
                    ' (' + mineTotal + ' submission' + (mineTotal === 1 ? '' : 's') + ')';
                el.minePrev.disabled = data.page <= 1;
                el.mineNext.disabled = data.page >= pages;
            }
        } catch (err) {
            el.mineList.innerHTML = '';
            setNotice(err.message, 'error');
        }
    }

    function totalPages(total) {
        return Math.max(1, Math.ceil(total / Math.min(PAGE_SIZE, MAX_PAGE_SIZE)));
    }

    // ------------------------------------------------------- deep links ------
    /** ?plantId= preselects the contribute (or change) tab's plant. */
    async function applyDeepLink(tab) {
        var params = new URLSearchParams(window.location.search);

        var plantId = params.get('plantId');
        if (plantId) {
            try {
                var plant = await api('/api/plants/lookup?plantId=' + encodeURIComponent(plantId));
                if (plant.exists) {
                    var chosen = { id: plant.plant.id, name: plant.plant.name, scientificName: plant.plant.scientificName };
                    if (tab === 'change') await selectChangePlant(chosen);
                    else await selectPlant(chosen);
                } else {
                    setNotice('That plant could not be found.', 'error');
                }
            } catch (err) {
                setNotice('That plant could not be loaded: ' + err.message, 'error');
            }
        }

        var scientific = (params.get('scientificName') || '').trim();
        var common = (params.get('commonName') || '').trim();
        if (tab === 'new' && (scientific || common)) {
            // A HINT, not a prefill. The prediction is the reason the botanist is
            // being asked, so it is not trustworthy input and must not silently
            // become the recorded name.
            if (el.newPlantHint) {
                el.newPlantHint.hidden = false;
                el.newPlantHint.innerHTML = 'From your scan: <strong>' +
                    escapeHtml(scientific || common) + '</strong>. ' +
                    'Check it against the plant in front of you before submitting.';
            }
            // The scan photo is OFFERED, never attached by itself.
            if (scientific) await loadCarried('new', scientific);
            // The scan's "Record this plant" link always opens this tab, even for a
            // species that is already in the library. Look it up now (the name box
            // stays empty: the prediction is a hint) so the botanist is offered the
            // contribution path immediately instead of finding out at submit.
            if (scientific) {
                try {
                    var found = await api('/api/plants/lookup?scientificName=' + encodeURIComponent(scientific));
                    if (found.exists) {
                        existingForNew = found.plant;
                        renderDuplicate();
                    }
                } catch (err) { /* the submit-time check still applies */ }
            }
        }
    }

    // ----------------------------------------------------------- plant types --
    async function loadTypes() {
        try {
            var data = await api('/api/plants/types');
            // One entry per NAME, most used first (the server groups them): every plant
            // owns its own type row, so the list is names, not rows.
            typeNames = (data.types || []).map(function (type) {
                return { typeName: type.typeName, plantCount: Number(type.plantCount) || 0 };
            });

            // The Find-a-plant filters on the two picker tabs. Their value is the
            // typeName, because that is what GET /api/plants?type= expects.
            ['contributeTypeFilter', 'changeTypeFilter'].forEach(function (id) {
                var select = byId(id);
                if (!select) return;
                var previous = select.value;
                select.innerHTML = '<option value="">All types</option>';
                typeNames.forEach(function (type) {
                    var option = document.createElement('option');
                    option.value = type.typeName;
                    option.textContent = type.typeName;
                    select.appendChild(option);
                });
                select.value = previous;
            });
        } catch (err) {
            // The suggestion list stays empty; typing a type still works.
        }
    }

    // --------------------------------banner --
    /**
     * ?from=<requestId> is how discoveries.html hands a report to a botanist.
     *
     * The report's photos are SHOWN in the banner and OFFERED as tickable photos
     * in both forms. Ticking one asks the server to COPY it into the submission
     * as a pending plant photo: the report keeps its own file as evidence, and the
     * copy has to be approved by an admin like any other photo. Nothing is ticked
     * by default, and the server refuses an id that is not on the claimed report.
     */
    function discoveryParam() {
        var params = new URLSearchParams(window.location.search);
        var from = params.get('from');
        return from && /^req_\d{6}$/.test(from) ? from : null;
    }

    async function initDiscoveryBanner() {
        var banner = byId('discoveryBanner');
        discoveryRequestId = discoveryParam();
        // A bare ?from= with no ?tab= lands on "new plant", because recording a
        // newly discovered species IS a new plant. initialTab() already does
        // that; ?from= simply must not send it anywhere else.
        if (!banner || !discoveryRequestId) return;

        var meta = byId('discoveryBannerMeta');
        var list = byId('discoveryPhotoList');
        meta.textContent = 'Report ' + discoveryRequestId + ' — submitting the form below will send this report for review.';

        try {
            var response = await fetch('/api/discoveries?page=1&pageSize=50', { credentials: 'include' });
            if (response.status === 403) {
                // No record_plant: the whole form is already gated.
                return;
            }
            if (!response.ok) throw new Error('Queue unavailable');
            var data = await response.json();
            var card = null;
            for (var i = 0; i < data.requests.length; i++) {
                if (data.requests[i].requestId === discoveryRequestId) card = data.requests[i];
            }
            if (!card) {
                // Paged past it, or already decided. Say so rather than showing an
                // empty banner that looks like a loading failure.
                meta.textContent = 'Report ' + discoveryRequestId + ' is no longer in the queue. ' +
                    'It may have been recorded, closed, or is on another page.';
                banner.hidden = false;
                return;
            }
            banner.hidden = false;
            if (card.reporterName) {
                meta.textContent = 'Report ' + discoveryRequestId + ' from ' + card.reporterName +
                    '. Submitting the form below sends this report for review.';
            }
            if (card.note) {
                var noteLi = document.createElement('li');
                noteLi.className = 'record-discovery-note';
                noteLi.textContent = card.note;
                list.appendChild(noteLi);
            }
            discoveryImages = (card.images || []).filter(function (image) { return image.imageId && image.url; });
            discoveryImages.forEach(function (image) {
                var li = document.createElement('li');
                var open = document.createElement('button');
                open.type = 'button';
                open.className = 'record-thumb-open';
                open.setAttribute('data-preview', image.url);
                open.setAttribute('aria-label', 'Preview report photo');
                var img = document.createElement('img');
                img.src = image.url;
                img.alt = 'Photo attached to report ' + discoveryRequestId;
                open.appendChild(img);
                li.appendChild(open);
                list.appendChild(li);
            });
            list.addEventListener('click', function (event) {
                var open = event.target.closest('.record-thumb-open');
                if (open) openPreview(open.getAttribute('data-preview'), 'Report photo', open);
            });
            if (list.children.length === 0) list.hidden = true;
            renderReportPhotoPickers();
        } catch (err) {
            // A banner is an aid. The form must still work without it.
            console.error('Discovery banner failed:', err);
            banner.hidden = true;
            discoveryImages = [];
        }
    }

    // ------------------------------------------------------------------ init --
    async function init() {
        el = {
            gate: byId('recordGate'),
            ui: byId('recordUi'),
            notice: byId('recordNotice'),
            modal: byId('imageModal'),
            modalImg: byId('imageModalImg'),
            modalClose: byId('imageModalClose'),
            newPlantForm: byId('newPlantForm'),
            newPlantHint: byId('newPlantHint'),
            newDuplicateWarning: byId('newDuplicateWarning'),
            newTypeName: byId('newTypeName'),
            newTypeMedicinal: byId('newTypeMedicinal'),
            newToxicityLevel: byId('newToxicityLevel'),
            newCautionNote: byId('newCautionNote'),
            newHeightMinCm: byId('newHeightMinCm'),
            newHeightMaxCm: byId('newHeightMaxCm'),
            newWidthMinCm: byId('newWidthMinCm'),
            newWidthMaxCm: byId('newWidthMaxCm'),
            newImages: byId('newImages'),
            newSubmit: byId('newPlantSubmit'),
            contributeForm: byId('contributeForm'),
            contributeSearch: byId('contributeSearch'),
            contributeResults: byId('contributeResults'),
            contributeSelected: byId('contributeSelected'),
            contributePlantId: byId('contributePlantId'),
            contributeImages: byId('contributeImages'),
            contributeSubmit: byId('contributeSubmit'),
            taxonomyPanel: byId('taxonomyPanel'),
            taxonomyGrid: byId('taxonomyGrid'),
            taxonomyEditGrid: byId('taxonomyEditGrid'),
            taxonomyRequest: byId('taxonomyRequest'),
            taxonomyReason: byId('taxonomyReason'),
            taxonomyToggle: byId('taxonomyToggle'),
            taxonomyPendingNote: byId('taxonomyPendingNote'),
            taxonomySubmit: byId('taxonomySubmit'),
            changeSearch: byId('changeSearch'),
            changeResults: byId('changeResults'),
            changeSelected: byId('changeSelected'),
            changeForm: byId('changeForm'),
            changeBaseToggle: byId('changeBaseToggle'),
            changeBaseBody: byId('changeBaseBody'),
            changeBaseFields: byId('changeBaseFields'),
            changeBaseReason: byId('changeBaseReason'),
            changeDescToggle: byId('changeDescToggle'),
            changeDescBody: byId('changeDescBody'),
            changeDescPickWrap: byId('changeDescPickWrap'),
            changeDescPick: byId('changeDescPick'),
            changeDescFields: byId('changeDescFields'),
            changeDescReason: byId('changeDescReason'),
            changeSubmit: byId('changeSubmit'),
            mineList: byId('mineList'),
            minePagination: byId('minePagination'),
            mineInfo: byId('mineInfo'),
            minePrev: byId('minePrev'),
            mineNext: byId('mineNext')
        };

        // The HTML shell is public by choice; only the APIs enforce (403). This
        // gate just avoids showing forms that cannot work. sidebar.js already
        // asked who this is — one fetch, one answer, no second try/catch here to
        // collapse every failure into user = null.
        var user = await window.plantAuth.ready;
        // A signed-out visitor and a signed-in non-botanist are in the SAME state
        // here: neither can record, and signing in would not change that for a
        // plain account. So they get one message rather than two presentations of
        // one fact.
        const NO_RECORD = 'Botanist access required. Every form is hidden because the APIs would answer 403 anyway.';
        if (!user || !(user.permissions || []).includes('record_plant')) {
            setGate(NO_RECORD);
            el.ui.hidden = true;
            return;
        }
        el.ui.hidden = false;

        initModal();

        newList = createImageList({
            grid: byId('newThumbs'),
            reserved: function () { return reportReserved('new'); },
            onCacheItemRemoved: function (key) { loadCarried('new', key); }
        });
        contributeList = createImageList({
            grid: byId('contributeThumbs'),
            reserved: function () { return reportReserved('contribute'); },
            onCacheItemRemoved: function (key) { loadCarried('contribute', key); }
        });
        initReportPhotoPickers();

        await loadLimits();
        await initDiscoveryBanner();

        TAB_IDS.forEach(function (id) {
            var button = byId('tab-' + id);
            if (button) button.addEventListener('click', function () { showTab(id, true); });
        });

        // The harmful checkbox shows / hides "Things to watch out for".
        ['new', 'contribute'].forEach(function (prefix) {
            byId(prefix + 'IsHarmful').addEventListener('change', function () { syncHarmful(prefix); });
        });

        el.newPlantForm.addEventListener('submit', submitNewPlant);
        byId('newScientificName').addEventListener('blur', refreshExistingForNew);
        byId('newScientificName').addEventListener('input', function () {
            // Typing a different name than the collision ends the collision.
            if (existingForNew && value('newScientificName').toLowerCase() !== existingForNew.scientificName.toLowerCase()) {
                existingForNew = null;
                renderDuplicate();
            }
        });
        attachTypeSuggest(el.newTypeName, byId('newTypeSuggest'));

        // Previews the badge this plant will wear: its name in the colour of its toxicity.
        function updateNewTypeHint() {
            var hint = byId('newTypeHint');
            var name = normalizeTypeName(el.newTypeName.value);
            if (!name) { hint.hidden = true; hint.innerHTML = ''; return; }
            var harmful = byId('newIsHarmful').checked;
            hint.hidden = false;
            hint.innerHTML = 'Badge preview: ' + PlantBadge.html(name, harmful ? el.newToxicityLevel.value : 'none');
        }
        [el.newTypeName, el.newTypeMedicinal, el.newToxicityLevel, byId('newIsHarmful')].forEach(function (node) {
            node.addEventListener('input', updateNewTypeHint);
            node.addEventListener('change', updateNewTypeHint);
        });

        el.newImages.addEventListener('change', function () {
            var problems = newList.add(Array.from(el.newImages.files || []));
            el.newImages.value = '';   // so the same file can be chosen again after removing it
            if (problems.length > 0) setNotice(problems.join(' '), 'error');
        });
        el.contributeImages.addEventListener('change', function () {
            var problems = contributeList.add(Array.from(el.contributeImages.files || []));
            el.contributeImages.value = '';
            if (problems.length > 0) setNotice(problems.join(' '), 'error');
        });

        el.contributeSearch.addEventListener('input', function () {
            // Editing the box after choosing a plant abandons that choice, so the
            // text and the selection cannot disagree.
            if (contributePlant && value('contributeSearch') !== plantLabel(contributePlant)) clearSelection();
            debouncedSearch(false);
        });
        el.contributeForm.addEventListener('submit', submitContribution);

        // Request change: same pattern as the contribute picker. Typing over a
        // chosen plant abandons that choice and hides the form built from it.
        el.changeSearch.addEventListener('input', function () {
            if (changePlant && value('changeSearch') !== plantLabel({
                name: changePlant.values.commonName, scientificName: changePlant.values.scientificName
            })) {
                resetChangeForm();
            }
            debouncedChangeSearch(false);
        });
        el.changeForm.addEventListener('submit', submitChange);
        // Each half opens only when ticked; a half left unticked is never sent.
        el.changeBaseToggle.addEventListener('change', function () {
            el.changeBaseBody.hidden = !el.changeBaseToggle.checked;
        });
        el.changeDescToggle.addEventListener('change', function () {
            el.changeDescBody.hidden = !el.changeDescToggle.checked;
        });
        el.changeDescPick.addEventListener('change', function () {
            if (!changePlant) return;
            var picked = (changePlant.descriptions || []).filter(function (d) {
                return d.descriptionId === el.changeDescPick.value;
            })[0];
            if (!picked || picked.hasPendingChange) return;
            changeDescription = picked;
            renderChangeDescriptionFields(changePlant, picked);
        });

        // Open the dropdown on focus and re-run it when the type filter changes.
        el.contributeSearch.addEventListener('focus', function () { debouncedSearch(true); });
        byId('contributeTypeFilter').addEventListener('change', function () { debouncedSearch(true); });
        el.changeSearch.addEventListener('focus', function () { debouncedChangeSearch(true); });
        byId('changeTypeFilter').addEventListener('change', function () { debouncedChangeSearch(true); });

        // Close either dropdown when clicking elsewhere.
        document.addEventListener('click', function (event) {
            [[el.contributeResults, 'contributeSearch', 'contributeTypeFilter'],
             [el.changeResults, 'changeSearch', 'changeTypeFilter']].forEach(function (set) {
                if (!set[0] || set[0].hidden) return;
                var inside = set[0].contains(event.target) ||
                    event.target === byId(set[1]) || event.target === byId(set[2]);
                if (!inside) set[0].hidden = true;
            });
        });

        byId('newUseCarried').addEventListener('click', function () { useCarried('new'); });
        byId('newDropCarried').addEventListener('click', function () { dropCarried('new'); });
        byId('contributeUseCarried').addEventListener('click', function () { useCarried('contribute'); });
        byId('contributeDropCarried').addEventListener('click', function () { dropCarried('contribute'); });

        el.taxonomyToggle.addEventListener('click', function () {
            el.taxonomyRequest.hidden = !el.taxonomyRequest.hidden;
        });
        byId('taxonomyCancel').addEventListener('click', function () { el.taxonomyRequest.hidden = true; });
        el.taxonomySubmit.addEventListener('click', submitTaxonomy);

        if (el.minePrev) {
            el.minePrev.addEventListener('click', function () {
                if (minePage > 1) { minePage--; loadMine(); }
            });
        }
        if (el.mineNext) {
            el.mineNext.addEventListener('click', function () {
                if (minePage < totalPages(mineTotal)) { minePage++; loadMine(); }
            });
        }

        // Submitted photos open in the same preview dialog; the link stays a real
        // href so open-in-new-tab still works.
        el.mineList.addEventListener('click', function (event) {
            var link = event.target.closest('.record-image-link');
            if (!link || event.metaKey || event.ctrlKey || event.shiftKey) return;
            event.preventDefault();
            var img = link.querySelector('img');
            openPreview(link.getAttribute('href'), img ? img.alt : '', link);
        });

        var tab = initialTab();
        await loadTypes();
        await applyDeepLink(tab);
        showTab(tab, true);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();