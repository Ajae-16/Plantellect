package com.plantellect.mobileplantellect.ui.screen

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.plantellect.mobileplantellect.data.remote.dto.*
import com.plantellect.mobileplantellect.viewmodel.ApprovalsUiState

/*
 * Profile > Pending approval.
 *
 *   Waiting for your approval   somebody asked to change a description YOU wrote. Your approval AND an admin's
 *                               are both needed; if you decline, the change is cancelled.
 *   Asked by you                changes you asked for. Changing someone else's description needs that person
 *                               AND an admin; changing your own needs only an admin.
 */

private val RICH_KEYS = setOf("uses", "benefits", "harmful", "type.cautionNote")

private fun scopeTitle(m: MyApprovalDto): String = when {
    m.scope == "base" -> "Change to the plant info"
    m.owner != null -> "Change to ${m.owner.name ?: "another contributor"}'s description"
    else -> "Change to your description"
}

private fun plantLine(name: String?, sci: String?): String =
    listOfNotNull(name?.takeIf { it.isNotBlank() }, sci?.takeIf { it.isNotBlank() }?.let { "($it)" }).joinToString(" ").ifBlank { "Plant" }

/** Each field a change asks for: before → after. */
@Composable
private fun ChangeLines(changes: Map<String, RecChange>?) {
    changes?.forEach { (key, ch) ->
        var from = ch.fromLabel.asText().ifEmpty { ch.from.asText() }
        var to = ch.toLabel.asText().ifEmpty { ch.to.asText() }
        if (key in RICH_KEYS) { from = plain(from); to = plain(to) }
        Text(
            "${CHANGE_LABELS[key] ?: key}: ${from.ifEmpty { "(empty)" }} → ${to.ifEmpty { "(empty)" }}",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurface
        )
    }
}

@Composable
private fun StatusLine(who: String, status: String, detail: String? = null) {
    val c = MaterialTheme.colorScheme
    val (label, color) = when (status) {
        "approved" -> "Approved" to c.primary
        "denied" -> "Declined" to c.error
        "blocked" -> "Waits for the contributor first" to c.onSurfaceVariant
        else -> "Waiting" to c.onSurfaceVariant
    }
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("$who:", style = MaterialTheme.typography.bodyMedium, color = c.onSurface)
        Text(label, style = MaterialTheme.typography.bodyMedium, color = color, fontWeight = FontWeight.SemiBold)
    }
    detail?.takeIf { it.isNotBlank() }?.let {
        Text("“$it”", style = MaterialTheme.typography.bodySmall, color = c.onSurfaceVariant)
    }
}

@Composable
internal fun PendingApprovalSection(
    state: ApprovalsUiState,
    onAnswer: (requestId: String, approve: Boolean, note: String?) -> Unit,
    onOpenPlant: (String) -> Unit,
    onDismissMessage: () -> Unit
) {
    val c = MaterialTheme.colorScheme
    val data = state.data
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        state.message?.let { m ->
            Card(colors = CardDefaults.cardColors(containerColor = if (m.isError) c.errorContainer else c.secondaryContainer)) {
                Row(Modifier.padding(start = 12.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(m.text, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                    PlantTextButton(onDismissMessage) { Text("Dismiss") }
                }
            }
        }
        if (state.loading && !state.loaded) CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally))
        if (state.loaded && data.awaitingMe.isEmpty() && data.mine.isEmpty()) {
            Text(
                "Nothing is waiting for approval. When you ask to change someone else's description, or someone asks to change yours, it shows up here.",
                style = MaterialTheme.typography.bodyMedium, color = c.onSurfaceVariant
            )
        }

        // ------------------------------------------------------------ waiting for MY answer
        if (data.awaitingMe.isNotEmpty()) {
            SectionTitle("Waiting for your approval (${data.awaitingMe.size})")
            Text(
                "Someone asked to change a description you wrote. It also needs an admin. If you decline, it is cancelled.",
                style = MaterialTheme.typography.bodySmall, color = c.onSurfaceVariant
            )
            data.awaitingMe.forEach { a ->
                var note by remember(a.requestId) { mutableStateOf("") }
                val busy = state.answeringId == a.requestId
                PlantSurface(Modifier.fillMaxWidth()) {
                    Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(plantLine(a.plantName, a.scientificName), style = MaterialTheme.typography.titleSmall, color = c.onSurface)
                        Text(
                            "${a.requesterName ?: "Someone"} asked to change your description" +
                                    (niceDateTime(a.createdAt).takeIf { it.isNotBlank() }?.let { " · $it" } ?: ""),
                            style = MaterialTheme.typography.bodyMedium, color = c.onSurfaceVariant
                        )
                        a.reason?.takeIf { it.isNotBlank() }?.let {
                            Text("Reason: $it", style = MaterialTheme.typography.bodyMedium, color = c.onSurface)
                        }
                        ChangeLines(a.changes)
                        OutlinedTextField(
                            value = note, onValueChange = { note = it },
                            label = { Text("Note to ${a.requesterName ?: "them"} (optional)") },
                            modifier = Modifier.fillMaxWidth(), minLines = 1, maxLines = 3,
                            keyboardOptions = KeyboardOptions.Default, shape = MaterialTheme.shapes.small
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                            PlantButton({ onAnswer(a.requestId, true, note) }, enabled = state.answeringId == null) {
                                Text(if (busy) "Saving…" else "Approve")
                            }
                            PlantOutlinedButton({ onAnswer(a.requestId, false, note) }, enabled = state.answeringId == null) {
                                Text("Decline")
                            }
                            a.plantId?.let { id -> PlantTextButton({ onOpenPlant(id) }) { Text("See plant") } }
                        }
                    }
                }
            }
        }

        // ------------------------------------------------------------ asked BY me
        if (data.mine.isNotEmpty()) {
            SectionTitle("Asked by you (${data.mine.size})")
            data.mine.forEach { m ->
                PlantSurface(Modifier.fillMaxWidth()) {
                    Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(
                                plantLine(m.plantName, m.scientificName),
                                Modifier.weight(1f), style = MaterialTheme.typography.titleSmall, color = c.onSurface
                            )
                            if (m.unread) Text("NEW", style = MaterialTheme.typography.labelLarge, color = c.primary, fontWeight = FontWeight.Bold)
                        }
                        Text(scopeTitle(m), style = MaterialTheme.typography.bodyMedium, color = c.onSurfaceVariant)

                        val ownerStatus = m.owner?.status ?: "pending"
                        // Contributor first (when there is one), then the admin.
                        m.owner?.let { o ->
                            StatusLine("Contributor (${o.name ?: "—"})", ownerStatus, o.note)
                        }
                        val adminStatus = when {
                            m.status == "pending" && m.owner != null && ownerStatus != "approved" -> "blocked"
                            else -> m.status
                        }
                        // A decline by the contributor ends the request; the admin never sees it.
                        if (!(m.owner != null && ownerStatus == "denied")) {
                            StatusLine("Admin", adminStatus, if (m.status != "pending") m.note?.takeIf { !it.startsWith("[") } else null)
                        }
                        Text(
                            when {
                                m.owner != null && ownerStatus == "denied" -> "Declined by the contributor. Nothing was changed."
                                m.status == "approved" -> "Approved. The change is now on the plant."
                                m.status == "denied" -> "Declined by an admin. Nothing was changed."
                                else -> "Still open."
                            },
                            style = MaterialTheme.typography.labelLarge,
                            color = when {
                                m.status == "approved" -> c.primary
                                m.status == "denied" -> c.error
                                else -> c.onSurfaceVariant
                            }
                        )
                        m.reason?.takeIf { it.isNotBlank() }?.let {
                            Text("Your reason: $it", style = MaterialTheme.typography.bodySmall, color = c.onSurfaceVariant)
                        }
                        ChangeLines(m.changes)
                        Text(
                            "Asked ${niceDateTime(m.createdAt)}",
                            style = MaterialTheme.typography.bodySmall, color = c.onSurfaceVariant
                        )
                        m.plantId?.let { id -> PlantTextButton({ onOpenPlant(id) }) { Text("See plant") } }
                    }
                }
            }
        }
    }
}
