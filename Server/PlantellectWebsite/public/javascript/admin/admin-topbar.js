/* =========================================================
   admin-topbar.js
   Shared by the Dashboard, Plants and Settings pages (the Users
   page has only a plain link, so it needs the CSS but not this).

   Load it at the END of <body>, after the page markup:
     <script src="/javascript/admin/admin-topbar.js"></script>

   What it does for <nav class="admin-topbar">:
     - Highlights the tab of the section you are reading while you scroll.
       A sliding reference line lets even short or collapsed sections
       get their turn.
     - Clicking a tab scrolls to its section. If the section contains a
       <details class="collapse">, that is opened first.
     - Opening the page with #sectionId jumps to that section.

   Only tabs with href="#..." AND a data-target are in-page tabs.
   Anything else (a normal link to another page) is left alone.
   Tabs are looked up on every event, so tabs a page adds later work too.

   Hooks for page scripts:
     topbar.addEventListener('admintopbar:navigate', function (e) {
         // e.detail.target is the section id about to be scrolled to.
         // Use it to expand something custom first.
     });
     AdminTopbar.refresh();        // re-check after the layout changed
     AdminTopbar.goTo('sectionId');
   ========================================================= */
(function () {
    'use strict';

    var topbar = null;
    var currentId = null;
    var manualTarget = null;   // set by a tab click so scroll tracking does not fight the smooth scroll
    var ticking = false;

    /* ---------- helpers ---------- */

    function inPageTabs() {
        return Array.prototype.slice.call(topbar.querySelectorAll('.admin-tab[data-target]'))
            .filter(function (tab) {
                var href = tab.getAttribute('href') || '';
                return href.charAt(0) === '#';
            });
    }

    function sectionOf(tab) {
        return document.getElementById(tab.dataset.target);
    }

    // The element that actually scrolls: a scrollable ancestor if there is one, otherwise the page
    function getScroller() {
        var node = topbar.parentElement;
        while (node && node !== document.body) {
            var overflowY = getComputedStyle(node).overflowY;
            if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
                return node;
            }
            node = node.parentElement;
        }
        return document.scrollingElement || document.documentElement;
    }

    // Gives each target the scroll-margin that keeps its heading clear of the sticky bar
    function markTargets() {
        inPageTabs().forEach(function (tab) {
            var section = sectionOf(tab);
            if (section) section.classList.add('topbar-target');
        });
    }

    /* ---------- highlighting ---------- */

    function setActive(targetId) {
        var tabs = inPageTabs();
        tabs.forEach(function (t) {
            var on = t.dataset.target === targetId;
            t.classList.toggle('active', on);
            if (on) t.setAttribute('aria-current', 'true');
            else t.removeAttribute('aria-current');
        });

        if (targetId === currentId) return;
        currentId = targetId;

        // Keep the active tab visible when the topbar itself scrolls sideways (phones)
        var active = tabs.filter(function (t) { return t.dataset.target === targetId; })[0];
        if (active && topbar.scrollWidth > topbar.clientWidth) {
            topbar.scrollTo({
                left: active.offsetLeft - (topbar.clientWidth - active.offsetWidth) / 2,
                behavior: 'smooth'
            });
        }
    }

    // Sliding reference line:
    //   scrolled to the top    -> line sits just below the topbar
    //   scrolled to the bottom -> line sits at the bottom edge of the viewport
    //   in between             -> linear blend
    // The active section is the one whose top edge is closest above the line.
    // When two sections share a top edge (side by side on wide screens) the
    // first one in tab order wins the tie.
    function updateFromScroll() {
        ticking = false;
        if (manualTarget) return;

        var sections = inPageTabs().map(sectionOf).filter(Boolean);
        if (sections.length === 0) return;

        var scroller = getScroller();
        var maxScroll = scroller.scrollHeight - scroller.clientHeight;
        if (maxScroll <= 2) return; // nothing to scroll: keep whatever is highlighted

        var progress = Math.min(1, Math.max(0, scroller.scrollTop / maxScroll));
        var topLine = topbar.getBoundingClientRect().bottom + 16;
        var bottomLine = window.innerHeight - 4;
        var line = topLine + progress * (bottomLine - topLine);

        var current = sections[0].id;
        var bestTop = -Infinity;
        sections.forEach(function (section) {
            var top = section.getBoundingClientRect().top;
            if (top <= line && top > bestTop) {
                bestTop = top;
                current = section.id;
            }
        });

        setActive(current);
    }

    function onScroll() {
        if (ticking) return;
        ticking = true;
        window.requestAnimationFrame(updateFromScroll);
    }

    /* ---------- navigation ---------- */

    function goTo(targetId, opts) {
        var smooth = !opts || opts.smooth !== false;
        var updateHash = !opts || opts.updateHash !== false;
        var section = document.getElementById(targetId);
        if (!section) return;

        // Collapsible sections open themselves before we scroll to them
        var details = section.querySelector('details.collapse');
        if (details) details.open = true;

        // Page-specific expanding (e.g. the Dashboard's access card)
        topbar.dispatchEvent(new CustomEvent('admintopbar:navigate', {
            bubbles: true,
            detail: { target: targetId }
        }));

        manualTarget = targetId;
        setActive(targetId);
        if (updateHash) history.replaceState(null, '', '#' + targetId);

        window.requestAnimationFrame(function () {
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

    /* ---------- wiring ---------- */

    function init() {
        topbar = document.querySelector('.admin-topbar');
        if (!topbar) return;

        markTargets();

        topbar.addEventListener('click', function (e) {
            var tab = e.target.closest('.admin-tab[data-target]');
            if (!tab || (tab.getAttribute('href') || '').charAt(0) !== '#') return;
            e.preventDefault();
            markTargets();
            goTo(tab.dataset.target);
        });

        window.addEventListener('wheel', releaseManual, { passive: true });
        window.addEventListener('touchmove', releaseManual, { passive: true });
        window.addEventListener('keydown', function (e) {
            if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].indexOf(e.key) !== -1) {
                releaseManual();
            }
        });

        window.addEventListener('hashchange', function () {
            var id = location.hash.slice(1);
            var known = inPageTabs().some(function (t) { return t.dataset.target === id; });
            if (known) goTo(id, { updateHash: false });
        });

        // capture:true catches scrolling of any element, so it works whether the page or a panel scrolls
        document.addEventListener('scroll', onScroll, { passive: true, capture: true });
        window.addEventListener('resize', onScroll);
        // Opening or closing a collapsible section changes the page height, so re-check
        // (the toggle event does not bubble, hence capture)
        document.addEventListener('toggle', onScroll, true);

        // Opening the page with a #hash (e.g. /admin/plants#discoveryQueue) jumps to that section
        function onLoad() {
            var initial = location.hash.slice(1);
            var known = inPageTabs().some(function (t) { return t.dataset.target === initial; });
            if (known) goTo(initial, { smooth: false, updateHash: false });
            else updateFromScroll();
        }
        if (document.readyState === 'complete') onLoad();
        else window.addEventListener('load', onLoad);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.AdminTopbar = {
        refresh: onScroll,
        goTo: function (id) { if (topbar) goTo(id); }
    };
})();