/**
 * Plant photo limit editor for admin-settings.html.
 *
 * One number: how many photos a single botanist submission may carry. It is the
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
        return (data.plantImages && data.plantImages.maxFilesPerRequest) || 20;
    }

    function render(current) {
        host.innerHTML = '';
        var label = document.createElement('label');
        label.setAttribute('for', 'plantImagesMax');
        label.textContent = 'Photos per submission';
        var input = document.createElement('input');
        input.type = 'number';
        input.id = 'plantImagesMax';
        input.min = '1';
        input.max = '100';
        input.step = '1';
        input.value = String(current);
        var save = document.createElement('button');
        save.type = 'button';
        save.className = 'btn';
        save.textContent = 'Save';
        save.addEventListener('click', async function () {
            var value = Number(input.value);
            if (!Number.isInteger(value) || value < 1 || value > 100) {
                note('Enter a whole number from 1 to 100.', true);
                return;
            }
            save.disabled = true;
            try {
                var response = await fetch('/admin/api/settings', {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ plantImages: { maxFilesPerRequest: value } })
                });
                var body = await response.json().catch(function () { return {}; });
                if (!response.ok) throw new Error(body.error || 'Save failed');
                version = body.plantImages ? body.plantImages.version : version;
                note('Saved. Botanists can attach up to ' + value + ' photos per submission.', false);
            } catch (err) {
                note(err.message, true);
            } finally {
                save.disabled = false;
            }
        });
        host.appendChild(label);
        host.appendChild(input);
        host.appendChild(save);
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
