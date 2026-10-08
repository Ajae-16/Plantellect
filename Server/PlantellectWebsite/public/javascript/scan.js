/**
 * Scan (capture) page controller for capture-plant.html.
 *
 * This used to be a modal that injected its own markup and exposed
 * window.openPlantScan(). Scanning is a PAGE now, so the ids below live in the
 * page's static HTML instead of being created at runtime — which is what makes
 * them assertable by scripts/check-scripts.cjs. The ids are unchanged: do not
 * rename them while moving them.
 *
 * Uses ml-client.js for the API calls and photo-cache.js to carry a chosen photo
 * across the navigation to record.html.
 */

document.addEventListener('DOMContentLoaded', function () {
    const scanPlantBtn = document.getElementById('scanPlantBtn');
    const scanUploadArea = document.getElementById('scanUploadArea');
    const scanImageInput = document.getElementById('scanImageInput');
    const scanUploadPrompt = document.getElementById('scanUploadPrompt');
    const scanUploadBtn = document.getElementById('scanUploadBtn');
    const scanCameraBtn = document.getElementById('scanCameraBtn');
    const scanPredictBtn = document.getElementById('scanPredictBtn');
    const scanPreview = document.getElementById('scanPreview');
    const scanPreviewImg = document.getElementById('scanPreviewImg');
    const scanResults = document.getElementById('scanResults');
    const scanGate = document.getElementById('scanGate');
    const scanUi = document.getElementById('scanUi');
    const scanMessage = document.getElementById('scanMessage');
    const scanBack = document.getElementById('scanBack');
    const scanDeepLink = document.getElementById('scanDeepLink');

    if (!scanUploadArea || !scanImageInput || !scanPredictBtn) return;

    let selectedImageFile = null;
    let previewObjectUrl = null;
    let lastScanResult = null;
    // null until plantAuth.ready resolves; "Record this plant" re-renders if it is late.
    let canRecord = null;

    // -------------------------------------------------------------- gate ----
    // The page is a public file, so the shell is readable by anyone. The APIs are
    // the real gate; this only avoids showing a UI that cannot work.
    function setGate(message, visible) {
        if (scanGate) {
            scanGate.textContent = message || '';
            scanGate.hidden = !message;
        }
        if (scanUi) scanUi.hidden = !visible;
    }

    async function resolveGate() {
        // The app's one /api/auth/me answer, already fetched by sidebar.js. Never
        // rejects, so there is no try/catch here to flatten every failure into
        // "signed out" — which is how one problem became three symptoms.
        const user = await window.plantAuth.ready;
        if (!user) {
            setGate('', false);
            // Reuse the sidebar's own "Sign in to unlock" popup rather than
            // leaving showRestrictedModal unreachable dead code.
            if (typeof window.showRestrictedModal === 'function') window.showRestrictedModal();
            return;
        }
        const permissions = user.permissions || [];
        if (!permissions.includes('scan_plant')) {
            setGate('Scanning is not available for this account.', false);
            return;
        }
        setGate('', true);
    }

    // ------------------------------------------------------------ messages ----
    function setMessage(text, kind) {
        if (!scanMessage) return;
        scanMessage.textContent = text || '';
        scanMessage.className = text ? 'scan-message ' + (kind || 'error') : 'scan-message';
        scanMessage.hidden = !text;
    }

    // --------------------------------------------------------------- back ----
    // Scanning is a page and the user left somewhere to get here. document.referrer
    // is preferred WHEN SAME-ORIGIN, so someone arriving from a plant profile goes
    // back to that species rather than to the library grid. history.back() is
    // never used blindly: typing the URL leaves a cross-site or empty referrer,
    // and back() would then either do nothing or leave the app.
    function resolveBackTarget() {
        const fallback = 'library.html';
        const referrer = document.referrer;
        if (!referrer) return { href: fallback, label: 'Back to library' };
        try {
            const url = new URL(referrer);
            if (url.origin !== window.location.origin) return { href: fallback, label: 'Back to library' };
            // Returning to a non-page (a query string on the same file) is fine,
            // but the app root is not a useful destination.
            if (url.pathname === '/' || url.pathname === window.location.pathname) {
                return { href: fallback, label: 'Back to library' };
            }
            const name = decodeURIComponent(url.pathname.split('/').pop() || '').replace(/\.html$/i, '');
            const label = name ? `Back to ${name.replace(/[-_]/g, ' ')}` : 'Back to library';
            return { href: url.pathname + url.search, label };
        } catch (err) {
            return { href: fallback, label: 'Back to library' };
        }
    }

    function initBackControl() {
        if (!scanBack) return;
        const target = resolveBackTarget();
        scanBack.setAttribute('href', target.href);
        scanBack.textContent = target.label;
    }

    // ------------------------------------------------------- deep link hint ----
    // ?scientificName= lets a shared or bookmarked scan URL prefill. The selected
    // file is deliberately never put in a URL.
    function initDeepLink() {
        if (!scanDeepLink) return;
        const params = new URLSearchParams(window.location.search);
        const scientific = (params.get('scientificName') || '').trim();
        if (!scientific) {
            scanDeepLink.hidden = true;
            return;
        }
        scanDeepLink.textContent = `Scanned species hint: ${scientific}`;
        scanDeepLink.hidden = false;
    }

    // ----------------------------------------------------------- selection ----
    function revokePreviewUrl() {
        if (previewObjectUrl) {
            URL.revokeObjectURL(previewObjectUrl);
            previewObjectUrl = null;
        }
    }

    function handleImageSelected(file) {
        if (!file) return;
        if (!String(file.type || '').startsWith('image/')) {
            setMessage('That file is not an image. Choose a JPEG, PNG or WebP file.', 'error');
            return;
        }
        selectedImageFile = file;
        setMessage('', null);
        // Revoked on REPLACEMENT rather than after render: a page left open across
        // many scans would otherwise hold every blob it ever previewed.
        revokePreviewUrl();
        previewObjectUrl = URL.createObjectURL(file);
        scanPreviewImg.src = previewObjectUrl;
        scanPreview.hidden = false;
        if (scanUploadPrompt) scanUploadPrompt.hidden = true;
        scanPredictBtn.disabled = false;
    }

    // -------------------------------------------------------------- upload ----
    if (scanUploadBtn) {
        scanUploadBtn.addEventListener('click', function () {
            scanImageInput.click();
        });
    }

    if (scanUploadArea) {
        scanUploadArea.addEventListener('click', function () {
            scanImageInput.click();
        });
        scanUploadArea.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                scanImageInput.click();
            }
        });
        scanUploadArea.addEventListener('dragover', function (e) {
            e.preventDefault();
            scanUploadArea.classList.add('drag-over');
        });
        scanUploadArea.addEventListener('dragleave', function () {
            scanUploadArea.classList.remove('drag-over');
        });
        scanUploadArea.addEventListener('drop', function (e) {
            e.preventDefault();
            scanUploadArea.classList.remove('drag-over');
            if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                handleImageSelected(e.dataTransfer.files[0]);
            }
        });
    }

    scanImageInput.addEventListener('change', function (e) {
        if (e.target.files && e.target.files[0]) {
            handleImageSelected(e.target.files[0]);
        }
    });

    // The page has no modal to open, so this trigger only carries the styling /
    // focus target. It stays in the markup because check-scripts.cjs asserts it.
    if (scanPlantBtn) {
        scanPlantBtn.addEventListener('click', function (e) {
            e.preventDefault();
            scanUploadArea.focus();
        });
    }

    // -------------------------------------------------------------- camera ----
    // The camera overlay is the ONE piece that still injects its own markup: it
    // only exists while a MediaStream is live. It keeps the .scan-modal chrome,
    // scoped to itself so those overlay rules cannot leak onto the page.
    if (scanCameraBtn) {
        scanCameraBtn.addEventListener('click', async function () {
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                setMessage(
                    'This browser cannot open the camera. Camera capture needs https or localhost — ' +
                    'upload the photo instead.',
                    'error'
                );
                return;
            }
            let stream = null;
            let currentFacingMode = 'environment';
            async function startCamera(facingMode) {
                try {
                    const newStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode } });
                    stream.getTracks().forEach((track) => track.stop());
                    stream = newStream;
                    video.srcObject = stream;
                    currentFacingMode = facingMode;
                    updateSwitchButton();
                } catch (err) {
                    setMessage('Failed to switch camera.', 'error');
                }
            }

            try {
                // Prefer back camera (environment), fall back to front (user)
                stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: currentFacingMode } });
            } catch (err) {
                try {
                    currentFacingMode = 'user';
                    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: currentFacingMode } });
                } catch (err2) {
                    // Reported in the page, not with alert(): over a plain-http LAN IP
                    // getUserMedia cannot work at all, and a native dialog says
                    // nothing about that.
                    setMessage(
                        'Camera unavailable. It needs https or localhost (and your permission). ' +
                        'Upload the photo instead.',
                        'error'
                    );
                    return;
                }
            }

            const video = document.createElement('video');
            video.autoplay = true;
            video.playsInline = true;
            video.muted = true;
            video.srcObject = stream;
            video.className = 'scan-camera-video';

            const overlay = document.createElement('div');
            overlay.className = 'scan-camera-overlay';
            overlay.setAttribute('role', 'dialog');
            overlay.setAttribute('aria-label', 'Take a photo');

            const capture = document.createElement('button');
            capture.type = 'button';
            capture.className = 'btn scan-btn-primary';
            capture.textContent = 'Capture';

            const switchBtn = document.createElement('button');
            switchBtn.type = 'button';
            switchBtn.className = 'btn scan-btn-secondary scan-camera-switch';
            switchBtn.setAttribute('aria-label', 'Switch camera');
            function updateSwitchButton() {
                switchBtn.textContent = currentFacingMode === 'environment' ? '📷 Front' : '📷 Back';
            }
            updateSwitchButton();
            switchBtn.addEventListener('click', function () {
                startCamera(currentFacingMode === 'environment' ? 'user' : 'environment');
            });

            const close = document.createElement('button');
            close.type = 'button';
            close.className = 'btn scan-btn-secondary';
            close.textContent = 'Cancel';

            overlay.appendChild(video);
            overlay.appendChild(capture);
            overlay.appendChild(switchBtn);
            overlay.appendChild(close);
            document.body.appendChild(overlay);

            function teardown() {
                stream.getTracks().forEach((track) => track.stop());
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            }

            close.addEventListener('click', teardown);
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) teardown();
            });
            capture.addEventListener('click', function () {
                const canvas = document.createElement('canvas');
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                canvas.getContext('2d').drawImage(video, 0, 0);
                canvas.toBlob(function (blob) {
                    if (blob) handleImageSelected(new File([blob], 'camera-photo.jpg', { type: 'image/jpeg' }));
                    teardown();
                }, 'image/jpeg');
            });
        });
    }

    // ------------------------------------------------------------- predict ----
    scanPredictBtn.addEventListener('click', async function () {
        if (!selectedImageFile) return;

        scanPredictBtn.disabled = true;
        scanPredictBtn.textContent = 'Predicting...';
        scanResults.hidden = false;
        scanResults.innerHTML = '<p class="scan-loading">Loading the model and predicting...</p>';
        setMessage('', null);

        try {
            const result = await predictPlant(selectedImageFile, 5);
            renderResults(result);
        } catch (err) {
            scanResults.innerHTML = '';
            scanResults.hidden = true;
            setMessage(err.message || 'Prediction failed. Please try again.', 'error');
        } finally {
            scanPredictBtn.disabled = false;
            scanPredictBtn.textContent = 'Predict';
        }
    });

    function renderResults(result) {
        lastScanResult = result;
        const predictions = (result && result.predictions) || [];
        let html = '<div class="scan-result-header">' +
            `<span>Inference: ${escapeHtml(result.inference_ms)}ms</span>` +
            `<span>Model: ${escapeHtml(result.model_version)}</span>` +
            '</div>';

        if (predictions.length === 0) {
            html += '<p class="scan-loading">No predictions returned.</p>';
            scanResults.innerHTML = html;
            return;
        }

        html += '<div class="scan-predictions">';
        predictions.forEach((pred, index) => {
            const confidencePct = ((pred.confidence || 0) * 100).toFixed(1);
            // The server attaches plantId when the species is in the library.
            // Link to the profile only then; never drop a prediction for it.
            const nameHtml = pred.plantId
                ? `<a class="scan-prediction-name" href="/plant-profile.html?plantId=${encodeURIComponent(pred.plantId)}">${escapeHtml(pred.commonName || pred.scientific_name)}</a>`
                : `<span class="scan-prediction-name">${escapeHtml(pred.commonName || pred.scientific_name)}</span>`;
            html += '<div class="scan-prediction-item">' +
                '<div class="scan-prediction-info">' +
                    `<span class="scan-prediction-rank">#${index + 1}</span>` +
                    nameHtml +
                    `<span class="scan-prediction-sci">${escapeHtml(pred.scientific_name)}</span>` +
                '</div>' +
                '<div class="scan-prediction-bar">' +
                    `<div class="scan-prediction-fill" style="width: ${confidencePct}%"></div>` +
                '</div>' +
                `<span class="scan-prediction-conf">${confidencePct}%</span>` +
                renderRecordLink(pred) +
                '</div>';
        });
        html += '</div>';
        scanResults.innerHTML = html;

        scanResults.querySelectorAll('[data-record-species]').forEach(function (link) {
            link.addEventListener('click', function () {
                stashScanPhoto(link.getAttribute('data-record-species'));
            });
        });
    }

    /**
     * "Record this plant" is a plain <a>, not a button, because recording means
     * navigating to record.html. Rendered only when the session holds
     * record_plant, and re-rendered if the permission arrives late.
     */
    function renderRecordLink(pred) {
        if (canRecord !== true) return '';
        const params = new URLSearchParams({
            tab: 'new',
            scientificName: pred.scientific_name || '',
            commonName: pred.common_name || ''
        });
        return '<a class="scan-record-link" href="record.html?' + params.toString() + '" ' +
            'data-record-species="' + escapeHtml(pred.scientific_name || '') + '">Record this plant</a>';
    }

    /** Re-renders the prediction list so the record links reflect a resolved permission. */
    function reRenderResults() {
        if (lastScanResult) renderResults(lastScanResult);
    }

    /**
     * Persists the scanned File so it survives the navigation to record.html: a
     * File handle cannot cross a page transition any other way, and this is the
     * whole reason photo-cache.js exists.
     */
    async function stashScanPhoto(scientificName) {
        if (!selectedImageFile || !scientificName) return;
        const saved = await window.saveScanPhoto(selectedImageFile, { scientificName });
        if (!saved) {
            setMessage(
                'The photo could not be carried over to the record page — pick it again there.',
                'error'
            );
        }
    }

    // ------------------------------------------------------------ lifecycle ----
    window.addEventListener('beforeunload', function () {
        // A page left open across many scans would otherwise leak every blob.
        revokePreviewUrl();
    });

    initBackControl();
    initDeepLink();

    // The report card has its OWN gate and runs for every signed-in account, in
    // parallel with the scan gate. A plain `user` has no scan_plant and is hidden
    // from scanUi entirely — but they are precisely the person most likely to know
    // a plant the model did not recognise, so their only way to ask for help is
    // this form. Tying it to resolveGate would make it unreachable for the only
    // audience it was written for.
    setupDiscoveryReport();

    resolveGate().then(() => {
        // plantAuth.ready has settled, so plantAuth.user() is the resolved user
        // and the "Record this plant" link is decidable from it. Reading
        // sessionStorage.permissions here instead would be a second source for a
        // fact the authority already holds.
        const user = window.plantAuth.user();
        if (user && (user.permissions || []).includes('record_plant')) canRecord = true;
        else if (canRecord === null) canRecord = false;
        // A result rendered before this point is re-rendered, so a permission
        // that arrives late does not silently lose the link.
        reRenderResults();
    });

    // ------------------------------------------------------------ reporting ----
    // "The model did not recognise it, but I know it is a plant."
    //
    // The predictions ride along as a HINT and nothing else. They are stored on
    // the report because what the model almost thought it was is often the most
    // useful part of a failed prediction for the botanist who picks it up — but
    // they never pre-fill the form and are never shown as an answer. A prediction
    // is the reason this person is being asked, so it is not trustworthy input.
    const DISCOVERY_MAX_FILES = 3;

    async function setupDiscoveryReport() {
        const card = document.getElementById('discoveryReportCard');
        if (!card) return;

        const form = document.getElementById('discoveryReportForm');
        const fileInput = document.getElementById('reportImages');
        const fileHint = document.getElementById('reportFileHint');
        const result = document.getElementById('discoveryReportResult');
        const quota = document.getElementById('discoveryReportQuota');
        const submit = document.getElementById('discoveryReportSubmit');

        // The summary is the gate and the copy in one request: a 401 means the form
        // cannot work at all and must stay hidden.
        let summary;
        try {
            const response = await fetch('/api/discoveries/mine/summary', { credentials: 'include' });
            if (!response.ok) return;
            summary = await response.json();
        } catch (err) {
            console.error('Discovery summary failed:', err);
            return;
        }

        card.hidden = false;

        // At the cap the form stays visible but disabled, with the numbers shown.
        // Hiding it would leave somebody who has ten open reports with no way to
        // understand why the option disappeared.
        const atCap = summary.open >= summary.limit;
        if (atCap) {
            quota.hidden = false;
            quota.textContent = `You have ${summary.open} open report${summary.open === 1 ? '' : 's'} ` +
                `of ${summary.limit}. One must be reviewed or withdrawn before you can file another.`;
            ['reportNote', 'reportLocation', 'reportImages'].forEach((id) => {
                const field = document.getElementById(id);
                if (field) field.disabled = true;
            });
            submit.disabled = true;
        }

        fileInput.addEventListener('change', function () {
            const count = fileInput.files ? fileInput.files.length : 0;
            // The count alone would never be enough — the server rejects the
            // overflow too. This is the demonstration, not the control.
            fileHint.textContent = count === 0
                ? ''
                : count > DISCOVERY_MAX_FILES
                    ? `Only the first ${DISCOVERY_MAX_FILES} will be sent.`
                    : `${count} photo${count === 1 ? '' : 's'} ready to send.`;
        });

        form.addEventListener('submit', async function (event) {
            event.preventDefault();
            const note = document.getElementById('reportNote').value.trim();
            const location = document.getElementById('reportLocation').value.trim();
            const files = Array.from(fileInput.files || []).slice(0, DISCOVERY_MAX_FILES);

            if (!note && files.length === 0) {
                result.hidden = false;
                result.textContent = 'Add a note or at least one photo before sending.';
                return;
            }

            const body = new FormData();
            body.append('note', note);
            body.append('location', location);
            const predictions = (lastScanResult && lastScanResult.predictions) || [];
            if (predictions.length > 0) {
                body.append('predictions', JSON.stringify(predictions));
            }
            files.forEach((file) => body.append('images', file));

            submit.disabled = true;
            result.hidden = false;
            result.textContent = 'Sending…';

            try {
                const response = await fetch('/api/discoveries', {
                    method: 'POST',
                    credentials: 'include',
                    body: body
                });
                const data = await response.json().catch(() => ({}));
                if (!response.ok) {
                    // 429 is the filing cooldown, 409 the open-report cap. Both are
                    // reported in the server's own words: this form has no better
                    // vocabulary for them, and a generic "try again" would bury a
                    // message the user needs to act on.
                    result.textContent = data.error || 'Could not send the report.';
                    submit.disabled = false;
                    if (response.status === 409) quota.hidden = false;
                    return;
                }
                form.reset();
                fileHint.textContent = '';
                result.textContent = 'Sent. A botanist will pick it up from the queue. ' +
                    `Reference ${data.requestId}. You have ${data.openReports} of ${data.maxOpenReports} open.`;
                quota.hidden = false;
                if (typeof window.loadDiscoveryBadge === 'function') await window.loadDiscoveryBadge();
            } catch (err) {
                console.error('Discovery report failed:', err);
                result.textContent = 'Could not reach the server. Nothing was sent.';
                submit.disabled = false;
            }
        });
    }
});

