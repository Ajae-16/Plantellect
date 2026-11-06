/**
 * Draft editing for admin-settings.html: nothing is saved while you type.
 *
 * Every settings section registers itself here and gets:
 *   - a Save and a Cancel button under it (enabled only while the section has unsaved edits),
 *   - an undo button beside every row you changed (puts that one row back),
 *   - a status pill in its heading ("Unsaved"),
 * and the page gets one bar at the very bottom (#sfAllBar) with "Save all" and "Cancel all",
 * which act only on the sections you actually touched.
 *
 * A section hands in the element holding its inputs and a save() function. This file never knows
 * what a setting means: it compares each control with the value it had when the section loaded
 * (or was last saved), so it works for number boxes, selects, checkboxes and table cells alike.
 *
 * Percent helpers are here too (decimalToPercent / percentToDecimal). Confidence values are
 * stored as 0..1 everywhere in the backend; only this page shows them as 0..100.
 *
 * Classic script (no import), loaded before the page's module script. Also loadable from Node
 * for tests: the pure helpers do not touch the DOM.
 */
(function (root, factory) {
    'use strict';
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.SettingsForms = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    /* ---------------------------------------------------------------- percent helpers */

    /** 0.95 -> "95", 0.925 -> "92.5". Rounded to two decimals of a percent, so no float noise (0.35 * 100 = 35.0000...1). */
    function decimalToPercent(value) {
        if (typeof value !== 'number' || !isFinite(value)) return '';
        return String(Math.round(value * 10000) / 100);
    }

    /** "95" -> 0.95, "92.5" -> 0.925. Empty or not a number -> NaN. Range is NOT checked here. */
    function percentToDecimal(text) {
        var t = String(text == null ? '' : text).trim();
        if (t === '') return NaN;
        var n = Number(t);
        if (!isFinite(n)) return NaN;
        return Math.round(n * 100) / 10000;
    }

    /* ---------------------------------------------------------------- the registry */

    var sections = [];          // { id, opts, root, ... } in the order they registered
    var allBar = null;
    var allStatusTimer = null;

    var CONTROLS = 'input:not([type="button"]):not([type="submit"]):not([type="hidden"]), select, textarea';

    function readControl(el) {
        return el.type === 'checkbox' || el.type === 'radio' ? (el.checked ? '1' : '0') : el.value;
    }

    function writeControl(el, value) {
        if (el.type === 'checkbox' || el.type === 'radio') el.checked = value === '1';
        else el.value = value;
    }

    function rowOf(el) {
        return el.closest('.setting-row, .dv-field, tr, .approval-mode-row') || el.parentElement;
    }

    function fire(el, type) {
        el.dispatchEvent(new Event(type, { bubbles: true }));
    }

    function makeUndoButton() {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sf-undo';
        btn.hidden = true;
        btn.title = 'Undo this change';
        btn.setAttribute('aria-label', 'Undo this change');
        btn.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">undo</span>';
        return btn;
    }

    function controlsOf(section) {
        return Array.prototype.filter.call(section.root.querySelectorAll(CONTROLS), function (el) {
            return !el.hasAttribute('data-sf-skip');
        });
    }

    function isControlDirty(el) {
        return readControl(el) !== el._sfInitial;
    }

    function sectionDirty(section) {
        return controlsOf(section).some(isControlDirty);
    }

    function refreshControl(el) {
        var dirty = isControlDirty(el);
        el.classList.toggle('sf-changed', dirty);
        if (el._sfUndo) el._sfUndo.hidden = !dirty;
        var row = rowOf(el);
        if (row) {
            // a row can hold several controls (a table row): it is "changed" while any of them is
            row.classList.toggle('sf-row-changed', Array.prototype.some.call(row.querySelectorAll(CONTROLS), function (c) {
                return c._sfInitial !== undefined && isControlDirty(c);
            }));
        }
    }

    function refreshSection(section) {
        controlsOf(section).forEach(refreshControl);
        var dirty = sectionDirty(section);
        if (section.saveBtn) section.saveBtn.disabled = section.busy || !dirty;
        if (section.cancelBtn) section.cancelBtn.disabled = section.busy || !dirty;
        if (section.status) section.status.hidden = !dirty;
        if (section.pill) section.pill.hidden = !dirty;
        if (typeof section.opts.onChange === 'function') section.opts.onChange(section);
        refreshAll();
    }

    function dirtySections() {
        return sections.filter(sectionDirty);
    }

    function setAllStatus(text, isError) {
        if (!allBar) return;
        var el = allBar.querySelector('.sf-all-status');
        if (!el) return;
        el.textContent = text;
        el.classList.toggle('is-error', Boolean(isError));
    }

    function refreshAll() {
        if (!allBar) return;
        var dirty = dirtySections();
        var anyBusy = sections.some(function (s) { return s.busy; });
        var save = allBar.querySelector('#sfSaveAll');
        var cancel = allBar.querySelector('#sfCancelAll');
        if (save) save.disabled = anyBusy || dirty.length === 0;
        if (cancel) cancel.disabled = anyBusy || dirty.length === 0;
        allBar.classList.toggle('has-changes', dirty.length > 0);
        if (dirty.length > 0) {
            clearTimeout(allStatusTimer);
            setAllStatus(dirty.length + (dirty.length === 1 ? ' section has' : ' sections have') +
                ' unsaved changes: ' + dirty.map(function (s) { return s.opts.label; }).join(', '), false);
        } else if (!allBar.classList.contains('has-message')) {
            setAllStatus('No unsaved changes.', false);
        }
    }

    function notify(section, message, isError) {
        var el = section.opts.noticeId ? document.getElementById(section.opts.noticeId) : null;
        if (!el) return;
        clearTimeout(section.noticeTimer);
        el.textContent = message || '';
        el.className = 'admin-notice' + (isError ? ' error' : '');
        el.hidden = !message;
        // A success message fades; an error stays until the next save or cancel.
        if (message && !isError) section.noticeTimer = setTimeout(function () { el.hidden = true; }, 6000);
    }

    /** Saves one section. Never throws: resolves { ok, skipped?, error? }. */
    async function saveSection(section) {
        if (!sectionDirty(section)) return { ok: true, skipped: true };
        if (typeof section.opts.validate === 'function') {
            var problem = section.opts.validate();
            if (problem) { notify(section, problem, true); return { ok: false, error: problem }; }
        }
        section.busy = true;
        refreshSection(section);
        try {
            var message = await section.opts.save();
            commitSection(section);
            notify(section, message || 'Saved.', false);
            return { ok: true };
        } catch (err) {
            var text = (err && err.message) || 'Save failed';
            notify(section, text, true);
            return { ok: false, error: text };
        } finally {
            section.busy = false;
            refreshSection(section);
        }
    }

    function commitSection(section) {
        controlsOf(section).forEach(function (el) { el._sfInitial = readControl(el); });
        refreshSection(section);
    }

    function discardSection(section) {
        controlsOf(section).forEach(function (el) {
            if (isControlDirty(el)) {
                writeControl(el, el._sfInitial);
                fire(el, 'input');
                fire(el, 'change');
            }
        });
        notify(section, '', false);
        refreshSection(section);
    }

    function buildBar(section) {
        var bar = document.createElement('div');
        bar.className = 'sf-bar';
        bar.innerHTML =
            '<span class="sf-bar-status" hidden>Unsaved changes</span>' +
            '<button type="button" class="btn btn-primary sf-save" disabled>Save</button>' +
            '<button type="button" class="btn sf-cancel" disabled>Cancel</button>';
        section.status = bar.querySelector('.sf-bar-status');
        section.saveBtn = bar.querySelector('.sf-save');
        section.cancelBtn = bar.querySelector('.sf-cancel');
        section.saveBtn.addEventListener('click', function () { saveSection(section); });
        section.cancelBtn.addEventListener('click', function () { discardSection(section); });
        return bar;
    }

    /**
     * Registers a section. opts:
     *   id         unique; registering the same id again replaces the old section (a re-render)
     *   label      shown in the "unsaved" summary
     *   root       element that holds the section's inputs
     *   body       element the Save / Cancel bar is added to (default: root's .collapse-body, else root's parent)
     *   noticeId   id of the <p class="admin-notice"> for this section
     *   save()     async; saves the section; resolves a message to show, or throws
     *   validate() optional; returns an error string to block the save, or ''
     *   onChange(section) optional; called after every edit
     * Returns { commit, discard, save, isDirty, refresh, element }.
     */
    function register(opts) {
        var existing = sections.findIndex(function (s) { return s.id === opts.id; });
        if (existing >= 0) unregisterAt(existing);

        var section = { id: opts.id, opts: opts, root: opts.root, busy: false };
        sections.push(section);

        var body = opts.body || opts.root.closest('.collapse-body') || opts.root.parentElement;
        var noticeEl = opts.noticeId ? document.getElementById(opts.noticeId) : null;
        section.bar = buildBar(section);
        if (noticeEl && noticeEl.parentElement === body) body.insertBefore(section.bar, noticeEl);
        else body.appendChild(section.bar);

        var heading = body.closest('.admin-section') && body.closest('.admin-section').querySelector('summary h2');
        if (heading) {
            section.pill = document.createElement('span');
            section.pill.className = 'sf-pill';
            section.pill.textContent = 'Unsaved';
            section.pill.hidden = true;
            heading.appendChild(section.pill);
        }

        // Remember what every control holds now, and give each one its own undo button.
        controlsOf(section).forEach(function (el) {
            el._sfInitial = readControl(el);
            var undo = makeUndoButton();
            el._sfUndo = undo;
            var anchor = el.closest('label.switch') || el;
            anchor.insertAdjacentElement('afterend', undo);
            undo.addEventListener('click', function (event) {
                event.preventDefault();
                event.stopPropagation();
                writeControl(el, el._sfInitial);
                fire(el, 'input');
                fire(el, 'change');
            });
        });

        function onEdit(event) {
            if (event.target && event.target.matches && event.target.matches(CONTROLS)) refreshSection(section);
        }
        section.listener = onEdit;
        section.root.addEventListener('input', onEdit);
        section.root.addEventListener('change', onEdit);

        refreshSection(section);
        return {
            commit: function () { commitSection(section); },
            discard: function () { discardSection(section); },
            save: function () { return saveSection(section); },
            isDirty: function () { return sectionDirty(section); },
            refresh: function () { refreshSection(section); },
            element: section.bar
        };
    }

    function unregisterAt(index) {
        var old = sections[index];
        sections.splice(index, 1);
        if (old.bar && old.bar.parentNode) old.bar.parentNode.removeChild(old.bar);
        if (old.pill && old.pill.parentNode) old.pill.parentNode.removeChild(old.pill);
        if (old.root && old.listener) {
            old.root.removeEventListener('input', old.listener);
            old.root.removeEventListener('change', old.listener);
        }
    }

    /** Is any section holding unsaved edits? */
    function hasUnsaved() {
        return dirtySections().length > 0;
    }

    /* ---------------------------------------------------------------- the bottom bar */

    async function saveAll() {
        var targets = dirtySections();
        if (targets.length === 0) return;
        allBar.classList.add('has-message');
        setAllStatus('Saving ' + targets.length + (targets.length === 1 ? ' section' : ' sections') + '...', false);
        var saved = [];
        var failed = [];
        for (var i = 0; i < targets.length; i += 1) {
            var result = await saveSection(targets[i]);
            (result.ok ? saved : failed).push(targets[i].opts.label);
        }
        allBar.classList.remove('has-message');
        if (failed.length === 0) {
            allBar.classList.add('has-message');
            setAllStatus('Saved: ' + saved.join(', ') + '.', false);
            clearTimeout(allStatusTimer);
            allStatusTimer = setTimeout(function () { allBar.classList.remove('has-message'); refreshAll(); }, 6000);
        } else {
            refreshAll();
            var summary = (saved.length ? 'Saved: ' + saved.join(', ') + '. ' : '') +
                'Not saved: ' + failed.join(', ') + ' (see the message under each section).';
            allBar.classList.add('has-message');
            setAllStatus(summary, true);
        }
    }

    function cancelAll() {
        var targets = dirtySections();
        if (targets.length === 0) return;
        var names = targets.map(function (s) { return s.opts.label; }).join(', ');
        if (!window.confirm('Discard unsaved changes in: ' + names + '?')) return;
        targets.forEach(discardSection);
        allBar.classList.remove('has-message');
        refreshAll();
    }

    function initAllBar() {
        if (typeof document === 'undefined') return;
        allBar = document.getElementById('sfAllBar');
        if (!allBar) return;
        var save = allBar.querySelector('#sfSaveAll');
        var cancel = allBar.querySelector('#sfCancelAll');
        if (save) save.addEventListener('click', saveAll);
        if (cancel) cancel.addEventListener('click', cancelAll);
        refreshAll();
    }

    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initAllBar);
        else initAllBar();
        window.addEventListener('beforeunload', function (event) {
            if (!hasUnsaved()) return;
            event.preventDefault();
            event.returnValue = '';
        });
    }

    return {
        decimalToPercent: decimalToPercent,
        percentToDecimal: percentToDecimal,
        register: register,
        hasUnsaved: hasUnsaved,
        saveAll: saveAll,
        cancelAll: cancelAll
    };
});
