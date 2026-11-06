/**
 * Description vote thresholds for admin-settings.html (self-contained, like admin-plant-images.js).
 *
 * Two numbers, saved through GET/POST /admin/api/description-votes/settings:
 *   downvoteHide  this many down votes hide a description from the public page (at least 2)
 *   upvoteAlert   this many up votes on a non-primary description notify the admin
 * Saving a LOWER hide number hides, right away, descriptions that already have that many down
 * votes; the server says how many. The version number makes two admins saving at once get a 409
 * instead of a silent overwrite.
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
        var response = await fetch('/admin/api/description-votes/settings', {
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

    function field(id, labelText, hint, value, limits) {
        var wrap = document.createElement('div');
        wrap.className = 'dv-field';
        var label = document.createElement('label');
        label.setAttribute('for', id);
        label.textContent = labelText;
        var input = document.createElement('input');
        input.type = 'number';
        input.id = id;
        input.min = String(limits.min);
        input.max = String(limits.max);
        input.step = '1';
        input.value = String(value);
        var small = document.createElement('small');
        small.className = 'admin-muted';
        small.textContent = hint + ' (' + limits.min + '–' + limits.max + ')';
        wrap.appendChild(label);
        wrap.appendChild(input);
        wrap.appendChild(small);
        return { wrap: wrap, input: input };
    }

    function render(data) {
        version = data.version || 0;
        host.innerHTML = '';
        host.style.display = 'grid';
        host.style.gap = '14px';
        host.style.maxWidth = '460px';

        var hide = field('dvDownvoteHide', 'Downvotes that hide a description',
            'Hidden from the public at once; the admin is notified', data.downvoteHide, data.limits.downvoteHide);
        var alert = field('dvUpvoteAlert', 'Upvotes that notify the admin',
            'On a description that is not the primary one', data.upvoteAlert, data.limits.upvoteAlert);

        var row = document.createElement('div');
        row.style.display = 'flex';
        row.style.gap = '10px';
        row.style.flexWrap = 'wrap';
        // Not a save button: Save / Cancel under the section (settings-forms.js) do that. This only
        // fills the boxes, which then count as unsaved edits like any other.
        var reset = document.createElement('button');
        reset.type = 'button';
        reset.className = 'btn';
        reset.setAttribute('data-sf-skip', '');
        reset.textContent = 'Use defaults (' + data.defaults.downvoteHide + ' / ' + data.defaults.upvoteAlert + ')';
        row.appendChild(reset);

        reset.addEventListener('click', function () {
            hide.input.value = String(data.defaults.downvoteHide);
            alert.input.value = String(data.defaults.upvoteAlert);
            hide.input.dispatchEvent(new Event('input', { bubbles: true }));
            alert.input.dispatchEvent(new Event('input', { bubbles: true }));
            note('Defaults filled in. Press Save to apply them.', false);
        });

        host.appendChild(hide.wrap);
        host.appendChild(alert.wrap);
        host.appendChild(row);

        window.SettingsForms.register({
            id: 'descriptionVotes', label: 'Description Votes', root: host, noticeId: 'descriptionVotesNotice',
            validate: function () {
                var limits = data.limits;
                var checks = [[hide.input, limits.downvoteHide, 'Downvotes that hide a description'],
                              [alert.input, limits.upvoteAlert, 'Upvotes that notify the admin']];
                for (var i = 0; i < checks.length; i += 1) {
                    var n = Number(checks[i][0].value);
                    if (checks[i][0].value.trim() === '' || !Number.isInteger(n) || n < checks[i][1].min || n > checks[i][1].max) {
                        return checks[i][2] + ' must be a whole number from ' + checks[i][1].min + ' to ' + checks[i][1].max + '.';
                    }
                }
                return '';
            },
            save: async function () {
                var saved = await request('POST', {
                    downvoteHide: hide.input.value,
                    upvoteAlert: alert.input.value,
                    version: version
                });
                version = saved.version;
                var extra = saved.hiddenNow
                    ? ' ' + saved.hiddenNow + ' description' + (saved.hiddenNow === 1 ? ' was' : 's were') + ' hidden right away.'
                    : '';
                if (typeof window.loadNavBadges === 'function') window.loadNavBadges();
                return 'Saved. ' + saved.downvoteHide + ' downvotes hide a description; ' +
                    saved.upvoteAlert + ' upvotes notify the admin.' + extra;
            }
        });
    }

    document.addEventListener('DOMContentLoaded', async function () {
        host = document.querySelector('.description-votes-editor');
        notice = document.getElementById('descriptionVotesNotice');
        if (!host) return;
        try {
            render(await request('GET'));
        } catch (err) {
            note(err.message, true);
        }
    });
})();
