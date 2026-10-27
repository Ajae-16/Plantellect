/**
 * Shared rich text for botanist descriptions (uses, benefits, things to watch out for).
 *
 * The database stores plain TEXT. This file turns that text into safe HTML, and helps a
 * botanist write it. Rules live in css/core/richtext.css. A page needs:
 *     <script src="javascript/richtext.js"></script>
 * then   RichText.render(el, text)      show formatted text in an element
 *        RichText.html(text)            the same as an HTML string
 *        RichText.plain(text)           the text with the marks removed (for short snippets)
 *        RichText.attach(textarea)      add the toolbar, hint and live preview to a textarea
 *        RichText.openGuide()           the "how to format" dialog
 *        RichText.contributorClass(i)   contrib-box--cN, cycling through 8 colours
 *
 * What a botanist can type (the same list is shown by openGuide):
 *   Enter                new line (kept in the database)
 *   \n   (backslash n)   next paragraph
 *   a blank line         next paragraph
 *   *- item              bullet list         1. item   numbered list
 *   **bold**   *italic*   __underline__   ~~strike~~
 *   ==highlight==        yellow marker
 *   !!important!!        red emphasis
 *
 * Safety: the text is HTML-escaped FIRST, then the marks are turned into a fixed set of
 * tags. Nothing a botanist types can become a script, link or attribute.
 */
(function (global) {
    'use strict';

    function esc(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    /** Line breaks as the browser or database gives them, with "\n" typed out as a paragraph break. */
    function normalize(text) {
        return String(text == null ? '' : text)
            .replace(/\r\n?/g, '\n')
            .replace(/\\n/g, '\n\n');
    }

    /** Inline marks on ALREADY ESCAPED text. Order matters: ** before *. */
    function inline(escaped) {
        return escaped
            .replace(/\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/g, '<strong>$1</strong>')
            .replace(/__(?=\S)([\s\S]+?)(?<=\S)__/g, '<u>$1</u>')
            .replace(/~~(?=\S)([\s\S]+?)(?<=\S)~~/g, '<s>$1</s>')
            .replace(/==(?=\S)([\s\S]+?)(?<=\S)==/g, '<mark>$1</mark>')
            .replace(/!!(?=\S)([\s\S]+?)(?<=\S)!!/g, '<span class="rt-important">$1</span>')
            .replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?!\*)/g, '$1<em>$2</em>');
    }

    // A bullet is "*- " (or a pasted "• "). A lone "-" is NOT a bullet, so "well-known" and "a - b" stay as typed.
    var BULLET = /^\s*(?:\*-|•)\s+/;
    var NUMBER = /^\s*\d+[.)]\s+/;

    /** Text -> block HTML (<p>, <ul>, <ol>). Empty input gives ''. */
    function html(text) {
        var source = normalize(text).trim();
        if (!source) return '';
        var out = [];
        source.split(/\n{2,}/).forEach(function (block) {
            var lines = block.split('\n');
            var i = 0;
            while (i < lines.length) {
                var line = lines[i];
                if (!line.trim()) { i++; continue; }
                var kind = BULLET.test(line) ? 'ul' : NUMBER.test(line) ? 'ol' : null;
                if (kind) {
                    var marker = kind === 'ul' ? BULLET : NUMBER;
                    var items = [];
                    while (i < lines.length && marker.test(lines[i])) {
                        items.push('<li>' + inline(esc(lines[i].replace(marker, '').trim())) + '</li>');
                        i++;
                    }
                    out.push('<' + kind + '>' + items.join('') + '</' + kind + '>');
                } else {
                    var para = [];
                    while (i < lines.length && lines[i].trim() && !BULLET.test(lines[i]) && !NUMBER.test(lines[i])) {
                        para.push(inline(esc(lines[i].trim())));
                        i++;
                    }
                    out.push('<p>' + para.join('<br>') + '</p>');
                }
            }
        });
        return out.join('');
    }

    /** The text without marks, on one line: for library cards and other short snippets. */
    function plain(text) {
        return normalize(text)
            .replace(/\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/g, '$1')
            .replace(/__(?=\S)([\s\S]+?)(?<=\S)__/g, '$1')
            .replace(/~~(?=\S)([\s\S]+?)(?<=\S)~~/g, '$1')
            .replace(/==(?=\S)([\s\S]+?)(?<=\S)==/g, '$1')
            .replace(/!!(?=\S)([\s\S]+?)(?<=\S)!!/g, '$1')
            .replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?!\*)/g, '$1$2')
            .replace(/^\s*(?:\*-|•|\d+[.)])\s+/gm, '')
            .replace(/\s*\n+\s*/g, ' ')
            .trim();
    }

    /** Puts formatted text into `el`. An empty value shows `emptyText` when given. */
    function render(el, text, emptyText) {
        if (!el) return;
        el.classList.add('rt');
        var markup = html(text);
        el.innerHTML = markup || (emptyText ? '<p class="rt-empty">' + esc(emptyText) + '</p>' : '');
    }

    /** contrib-box--c1 ... c8, then round again: a 9th botanist reuses colour 1. */
    function contributorClass(index) {
        return 'contrib-box--c' + ((Math.max(0, index | 0) % 8) + 1);
    }

    // ------------------------------------------------------------------ guide

    var EXAMPLES = [
        ['Enter', 'A new line inside the same paragraph.', 'Leaves can be eaten raw.\nStems are tougher.'],
        ['\\n', 'Starts the next paragraph. Type a backslash and the letter n.', 'First idea.\\nSecond idea.'],
        ['*- item', 'A bullet. One per line. (A lone - is just a dash.)', '*- Tea from the leaves\n*- Poultice for bruises'],
        ['1. item', 'A numbered step.', '1. Wash the leaves\n2. Boil for ten minutes'],
        ['**bold**', 'Makes words bold.', '**Never** eat the seeds.'],
        ['*italic*', 'Makes words slanted.', 'Also called *kamote tops*.'],
        ['__underline__', 'Underlines words.', 'Use __fresh__ leaves.'],
        ['~~strike~~', 'Crosses words out.', '~~Old name~~ new name'],
        ['==highlight==', 'A yellow marker for the key point.', 'Dose: ==one cup a day==.'],
        ['!!important!!', 'Red emphasis. Best for warnings.', '!!Toxic to pets!!']
    ];

    // Which EXAMPLES rows belong under which heading in the guide.
    var GUIDE_GROUPS = [
        { title: 'Lines and paragraphs', rows: [0, 1] },
        { title: 'Lists',                rows: [2, 3] },
        { title: 'Text style',           rows: [4, 5, 6, 7] },
        { title: 'Emphasis',             rows: [8, 9] }
    ];

    var guideDialog = null;

    function buildGuide() {
        if (guideDialog) return guideDialog;

        var groups = GUIDE_GROUPS.map(function (group) {
            var cards = group.rows.map(function (i) {
                var row = EXAMPLES[i];
                return '<div class="rt-guide-item">' +
                    '<div class="rt-guide-item-head"><code class="rt-guide-key">' + esc(row[0]) + '</code>' +
                    '<span>' + esc(row[1]) + '</span></div>' +
                    '<div class="rt-guide-demo">' +
                        '<div class="rt-guide-col"><span class="rt-guide-tag">You type</span><pre>' + esc(row[2]) + '</pre></div>' +
                        '<span class="rt-guide-arrow" aria-hidden="true">&rarr;</span>' +
                        '<div class="rt-guide-col"><span class="rt-guide-tag">You get</span><div class="rt">' + html(row[2]) + '</div></div>' +
                    '</div></div>';
            }).join('');
            return '<section class="rt-guide-group"><h3>' + esc(group.title) + '</h3>' +
                '<div class="rt-guide-items">' + cards + '</div></section>';
        }).join('');

        var tips =
            '<section class="rt-guide-tips"><h3>Tips</h3><ul>' +
            '<li>Keep one idea per bullet.</li>' +
            '<li>Use <code>==highlight==</code> for the one thing a reader must remember, and <code>!!important!!</code> only for warnings, or nothing stands out.</li>' +
            '<li>Marks must touch the words: <code>**bold**</code>, not <code>** bold **</code>.</li>' +
            '<li>Your notes are shown under your name in your own colour.</li>' +
            '</ul></section>';

        guideDialog = document.createElement('dialog');
        guideDialog.className = 'rt-guide';
        guideDialog.setAttribute('aria-labelledby', 'rtGuideTitle');
        guideDialog.innerHTML =
            '<header class="rt-guide-head"><div>' +
                '<h2 id="rtGuideTitle">Formatting guide</h2>' +
                '<p>Descriptions are saved as plain text. Wrap words in these marks and they keep their paragraphs, lists and emphasis on the plant page. The toolbar above each box adds them for you.</p>' +
            '</div><button type="button" class="rt-guide-x" data-close aria-label="Close guide">&times;</button></header>' +
            '<div class="rt-guide-body">' + groups + tips + '</div>' +
            '<footer class="rt-guide-foot"><button type="button" class="rt-guide-done" data-close>Got it</button></footer>';

        guideDialog.addEventListener('click', function (e) {
            if (e.target === guideDialog || (e.target.closest && e.target.closest('[data-close]'))) guideDialog.close();
        });
        document.body.appendChild(guideDialog);
        return guideDialog;
    }

    function openGuide() {
        var dialog = buildGuide();
        if (!dialog.open) dialog.showModal();
    }

    // ----------------------------------------------------------------- editor

    function wrapSelection(area, before, after) {
        var start = area.selectionStart, end = area.selectionEnd;
        var value = area.value;
        var chosen = value.slice(start, end) || 'text';
        area.value = value.slice(0, start) + before + chosen + after + value.slice(end);
        area.focus();
        area.setSelectionRange(start + before.length, start + before.length + chosen.length);
        area.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function prefixLines(area, prefixFor) {
        var value = area.value;
        var start = value.lastIndexOf('\n', area.selectionStart - 1) + 1;
        var endIdx = value.indexOf('\n', area.selectionEnd);
        var end = endIdx === -1 ? value.length : endIdx;
        var n = 0;
        var changed = value.slice(start, end).split('\n').map(function (line) {
            return prefixFor(++n) + line.replace(BULLET, '').replace(NUMBER, '');
        }).join('\n');
        area.value = value.slice(0, start) + changed + value.slice(end);
        area.focus();
        area.setSelectionRange(start, start + changed.length);
        area.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function insertAtCursor(area, text) {
        var start = area.selectionStart;
        area.value = area.value.slice(0, start) + text + area.value.slice(area.selectionEnd);
        area.focus();
        area.setSelectionRange(start + text.length, start + text.length);
        area.dispatchEvent(new Event('input', { bubbles: true }));
    }

    var TOOLS = [
        { label: 'B', title: 'Bold (Ctrl+B)', run: function (a) { wrapSelection(a, '**', '**'); }, style: 'font-weight:700' },
        { label: 'I', title: 'Italic (Ctrl+I)', run: function (a) { wrapSelection(a, '*', '*'); }, style: 'font-style:italic' },
        { label: 'U', title: 'Underline', run: function (a) { wrapSelection(a, '__', '__'); }, style: 'text-decoration:underline' },
        { label: 'S', title: 'Strikethrough', run: function (a) { wrapSelection(a, '~~', '~~'); }, style: 'text-decoration:line-through' },
        { sep: true },
        { label: 'Highlight', title: 'Highlight the key point', run: function (a) { wrapSelection(a, '==', '=='); } },
        { label: 'Important', title: 'Red emphasis for warnings', run: function (a) { wrapSelection(a, '!!', '!!'); } },
        { sep: true },
        { label: '\u2022 List', title: 'Bullet list', run: function (a) { prefixLines(a, function () { return '*- '; }); } },
        { label: '1. List', title: 'Numbered list', run: function (a) { prefixLines(a, function (n) { return n + '. '; }); } },
        { label: '\u00B6 Paragraph', title: 'Start the next paragraph (\\n)', run: function (a) { insertAtCursor(a, '\\n'); } }
    ];

    /**
     * Adds the toolbar, one hint line and a live preview to a textarea. Safe to call twice
     * on the same textarea. Returns the preview element.
     */
    function attach(area, options) {
        if (!area || area.dataset.rtAttached) return null;
        area.dataset.rtAttached = '1';
        var withPreview = !options || options.preview !== false;

        var wrap = document.createElement('div');
        wrap.className = 'rt-editor';
        area.parentNode.insertBefore(wrap, area);

        var bar = document.createElement('div');
        bar.className = 'rt-toolbar';
        bar.setAttribute('role', 'toolbar');
        bar.setAttribute('aria-label', 'Text formatting');
        TOOLS.forEach(function (tool) {
            if (tool.sep) {
                var sep = document.createElement('span');
                sep.className = 'rt-sep';
                bar.appendChild(sep);
                return;
            }
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = tool.label;
            btn.title = tool.title;
            if (tool.style) btn.setAttribute('style', tool.style);
            btn.addEventListener('click', function () { tool.run(area); });
            bar.appendChild(btn);
        });
        var help = document.createElement('button');
        help.type = 'button';
        help.className = 'rt-help';
        help.textContent = 'Formatting guide';
        help.addEventListener('click', openGuide);
        bar.appendChild(help);

        var hint = document.createElement('p');
        hint.className = 'rt-hint';
        hint.innerHTML = 'Enter = new line, <code>\\n</code> = next paragraph, <code>*- </code> = bullet, ' +
            '<code>**bold**</code>, <code>==highlight==</code>.';

        wrap.appendChild(bar);
        wrap.appendChild(area);
        wrap.appendChild(hint);

        var preview = null;
        if (withPreview) {
            preview = document.createElement('div');
            preview.className = 'rt-preview';
            preview.hidden = true;
            preview.innerHTML = '<span class="rt-preview-label">Preview</span><div class="rt"></div>';
            wrap.appendChild(preview);
            var body = preview.querySelector('.rt');
            var update = function () {
                var markup = html(area.value);
                body.innerHTML = markup;
                preview.hidden = !markup;
            };
            area.addEventListener('input', update);
            area.addEventListener('rt:refresh', update);
            if (area.form) area.form.addEventListener('reset', function () { setTimeout(update, 0); });
            update();
        }

        area.addEventListener('keydown', function (e) {
            if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
            var key = e.key.toLowerCase();
            if (key === 'b') { e.preventDefault(); wrapSelection(area, '**', '**'); }
            else if (key === 'i') { e.preventDefault(); wrapSelection(area, '*', '*'); }
        });
        return preview;
    }

    /** Attaches every textarea marked data-richtext (call after dynamic markup is added too). */
    function attachAll(root) {
        (root || document).querySelectorAll('textarea[data-richtext]').forEach(function (area) { attach(area); });
    }

    document.addEventListener('click', function (e) {
        if (e.target.closest && e.target.closest('[data-rt-guide]')) { e.preventDefault(); openGuide(); }
    });

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { attachAll(); });
    else attachAll();

    global.RichText = {
        html: html, plain: plain, render: render, attach: attach, attachAll: attachAll,
        openGuide: openGuide, contributorClass: contributorClass, EXAMPLES: EXAMPLES
    };
})(window);