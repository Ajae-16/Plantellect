/* =========================================================
   admin-users.js
   Logic for the Users page (admin-users.html).

   Load it at the bottom of the page, AFTER auth.js and home.js.
   It relies on window.loadNavBadges (admin-sidebar.js) and
   logoutUser (logout.js).

   Search module:
     - two independent fields (name, email), both "starts with"
     - debounced; Enter searches immediately; Escape clears
     - a clear (x) button appears when a field has text
     - requests only fire when the trimmed value really changed
     - stale responses are cancelled (AbortController), so a slow
       response can never overwrite a newer one
     - the matched start of each result is highlighted
   ========================================================= */
(function () {
    'use strict';

    // ---------------------------------------------------------
    // Config
    // ---------------------------------------------------------
    const PAGE_SIZE = 10;
    const SEARCH_DEBOUNCE_MS = 300;

    const FILTER_LABELS = {
        admin: 'Administrators',
        botanist: 'Botanists',
        user: 'Users',
        active: 'Active Accounts'
    };

    // ---------------------------------------------------------
    // State
    // ---------------------------------------------------------
    const state = {
        page: 1,
        filter: 'admin',      // which role card is open
        name: '',
        email: '',
        status: 'all',
        role: 'all',
        viewerPermissions: [],
        accountId: null
    };

    let inflight = null;      // AbortController of the request in flight

    // ---------------------------------------------------------
    // DOM
    // ---------------------------------------------------------
    const el = {
        panel: document.getElementById('roleDetailPanel'),
        title: document.getElementById('roleDetailTitle'),
        tbody: document.getElementById('usersTableBody'),
        tableWrap: document.querySelector('.users-table-wrapper'),
        empty: document.getElementById('usersEmptyState'),
        emptyText: document.querySelector('#usersEmptyState p'),
        pageInfo: document.getElementById('paginationInfo'),
        pageControls: document.getElementById('paginationControls'),
        status: document.getElementById('statusFilter'),
        role: document.getElementById('roleFilter'),
        nameInput: document.getElementById('nameSearch'),
        emailInput: document.getElementById('emailSearch')
    };

    // Small bits of styling that belong to this module (clear button, highlight, loading)
    (function injectStyles() {
        const style = document.createElement('style');
        style.textContent = `
            .users-search input { padding-right: 38px; }
            .search-clear {
                position: absolute; top: 50%; right: 8px; transform: translateY(-50%);
                width: 24px; height: 24px; padding: 0; border: none; border-radius: 50%;
                display: flex; align-items: center; justify-content: center;
                background: rgba(128, 128, 128, 0.22); color: inherit; cursor: pointer;
            }
            .search-clear[hidden] { display: none; }
            .search-clear:hover { background: rgba(128, 128, 128, 0.4); }
            .search-clear .material-symbols-outlined { font-size: 16px; }
            mark.match-hl {
                background: rgba(76, 175, 80, 0.3); color: inherit;
                border-radius: 3px; padding: 0 1px;
            }
            .users-table-wrapper { transition: opacity 0.15s ease; }
            .users-table-wrapper.is-loading { opacity: 0.55; }
        `;
        document.head.appendChild(style);
    })();

    // ---------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------
    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = String(str == null ? '' : str);
        return div.innerHTML;
    }

    function capitalize(s) {
        s = String(s || '');
        return s.charAt(0).toUpperCase() + s.slice(1);
    }

    function hasPermission(name) {
        return state.viewerPermissions.indexOf(name) !== -1;
    }

    /**
     * Escapes `text` and wraps the matching start in <mark>. The match counts
     * at the very start of the value, or at the start of any word in it (so a
     * name search for "d" lights up the D in "Maria D."), matching the
     * "starts with" behaviour of the search.
     */
    function highlightStart(text, query) {
        text = String(text == null ? '' : text);
        const q = (query || '').trim().toLowerCase();
        if (!q) return escapeHtml(text);

        const lower = text.toLowerCase();
        let at = -1;
        for (let i = 0; i <= lower.length - q.length; i++) {
            const atWordStart = i === 0 || lower[i - 1] === ' ';
            if (atWordStart && lower.startsWith(q, i)) { at = i; break; }
        }
        if (at === -1) return escapeHtml(text);

        return escapeHtml(text.slice(0, at)) +
            '<mark class="match-hl">' + escapeHtml(text.slice(at, at + q.length)) + '</mark>' +
            escapeHtml(text.slice(at + q.length));
    }

    // ---------------------------------------------------------
    // Search module
    // ---------------------------------------------------------
    /**
     * Wraps one search input. Calls onChange(value) with the TRIMMED value, but
     * only when it differs from the last value it reported.
     */
    function createSearchField(input, onChange) {
        let timer = null;
        let last = '';

        const wrap = input.closest('.users-search');
        const clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.className = 'search-clear';
        clearBtn.hidden = true;
        clearBtn.setAttribute('aria-label', 'Clear search');
        clearBtn.innerHTML = '<span class="material-symbols-outlined">close</span>';
        wrap.appendChild(clearBtn);

        function emit() {
            clearTimeout(timer);
            const value = input.value.trim();
            if (value === last) return;      // nothing really changed
            last = value;
            onChange(value);
        }

        input.addEventListener('input', () => {
            clearBtn.hidden = input.value === '';
            clearTimeout(timer);
            timer = setTimeout(emit, SEARCH_DEBOUNCE_MS);
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                emit();                      // skip the debounce
            } else if (e.key === 'Escape' && input.value !== '') {
                clear();
            }
        });

        clearBtn.addEventListener('click', () => {
            clear();
            input.focus();
        });

        /** Empties the field. Pass {silent:true} to skip the onChange call. */
        function clear(opts) {
            clearTimeout(timer);
            input.value = '';
            clearBtn.hidden = true;
            if (opts && opts.silent) {
                last = '';
                return;
            }
            emit();
        }

        return { clear };
    }

    const nameSearch = createSearchField(el.nameInput, (value) => {
        state.name = value;
        state.page = 1;
        loadUsers();
    });

    const emailSearch = createSearchField(el.emailInput, (value) => {
        state.email = value;
        state.page = 1;
        loadUsers();
    });

    /** Message shown when the search finds nothing. */
    function emptyMessage() {
        const parts = [];
        if (state.name) parts.push('a name starting with \u201C' + state.name + '\u201D');
        if (state.email) parts.push('an email starting with \u201C' + state.email + '\u201D');
        return parts.length
            ? 'No users with ' + parts.join(' and ') + '.'
            : 'No users found.';
    }

    // ---------------------------------------------------------
    // Data loading (filtering, search and pagination are server-side)
    // ---------------------------------------------------------
    function buildQuery() {
        const params = new URLSearchParams();
        // Separate "starts with" searches. The server matches the START of each value.
        if (state.name) params.set('name', state.name);
        if (state.email) params.set('email', state.email);
        params.set('page', String(state.page));

        if (state.filter === 'active') {
            // The active card filters on status, not on a role.
            params.set('status', state.status === 'all' ? 'active' : state.status);
            if (state.role !== 'all') params.set('role', state.role);
        } else {
            params.set('role', state.filter);
            if (state.status !== 'all') params.set('status', state.status);
        }
        return params;
    }

    async function loadUsers() {
        // Cancel the previous request so a slow, older response can never win
        if (inflight) inflight.abort();
        const controller = new AbortController();
        inflight = controller;
        el.tableWrap.classList.add('is-loading');

        try {
            const response = await fetch('/admin/api/users?' + buildQuery().toString(), {
                credentials: 'include',
                signal: controller.signal
            });
            if (response.status === 401) {
                window.location.href = '/auth.html';
                return;
            }
            if (!response.ok) throw new Error('Failed to load users');
            const data = await response.json();
            updateCounts(data.counts);
            renderTable(data);
        } catch (err) {
            if (err.name === 'AbortError') return;   // superseded by a newer request
            console.error('Load users error:', err);
            el.tbody.innerHTML = '';
            el.emptyText.textContent = 'Users could not be loaded.';
            el.empty.hidden = false;
        } finally {
            if (inflight === controller) {
                inflight = null;
                el.tableWrap.classList.remove('is-loading');
            }
        }
    }

    // Counts come from the response, not from the current page of rows.
    function updateCounts(counts) {
        if (!counts) return;
        document.getElementById('countAdmin').textContent = counts.admin;
        document.getElementById('countBotanist').textContent = counts.botanist;
        document.getElementById('countUsers').textContent = counts.user;
        document.getElementById('countActive').textContent = counts.active;
    }

    // ---------------------------------------------------------
    // Rendering
    // ---------------------------------------------------------
    function renderTable(data) {
        const users = data.users || [];
        const total = data.total || 0;
        const pageSize = data.pageSize || PAGE_SIZE;
        const totalPages = Math.max(1, Math.ceil(total / pageSize));

        // Narrowing a filter can leave us past the end of the results.
        if (state.page > totalPages) {
            state.page = totalPages;
            return loadUsers();
        }

        el.title.textContent = FILTER_LABELS[state.filter];

        if (users.length === 0) {
            el.tbody.innerHTML = '';
            el.emptyText.textContent = emptyMessage();
            el.empty.hidden = false;
        } else {
            el.empty.hidden = true;
            el.tbody.innerHTML = users.map(renderRow).join('');
        }

        renderPagination(total, totalPages, pageSize);
    }

    /** One icon-only action button. The tooltip and aria-label carry the meaning. */
    function actionButton(cls, variant, icon, label, attrs) {
        return '<button type="button" class="action-btn action-btn--' + variant + ' ' + cls + '"' +
            ' title="' + escapeHtml(label) + '" aria-label="' + escapeHtml(label) + '" ' + attrs + '>' +
            '<span class="material-symbols-outlined">' + icon + '</span></button>';
    }

    function renderRow(u) {
        const notSelf = u.id !== state.accountId;
        const isSuperadmin = u.role === 'superadmin';
        const privileged = u.role === 'admin' || isSuperadmin;
        const id = escapeHtml(u.id);

        const viewBtn = actionButton('btn-view', 'view', 'visibility', 'View details', 'data-id="' + id + '"');

        let suspendBtn = '';
        if (hasPermission('archive_user') && notSelf) {
            const isActive = u.status === 'active';
            suspendBtn = actionButton(
                'btn-toggle-status',
                isActive ? 'danger' : 'success',
                isActive ? 'block' : 'check_circle',
                isActive ? 'Suspend account' : 'Activate account',
                'data-id="' + id + '" data-status="' + escapeHtml(u.status) + '"'
            );
        }

        let roleBtn = '';
        if (hasPermission('admin_promote') && notSelf) {
            const label = isSuperadmin ? 'Revoke superadmin' : (privileged ? 'Revoke admin' : 'Make admin');
            roleBtn = actionButton(
                'btn-toggle-admin',
                privileged ? 'danger' : 'promote',
                privileged ? 'remove_moderator' : 'shield_person',
                label,
                'data-id="' + id + '" data-role="' + escapeHtml(u.role) + '"'
            );
        }

        return '<tr>' +
            '<td>' + highlightStart(u.name, state.name) + '</td>' +
            '<td>' + highlightStart(u.email, state.email) + '</td>' +
            '<td><span class="badge badge-' + escapeHtml(u.role) + '">' + capitalize(u.role) + '</span></td>' +
            '<td><span class="badge badge-' + escapeHtml(u.status) + '">' + capitalize(u.status) + '</span></td>' +
            '<td class="user-actions"><div class="action-group">' +
                viewBtn + suspendBtn + roleBtn +
            '</div></td>' +
        '</tr>';
    }

    function renderPagination(totalItems, totalPages, pageSize) {
        if (totalItems === 0) {
            el.pageInfo.textContent = 'No entries';
            el.pageControls.innerHTML = '';
            return;
        }

        const start = (state.page - 1) * pageSize + 1;
        const end = Math.min(state.page * pageSize, totalItems);
        el.pageInfo.innerHTML =
            'Showing <strong>' + start + '</strong> to <strong>' + end +
            '</strong> of <strong>' + totalItems + '</strong> entries';

        let buttons = '<button class="page-btn" data-page="prev"' + (state.page === 1 ? ' disabled' : '') + '>Prev</button>';
        for (let p = 1; p <= totalPages; p++) {
            buttons += '<button class="page-btn' + (p === state.page ? ' active' : '') + '" data-page="' + p + '">' + p + '</button>';
        }
        buttons += '<button class="page-btn" data-page="next"' + (state.page === totalPages ? ' disabled' : '') + '>Next</button>';
        el.pageControls.innerHTML = buttons;
    }

    // ---------------------------------------------------------
    // Events (delegated, so re-rendering never needs re-wiring)
    // ---------------------------------------------------------
    el.pageControls.addEventListener('click', (e) => {
        const btn = e.target.closest('.page-btn');
        if (!btn || btn.disabled) return;
        const val = btn.dataset.page;
        if (val === 'prev') state.page = Math.max(1, state.page - 1);
        else if (val === 'next') state.page = state.page + 1;
        else state.page = parseInt(val, 10);
        loadUsers();
    });

    el.tbody.addEventListener('click', (e) => {
        const statusBtn = e.target.closest('.btn-toggle-status');
        if (statusBtn) {
            toggleAccount(statusBtn.dataset.id, {
                status: statusBtn.dataset.status === 'active' ? 'inactive' : 'active'
            });
            return;
        }

        const roleBtn = e.target.closest('.btn-toggle-admin');
        if (roleBtn) {
            const currentRole = roleBtn.dataset.role;
            const privileged = currentRole === 'admin' || currentRole === 'superadmin';
            // Revoking a superadmin demotes them to user; the server refuses
            // if that would leave no active superadmin.
            toggleAccount(
                roleBtn.dataset.id,
                { role: privileged ? 'user' : 'admin' },
                privileged ? 'Revoke ' + currentRole + ' from' : 'Grant admin to'
            );
            return;
        }

        // .btn-view: hook up a details view here when you build one.
    });

    async function toggleAccount(accountId, body, roleLabel) {
        const label = body.status
            ? (body.status === 'inactive' ? 'Suspend' : 'Reactivate')
            : (roleLabel || (body.role === 'admin' ? 'Grant admin to' : 'Revoke admin from'));
        if (!confirm(label + ' account ' + accountId + '?')) return;

        const isStatus = Boolean(body.status);
        try {
            const response = await fetch(
                '/admin/api/users/' + encodeURIComponent(accountId) + '/' + (isStatus ? 'status' : 'role'),
                {
                    method: isStatus ? 'PATCH' : 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify(body)
                }
            );
            const result = await response.json();
            if (!response.ok) {
                alert('Error: ' + (result.error || 'Request failed'));
                return;
            }
            await loadUsers();
        } catch (err) {
            console.error('Account action error:', err);
            alert('Error: ' + err.message);
        }
    }

    // Role cards: switch filter + expand the detail panel
    document.querySelectorAll('.role-box').forEach((box) => {
        // Administrators is the default view, so mark it active to match the open panel.
        if (box.dataset.role === state.filter) box.classList.add('active-role');

        box.addEventListener('click', () => {
            // Clicking the already-open card again collapses it.
            if (box.classList.contains('active-role')) {
                box.classList.remove('active-role');
                el.panel.classList.remove('open');
                return;
            }

            document.querySelectorAll('.role-box').forEach((b) => b.classList.remove('active-role'));
            box.classList.add('active-role');

            state.filter = box.dataset.role;
            state.page = 1;
            state.name = '';
            state.email = '';
            state.status = 'all';
            state.role = 'all';

            nameSearch.clear({ silent: true });
            emailSearch.clear({ silent: true });
            el.status.value = 'all';
            el.role.value = 'all';
            el.role.hidden = state.filter !== 'active';

            el.panel.classList.add('open');
            el.panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            loadUsers();
        });
    });

    el.status.addEventListener('change', (e) => {
        state.status = e.target.value;
        state.page = 1;
        loadUsers();
    });

    // Extra refinement for the active-users panel
    el.role.addEventListener('change', (e) => {
        state.role = e.target.value;
        state.page = 1;
        loadUsers();
    });

    // ---------------------------------------------------------
    // Init
    // ---------------------------------------------------------
    (async function init() {
        const response = await fetch('/api/auth/me', { credentials: 'include' });
        if (!response.ok) {
            window.location.href = '/auth.html';
            return;
        }
        const data = await response.json();

        document.getElementById('adminUser').textContent = 'Logged in as ' + data.username;
        state.accountId = data.accountId || null;
        state.viewerPermissions = data.permissions || [];

        document.querySelectorAll('.admin-sidebar a[data-perm]').forEach(function (a) {
            if (!state.viewerPermissions.includes(a.getAttribute('data-perm'))) {
                a.style.display = 'none';
            }
        });

        document.getElementById('adminLogoutLink').addEventListener('click', function (e) {
            e.preventDefault();
            logoutUser();
        });

        loadUsers();
        loadNavBadges();
    })();
})();