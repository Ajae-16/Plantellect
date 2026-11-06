/**
 * Plant photo limit editor for admin-settings.html.
 *
 * One number: how many photos a single contributor submission may carry. It is the
 * system_settings key `plantImages`, saved through the same optimistic-locking
 * endpoint as every other setting (POST /admin/api/settings), so two admins
 * saving at once get a 409 instead of a silent overwrite. The server clamps it to
 * 1..hardMaxFilesPerRequest and re-reads it on every upload.
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

    async function load() {
        var response = await fetch('/admin/api/settings', { credentials: 'include' });
        if (!response.ok) throw new Error('Could not load the photo limit');
        var data = await response.json();
        version = data.plantImagesVersion || 0;
        var cfg = data.plantImages || {};
        return { maxFiles: cfg.maxFilesPerRequest || 20, perPage: cfg.adminPhotosPerPage || 12 };
    }

    function render(current) {
        var PER_PAGE_MAX = 50;
        host.innerHTML = '';
        var row = document.createElement('div');
        row.className = 'setting-row';
        var label = document.createElement('label');
        label.className = 'setting-label';
        label.setAttribute('for', 'plantImagesMax');
        label.textContent = 'Photos per submission';
        var input = document.createElement('input');
        input.type = 'number';
        input.id = 'plantImagesMax';
        input.className = 'setting-input';
        input.min = '1';
        input.max = '100';
        input.step = '1';
        input.value = String(current.maxFiles);
        row.appendChild(label);
        row.appendChild(input);
        host.appendChild(row);

        // How many photos the admin plant editor fetches per page (its pagination), so opening a plant
        // with many photos never loads them all at once.
        var pageRow = document.createElement('div');
        pageRow.className = 'setting-row';
        var pageLabel = document.createElement('label');
        pageLabel.className = 'setting-label';
        pageLabel.setAttribute('for', 'plantImagesPerPage');
        pageLabel.textContent = 'Photos per page in the plant editor';
        var pageInput = document.createElement('input');
        pageInput.type = 'number';
        pageInput.id = 'plantImagesPerPage';
        pageInput.className = 'setting-input';
        pageInput.min = '1';
        pageInput.max = String(PER_PAGE_MAX);
        pageInput.step = '1';
        pageInput.value = String(current.perPage);
        pageRow.appendChild(pageLabel);
        pageRow.appendChild(pageInput);
        host.appendChild(pageRow);

        // Save / Cancel come from settings-forms.js; nothing is sent while you type.
        window.SettingsForms.register({
            id: 'plantImages', label: 'Plant Photos', root: host, noticeId: 'plantImagesNotice',
            validate: function () {
                var value = Number(input.value);
                if (!(input.value.trim() !== '' && Number.isInteger(value) && value >= 1 && value <= 100)) {
                    return 'Photos per submission must be a whole number from 1 to 100.';
                }
                var perPage = Number(pageInput.value);
                if (!(pageInput.value.trim() !== '' && Number.isInteger(perPage) && perPage >= 1 && perPage <= PER_PAGE_MAX)) {
                    return 'Photos per page must be a whole number from 1 to ' + PER_PAGE_MAX + '.';
                }
                return '';
            },
            save: async function () {
                var value = Number(input.value);
                var response = await fetch('/admin/api/settings', {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ plantImages: { maxFilesPerRequest: value, adminPhotosPerPage: Number(pageInput.value) } })
                });
                var body = await response.json().catch(function () { return {}; });
                if (!response.ok) throw new Error(body.error || 'Save failed');
                version = body.plantImages ? body.plantImages.version : version;
                return 'Saved. Contributors can attach up to ' + value + ' photos per submission; the plant editor loads ' + Number(pageInput.value) + ' photos per page.';
            }
        });
    }

    document.addEventListener('DOMContentLoaded', async function () {
        host = document.querySelector('.plant-images-editor');
        notice = document.getElementById('plantImagesNotice');
        if (!host) return;
        try {
            render(await load());
        } catch (err) {
            note(err.message, true);
        }
    });
})();
