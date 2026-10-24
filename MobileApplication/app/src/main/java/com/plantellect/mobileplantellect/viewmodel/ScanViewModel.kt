package com.plantellect.mobileplantellect.viewmodel

import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.plantellect.mobileplantellect.data.repository.ScanOutcome
import com.plantellect.mobileplantellect.data.repository.ScanRepository
import com.plantellect.mobileplantellect.data.logic.AppError
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

sealed interface ScanUiState {
    data object Idle : ScanUiState
    data class Scanning(val uri: Uri) : ScanUiState
    data class Done(val uri: Uri, val outcome: ScanOutcome) : ScanUiState
}

class ScanViewModel(private val repo: ScanRepository) : ViewModel() {
    private val _state = MutableStateFlow<ScanUiState>(ScanUiState.Idle)
    val state: StateFlow<ScanUiState> = _state.asStateFlow()

    /** [uri] from CameraX (Uri.fromFile) or the photo picker. */
    fun scan(uri: Uri) = run(uri, skipLocalGate = false)

    /** For the "this is a plant, scan anyway" button on a NotAPlant result. */
    fun scanAnyway(uri: Uri) = run(uri, skipLocalGate = true)

    private var job: Job? = null
    private var lastSkipGate = false

    /** Back to the camera. Also cancels a scan that is still running. */
    fun reset() {
        job?.cancel()
        _state.value = ScanUiState.Idle
    }

    /** Runs the same photo again (the Retry button). */
    fun retry(uri: Uri) = run(uri, skipLocalGate = lastSkipGate)

    private fun run(uri: Uri, skipLocalGate: Boolean) {
        if (_state.value is ScanUiState.Scanning) return
        lastSkipGate = skipLocalGate
        _state.value = ScanUiState.Scanning(uri)
        job = viewModelScope.launch {
            val outcome = try {
                repo.scan(uri, skipLocalGate = skipLocalGate)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                // Never leave the screen stuck on "Analyzing..."
                ScanOutcome.Failed(AppError.Unexpected(e.message ?: "Scan failed"))
            }
            _state.value = ScanUiState.Done(uri, outcome)
        }
    }
}
