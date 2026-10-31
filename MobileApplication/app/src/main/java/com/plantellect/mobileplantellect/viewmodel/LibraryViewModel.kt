package com.plantellect.mobileplantellect.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.plantellect.mobileplantellect.data.logic.*
import com.plantellect.mobileplantellect.data.remote.dto.*
import com.plantellect.mobileplantellect.data.repository.PlantRepository
import com.plantellect.mobileplantellect.ui.screen.cardName
import com.plantellect.mobileplantellect.ui.screen.cardScientific
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch

/** What the search box matches against. */
enum class SearchBy(val label: String) {
    ALL("All names"),
    COMMON("Common name"),
    SCIENTIFIC("Scientific name")
}

data class LibraryUiState(
    val query: String = "",
    val searchBy: SearchBy = SearchBy.ALL,
    /** PlantTypeDto.typeName, the value the server filters on. */
    val typeName: String? = null,
    val types: List<PlantTypeDto> = emptyList(),
    /** Only the cards of the CURRENT page (at most [pageSize]). */
    val items: List<PlantSummaryDto> = emptyList(),
    val loading: Boolean = false,
    val error: String? = null,
    val page: Int = 1,
    val pageSize: Int = LibraryViewModel.PAGE_SIZE,
    /** Number of plants matching the search / filters, across all pages. */
    val total: Int = 0
) {
    val pageCount: Int get() = maxOf(1, (total + pageSize - 1) / pageSize)
    val hasPrev: Boolean get() = page > 1
    val hasNext: Boolean get() = page < pageCount
}

sealed interface PlantDetailState {
    data object None : PlantDetailState
    data object Loading : PlantDetailState
    data class Loaded(val plant: PlantDetailDto) : PlantDetailState
    data class Error(val message: String) : PlantDetailState
}

class LibraryViewModel(private val repo: PlantRepository) : ViewModel() {
    private val _ui = MutableStateFlow(LibraryUiState())
    val ui: StateFlow<LibraryUiState> = _ui.asStateFlow()

    private val _detail = MutableStateFlow<PlantDetailState>(PlantDetailState.None)
    val detail: StateFlow<PlantDetailState> = _detail.asStateFlow()

    /** Every plant matching the current search / filters; the UI shows 10 of them at a time. */
    private var all: List<PlantSummaryDto> = emptyList()
    private var loadJob: Job? = null

    init {
        viewModelScope.launch { (repo.types() as? ApiResult.Success)?.let { r -> _ui.update { it.copy(types = r.value) } } }
        reload()
    }

    fun setQuery(q: String) {
        _ui.update { it.copy(query = q) }
        loadJob?.cancel()
        loadJob = viewModelScope.launch { delay(250); fetchAll() }   // debounce typing
    }

    fun setSearchBy(by: SearchBy) { _ui.update { it.copy(searchBy = by) }; reload() }

    fun setType(typeName: String?) { _ui.update { it.copy(typeName = typeName) }; reload() }

    fun reload() { loadJob?.cancel(); loadJob = viewModelScope.launch { fetchAll() } }

    fun nextPage() { if (_ui.value.hasNext) goToPage(_ui.value.page + 1) }
    fun prevPage() { if (_ui.value.hasPrev) goToPage(_ui.value.page - 1) }

    fun goToPage(target: Int) {
        val s = _ui.value
        val p = target.coerceIn(1, s.pageCount)
        _ui.update { it.copy(page = p, items = pageSlice(p)) }
    }

    /** Kept so other screens that still call it compile. Pagination replaced infinite scroll. */
    fun loadNextPage() {}

    fun openPlant(plantId: String) {
        _detail.value = PlantDetailState.Loading
        viewModelScope.launch {
            _detail.value = when (val r = repo.detail(plantId)) {
                is ApiResult.Success -> PlantDetailState.Loaded(r.value)
                is ApiResult.Failure -> PlantDetailState.Error(r.error.userMessage())
            }
        }
    }

    fun closePlant() { _detail.value = PlantDetailState.None }

    fun imageUrl(p: PlantSummaryDto): String? = repo.heroUrl(p)
    fun imageUrl(plantId: String, imageId: String): String = repo.imageUrl(plantId, imageId)
    /** For PredictionDto.imageUrl from a scan result. */
    fun absoluteUrl(path: String?): String? = repo.absoluteUrl(path)

    private fun pageSlice(page: Int): List<PlantSummaryDto> =
        all.drop((page - 1) * PAGE_SIZE).take(PAGE_SIZE)

    /**
     * Search from the FIRST letter and by the chosen field. The server's "search" param is sent
     * as-is, then results are filtered here so a one-letter query matches names that START with it
     * (best matches first) and the common / scientific choice is respected.
     */
    private fun List<PlantSummaryDto>.applySearch(query: String, by: SearchBy): List<PlantSummaryDto> {
        val q = query.trim().lowercase()
        if (q.isEmpty()) return this
        fun fields(p: PlantSummaryDto): List<String> = when (by) {
            SearchBy.COMMON -> listOf(p.cardName)
            SearchBy.SCIENTIFIC -> listOf(p.cardScientific.orEmpty())
            SearchBy.ALL -> listOf(p.cardName, p.cardScientific.orEmpty())
        }.map { it.lowercase() }

        fun rank(p: PlantSummaryDto): Int {
            val f = fields(p)
            return when {
                f.any { it.startsWith(q) } -> 0                                   // starts with the typed letters
                f.any { n -> n.split(' ', '-').any { w -> w.startsWith(q) } } -> 1 // any word starts with them
                f.any { it.contains(q) } -> 2
                else -> 3
            }
        }
        return filter { rank(it) < 3 }.sortedBy { rank(it) }
    }

    /** Loads every server page for the current query / type, filters, then shows page 1. */
    private suspend fun fetchAll() {
        val s = _ui.value
        all = emptyList()
        _ui.update { it.copy(loading = true, error = null, items = emptyList(), page = 1, total = 0) }

        val collected = mutableListOf<PlantSummaryDto>()
        var serverPage = 1
        var rawLoaded = 0
        while (serverPage <= MAX_SERVER_PAGES) {
            when (val r = repo.list(s.query, s.typeName, serverPage)) {
                is ApiResult.Success -> {
                    val rows = r.value.plants
                    rawLoaded += rows.size
                    collected += rows
                    serverPage += 1
                    if (rows.isEmpty() || (r.value.total > 0 && rawLoaded >= r.value.total)) break
                }
                is ApiResult.Failure -> {
                    _ui.update { it.copy(loading = false, error = r.error.userMessage()) }
                    return
                }
            }
        }

        all = collected.distinctBy { it.id }.applySearch(s.query, s.searchBy)
        _ui.update { it.copy(loading = false, page = 1, total = all.size, items = pageSlice(1)) }
    }

    companion object {
        const val PAGE_SIZE = 10
        /** Safety stop so a misbehaving server can never loop forever. */
        private const val MAX_SERVER_PAGES = 100
    }
}