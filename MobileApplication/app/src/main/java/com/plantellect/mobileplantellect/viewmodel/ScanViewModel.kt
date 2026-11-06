package com.plantellect.mobileplantellect.viewmodel

import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.plantellect.mobileplantellect.data.local.SettingsStore
import com.plantellect.mobileplantellect.data.logic.AppError
import com.plantellect.mobileplantellect.data.remote.ExtrasResult
import com.plantellect.mobileplantellect.data.remote.ReportHint
import com.plantellect.mobileplantellect.data.remote.ReportSummary
import com.plantellect.mobileplantellect.data.remote.dto.ScanVerdict
import com.plantellect.mobileplantellect.data.repository.ScanOutcome
import com.plantellect.mobileplantellect.data.repository.ScanRepository
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

sealed interface ScanUiState {
    data object Idle : ScanUiState
    /** [retryInSeconds] is set while the server was unreachable and the scan waits to try it again. */
    data class Scanning(val uri: Uri, val retryInSeconds: Int? = null) : ScanUiState
    data class Done(val uri: Uri, val outcome: ScanOutcome) : ScanUiState
}

// ------------------------------------------------------------------ "Help improve the ML"

enum class ContributePhase { OFFER, SENDING, DONE, REFUSED }
enum class MessageTone { INFO, SUCCESS, ERROR }

/** The contribution card. Null = no card (no offer, or it was skipped / closed). */
data class ContributionUi(
    val phase: ContributePhase,
    val speciesName: String,
    val message: String? = null,
    val tone: MessageTone = MessageTone.INFO,
    /** True for a plant the model has no class for: there is no species to name, only a confidence. */
    val otherPlant: Boolean = false,
    /** The server's own confidence for the offer (0..1). */
    val confidence: Double? = null
)

// ------------------------------------------------------------------ "Not identified?" report

data class ReportUi(
    val summary: ReportSummary? = null,
    val loadingSummary: Boolean = false,
    val sending: Boolean = false,
    /** True once this photo has been reported: the form is replaced by [message]. */
    val sent: Boolean = false,
    /** Id of the report just filed from this screen. Set while [sent], so it can be withdrawn. */
    val requestId: String? = null,
    val withdrawing: Boolean = false,
    val message: String? = null,
    val isError: Boolean = false
)

class ScanViewModel(
    private val repo: ScanRepository,
    private val settings: SettingsStore
) : ViewModel() {
    private val _state = MutableStateFlow<ScanUiState>(ScanUiState.Idle)
    val state: StateFlow<ScanUiState> = _state.asStateFlow()

    private val _contribution = MutableStateFlow<ContributionUi?>(null)
    val contribution: StateFlow<ContributionUi?> = _contribution.asStateFlow()

    private val _report = MutableStateFlow(ReportUi())
    val report: StateFlow<ReportUi> = _report.asStateFlow()

    /** [uri] from CameraX (Uri.fromFile) or the photo picker. */
    fun scan(uri: Uri) = run(uri, skipLocalGate = false)

    /** For the "this is a plant, scan anyway" button on a NotAPlant result. */
    fun scanAnyway(uri: Uri) = run(uri, skipLocalGate = true)

    private var job: Job? = null
    private var reportJob: Job? = null
    private var lastSkipGate = false

    /** Back to the camera. Also cancels a scan that is still running. */
    fun reset() {
        job?.cancel()
        reportJob?.cancel()
        _contribution.value = null
        _report.value = ReportUi()
        _state.value = ScanUiState.Idle
    }

    /** Runs the same photo again (the Retry button). */
    fun retry(uri: Uri) = run(uri, skipLocalGate = lastSkipGate)

    private fun run(uri: Uri, skipLocalGate: Boolean) {
        if (_state.value is ScanUiState.Scanning) return
        lastSkipGate = skipLocalGate
        // A new scan ends the old offer (it is bound to the old photo's bytes) and the old report form.
        _contribution.value = null
        reportJob?.cancel()
        _report.value = ReportUi()
        _state.value = ScanUiState.Scanning(uri)
        job = viewModelScope.launch {
            val outcome = try {
                repo.scan(uri, skipLocalGate = skipLocalGate) { left ->
                    _state.update { s -> if (s is ScanUiState.Scanning) s.copy(retryInSeconds = left) else s }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                // Never leave the screen stuck on "Analyzing..."
                ScanOutcome.Failed(AppError.Unexpected(e.message ?: "Scan failed"))
            }
            _contribution.value = offerFor(outcome)
            _state.value = ScanUiState.Done(uri, outcome)
            // Settings > Privacy > "Help improve": send the offered photo without the person tapping the button.
            if (_contribution.value != null && settings.autoContribute.value) contribute()
        }
    }

    // ============================================================== Help improve the ML

    /**
     * The server adds `contribute_offer` only when every one of its own rules holds (contributions on,
     * identified, species in the library or "other plant" allowed, confidence over the bar). The app only
     * checks it is there and agrees with the outcome.
     */
    private fun offerFor(outcome: ScanOutcome): ContributionUi? {
        val server = outcome as? ScanOutcome.Server ?: return null
        if (server.uploadedJpeg == null) return null
        val offer = server.response.contributeOffer ?: return null
        if (offer.token.isBlank()) return null
        // An "other plant" offer (a plant the model has no class for) goes with an unrecognized outcome,
        // like the website's card; a species offer goes with an identified one.
        if (offer.isOtherPlant) {
            if (server.response.outcome != "unrecognized") return null
            return ContributionUi(ContributePhase.OFFER, "this plant", otherPlant = true, confidence = offer.confidence)
        }
        if (server.response.verdict() != ScanVerdict.IDENTIFIED) return null
        val top = server.response.predictions.firstOrNull() ?: return null
        return ContributionUi(
            ContributePhase.OFFER, top.displayName.ifBlank { top.scientificName }, confidence = offer.confidence
        )
    }

    fun contribute() {
        val current = _contribution.value ?: return
        if (current.phase == ContributePhase.SENDING) return
        val server = (_state.value as? ScanUiState.Done)?.outcome as? ScanOutcome.Server ?: return
        val jpeg = server.uploadedJpeg ?: return
        val token = server.response.contributeOffer?.token ?: return

        _contribution.value = current.copy(phase = ContributePhase.SENDING, message = null)
        viewModelScope.launch {
            val result = repo.contribute(jpeg, token)
            // The person moved on to another photo meanwhile: nothing left to show.
            val now = _contribution.value ?: return@launch
            if (now.phase != ContributePhase.SENDING) return@launch
            _contribution.value = when (result) {
                is ExtrasResult.Ok -> now.copy(
                    phase = ContributePhase.DONE,
                    tone = MessageTone.SUCCESS,
                    message = "Thank you! Your photo of ${now.speciesName} will help the model learn. " +
                            "It is used only for training and is never shown publicly."
                )
                is ExtrasResult.NoNetwork -> now.copy(
                    phase = ContributePhase.OFFER,
                    tone = MessageTone.ERROR,
                    message = "Could not reach the server. The photo was not sent."
                )
                is ExtrasResult.Refused -> when {
                    result.reason in DONE_REASONS -> now.copy(
                        phase = ContributePhase.DONE,
                        tone = if (result.reason == "already_contributed") MessageTone.SUCCESS else MessageTone.INFO,
                        message = result.message
                    )
                    // Nothing was refused on merit: the buttons come back so the person can try again.
                    result.reason in RETRY_REASONS ||
                            (result.status >= 500 && result.reason != "contribute_unavailable") -> now.copy(
                        phase = ContributePhase.OFFER,
                        tone = MessageTone.ERROR,
                        message = result.message
                    )
                    // A cap, an expired offer, the setting turned off...: say why, no retry.
                    else -> now.copy(
                        phase = ContributePhase.REFUSED,
                        tone = if (result.reason in LIMIT_REASONS) MessageTone.INFO else MessageTone.ERROR,
                        message = result.message
                    )
                }
            }
        }
    }

    /** Skip / Close: the offer is dropped with the card. */
    fun dismissContribution() {
        _contribution.value = null
    }

    // ============================================================== Not identified? report

    /** Called the first time the report card is opened, so a normal scan costs no extra request. */
    fun loadReportSummary() {
        val r = _report.value
        if (r.summary != null || r.loadingSummary) return
        _report.value = r.copy(loadingSummary = true)
        viewModelScope.launch {
            val result = repo.reportSummary()
            _report.value = when (result) {
                is ExtrasResult.Ok -> _report.value.copy(summary = result.value, loadingSummary = false)
                // The summary is only a courtesy; the server still enforces the cap when sending.
                else -> _report.value.copy(loadingSummary = false)
            }
        }
    }

    /** [note] is already composed from the ticked clues + the free text. */
    fun submitReport(note: String, location: String, allowContribution: Boolean) {
        val done = _state.value as? ScanUiState.Done ?: return
        val r = _report.value
        if (r.sending || r.sent || r.summary?.atCap == true) return

        _report.value = r.copy(sending = true, message = null, isError = false)
        reportJob = viewModelScope.launch {
            val jpeg = (done.outcome as? ScanOutcome.Server)?.uploadedJpeg
            val result = repo.fileReport(
                uri = done.uri,
                knownJpeg = jpeg,
                note = note.trim(),
                location = location.trim(),
                hints = hintsFor(done.outcome),
                allowContribution = allowContribution
            )
            _report.value = when (result) {
                is ExtrasResult.Ok -> {
                    val receipt = result.value
                    _report.value.copy(
                        sending = false,
                        sent = true,
                        requestId = receipt.requestId.takeIf { it.isNotBlank() },
                        isError = false,
                        summary = _report.value.summary?.copy(open = receipt.openReports, limit = receipt.maxOpenReports),
                        message = "Sent. A contributor will pick it up from the queue. " +
                                "You have ${receipt.openReports} of ${receipt.maxOpenReports} reports open."
                    )
                }
                is ExtrasResult.NoNetwork -> _report.value.copy(
                    sending = false, isError = true,
                    message = "Could not reach the server. Nothing was sent."
                )
                // 429 = filing cooldown, 409 = open-report cap. The server's own words say what to do.
                is ExtrasResult.Refused -> _report.value.copy(
                    sending = false, isError = true, message = result.message
                )
            }
        }
    }

    /**
     * Withdraws the report just filed from this screen. The server only allows it while the report is
     * still waiting and inside its grace window; otherwise its own message is shown and the report stays.
     */
    fun withdrawReport() {
        val r = _report.value
        val id = r.requestId ?: return
        if (r.withdrawing) return

        _report.value = r.copy(withdrawing = true, message = null, isError = false)
        reportJob = viewModelScope.launch {
            _report.value = when (val result = repo.withdrawReport(id)) {
                is ExtrasResult.Ok -> _report.value.copy(
                    withdrawing = false,
                    sent = false,           // the form comes back, so the person can file another
                    requestId = null,
                    isError = false,
                    summary = _report.value.summary?.let { it.copy(open = (it.open - 1).coerceAtLeast(0)) },
                    message = "Report withdrawn. You can file another."
                )
                is ExtrasResult.NoNetwork -> _report.value.copy(
                    withdrawing = false, isError = true,
                    message = "Could not reach the server. Nothing was withdrawn."
                )
                is ExtrasResult.Refused -> _report.value.copy(
                    withdrawing = false, isError = true, message = result.message
                )
            }
        }
    }

    /** What the model almost thought it was. Rides along as a hint for the contributor, never as an answer. */
    private fun hintsFor(outcome: ScanOutcome): List<ReportHint> = when (outcome) {
        is ScanOutcome.Server -> outcome.response.predictions.map {
            ReportHint(it.scientificName, it.displayName.takeIf { n -> n.isNotBlank() && n != it.scientificName }, it.confidence)
        }
        is ScanOutcome.OnDevice -> outcome.local.top
            .filter { it.kind != "non_plant" && it.kind != "other_plant" }
            .map { ReportHint(it.scientificName, null, it.confidence.toDouble()) }
        is ScanOutcome.NotAPlant, is ScanOutcome.RateLimited, is ScanOutcome.Failed -> emptyList()
    }

    private companion object {
        // Same sets the website's scan.js uses.
        val RETRY_REASONS = setOf("network", "server_error", "save_failed")
        val DONE_REASONS = setOf("already_contributed", "already_in_library")
        val LIMIT_REASONS = setOf("daily_cap", "species_cap")
    }
}
