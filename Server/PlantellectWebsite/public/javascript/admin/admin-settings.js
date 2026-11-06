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

// One request for every changed model: the server validates all of them and saves all or none.
export async function updateConfidenceMany(changes) {
    const response = await fetch('/admin/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ mlConfidence: changes })
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

// Settings are drafts: nothing here saves on change. Each section registers with SettingsForms
// (javascript/admin/settings-forms.js), which adds Save / Cancel, a per-row undo and the
// "Save all / Cancel all" bar. The load* functions at the bottom do the registering.
const forms = () => window.SettingsForms;

export function renderModelSelector(container, models, activeModelId) {
    const options = models.map(m => `<option value="${escapeHtml(m)}" ${m === activeModelId ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('');
    container.innerHTML = `
        <div class="setting-row">
            <label for="activeModelSelect" class="setting-label">Active Model</label>
            <select id="activeModelSelect" class="setting-select">${options}</select>
        </div>
    `;
}

// Same values as DEFAULTS in config/ml-confidence.js; only used to fill a panel that has no saved value.
const CONFIDENCE_DEFAULTS = {
    mode: 'off', acceptThreshold: 0.70, uncertainThreshold: 0.35, marginThreshold: 0.15,
    contributeMode: 'off', contributeThreshold: 0.95, contributeUpperThreshold: 1, contributeDailyCap: 5, contributeSpeciesCap: 20, contributeOtherPlants: 'off', contributeOtherPlantCap: 20
};

// Shown as percents (95) on this page only. The backend, the database and the scan tokens all keep
// 0..1 (0.95): the conversion happens in SettingsForms.decimalToPercent / percentToDecimal.
const PERCENT_FIELDS = ['acceptThreshold', 'uncertainThreshold', 'marginThreshold', 'contributeThreshold', 'contributeUpperThreshold'];
const WHOLE_FIELDS = ['contributeDailyCap', 'contributeSpeciesCap', 'contributeOtherPlantCap'];
const PERCENT_LABELS = {
    acceptThreshold: 'Accept Threshold', uncertainThreshold: 'Uncertain Threshold', marginThreshold: 'Margin Threshold',
    contributeThreshold: 'Contribute lower threshold', contributeUpperThreshold: 'Contribute upper threshold'
};

function percentRow(c, field) {
    return `
                <div class="setting-row">
                    <label class="setting-label">${PERCENT_LABELS[field]} (%)</label>
                    <input type="number" class="setting-input" data-field="${field}" data-percent value="${forms().decimalToPercent(c[field])}" step="any" min="0" max="100">
                </div>`;
}

export function renderConfidenceThresholds(container, confidence, availableModels) {
    // Every model the ML service has loaded gets a panel, even before it has a saved
    // entry: the panel below falls back to defaults, and the first save creates the
    // entry. (Filtering on `confidence[m]` meant a new model could never be configured.)
    // If the service is unreachable, show the models that already have saved settings.
    const modelIds = availableModels.length > 0 ? [...availableModels] : Object.keys(confidence);
    const tabsHtml = modelIds.map((id, i) => `
        <button type="button" class="confidence-tab ${i === 0 ? 'active' : ''}" data-model="${escapeHtml(id)}">${escapeHtml(id)}</button>
    `).join('');

    // What each panel was built from, so an untouched field is saved back exactly as it was
    // (a stored 0.123456 shows as 12.35 and must not be rewritten as 0.1235).
    const originals = {};

    const panelsHtml = modelIds.map((id, i) => {
        // Merged over the defaults so a model saved before the contribute keys existed still renders.
        const c = { ...CONFIDENCE_DEFAULTS, ...(confidence[id] || {}) };
        originals[id] = c;
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
                ${percentRow(c, 'acceptThreshold')}
                ${percentRow(c, 'uncertainThreshold')}
                ${percentRow(c, 'marginThreshold')}
                <h3 class="confidence-subhead">Scan contributions</h3>
                <p class="admin-subtitle">Lets a user offer a scan photo for ML training only. Never shown publicly. Offers are made only when Mode above is <strong>Enforce</strong> and the scan is identified.</p>
                <div class="setting-row">
                    <label class="setting-label">Contribute offers</label>
                    <select class="setting-select" data-field="contributeMode">
                        <option value="off" ${c.contributeMode !== 'on' ? 'selected' : ''}>Off</option>
                        <option value="on" ${c.contributeMode === 'on' ? 'selected' : ''}>On</option>
                    </select>
                </div>
                ${percentRow(c, 'contributeThreshold')}
                ${percentRow(c, 'contributeUpperThreshold')}
                <p class="admin-subtitle">A scan is offered only when its top confidence is <strong>between</strong> the lower and upper thresholds (both included), for example 85 to 95. Set the upper to 100 for no ceiling. The scan must also be identified, so keep the band at or above the Accept Threshold.</p>
                <div class="setting-row">
                    <label class="setting-label">Daily cap per user</label>
                    <input type="number" class="setting-input" data-field="contributeDailyCap" value="${c.contributeDailyCap}" step="1" min="1" max="1000">
                </div>
                <div class="setting-row">
                    <label class="setting-label">Daily cap per species</label>
                    <input type="number" class="setting-input" data-field="contributeSpeciesCap" value="${c.contributeSpeciesCap}" step="1" min="1" max="1000">
                </div>
                <h3 class="confidence-subhead">Other plant contributions</h3>
                <p class="admin-subtitle">Scans the model calls <strong>Other plant</strong> (a plant it has no class for). They use the same Contribute offers switch and confidence band above, but have their own switch and daily cap. These photos have no plant yet: they wait under <strong>Other plant (no plant assigned yet)</strong> in Plants &gt; Scan contributions until an admin moves them to the right plant. They never reach the dataset or the public library on their own.</p>
                <div class="setting-row">
                    <label class="setting-label">Accept Other plant scans</label>
                    <select class="setting-select" data-field="contributeOtherPlants">
                        <option value="off" ${c.contributeOtherPlants !== 'on' ? 'selected' : ''}>Off</option>
                        <option value="on" ${c.contributeOtherPlants === 'on' ? 'selected' : ''}>On</option>
                    </select>
                </div>
                <div class="setting-row">
                    <label class="setting-label">Daily cap for Other plant (all users)</label>
                    <input type="number" class="setting-input" data-field="contributeOtherPlantCap" value="${c.contributeOtherPlantCap}" step="1" min="1" max="1000">
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

    // Marks the tab of every model that has unsaved edits (so a change on a hidden tab is not missed).
    function markDirtyTabs() {
        container.querySelectorAll('.confidence-panel').forEach(panel => {
            const tab = container.querySelector(`.confidence-tab[data-model="${CSS.escape(panel.dataset.model)}"]`);
            if (tab) tab.classList.toggle('is-dirty', Boolean(panel.querySelector('.sf-changed')));
        });
    }

    // Reads one panel back into the stored shape (0..1). Returns { config } or { error }.
    function readPanel(panel) {
        const original = originals[panel.dataset.model];
        const config = { ...original };
        config.mode = panel.querySelector('.confidence-mode').value;
        config.contributeMode = panel.querySelector('[data-field="contributeMode"]').value;
        config.contributeOtherPlants = panel.querySelector('[data-field="contributeOtherPlants"]').value;
        for (const field of PERCENT_FIELDS) {
            const input = panel.querySelector(`[data-field="${field}"]`);
            if (!input.classList.contains('sf-changed')) continue;   // untouched: keep the stored number as is
            const decimal = forms().percentToDecimal(input.value);
            if (Number.isNaN(decimal) || decimal < 0 || decimal > 1) {
                return { error: `${panel.dataset.model}: ${PERCENT_LABELS[field]} must be a number from 0 to 100.` };
            }
            config[field] = decimal;
        }
        for (const field of WHOLE_FIELDS) {
            const input = panel.querySelector(`[data-field="${field}"]`);
            if (!input.classList.contains('sf-changed')) continue;
            const n = Number(input.value);
            if (input.value.trim() === '' || !Number.isInteger(n) || n < 1 || n > 1000) {
                return { error: `${panel.dataset.model}: ${input.closest('.setting-row').querySelector('.setting-label').textContent} must be a whole number from 1 to 1000.` };
            }
            config[field] = n;
        }
        if (config.contributeThreshold > config.contributeUpperThreshold) {
            return { error: `${panel.dataset.model}: the contribute lower threshold cannot be higher than the upper threshold.` };
        }
        if (config.uncertainThreshold >= config.acceptThreshold) {
            return { error: `${panel.dataset.model}: the Uncertain Threshold must be lower than the Accept Threshold.` };
        }
        return { config };
    }

    // { modelId: config } for every panel with unsaved edits, or { error }.
    function collectChanges() {
        const changes = {};
        for (const panel of container.querySelectorAll('.confidence-panel')) {
            if (!panel.querySelector('.sf-changed')) continue;
            const read = readPanel(panel);
            if (read.error) return { error: read.error };
            changes[panel.dataset.model] = read.config;
        }
        return { changes };
    }

    return { markDirtyTabs, collectChanges, originals };
}

export function renderApprovalModes(container, payload) {
    const modes = payload.modes || [];

    const railsHtml = (payload.rules && payload.rules.rails) || [];
    const railsHtmlStr = railsHtml.length > 0
        ? '<details class="approval-rails"><summary>Always-on safeguards</summary><ul>' +
            railsHtml.map(r => '<li>' + escapeHtml(r) + '</li>').join('') +
            '</ul><p>' + escapeHtml((payload.rules && payload.rules.neverDenies) || '') + '</p></details>'
        : '';

    // The notice for this section is the static #approvalModesNotice in admin-settings.html.
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
    `;

    // The row's label and look follow the switch while it is a draft.
    container.querySelectorAll('.approval-mode-input').forEach(input => {
        input.addEventListener('change', () => {
            const row = input.closest('.approval-mode-row');
            if (!row) return;
            row.classList.toggle('is-auto', input.checked);
            const pill = row.querySelector('.mode-pill');
            if (pill) pill.textContent = input.checked ? 'Automatic' : 'Manual';
        });
    });
}

const DISCOVERY_FIELDS = [
    { key: 'maxClaimPerUsers', label: 'Max Claims per User', min: 1, max: 1000 },
    { key: 'maxOpenReportsPerAccount', label: 'Max Open Reports per Account', min: 1, max: 1000 },
    { key: 'cancelGraceHours', label: 'Cancel Grace Period (hours)', min: 0, max: 8760 },
    { key: 'reportCooldownMinutes', label: 'Report Cooldown (minutes)', min: 0, max: 10080 },
    { key: 'claimStaleDays', label: 'Claim Stale Days', min: 1, max: 365 },
    { key: 'notAPlantVotes', label: 'Not-a-Plant Vote Ceiling', min: 2, max: 100 },
    { key: 'discoveryClosedPhotoDays', label: 'Closed Report Photo Retention (days)', min: 1, max: 365 }
];

export function renderDiscoveriesSettings(container, settings) {
    container.innerHTML = DISCOVERY_FIELDS.map(f => `
        <div class="setting-row">
            <label class="setting-label">${escapeHtml(f.label)}</label>
            <input type="number" class="setting-input" data-key="${f.key}" value="${settings[f.key]}" min="${f.min}" max="${f.max}" step="1">
        </div>
    `).join('');
}

// Whole-number inputs: returns { values } (every key, as numbers) or { error }.
function readWholeNumbers(container, fields) {
    const values = {};
    for (const f of fields) {
        const input = container.querySelector(`[data-key="${f.key}"]`);
        const n = Number(input.value);
        if (input.value.trim() === '' || !Number.isInteger(n) || n < f.min || n > f.max) {
            return { error: `${f.label} must be a whole number from ${f.min} to ${f.max}.` };
        }
        values[f.key] = n;
    }
    return { values };
}

export function renderMLRequestSettings(container, settings) {
    container.innerHTML = `
        <div class="setting-row">
            <label class="setting-label">Max Top-K</label>
            <input type="number" class="setting-input" id="maxTopKInput" value="${settings.maxTopK}" min="1" max="100" step="1">
        </div>
    `;
}

const QUOTA_DEFAULTS = {
    maxClaimPerUsers: 20,
    maxOpenReportsPerAccount: 10,
    maxScan: 30,
    rateLimitWindowMin: 10
};
const QUOTA_LIMITS = { maxClaimPerUsers: 1000, maxOpenReportsPerAccount: 1000, maxScan: 1000, rateLimitWindowMin: 10080 };

export function renderSpamQuotas(container, roleLimits) {
    if (!roleLimits || roleLimits.length === 0) {
        container.innerHTML = '<p>No role limits configured.</p>';
        return;
    }

    container.innerHTML = `
        <div class="quota-defaults-note" style="margin-bottom: 12px; font-size: 13px; opacity: 0.7;">
            Defaults: Max Claims ${QUOTA_DEFAULTS.maxClaimPerUsers}, Max Open Reports ${QUOTA_DEFAULTS.maxOpenReportsPerAccount}, Max Scans ${QUOTA_DEFAULTS.maxScan} per ${QUOTA_DEFAULTS.rateLimitWindowMin} min window.
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
                        <td><input type="number" class="setting-input quota-input" data-key="maxClaimPerUsers" value="${r.maxClaimPerUsers ?? ''}" min="1" max="1000" placeholder="${QUOTA_DEFAULTS.maxClaimPerUsers}"></td>
                        <td><input type="number" class="setting-input quota-input" data-key="maxOpenReportsPerAccount" value="${r.maxOpenReportsPerAccount ?? ''}" min="1" max="1000" placeholder="${QUOTA_DEFAULTS.maxOpenReportsPerAccount}"></td>
                        <td><input type="number" class="setting-input quota-input" value="${r.maxScan ?? ''}" data-key="maxScan" min="1" max="1000" placeholder="${QUOTA_DEFAULTS.maxScan}"></td>
                        <td><input type="number" class="setting-input quota-input" value="${r.rateLimitWindowMin ?? ''}" data-key="rateLimitWindowMin" min="1" max="10080" placeholder="${QUOTA_DEFAULTS.rateLimitWindowMin}"></td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;
}

// The changed role rows as the API wants them, or { error }. The API can set a limit but not clear
// one, so a box that had a number may not be emptied.
function collectQuotaChanges(container) {
    const rows = [];
    for (const tr of container.querySelectorAll('tr[data-role]')) {
        if (!tr.querySelector('.sf-changed')) continue;
        const row = { roleName: tr.dataset.role };
        for (const input of tr.querySelectorAll('.quota-input')) {
            const key = input.dataset.key;
            const text = input.value.trim();
            if (text === '') {
                if (input._sfInitial !== '' && input.classList.contains('sf-changed')) {
                    return { error: `${tr.dataset.role}: a limit cannot be cleared here, enter a number instead.` };
                }
                continue;
            }
            const n = Number(text);
            if (!Number.isInteger(n) || n < 1 || n > QUOTA_LIMITS[key]) {
                return { error: `${tr.dataset.role}: ${key} must be a whole number from 1 to ${QUOTA_LIMITS[key]}.` };
            }
            row[key] = n;
        }
        rows.push(row);
    }
    return { rows };
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
        { id: 'spamQuotasSection', loader: loadSpamQuotasSection },
        { id: 'datasetAuditSection', loader: loadDatasetAuditSection }
    ];

    await Promise.all(sections.map(s => s.loader().catch(err => {
        console.error(`Failed to load ${s.id}:`, err);
        const container = document.getElementById(s.id);
        if (container) {
            const inner = container.querySelector('.model-selector, .confidence-editor, .approval-modes-editor, .discoveries-editor, .ml-request-editor, .spam-quotas-editor, .dataset-audit-editor');
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
        renderModelSelector(inner, availableModels, activeModelId);
        forms().register({
            id: 'model', label: 'ML Model', root: inner, noticeId: 'modelNotice',
            save: async () => {
                const modelId = inner.querySelector('#activeModelSelect').value;
                await updateActiveModel(modelId);
                return `Active model switched to ${modelId}`;
            }
        });
    } catch (err) {
        if (inner) inner.innerHTML = '<p class="admin-notice error">Failed to load model selector: ' + escapeHtml(err.message) + '</p>';
    }
}

async function loadConfidenceSection() {
    const container = document.getElementById('confidenceSection');
    if (!container) return;
    const inner = container.querySelector('.confidence-editor');
    try {
        const [settings, modelsData] = await Promise.all([fetchSettings(), fetchAvailableModels()]);
        const availableModels = (modelsData.available_models || []).map(modelIdOf).filter(Boolean);
        const editor = renderConfidenceThresholds(inner, settings.mlConfidence || {}, availableModels);
        forms().register({
            id: 'confidence', label: 'Confidence', root: inner, noticeId: 'confidenceNotice',
            onChange: () => editor.markDirtyTabs(),
            validate: () => editor.collectChanges().error || '',
            save: async () => {
                const { changes } = editor.collectChanges();
                const ids = Object.keys(changes);
                await updateConfidenceMany(changes);
                // What was just saved is the new "untouched" value for the next edit.
                for (const id of ids) editor.originals[id] = changes[id];
                return `Updated ${ids.join(', ')} confidence settings`;
            }
        });
    } catch (err) {
        if (inner) inner.innerHTML = '<p class="admin-notice error">Failed to load confidence thresholds: ' + escapeHtml(err.message) + '</p>';
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
        renderApprovalModes(inner, payload);
        forms().register({
            id: 'approvalModes', label: 'Approval Modes', root: inner, noticeId: 'approvalModesNotice',
            save: async () => {
                const changed = Array.from(inner.querySelectorAll('.approval-mode-input'))
                    .filter(input => input.checked !== input.defaultChecked);
                const done = [];
                const skipped = [];
                const failed = [];
                for (const input of changed) {
                    const mode = (payload.modes || []).find(m => m.requestType === input.dataset.requestType);
                    // Turning automatic approval ON is the one change that asks first, at save time.
                    if (input.checked && mode && !confirmAutoEnable(mode)) { skipped.push(mode.label); continue; }
                    try {
                        await updateApprovalMode(input.dataset.requestType, input.checked);
                        done.push(mode ? mode.label : input.dataset.requestType);
                    } catch (err) {
                        failed.push(`${mode ? mode.label : input.dataset.requestType}: ${err.message}`);
                    }
                }
                // Show what the server now says, whatever happened above.
                await loadApprovalModesSection();
                if (failed.length) throw new Error('Not saved: ' + failed.join('; '));
                const parts = [];
                if (done.length) parts.push('Updated ' + done.join(', '));
                if (skipped.length) parts.push('Left unchanged (not confirmed): ' + skipped.join(', '));
                return parts.join('. ') + '.';
            }
        });
    } catch (err) {
        if (inner) inner.innerHTML = '<p class="admin-notice error">Failed to load approval modes: ' + escapeHtml(err.message) + '</p>';
    }
}

async function loadDiscoveriesSection() {
    const container = document.getElementById('discoveriesSection');
    if (!container) return;
    try {
        const settings = await fetchSettings();
        const inner = container.querySelector('.discoveries-editor');
        renderDiscoveriesSettings(inner, settings.discoveries || {});
        forms().register({
            id: 'discoveries', label: 'Discoveries', root: inner, noticeId: 'discoveriesNotice',
            validate: () => readWholeNumbers(inner, DISCOVERY_FIELDS).error || '',
            save: async () => {
                await updateDiscoveriesSettings(readWholeNumbers(inner, DISCOVERY_FIELDS).values);
                return 'Discovery settings updated';
            }
        });
    } catch (err) {
        container.innerHTML = '<p class="admin-notice error">Failed to load discovery settings: ' + escapeHtml(err.message) + '</p>';
    }
}

async function loadMLRequestSection() {
    const container = document.getElementById('mlRequestSection');
    if (!container) return;
    const inner = container.querySelector('.ml-request-editor');
    const fields = [{ key: 'maxTopK', label: 'Max Top-K', min: 1, max: 100 }];
    try {
        const settings = await fetchSettings();
        renderMLRequestSettings(inner, settings.mlRequest || {});
        const input = inner.querySelector('#maxTopKInput');
        input.dataset.key = 'maxTopK';
        forms().register({
            id: 'mlRequest', label: 'ML Request', root: inner, noticeId: 'mlRequestNotice',
            validate: () => readWholeNumbers(inner, fields).error || '',
            save: async () => {
                await updateMLRequestSettings(readWholeNumbers(inner, fields).values);
                return 'ML request settings updated';
            }
        });
    } catch (err) {
        if (inner) inner.innerHTML = '<p class="admin-notice error">Failed to load ML request settings: ' + escapeHtml(err.message) + '</p>';
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
        renderSpamQuotas(inner, data.roleLimits || []);
        if (!inner.querySelector('.quota-input')) return;   // "No role limits configured": nothing to edit
        forms().register({
            id: 'spamQuotas', label: 'Spam Quotas', root: inner, noticeId: 'spamQuotasNotice',
            validate: () => collectQuotaChanges(inner).error || '',
            save: async () => {
                await updateRoleLimits(collectQuotaChanges(inner).rows);
                return 'Spam quotas updated';
            }
        });
    } catch (err) {
        if (inner) inner.innerHTML = '<p class="admin-notice error">Failed to load spam quotas: ' + escapeHtml(err.message) + '</p>';
    }
}

/* ------------------------------------------------------------------ */
/* Dataset Audit: model + similarity thresholds                         */
/* The ML service keeps these (the audit reads them there); this      */
/* section and the quick row on the Dataset page edit the same values. */
/* ------------------------------------------------------------------ */

const AUDIT_SETTINGS_URL = '/admin/api/dataset/audit-settings';
const AUDIT_LOW = 0.5;
const AUDIT_HIGH = 0.999;

export function renderDatasetAuditSettings(container, data) {
    const options = (data.available || []).map(e =>
        `<option value="${escapeHtml(e.kind)}">${escapeHtml(e.label)}</option>`).join('');
    const known = (data.available || []).some(e => e.kind === data.embedder);
    const defaults = data.defaults || {};
    container.innerHTML = `
        <div class="setting-row">
            <label class="setting-label" for="auditModelInput">Model that compares photos</label>
            <select class="setting-input" id="auditModelInput" data-key="embedder">
                ${options}${known ? '' : `<option value="${escapeHtml(data.embedder)}">${escapeHtml(data.embedder)}</option>`}
            </select>
        </div>
        <div class="setting-row">
            <label class="setting-label" for="auditSimilarInput">Similar from (default ${escapeHtml(defaults.cosSimilar)})</label>
            <input type="number" class="setting-input" id="auditSimilarInput" data-key="cosSimilar" min="${AUDIT_LOW}" max="${AUDIT_HIGH}" step="0.01">
        </div>
        <div class="setting-row">
            <label class="setting-label" for="auditSameInput">Same photo from (default ${escapeHtml(defaults.cosSame)})</label>
            <input type="number" class="setting-input" id="auditSameInput" data-key="cosSame" min="${AUDIT_LOW}" max="${AUDIT_HIGH}" step="0.01">
        </div>
        <p class="admin-subtitle">A trained model usually puts photos of the same plant closer together than MobileNet does, so after changing the model look at the nearest-neighbour numbers of the next audit before trusting these thresholds.</p>
    `;
    container.querySelector('#auditModelInput').value = data.embedder;
    container.querySelector('#auditSimilarInput').value = data.cosSimilar;
    container.querySelector('#auditSameInput').value = data.cosSame;
}

export function readDatasetAuditSettings(container) {
    const similar = Number(container.querySelector('#auditSimilarInput').value);
    const same = Number(container.querySelector('#auditSameInput').value);
    const blank = container.querySelector('#auditSimilarInput').value.trim() === '' || container.querySelector('#auditSameInput').value.trim() === '';
    if (blank || !Number.isFinite(similar) || !Number.isFinite(same)) return { error: 'Enter both similarity numbers.' };
    if (similar < AUDIT_LOW || similar > AUDIT_HIGH || same < AUDIT_LOW || same > AUDIT_HIGH) {
        return { error: `Similarity numbers must be between ${AUDIT_LOW} and ${AUDIT_HIGH}.` };
    }
    if (similar > same) return { error: 'Similar cannot be higher than Same photo.' };
    return { values: { embedder: container.querySelector('#auditModelInput').value, cosSimilar: similar, cosSame: same } };
}

async function loadDatasetAuditSection() {
    const container = document.getElementById('datasetAuditSection');
    if (!container) return;
    const inner = container.querySelector('.dataset-audit-editor');
    try {
        const response = await fetch(AUDIT_SETTINGS_URL, { credentials: 'include' });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'Failed to load dataset audit settings');
        renderDatasetAuditSettings(inner, data);
        forms().register({
            id: 'datasetAudit', label: 'Dataset Audit', root: inner, noticeId: 'datasetAuditNotice',
            validate: () => readDatasetAuditSettings(inner).error || '',
            save: async () => {
                const put = await fetch(AUDIT_SETTINGS_URL, {
                    method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(readDatasetAuditSettings(inner).values)
                });
                const out = await put.json().catch(() => ({}));
                if (!put.ok) throw new Error(out.error || 'Failed to save dataset audit settings');
                return 'Dataset audit settings updated. They apply from the next audit.';
            }
        });
    } catch (err) {
        if (inner) inner.innerHTML = '<p class="admin-notice error">Failed to load dataset audit settings: ' + escapeHtml(err.message) + '</p>';
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