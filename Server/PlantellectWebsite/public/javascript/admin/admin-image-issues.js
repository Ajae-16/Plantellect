/**
 * "Image file problems" on admin-plants.html.
 *
 * A photo is COPIED into the folder its review status belongs in (pending,
 * approved or denied), the copy is checked, and only then is the old file
 * deleted. If a copy still fails the check after the retry limit, the photo is
 * left where it was and listed here so an admin knows. The photo keeps working
 * meanwhile; Retry runs the same copy-and-check again.
 *
 * SELF-INITIALISING, like admin-discoveries.js: no page calls it and no load
 * order is assumed. window.refreshImageIssues() reloads the list (the plant
 * request approve/deny handler calls it, because that is when a problem appears).
 * Everything is built with textContent, never innerHTML: the messages come from
 * the server's file checks and must never be treated as markup.
 */
(function () {
    'use strict';

    var section = null;
    var list = null;
    var countBadge = null;
    var intro = null;
    var notice = null;
    var maxAttempts = 5;

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }

    function say(text, isError) {
        if (!notice) return;
        notice.hidden = !text;
        notice.textContent = text || '';
        notice.className = 'admin-notice' + (isError ? ' error' : '');
    }

    function describe(issue) {
        var what = issue.kind === 'discovery' ? 'Discovery report photo' : 'Plant photo';
        var where = issue.kind === 'discovery'
            ? 'report ' + issue.requestId
            : (issue.plantName ? issue.plantName + ' (' + issue.plantId + ')' : 'not yet linked to a plant');
        var status = issue.status === 'rejected' || issue.status === 'denied' ? 'denied' : issue.status;
        return what + ' ' + issue.imageId + ' · ' + where + ' · ' + status;
    }

    async function retry(issue, button) {
        button.disabled = true;
        say('', false);
        try {
            var response = await fetch(
                '/admin/api/image-issues/' + encodeURIComponent(issue.kind) + '/' + encodeURIComponent(issue.imageId) + '/retry',
                { method: 'POST', credentials: 'include' }
            );
            var body = await response.json().catch(function () { return {}; });
            if (!response.ok) throw new Error(body.error || 'Retry failed');
            say(body.message, body.ok === false);
            await load();
        } catch (err) {
            say(err.message, true);
            button.disabled = false;
        }
    }

    function render(issues) {
        list.textContent = '';
        section.hidden = issues.length === 0;
        countBadge.hidden = issues.length === 0;
        countBadge.textContent = String(issues.length);
        if (issues.length === 0) return;

        intro.textContent =
            'These photos could not be copied cleanly into their folder after ' + maxAttempts +
            ' attempts. Each one is still where it was and still displays; nothing was deleted.';

        issues.forEach(function (issue) {
            var row = el('div', 'image-issue-row');
            row.appendChild(el('strong', null, describe(issue)));
            row.appendChild(el('p', 'admin-subtitle', issue.message));
            var button = el('button', 'btn', 'Retry');
            button.type = 'button';
            button.addEventListener('click', function () { retry(issue, button); });
            row.appendChild(button);
            list.appendChild(row);
        });
    }

    async function load() {
        try {
            var response = await fetch('/admin/api/image-issues', { credentials: 'include' });
            if (!response.ok) return;   // not an admin, or the server is busy: stay hidden
            var data = await response.json();
            maxAttempts = data.maxAttempts || maxAttempts;
            render(data.issues || []);
        } catch (err) {
            console.error('Could not load image file problems:', err.message);
        }
    }

    window.refreshImageIssues = load;

    document.addEventListener('DOMContentLoaded', function () {
        section = document.getElementById('imageIssuesSection');
        list = document.getElementById('imageIssuesList');
        countBadge = document.getElementById('imageIssuesCount');
        intro = document.getElementById('imageIssuesIntro');
        notice = document.getElementById('imageIssuesNotice');
        if (!section || !list || !countBadge || !intro) return;
        load();
        window.addEventListener('focus', load);
    });
})();
