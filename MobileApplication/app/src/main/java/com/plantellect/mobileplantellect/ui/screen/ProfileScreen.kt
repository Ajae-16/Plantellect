package com.plantellect.mobileplantellect.ui.screen

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.plantellect.mobileplantellect.data.logic.ProfileValidator
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
    val uriHandler = LocalUriHandler.current

    val isOwn = viewAccountId == null || viewAccountId == myAccountId
    val target = if (isOwn) myAccountId else viewAccountId

    var showChangePassword by remember { mutableStateOf(false) }
    var passwordNotice by remember { mutableStateOf<String?>(null) }
    var tab by rememberSaveable(target) { mutableIntStateOf(0) }

    fun open(url: String) {
        val full = if (url.startsWith("http")) url else baseUrl.trimEnd('/') + "/" + url.trimStart('/')
        uriHandler.openUri(full)
    }

    // Own: reports + own profile refresh. Anyone: the public profile (photo, counts, plants).
    // A person with nothing public simply gets no profile data (the server answers 404).
    LaunchedEffect(account != null, target, isOwn) {
        if (isOwn && account != null) { vm.load(1); vm.loadOwnProfile() }
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
                    Button(onClick = onSignIn) { Text("Sign in") }
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
                            initials = account.username.take(2).uppercase()
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
                    account.bio?.takeIf { it.isNotBlank() }?.let {
                        Text(it, style = MaterialTheme.typography.bodyMedium, color = c.onSurface)
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
                                initials = other.name.take(2).uppercase()
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

        // ---- counts (anyone with a public profile) ----
        p?.let {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Stat("Recorded", it.metrics.verifiedPlants, Modifier.weight(1f))
                Stat("Reviewed", it.metrics.reviewedPlants, Modifier.weight(1f))
                Stat("Reported", it.metrics.reportedPlants, Modifier.weight(1f))
            }
        }

        // ---- security: own only ----
        if (isOwn) {
            SectionTitle("Security")
            OutlinedButton(onClick = { passwordNotice = null; vm.clearEditMessages(); showChangePassword = true }) {
                Text("Change password")
            }
            passwordNotice?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = c.primary) }
        }

        // ---- tabs ----
        // Own:    My reports | My contributions
        // Other:  Contributions | Reported plants
        val canRecord = "record_plant" in account.permissions
        val tabs = buildList<Pair<String, String>> {
            if (isOwn) {
                add("reports" to "My reports (${s.total})")
                if (p != null || canRecord) add("contributions" to "My contributions (${p?.contributions?.size ?: 0})")
            } else if (p != null) {
                add("contributions" to "Contributions (${p.contributions.size})")
                add("reported" to "Reported plants (${p.reported.size})")
            }
        }
        if (tabs.isNotEmpty()) {
            val selected = tab.coerceIn(0, tabs.lastIndex)
            TabRow(selectedTabIndex = selected) {
                tabs.forEachIndexed { i, (_, label) ->
                    Tab(selected = selected == i, onClick = { tab = i }, text = { Text(label, maxLines = 1) })
                }
            }
            when (tabs[selected].first) {
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
    }

    // Dialogs live outside the page column so they never add spacing to it.
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

/** Profile picture in the app's leaf shape; initials when there is no photo. */
@Composable
private fun ProfilePicture(url: String?, name: String, initials: String) {
    val c = MaterialTheme.colorScheme
    Surface(shape = LeafMedium, color = c.primaryContainer, modifier = Modifier.size(72.dp)) {
        Box(contentAlignment = Alignment.Center) {
            if (url != null) PlantPhoto(url, name, Modifier.fillMaxSize(), maxPx = 256, placeholder = false)
            else Text(initials, style = MaterialTheme.typography.titleLarge, color = c.onPrimaryContainer)
        }
    }
}

@Composable
private fun Stat(label: String, value: Int, modifier: Modifier) {
    Surface(modifier, shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surfaceContainer) {
        Column(Modifier.padding(12.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text("$value", style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.onSurface)
            Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
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
                OutlinedButton(onClick = onPrev, enabled = hasPrev && !loading) { Text("Previous") }
                Text("Page $page of $pageCount", style = MaterialTheme.typography.bodyMedium, color = c.onSurfaceVariant)
                OutlinedButton(onClick = onNext, enabled = hasNext && !loading) { Text("Next") }
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
                    Button(onClick = { onOpen(it) }) { Text("See the plant") }
                }
                // Offered only while waiting; the server's 409 says if it is too late.
                if (report.state == "waiting") {
                    OutlinedButton(onClick = onWithdraw, enabled = !withdrawing) {
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

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Change password") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                PasswordField("Current password", current) { current = it }
                PasswordField("New password", next) { next = it }
                PasswordField("Confirm new password", confirm) { confirm = it }
                (problem ?: serverError)?.let {
                    Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                }
                if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            }
        },
        confirmButton = {
            Button(onClick = { confirming = true }, enabled = canSubmit) { Text("Change password") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel") }
        }
    )

    if (confirming) {
        AlertDialog(
            onDismissRequest = { confirming = false },
            title = { Text("Confirm password change") },
            text = { Text("Are you sure you want to change your password?") },
            confirmButton = {
                Button(onClick = {
                    confirming = false
                    onSubmit(current, next)
                }) { Text("Yes, change it") }
            },
            dismissButton = {
                TextButton(onClick = { confirming = false }) { Text("Go back") }
            }
        )
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
