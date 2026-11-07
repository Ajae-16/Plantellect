package com.plantellect.mobileplantellect.viewmodel

import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.plantellect.mobileplantellect.data.logic.*
import com.plantellect.mobileplantellect.data.remote.dto.ApprovalsDto
import com.plantellect.mobileplantellect.data.remote.dto.BotanistProfileDto
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

/** The public profile of whoever the screen is showing (yourself or another botanist). */
data class BotanistUiState(
    val loading: Boolean = false,
    val profile: BotanistProfileDto? = null,
    val error: String? = null
)

/** The Pending approval tab: changes waiting for my answer, and the changes I asked for. */
data class ApprovalsUiState(
    val loading: Boolean = false,
    val loaded: Boolean = false,
    val data: ApprovalsDto = ApprovalsDto(),
    /** The number shown next to Profile in the sidebar. */
    val badge: Int = 0,
    /** Request being answered right now. */
    val answeringId: String? = null,
    val message: ProfileMessage? = null
)

/** Result line for one action on the profile (bio / password / photo). */
data class ProfileMessage(val text: String, val isError: Boolean)

/** State of the "edit my profile" actions. The account itself (bio, photoUrl) comes from AuthViewModel.authState. */
data class ProfileEditState(
    val savingBio: Boolean = false,
    val changingPassword: Boolean = false,
    val changingEmail: Boolean = false,
    val uploadingPhoto: Boolean = false,
    val bioMessage: ProfileMessage? = null,
    val passwordMessage: ProfileMessage? = null,
    val emailMessage: ProfileMessage? = null,
    val photoMessage: ProfileMessage? = null
) {
    val busy: Boolean get() = savingBio || changingPassword || changingEmail || uploadingPhoto
}

class ProfileViewModel(private val repo: ProfileRepository) : ViewModel() {

    private val _state = MutableStateFlow(ReportsUiState())
    val state: StateFlow<ReportsUiState> = _state.asStateFlow()

    private val _edit = MutableStateFlow(ProfileEditState())
    val edit: StateFlow<ProfileEditState> = _edit.asStateFlow()

    private val _approvals = MutableStateFlow(ApprovalsUiState())
    val approvals: StateFlow<ApprovalsUiState> = _approvals.asStateFlow()

    private val _botanist = MutableStateFlow(BotanistUiState())
    val botanist: StateFlow<BotanistUiState> = _botanist.asStateFlow()

    // ---- pending approvals ---------------------------------------------------

    /** Cheap: only the number for the sidebar. Quiet on failure (the old number stays). */
    fun refreshBadge() {
        viewModelScope.launch {
            (repo.approvalCount() as? ApiResult.Success)?.let { r -> _approvals.update { it.copy(badge = r.value.count) } }
        }
    }

    /** The full lists for the tab. */
    fun loadApprovals() {
        if (_approvals.value.loading) return
        _approvals.update { it.copy(loading = true) }
        viewModelScope.launch {
            when (val r = repo.approvals()) {
                is ApiResult.Success -> _approvals.update {
                    it.copy(loading = false, loaded = true, data = r.value, badge = r.value.badge)
                }
                is ApiResult.Failure -> _approvals.update {
                    it.copy(loading = false, message = ProfileMessage("Your pending approvals could not be loaded.", true))
                }
            }
        }
    }

    /**
     * The person opened the tab, so what they asked for and has now been answered stops counting as new.
     * Their own waiting-for-me items keep counting until they answer.
     */
    fun markApprovalsSeen() {
        if (_approvals.value.data.mine.none { it.unread }) return
        viewModelScope.launch {
            repo.approvalsSeen()
            refreshBadge()
        }
    }

    /** Approve or decline a change to my own description. */
    fun answerChange(requestId: String, approve: Boolean, note: String?) {
        if (_approvals.value.answeringId != null) return
        _approvals.update { it.copy(answeringId = requestId, message = null) }
        viewModelScope.launch {
            val message = when (val r = repo.answerChange(requestId, approve, note)) {
                is ApiResult.Success -> ProfileMessage(r.value.message ?: if (approve) "Approved." else "Declined.", false)
                is ApiResult.Failure -> ProfileMessage(r.error.userMessage(), true)
            }
            _approvals.update { it.copy(answeringId = null, message = message) }
            // The server's answer is the truth, so read the lists again either way.
            _approvals.update { it.copy(loading = false) }
            loadApprovals()
        }
    }

    /** A different account signed in: drop the previous person's lists and number. */
    fun resetApprovals() { _approvals.value = ApprovalsUiState() }

    fun clearApprovalMessage() = _approvals.update { it.copy(message = null) }

    /** Loadable photo URL for a relative photoUrl (send the session cookie: use the app's OkHttp client). */
    fun photoUrl(relative: String?): String? = repo.photoUrl(relative)

    /** Loads the public profile (photo, metrics, contributions, reported plants) of any account. */
    fun loadBotanist(accountId: String) {
        _botanist.update { BotanistUiState(loading = true) }
        viewModelScope.launch {
            val next = when (val r = repo.botanistProfile(accountId)) {
                is ApiResult.Success -> BotanistUiState(profile = r.value)
                is ApiResult.Failure -> BotanistUiState(error = "This profile could not be loaded.")
            }
            _botanist.value = next
        }
    }

    /** Refreshes bio / photo from the server. Quiet on failure: the cached account is still shown. */
    fun loadOwnProfile() {
        viewModelScope.launch { repo.loadOwn() }
    }

    /** A blank [bio] clears it. */
    fun saveBio(bio: String, onDone: () -> Unit = {}) {
        if (_edit.value.savingBio) return
        _edit.update { it.copy(savingBio = true, bioMessage = null) }
        viewModelScope.launch {
            val r = repo.updateBio(bio)
            val message = when (r) {
                is ApiResult.Success -> ProfileMessage(if (r.value.bio == null) "Bio cleared." else "Bio saved.", false)
                is ApiResult.Failure -> ProfileMessage(r.error.userMessage(), true)
            }
            _edit.update { it.copy(savingBio = false, bioMessage = message) }
            if (r is ApiResult.Success) onDone()
        }
    }

    /** [onDone] runs on success only, so the dialog can close. */
    fun changePassword(current: String, new: String, onDone: () -> Unit = {}) {
        if (_edit.value.changingPassword) return
        _edit.update { it.copy(changingPassword = true, passwordMessage = null) }
        viewModelScope.launch {
            val r = repo.changePassword(current, new)
            val message = when (r) {
                is ApiResult.Success -> ProfileMessage("Your password was changed.", false)
                is ApiResult.Failure -> ProfileMessage(passwordErrorText(r.error), true)
            }
            _edit.update { it.copy(changingPassword = false, passwordMessage = message) }
            if (r is ApiResult.Success) onDone()
        }
    }

    /** [onDone] runs on success only, so the dialog can close. [oldEmail] is checked so a no-op change is refused early. */
    fun changeEmail(current: String, newEmail: String, oldEmail: String?, onDone: (String) -> Unit = {}) {
        if (_edit.value.changingEmail) return
        _edit.update { it.copy(changingEmail = true, emailMessage = null) }
        viewModelScope.launch {
            val r = repo.changeEmail(current, newEmail, oldEmail)
            val message = when (r) {
                is ApiResult.Success -> ProfileMessage("Your email was changed.", false)
                is ApiResult.Failure -> ProfileMessage(passwordErrorText(r.error), true)
            }
            _edit.update { it.copy(changingEmail = false, emailMessage = message) }
            if (r is ApiResult.Success) onDone(r.value.email)
        }
    }

    fun uploadPhoto(uri: Uri) {
        if (_edit.value.uploadingPhoto) return
        _edit.update { it.copy(uploadingPhoto = true, photoMessage = null) }
        viewModelScope.launch {
            val message = when (val r = repo.uploadPhoto(uri)) {
                is ApiResult.Success -> ProfileMessage("Profile photo updated.", false)
                is ApiResult.Failure -> ProfileMessage(r.error.userMessage(), true)
            }
            _edit.update { it.copy(uploadingPhoto = false, photoMessage = message) }
        }
    }

    fun removePhoto() {
        if (_edit.value.uploadingPhoto) return
        _edit.update { it.copy(uploadingPhoto = true, photoMessage = null) }
        viewModelScope.launch {
            val message = when (val r = repo.removePhoto()) {
                is ApiResult.Success -> ProfileMessage("Profile photo removed.", false)
                is ApiResult.Failure -> ProfileMessage(r.error.userMessage(), true)
            }
            _edit.update { it.copy(uploadingPhoto = false, photoMessage = message) }
        }
    }

    fun clearEditMessages() = _edit.update { it.copy(bioMessage = null, passwordMessage = null, emailMessage = null, photoMessage = null) }

    /** 403 wrong password, 429 locked: both keep the server's text, the lock also says for how long. */
    private fun passwordErrorText(e: AppError): String {
        if (e is AppError.Http && e.code == 429) {
            val minutes = e.retryAfterSeconds?.let { (it + 59) / 60 }
            return if (minutes != null) "Too many wrong passwords. Try again in $minutes minute${if (minutes == 1) "" else "s"}."
            else e.message
        }
        return e.userMessage()
    }

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