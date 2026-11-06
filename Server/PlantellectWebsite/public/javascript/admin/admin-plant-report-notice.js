/**
 * Dashboard notification for plant reports (community votes on plant descriptions).
 *
 * View only: it reads GET /admin/api/description-feedback/count and links to the real work
 * surface, the "Plant reports" section on the Plants page (before the discovery reports).
 * Nothing here can change a description.
 *
 * Self-initialising; returns at once when #plantReportNotice is absent.
 */
(function () {
    'use strict';

    var LINK = '/admin/plants#plantReportQueue';

    function esc(value) {
        var div = document.createElement('div');
        div.textContent = String(value == null ? '' : value);
        return div.innerHTML;
    }

    function chip(cls, icon, text) {
        return '<span class="fb-flag ' + cls + '"><span class="material-symbols-outlined">' + icon + '</span>' + esc(text) + '</span>';
    }

    function render(box, data) {
        var total = data.total || 0;
        var badge = document.getElementById('plantReportCount');
        if (badge) {
            badge.hidden = !(total > 0);
            badge.textContent = total > 99 ? '99+' : String(total);
        }
        box.classList.toggle('is-clear', total === 0);

        if (total === 0) {
            box.innerHTML = '<p class="rn-line">No plant reports need attention.</p>' +
                '<a class="rn-link" href="' + LINK + '"><span class="material-symbols-outlined">flag</span>Open plant reports</a>';
            return;
        }

        var chips = [];
        if (data.hidden) chips.push(chip('is-hidden', 'visibility_off', data.hidden + ' hidden by downvotes'));
        if (data.downvoted) chips.push(chip('is-down', 'thumb_down', data.downvoted + ' with downvotes'));
        if (data.popular) chips.push(chip('is-up', 'thumb_up', data.popular + ' popular, consider as primary'));

        box.innerHTML =
            '<p class="rn-line">' + total + ' plant report' + (total === 1 ? '' : 's') + ' need' + (total === 1 ? 's' : '') + ' your attention.</p>' +
            '<div class="rn-chips">' + chips.join('') + '</div>' +
            '<a class="rn-link" href="' + LINK + '"><span class="material-symbols-outlined">flag</span>Review plant reports</a>';
    }

    async function init() {
        var box = document.getElementById('plantReportNotice');
        if (!box) return;
        try {
            var res = await fetch('/admin/api/description-feedback/count', { credentials: 'include' });
            if (!res.ok) throw new Error('count failed');
            var data = await res.json();
            render(box, data);
            // Same number feeds the sidebar badge and the hamburger dot.
            if (typeof window.loadNavBadges === 'function') window.loadNavBadges({ feedback: data.total || 0 });
        } catch (err) {
            console.error('Plant report notice failed:', err);
            box.innerHTML = '<p class="rn-line">Plant reports could not be checked.</p>';
        }
    }

    init();
})();
