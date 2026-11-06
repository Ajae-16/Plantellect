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
 *
 * All visual styling lives in css/public/capture-plant.css. This file only sets
 * class names and toggles state.
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
    // Set by setupDiscoveryReport(): tells the "Not identified?" card the scanned photo changed.
    let onScanPhotoChange = function () {};
    // null until plantAuth.ready resolves; "Record this plant" re-renders if it is late.
    let canRecord = null;
    // The scan contribution card (Help improve the ML / Record it / Skip), or null when there is none.
    // { token, file, prediction, phase: 'offer' | 'sending' | 'done' | 'refused', message, tone }
    let contribution = null;

    // Shown in the camera screen and the console, so it is obvious whether the
    // browser loaded this file or an old cached copy.
    const SCAN_VERSION = '';
    console.log('scan.js ' + SCAN_VERSION);

    // Whether the FRONT camera is shown mirrored, like a bathroom mirror (your
    // left stays on the left of the screen). Whether a device's raw front feed
    // arrives mirrored or not cannot be detected from the page, so instead of
    // guessing there is a "Flip view" button for the front camera. The choice is
    // remembered on this device. The saved photo matches the preview. The back
    // camera is never flipped.
    //
    // The flip itself is CSS: the .scan-camera-video--mirrored class. Everything
    // else on the page is kept unmirrored by a rule in capture-plant.css.
    let mirrorFront = true;
    try {
        const savedMirror = localStorage.getItem('plantellect_front_mirror');
        if (savedMirror !== null) mirrorFront = savedMirror === '1';
    } catch (err) { /* storage blocked: keep the default */ }
    function saveMirrorFront() {
        try { localStorage.setItem('plantellect_front_mirror', mirrorFront ? '1' : '0'); } catch (err) { /* ignore */ }
    }

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
        // An offer is bound to the exact photo that was scanned, so it ends with that photo.
        clearContribution();
        setMessage('', null);
        // Revoked on REPLACEMENT rather than after render: a page left open across
        // many scans would otherwise hold every blob it ever previewed.
        revokePreviewUrl();
        previewObjectUrl = URL.createObjectURL(file);
        scanPreviewImg.src = previewObjectUrl;
        scanPreview.hidden = false;
        if (scanUploadPrompt) scanUploadPrompt.hidden = true;
        scanPredictBtn.disabled = false;
        onScanPhotoChange();
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
    // only exists while a MediaStream is live. Its styling is in capture-plant.css
    // (.scan-camera-*); this code only creates the elements and sets classes.
    //
    // Opens on the back camera. ONE toggle button shows the camera you would
    // switch TO: "Back camera" while the front is live, "Front camera" while the
    // back is live. It is always visible. The overlay appears immediately and the
    // stream attaches as soon as it is ready, so there is no blank wait.
    if (scanCameraBtn) {
        scanCameraBtn.addEventListener('click', function () {
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                setMessage(
                    'This browser cannot open the camera. Camera capture needs https or localhost — ' +
                    'upload the photo instead.',
                    'error'
                );
                return;
            }
            // A second click while the overlay is up must not open a second stream.
            if (document.querySelector('.scan-camera-overlay')) return;

            let stream = null;
            let closed = false;
            let busy = false;
            let currentFacingMode = 'environment';   // back camera first
            let cameraCount = 0;                      // 0 = not counted yet

            // ---- markup, built up front so it shows at once ----
            const overlay = document.createElement('div');
            overlay.className = 'scan-camera-overlay';
            overlay.setAttribute('role', 'dialog');
            overlay.setAttribute('aria-label', 'Take a photo');

            const video = document.createElement('video');
            video.autoplay = true;
            video.playsInline = true;
            video.muted = true;
            video.className = 'scan-camera-video';

            const status = document.createElement('p');
            status.className = 'scan-camera-status';
            status.setAttribute('aria-live', 'polite');
            function setStatus(text) { status.textContent = text || ''; }
            setStatus('Opening camera…');

            const bar = document.createElement('div');
            bar.className = 'scan-camera-bar';

            const capture = document.createElement('button');
            capture.type = 'button';
            capture.className = 'btn scan-btn-primary scan-camera-btn';
            capture.textContent = 'Capture';
            capture.disabled = true;               // until the first frame is live

            const switchBtn = document.createElement('button');
            switchBtn.type = 'button';
            switchBtn.className = 'btn scan-btn-secondary scan-camera-btn scan-camera-switch';
            switchBtn.textContent = '📷 Front camera';
            switchBtn.disabled = true;

            // Front camera only: flips the preview (and the saved photo) left/right.
            const flipBtn = document.createElement('button');
            flipBtn.type = 'button';
            flipBtn.className = 'btn scan-btn-secondary scan-camera-btn scan-camera-flip';
            flipBtn.textContent = 'Flip view';
            flipBtn.hidden = true;

            const close = document.createElement('button');
            close.type = 'button';
            close.className = 'btn scan-btn-secondary scan-camera-btn';
            close.textContent = 'Cancel';

            // Front camera: mirrored or not, per the "Flip view" button. Back
            // camera: never transformed.
            function flipsFront() {
                return mirrorFront && currentFacingMode === 'user';
            }
            function applyOrientation() {
                video.classList.toggle('scan-camera-video--mirrored', flipsFront());
            }

            function updateSwitchLabel() {
                applyOrientation();
                flipBtn.hidden = currentFacingMode !== 'user';
                const next = currentFacingMode === 'environment' ? 'Front' : 'Back';
                switchBtn.textContent = '📷 ' + next + ' camera';
                switchBtn.setAttribute('aria-label', 'Switch to the ' + next.toLowerCase() + ' camera');
                setStatus('Using the ' + (currentFacingMode === 'environment' ? 'back' : 'front') +
                    ' camera');
            }

            bar.appendChild(capture);
            bar.appendChild(switchBtn);
            
            bar.appendChild(close);
            overlay.appendChild(video);
            overlay.appendChild(status);
            overlay.appendChild(bar);
            document.body.appendChild(overlay);

            // ---- stream handling ----
            function stopStream() {
                if (stream) {
                    stream.getTracks().forEach((track) => track.stop());
                    stream = null;
                }
                video.srcObject = null;
            }

            // The old stream is stopped BEFORE the next is requested: phones can
            // only run one camera at a time. Returns false if the overlay was
            // closed while the browser was still opening the camera.
            async function openStream(videoConstraints) {
                stopStream();
                const next = await navigator.mediaDevices.getUserMedia({
                    video: videoConstraints,
                    audio: false
                });
                if (closed) {
                    next.getTracks().forEach((track) => track.stop());
                    return false;
                }
                stream = next;
                video.srcObject = next;
                video.play().catch(function () {});   // not awaited: no extra wait
                return true;
            }

            function settingsOf(s) {
                const track = s && s.getVideoTracks()[0];
                return track ? track.getSettings() : {};
            }

            function facingOf(s, fallback) {
                const f = settingsOf(s).facingMode;
                return f === 'user' || f === 'environment' ? f : fallback;
            }

            async function openFacing(facing) {
                try {
                    // "exact" is what reliably forces the right camera on phones,
                    // and it fails instantly (no delay) where it is unsupported.
                    if (await openStream({ facingMode: { exact: facing } })) {
                        currentFacingMode = facing;
                    }
                } catch (err) {
                    if (closed) return;
                    if (err && err.name === 'NotAllowedError') throw err;
                    // Laptops and single-camera devices reject "exact".
                    if (await openStream({ facingMode: { ideal: facing } })) {
                        // A webcam that reports no facingMode is a front camera.
                        currentFacingMode = facingOf(stream, 'user');
                    }
                }
            }

            function countCameras() {
                // Not awaited by the caller: it must never hold up the preview.
                navigator.mediaDevices.enumerateDevices().then(function (all) {
                    cameraCount = all.filter((d) => d.kind === 'videoinput').length;
                }).catch(function () {});
            }

            async function switchCamera() {
                if (busy || closed) return;
                if (cameraCount === 1) {
                    setStatus('This device has only one camera.');
                    return;
                }
                busy = true;
                switchBtn.disabled = true;
                capture.disabled = true;
                setStatus('Switching camera…');
                const target = currentFacingMode === 'environment' ? 'user' : 'environment';
                const previous = currentFacingMode;
                const previousId = settingsOf(stream).deviceId || '';
                let failed = false;
                try {
                    await openFacing(target);
                    // facingMode was accepted but the same camera came back:
                    // take any other camera instead.
                    if (!closed && stream && previousId && settingsOf(stream).deviceId === previousId) {
                        const all = await navigator.mediaDevices.enumerateDevices();
                        const other = all.find((d) => d.kind === 'videoinput' && d.deviceId !== previousId);
                        if (other && await openStream({ deviceId: { exact: other.deviceId } })) {
                            currentFacingMode = facingOf(stream, target);
                        } else if (!other) {
                            failed = true;
                        }
                    }
                } catch (err) {
                    failed = true;
                    // Put the previous camera back so the preview is never blank.
                    try { await openFacing(previous); } catch (err2) { /* nothing to restore */ }
                }
                if (closed) return;
                updateSwitchLabel();
                if (failed) setStatus('Could not switch camera. Using the ' +
                    (currentFacingMode === 'environment' ? 'back' : 'front') + ' camera.');
                busy = false;
                switchBtn.disabled = false;
                capture.disabled = false;
            }

            function onVisibility() {
                if (document.hidden) teardown();
            }

            function teardown() {
                closed = true;
                stopStream();
                document.removeEventListener('visibilitychange', onVisibility);
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            }

            document.addEventListener('visibilitychange', onVisibility);
            switchBtn.addEventListener('click', switchCamera);
            flipBtn.addEventListener('click', function () {
                mirrorFront = !mirrorFront;
                saveMirrorFront();
                applyOrientation();
            });
            close.addEventListener('click', teardown);
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) teardown();
            });
            capture.addEventListener('click', function () {
                if (!video.videoWidth) return;
                const canvas = document.createElement('canvas');
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                const ctx = canvas.getContext('2d');
                // The saved photo matches the preview: the front camera is flipped
                // back, the back camera is saved exactly as captured.
                if (flipsFront()) {
                    ctx.translate(canvas.width, 0);
                    ctx.scale(-1, 1);
                }
                ctx.drawImage(video, 0, 0);
                canvas.toBlob(function (blob) {
                    if (blob) handleImageSelected(new File([blob], 'camera-photo.jpg', { type: 'image/jpeg' }));
                    teardown();
                }, 'image/jpeg', 0.92);
            });

            // ---- start: back camera first, then anything that works ----
            (async function start() {
                try {
                    await openFacing('environment');
                } catch (err) {
                    if (closed) return;
                    try {
                        await openStream(true);
                        currentFacingMode = facingOf(stream, 'user');
                    } catch (err2) {
                        // Reported in the page, not with alert(): over a plain-http LAN IP
                        // getUserMedia cannot work at all, and a native dialog says
                        // nothing about that.
                        teardown();
                        setMessage(
                            'Camera unavailable. It needs https or localhost (and your permission). ' +
                            'Upload the photo instead.',
                            'error'
                        );
                        return;
                    }
                }
                if (closed || !stream) return;
                updateSwitchLabel();
                capture.disabled = false;
                switchBtn.disabled = false;
                countCameras();
            })();
        });
    }

    // ------------------------------------------------------------- predict ----
    scanPredictBtn.addEventListener('click', async function () {
        if (!selectedImageFile) return;

        // The offer (if any) must be posted with THESE bytes, so keep the file that is being scanned.
        const scannedFile = selectedImageFile;
        clearContribution();

        scanPredictBtn.disabled = true;
        scanPredictBtn.textContent = 'Predicting...';
        scanResults.hidden = false;
        scanResults.innerHTML = '<p class="scan-loading">Loading the model and predicting...</p>';
        setMessage('', null);

        try {
            const result = await predictPlant(selectedImageFile, 5);
            renderResults(result);
            offerContribution(result, scannedFile);
            // Keep the scanned photo on this device (a few days) so the "Not identified?" report can
            // use it, even after a reload, instead of asking for another one.
            if (window.PhotoCache && window.PhotoCache.saveReportPhoto) window.PhotoCache.saveReportPhoto(selectedImageFile);
        } catch (err) {
            scanResults.innerHTML = '';
            scanResults.hidden = true;
            setMessage(err.message || 'Prediction failed. Please try again.', 'error');
        } finally {
            scanPredictBtn.disabled = false;
            scanPredictBtn.textContent = 'Predict';
        }
    });

    // ------------------------------------------------------- server verdict ----
    // routes/ml.js answers with `outcome` and `reason` once mlConfidence is in
    // 'enforce' mode. In 'off' and 'log' mode neither field is present and this
    // page behaves exactly as it did before.
    const NON_SPECIES_KINDS = ['non_plant', 'other_plant'];

    // "non plant" / "other plant" are classes of the model, never species names.
    function speciesOnly(predictions) {
        return (predictions || []).filter((p) => !NON_SPECIES_KINDS.includes(p && p.kind));
    }

    // ------------------------------------------------- picture and profile link ----
    // The server attaches plantId (and imageUrl / thumbnailUrl, when the plant has a
    // hero photo) only for species that exist in the library. Both are static public
    // copies under /resource/plant-images/; the old /api/plants/... address still
    // redirects there, so it is accepted too.
    function profileHref(pred) {
        return pred && pred.plantId
            ? `/plant-profile.html?plantId=${encodeURIComponent(pred.plantId)}`
            : '';
    }

    function thumbHtml(pred, label) {
        const candidate = pred && (pred.thumbnailUrl || pred.imageUrl);
        const url = typeof candidate === 'string' &&
            (candidate.startsWith('/resource/plant-images/') || candidate.startsWith('/api/plants/'))
            ? candidate
            : '';
        return url
            ? `<img class="scan-prediction-img" src="${escapeHtml(url)}" alt="${escapeHtml(label)}" loading="lazy" decoding="async">`
            : '<span class="scan-prediction-img scan-prediction-img--empty" aria-hidden="true">\u{1F33F}</span>';
    }

    function verdictMessage(result, firstPrediction) {
        switch (result && result.outcome) {
            case 'uncertain': {
                const name = firstPrediction
                    ? (firstPrediction.commonName || firstPrediction.scientific_name)
                    : '';
                return name
                    ? `Possible ${name}. Take another photo to be sure.`
                    : 'Not sure what this is. Take another photo.';
            }
            case 'unrecognized':
                if (result.reason === 'non_plant') {
                    return 'No plant detected. Point the camera at a leaf or plant and try again.';
                }
                if (result.reason === 'other_plant') {
                    return 'Plant detected, but this species is not supported yet. ' +
                        'If you know what it is, you can report it below.';
                }
                return 'Could not recognise this photo. Try a clearer photo of a leaf.';
            default:
                return null; // 'identified', or no verdict at all: show the list as before
        }
    }

    function renderResults(result) {
        lastScanResult = result;
        // Defence in depth: the server already withholds non-species classes, but one
        // must never render as a species or get a "Record this plant" link.
        const predictions = speciesOnly(result && result.predictions);
        let html = '';

        const verdict = verdictMessage(result, predictions[0]);
        if (verdict) html += `<p class="scan-verdict">${escapeHtml(verdict)}</p>`;

        if (predictions.length === 0) {
            if (!verdict) html += '<p class="scan-loading">No predictions returned.</p>';
            scanResults.innerHTML = html;
            return;
        }

        html += '<div class="scan-predictions">';
        predictions.forEach((pred, index) => {
            const confidencePct = ((pred.confidence || 0) * 100).toFixed(1);
            const label = pred.commonName || pred.scientific_name;
            const href = profileHref(pred);

            // Picture + names are ONE link to the profile when the species is in the
            // library. The record link stays outside it: a link inside a link is invalid.
            const inner = thumbHtml(pred, label) +
                '<div class="scan-prediction-info">' +
                    `<span class="scan-prediction-rank">#${index + 1}</span>` +
                    `<span class="scan-prediction-name">${escapeHtml(label)}</span>` +
                    `<span class="scan-prediction-sci">${escapeHtml(pred.scientific_name)}</span>` +
                    (href ? '' : '<span class="scan-prediction-note">Not in the library yet</span>') +
                '</div>';
            const main = href
                ? `<a class="scan-prediction-link" href="${href}" title="Open the ${escapeHtml(label)} profile">${inner}</a>`
                : `<div class="scan-prediction-link">${inner}</div>`;

            html += '<div class="scan-prediction-item">' +
                main +
                '<div class="scan-prediction-bar">' +
                    `<div class="scan-prediction-fill" style="width: ${confidencePct}%"></div>` +
                '</div>' +
                `<span class="scan-prediction-conf">${confidencePct}%</span>` +
                renderRecordLink(pred) +
                '</div>';
        });
        html += '</div>';
        scanResults.innerHTML = html;

        // A photo that fails to load (deleted, still processing) falls back to the leaf icon.
        scanResults.querySelectorAll('img.scan-prediction-img').forEach(function (img) {
            img.addEventListener('error', function () {
                const placeholder = document.createElement('span');
                placeholder.className = 'scan-prediction-img scan-prediction-img--empty';
                placeholder.setAttribute('aria-hidden', 'true');
                placeholder.textContent = '\u{1F33F}';
                img.replaceWith(placeholder);
            }, { once: true });
        });

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
    function recordHref(pred, fromScan) {
        const names = {
            scientificName: pred.scientific_name || '',
            commonName: pred.commonName || pred.common_name || ''
        };
        if (fromScan === true) {
            // The contribution card's "Record it" . from=scan tells record.html this trip came from a
            // scan, so it prefills the names and asks for a description. A species that is already in the library
            // (the server attached a plantId) goes to "Add to existing" with that plant chosen; a species that is
            // not goes to the new-plant tab.
            const params = pred.plantId
                ? new URLSearchParams({ tab: 'contribute', plantId: String(pred.plantId), ...names, from: 'scan' })
                : new URLSearchParams({ tab: 'new', ...names, from: 'scan' });
            return 'record.html?' + params.toString();
        }
        const params = new URLSearchParams({ tab: 'new', ...names });
        return 'record.html?' + params.toString();
    }

    function renderRecordLink(pred) {
        if (canRecord !== true) return '';
        return '<a class="scan-record-link" href="' + recordHref(pred) + '" ' +
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

    // ------------------------------------------------- scan contribution ----
    // routes/ml.js adds `contribute_offer` to the /predict answer only when the server itself decided
    // this photo may be offered for training (see config/contribute-offer.js). Without it nothing here
    // runs and the page is exactly as it was. The card never decides anything: it shows the choices,
    // posts the same file with the token to POST /api/ml/contribute, and shows the server's answer.
    const scanContribute = document.getElementById('scanContribute');

    // Worth another try: nothing was refused, the request just did not get through or the server tripped.
    const CONTRIBUTE_RETRY_REASONS = ['network', 'server_error', 'save_failed'];
    // Nothing more to do for this photo: it is already held (as a contribution, or in the library).
    const CONTRIBUTE_DONE_REASONS = ['already_contributed', 'already_in_library'];
    // A daily limit is the server saying thanks and "not now", not a fault: shown calmly, not as an error.
    const CONTRIBUTE_LIMIT_REASONS = ['daily_cap', 'species_cap'];

    function clearContribution() {
        contribution = null;
        if (!scanContribute) return;
        scanContribute.hidden = true;
        scanContribute.innerHTML = '';
    }

    function offerContribution(result, file) {
        const offer = result && result.contribute_offer;
        if (!scanContribute || !offer || typeof offer.token !== 'string' || offer.token === '') return;
        // An "Other plant" offer (the model sees a plant it has no class for) comes with an unrecognized outcome.
        const otherPlant = offer.kind === 'other_plant';
        if (otherPlant ? result.outcome !== 'unrecognized' : result.outcome !== 'identified') return;
        // The photo on screen changed while the scan was running: the offer is for the old one.
        if (file !== selectedImageFile) return;
        const top = otherPlant
            ? { confidence: Number(offer.confidence) || 0, otherPlant: true }
            : speciesOnly(result.predictions)[0];
        if (!top) return;
        contribution = { token: offer.token, file: file, prediction: top, phase: 'offer', message: '', tone: '' };
        renderContributionCard(false);
    }

    function renderContributionCard(focusMessage) {
        if (!scanContribute) return;
        if (!contribution) {
            clearContribution();
            return;
        }
        const c = contribution;
        const pred = c.prediction;
        const otherPlant = Boolean(pred.otherPlant);
        const name = pred.commonName || pred.scientific_name || 'this plant';
        const pct = ((pred.confidence || 0) * 100).toFixed(1);
        const sending = c.phase === 'sending';
        const asking = c.phase === 'offer' || sending;
        const recordLink = canRecord === true && !otherPlant
            ? '<a class="btn scan-btn-secondary" href="' + recordHref(pred, true) + '" ' +
                'data-record-species="' + escapeHtml(pred.scientific_name || '') + '">Record it</a>'
            : '';

        let html = '<h2 id="scanContributeTitle" class="scan-contribute-title">Help improve the plant model?</h2>';
        if (asking) {
            html += otherPlant
                ? '<p class="scan-contribute-lead">The model is <strong>' + escapeHtml(pct) + '%</strong> sure this is a plant it does not know yet. ' +
                    'You can share this photo to help it learn new plants.</p>'
                : '<p class="scan-contribute-lead">The model is <strong>' + escapeHtml(pct) + '%</strong> sure this is <strong>' +
                    escapeHtml(name) + '</strong>. You can share this photo to help it learn' +
                    (recordLink ? ', or record the plant instead.' : '.') + '</p>';
        }
        if (c.message) {
            html += '<p id="scanContributeStatus" class="scan-contribute-status ' + escapeHtml(c.tone || 'info') +
                '" role="status" tabindex="-1">' + escapeHtml(c.message) + '</p>';
        }
        if (asking) {
            html += '<div class="scan-actions">' +
                '<button type="button" class="btn scan-btn-primary" data-contribute="help"' + (sending ? ' disabled' : '') + '>' +
                    (sending ? 'Sending…' : 'Help improve the ML') + '</button>' +
                recordLink +
                '<button type="button" class="btn scan-btn-secondary" data-contribute="close"' + (sending ? ' disabled' : '') + '>Skip</button>' +
                '</div>' +
                '<p class="scan-hint scan-contribute-consent">Used only to train the plant model. Never shown publicly.</p>';
        } else if (c.phase === 'refused') {
            html += '<div class="scan-actions">' + recordLink +
                '<button type="button" class="btn scan-btn-secondary" data-contribute="close">Close</button></div>';
        }
        scanContribute.innerHTML = html;
        scanContribute.hidden = false;

        // The buttons were just replaced, so a keyboard or screen-reader user would lose their place:
        // move to the outcome of what they pressed.
        if (focusMessage) {
            const status = document.getElementById('scanContributeStatus');
            if (status) status.focus();
        }
    }

    async function submitContribution() {
        const c = contribution;
        if (!c || c.phase === 'sending') return;
        c.phase = 'sending';
        c.message = '';
        c.tone = '';
        renderContributionCard(false);
        const name = c.prediction.commonName || c.prediction.scientific_name || 'this plant';
        try {
            await contributeScanPhoto(c.file, c.token);
            if (contribution !== c) return;   // another photo was chosen meanwhile: nothing left to show
            c.phase = 'done';
            c.tone = 'success';
            c.message = (c.prediction.otherPlant ? 'Thank you! Your photo will help the model learn new plants. ' : 'Thank you! Your photo of ' + name + ' will help the model learn. ') +
                'It is used only for training and is never shown publicly.';
        } catch (err) {
            if (contribution !== c) return;
            const reason = err && err.reason;
            c.message = (err && err.message) || 'The photo could not be sent.';
            if (CONTRIBUTE_DONE_REASONS.includes(reason)) {
                c.phase = 'done';
                c.tone = reason === 'already_contributed' ? 'success' : 'info';
            } else if (CONTRIBUTE_RETRY_REASONS.includes(reason) || (err && err.status >= 500 && reason !== 'contribute_unavailable')) {
                c.phase = 'offer';      // the buttons come back, so the person can try again
                c.tone = 'error';
            } else {
                c.phase = 'refused';    // a cap, an expired offer, the setting turned off, ...: say why, no retry
                c.tone = CONTRIBUTE_LIMIT_REASONS.includes(reason) ? 'info' : 'error';
            }
        }
        renderContributionCard(true);
    }

    if (scanContribute) {
        scanContribute.addEventListener('click', function (event) {
            const record = event.target.closest('[data-record-species]');
            if (record) {
                // Plain link: it navigates on its own. This only carries the photo across, like the result list does.
                stashScanPhoto(record.getAttribute('data-record-species'));
                return;
            }
            const action = event.target.closest('[data-contribute]');
            if (!action || action.disabled) return;
            if (action.getAttribute('data-contribute') === 'help') submitContribution();
            else clearContribution();      // Skip or Close: the token is dropped with the card
        });
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
        // The card's "Record it" depends on the same permission.
        renderContributionCard(false);
    });

    // ------------------------------------------------------------ reporting ----
    // "The model did not recognise it, but I know it is a plant."
    //
    // The predictions ride along as a HINT and nothing else. They are stored on
    // the report because what the model almost thought it was is often the most
    // useful part of a failed prediction for the contributor who picks it up — but
    // they never pre-fill the form and are never shown as an answer. A prediction
    // is the reason this person is being asked, so it is not trustworthy input.
    // Tick-box clues for "What do you see?". Ticking only APPENDS text to the note, so a person who
    // does not know the words for a plant can still describe it; "Anything else?" is for the rest.
    const REPORT_CHECKLIST = [
        { title: 'Leaves', items: ['compound leaves (many small leaflets)', 'simple leaves', 'leaves in pairs (opposite)', 'leaves one by one (alternate)', 'broad leaves', 'narrow or needle-like leaves', 'thorny or spiny'] },
        { title: 'Flowers and fruit', items: ['has flowers', 'has fruit, berries or pods', 'no flowers or fruit visible'] },
        { title: 'Growth', items: ['tree', 'shrub', 'vine or climber', 'small herb or ground cover', 'grass-like'] },
        { title: 'Other clues', items: ['hairy or fuzzy surface', 'waxy or shiny surface', 'milky sap', 'strong smell', 'growing on a wall or rock', 'growing in water or wet ground'] }
    ];

    async function setupDiscoveryReport() {
        const card = document.getElementById('discoveryReportCard');
        if (!card) return;

        const form = document.getElementById('discoveryReportForm');
        const result = document.getElementById('discoveryReportResult');
        const quota = document.getElementById('discoveryReportQuota');
        const submit = document.getElementById('discoveryReportSubmit');
        const photoBox = document.getElementById('reportPhotoBox');
        const photoImg = document.getElementById('reportPhotoImg');
        const photoMeta = document.getElementById('reportPhotoMeta');
        const noPhoto = document.getElementById('reportNoPhoto');
        const pickBtn = document.getElementById('reportPickBtn');
        const pickInput = document.getElementById('reportPickInput');
        const checklist = document.getElementById('reportChecklist');
        const noteField = document.getElementById('reportNote');
        const notePreview = document.getElementById('reportNotePreview');
        const contribute = document.getElementById('reportContribute');

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
            form.querySelectorAll('input, textarea, button').forEach((el) => { el.disabled = true; });
        }

        // ---- the photo: the scan itself, else the cached last scan, else one chosen photo ----
        let cachedFile = null;      // last scan, restored from the device cache after a reload
        let pickedFile = null;      // only for accounts that cannot scan
        let sentFile = null;        // already reported: never offered again
        let previewUrl = null;

        function reportFile() {
            const file = selectedImageFile || pickedFile || cachedFile;
            return file && file !== sentFile ? file : null;
        }

        function renderPhoto() {
            const file = reportFile();
            if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
            if (file) {
                previewUrl = URL.createObjectURL(file);
                photoImg.src = previewUrl;
                photoMeta.textContent = file === selectedImageFile
                    ? 'The photo you just scanned. No need to take another one.'
                    : file === pickedFile
                        ? 'The photo you chose.'
                        : 'Your last scanned photo, kept on this device for a few days.';
            }
            photoBox.hidden = !file;
            // The picker is only a fallback for somebody who cannot scan at all.
            const canPick = !selectedImageFile && !cachedFile;
            noPhoto.hidden = Boolean(file) || !canPick;
            pickBtn.hidden = !canPick;
        }
        onScanPhotoChange = renderPhoto;

        pickBtn.addEventListener('click', () => pickInput.click());
        pickInput.addEventListener('change', () => {
            const file = pickInput.files && pickInput.files[0];
            if (file && String(file.type || '').startsWith('image/')) pickedFile = file;
            renderPhoto();
        });

        try {
            if (window.PhotoCache && window.PhotoCache.takeReportPhoto) cachedFile = await window.PhotoCache.takeReportPhoto();
        } catch (err) { /* no cache: the scan itself still works */ }
        renderPhoto();

        // ---- the checklist: ticked items become one sentence at the front of the note ----
        checklist.innerHTML = REPORT_CHECKLIST.map((group) =>
            '<div class="report-group"><p class="report-group-title">' + escapeHtml(group.title) + '</p><div class="report-chips">' +
            group.items.map((item) =>
                '<label class="report-chip"><input type="checkbox" value="' + escapeHtml(item) + '"><span>' + escapeHtml(item) + '</span></label>'
            ).join('') + '</div></div>'
        ).join('');

        function composeNote() {
            const ticked = Array.from(checklist.querySelectorAll('input:checked')).map((box) => box.value);
            const extra = noteField.value.trim();
            const parts = [];
            if (ticked.length) parts.push('What I see: ' + ticked.join(', ') + '.');
            if (extra) parts.push(extra);
            return parts.join(' ');
        }

        function updatePreview() {
            const note = composeNote();
            notePreview.textContent = note ? 'The contributor will read: ' + note : '';
        }
        checklist.addEventListener('change', updatePreview);
        noteField.addEventListener('input', updatePreview);

        form.addEventListener('submit', async function (event) {
            event.preventDefault();
            const note = composeNote();
            const location = document.getElementById('reportLocation').value.trim();
            const file = reportFile();

            if (!note && !file) {
                result.hidden = false;
                result.textContent = 'Scan a photo above, or tick what you see, before sending.';
                return;
            }

            const body = new FormData();
            body.append('note', note);
            body.append('location', location);
            // Species guesses only. When the server withheld the list (outcome
            // 'unrecognized') it sends them as hint_predictions, so the contributor still
            // sees what the model almost thought. They stay a hint, never an answer.
            const predictions = speciesOnly(
                lastScanResult && (lastScanResult.hint_predictions || lastScanResult.predictions)
            );
            if (predictions.length > 0) {
                body.append('predictions', JSON.stringify(predictions));
            }
            if (file) {
                body.append('images', file, file.name || 'scan-photo.jpg');
                body.append('allowContribution', contribute.checked ? '1' : '0');
            }

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
                // Sent: the temporary copy is no longer needed, and the same photo is never offered twice.
                sentFile = file;
                cachedFile = null;
                pickedFile = null;
                if (window.PhotoCache && window.PhotoCache.dropReportPhoto) window.PhotoCache.dropReportPhoto();
                form.reset();
                updatePreview();
                renderPhoto();
                result.textContent = 'Sent. A contributor will pick it up from the queue. ' +
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