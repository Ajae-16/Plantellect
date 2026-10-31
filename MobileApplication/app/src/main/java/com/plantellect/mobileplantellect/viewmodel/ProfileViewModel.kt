package com.plantellect.mobileplantellect.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.plantellect.mobileplantellect.data.logic.*
import com.plantellect.mobileplantellect.data.repository.ProfileRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** What the profile screen needs from one report. */
data class ReportItem(
    val requestId: String,
    val state: String,
    val submittedAt: String?,
    val note: String?,
    val location: String?,
    val voterCount: Int,
    val plantUrl: String?
)

data class ReportsUiState(
    val loading: Boolean = false,
    val reports: List<ReportItem> = emptyList(),
    val page: Int = 1,
    val pageSize: Int = ProfileRepository.REPORTS_PAGE_SIZE,
    val total: Int = 0,
    /** Same role as #myReportsNotice on the web page. */
    val notice: String? = null,
    val withdrawingId: String? = null
) {
    val pageCount: Int get() = maxOf(1, (total + pageSize - 1) / pageSize)
    val hasPrev: Boolean get() = page > 1
    val hasNext: Boolean get() = page * pageSize < total
}

class ProfileViewModel(private val repo: ProfileRepository) : ViewModel() {

    private val _state = MutableStateFlow(ReportsUiState())
    val state: StateFlow<ReportsUiState> = _state.asStateFlow()

    fun load(page: Int = _state.value.page) {
        _state.update { it.copy(loading = true) }
        viewModelScope.launch {
            when (val r = repo.myReports(page)) {
                is ApiResult.Success -> {
                    val data = r.value
                    _state.update {
                        it.copy(
                            loading = false,
                            // The only place that reads the DTO's report fields.
                            reports = data.reports.map { rep ->
                                ReportItem(
                                    requestId = rep.requestId,
                                    state = rep.state,
                                    submittedAt = rep.submittedAt,
                                    note = rep.note,
                                    location = rep.location,
                                    voterCount = rep.voterCount,
                                    plantUrl = rep.plantUrl
                                )
                            },
                            page = data.page,
                            pageSize = data.pageSize,
                            total = data.total,
                            notice = null
                        )
                    }
                }
                is ApiResult.Failure -> _state.update {
                    it.copy(loading = false, reports = emptyList(), notice = "Your reports could not be loaded.")
                }
            }
        }
    }

    fun nextPage() { if (_state.value.hasNext) load(_state.value.page + 1) }
    fun prevPage() { if (_state.value.hasPrev) load(_state.value.page - 1) }

    fun withdraw(requestId: String) {
        if (_state.value.withdrawingId != null) return
        _state.update { it.copy(withdrawingId = requestId) }
        viewModelScope.launch {
            val message = when (val r = repo.withdraw(requestId)) {
                is ApiResult.Success -> null
                is ApiResult.Failure -> r.error.userMessage()
            }
            _state.update { it.copy(withdrawingId = null, notice = message) }
            // Reload either way, like the web page: the server's answer is the truth.
            load()
        }
    }
}