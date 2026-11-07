package com.plantellect.mobileplantellect.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.plantellect.mobileplantellect.data.logic.ApiResult
import com.plantellect.mobileplantellect.data.remote.dto.AboutDto
import com.plantellect.mobileplantellect.data.remote.dto.AboutSectionDto
import com.plantellect.mobileplantellect.data.repository.AboutRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class AboutUiState(
    /** What the server last said; until then (or when it cannot be reached) the copy bundled with the app. */
    val about: AboutDto = BundledAbout,
    /** True once [about] came from the server. */
    val fromServer: Boolean = false
)

/** The same words the server sends, kept in the app so the About section is never empty offline. */
val BundledAbout = AboutDto(
    title = "About Plantellect",
    intro = "Welcome to Plantellect\u2014your digital community companion for exploring and viewing plants identified " +
        "through their leaves and stems, empowering you to explore the flora within your community.",
    sections = listOf(
        AboutSectionDto(
            "what-we-do", "What we do",
            "Plantellect is a dedicated community platform where users can explore and view plants uploaded by " +
                "individuals who hold authority within the system. By focusing on key vegetative traits like stems " +
                "and leaves, our platform connects you with plant entries to help you discover the flora right around you."
        ),
        AboutSectionDto(
            "our-mission", "Our mission",
            "We aim to make botany accessible, educational, and engaging for students, gardeners, and nature " +
                "enthusiasts alike. By centering around a collaborative community and focusing on physical traits like " +
                "stems and leaves, Plantellect empowers users to explore the flora within their community."
        ),
        AboutSectionDto(
            "community", "Community and contributions",
            "Our library is powered by contributions from individuals who have been granted authority to upload " +
                "within the system. Users can easily browse these uploaded profiles to discover species names, " +
                "classifications, and detailed descriptions of local plant life."
        )
    )
)

class AboutViewModel(private val repo: AboutRepository) : ViewModel() {
    private val _ui = MutableStateFlow(AboutUiState())
    val ui: StateFlow<AboutUiState> = _ui.asStateFlow()

    init { reload() }

    /** Asks the server again. A failed or empty answer keeps whatever is already showing. */
    fun reload() {
        viewModelScope.launch {
            val r = repo.about()
            if (r is ApiResult.Success && r.value.sections.isNotEmpty()) {
                _ui.update { it.copy(about = r.value, fromServer = true) }
            }
        }
    }
}
