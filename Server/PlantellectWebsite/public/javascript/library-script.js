function initSliderAutoplayPause() {
    const sliderWrapper = document.querySelector('.slider-wrapper');
    const sliderTrack = document.querySelector('.slider-track');
    if (!sliderWrapper || !sliderTrack) return;

    let resumeTimer = null;
    const RESUME_DELAY = 1500;

    function pauseAnimation() {
        sliderTrack.classList.add('paused');
        sliderWrapper.classList.add('paused');
    }

    function resumeAnimation() {
        if (resumeTimer) {
            clearTimeout(resumeTimer);
        }
        resumeTimer = setTimeout(function() {
            sliderTrack.classList.remove('paused');
            sliderWrapper.classList.remove('paused');
        }, RESUME_DELAY);
    }

    sliderWrapper.addEventListener('pointerdown', pauseAnimation, { passive: true });
    sliderWrapper.addEventListener('pointerup', resumeAnimation, { passive: true });
    sliderWrapper.addEventListener('pointerleave', resumeAnimation, { passive: true });
    sliderWrapper.addEventListener('pointercancel', resumeAnimation, { passive: true });
    sliderWrapper.addEventListener('touchstart', pauseAnimation, { passive: true });
    sliderWrapper.addEventListener('touchend', resumeAnimation, { passive: true });
    sliderWrapper.addEventListener('touchcancel', resumeAnimation, { passive: true });

    if (window.matchMedia('(hover: hover)').matches) {
        sliderWrapper.addEventListener('mouseenter', pauseAnimation);
        sliderWrapper.addEventListener('mouseleave', resumeAnimation);
    }
}

// The nav bar calls this on every page, including this one, so it has to be
// available here too — this page does not load home.js.
function openLibrary(event) {
    if (event) event.preventDefault();
    window.location.href = 'library.html';
}

// ---------------------------------------------------------
// Plant library: server-side search, filtering and pagination
// ---------------------------------------------------------
const libraryState = {
    search: '',
    page: 1,
    pageSize: 12,
    total: 0
};

let librarySearchTimer = null;

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str == null ? '' : str);
    return div.innerHTML;
}

/**
 * The creation date as { iso, text }, or null when the API sent none (or
 * something that is not a date). The API field is dateUploaded (createdAt on
 * older responses).
 */
function formatCreatedAt(raw) {
    const when = raw ? new Date(raw) : null;
    if (!when || isNaN(when.getTime())) return null;
    return {
        iso: when.toISOString(),
        text: when.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    };
}

// Toxicity labels. Adjust the keys if your backend uses different levels
// (and update the matching .tox-* classes in library.css).
const TOXICITY_LABELS = {
    none: 'Non-toxic',
    low: 'Low toxicity',
    mild: 'Mild toxicity',
    moderate: 'Moderate toxicity',
    high: 'High toxicity',
    severe: 'Severe toxicity'
};

function toxicityInfo(level) {
    const key = String(level || 'none').toLowerCase();
    const label = TOXICITY_LABELS[key] ||
        (key.charAt(0).toUpperCase() + key.slice(1) + ' toxicity');
    return { key: key, label: label };
}

function renderPlantCards(plants) {
    const grid = document.getElementById('plantGrid');
    if (!grid) return;

    if (plants.length === 0) {
        grid.innerHTML = '<p class="library-empty">No plants match your search.</p>';
        return;
    }

    grid.innerHTML = plants.map(function (p) {
        const name = p.name.toUpperCase();
        const tox = toxicityInfo(p.toxicityLevel);
        const image = p.imageUrl
            ? `<img src="${escapeHtml(p.imageUrl)}" alt="${escapeHtml(p.name)} Plant">`
            : '<div class="image-box image-placeholder" aria-hidden="true">🌿</div>';

        // Harmful: the recorded "things to watch out for" text, or the type's
        // caution note if no text was recorded. Otherwise: the benefits.
        const d = p.description || {};
        const harmfulText = RichText.plain(d.harmful);   // card snippet: no paragraph marks
        const benefitsText = RichText.plain(d.benefits);
        const typeIsHarmful = Boolean(p.isHarmful) ||
            (p.toxicityLevel && p.toxicityLevel !== 'none');
        const isHarmful = harmfulText !== '' || typeIsHarmful;

        // The caution note belongs to the plant and shows whether or not it is
        // harmful. A harmful plant puts its own warning first; a safe plant with
        // a caution shows that; otherwise the benefits.
        const cautionText = RichText.plain(p.cautionNote);
        let noteText = '';
        let noteClass = 'is-benefit';
        let noteLabel = 'Benefits';
        if (isHarmful) {
            noteText = harmfulText || cautionText || 'Handle with care.';
            noteClass = 'is-harmful';
            noteLabel = '⚠ Things to watch out for';
        } else if (cautionText) {
            noteText = cautionText;
            noteClass = 'is-caution';
            noteLabel = 'Caution';
        } else {
            noteText = benefitsText;
        }

        // Always the same structure (label, fixed 3-line text area, "More"),
        // so the note sits in the same place on every card.
        const hasText = noteText !== '';
        const note = `<div class="plant-note ${noteClass}">
                   <span class="plant-note-label">${noteLabel}</span>
                   <div class="plant-note-text ${hasText ? '' : 'is-empty'}">${hasText ? escapeHtml(noteText) : 'No details added yet.'}</div>
                   <span class="plant-more">More <span aria-hidden="true">&rarr;</span></span>
               </div>`;

        // The creation date. A div, not a p: ".plant-grid .plant-card p" would
        // clamp it to 3 lines and pad it like a description. Left out entirely
        // when the API sent no (or an invalid) date.
        const added = formatCreatedAt(p.dateUploaded || p.createdAt);
        const dateRow = added
            ? `<div class="plant-card-date">
                   <span class="material-symbols-outlined" aria-hidden="true">calendar_today</span>
                   <time datetime="${escapeHtml(added.iso)}">Added ${escapeHtml(added.text)}</time>
               </div>`
            : '';

        return `
        <a class="plant-link" href="plant-profile.html?plantId=${encodeURIComponent(p.id)}"
           aria-label="${escapeHtml(p.name)} - view plant profile">
            <div class="plant-card">
                <div class="image-box">${image}</div>
                <h3>${escapeHtml(name)}</h3>
                <div class="plant-card-type">
                    <span class="plant-chip plant-chip-type">${escapeHtml(p.typeLabel || p.type || 'Unknown type')}</span>
                    <span class="plant-chip plant-chip-tox tox-${escapeHtml(tox.key)}">${escapeHtml(tox.label)}</span>
                </div>
                ${dateRow}
                ${note}
            </div>
        </a>`;
    }).join('');
}

function renderLibraryPagination() {
    const wrap = document.getElementById('libraryPagination');
    const info = document.getElementById('libraryPaginationInfo');
    const controls = document.getElementById('libraryPaginationControls');
    if (!wrap || !info || !controls) return;

    if (libraryState.total === 0) {
        wrap.hidden = true;
        return;
    }
    wrap.hidden = false;

    const totalPages = Math.max(1, Math.ceil(libraryState.total / libraryState.pageSize));
    const start = (libraryState.page - 1) * libraryState.pageSize + 1;
    const end = Math.min(libraryState.page * libraryState.pageSize, libraryState.total);
    info.innerHTML = `Showing <strong>${start}</strong> to <strong>${end}</strong> of <strong>${libraryState.total}</strong> plants`;

    let buttons = `<button class="page-btn" data-page="prev" ${libraryState.page === 1 ? 'disabled' : ''}>Prev</button>`;
    for (let p = 1; p <= totalPages; p++) {
        buttons += `<button class="page-btn ${p === libraryState.page ? 'active' : ''}" data-page="${p}">${p}</button>`;
    }
    buttons += `<button class="page-btn" data-page="next" ${libraryState.page === totalPages ? 'disabled' : ''}>Next</button>`;
    controls.innerHTML = buttons;

    controls.querySelectorAll('.page-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            const val = btn.dataset.page;
            if (val === 'prev') libraryState.page = Math.max(1, libraryState.page - 1);
            else if (val === 'next') libraryState.page = Math.min(totalPages, libraryState.page + 1);
            else libraryState.page = parseInt(val, 10);
            loadLibraryPlants();
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
    });
}

async function loadLibraryPlants() {
    const grid = document.getElementById('plantGrid');
    const params = new URLSearchParams();
    if (libraryState.search) params.set('search', libraryState.search);
    params.set('page', String(libraryState.page));

    try {
        const response = await fetch('/api/plants?' + params.toString(), { credentials: 'include' });
        if (!response.ok) throw new Error('Failed to load plants');
        const data = await response.json();

        libraryState.total = data.total || 0;
        libraryState.pageSize = data.pageSize || libraryState.pageSize;
        libraryState.page = data.page || 1;

        // A filter change can leave us past the end of the results.
        const totalPages = Math.max(1, Math.ceil(libraryState.total / libraryState.pageSize));
        if (libraryState.page > totalPages) {
            libraryState.page = totalPages;
            return loadLibraryPlants();
        }

        renderPlantCards(data.plants || []);
        renderLibraryPagination();
    } catch (err) {
        console.error('Load library plants error:', err);
        if (grid) {
            grid.innerHTML = '<p class="library-empty">Could not load the plant library.</p>';
        }
    }
}

// Debounced so typing does not fire a request per keystroke.
function filterPlants() {
    const input = document.getElementById('plantSearchInput');
    if (!input) return;

    libraryState.search = input.value.trim();
    libraryState.page = 1;
    clearTimeout(librarySearchTimer);
    librarySearchTimer = setTimeout(loadLibraryPlants, 300);
}

function handleSearchKey(event) {
    if (event.key === 'Enter') {
        const input = document.getElementById('plantSearchInput');
        const term = input.value.trim();
        if (term.length > 0) {
            saveRecentSearch(term);
            showRecentSearches();
        }
    }
}

function showRecentSearches() {
    const dropdown = document.getElementById('recentSearchesDropdown');
    const listContainer = document.getElementById('recentSearchesList');
    if (!dropdown || !listContainer) return;

    let searches = JSON.parse(localStorage.getItem('plantellect_recent_searches')) || [];
    
    if (searches.length === 0) {
        dropdown.style.display = 'none';
        return;
    }

    listContainer.innerHTML = '';
    searches.forEach(term => {
        const pill = document.createElement('div');
        pill.className = 'recent-search-pill';
        pill.innerHTML = `<span class="material-symbols-outlined">history</span> ${term}`;
        pill.onclick = function() {
            document.getElementById('plantSearchInput').value = term;
            filterPlants();
            dropdown.style.display = 'none';
        };
        listContainer.appendChild(pill);
    });

    dropdown.style.display = 'block';
}

function saveRecentSearch(term) {
    let searches = JSON.parse(localStorage.getItem('plantellect_recent_searches')) || [];
    // Remove if already exists to put it at the top
    searches = searches.filter(s => s.toLowerCase() !== term.toLowerCase());
    searches.unshift(term);
    // Keep max 5 recent searches
    if (searches.length > 5) searches.pop();
    localStorage.setItem('plantellect_recent_searches', JSON.stringify(searches));
}

function clearRecentSearches(event) {
    event.stopPropagation();
    localStorage.removeItem('plantellect_recent_searches');
    const dropdown = document.getElementById('recentSearchesDropdown');
    if (dropdown) dropdown.style.display = 'none';
}

// Hide dropdown when clicking outside the entire search container
document.addEventListener('click', function(e) {
    const searchContainer = document.querySelector('.library-search-container');
    const dropdown = document.getElementById('recentSearchesDropdown');
    if (searchContainer && dropdown && !searchContainer.contains(e.target)) {
        dropdown.style.display = 'none';
    }
});

// No auth call here: sidebar.js owns the header render and the single
// /api/auth/me fetch, so this page cannot show a stale signed-out header.
document.addEventListener('DOMContentLoaded', function() {
    initSliderAutoplayPause();

    loadLibraryPlants();
});