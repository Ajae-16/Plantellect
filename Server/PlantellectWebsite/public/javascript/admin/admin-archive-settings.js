/**
 * Archive retention for admin-settings.html (self-contained, like admin-description-vote-settings.js).
 *
 * One number, saved through GET/POST /admin/api/archive/settings: how many days a DELETED plant, photo or
 * description is kept before the nightly job removes it for good. Save / Cancel under the section come from
 * settings-forms.js; the version number makes two admins saving at once get a 409, not a silent overwrite.
 */
(function () {
    'use strict';

    var host = null;
    var notice = null;
    var version = 0;

    function note(text, isError) {
        if (!notice) return;
        notice.hidden = !text;
        notice.textContent = text || '';
        notice.className = 'admin-notice' + (isError ? ' error' : '');
    }

    async function request(method, body) {
        var response = await fetch('/admin/api/archive/settings', {
            method: method,
            credentials: 'include',
            headers: body ? { 'Content-Type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined
        });
        var data = await response.json().catch(function () { return {}; });
        if (!response.ok) {
            if (response.status === 401 || response.status === 403) {
                throw new Error('You need the admin settings permission to change this.');
            }
            throw new Error(data.error || 'Request failed');
        }
        return data;
    }

    function render(data) {
        version = data.version || 0;
        var limits = data.limits.retentionDays;
        host.innerHTML = '';
        host.style.display = 'grid';
        host.style.gap = '14px';
        host.style.maxWidth = '460px';

        var wrap = document.createElement('div');
        wrap.className = 'dv-field';
        var label = document.createElement('label');
        label.setAttribute('for', 'archiveRetentionDays');
        label.textContent = 'Days a deleted item is kept';
        var input = document.createElement('input');
        input.type = 'number';
        input.id = 'archiveRetentionDays';
        input.min = String(limits.min);
        input.max = String(limits.max);
        input.step = '1';
        input.value = String(data.retentionDays);
        var small = document.createElement('small');
        small.className = 'admin-muted';
        small.textContent = 'Counted from the day it was deleted (' + limits.min + '\u2013' + limits.max + '). Changing it applies to items already waiting.';
        wrap.appendChild(label);
        wrap.appendChild(input);
        wrap.appendChild(small);

        var reset = document.createElement('button');
        reset.type = 'button';
        reset.className = 'btn';
        reset.setAttribute('data-sf-skip', '');
        reset.textContent = 'Use default (' + data.defaults.retentionDays + ' days)';
        reset.addEventListener('click', function () {
            input.value = String(data.defaults.retentionDays);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            note('Default filled in. Press Save to apply it.', false);
        });

        host.appendChild(wrap);
        host.appendChild(reset);

        window.SettingsForms.register({
            id: 'archiveRetention', label: 'Archive & Deletion', root: host, noticeId: 'archiveRetentionNotice',
            validate: function () {
                var n = Number(input.value);
                if (input.value.trim() === '' || !Number.isInteger(n) || n < limits.min || n > limits.max) {
                    return 'Days a deleted item is kept must be a whole number from ' + limits.min + ' to ' + limits.max + '.';
                }
                return '';
            },
            save: async function () {
                var saved = await request('POST', { retentionDays: input.value, version: version });
                version = saved.version;
                return 'Saved. Deleted items are removed for good after ' + saved.retentionDays + ' day' + (saved.retentionDays === 1 ? '' : 's') + '.';
            }
        });
    }

    document.addEventListener('DOMContentLoaded', async function () {
        host = document.querySelector('.archive-retention-editor');
        notice = document.getElementById('archiveRetentionNotice');
        if (!host) return;
        try {
            render(await request('GET'));
        } catch (err) {
            note(err.message, true);
        }
    });
})();
