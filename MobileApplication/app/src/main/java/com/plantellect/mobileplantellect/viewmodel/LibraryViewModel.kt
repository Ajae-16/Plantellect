package com.plantellect.mobileplantellect.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.plantellect.mobileplantellect.data.logic.*
import com.plantellect.mobileplantellect.data.remote.dto.*
import com.plantellect.mobileplantellect.data.repository.DescriptionVoteRepository
import com.plantellect.mobileplantellect.data.repository.PlantProfileRepository
import com.plantellect.mobileplantellect.data.repository.PlantRepository
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

class LibraryViewModel(
    private val repo: PlantRepository,
    private val profiles: PlantProfileRepository,
    private val votes: DescriptionVoteRepository
) : ViewModel() {
    private val _ui = MutableStateFlow(LibraryUiState())
    val ui: StateFlow<LibraryUiState> = _ui.asStateFlow()

    private val _detail = MutableStateFlow<PlantDetailState>(PlantDetailState.None)
    val detail: StateFlow<PlantDetailState> = _detail.asStateFlow()

    /** Every plant matching the current search / filters; the UI shows 10 of them at a time. */
    private var all: List<PlantSummaryDto> = emptyList()
    private var loadJob: Job? = null

    /** Types as the server last listed them (GET /plants/types). */
    private var serverTypes: List<PlantTypeDto> = emptyList()

    /** Type names seen on the plants themselves: a new type shows in the filter even if the types list is stale. */
    private var seenTypeNames: Set<String> = emptySet()

    init {
        refreshTypes()
        refetch()
    }

    /**
     * Reads the plant types from the server again. The ViewModel lives as long as the Activity, so a type
     * added on the website after the app opened would never appear if this only ran once.
     * Called on start, on pull to refresh, and whenever the Library screen or its Filters panel opens.
     */
    fun refreshTypes() {
        viewModelScope.launch {
            (repo.types() as? ApiResult.Success)?.let { r ->
                serverTypes = r.value
                publishTypes()
            }
        }
    }

    /** Server types plus any type seen on a loaded plant, one chip per name (case-insensitive), A to Z. */
    private fun publishTypes() {
        val byKey = linkedMapOf<String, PlantTypeDto>()
        serverTypes.forEach { t ->
            val k = t.typeName.trim().lowercase()
            if (k.isNotEmpty() && k !in byKey) byKey[k] = t
        }
        seenTypeNames.forEach { n ->
            val k = n.trim().lowercase()
            if (k.isNotEmpty() && k !in byKey) byKey[k] = PlantTypeDto(typeId = "seen:$k", typeName = n.trim(), label = n.trim())
        }
        val merged = byKey.values.sortedBy { it.typeName.trim().lowercase() }
        _ui.update { it.copy(types = merged) }
    }

    fun setQuery(q: String) {
        _ui.update { it.copy(query = q) }
        loadJob?.cancel()
        loadJob = viewModelScope.launch { delay(250); fetchAll() }   // debounce typing
    }

    fun setSearchBy(by: SearchBy) { _ui.update { it.copy(searchBy = by) }; refetch() }

    fun setType(typeName: String?) { _ui.update { it.copy(typeName = typeName) }; refetch() }

    /** Pull to refresh: the plants AND the type list. */
    fun reload() { refreshTypes(); refetch() }

    /** Plants only (a filter or search change does not need the type list again). */
    private fun refetch() { loadJob?.cancel(); loadJob = viewModelScope.launch { fetchAll() } }

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

    // ---- one plant's full profile and the votes on its descriptions ----------------------

    /** Photo addresses from the server are paths like /resource/plant-images/display/...; this makes them absolute. */
    fun resolveUrl(path: String?): String? = profiles.resolveUrl(path)

    /** One plant's public profile, cached. [force] skips the cache. 404 comes back as [ProfileLoad.NotFound]. */
    suspend fun profile(plantId: String, force: Boolean = false): ProfileLoad = profiles.load(plantId, force)

    /** The plant's first photo, for a card whose list row carries none. Null when it has no photo. */
    suspend fun heroUrl(plantId: String): String? = profiles.heroUrl(plantId)

    /** Null when the votes could not be read. */
    suspend fun voteSummary(plantId: String): VoteSummary? = votes.summary(plantId)
    suspend fun voteUp(plantId: String, descriptionId: String): VoteResult = votes.up(plantId, descriptionId)
    suspend fun voteDown(plantId: String, descriptionId: String, reasonCode: String, note: String?): VoteResult =
        votes.down(plantId, descriptionId, reasonCode, note)
    suspend fun voteRetract(plantId: String, descriptionId: String): VoteResult = votes.retract(plantId, descriptionId)

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
            SearchBy.COMMON -> listOf(p.name)
            SearchBy.SCIENTIFIC -> listOf(p.scientificName.orEmpty())
            SearchBy.ALL -> listOf(p.name, p.scientificName.orEmpty())
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

        // Remember every type name on these plants so the filter always has a chip for it.
        seenTypeNames = seenTypeNames + collected.mapNotNull { (it.type.ifBlank { it.typeLabel }).trim().takeIf { n -> n.isNotEmpty() } }
        publishTypes()
        all = collected.distinctBy { it.id }.applySearch(s.query, s.searchBy)
        _ui.update { it.copy(loading = false, page = 1, total = all.size, items = pageSlice(1)) }
    }

    companion object {
        const val PAGE_SIZE = 10
        /** Safety stop so a misbehaving server can never loop forever. */
        private const val MAX_SERVER_PAGES = 100
    }
}