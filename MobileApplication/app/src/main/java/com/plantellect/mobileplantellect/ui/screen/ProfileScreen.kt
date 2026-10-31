package com.plantellect.mobileplantellect.ui.screen

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.plantellect.mobileplantellect.data.remote.dto.AccountDto
import com.plantellect.mobileplantellect.ui.theme.LeafMedium
import com.plantellect.mobileplantellect.viewmodel.ProfileViewModel
import com.plantellect.mobileplantellect.viewmodel.ReportItem
import java.text.DateFormat
import java.time.Instant
import java.util.Date

/** Same closed set of states the server sends; an unknown state shows its raw value. */
private val REPORT_STATE_LABELS = mapOf(
    "waiting" to "Waiting for a botanist",
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
 * @param account  the signed-in account from /me, or null when signed out (guest).
 * @param baseUrl  server origin (e.g. "https://host/"), used to open relative plant links.
 * @param onSignIn called from the guest prompt.
 */
@Composable
fun ProfileScreen(
    account: AccountDto?,
    vm: ProfileViewModel,
    baseUrl: String,
    onSignIn: () -> Unit
) {
    val c = MaterialTheme.colorScheme
    val s by vm.state.collectAsState()
    val uriHandler = LocalUriHandler.current

    var showChangePassword by remember { mutableStateOf(false) }
    var passwordNotice by remember { mutableStateOf<String?>(null) }

    fun open(url: String) {
        val full = if (url.startsWith("http")) url else baseUrl.trimEnd('/') + "/" + url.trimStart('/')
        uriHandler.openUri(full)
    }

    // Reports are only fetched when signed in, so a guest never triggers a failing call.
    LaunchedEffect(account != null) { if (account != null) vm.load(1) }

    PlantellectPage {
        PageHeading("Personal space", "Your profile", "Your account and the plants you have reported.")

        if (account == null) {
            PlantSurface(Modifier.fillMaxWidth()) {
                Column(
                    Modifier.fillMaxWidth().padding(20.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    Text(
                        "Sign in to see your profile and reports.",
                        style = MaterialTheme.typography.bodyLarge,
                        color = c.onSurface,
                        textAlign = TextAlign.Center
                    )
                    Button(onClick = onSignIn) { Text("Sign in") }
                }
            }
            return@PlantellectPage
        }

        // ---- identity: username, email, roles ----
        PlantSurface(Modifier.fillMaxWidth()) {
            Row(
                Modifier.fillMaxWidth().padding(20.dp),
                horizontalArrangement = Arrangement.spacedBy(16.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Surface(shape = LeafMedium, color = c.primaryContainer, modifier = Modifier.size(64.dp)) {
                    Box(contentAlignment = Alignment.Center) {
                        Text(
                            account.username.take(2).uppercase(),
                            style = MaterialTheme.typography.titleLarge,
                            color = c.onPrimaryContainer
                        )
                    }
                }
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(
                        account.username.ifBlank { "-" },
                        style = MaterialTheme.typography.titleLarge,
                        color = c.onSurface
                    )
                    Text(
                        account.email.ifBlank { "-" },
                        style = MaterialTheme.typography.bodyMedium,
                        color = c.onSurfaceVariant
                    )
                    Text(
                        "Roles: " + (account.roles.joinToString(", ").ifEmpty { "None" }),
                        style = MaterialTheme.typography.bodyMedium,
                        color = c.onSurfaceVariant
                    )
                }
            }
        }

        // ---- security: change password ----
        SectionTitle("Security")

        OutlinedButton(onClick = { passwordNotice = null; showChangePassword = true }) {
            Text("Change password")
        }

        passwordNotice?.let {
            Text(it, style = MaterialTheme.typography.bodyMedium, color = c.primary)
        }

        // ---- my reports ----
        SectionTitle("My reports")

        Text(
            if (s.total == 0 && !s.loading)
                "You have not reported any unidentified plants yet. You can do that from the Scan page."
            else "${s.total} report${if (s.total == 1) "" else "s"} filed.",
            style = MaterialTheme.typography.bodyMedium,
            color = c.onSurfaceVariant
        )

        s.notice?.let {
            Text(it, style = MaterialTheme.typography.bodyMedium, color = c.error)
        }

        if (s.loading && s.reports.isEmpty()) {
            CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally))
        }

        s.reports.forEach { report ->
            ReportCard(
                report = report,
                withdrawing = s.withdrawingId == report.requestId,
                onWithdraw = { vm.withdraw(report.requestId) },
                onOpen = ::open
            )
        }

        if (s.total > s.pageSize) {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                OutlinedButton(onClick = vm::prevPage, enabled = s.hasPrev && !s.loading) { Text("Previous") }
                Text(
                    "Page ${s.page} of ${s.pageCount}",
                    style = MaterialTheme.typography.bodyMedium,
                    color = c.onSurfaceVariant
                )
                OutlinedButton(onClick = vm::nextPage, enabled = s.hasNext && !s.loading) { Text("Next") }
            }
        }
    }

    // Dialogs live outside the page column so they never add spacing to it.
    if (showChangePassword && account != null) {
        ChangePasswordDialog(
            onDismiss = { showChangePassword = false },
            onConfirmed = {
                showChangePassword = false
                passwordNotice = "Your password was changed."
            }
        )
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
                Text(
                    formatWhen(report.submittedAt),
                    style = MaterialTheme.typography.bodySmall,
                    color = c.onSurfaceVariant
                )
            }

            report.note?.takeIf { it.isNotBlank() }?.let {
                Text(it, style = MaterialTheme.typography.bodyMedium, color = c.onSurface)
            }
            report.location?.takeIf { it.isNotBlank() }?.let {
                Text("Where: $it", style = MaterialTheme.typography.bodySmall, color = c.onSurfaceVariant)
            }

            // Only for a community rejection; a single botanist's verdict stays private.
            if (report.state == "not_a_plant" && report.voterCount > 0) {
                Text(
                    "${report.voterCount} botanist${if (report.voterCount == 1) "" else "s"} agreed this is not a plant.",
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
 * UI only: [onConfirmed] runs when the user taps "Yes, change it".
 */
@Composable
private fun ChangePasswordDialog(
    onDismiss: () -> Unit,
    onConfirmed: () -> Unit
) {
    var current by remember { mutableStateOf("") }
    var next by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var confirming by remember { mutableStateOf(false) }

    val problem: String? = when {
        next.isNotEmpty() && next.length < 8 -> "New password must be at least 8 characters."
        next.isNotEmpty() && next == current -> "New password must differ from the current one."
        confirm.isNotEmpty() && confirm != next -> "The new passwords do not match."
        else -> null
    }
    val canSubmit = current.isNotEmpty() && next.isNotEmpty() && confirm.isNotEmpty() && problem == null

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Change password") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                PasswordField("Current password", current) { current = it }
                PasswordField("New password", next) { next = it }
                PasswordField("Confirm new password", confirm) { confirm = it }
                problem?.let {
                    Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                }
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
                    // TODO: call the change-password request here, then onConfirmed() on success.
                    confirming = false
                    onConfirmed()
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