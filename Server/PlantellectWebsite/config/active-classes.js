// The class list of the ACTIVE ML model (ml/model/<modelId>/classes.json), species only.
//
// Shared by the admin coverage route and the dataset snapshot builder, so both agree on which
// species the model supports. Returns null when the file is missing or unreadable: callers must treat
// null as "cannot tell", never as "no species are supported".

const fs = require('fs');
const path = require('path');
const settings = require('./settings');

/** The id of the active model: the mlActiveModel setting, else the configured default. */
async function activeModelId(getSystemSetting) {
    let modelId = '';
    try {
        let value = await getSystemSetting('mlActiveModel');
        if (typeof value === 'string') {
            try { value = JSON.parse(value); } catch (_) { /* bare id */ }
        }
        modelId = typeof value === 'string' ? value : (value && value.modelId) || '';
    } catch (err) {
        console.error('mlActiveModel read failed:', err.message);
    }
    return path.basename(modelId || settings.ml.defaultModel || 'efficientnetv2b1');
}

/**
 * The classes.json every dataset feature reads. SPECIES_CLASSES_PATH (settings.speciesPromotion.classesPath)
 * overrides it when set; otherwise it is the active model's file. One function, so the promotion page, the
 * coverage route and the database snapshot can never look at different files.
 */
async function resolveClassesPath(getSystemSetting) {
    if (settings.speciesPromotion && settings.speciesPromotion.classesPath) return settings.speciesPromotion.classesPath;
    // Loaded only now, so an override (or a test) never needs the database module.
    const modelId = await activeModelId(getSystemSetting || require('./setting-mysql').getSystemSetting);
    return path.join(__dirname, '..', 'ml', 'model', modelId, 'classes.json');
}

/** [{ scientific, common, ... }] for the active model's species, or null. */
async function loadActiveClasses(getSystemSetting) {
    const classesPath = await resolveClassesPath(getSystemSetting);
    try {
        if (!fs.existsSync(classesPath)) return null;
        const parsed = JSON.parse(fs.readFileSync(classesPath, 'utf8'));
        const values = Array.isArray(parsed) ? parsed : Object.values(parsed);
        return values
            .map((v) => (typeof v === 'string' ? { scientific: v, common: v } : v))
            .filter((v) => v && v.scientific && (v.kind || 'species') === 'species');
    } catch (err) {
        console.error('Could not read classes.json:', err.message);
        return null;
    }
}

module.exports = { loadActiveClasses, activeModelId, resolveClassesPath };
