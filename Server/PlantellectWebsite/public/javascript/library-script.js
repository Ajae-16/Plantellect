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
    pageSize: 10,
    total: 0
};

let librarySearchTimer = null;

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str == null ? '' : str);
    return div.innerHTML;
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
        const image = p.imageUrl
            ? `<img src="${escapeHtml(p.imageUrl)}" alt="${escapeHtml(p.name)} Plant">`
            : '<div class="image-box image-placeholder" aria-hidden="true">🌿</div>';
        const caution = p.toxicityLevel && p.toxicityLevel !== 'none'
            ? `<p class="plant-card-caution">⚠ ${escapeHtml(p.cautionNote || 'Handle with care')}</p>`
            : '';

        return `
        <a href="plant-profile.html?plantId=${encodeURIComponent(p.id)}" style="text-decoration: none; color: inherit;">
            <div class="plant-card">
                <div class="image-box">${image}</div>
                <h3>${escapeHtml(name)}</h3>
                <p class="plant-card-type">${escapeHtml(p.typeLabel || p.type)}</p>
                ${caution}
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

document.addEventListener('DOMContentLoaded', async function() {
    initSliderAutoplayPause();

    const user = await checkAuth();
    updateNavForAuthState(user);

    loadLibraryPlants();
});