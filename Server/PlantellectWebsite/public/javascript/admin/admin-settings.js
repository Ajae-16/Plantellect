export async function fetchSettings() {
    const response = await fetch('/admin/api/settings', { credentials: 'include' });
    if (!response.ok) {
        if (response.status === 401 || response.status === 403) window.location.href = '/auth.html';
        throw new Error('Failed to load settings');
    }
    return response.json();
}

export async function fetchAvailableModels() {
    const response = await fetch('/api/ml/model/info', { credentials: 'include' });
    if (!response.ok) {
        if (response.status === 401 || response.status === 403) window.location.href = '/auth.html';
        throw new Error('Failed to load available models');
    }
    return response.json();
}

export async function updateActiveModel(modelId) {
    const response = await fetch('/admin/api/ml/active-model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ modelId })
    });
    if (!response.ok) {
        let errMsg = 'Failed to update active model';
        try {
            const err = await response.json();
            errMsg = err.error || errMsg;
        } catch (_) {
            const text = await response.text().catch(() => '');
            if (text) errMsg = text;
        }
        throw new Error(errMsg);
    }
    return response.json();
}

export async function updateConfidence(modelId, config) {
    const response = await fetch('/admin/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ mlConfidence: { [modelId]: config } })
    });
    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to update confidence thresholds');
    }
    return response.json();
}

export async function updateApprovalMode(requestType, enabled) {
    const response = await fetch('/admin/api/approval-modes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ requestType, enabled })
    });
    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to update approval mode');
    }
    return response.json();
}

export async function updateDiscoveriesSettings(settings) {
    const response = await fetch('/admin/api/discoveries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(settings)
    });
    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to update discovery settings');
    }
    return response.json();
}

export async function updateMLRequestSettings(settings) {
    const response = await fetch('/admin/api/ml/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(settings)
    });
    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to update ML request settings');
    }
    return response.json();
}

export async function updateRoleLimits(roleLimits) {
    const response = await fetch('/admin/api/role-limits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ roleLimits })
    });
    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to update role limits');
    }
    return response.json();
}

export function renderModelSelector(container, models, activeModelId, onChange) {
    const options = models.map(m => `<option value="${escapeHtml(m)}" ${m === activeModelId ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('');
    container.innerHTML = `
        <label for="activeModelSelect" class="setting-label">Active Model</label>
        <select id="activeModelSelect" class="setting-select">${options}</select>
    `;
    const select = container.querySelector('#activeModelSelect');
    select.addEventListener('change', () => onChange(select.value));
}

export function renderConfidenceThresholds(container, confidence, availableModels, onChange) {
    // Every model the ML service has loaded gets a panel, even before it has a saved
    // entry: the panel below falls back to defaults, and the first save creates the
    // entry. (Filtering on `confidence[m]` meant a new model could never be configured.)
    // If the service is unreachable, show the models that already have saved settings.
    const modelIds = availableModels.length > 0 ? [...availableModels] : Object.keys(confidence);
    const tabsHtml = modelIds.map((id, i) => `
        <button type="button" class="confidence-tab ${i === 0 ? 'active' : ''}" data-model="${escapeHtml(id)}">${escapeHtml(id)}</button>
    `).join('');

    const panelsHtml = modelIds.map((id, i) => {
        const c = confidence[id] || { mode: 'off', acceptThreshold: 0.70, uncertainThreshold: 0.35, marginThreshold: 0.15 };
        return `
            <div class="confidence-panel ${i === 0 ? 'active' : ''}" data-model="${escapeHtml(id)}">
                <div class="setting-row">
                    <label class="setting-label">Mode</label>
                    <select class="setting-select confidence-mode" data-field="mode">
                        <option value="off" ${c.mode === 'off' ? 'selected' : ''}>Off</option>
                        <option value="log" ${c.mode === 'log' ? 'selected' : ''}>Log only</option>
                        <option value="enforce" ${c.mode === 'enforce' ? 'selected' : ''}>Enforce</option>
                    </select>
                </div>
                <div class="setting-row">
                    <label class="setting-label">Accept Threshold</label>
                    <input type="number" class="setting-input" data-field="acceptThreshold" value="${c.acceptThreshold}" step="0.01" min="0" max="1">
                </div>
                <div class="setting-row">
                    <label class="setting-label">Uncertain Threshold</label>
                    <input type="number" class="setting-input" data-field="uncertainThreshold" value="${c.uncertainThreshold}" step="0.01" min="0" max="1">
                </div>
                <div class="setting-row">
                    <label class="setting-label">Margin Threshold</label>
                    <input type="number" class="setting-input" data-field="marginThreshold" value="${c.marginThreshold}" step="0.01" min="0" max="1">
                </div>
            </div>
        `;
    }).join('');

    container.innerHTML = `
        <div class="confidence-tabs" role="tablist">${tabsHtml}</div>
        <div class="confidence-panels">${panelsHtml}</div>
    `;

    container.querySelectorAll('.confidence-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const model = tab.dataset.model;
            container.querySelectorAll('.confidence-tab').forEach(t => t.classList.toggle('active', t.dataset.model === model));
            container.querySelectorAll('.confidence-panel').forEach(p => p.classList.toggle('active', p.dataset.model === model));
        });
    });

    container.querySelectorAll('.confidence-panel').forEach(panel => {
        const modelId = panel.dataset.model;
        panel.querySelectorAll('select, input').forEach(input => {
            input.addEventListener('change', () => {
                const config = {
                    mode: panel.querySelector('.confidence-mode').value,
                    acceptThreshold: parseFloat(panel.querySelector('[data-field="acceptThreshold"]').value),
                    uncertainThreshold: parseFloat(panel.querySelector('[data-field="uncertainThreshold"]').value),
                    marginThreshold: parseFloat(panel.querySelector('[data-field="marginThreshold"]').value)
                };
                onChange(modelId, config);
            });
        });
    });
}

export function renderApprovalModes(container, payload, onToggle) {
    const modes = payload.modes || [];
    const autoCount = modes.filter(m => m.auto).length;

    const railsHtml = (payload.rules && payload.rules.rails) || [];
    const railsHtmlStr = railsHtml.length > 0
        ? '<details class="approval-rails"><summary>Always-on safeguards</summary><ul>' +
            railsHtml.map(r => '<li>' + escapeHtml(r) + '</li>').join('') +
            '</ul><p>' + escapeHtml((payload.rules && payload.rules.neverDenies) || '') + '</p></details>'
        : '';

    container.innerHTML = `
        <p class="admin-subtitle">All types start as <strong>manual</strong>. Automatic means a fixed rule approves submissions, recorded as &ldquo;System&rdquo;.</p>
        <div class="approval-mode-list" id="approvalModesList">
            ${modes.map(m => `
                <div class="approval-mode-row ${m.auto ? 'is-auto' : ''}" data-request-type="${escapeHtml(m.requestType)}" title="${escapeHtml(m.metaKey)}">
                    <div class="approval-mode-main">
                        <div class="approval-mode-text">
                            <div class="approval-mode-head">
                                <span class="approval-mode-label">${escapeHtml(m.label)}</span>
                                <span class="mode-pill">${m.auto ? 'Automatic' : 'Manual'}</span>
                            </div>
                            <p class="approval-mode-detail">${escapeHtml(m.detail)}</p>
                            ${m.note ? `<p class="approval-mode-note">${escapeHtml(m.note)}</p>` : ''}
                        </div>
                        <label class="switch" title="Automatic approval">
                            <input type="checkbox" class="approval-mode-input"
                                   aria-label="Automatic approval for ${escapeHtml(m.label)}"
                                   data-request-type="${escapeHtml(m.requestType)}"
                                   ${m.auto ? 'checked' : ''}>
                            <span class="switch-track"></span>
                        </label>
                    </div>
                    ${m.warning ? `<p class="approval-mode-warning">${escapeHtml(m.warning)}</p>` : ''}
                </div>
            `).join('')}
        </div>
        <div id="approvalModesRails">${railsHtmlStr}</div>
        <p class="admin-notice" id="approvalModesNotice" hidden></p>
    `;

    container.querySelectorAll('.approval-mode-input').forEach(input => {
        input.addEventListener('change', () => onToggle(input));
    });
}

export function renderDiscoveriesSettings(container, settings, onChange) {
    const fields = [
        { key: 'maxClaimsPerBotanist', label: 'Max Claims per Botanist', min: 1, max: 1000 },
        { key: 'maxOpenReportsPerAccount', label: 'Max Open Reports per Account', min: 1, max: 1000 },
        { key: 'cancelGraceHours', label: 'Cancel Grace Period (hours)', min: 0, max: 8760 },
        { key: 'reportCooldownMinutes', label: 'Report Cooldown (minutes)', min: 0, max: 10080 },
        { key: 'claimStaleDays', label: 'Claim Stale Days', min: 1, max: 365 },
        { key: 'notAPlantVotes', label: 'Not-a-Plant Vote Ceiling', min: 2, max: 100 },
        { key: 'discoveryClosedPhotoDays', label: 'Closed Report Photo Retention (days)', min: 1, max: 365 }
    ];

    container.innerHTML = fields.map(f => `
        <div class="setting-row">
            <label class="setting-label">${escapeHtml(f.label)}</label>
            <input type="number" class="setting-input" data-key="${f.key}" value="${settings[f.key]}" min="${f.min}" max="${f.max}">
        </div>
    `).join('');

    container.querySelectorAll('.setting-input').forEach(input => {
        input.addEventListener('change', () => {
            const updated = {};
            container.querySelectorAll('.setting-input').forEach(i => {
                updated[i.dataset.key] = parseInt(i.value, 10);
            });
            onChange(updated);
        });
    });
}

export function renderMLRequestSettings(container, settings, onChange) {
    container.innerHTML = `
        <div class="setting-row">
            <label class="setting-label">Max Top-K</label>
            <input type="number" class="setting-input" id="maxTopKInput" value="${settings.maxTopK}" min="1" max="100">
        </div>
    `;

    const input = container.querySelector('#maxTopKInput');
    input.addEventListener('change', () => {
        onChange({ maxTopK: parseInt(input.value, 10) });
    });
}

export function renderSpamQuotas(container, roleLimits, onChange) {
    if (!roleLimits || roleLimits.length === 0) {
        container.innerHTML = '<p>No role limits configured.</p>';
        return;
    }

    // Default values from settings for reference
    const DEFAULTS = {
        maxClaimsPerBotanist: 20,
        maxOpenReportsPerAccount: 10,
        maxScan: 30,
        rateLimitWindowMin: 10
    };

    container.innerHTML = `
        <div class="quota-defaults-note" style="margin-bottom: 12px; font-size: 13px; opacity: 0.7;">
            Defaults: Max Claims ${DEFAULTS.maxClaimsPerBotanist}, Max Open Reports ${DEFAULTS.maxOpenReportsPerAccount}, Max Scans ${DEFAULTS.maxScan} per ${DEFAULTS.rateLimitWindowMin} min window.
            Empty fields use defaults.
        </div>
        <table class="role-limits-table">
            <thead>
                <tr>
                    <th>Role</th>
                    <th>Max Claims</th>
                    <th>Max Open Reports</th>
                    <th>Max Scans</th>
                    <th>Rate Limit Window (min)</th>
                </tr>
            </thead>
            <tbody>
                ${roleLimits.map(r => `
                    <tr data-role="${escapeHtml(r.roleName)}">
                        <td>${escapeHtml(r.roleName)}</td>
                        <td><input type="number" class="setting-input quota-input" data-key="maxClaimsPerBotanist" value="${r.maxClaimsPerBotanist ?? ''}" min="1" max="1000" placeholder="${DEFAULTS.maxClaimsPerBotanist}"></td>
                        <td><input type="number" class="setting-input quota-input" data-key="maxOpenReportsPerAccount" value="${r.maxOpenReportsPerAccount ?? ''}" min="1" max="1000" placeholder="${DEFAULTS.maxOpenReportsPerAccount}"></td>
                        <td><input type="number" class="setting-input quota-input" value="${r.maxScan ?? ''}" data-key="maxScan" min="1" max="1000" placeholder="${DEFAULTS.maxScan}"></td>
                        <td><input type="number" class="setting-input quota-input" value="${r.rateLimitWindowMin ?? ''}" data-key="rateLimitWindowMin" min="1" max="10080" placeholder="${DEFAULTS.rateLimitWindowMin}"></td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
        <p class="admin-notice" id="spamQuotasNotice" hidden></p>
    `;

    if (onChange) {
        let debounceTimer = null;
        container.querySelectorAll('.quota-input').forEach(input => {
            input.addEventListener('change', () => {
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => {
                    const row = input.closest('tr');
                    const roleName = row.dataset.role;
                    const updated = { roleName };
                    row.querySelectorAll('.quota-input').forEach(i => {
                        const val = i.value;
                        if (val !== '') updated[i.dataset.key] = parseInt(val, 10);
                    });
                    onChange([updated]);
                }, 500);
            });
        });
    }
}

export function showNotice(containerId, message, isError = false) {
    const notice = document.getElementById(containerId);
    if (!notice) return;
    notice.textContent = message;
    notice.className = 'admin-notice' + (isError ? ' error' : '');
    notice.hidden = false;
    setTimeout(() => { notice.hidden = true; }, 5000);
}

export function confirmAutoEnable(mode) {
    const lines = [
        'Turn ON automatic approval for ' + mode.label + '?',
        '',
        mode.detail,
        '',
        'Every submission of this type will then be approved by a fixed rule, ' +
        'with no human reading it. Decisions are recorded against the machine ' +
        'account "System", not against you.'
    ];
    if (mode.warning) {
        lines.push('', mode.warning);
    }
    lines.push('', 'A discovery report is never auto-decided, and a submitter\'s first ' +
        'submission is always reviewed by hand.');
    return confirm(lines.join('\n'));
}

export function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str == null ? '' : str);
    return div.innerHTML;
}

export async function initSettingsPage() {
    const sections = [
        { id: 'modelSection', loader: loadModelSection },
        { id: 'confidenceSection', loader: loadConfidenceSection },
        { id: 'approvalModesSection', loader: loadApprovalModesSection },
        { id: 'discoveriesSection', loader: loadDiscoveriesSection },
        { id: 'mlRequestSection', loader: loadMLRequestSection },
        { id: 'spamQuotasSection', loader: loadSpamQuotasSection }
    ];

    await Promise.all(sections.map(s => s.loader().catch(err => {
        console.error(`Failed to load ${s.id}:`, err);
        const container = document.getElementById(s.id);
        if (container) {
            const inner = container.querySelector('.model-selector, .confidence-editor, .approval-modes-editor, .discoveries-editor, .ml-request-editor, .spam-quotas-editor');
            if (inner) inner.innerHTML = '<p class="admin-notice error">Failed to load section: ' + escapeHtml(err.message) + '</p>';
            else container.innerHTML = '<p class="admin-notice error">Failed to load section: ' + escapeHtml(err.message) + '</p>';
        }
    })));
}

// Extract model ID from FastAPI response object or string
function modelIdOf(m) {
    if (typeof m === 'string') return m;
    return (m && (m.id || m.modelId || m.model_id || m.name)) || '';
}

async function loadModelSection() {
    const container = document.getElementById('modelSection');
    if (!container) return;
    const inner = container.querySelector('.model-selector');
    try {
        const [settings, modelsData] = await Promise.all([fetchSettings(), fetchAvailableModels()]);
        const activeModelId = settings.mlActiveModel?.modelId || '';
        const availableModels = (modelsData.available_models || []).map(modelIdOf).filter(Boolean);
        renderModelSelector(inner, availableModels, activeModelId, handleModelChange);
    } catch (err) {
        if (inner) inner.innerHTML = '<p class="admin-notice error">Failed to load model selector: ' + escapeHtml(err.message) + '</p>';
    }
}

async function handleModelChange(modelId) {
    const notice = document.getElementById('modelNotice');
    const select = document.getElementById('activeModelSelect');
    const previousValue = select ? select.value : modelId;
    try {
        await updateActiveModel(modelId);
        showNotice('modelNotice', `Active model switched to ${modelId}`);
    } catch (err) {
        showNotice('modelNotice', 'Error: ' + err.message, true);
        // Revert dropdown to previous value on failure
        if (select) select.value = previousValue;
    }
}

async function loadConfidenceSection() {
    const container = document.getElementById('confidenceSection');
    if (!container) return;
    const inner = container.querySelector('.confidence-editor');
    try {
        const [settings, modelsData] = await Promise.all([fetchSettings(), fetchAvailableModels()]);
        const availableModels = (modelsData.available_models || []).map(modelIdOf).filter(Boolean);
        renderConfidenceThresholds(inner, settings.mlConfidence || {}, availableModels, handleConfidenceChange);
    } catch (err) {
        if (inner) inner.innerHTML = '<p class="admin-notice error">Failed to load confidence thresholds: ' + escapeHtml(err.message) + '</p>';
    }
}

async function handleConfidenceChange(modelId, config) {
    const notice = document.getElementById('confidenceNotice');
    try {
        await updateConfidence(modelId, config);
        showNotice('confidenceNotice', `Updated ${modelId} confidence thresholds`);
    } catch (err) {
        showNotice('confidenceNotice', 'Error: ' + err.message, true);
    }
}

async function loadApprovalModesSection() {
    const container = document.getElementById('approvalModesSection');
    if (!container) return;
    const inner = container.querySelector('.approval-modes-editor');
    try {
        const response = await fetch('/admin/api/approval-modes', { credentials: 'include' });
        if (!response.ok) throw new Error('Failed to load approval modes');
        const payload = await response.json();
        renderApprovalModes(inner, payload, handleApprovalModeToggle);
    } catch (err) {
        if (inner) inner.innerHTML = '<p class="admin-notice error">Failed to load approval modes: ' + escapeHtml(err.message) + '</p>';
    }
}

async function handleApprovalModeToggle(input) {
    const requestType = input.dataset.requestType;
    const enabled = input.checked;
    const notice = document.getElementById('approvalModesNotice');
    const row = input.closest('.approval-mode-row');

    const known = (await fetch('/admin/api/approval-modes', { credentials: 'include' }).then(r => r.json())).modes.find(m => m.requestType === requestType);

    if (enabled && known && !confirmAutoEnable(known)) {
        input.checked = false;
        return;
    }

    notice.hidden = true;
    try {
        const data = await updateApprovalMode(requestType, enabled);
        showNotice('approvalModesNotice', data.message);
        loadApprovalModesSection();
    } catch (err) {
        input.checked = !enabled;
        showNotice('approvalModesNotice', 'Error: ' + err.message, true);
    } finally {
        if (row) {
            row.classList.toggle('is-auto', input.checked);
            const pill = row.querySelector('.mode-pill');
            if (pill) pill.textContent = input.checked ? 'Automatic' : 'Manual';
        }
    }
}

async function loadDiscoveriesSection() {
    const container = document.getElementById('discoveriesSection');
    if (!container) return;
    try {
        const settings = await fetchSettings();
        renderDiscoveriesSettings(container.querySelector('.discoveries-editor'), settings.discoveries || {}, handleDiscoveriesChange);
    } catch (err) {
        container.innerHTML = '<p class="admin-notice error">Failed to load discovery settings: ' + escapeHtml(err.message) + '</p>';
    }
}

async function handleDiscoveriesChange(updated) {
    const notice = document.getElementById('discoveriesNotice');
    try {
        await updateDiscoveriesSettings(updated);
        showNotice('discoveriesNotice', 'Discovery settings updated');
    } catch (err) {
        showNotice('discoveriesNotice', 'Error: ' + err.message, true);
    }
}

async function loadMLRequestSection() {
    const container = document.getElementById('mlRequestSection');
    if (!container) return;
    const inner = container.querySelector('.ml-request-editor');
    try {
        const settings = await fetchSettings();
        renderMLRequestSettings(inner, settings.mlRequest || {}, handleMLRequestChange);
    } catch (err) {
        if (inner) inner.innerHTML = '<p class="admin-notice error">Failed to load ML request settings: ' + escapeHtml(err.message) + '</p>';
    }
}

async function handleMLRequestChange(updated) {
    const notice = document.getElementById('mlRequestNotice');
    try {
        await updateMLRequestSettings(updated);
        showNotice('mlRequestNotice', 'ML request settings updated');
    } catch (err) {
        showNotice('mlRequestNotice', 'Error: ' + err.message, true);
    }
}

async function loadSpamQuotasSection() {
    const container = document.getElementById('spamQuotasSection');
    if (!container) return;
    const inner = container.querySelector('.spam-quotas-editor');
    try {
        const response = await fetch('/admin/api/role-limits', { credentials: 'include' });
        if (!response.ok) throw new Error('Failed to load role limits');
        const data = await response.json();
        renderSpamQuotas(inner, data.roleLimits || [], handleSpamQuotasChange);
    } catch (err) {
        if (inner) inner.innerHTML = '<p class="admin-notice error">Failed to load spam quotas: ' + escapeHtml(err.message) + '</p>';
    }
}

async function handleSpamQuotasChange(roleLimits) {
    const notice = document.getElementById('spamQuotasNotice');
    try {
        await updateRoleLimits(roleLimits);
        showNotice('spamQuotasNotice', 'Spam quotas updated');
    } catch (err) {
        showNotice('spamQuotasNotice', 'Error: ' + err.message, true);
    }
}

/* ------------------------------------------------------------------ */
/* Header: signed-in username                                          */
/* ------------------------------------------------------------------ */

export async function initAdminUser() {
    const el = document.getElementById('adminUser');
    if (!el) return;

    try {
        const response = await fetch('/api/auth/me', { credentials: 'include' });
        if (response.status === 401 || response.status === 403) {
            window.location.href = '/auth.html';
            return;
        }
        if (!response.ok) throw new Error('Failed to load user');

        const user = await response.json();
        el.textContent = user.username || user.email || 'Admin';
        if (Array.isArray(user.roles) && user.roles.length) {
            el.title = 'Roles: ' + user.roles.join(', ');
        }
    } catch (err) {
        console.error('Failed to load admin user:', err);
        el.textContent = 'Not signed in';
    }
}

/* ------------------------------------------------------------------ */
/* Topbar: highlights the section you are reading while you scroll.    */
/* Works even for tiny (collapsed) sections that can never reach the   */
/* top of the screen, by using a reference line that slides down the   */
/* viewport as you scroll.                                             */
/* ------------------------------------------------------------------ */

export function initSettingsTopbar() {
    const topbar = document.getElementById('settingsTopbar');
    if (!topbar) return;

    const tabs = Array.from(topbar.querySelectorAll('.settings-tab'));
    const sections = tabs
        .map(t => document.getElementById(t.dataset.target))
        .filter(Boolean);
    if (sections.length === 0) return;

    let currentId = null;
    let manualTarget = null;   // set by a tab click so scroll tracking does not fight the smooth scroll
    let ticking = false;

    // The element that actually scrolls: a scrollable ancestor if there is one, otherwise the page
    function getScroller() {
        let node = topbar.parentElement;
        while (node && node !== document.body) {
            const overflowY = getComputedStyle(node).overflowY;
            if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
                return node;
            }
            node = node.parentElement;
        }
        return document.scrollingElement || document.documentElement;
    }

    function setActive(targetId) {
        tabs.forEach(t => {
            const on = t.dataset.target === targetId;
            t.classList.toggle('active', on);
            if (on) t.setAttribute('aria-current', 'true');
            else t.removeAttribute('aria-current');
        });

        if (targetId === currentId) return;
        currentId = targetId;

        // Keep the active tab visible when the topbar itself scrolls sideways (phones)
        const active = tabs.find(t => t.dataset.target === targetId);
        if (active && topbar.scrollWidth > topbar.clientWidth) {
            topbar.scrollTo({
                left: active.offsetLeft - (topbar.clientWidth - active.offsetWidth) / 2,
                behavior: 'smooth'
            });
        }
    }

    // Sliding reference line, so even tiny sections get their turn.
    //   scrolled to the top    -> line sits just below the topbar
    //   scrolled to the bottom -> line sits at the bottom edge of the viewport
    //   in between             -> linear blend
    // The active section is the last one whose top edge is above the line.
    function updateFromScroll() {
        ticking = false;
        if (manualTarget) return;

        const scroller = getScroller();
        const maxScroll = scroller.scrollHeight - scroller.clientHeight;
        if (maxScroll <= 2) return; // nothing to scroll: keep whatever is highlighted (clicks still work)

        const progress = Math.min(1, Math.max(0, scroller.scrollTop / maxScroll));
        const topLine = topbar.getBoundingClientRect().bottom + 16;
        const bottomLine = window.innerHeight - 4;
        const line = topLine + progress * (bottomLine - topLine);

        let current = sections[0].id;
        for (const section of sections) {
            if (section.getBoundingClientRect().top <= line) current = section.id;
            else break;
        }

        setActive(current);
    }

    function onScroll() {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(updateFromScroll);
    }

    function goTo(targetId, { smooth = true, updateHash = true } = {}) {
        const section = document.getElementById(targetId);
        if (!section) return;

        const details = section.querySelector('details.collapse');
        if (details) details.open = true;

        manualTarget = targetId;
        setActive(targetId);
        if (updateHash) history.replaceState(null, '', '#' + targetId);

        requestAnimationFrame(() => {
            section.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
        });
    }

    // Scroll tracking takes over again as soon as the person scrolls by hand
    function releaseManual() {
        if (manualTarget) {
            manualTarget = null;
            onScroll();
        }
    }
    window.addEventListener('wheel', releaseManual, { passive: true });
    window.addEventListener('touchmove', releaseManual, { passive: true });
    window.addEventListener('keydown', (e) => {
        if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) releaseManual();
    });

    topbar.addEventListener('click', (e) => {
        const tab = e.target.closest('.settings-tab');
        if (!tab) return;
        e.preventDefault();
        goTo(tab.dataset.target);
    });

    window.addEventListener('hashchange', () => {
        const id = location.hash.slice(1);
        if (tabs.some(t => t.dataset.target === id)) goTo(id, { updateHash: false });
    });

    // capture:true catches scrolling of any element, so it works whether the page or a panel scrolls
    document.addEventListener('scroll', onScroll, { passive: true, capture: true });
    window.addEventListener('resize', onScroll);
    // opening or closing a section changes the page height, so re-check
    document.querySelectorAll('details.collapse').forEach(d => d.addEventListener('toggle', onScroll));

    const initial = location.hash.slice(1);
    if (tabs.some(t => t.dataset.target === initial)) {
        goTo(initial, { smooth: false, updateHash: false });
    } else {
        updateFromScroll();
    }
}

export function addTopbarTab() {
    if (document.getElementById('settingsTopbarTab')) return;

    const topbar = document.querySelector('.plants-topbar, .dashboard-topbar');
    if (!topbar) return;

    const tab = document.createElement('a');
    tab.id = 'settingsTopbarTab';
    tab.href = '/admin/settings';
    tab.className = topbar.querySelector('a')?.className?.replace('plants-tab', '').replace('dashboard-tab', '') + ' plants-tab';
    tab.textContent = 'Settings';
    tab.dataset.target = 'settingsSection';
    topbar.appendChild(tab);
}