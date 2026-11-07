package com.plantellect.mobileplantellect.ui.screen

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material.icons.filled.PhotoLibrary
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.plantellect.mobileplantellect.data.logic.ProfileValidator
import com.plantellect.mobileplantellect.data.logic.UploadLimits
import com.plantellect.mobileplantellect.viewmodel.ProfileMessage
import com.plantellect.mobileplantellect.data.remote.dto.AccountDto
import com.plantellect.mobileplantellect.data.remote.dto.ProfilePlantDto
import com.plantellect.mobileplantellect.ui.theme.LeafMedium
import com.plantellect.mobileplantellect.viewmodel.ProfileViewModel
import com.plantellect.mobileplantellect.viewmodel.ReportItem
import java.text.DateFormat
import java.time.Instant
import java.util.Date

/** Same closed set of states the server sends; an unknown state shows its raw value. */
private val REPORT_STATE_LABELS = mapOf(
    "waiting" to "Waiting for a contributor",
    "recording" to "Recorded — awaiting admin review",
    "not_recorded" to "Not recorded — you can record it instead",
    "added" to "Added to the library",
    "not_added" to "Not added — the species was refused",
    "not_a_plant" to "Not a plant",
    "cancelled" to "Withdrawn by you"
)

private fun reportStateLabel(state: String) = REPORT_STATE_LABELS[state] ?: state

private fun formatWhen(value: String?): String {
    if (value.isNullOrBlank()) return ""
    val instant = try { Instant.parse(value) } catch (e: Exception) { return "" }
    val seconds = (System.currentTimeMillis() - instant.toEpochMilli()) / 1000
    return when {
        seconds < 60 -> "just now"
        seconds < 3600 -> "${Math.round(seconds / 60.0)} min ago"
        seconds < 86400 -> "${Math.round(seconds / 3600.0)}h ago"
        seconds < 1_728_000 -> "${Math.round(seconds / 86400.0)}d ago"
        else -> DateFormat.getDateInstance().format(Date.from(instant))
    }
}

/**
 * ONE profile screen for everybody (the old "Profile" and "Contributor profile" screens, combined).
 *
 * Your own profile: identity, Change password, and two tabs: My reports | My contributions.
 * Anyone else's profile (tap a contributor's name anywhere): the same layout, read-only, with their
 * Contributions and the plants they reported. The Library, the plant profile, Home and Discoveries all
 * open it through the "profile/{accountId}" route.
 *
 * @param account       the signed-in account from /me, or null when signed out (guest).
 * @param myAccountId   the signed-in account's id.
 * @param viewAccountId whose profile to show. Null or equal to [myAccountId] = your own profile.
 * @param baseUrl       server origin, used to open relative plant links.
 * @param onOpenPlant   opens a plant inside the app (the plant profile).
 */
@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
fun ProfileScreen(
    account: AccountDto?,
    vm: ProfileViewModel,
    baseUrl: String,
    onSignIn: () -> Unit,
    myAccountId: String? = account?.accountId,
    viewAccountId: String? = null,
    onOpenPlant: (String) -> Unit = {}
) {
    val c = MaterialTheme.colorScheme
    val s by vm.state.collectAsState()
    val b by vm.botanist.collectAsState()
    val edit by vm.edit.collectAsState()
    val approvals by vm.approvals.collectAsState()
    val uriHandler = LocalUriHandler.current

    val isOwn = viewAccountId == null || viewAccountId == myAccountId
    val target = if (isOwn) myAccountId else viewAccountId

    var showChangePassword by remember { mutableStateOf(false) }
    var showChangeEmail by remember { mutableStateOf(false) }
    var showPhotoChoice by remember { mutableStateOf(false) }
    var zoomPhoto by remember { mutableStateOf<String?>(null) }
    var emailNotice by remember { mutableStateOf<String?>(null) }
    var editingBio by rememberSaveable { mutableStateOf(false) }
    var bioDraft by rememberSaveable { mutableStateOf("") }
    var passwordNotice by remember { mutableStateOf<String?>(null) }
    var tab by rememberSaveable(target) { mutableIntStateOf(0) }

    // Picks a photo from the phone and sends it as the new profile picture (the repository shrinks big files).
    val photoPicker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) vm.uploadPhoto(uri)
    }
    fun pickPhoto() { vm.clearEditMessages(); photoPicker.launch("image/*") }

    // "Use camera": take a picture with the phone's camera and send it as the new profile picture.
    val context = LocalContext.current
    var cameraUri by remember { mutableStateOf<android.net.Uri?>(null) }
    val takePicture = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { saved ->
        val uri = cameraUri
        if (saved && uri != null) vm.uploadPhoto(uri)
        cameraUri = null
    }
    fun launchCamera() {
        val dir = java.io.File(context.cacheDir, "camera").apply { mkdirs() }
        val file = java.io.File.createTempFile("profile_", ".jpg", dir)
        val uri = androidx.core.content.FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
        cameraUri = uri
        takePicture.launch(uri)
    }
    // The app declares the camera permission, so Android needs it granted before the camera can open.
    val cameraPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) launchCamera()
    }
    fun useCamera() {
        vm.clearEditMessages()
        val granted = androidx.core.content.ContextCompat.checkSelfPermission(
            context, android.Manifest.permission.CAMERA
        ) == android.content.pm.PackageManager.PERMISSION_GRANTED
        if (granted) launchCamera() else cameraPermission.launch(android.Manifest.permission.CAMERA)
    }

    fun open(url: String) {
        val full = if (url.startsWith("http")) url else baseUrl.trimEnd('/') + "/" + url.trimStart('/')
        uriHandler.openUri(full)
    }

    // Own: reports + own profile refresh. Anyone: the public profile (photo, counts, plants).
    // A person with nothing public simply gets no profile data (the server answers 404).
    LaunchedEffect(account != null, target, isOwn) {
        if (isOwn && account != null) { vm.load(1); vm.loadOwnProfile(); vm.loadApprovals() }
        target?.let { if (account != null) vm.loadBotanist(it) }
    }

    // The view model is shared: never show the previous person's profile for a frame while this one loads.
    val p = b.profile?.takeIf { it.accountId == target }

    PlantellectPage {
        PageHeading(
            if (isOwn) "Personal space" else "Contributor",
            if (isOwn) "Your profile" else (p?.name ?: "Profile"),
            if (isOwn) "Your account, your reports and the plants you recorded."
            else "Their contributions and the plants they reported."
        )

        if (account == null) {
            PlantSurface(Modifier.fillMaxWidth()) {
                Column(
                    Modifier.fillMaxWidth().padding(20.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    Text(
                        "Sign in to see profiles and reports.",
                        style = MaterialTheme.typography.bodyLarge,
                        color = c.onSurface,
                        textAlign = TextAlign.Center
                    )
                    PlantButton(onClick = onSignIn) { Text("Sign in") }
                }
            }
            return@PlantellectPage
        }

        // ---- identity ----
        if (isOwn) {
            PlantSurface(Modifier.fillMaxWidth()) {
                Column(Modifier.fillMaxWidth().padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
                        ProfilePicture(
                            url = vm.photoUrl(account.photoUrl),
                            name = account.username,
                            initials = account.username.take(2).uppercase(),
                            busy = edit.uploadingPhoto,
                            // Tap = change the photo, hold = look at it big.
                            onClick = { if (!edit.uploadingPhoto) { vm.clearEditMessages(); showPhotoChoice = true } },
                            onLongClick = { vm.photoUrl(account.photoUrl)?.let { zoomPhoto = it } }
                        )
                        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(account.username.ifBlank { "-" }, style = MaterialTheme.typography.titleLarge, color = c.onSurface)
                            Text(account.email.ifBlank { "-" }, style = MaterialTheme.typography.bodyMedium, color = c.onSurfaceVariant)
                            Text(
                                "Roles: " + (account.roles.joinToString(", ").ifEmpty { "None" }),
                                style = MaterialTheme.typography.bodyMedium, color = c.onSurfaceVariant
                            )
                        }
                    }
                    // ---- bio, with the photo button beside Edit bio ----
                    BioSection(
                        bio = account.bio,
                        editing = editingBio,
                        draft = bioDraft,
                        saving = edit.savingBio,
                        message = edit.bioMessage,
                        photoButtonLabel = if (account.photoUrl == null) "Add photo" else "Change photo",
                        photoBusy = edit.uploadingPhoto,
                        onDraftChange = { bioDraft = it },
                        onEdit = { vm.clearEditMessages(); bioDraft = account.bio.orEmpty(); editingBio = true },
                        onCancel = { vm.clearEditMessages(); editingBio = false },
                        onSave = { vm.saveBio(bioDraft) { editingBio = false } },
                        onChangePhoto = { vm.clearEditMessages(); showPhotoChoice = true }
                    )
                    if (account.photoUrl != null) {
                        PlantTextButton(onClick = { vm.removePhoto() }, enabled = !edit.uploadingPhoto) { Text("Remove photo") }
                    }
                    if (edit.uploadingPhoto) LinearProgressIndicator(Modifier.fillMaxWidth())
                    edit.photoMessage?.let {
                        Text(
                            it.text,
                            style = MaterialTheme.typography.bodySmall,
                            color = if (it.isError) c.error else c.primary
                        )
                    }
                }
            }
        } else {
            if (b.loading && p == null) CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally))
            if (!b.loading && p == null) {
                PlantSurface(Modifier.fillMaxWidth()) {
                    Text(
                        "This profile is not available. A person's profile appears once they have a plant in the library.",
                        Modifier.padding(20.dp),
                        style = MaterialTheme.typography.bodyMedium, color = c.onSurfaceVariant
                    )
                }
            }
            p?.let { other ->
                PlantSurface(Modifier.fillMaxWidth()) {
                    Column(Modifier.fillMaxWidth().padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Row(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
                            ProfilePicture(
                                url = vm.photoUrl(other.photoUrl),
                                name = other.name,
                                initials = other.name.take(2).uppercase(),
                                onLongClick = { vm.photoUrl(other.photoUrl)?.let { zoomPhoto = it } }
                            )
                            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text(other.name, style = MaterialTheme.typography.titleLarge, color = c.onSurface)
                                if (other.username.isNotBlank())
                                    Text("@${other.username}", style = MaterialTheme.typography.bodyMedium, color = c.onSurfaceVariant)
                                val role = when (other.role) {
                                    "admin" -> "Administrator"
                                    "superadmin" -> "Superadministrator"
                                    else -> null
                                }
                                role?.let { Text(it, style = MaterialTheme.typography.labelLarge, color = c.primary) }
                                other.specialization?.takeIf { it.isNotBlank() }?.let {
                                    Text(it, style = MaterialTheme.typography.bodySmall, color = c.onSurfaceVariant)
                                }
                            }
                        }
                        other.bio?.takeIf { it.isNotBlank() }?.let {
                            Text(it, style = MaterialTheme.typography.bodyMedium, color = c.onSurface)
                        }
                    }
                }
            }
        }

        // ---- tabs ----
        // Own:    My reports | My contributions
        // Other:  Contributions | Reported plants
        val canRecord = "record_plant" in account.permissions
        val tabs = buildList<Pair<String, String>> {
            if (isOwn) {
                // First, so a request waiting for you is the first thing you see.
                if (canRecord) add("approvals" to "Pending approval (${approvals.data.awaitingMe.size + approvals.data.mine.size})")
                add("reports" to "My reports (${s.total})")
                if (p != null || canRecord) add("contributions" to "My contributions (${p?.contributions?.size ?: 0})")
            } else if (p != null) {
                add("contributions" to "Contributions (${p.contributions.size})")
                add("reported" to "Reported plants (${p.reported.size})")
            }
        }
        if (tabs.isNotEmpty()) {
            val selected = tab.coerceIn(0, tabs.lastIndex)
            ScrollableTabStrip(tabs.map { it.second }, selected, { tab = it })
            // Looking at the tab is what clears the "new" mark on the requests you asked for.
            val onApprovals = tabs[selected].first == "approvals"
            LaunchedEffect(onApprovals, approvals.loaded, approvals.data.mine) {
                if (onApprovals && approvals.loaded) vm.markApprovalsSeen()
            }
            when (tabs[selected].first) {
                "approvals" -> PendingApprovalSection(
                    state = approvals,
                    onAnswer = vm::answerChange,
                    onOpenPlant = onOpenPlant,
                    onDismissMessage = vm::clearApprovalMessage
                )
                "reports" -> MyReportsSection(s.total, s.loading, s.notice, s.reports, s.withdrawingId,
                    s.page, s.pageCount, s.pageSize, s.hasPrev, s.hasNext,
                    onWithdraw = vm::withdraw, onPrev = vm::prevPage, onNext = vm::nextPage,
                    onOpenPlant = onOpenPlant, onOpenWeb = ::open)
                "contributions" -> PlantList(
                    p?.contributions.orEmpty(),
                    if (isOwn) "You have not recorded any plants yet." else "Nothing recorded yet.",
                    onOpenPlant
                )
                "reported" -> PlantList(p?.reported.orEmpty(), "No reported plants yet.", onOpenPlant)
            }
        }

        // ---- security: own only, below the reports and contributions ----
        if (isOwn) {
            SectionTitle("Security")
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PlantOutlinedButton(
                    onClick = { passwordNotice = null; emailNotice = null; vm.clearEditMessages(); showChangePassword = true },
                    modifier = Modifier.weight(1f)
                ) { Text("Change password") }
                PlantOutlinedButton(
                    onClick = { passwordNotice = null; emailNotice = null; vm.clearEditMessages(); showChangeEmail = true },
                    modifier = Modifier.weight(1f)
                ) { Text("Change email") }
            }
            passwordNotice?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = c.primary) }
            emailNotice?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = c.primary) }
        }
    }

    // Dialogs live outside the page column so they never add spacing to it.
    if (showPhotoChoice && isOwn) {
        PlantDialog(
            title = if (account?.photoUrl == null) "Add profile photo" else "Change profile photo",
            onDismiss = { showPhotoChoice = false },
            actions = { PlantTextButton(onClick = { showPhotoChoice = false }) { Text("Cancel") } }
        ) {
            Text("Where should the new photo come from?", style = MaterialTheme.typography.bodyMedium, color = c.onSurfaceVariant)
            PlantOutlinedButton(
                onClick = { showPhotoChoice = false; pickPhoto() },
                modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)
            ) {
                Icon(Icons.Filled.PhotoLibrary, contentDescription = null, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(10.dp))
                Text("Gallery")
            }
            PlantOutlinedButton(
                onClick = { showPhotoChoice = false; useCamera() },
                modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)
            ) {
                Icon(Icons.Filled.PhotoCamera, contentDescription = null, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(10.dp))
                Text("Camera")
            }
        }
    }
    zoomPhoto?.let { url -> PhotoZoomDialog(url, if (isOwn) "Your profile photo" else (p?.name ?: "Profile photo"), onClose = { zoomPhoto = null }) }
    if (showChangeEmail && account != null && isOwn) {
        ChangeEmailDialog(
            currentEmail = account.email,
            busy = edit.changingEmail,
            serverError = edit.emailMessage?.takeIf { it.isError }?.text,
            onDismiss = { showChangeEmail = false },
            onSubmit = { password, newEmail ->
                vm.changeEmail(password, newEmail, account.email) { saved ->
                    showChangeEmail = false
                    emailNotice = "Your email was changed to $saved."
                }
            }
        )
    }
    if (showChangePassword && account != null && isOwn) {
        ChangePasswordDialog(
            busy = edit.changingPassword,
            serverError = edit.passwordMessage?.takeIf { it.isError }?.text,
            onDismiss = { showChangePassword = false },
            // The dialog stays open until the server accepts the change, so a wrong current password can be fixed.
            onSubmit = { current, new ->
                vm.changePassword(current, new) {
                    showChangePassword = false
                    passwordNotice = "Your password was changed."
                }
            }
        )
    }
}

/**
 * Profile picture in the app's leaf shape; initials when there is no photo.
 *  - [onClick] (your own picture): tap to change it; wears a small camera badge.
 *  - [onLongClick]: hold to see the photo full screen (also on other people's pictures).
 * [busy] covers it with a spinner while a new photo is being sent.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ProfilePicture(
    url: String?, name: String, initials: String,
    busy: Boolean = false, onClick: (() -> Unit)? = null, onLongClick: (() -> Unit)? = null
) {
    val c = MaterialTheme.colorScheme
    Box(Modifier.size(72.dp)) {
        Surface(shape = LeafMedium, color = c.primaryContainer, modifier = Modifier.fillMaxSize()) {
            Box(
                Modifier.fillMaxSize().combinedClickable(
                    enabled = onClick != null || (onLongClick != null && url != null),
                    onClick = { onClick?.invoke() },
                    onLongClick = if (url != null) onLongClick else null
                ),
                contentAlignment = Alignment.Center
            ) {
                if (url != null) PlantPhoto(url, name, Modifier.fillMaxSize(), maxPx = 256, placeholder = false)
                else Text(initials, style = MaterialTheme.typography.titleLarge, color = c.onPrimaryContainer)
                if (busy) CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 3.dp)
            }
        }
        if (onClick != null) {
            Surface(
                shape = CircleShape, color = c.primary, shadowElevation = 2.dp,
                modifier = Modifier.align(Alignment.BottomEnd).size(24.dp)
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(Icons.Filled.PhotoCamera, contentDescription = "Change profile photo", tint = c.onPrimary, modifier = Modifier.size(14.dp))
                }
            }
        }
    }
}

/**
 * Your own bio: shown as text with "Add bio" / "Edit bio" and the photo button side by side. Editing opens a small
 * editor docked above the keyboard (Save and Cancel stay visible), that stops at [UploadLimits.MAX_BIO_CHARS]
 * characters and keeps the newest letter in view. Saving a blank box clears the bio.
 */
@Composable
private fun BioSection(
    bio: String?,
    editing: Boolean,
    draft: String,
    saving: Boolean,
    message: ProfileMessage?,
    photoButtonLabel: String,
    photoBusy: Boolean,
    onDraftChange: (String) -> Unit,
    onEdit: () -> Unit,
    onCancel: () -> Unit,
    onSave: () -> Unit,
    onChangePhoto: () -> Unit
) {
    val c = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Bio", style = MaterialTheme.typography.titleSmall, color = c.onSurface)
        if (bio.isNullOrBlank()) {
            Text(
                "You have not written a bio yet. It shows on your public profile.",
                style = MaterialTheme.typography.bodyMedium, color = c.onSurfaceVariant
            )
        } else {
            Text(bio, style = MaterialTheme.typography.bodyMedium, color = c.onSurface)
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PlantOutlinedButton(onClick = onEdit, modifier = Modifier.weight(1f)) {
                Text(if (bio.isNullOrBlank()) "Add bio" else "Edit bio")
            }
            PlantOutlinedButton(onClick = onChangePhoto, enabled = !photoBusy, modifier = Modifier.weight(1f)) {
                Text(photoButtonLabel)
            }
        }
        message?.let {
            Text(it.text, style = MaterialTheme.typography.bodySmall, color = if (it.isError) c.error else c.primary)
        }
    }

    if (editing) {
        KeyboardEditDialog(
            title = "Your bio",
            value = draft,
            onValueChange = onDraftChange,
            maxChars = UploadLimits.MAX_BIO_CHARS,
            saveLabel = "Save bio",
            saving = saving,
            saveEnabled = ProfileValidator.bioProblem(draft) == null,
            onSave = onSave,
            onCancel = onCancel,
            placeholder = "Tell people a little about yourself and your plant interests.",
            // A server error (for example a lost connection) shows next to the box it belongs to.
            errorText = message?.takeIf { it.isError }?.text
        )
    }
}

@Composable
private fun PlantList(plants: List<ProfilePlantDto>, empty: String, onOpen: (String) -> Unit) {
    val c = MaterialTheme.colorScheme
    if (plants.isEmpty()) {
        Text(empty, style = MaterialTheme.typography.bodyMedium, color = c.onSurfaceVariant)
        return
    }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        plants.forEach { pl ->
            PlantSurface(Modifier.fillMaxWidth().clickable { onOpen(pl.id) }) {
                Row(
                    Modifier.fillMaxWidth().padding(10.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    PlantPhoto(pl.imageUrl, pl.name, Modifier.size(64.dp).clip(RoundedCornerShape(10.dp)))
                    Column {
                        Text(pl.name, style = MaterialTheme.typography.titleMedium, color = c.onSurface)
                        if (pl.scientificName.isNotBlank())
                            Text(pl.scientificName, style = MaterialTheme.typography.bodySmall,
                                fontStyle = FontStyle.Italic, color = c.onSurfaceVariant)
                        if (pl.typeLabel.isNotBlank())
                            Text(pl.typeLabel, style = MaterialTheme.typography.labelMedium, color = c.primary)
                    }
                }
            }
        }
    }
}

@Composable
private fun MyReportsSection(
    total: Int, loading: Boolean, notice: String?, reports: List<ReportItem>, withdrawingId: String?,
    page: Int, pageCount: Int, pageSize: Int, hasPrev: Boolean, hasNext: Boolean,
    onWithdraw: (String) -> Unit, onPrev: () -> Unit, onNext: () -> Unit,
    onOpenPlant: (String) -> Unit, onOpenWeb: (String) -> Unit
) {
    val c = MaterialTheme.colorScheme
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(
            if (total == 0 && !loading)
                "You have not reported any unidentified plants yet. You can do that from the Scan page."
            else "$total report${if (total == 1) "" else "s"} filed.",
            style = MaterialTheme.typography.bodyMedium, color = c.onSurfaceVariant
        )
        notice?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = c.error) }
        if (loading && reports.isEmpty()) CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally))

        reports.forEach { report ->
            ReportCard(
                report = report,
                withdrawing = withdrawingId == report.requestId,
                onWithdraw = { onWithdraw(report.requestId) },
                onOpen = { url ->
                    // Open the plant inside the app when the link carries a plantId, else the web page.
                    val id = url.substringAfter("plantId=", "").takeIf { it.isNotBlank() }
                    if (id != null) onOpenPlant(id) else onOpenWeb(url)
                }
            )
        }

        if (total > pageSize) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                PlantOutlinedButton(onClick = onPrev, enabled = hasPrev && !loading) { Text("Previous") }
                Text("Page $page of $pageCount", style = MaterialTheme.typography.bodyMedium, color = c.onSurfaceVariant)
                PlantOutlinedButton(onClick = onNext, enabled = hasNext && !loading) { Text("Next") }
            }
        }
    }
}

@Composable
private fun ReportCard(
    report: ReportItem,
    withdrawing: Boolean,
    onWithdraw: () -> Unit,
    onOpen: (String) -> Unit
) {
    val c = MaterialTheme.colorScheme
    PlantSurface(Modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(
                    reportStateLabel(report.state),
                    style = MaterialTheme.typography.titleSmall,
                    color = c.onSurface,
                    modifier = Modifier.weight(1f)
                )
                Text(formatWhen(report.submittedAt), style = MaterialTheme.typography.bodySmall, color = c.onSurfaceVariant)
            }

            report.note?.takeIf { it.isNotBlank() }?.let {
                Text(it, style = MaterialTheme.typography.bodyMedium, color = c.onSurface)
            }
            report.location?.takeIf { it.isNotBlank() }?.let {
                Text("Where: $it", style = MaterialTheme.typography.bodySmall, color = c.onSurfaceVariant)
            }

            // Only for a community rejection; a single contributor's verdict stays private.
            if (report.state == "not_a_plant" && report.voterCount > 0) {
                Text(
                    "${report.voterCount} contributor${if (report.voterCount == 1) "" else "s"} agreed this is not a plant.",
                    style = MaterialTheme.typography.bodySmall,
                    color = c.onSurfaceVariant
                )
            }

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                report.plantUrl?.takeIf { it.isNotBlank() }?.let {
                    PlantButton(onClick = { onOpen(it) }) { Text("See the plant") }
                }
                // Offered only while waiting; the server's 409 says if it is too late.
                if (report.state == "waiting") {
                    PlantOutlinedButton(onClick = onWithdraw, enabled = !withdrawing) {
                        Text(if (withdrawing) "Withdrawing…" else "Withdraw")
                    }
                }
            }
        }
    }
}

/**
 * Two steps: (1) the form with current / new / confirm-new, (2) an "Are you sure?" dialog.
 * [onSubmit] runs when the user taps "Yes, change it" (POST /api/profile/password). [serverError] is the
 * server's answer to the last attempt (wrong current password, locked after 5 wrong guesses, ...).
 */
@Composable
private fun ChangePasswordDialog(
    busy: Boolean,
    serverError: String?,
    onDismiss: () -> Unit,
    onSubmit: (current: String, new: String) -> Unit
) {
    var current by remember { mutableStateOf("") }
    var next by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var confirming by remember { mutableStateOf(false) }

    // Same rules as the server (6 to 72 bytes, different from the current one), checked once something is typed.
    val problem: String? = when {
        next.isNotEmpty() -> ProfileValidator.passwordProblem(current.ifEmpty { " " }, next, confirm.ifEmpty { null })
        else -> null
    }
    val canSubmit = !busy && current.isNotEmpty() && next.isNotEmpty() && confirm.isNotEmpty() &&
            ProfileValidator.passwordProblem(current, next, confirm) == null

    PlantDialog(
        title = "Change password",
        onDismiss = { if (!busy) onDismiss() },
        actions = {
            PlantTextButton(onClick = onDismiss, enabled = !busy) { Text("Cancel") }
            PlantButton(onClick = { confirming = true }, enabled = canSubmit) { Text("Change password") }
        }
    ) {
        PasswordField("Current password", current) { current = it }
        PasswordField("New password", next) { next = it }
        PasswordField("Confirm new password", confirm) { confirm = it }
        (problem ?: serverError)?.let {
            Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
        }
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
    }

    if (confirming) {
        PlantDialog(
            title = "Confirm password change",
            onDismiss = { confirming = false },
            actions = {
                PlantTextButton(onClick = { confirming = false }) { Text("Go back") }
                PlantButton(onClick = { confirming = false; onSubmit(current, next) }) { Text("Yes, change it") }
            }
        ) {
            Text("Are you sure you want to change your password?", style = MaterialTheme.typography.bodyMedium)
        }
    }
}

/**
 * New email + current password, then an "Are you sure?" step. [serverError] is the server's answer to the last
 * attempt (wrong password, email already used, locked after 5 wrong guesses, ...).
 */
@Composable
private fun ChangeEmailDialog(
    currentEmail: String,
    busy: Boolean,
    serverError: String?,
    onDismiss: () -> Unit,
    onSubmit: (password: String, newEmail: String) -> Unit
) {
    val c = MaterialTheme.colorScheme
    var newEmail by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var confirming by remember { mutableStateOf(false) }

    val problem = if (newEmail.isNotEmpty()) ProfileValidator.emailProblem(newEmail, currentEmail) else null
    val canSubmit = !busy && password.isNotEmpty() && ProfileValidator.emailProblem(newEmail, currentEmail) == null

    PlantDialog(
        title = "Change email",
        onDismiss = { if (!busy) onDismiss() },
        actions = {
            PlantTextButton(onClick = onDismiss, enabled = !busy) { Text("Cancel") }
            PlantButton(onClick = { confirming = true }, enabled = canSubmit) { Text("Change email") }
        }
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text("Current email", style = MaterialTheme.typography.labelMedium, color = c.onSurfaceVariant)
            Text(currentEmail.ifBlank { "-" }, style = MaterialTheme.typography.bodyMedium, color = c.onSurface)
        }
        LimitedOutlinedTextField(
            value = newEmail, onValueChange = { newEmail = it }, maxChars = UploadLimits.EMAIL_MAX_CHARS,
            modifier = Modifier.fillMaxWidth(), label = "New email", singleLine = true,
            errorText = problem,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email)
        )
        PasswordField("Current password", password) { password = it }
        serverError?.let { Text(it, color = c.error, style = MaterialTheme.typography.bodySmall) }
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
    }

    if (confirming) {
        PlantDialog(
            title = "Confirm email change",
            onDismiss = { confirming = false },
            actions = {
                PlantTextButton(onClick = { confirming = false }) { Text("Go back") }
                PlantButton(onClick = { confirming = false; onSubmit(password, newEmail.trim()) }) { Text("Yes, change it") }
            }
        ) {
            Text("Change your email to ${newEmail.trim()}? You will use it to sign in from now on.", style = MaterialTheme.typography.bodyMedium)
        }
    }
}

/** Password input with a show / hide toggle. */
@Composable
private fun PasswordField(label: String, value: String, onChange: (String) -> Unit) {
    var visible by remember { mutableStateOf(false) }
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        label = { Text(label) },
        singleLine = true,
        visualTransformation = if (visible) VisualTransformation.None else PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
        trailingIcon = {
            IconButton(onClick = { visible = !visible }) {
                Icon(
                    if (visible) Icons.Filled.VisibilityOff else Icons.Filled.Visibility,
                    contentDescription = if (visible) "Hide password" else "Show password"
                )
            }
        },
        modifier = Modifier.fillMaxWidth()
    )
}
