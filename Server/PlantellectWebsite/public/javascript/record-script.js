/**
 * Record page controller for record.html.
 *
 * Three tabs, all query-param based (?tab=), never hash based: a hash has no
 * consumer on this page and would be a trap for the next reader.
 *
 *   - NEW PLANT      -> POST /api/plants/requests            (text only)
 *   - ADD TO EXISTING-> POST /api/plants/:plantId/contributions (multipart)
 *   - MY SUBMISSIONS -> GET  /api/plants/mine
 *
 * Reuses window.escapeHtml and window.checkAuth from public/javascript/auth.js
 * rather than adding a fifth local escapeHtml copy.
 *
 * Client-side upload limits duplicate settings.plantImages, which the browser
 * cannot read. That is unavoidable: a stale client limit is only a worse error
 * message, never a wrong outcome, because the server still enforces the real one.
 */

(function () {
    'use strict';

    var PAGE_SIZE = 10;   // settings.pagination.defaultPageSize
    var MAX_PAGE_SIZE = 50; // settings.pagination.maxPageSize
    var DEBOUNCE_MS = 300;

    // Mirrors settings.plantImages and settings.ml (the browser cannot read
    // settings.js). Keep the accept list in sync with it, the way the
    // certificate accept attribute already follows.
    var MAX_IMAGE_BYTES = 10 * 1024 * 1024;
    var MAX_FILES = 20;
    var IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp';

    var el = {};
    var activeTab = 'new';
    var minePage = 1;
    var mineTotal = 0;
    var carriedPhoto = null;   // { scientificName, blob, filename }
    var contributePlant = null; // { id, name, scientificName }
    var searchTimer = null;

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

    async function api(pathname, options) {
        var response = await fetch(pathname, Object.assign({ credentials: 'include' }, options || {}));
        var body = null;
        try { body = await response.json(); } catch (err) { body = null; }
        if (!response.ok) {
            var message = (body && body.error) || ('Request failed (' + response.status + ')');
            var error = new Error(message);
            error.status = response.status;
            throw error;
        }
        return body;
    }

    /** Disables both submit buttons so an impatient double-click cannot create
     *  two pending requests for one species — the second would silently become a
     *  contribution at approval. */
    function setBusy(busy) {
        [el.newSubmit, el.contributeSubmit].forEach(function (button) {
            if (button) button.disabled = busy;
        });
    }

    // --------------------------------------------------------------- tabs ----
    var TAB_IDS = ['new', 'contribute', 'mine'];

    /** Deep-link precedence: plantId forces contribute, a scanned name forces
     *  new, else ?tab=, else new. */
    function initialTab() {
        var params = new URLSearchParams(window.location.search);
        if (params.get('plantId')) return 'contribute';
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

    // --------------------------------------------------------- new plant ----
    function validateNewPlant(parts) {
        var problems = [];
        if (!value('newCommonName')) problems.push('Common name is required.');
        if (!value('newScientificName')) problems.push('Scientific name is required.');
        if (!el.newTypeId.value) problems.push('Choose a plant type.');
        if (el.newQuantity.value !== '' && Number.isNaN(Number(el.newQuantity.value))) {
            problems.push('Quantity must be a number.');
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
        // primary description, so names alone would be "Approved" and invisible.
        if (!hasAnyPartValue(parts) &&
            !value('newUses') && !value('newBenefits') && !value('newHarmful')) {
            problems.push('Add a description or some measurements — names alone are never published.');
        }
        return problems;
    }

    async function submitNewPlant(event) {
        event.preventDefault();
        setNotice('', null);

        var parts = readParts('new');
        var problems = validateNewPlant(parts);
        if (problems.length > 0) {
            setNotice(problems.join(' '), 'error');
            return;
        }

        setBusy(true);
        try {
            var payload = {
                commonName: value('newCommonName'),
                scientificName: value('newScientificName'),
                typeId: el.newTypeId.value,
                quantity: el.newQuantity.value === '' ? null : Number(el.newQuantity.value),
                kingdom: value('newKingdom'),
                phylum: value('newPhylum'),
                plantClass: value('newPlantClass'),
                order: value('newOrder'),
                family: value('newFamily'),
                genus: value('newGenus'),
                species: value('newSpecies'),
                parts: parts,
                uses: value('newUses'),
                benefits: value('newBenefits'),
                harmful: value('newHarmful'),
                // Present ONLY when the botanist arrived from the queue. The
                // server verifies the claim in the submit transaction, so this
                // is provenance and not a permission.
                discoveryRequestId: discoveryRequestId
            };
            var result = await api('/api/plants/requests', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            var suffix = '';
            // The server rewrites scientificName to the model's exact casing, so
            // report what was actually stored rather than what was typed.
            if (result.scientificName && result.scientificName !== payload.scientificName) {
                suffix = ' Stored as "' + result.scientificName + '".';
            }
            if (result.warnings && result.warnings.length > 0) {
                setNotice(result.warnings.join(' '), 'warning');
            } else {
                setNotice('Submitted for review as ' + result.requestId + '.' + suffix, 'success');
            }

            el.newPlantForm.reset();
            el.newTypeId.value = '';
            await loadTypes();
            if (el.newDuplicateWarning) el.newDuplicateWarning.hidden = true;
            showTab('mine');
        } catch (err) {
            // Surfaced verbatim made the server's 400 message specific,
            // and a generic failure string would throw that away.
            setNotice(err.message, 'error');
        } finally {
            setBusy(false);
        }
    }

    /** Blur check against the public library. No new endpoint: GET /api/plants
     *  already searches both names. */
    async function checkDuplicate() {
        var name = value('newScientificName');
        if (!el.newDuplicateWarning) return;
        if (!name) {
            el.newDuplicateWarning.hidden = true;
            return;
        }
        try {
            var data = await api('/api/plants?search=' + encodeURIComponent(name));
            if (data.plants && data.plants.length > 0) {
                el.newDuplicateWarning.hidden = false;
                el.newDuplicateWarning.innerHTML =
                    'Already in the library &mdash; <strong>' +
                    escapeHtml(data.plants[0].name) + '</strong> (' +
                    escapeHtml(data.plants[0].scientificName) + '). ' +
                    '<a href="#" id="duplicateJumpLink">Add to it instead</a>';
                var jump = byId('duplicateJumpLink');
                if (jump) {
                    jump.addEventListener('click', function (e) {
                        e.preventDefault();
                        el.newDuplicateWarning.hidden = true;
                        showTab('contribute');
                        el.contributeSearch.focus();
                    });
                }
            } else {
                el.newDuplicateWarning.hidden = true;
            }
        } catch (err) {
            // A failed lookup is not a validation failure: say nothing and let
            // the submission itself decide.
        }
    }

    // -------------------------------------------------------- contribute ----
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
                    '<em>' + escapeHtml(plant.scientificName) + '</em>';
                button.addEventListener('click', function () {
                    selectPlant({ id: plant.id, name: plant.name, scientificName: plant.scientificName });
                    el.contributeResults.hidden = true;
                });
                el.contributeResults.appendChild(button);
            });
        }
        el.contributeResults.hidden = false;
    }

    function selectPlant(plant) {
        contributePlant = plant;
        el.contributePlantId.value = plant ? plant.id : '';
        if (el.contributeSelected) {
            if (plant) {
                el.contributeSelected.textContent = 'Adding to: ' + plant.name + ' (' + plant.scientificName + ')';
                el.contributeSelected.hidden = false;
            } else {
                el.contributeSelected.hidden = true;
            }
        }
        loadCarriedPhoto(plant);
    }

    function debouncedSearch() {
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(async function () {
            var term = value('contributeSearch');
            if (!term) {
                if (el.contributeResults) el.contributeResults.hidden = true;
                return;
            }
            try {
                var data = await api('/api/plants?search=' + encodeURIComponent(term));
                renderPicker(data.plants || []);
            } catch (err) {
                renderPicker([]);
            }
        }, DEBOUNCE_MS);
    }

    /**
     * Looks for a photo cached by capture-plant.html. A File handle cannot cross
     * a page navigation, so IndexedDB is the only thing that can carry it.
     */
    async function loadCarriedPhoto(plant) {
        if (!el.contributeCarriedPhoto) return;
        if (typeof window.takeScanPhoto !== 'function') return;
        if (!plant || !plant.scientificName) {
            el.contributeCarriedPhoto.hidden = true;
            carriedPhoto = null;
            return;
        }
        var record = await window.takeScanPhoto(plant.scientificName);
        if (!record || !record.blob) {
            el.contributeCarriedPhoto.hidden = true;
            carriedPhoto = null;
            return;
        }
        carriedPhoto = {
            scientificName: record.scientificName,
            blob: record.blob,
            filename: record.filename || 'scan-photo.jpg'
        };
        if (el.contributeCarriedImg) {
            el.contributeCarriedImg.src = URL.createObjectURL(record.blob);
        }
        el.contributeCarriedPhoto.hidden = false;
    }

    function validateContribution(fileCount, parts) {
        var problems = [];
        if (!contributePlant) problems.push('Choose a plant to add to.');
        if (!hasAnyPartValue(parts) &&
            !value('contributeUses') && !value('contributeBenefits') && !value('contributeHarmful') &&
            fileCount === 0) {
            problems.push('Add a description, some measurements, or one photo.');
        }
        var files = el.contributeImages.files;
        if (files.length > MAX_FILES) {
            problems.push('At most ' + MAX_FILES + ' photos per submission.');
        }
        for (var i = 0; i < files.length; i++) {
            if (files[i].size > MAX_IMAGE_BYTES) {
                problems.push('"' + files[i].name + '" is larger than ' +
                    (MAX_IMAGE_BYTES / (1024 * 1024)) + ' MB.');
            }
            if (IMAGE_ACCEPT.indexOf(files[i].type) === -1) {
                problems.push('"' + files[i].name + '" is not a JPEG, PNG or WebP.');
            }
        }
        return problems;
    }

    async function submitContribution(event) {
        event.preventDefault();
        setNotice('', null);

        var parts = readParts('contribute');
        var files = Array.from(el.contributeImages.files || []);
        var problems = validateContribution(files.length, parts);
        if (problems.length > 0) {
            setNotice(problems.join(' '), 'error');
            return;
        }

        var form = new FormData();
        form.append('parts', JSON.stringify(parts));
        form.append('uses', value('contributeUses'));
        form.append('benefits', value('contributeBenefits'));
        form.append('harmful', value('contributeHarmful'));

        var usingCarried = false;
        if (!files.length && carriedPhoto) {
            // The scanned photo, uploaded now because the botanist chose it.
            // Nothing is sent without that explicit choice.
            form.append('images', carriedPhoto.blob, carriedPhoto.filename);
            usingCarried = true;
        } else {
            files.forEach(function (file) { form.append('images', file); });
        }

        setBusy(true);
        try {
            // Same provenance field as the new-plant form, and for the same
            // reason: a report can be worked through either tab, and the link
            // has to be recorded whichever route was taken.
            if (discoveryRequestId) form.append('discoveryRequestId', discoveryRequestId);
            var result = await api('/api/plants/' + encodeURIComponent(contributePlant.id) + '/contributions', {
                method: 'POST',
                body: form
            });
            if (usingCarried && typeof window.dropScanPhoto === 'function') {
                // Only now is the photo really submitted; before this the cache
                // entry is the botanist's only copy.
                await window.dropScanPhoto(carriedPhoto.scientificName);
            }
            if (el.contributeCarriedImg) el.contributeCarriedImg.removeAttribute('src');
            el.contributeCarriedPhoto.hidden = true;
            carriedPhoto = null;
            el.contributeForm.reset();
            selectPlant(null);
            setNotice('Contribution submitted for review as ' + result.requestId + '.', 'success');
            showTab('mine');
        } catch (err) {
            setNotice(err.message, 'error');
        } finally {
            setBusy(false);
        }
    }

    // ----------------------------------------------------- my submissions ----
    var STATUS_CLASS = { pending: 'pending', approved: 'approved', denied: 'denied' };

    function renderMine(data) {
        if (!el.mineList) return;
        if (!data.requests.length) {
            el.mineList.innerHTML = '<p class="record-muted">You have not submitted anything yet.</p>';
            return;
        }

        el.mineList.innerHTML = data.requests.map(function (request) {
            var html = '<article class="record-submission">';
            html += '<h3>' + escapeHtml(requestTypeLabel(request.requestType)) + '</h3>';
            html += '<p><span class="record-badge ' + (STATUS_CLASS[request.status] || 'pending') + '">' +
                escapeHtml(request.status) + '</span></p>';

            if (request.targetPlantName) {
                html += '<p>Plant: <a href="plant-profile.html?plantId=' +
                    encodeURIComponent(request.targetPlantId) + '">' +
                    escapeHtml(request.targetPlantName) + '</a></p>';
            }

            html += '<p class="record-muted">Submitted ' + escapeHtml(formatDate(request.createdAt));
            if (request.reviewedAt) html += ' &middot; reviewed ' + escapeHtml(formatDate(request.reviewedAt));
            if (request.reviewerName) html += ' by ' + escapeHtml(request.reviewerName);
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
            // route. The public library still shows approved photos only.
            if (request.images && request.images.length) {
                html += '<div class="record-images">';
                request.images.forEach(function (image) {
                    html += '<figure class="record-submission-image">' +
                        '<a href="' + escapeHtml(image.url) + '" target="_blank" rel="noopener">' +
                        '<img src="' + escapeHtml(image.url) + '" alt="' +
                        escapeHtml(image.originalFilename || 'Submitted photo') + '"></a>' +
                        '<figcaption><span class="record-badge ' +
                        (STATUS_CLASS[image.status] || 'pending') + '">' +
                        escapeHtml(image.status) + '</span></figcaption>' +
                        '</figure>';
                });
                html += '</div>';
            }

            // Second half of the two-step flow: a brand-new species becomes
            // reachable once it exists, so photos can be submitted against it.
            if (request.status === 'approved' && request.requestType === 'plant_addition' &&
                request.targetPlantId) {
                html += '<button type="button" class="btn record-btn-secondary record-add-photos" ' +
                    'data-plant-id="' + escapeHtml(request.targetPlantId) + '" ' +
                    'data-plant-name="' + escapeHtml(request.targetPlantName || '') + '">Add photos</button>';
            }

            html += '</article>';
            return html;
        }).join('');

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

    function requestTypeLabel(type) {
        if (type === 'plant_addition') return 'New plant submission';
        if (type === 'plant_contribution') return 'Contribution';
        if (type === 'plant_discovery') return 'Discovery report';
        return type;
    }

    function formatDate(value) {
        if (!value) return '';
        var date = new Date(value);
        return isNaN(date.getTime()) ? String(value) : date.toLocaleString();
    }

    async function loadMine() {
        if (!el.mineList) return;
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
    /** ?plantId= preselects the contribute tab's plant. The scientificName is
     *  resolved from GET /api/plants/:plantId so the carried photo can be found. */
    async function applyDeepLink(tab) {
        var params = new URLSearchParams(window.location.search);

        var plantId = params.get('plantId');
        if (plantId) {
            try {
                var plant = await api('/api/plants/' + encodeURIComponent(plantId));
                selectPlant({ id: plant.id, name: plant.name, scientificName: plant.scientificName });
                if (el.contributeSearch) el.contributeSearch.value = plant.name;
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
        }
    }

    // ----------------------------------------------------------- plant types --
    async function loadTypes() {
        if (!el.newTypeId) return;
        try {
            var data = await api('/api/plants/types');
            el.newTypeId.innerHTML = '<option value="">Choose a type…</option>';
            (data.types || []).forEach(function (type) {
                var option = document.createElement('option');
                option.value = type.typeId;
                option.textContent = type.label;
                el.newTypeId.appendChild(option);
            });
        } catch (err) {
            el.newTypeId.innerHTML = '<option value="">Could not load types</option>';
        }
    }

    // --------------------------------banner --
    /**
     * ?from=<requestId> is how discoveries.html hands a report to a botanist.
     *
     * The report's PHOTOS are displayed, and the new-plant form is submitted
     * carrying `discoveryRequestId` so the server links the two. That link is
     * verified in SQL inside the submit transaction — the client is not the
     * authority, and a botanist who never came from the queue simply submits
     * without the field.
     *
     * Photos come from the report, NOT from photo-cache.js: the File a reporter
     * chose has been written to the server and cannot cross a page transition
     * from a different browser. Re-uploading the reporter's own file is also what
     * would make it an approved plant image with an unreviewable provenance, so
     * they are shown and referenced, not copied.
     */
    var discoveryRequestId = null;

    function discoveryParam() {
        var params = new URLSearchParams(window.location.search);
        var value = params.get('from');
        return value && /^req_\d{6}$/.test(value) ? value : null;
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
                // No record_plant: record-script.js has already gated the whole
                // form, so there is nothing here to do but stay hidden.
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
            (card.images || []).forEach(function (image) {
                var li = document.createElement('li');
                var img = document.createElement('img');
                img.src = image.url;
                img.alt = 'Photo attached to report ' + discoveryRequestId;
                li.appendChild(img);
                list.appendChild(li);
            });
            if (list.children.length === 0) {
                list.hidden = true;
            }
        } catch (err) {
            // A banner is an aid. The form must still work without it.
            console.error('Discovery banner failed:', err);
            banner.hidden = true;
        }
    }

    // ------------------------------------------------------------------ init --
    async function init() {
        el = {
            gate: byId('recordGate'),
            ui: byId('recordUi'),
            notice: byId('recordNotice'),
            newPlantForm: byId('newPlantForm'),
            newPlantHint: byId('newPlantHint'),
            newDuplicateWarning: byId('newDuplicateWarning'),
            newTypeId: byId('newTypeId'),
            newQuantity: byId('newQuantity'),
            newHeightMinCm: byId('newHeightMinCm'),
            newHeightMaxCm: byId('newHeightMaxCm'),
            newWidthMinCm: byId('newWidthMinCm'),
            newWidthMaxCm: byId('newWidthMaxCm'),
            newSubmit: byId('newPlantSubmit'),
            contributeForm: byId('contributeForm'),
            contributeSearch: byId('contributeSearch'),
            contributeResults: byId('contributeResults'),
            contributeSelected: byId('contributeSelected'),
            contributePlantId: byId('contributePlantId'),
            contributeCarriedPhoto: byId('contributeCarriedPhoto'),
            contributeCarriedImg: byId('contributeCarriedImg'),
            contributeImages: byId('contributeImages'),
            contributeSubmit: byId('contributeSubmit'),
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
        // plain account. So they get one message rather than a gate for one and a
        // sign-in popup for the other — those were two presentations of one fact,
        // and the popup is a sidebar-wide "sign in to unlock" prompt that says
        // nothing about this page.
        const NO_RECORD = 'Botanist access required. Every form is hidden because the APIs would answer 403 anyway.';
        if (!user || !(user.permissions || []).includes('record_plant')) {
            setGate(NO_RECORD);
            el.ui.hidden = true;
            return;
        }
        el.ui.hidden = false;

        await initDiscoveryBanner();

        TAB_IDS.forEach(function (id) {
            var button = byId('tab-' + id);
            if (button) button.addEventListener('click', function () { showTab(id, true); });
        });

        el.newPlantForm.addEventListener('submit', submitNewPlant);
        byId('newScientificName').addEventListener('blur', checkDuplicate);

        el.contributeSearch.addEventListener('input', debouncedSearch);
        el.contributeForm.addEventListener('submit', submitContribution);

        var useCarried = byId('contributeUseCarried');
        if (useCarried) {
            useCarried.addEventListener('click', function () {
                if (el.contributeImages) el.contributeImages.disabled = false;
                setNotice('The scanned photo will be uploaded with this submission.', 'success');
                var uses = byId('contributeUses');
                if (uses) uses.focus();
            });
        }
        var dropCarried = byId('contributeDropCarried');
        if (dropCarried) {
            dropCarried.addEventListener('click', async function () {
                if (carriedPhoto && typeof window.dropScanPhoto === 'function') {
                    await window.dropScanPhoto(carriedPhoto.scientificName);
                }
                carriedPhoto = null;
                el.contributeCarriedPhoto.hidden = true;
                if (el.contributeCarriedImg) el.contributeCarriedImg.removeAttribute('src');
            });
        }

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

        var hint = el.contributeImages ? byId('contributeFileHint') : null;
        if (hint) {
            hint.textContent = 'JPEG, PNG or WebP. Up to ' + MAX_FILES + ' photos, ' +
                (MAX_IMAGE_BYTES / (1024 * 1024)) + ' MB each.';
        }

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