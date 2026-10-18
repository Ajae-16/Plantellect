package com.plantellect.mobileplantellect.viewmodel

import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.plantellect.mobileplantellect.data.logic.*
import com.plantellect.mobileplantellect.data.remote.dto.*
import com.plantellect.mobileplantellect.data.repository.RecordRepository
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch

data class RecordUiState(
    val busy: Boolean = false,
    val error: String? = null,
    /** Last successful submission, for a confirmation screen. autoApproved says whether anyone reviewed it. */
    val submitted: PlantSubmitResponse? = null,
    val contributed: ContributionResponse? = null,
    val mine: List<MyRequestDto> = emptyList(),
    val mineLoading: Boolean = false,
    val mineEnd: Boolean = false
)

class RecordPlantViewModel(private val repo: RecordRepository) : ViewModel() {
    private val _ui = MutableStateFlow(RecordUiState())
    val ui: StateFlow<RecordUiState> = _ui.asStateFlow()
    private var minePage = 0

    /** A duplicate species is fine: the server turns it into a contribution at approval time. */
    fun submitPlant(draft: PlantDraftRequest) = run {
        when (val r = repo.submitPlant(draft)) {
            is ApiResult.Success -> _ui.update { it.copy(busy = false, submitted = r.value, contributed = null) }
            is ApiResult.Failure -> fail(r.error)
        }
    }

    fun contribute(
        plantId: String, parts: PlantPartsInput?, uses: String?, benefits: String?, harmful: String?,
        photos: List<Uri>, discoveryRequestId: String? = null
    ) = run {
        when (val r = repo.contribute(plantId, parts, uses, benefits, harmful, photos, discoveryRequestId)) {
            is ApiResult.Success -> _ui.update { it.copy(busy = false, contributed = r.value, submitted = null) }
            is ApiResult.Failure -> fail(r.error)
        }
    }

    fun loadMine(reset: Boolean = true) {
        if (_ui.value.mineLoading || (!reset && _ui.value.mineEnd)) return
        if (reset) minePage = 0
        _ui.update { it.copy(mineLoading = true, error = null, mine = if (reset) emptyList() else it.mine, mineEnd = false) }
        viewModelScope.launch {
            when (val r = repo.mySubmissions(minePage + 1)) {
                is ApiResult.Success -> {
                    minePage += 1
                    _ui.update {
                        val all = it.mine + r.value.requests
                        it.copy(mineLoading = false, mine = all,
                            mineEnd = r.value.requests.isEmpty() || (r.value.total > 0 && all.size >= r.value.total))
                    }
                }
                is ApiResult.Failure -> _ui.update { it.copy(mineLoading = false, error = r.error.userMessage()) }
            }
        }
    }

    /** For MyRequestImageDto.url. */
    fun absoluteUrl(path: String?) = repo.absoluteUrl(path)
    fun clearMessages() = _ui.update { it.copy(error = null, submitted = null, contributed = null) }

    private fun fail(e: AppError) = _ui.update { it.copy(busy = false, error = e.userMessage()) }

    private fun run(block: suspend () -> Unit) {
        if (_ui.value.busy) return
        _ui.update { it.copy(busy = true, error = null) }
        viewModelScope.launch { block() }
    }
}
