/**
 * Plantellect Scan Feature
 * Handles the scan modal UI interactions and plant prediction flow.
 * Uses ml-client.js for prediction API calls.
 */

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str == null ? '' : str);
    return div.innerHTML;
}

document.addEventListener('DOMContentLoaded', function() {
    const scanBtn = document.getElementById('scanPlantBtn');
    const scanModal = document.getElementById('scanModal');
    const scanModalClose = document.getElementById('scanModalClose');
    const scanUploadArea = document.getElementById('scanUploadArea');
    const scanImageInput = document.getElementById('scanImageInput');
    const scanUploadPrompt = document.getElementById('scanUploadPrompt');
    const scanUploadBtn = document.getElementById('scanUploadBtn');
    const scanCameraBtn = document.getElementById('scanCameraBtn');
    const scanPredictBtn = document.getElementById('scanPredictBtn');
    const scanPreview = document.getElementById('scanPreview');
    const scanPreviewImg = document.getElementById('scanPreviewImg');
    const scanResults = document.getElementById('scanResults');

    let selectedImageFile = null;

    // Open modal
    if (scanBtn) {
        scanBtn.addEventListener('click', function() {
            scanModal.classList.add('active');
        });
    }

    // Close modal
    function closeModal() {
        scanModal.classList.remove('active');
        scanPreview.style.display = 'none';
        scanResults.innerHTML = '';
        scanResults.style.display = 'none';
        selectedImageFile = null;
        scanPredictBtn.disabled = true;
    }

    if (scanModalClose) {
        scanModalClose.addEventListener('click', closeModal);
    }

    if (scanModal) {
        scanModal.addEventListener('click', function(e) {
            if (e.target === scanModal) closeModal();
        });
    }

    // File upload
    if (scanUploadBtn) {
        scanUploadBtn.addEventListener('click', function() {
            scanImageInput.click();
        });
    }

    if (scanImageInput) {
        scanImageInput.addEventListener('change', function(e) {
            if (e.target.files && e.target.files[0]) {
                handleImageSelected(e.target.files[0]);
            }
        });
    }

    // Drag and drop
    if (scanUploadArea) {
        scanUploadArea.addEventListener('click', function() {
            scanImageInput.click();
        });

        scanUploadArea.addEventListener('dragover', function(e) {
            e.preventDefault();
            scanUploadArea.classList.add('drag-over');
        });

        scanUploadArea.addEventListener('dragleave', function() {
            scanUploadArea.classList.remove('drag-over');
        });

        scanUploadArea.addEventListener('drop', function(e) {
            e.preventDefault();
            scanUploadArea.classList.remove('drag-over');
            if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                handleImageSelected(e.dataTransfer.files[0]);
            }
        });
    }

    // Camera capture
    if (scanCameraBtn) {
        scanCameraBtn.addEventListener('click', async function() {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ video: true });
                // Create a temporary video element for capture
                const video = document.createElement('video');
                video.srcObject = stream;
                video.play();

                // Show camera modal
                const cameraModal = document.createElement('div');
                cameraModal.className = 'scan-modal active';
                cameraModal.innerHTML = `
                    <div class="scan-modal-content">
                        <div class="scan-modal-header">
                            <h3>Take Photo</h3>
                            <button class="scan-modal-close" id="cameraClose">&times;</button>
                        </div>
                        <div class="scan-modal-body">
                            <video id="cameraVideo" autoplay playsinline style="width: 100%; border-radius: 8px;"></video>
                            <div class="scan-actions">
                                <button class="scan-action-btn primary" id="captureBtn">Capture</button>
                            </div>
                        </div>
                    </div>
                `;
                document.body.appendChild(cameraModal);

                const cameraVideo = document.getElementById('cameraVideo');
                const captureBtn = document.getElementById('captureBtn');
                const cameraClose = document.getElementById('cameraClose');

                cameraClose.addEventListener('click', function() {
                    stream.getTracks().forEach(track => track.stop());
                    document.body.removeChild(cameraModal);
                });

                captureBtn.addEventListener('click', function() {
                    const canvas = document.createElement('canvas');
                    canvas.width = cameraVideo.videoWidth;
                    canvas.height = cameraVideo.videoHeight;
                    canvas.getContext('2d').drawImage(cameraVideo, 0, 0);
                    canvas.toBlob(function(blob) {
                        const file = new File([blob], 'camera-photo.jpg', { type: 'image/jpeg' });
                        handleImageSelected(file);
                        stream.getTracks().forEach(track => track.stop());
                        document.body.removeChild(cameraModal);
                    }, 'image/jpeg');
                });
            } catch (err) {
                alert('Camera access denied or unavailable: ' + err.message);
            }
        });
    }

    function handleImageSelected(file) {
        if (!file.type.startsWith('image/')) {
            alert('Please select an image file');
            return;
        }
        selectedImageFile = file;
        scanPredictBtn.disabled = false;
        scanUploadPrompt.style.display = 'none';
        scanPreview.style.display = 'block';
        scanPreviewImg.src = URL.createObjectURL(file);
    }

    // Predict
    if (scanPredictBtn) {
        scanPredictBtn.addEventListener('click', async function() {
            if (!selectedImageFile) return;

            scanPredictBtn.disabled = true;
            scanPredictBtn.textContent = 'Predicting...';
            scanResults.style.display = 'block';
            scanResults.innerHTML = '<div class="scan-loading">Loading model and predicting...</div>';

            try {
                const result = await predictPlant(selectedImageFile, 5);
                renderResults(result);
            } catch (err) {
                scanResults.innerHTML = `<div class="scan-error">Error: ${err.message}</div>`;
            } finally {
                scanPredictBtn.disabled = false;
                scanPredictBtn.textContent = 'Predict';
            }
        });
    }

    function renderResults(result) {
        let html = `
            <div class="scan-result-header">
                <span>Inference: ${result.inference_ms}ms</span>
                <span>Model: ${result.model_version}</span>
            </div>
            <div class="scan-predictions">
        `;

        result.predictions.forEach((pred, index) => {
            const confidencePct = (pred.confidence * 100).toFixed(1);
            // The server attaches plantId when the species is in the library.
            // Link to the profile only then; never drop a prediction for it.
            const nameHtml = pred.plantId
                ? `<a class="scan-prediction-name" href="/plant-profile.html?plantId=${encodeURIComponent(pred.plantId)}">${escapeHtml(pred.common_name)}</a>`
                : `<span class="scan-prediction-name">${escapeHtml(pred.common_name)}</span>`;
            html += `
                <div class="scan-prediction-item">
                    <div class="scan-prediction-info">
                        <span class="scan-prediction-rank">#${index + 1}</span>
                        ${nameHtml}
                        <span class="scan-prediction-sci">${escapeHtml(pred.scientific_name)}</span>
                    </div>
                    <div class="scan-prediction-bar">
                        <div class="scan-prediction-fill" style="width: ${confidencePct}%"></div>
                    </div>
                    <span class="scan-prediction-conf">${confidencePct}%</span>
                </div>
            `;
        });

        html += '</div>';
        scanResults.innerHTML = html;
    }
});