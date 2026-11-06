/**
 * Keeps an open admin page in step with other admins (window.DatasetSync). Server side: config/dataset-sync.js.
 *
 *   - Asks GET /admin/api/dataset/sync every few seconds. The interval comes FROM THE SERVER (pollSeconds), so going from
 *     "every 12 s" to "every 3 s" is one server setting, not a page change. The request carries the last ETag, so while
 *     nothing has changed the answer is a bodyless 304.
 *   - When a counter of a scope the page shows has moved past what the page loaded with, and the change was made by SOMEONE
 *     ELSE, a banner says who did what and offers Refresh. It never reloads by itself (that would throw away a selection).
 *   - Shows "Ben is working on this" on items other admins have claimed, and lets the page claim what its admin has selected.
 *
 * It informs; it does not prevent. Preventing two admins from changing the same item is the server's lock.
 *
 *   DatasetSync.start({ scopes, banner, onRefresh, onConflict })  -> Promise, settled after the first answer
 *   DatasetSync.markLoaded()      call when the page starts loading its data: what it shows is as of now
 *   DatasetSync.setClaims(owner, keys, purpose)   the items this admin is working on (declarative; [] lets go)
 *   DatasetSync.holder(key)       { name, purpose } when ANOTHER admin has claimed it, else null
 *   DatasetSync.paint(root)       puts / removes the marker on every [data-lockkey] element under root (the attribute may
 *                                 hold several keys separated by spaces; the first one somebody holds is shown)
 *   DatasetSync.lockSpecies(label)  lock a species folder (train, val and test) -> Promise { ok, key, label } or { ok: false, error }
 *   DatasetSync.unlockSpecies(key)  let go of it
 *   DatasetSync.isMine(key)       true when THIS admin holds that species lock
 *   Species locks are kept alive by a heartbeat while the page is open and the admin is active (mouse, keys, scrolling); they
 *   survive a reload (the next page adopts them) and lapse by themselves when the page is closed or left idle.
 *
 * Every server value goes onto the page with textContent, never innerHTML.
 */
(function () {
    'use strict';

    var API = '/admin/api/dataset/';
    var DEFAULT_POLL_MS = 12000;
    var MAX_SHOWN = 3;

    var st = {
        opts: null, etag: null, payload: null, payloadAt: 0, baseline: null, wantBaseline: true,
        pollMs: DEFAULT_POLL_MS, claimMs: 30000, claimMax: 200, failures: 0, timer: null, stopped: true,
        want: {}, purposes: {}, claimTimer: null, claimBusy: false, claimAgain: false, debounce: null,
        locks: {}, mine: {}, lockSig: '', conflictSig: '', bannerKey: '',
        spKeys: {}, spAdopted: false, spTimer: null, spLeaseMs: 300000, spIdleMs: 20 * 60000, spActive: Date.now()
    };

    function $(id) { return document.getElementById(id); }
    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
    }
    function copyBaseline(payload) {
        var c = {};
        Object.keys(payload.counters || {}).forEach(function (k) { c[k] = payload.counters[k]; });
        return { all: c.all || 0, counters: c };
    }

    // ------------------------------------------------------------------ what changed since this page loaded
    /**
     * Pure. Decides whether the page is out of date and by whose doing.
     *   baseline  { all, counters } as of the page's last load
     *   payload   the sync answer { counters, changes (newest first) }
     *   watched   the scopes this page shows
     *   myId      this admin's account id
     * Returns { stale, foreign: [change...], missed, ownOnly }:
     *   stale     show the banner
     *   ownOnly   a watched counter moved, but only because of this admin's own changes: move the baseline silently
     *   missed    changes happened that the answer's newest-rows window no longer lists (the banner then says "some")
     */
    function evaluate(baseline, payload, watched, myId) {
        var moved = watched.filter(function (s) { return (payload.counters[s] || 0) > (baseline.counters[s] || 0); });
        if (moved.length === 0) return { stale: false, foreign: [], missed: false, ownOnly: false };
        var since = (payload.changes || []).filter(function (c) { return c.id > baseline.all; });
        var expected = (payload.counters.all || 0) - baseline.all;
        var missed = since.length < expected;
        var foreign = since.filter(function (c) {
            return c.by.accountId !== myId && c.scopes.some(function (s) { return watched.indexOf(s) >= 0; });
        });
        if (foreign.length === 0 && !missed) return { stale: false, foreign: [], missed: false, ownOnly: true };
        return { stale: true, foreign: foreign, missed: missed, ownOnly: false };
    }

    function ago(seconds) {
        if (seconds < 45) return 'just now';
        var m = Math.round(seconds / 60);
        if (m < 60) return m + ' min ago';
        return Math.round(m / 60) + ' h ago';
    }

    // ------------------------------------------------------------------ banner
    function bannerNode() { return st.opts && st.opts.banner ? $(st.opts.banner) : null; }

    function hideBanner() {
        var b = bannerNode();
        if (b) { b.hidden = true; b.textContent = ''; }
        st.bannerKey = '';
    }

    function showBanner(result) {
        var b = bannerNode();
        if (!b) return;
        var elapsed = (Date.now() - st.payloadAt) / 1000;
        var lines = result.foreign.slice(0, MAX_SHOWN).map(function (c) {
            return c.by.name + ' ' + c.summary + ' (' + ago(c.ageSeconds + elapsed) + ')';
        });
        var more = result.foreign.length - lines.length;
        var text = lines.join('. ');
        if (more > 0) text += '. And ' + more + ' more change' + (more === 1 ? '' : 's') + '.';
        if (result.missed) text += (text ? ' ' : '') + 'There were more changes than can be listed here.';
        // Rebuild only when the message changed, so a button the admin is about to press is not replaced under the pointer.
        var key = text;
        if (key === st.bannerKey && !b.hidden) return;
        st.bannerKey = key;
        b.textContent = '';
        b.appendChild(el('span', 'material-symbols-outlined ds-sync-icon', 'sync_alt'));
        var msg = el('span', 'ds-sync-text');
        msg.appendChild(el('strong', null, 'Changed by someone else: '));
        msg.appendChild(document.createTextNode(text + ' This page shows the older version.'));
        b.appendChild(msg);
        var refresh = el('button', 'btn btn-primary', 'Refresh');
        refresh.type = 'button';
        refresh.addEventListener('click', function () {
            if (st.payload) st.baseline = copyBaseline(st.payload);
            hideBanner();
            if (st.opts && st.opts.onRefresh) Promise.resolve(st.opts.onRefresh()).catch(function () { /* the page reports its own errors */ });
        });
        var dismiss = el('button', 'btn', 'Dismiss');
        dismiss.type = 'button';
        dismiss.addEventListener('click', function () {
            if (st.payload) st.baseline = copyBaseline(st.payload);
            hideBanner();
        });
        b.appendChild(refresh);
        b.appendChild(dismiss);
        b.hidden = false;
    }

    // ------------------------------------------------------------------ markers for other admins' claims
    function applyLocks(payload) {
        var me = payload.me && payload.me.accountId;
        var map = {}, mine = {};
        (payload.locks || []).forEach(function (owner) {
            owner.keys.forEach(function (k) {
                if (owner.accountId === me) mine[k] = true;
                else map[k] = { name: owner.name, purpose: owner.purpose, key: k };
            });
        });
        adoptSpeciesLocks(mine);
        // An answer that was already on its way when this admin took (or let go of) a lock can be a little behind. A species lock
        // this page is keeping alive stays "mine" unless the answer shows ANOTHER admin holding it, in which case it is lost.
        var lost = [];
        Object.keys(st.spKeys).forEach(function (k) { if (map[k]) lost.push(k); else mine[k] = true; });
        var sig = JSON.stringify(map) + '|' + Object.keys(mine).sort().join(',');
        if (sig !== st.lockSig) {
            st.lockSig = sig;
            st.locks = map;
            st.mine = mine;
            paint(document);
            if (st.opts && st.opts.onLocks) st.opts.onLocks(map, mine);
        }
        if (lost.length) speciesLost(lost, 'lost');
    }

    function isSpeciesKey(key) { return typeof key === 'string' && key.indexOf('lbl:') === 0; }

    /** The first of the space-separated keys that ANOTHER admin holds, else null. */
    function holder(keys) {
        var list = String(keys || '').split(/\s+/);
        for (var i = 0; i < list.length; i++) if (list[i] && st.locks[list[i]]) return st.locks[list[i]];
        return null;
    }

    /** True when this admin holds the species lock (only species locks are shown as "mine"; selections are not). */
    function isMine(key) { return isSpeciesKey(key) && !!st.mine[key]; }

    function paint(root) {
        Array.prototype.forEach.call((root || document).querySelectorAll('[data-lockkey]'), function (node) {
            var keys = node.getAttribute('data-lockkey');
            var h = holder(keys);
            var own = !h && String(keys).split(/\s+/).some(isMine);
            var badge = node.querySelector(':scope > .ds-lockbadge');
            node.classList.toggle('is-locked', !!h);
            node.classList.toggle('is-mine', own);
            if (!h && !own) { if (badge) badge.remove(); return; }
            if (!badge) { badge = el('span', 'ds-lockbadge'); node.appendChild(badge); }
            badge.classList.toggle('mine', own);
            badge.textContent = own ? 'You locked this species'
                : isSpeciesKey(h.key) ? h.name + ' locked this species' : h.name + ' is working on this';
        });
    }

    // ------------------------------------------------------------------ polling
    function handle(payload) {
        st.payload = payload;
        st.payloadAt = Date.now();
        if (payload.pollSeconds) st.pollMs = Math.max(2000, payload.pollSeconds * 1000);
        if (payload.claimSeconds) st.claimMs = Math.max(5000, Math.round(payload.claimSeconds * 1000 / 3));
        if (payload.claimMaxKeys) st.claimMax = payload.claimMaxKeys;
        if (payload.speciesLockSeconds) st.spLeaseMs = payload.speciesLockSeconds * 1000;
        if (payload.speciesIdleSeconds) st.spIdleMs = payload.speciesIdleSeconds * 1000;
        if (st.wantBaseline || !st.baseline) { st.baseline = copyBaseline(payload); st.wantBaseline = false; }
        var watched = st.opts.scopes || [];
        var result = evaluate(st.baseline, payload, watched, payload.me && payload.me.accountId);
        if (result.ownOnly) {
            // Only this admin's own changes moved the counters; the page already reloaded itself after each of them.
            st.baseline = copyBaseline(payload);
            hideBanner();
        } else if (result.stale) {
            showBanner(result);
        } else {
            hideBanner();
        }
        applyLocks(payload);
    }

    function poll() {
        if (st.stopped) return Promise.resolve();
        var headers = {};
        if (st.etag) headers['If-None-Match'] = st.etag;
        return fetch(API + 'sync', { credentials: 'include', cache: 'no-store', headers: headers }).then(function (r) {
            if (r.status === 304) { st.failures = 0; return null; }
            // Signed out, no permission, or the tables are not migrated yet: stop asking; the page's own calls report it.
            if (r.status === 401 || r.status === 403 || r.status === 503) { st.stopped = true; return null; }
            if (!r.ok) throw new Error('sync ' + r.status);
            st.etag = r.headers.get('ETag');
            return r.json().then(function (payload) { st.failures = 0; handle(payload); });
        }).catch(function () { st.failures += 1; }).then(schedule);
    }

    function schedule() {
        if (st.stopped) return;
        clearTimeout(st.timer);
        var wait = st.pollMs * Math.min(5, 1 + st.failures);       // back off while the server is unreachable
        st.timer = setTimeout(function () {
            if (document.hidden) { schedule(); return; }          // nobody is looking: no request
            poll();
        }, wait);
    }

    // ------------------------------------------------------------------ claims: "I am working on this"
    function post(path, body) {
        return fetch(API + path, {
            method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, data: d }; }); });
    }

    function wantedKeys() {
        var all = [];
        Object.keys(st.want).forEach(function (owner) {
            st.want[owner].forEach(function (k) { if (all.indexOf(k) < 0) all.push(k); });
        });
        return all.slice(0, st.claimMax);
    }

    var heldBefore = [];
    function syncClaims() {
        if (st.stopped) return Promise.resolve();
        if (st.claimBusy) { st.claimAgain = true; return Promise.resolve(); }
        var keys = wantedKeys();
        var drop = heldBefore.filter(function (k) { return keys.indexOf(k) < 0; });
        st.claimBusy = true;
        var work = Promise.resolve();
        if (drop.length) work = post('locks/release', { keys: drop });
        if (keys.length) {
            work = work.then(function () {
                var purpose = Object.keys(st.purposes).map(function (o) { return st.purposes[o]; })[0] || 'editing';
                return post('locks', { keys: keys, purpose: purpose });
            }).then(function (res) {
                if (!res.ok || !res.data) return;
                heldBefore = res.data.held || [];
                var conflicts = res.data.conflicts || [];
                var sig = conflicts.map(function (c) { return c.key; }).join(',');
                if (sig !== st.conflictSig) {
                    st.conflictSig = sig;
                    if (conflicts.length && st.opts && st.opts.onConflict) st.opts.onConflict(conflicts);
                }
            });
        } else {
            heldBefore = [];
        }
        return work.catch(function () { /* a marker is a courtesy: try again at the next renewal */ }).then(function () {
            st.claimBusy = false;
            if (st.claimAgain) { st.claimAgain = false; return syncClaims(); }
            return null;
        });
    }

    /** The items this admin is working on, for one part of the page (owner). A later call replaces the earlier; [] lets go. */
    function setClaims(owner, keys, purpose) {
        var next = (keys || []).slice();
        var same = st.want[owner] && st.want[owner].length === next.length && st.want[owner].slice().sort().join('|') === next.slice().sort().join('|');
        if (same) return;                                   // nothing new to say; the renewal timer keeps the claim alive
        st.want[owner] = next;
        if (purpose) st.purposes[owner] = purpose;
        clearTimeout(st.debounce);
        st.debounce = setTimeout(syncClaims, 400);
    }

    function renewClaims() {
        if (document.hidden || wantedKeys().length === 0) return;   // a hidden tab lets its claims lapse on purpose
        syncClaims();
    }

    function releaseOnClose() {
        if (!heldBefore.length || !navigator.sendBeacon) return;
        try { navigator.sendBeacon(API + 'locks/release', new Blob([JSON.stringify({ all: true })], { type: 'application/json' })); } catch (e) { /* best effort */ }
    }

    // ------------------------------------------------------------------ species locks: "this species is mine for now"
    // The server keeps the lock for a lease and the page renews it every third of that, as long as the admin is active. A lock
    // that is not renewed (tab closed, computer asleep, nobody at the keyboard for speciesIdleSeconds) lapses by itself.
    function noteActivity() { st.spActive = Date.now(); }

    function speciesLost(keys, why) {
        keys.forEach(function (k) { delete st.spKeys[k]; delete st.mine[k]; });
        if (!Object.keys(st.spKeys).length) { clearInterval(st.spTimer); st.spTimer = null; }
        st.lockSig = '';                                       // repaint and tell the page even if the maps look the same
        paint(document);
        if (st.opts && st.opts.onSpeciesLockEnded) st.opts.onSpeciesLockEnded(keys, why);
        if (st.opts && st.opts.onLocks) st.opts.onLocks(st.locks, st.mine);
    }

    function renewSpecies() {
        var keys = Object.keys(st.spKeys);
        if (!keys.length || st.stopped) return Promise.resolve();
        if (Date.now() - st.spActive > st.spIdleMs) { speciesLost(keys, 'idle'); return Promise.resolve(); }
        return post('locks/species/renew', { keys: keys }).then(function (res) {
            // Only a real answer says a lock was lost; an error (server busy) keeps what we have and tries at the next beat.
            if (res.ok && res.data && res.data.lost && res.data.lost.length) speciesLost(res.data.lost, 'lost');
        }).catch(function () { /* the next beat tries again */ });
    }

    function keepAlive() {
        if (st.spTimer || !Object.keys(st.spKeys).length) return;
        st.spTimer = setInterval(renewSpecies, Math.max(15000, Math.round(st.spLeaseMs / 3)));
    }

    /** The first answer after the page opens: species locks this admin already holds (before a reload) keep being renewed. */
    function adoptSpeciesLocks(mine) {
        if (st.spAdopted) return;
        st.spAdopted = true;
        Object.keys(mine).forEach(function (k) { if (isSpeciesKey(k)) st.spKeys[k] = true; });
        keepAlive();
    }

    function lockSpecies(label) {
        return post('locks/species', { label: label }).then(function (res) {
            var d = res.data || {};
            if (!res.ok || !d.key) return { ok: false, error: d.error || 'Could not lock the species', code: d.code, lockedBy: d.lockedBy };
            st.spKeys[d.key] = true;
            st.mine[d.key] = true;
            st.spActive = Date.now();
            keepAlive();
            st.lockSig = '';
            paint(document);
            if (st.opts && st.opts.onLocks) st.opts.onLocks(st.locks, st.mine);
            poll();                                            // the lock counter moved: pick up the new list now
            return { ok: true, key: d.key, label: d.label };
        });
    }

    function unlockSpecies(key) {
        delete st.spKeys[key];
        delete st.mine[key];
        if (!Object.keys(st.spKeys).length) { clearInterval(st.spTimer); st.spTimer = null; }
        st.lockSig = '';
        paint(document);
        if (st.opts && st.opts.onLocks) st.opts.onLocks(st.locks, st.mine);
        return post('locks/release', { keys: [key] }).then(function (res) { poll(); return { ok: res.ok }; });
    }

    // ------------------------------------------------------------------ public
    function start(opts) {
        st.opts = opts || {};
        st.stopped = false;
        st.failures = 0;
        document.addEventListener('visibilitychange', function () {
            if (document.hidden || st.stopped) return;
            clearTimeout(st.timer);
            poll();
            renewClaims();
        });
        window.addEventListener('pagehide', releaseOnClose);
        ['pointerdown', 'keydown', 'scroll', 'touchstart'].forEach(function (name) {
            window.addEventListener(name, noteActivity, { passive: true, capture: true });
        });
        st.claimTimer = setInterval(renewClaims, st.claimMs);
        return poll();
    }

    function markLoaded() {
        // The page is about to read its data: what it shows is as of NOW. The newest answer is the baseline, or the first
        // answer will be if none has arrived yet. Taken BEFORE the data is read, so a change in between is announced
        // (a harmless extra banner) rather than missed.
        if (st.payload) { st.baseline = copyBaseline(st.payload); st.wantBaseline = false; hideBanner(); }
        else st.wantBaseline = true;
    }

    function stop() {
        st.stopped = true;
        clearTimeout(st.timer);
        clearInterval(st.claimTimer);
    }

    window.DatasetSync = { start: start, stop: stop, markLoaded: markLoaded, setClaims: setClaims, holder: holder, isMine: isMine, paint: paint, poll: poll,
        lockSpecies: lockSpecies, unlockSpecies: unlockSpecies, _evaluate: evaluate };
})();
