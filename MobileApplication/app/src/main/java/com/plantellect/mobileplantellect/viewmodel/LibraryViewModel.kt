package com.plantellect.mobileplantellect.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.plantellect.mobileplantellect.data.logic.*
import com.plantellect.mobileplantellect.data.remote.dto.*
import com.plantellect.mobileplantellect.data.repository.PlantRepository
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch

data class LibraryUiState(
    val query: String = "",
    val typeId: String? = null,
    val types: List<PlantTypeDto> = emptyList(),
    val items: List<PlantSummaryDto> = emptyList(),
    val loading: Boolean = false,
    val endReached: Boolean = false,
    val error: String? = null
)

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

    private var page = 0
    private var loadJob: Job? = null

    init {
        viewModelScope.launch { (repo.types() as? ApiResult.Success)?.let { r -> _ui.update { it.copy(types = r.value) } } }
        reload()
    }

    fun setQuery(q: String) {
        _ui.update { it.copy(query = q) }
        loadJob?.cancel()
        loadJob = viewModelScope.launch { delay(300); fetch(reset = true) }   // debounce typing
    }

    fun setType(typeId: String?) { _ui.update { it.copy(typeId = typeId) }; reload() }

    fun reload() { loadJob?.cancel(); loadJob = viewModelScope.launch { fetch(reset = true) } }

    /** Call when the list scrolls near its end. */
    fun loadNextPage() {
        val s = _ui.value
        if (s.loading || s.endReached) return
        loadJob = viewModelScope.launch { fetch(reset = false) }
    }

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

    private suspend fun fetch(reset: Boolean) {
        if (reset) page = 0
        val s = _ui.value
        _ui.update { it.copy(loading = true, error = null, items = if (reset) emptyList() else it.items, endReached = if (reset) false else it.endReached) }
        when (val r = repo.list(s.query, s.typeId, page + 1)) {
            is ApiResult.Success -> {
                page += 1
                val got = r.value.items
                _ui.update {
                    it.copy(
                        loading = false,
                        items = it.items + got,
                        endReached = got.isEmpty() || (r.value.total > 0 && it.items.size + got.size >= r.value.total)
                    )
                }
            }
            is ApiResult.Failure -> _ui.update { it.copy(loading = false, error = r.error.userMessage()) }
        }
    }
}
