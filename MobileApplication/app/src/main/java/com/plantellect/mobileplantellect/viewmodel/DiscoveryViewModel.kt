package com.plantellect.mobileplantellect.viewmodel

import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.plantellect.mobileplantellect.data.logic.*
import com.plantellect.mobileplantellect.data.remote.dto.*
import com.plantellect.mobileplantellect.data.repository.DiscoveryRepository
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch

data class DiscoveryUiState(
    val busy: Boolean = false,
    val error: String? = null,
    val notice: String? = null,
    /** Seconds until another report may be filed (429 cooldown), if the server said so. */
    val cooldownSeconds: Int? = null,
    // botanist side
    val queue: List<DiscoveryCardDto> = emptyList(),
    val unclaimed: Int = 0,
    val reasons: List<DisqualifyReason> = emptyList(),
    // reporter side
    val myReports: List<MyDiscoveryReportDto> = emptyList(),
    val mySummary: MyDiscoverySummaryDto? = null
)

/**
 * One ViewModel for the Discovery screen: any signed-in user can file and track reports;
 * only accounts with record_plant also load and work the queue (everything else would 403).
 */
class DiscoveryViewModel(
    private val repo: DiscoveryRepository,
    private val isBotanist: () -> Boolean
) : ViewModel() {
    private val _ui = MutableStateFlow(DiscoveryUiState())
    val ui: StateFlow<DiscoveryUiState> = _ui.asStateFlow()

    init { refresh() }

    fun refresh() {
        viewModelScope.launch {
            (repo.myReports(1) as? ApiResult.Success)?.let { r -> _ui.update { it.copy(myReports = r.value.reports) } }
            (repo.mySummary() as? ApiResult.Success)?.let { r -> _ui.update { it.copy(mySummary = r.value) } }
            if (isBotanist()) refreshQueue()
        }
    }

    fun refreshQueue() {
        viewModelScope.launch {
            when (val q = repo.queue(1)) {
                is ApiResult.Success -> _ui.update { it.copy(queue = q.value.requests) }
                is ApiResult.Failure -> fail(q.error)
            }
            (repo.count() as? ApiResult.Success)?.let { r -> _ui.update { it.copy(unclaimed = r.value.unclaimed) } }
            if (_ui.value.reasons.isEmpty()) {
                (repo.reasons() as? ApiResult.Success)?.let { r -> _ui.update { it.copy(reasons = r.value) } }
            }
        }
    }

    /** From the scan screen's "not in the library" result: pass the scan's predictions along. */
    fun fileReport(note: String?, location: String?, photos: List<Uri>, scanPredictions: List<PredictionDto> = emptyList()) =
        run {
            when (val r = repo.fileReport(note, location, photos, scanPredictions)) {
                is ApiResult.Success -> { notice(r.value.message.ifBlank { "Report filed." }); refresh() }
                is ApiResult.Failure -> fail(r.error)
            }
        }

    fun cancel(id: String) = act(id, "Report withdrawn") { repo.cancel(it) }

    // botanist actions: the server enforces who may do what and answers 409 with the reason
    fun claim(id: String) = act(id, "Claimed") { repo.claim(it) }
    fun unclaim(id: String) = act(id, "Claim released") { repo.unclaim(it) }
    fun release(id: String) = act(id, "Claim released") { repo.release(it) }
    fun resolve(id: String) = act(id, "Marked resolved") { repo.resolve(it) }
    fun reopen(id: String) = act(id, "Reopened") { repo.reopen(it) }
    fun reinstate(id: String) = act(id, "Reinstated") { repo.reinstate(it) }
    fun vote(id: String) = act(id, "Vote recorded") { repo.vote(it) }
    fun disqualify(id: String, reason: String) = act(id, "Recorded as not a plant") { repo.disqualify(it, reason) }

    fun ownerImageUrl(imageId: String) = repo.ownerImageUrl(imageId)
    fun reportImageUrl(imageId: String) = repo.reportImageUrl(imageId)
    fun clearMessages() = _ui.update { it.copy(error = null, notice = null) }

    private fun act(id: String, done: String, call: suspend (String) -> ApiResult<MessageDto>) = run {
        when (val r = call(id)) {
            is ApiResult.Success -> { notice(done); refresh() }
            is ApiResult.Failure -> fail(r.error)
        }
    }

    private fun notice(text: String) = _ui.update { it.copy(busy = false, notice = text, error = null, cooldownSeconds = null) }

    private fun fail(e: AppError) = _ui.update {
        it.copy(busy = false, error = e.userMessage(), cooldownSeconds = (e as? AppError.Http)?.retryAfterSeconds)
    }

    private fun run(block: suspend () -> Unit) {
        if (_ui.value.busy) return
        _ui.update { it.copy(busy = true, error = null, notice = null) }
        viewModelScope.launch { block() }
    }
}
