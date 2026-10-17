package com.plantellect.mobileplantellect.viewmodel

import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.plantellect.mobileplantellect.data.repository.ScanOutcome
import com.plantellect.mobileplantellect.data.repository.ScanRepository
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

    fun reset() { _state.value = ScanUiState.Idle }

    private fun run(uri: Uri, skipLocalGate: Boolean) {
        if (_state.value is ScanUiState.Scanning) return
        _state.value = ScanUiState.Scanning(uri)
        viewModelScope.launch {
            _state.value = ScanUiState.Done(uri, repo.scan(uri, skipLocalGate = skipLocalGate))
        }
    }
}
