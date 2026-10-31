package com.plantellect.mobileplantellect.viewmodel

import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.plantellect.mobileplantellect.data.logic.*
import com.plantellect.mobileplantellect.data.remote.dto.*
import com.plantellect.mobileplantellect.data.repository.RecordRepository
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

/** One-shot "a submission just went through" signal; the screen clears its form and switches tab, then consumes it. */
enum class RecordDone { NEW_PLANT, CONTRIBUTION, TAXONOMY, CHANGE, WITHDRAWN }

data class RecordUiState(
    val busy: Boolean = false,
    val error: String? = null,
    val notice: String? = null,
    val submitted: PlantSubmitResponse? = null,
    val contributed: ContributionResponse? = null,
    val mine: List<MyRequestDto> = emptyList(),
    val mineLoading: Boolean = false,
    val mineEnd: Boolean = false,

    val maxPhotos: Int = UploadLimits.MAX_CONTRIBUTION_PHOTOS,
    /** Deduplicated: one entry per type, e.g. "Herbal (1)". */
    val types: List<RecTypeName> = emptyList(),
    val results: List<RecPlantItem> = emptyList(),
    val contribPlant: RecLookupPlant? = null,
    val duplicate: RecLookupPlant? = null,
    val editable: RecEditable? = null,
    val requests: List<RecMyRequest> = emptyList(),
    val requestsLoading: Boolean = false,
    val requestsEnd: Boolean = false,
    val completed: RecordDone? = null
)

class RecordPlantViewModel(private val repo: RecordRepository) : ViewModel() {
    private val _ui = MutableStateFlow(RecordUiState())
    val ui: StateFlow<RecordUiState> = _ui.asStateFlow()
    private var minePage = 0
    private var requestsPage = 0
    private var searchJob: Job? = null

    init { viewModelScope.launch { loadTypesNow() } }

    // ---- existing API (unchanged) -------------------------------------------

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

    fun absoluteUrl(path: String?) = repo.absoluteUrl(path)

    fun clearMessages() = _ui.update { it.copy(error = null, notice = null, submitted = null, contributed = null) }
    fun consumeCompleted() = _ui.update { it.copy(completed = null) }

    // ---- pickers ---------------------------------------------------------------

    fun search(query: String, typeName: String?) {
        searchJob?.cancel()
        searchJob = viewModelScope.launch {
            delay(300)
            (repo.searchPlants(query, typeName) as? ApiResult.Success)?.let { r -> _ui.update { it.copy(results = r.value) } }
        }
    }

    fun selectContribPlant(plantId: String) {
        viewModelScope.launch {
            when (val r = repo.lookupById(plantId)) {
                is ApiResult.Success ->
                    if (r.value.exists && r.value.plant != null) _ui.update { it.copy(contribPlant = r.value.plant, error = null) }
                    else _ui.update { it.copy(error = "That plant could not be found.") }
                is ApiResult.Failure -> fail(r.error)
            }
        }
    }

    fun clearContribPlant() = _ui.update { it.copy(contribPlant = null) }
    fun clearDuplicate() = _ui.update { it.copy(duplicate = null) }

    fun selectChangePlant(plantId: String) {
        _ui.update { it.copy(editable = null) }
        viewModelScope.launch {
            when (val r = repo.editable(plantId)) {
                is ApiResult.Success ->
                    if (r.value.archived == true) _ui.update { it.copy(error = "That plant is archived and cannot be changed.") }
                    else _ui.update { it.copy(editable = r.value, error = null) }
                is ApiResult.Failure -> fail(r.error)
            }
        }
    }

    fun clearEditable() = _ui.update { it.copy(editable = null) }

    // ---- submissions -----------------------------------------------------------

    fun submitNew(fields: Map<String, String>, photos: List<Uri>) = run {
        val sci = fields["scientificName"].orEmpty()
        val dup = (repo.lookupByName(sci) as? ApiResult.Success)?.value?.takeIf { it.exists }?.plant
        if (dup != null) {
            _ui.update {
                it.copy(busy = false, duplicate = dup,
                    error = "\"${dup.scientificName}\" is already in the library. Use \"Add to it instead\" so your text and photos go to that plant.")
            }
            return@run
        }
        when (val r = repo.submitPlantForm(fields, photos)) {
            is ApiResult.Success -> {
                var text = resultText(r.value, "Submission")
                r.value.scientificName?.takeIf { it != sci }?.let { text += " Stored as \"$it\"." }
                done(text, RecordDone.NEW_PLANT)
            }
            is ApiResult.Failure -> fail(r.error)
        }
    }

    fun submitContribution(plantId: String, fields: Map<String, String>, photos: List<Uri>) = run {
        when (val r = repo.contributeForm(plantId, fields, photos)) {
            is ApiResult.Success -> done(resultText(r.value, "Contribution"), RecordDone.CONTRIBUTION)
            is ApiResult.Failure -> fail(r.error)
        }
    }

    fun submitTaxonomy(plantId: String, levels: Map<String, String>, reason: String) = run {
        when (val r = repo.requestTaxonomy(plantId, levels, reason)) {
            is ApiResult.Success -> {
                _ui.update { s -> s.copy(contribPlant = s.contribPlant?.copy(hasPendingTaxonomyRequest = true)) }
                done("Taxonomy update sent for review as ${r.value.requestId}. It is reviewed separately from any description or photos.",
                    RecordDone.TAXONOMY)
            }
            is ApiResult.Failure -> fail(r.error)
        }
    }

    fun submitChange(plantId: String, body: JsonObject) = run {
        when (val r = repo.requestChange(plantId, body)) {
            is ApiResult.Success -> {
                val ids = r.value.requests.orEmpty().mapNotNull { it.requestId }.joinToString(" and ")
                    .ifBlank { r.value.requestId.orEmpty() }
                val plural = if ((r.value.requests?.size ?: 0) > 1) "s" else ""
                done("Change request$plural sent for review as $ids. Nothing changes until an admin decides each one.",
                    RecordDone.CHANGE)
            }
            is ApiResult.Failure -> fail(r.error)
        }
    }

    fun withdraw(requestId: String) = run {
        when (val r = repo.withdraw(requestId)) {
            is ApiResult.Success -> done("Submission withdrawn.", RecordDone.WITHDRAWN)
            is ApiResult.Failure -> { fail(r.error); fetchRequests(reset = true) }
        }
    }

    fun loadRequests(reset: Boolean = true) {
        if (_ui.value.requestsLoading || (!reset && _ui.value.requestsEnd)) return
        viewModelScope.launch { fetchRequests(reset) }
    }

    // ---- internals ---------------------------------------------------------------

    private suspend fun loadTypesNow() {
        (repo.types() as? ApiResult.Success)?.let { r -> _ui.update { it.copy(types = r.value.dedupeTypes()) } }
    }

    private suspend fun fetchRequests(reset: Boolean) {
        if (reset) requestsPage = 0
        _ui.update { it.copy(requestsLoading = true, requests = if (reset) emptyList() else it.requests, requestsEnd = false) }
        when (val r = repo.myRequests(requestsPage + 1)) {
            is ApiResult.Success -> {
                requestsPage += 1
                val got = r.value.requests.orEmpty()
                _ui.update {
                    val all = it.requests + got
                    it.copy(requestsLoading = false, requests = all,
                        requestsEnd = got.isEmpty() || ((r.value.total ?: 0) > 0 && all.size >= (r.value.total ?: 0)))
                }
            }
            is ApiResult.Failure -> _ui.update { it.copy(requestsLoading = false, error = r.error.userMessage()) }
        }
    }

    private suspend fun done(text: String, what: RecordDone) {
        _ui.update { it.copy(busy = false, notice = text, error = null, completed = what, duplicate = null) }
        loadTypesNow()
        fetchRequests(reset = true)
    }

    private fun resultText(r: RecSubmitResult, what: String): String {
        var t = if (r.autoApproved == true) "Approved automatically as ${r.requestId} — no human reviewed it."
        else "$what submitted for review as ${r.requestId}."
        val n = r.imageIds?.size ?: 0
        if (n > 0) t += " $n photo${if (n == 1) "" else "s"} sent for approval."
        r.warnings?.takeIf { it.isNotEmpty() }?.let { t += " " + it.joinToString(" ") }
        return t
    }

    private fun fail(e: AppError) = _ui.update { it.copy(busy = false, error = e.userMessage()) }

    private fun run(block: suspend () -> Unit) {
        if (_ui.value.busy) return
        _ui.update { it.copy(busy = true, error = null, notice = null) }
        viewModelScope.launch { block() }
    }
}

/** "Herbal", "herbal" and " Herbal " are one type: keep one entry with the highest plantCount. */
fun List<RecTypeName>.dedupeTypes(): List<RecTypeName> =
    groupBy { it.typeName.trim().lowercase() }
        .map { (_, g) ->
            val best = g.maxBy { it.plantCount ?: 0 }
            best.copy(typeName = best.typeName.trim(), plantCount = g.maxOf { it.plantCount ?: 0 })
        }
        .sortedWith(compareByDescending<RecTypeName> { it.plantCount ?: 0 }.thenBy { it.typeName.lowercase() })

/** Picker label, e.g. "Herbal (1)". */
fun RecTypeName.label(): String =
    typeName.replaceFirstChar { it.uppercase() } + " (${plantCount ?: 0})"