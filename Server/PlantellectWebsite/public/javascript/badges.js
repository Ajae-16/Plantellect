/* Shared badge helpers: the plant type badge and the role chip.
 *
 * ONE badge per plant. Its text is the plant's own type name and its colour is
 * its toxicity level: green = none, yellow = mild, orange = moderate, red = severe.
 * A plant can no longer be "herbal AND hazard" as two competing badges; it is one
 * badge whose colour says how safe it is.
 *
 * Colours live in css/core/variables.css (--badge-*-bg / -fg) and the rules in
 * css/core/badges.css. This file only builds the markup, so a page needs:
 *     <script src="javascript/badges.js"></script>
 * and uses  PlantBadge.html(typeName, toxicityLevel)  /  RoleBadge.html(roleName).
 */
(function (global) {
    'use strict';

    /* =====================  EDIT HERE  =========================================
     * Icons are a plain glyph today. The team plans to move to Google Material
     * Symbols: load the font on the page, then set USE_MATERIAL_SYMBOLS to true.
     * `symbol` is the Material Symbols name that will be used then.
     * ======================================================================== */
    var USE_MATERIAL_SYMBOLS = false;

    var PLANT_BADGE_LEVELS = {
        none:     { title: 'No known toxicity', symbol: 'check_circle', glyph: '\u2713' },
        mild:     { title: 'Mild toxicity',     symbol: 'info',         glyph: '!' },
        moderate: { title: 'Moderate toxicity', symbol: 'warning',      glyph: '\u26A0' },
        severe:   { title: 'Severe toxicity',   symbol: 'dangerous',    glyph: '\u2620' }
    };

    // Same rules as the public profile: a botanist is certificate-verified.
    var ROLE_BADGES = {
        botanist:   { label: 'Verified botanist', modifier: 'verified', symbol: 'verified',  glyph: '\u2713' },
        admin:      { label: 'Admin',             modifier: 'admin',    symbol: 'shield',    glyph: '' },
        superadmin: { label: 'Admin',             modifier: 'admin',    symbol: 'shield',    glyph: '' },
        user:       { label: 'User',              modifier: 'user',     symbol: 'person',    glyph: '' }
    };
    /* ======================================================================== */

    function esc(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function icon(cfg, className) {
        if (USE_MATERIAL_SYMBOLS && cfg.symbol) {
            return '<span class="material-symbols-outlined" aria-hidden="true">' + esc(cfg.symbol) + '</span>';
        }
        return cfg.glyph ? '<span class="' + className + '" aria-hidden="true">' + esc(cfg.glyph) + '</span>' : '';
    }

    /** One badge for one plant. An unknown or missing level reads as "none". */
    function plantBadge(typeName, toxicityLevel) {
        var level = PLANT_BADGE_LEVELS[toxicityLevel] ? toxicityLevel : 'none';
        var cfg = PLANT_BADGE_LEVELS[level];
        var name = String(typeName || '').trim() || 'Unspecified';
        return '<span class="type-badge type-badge--' + level + '" title="' + esc(name + ' \u00B7 ' + cfg.title) + '">' +
            icon(cfg, 'type-badge__icon') +
            '<span class="type-badge__name">' + esc(name) + '</span>' +
            '<span class="type-badge__sr"> \u2014 ' + esc(cfg.title) + '</span>' +
        '</span>';
    }

    /** Who submitted something: Verified botanist / Admin / User. Empty when the role is unknown. */
    function roleBadge(roleName) {
        var cfg = ROLE_BADGES[String(roleName || '').toLowerCase()];
        if (!cfg) return '';
        return '<span class="role-chip role-chip--' + cfg.modifier + '">' + icon(cfg, 'role-chip__icon') + esc(cfg.label) + '</span>';
    }

    global.PlantBadge = { html: plantBadge, LEVELS: PLANT_BADGE_LEVELS };
    global.RoleBadge = { html: roleBadge, ROLES: ROLE_BADGES };
})(window);
