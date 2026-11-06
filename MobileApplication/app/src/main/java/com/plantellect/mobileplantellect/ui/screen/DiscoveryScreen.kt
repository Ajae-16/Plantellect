package com.plantellect.mobileplantellect.ui.screen

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.plantellect.mobileplantellect.PlantellectApp
import com.plantellect.mobileplantellect.data.remote.dto.DiscoveryCardDto
import com.plantellect.mobileplantellect.viewmodel.DiscoveryViewModel
import java.text.DateFormat
import java.time.Instant
import java.util.Date

/** The server owns this set; these are readable labels only (same as the web page). */
private val REASON_LABELS = linkedMapOf(
    "not_a_plant" to "Not a plant",
    "not_a_photo_of_plant" to "Not a photo of a plant",
    "unusable_image" to "Image cannot be used",
    "already_recorded" to "Already in the library",
    "duplicate" to "Duplicate of another report"
)

/**
 * The contributor queue (mirrors discoveries.html), built on the existing DiscoveryViewModel.
 * Buttons are drawn from fields the card carries, so the app only offers what the server accepts.
 * [onRecord] opens Record a Plant; it does not carry the report id over.
 * [onOpenBotanist] opens a person's profile (the reporter's name is a link).
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun DiscoveriesScreen(
    myAccountId: String?,
    onRecord: () -> Unit,
    onOpenBotanist: (String) -> Unit = {}
) {
    val container = (LocalContext.current.applicationContext as PlantellectApp).container
    val vm: DiscoveryViewModel = viewModel(factory = container.viewModelFactory)
    val state by vm.ui.collectAsState()
    val c = MaterialTheme.colorScheme

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        Text("Discoveries", style = MaterialTheme.typography.headlineMedium, color = c.onBackground)
        Text(
            "Plants people could not identify. Claim one, record it, and an admin closes it when the record is approved.",
            style = MaterialTheme.typography.bodyMedium, color = c.onSurfaceVariant
        )

        state.error?.let { Banner(it, c.errorContainer, c.onErrorContainer, vm::clearMessages) }
        state.notice?.let { Banner(it, c.secondaryContainer, c.onSurface, vm::clearMessages) }
        if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())

        if (state.queue.isEmpty()) {
            Text("Nothing is waiting. New reports appear here as soon as they are filed.", color = c.onSurfaceVariant)
        } else {
            state.queue.forEach { card ->
                DiscoveryCardView(
                    card = card, me = myAccountId, busy = state.busy, vm = vm, onRecord = onRecord,
                    // The server tells each card whether THIS account voted on it (myVote), so the state
                    // is right after a restart, on another phone, and after the list refreshes.
                    hasVoted = card.myVote,
                    onVote = vm::vote,
                    onUnvote = vm::unvote,
                    onOpenBotanist = onOpenBotanist
                )
            }
        }
    }
}

@Composable
private fun Banner(text: String, container: Color, content: Color, onDismiss: () -> Unit) {
    Surface(shape = RoundedCornerShape(12.dp), color = container, modifier = Modifier.fillMaxWidth()) {
        Row(Modifier.padding(start = 14.dp, top = 4.dp, bottom = 4.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(text, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium, color = content)
            TextButton(onDismiss) { Text("OK", color = content) }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun DiscoveryCardView(
    card: DiscoveryCardDto,
    me: String?,
    busy: Boolean,
    vm: DiscoveryViewModel,
    onRecord: () -> Unit,
    hasVoted: Boolean,
    onVote: (String) -> Unit,
    onUnvote: (String) -> Unit,
    onOpenBotanist: (String) -> Unit
) {
    val c = MaterialTheme.colorScheme
    val id = card.requestId
    val mine = card.claimedBy != null && card.claimedBy == me
    val isReporter = me != null && card.reporterId == me
    // A live claim or a recorded report closes the vote (the server enforces the same rule).
    val votingClosed = card.claimedBy != null || card.recordRequestId != null

    Card(
        colors = CardDefaults.cardColors(containerColor = c.surface),
        border = BorderStroke(1.dp, c.outlineVariant),
        modifier = Modifier.fillMaxWidth()
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {

            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                PersonLink(
                    name = card.reporterName ?: card.reporterId.orEmpty(),
                    accountId = card.reporterId,
                    color = c.primary,
                    style = MaterialTheme.typography.titleMedium,
                    onOpen = onOpenBotanist,
                    fontWeight = null
                )
                val where = card.location?.takeIf { it.isNotBlank() }?.let { " · $it" }.orEmpty()
                Text("Reported ${whenText(card.submittedAt)}$where", style = MaterialTheme.typography.bodySmall, color = c.onSurfaceVariant)
                Text(id, style = MaterialTheme.typography.labelSmall, color = c.onSurfaceVariant)
            }

            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                if (card.claimedBy != null)
                    Pill("Claimed by ${card.claimedByName ?: card.claimedBy} ${whenText(card.claimedAt)}", c.primaryContainer, c.onPrimaryContainer)
                if (card.resolvedBy != null)
                    Pill("Resolved by ${card.resolverName ?: card.resolvedBy}", c.secondaryContainer, c.onSurface)
                if (card.recordRequestId != null)
                    Pill("Recorded — awaiting admin review", c.secondaryContainer, c.onSurface)
                if (card.disqualifiedBy != null)
                    Pill("${REASON_LABELS[card.disqualifyReason] ?: "Not a plant"} — ${card.disqualifierName ?: card.disqualifiedBy}", c.errorContainer, c.onErrorContainer)
            }

            card.note?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = c.onSurface) }

            if (card.images.isEmpty()) {
                Text(
                    if (card.photosPurged) "The photos for this report were removed after it was closed." else "No photos were attached.",
                    style = MaterialTheme.typography.bodySmall, color = c.onSurfaceVariant
                )
            } else {
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    card.images.forEach { img ->
                        PlantPhoto(vm.reportImageUrl(img.imageId), "Photo from this report", Modifier.size(120.dp).clip(RoundedCornerShape(12.dp)))
                    }
                }
            }

            if (card.predictions.isNotEmpty()) {
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text("WHAT THE MODEL SUGGESTED", style = MaterialTheme.typography.labelSmall, color = c.onSurfaceVariant, fontWeight = FontWeight.Bold)
                    card.predictions.take(3).forEach { p ->
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(p.scientificName.orEmpty(), style = MaterialTheme.typography.bodySmall, fontStyle = FontStyle.Italic, color = c.onSurface)
                            Text(p.commonName.orEmpty(), Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, color = c.onSurfaceVariant)
                            Text("${Math.round((p.confidence ?: 0.0) * 100)}%", style = MaterialTheme.typography.labelMedium, color = c.primary, fontWeight = FontWeight.Bold)
                        }
                    }
                }
            }

            HorizontalDivider()

            // The reporter cannot claim or record their own report; the server enforces the same rule.
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                if (mine) {
                    Button({ vm.resolve(id) }, enabled = !busy) { Text("Mark resolved") }
                    if (card.resolvedBy == me) OutlinedButton({ vm.reopen(id) }, enabled = !busy) { Text("Undo resolve") }
                    if (!isReporter) Button(onRecord, enabled = !busy) { Text("Record it") }
                    OutlinedButton({ vm.unclaim(id) }, enabled = !busy) { Text("Release") }
                } else if (card.claimable && !isReporter) {
                    // Someone who voted "not a plant" should not also take the report. Undo the vote to enable.
                    Button({ vm.claim(id) }, enabled = !busy && !hasVoted) { Text("Claim") }
                }

                // Beside Claim: a vote is an endorsement, so it does not need the claim.
                if (hasVoted) {
                    // Voted: shown differently, and tapping it takes the vote back (which enables Claim).
                    FilledTonalButton(
                        onClick = { onUnvote(id) },
                        enabled = !busy && !votingClosed,
                        colors = ButtonDefaults.filledTonalButtonColors(
                            containerColor = c.errorContainer,
                            contentColor = c.onErrorContainer,
                            disabledContainerColor = c.errorContainer.copy(alpha = 0.5f),
                            disabledContentColor = c.onErrorContainer.copy(alpha = 0.7f)
                        )
                    ) {
                        Text("✓ You voted not a plant · ${card.voteCount}/${card.notAPlantThreshold} · Undo")
                    }
                } else {
                    OutlinedButton({ onVote(id) }, enabled = !votingClosed && !busy) {
                        Text("Vote not a plant · ${card.voteCount}/${card.notAPlantThreshold}")
                    }
                }

                if (card.disqualifiedBy != null)
                    OutlinedButton({ vm.reinstate(id) }, enabled = !busy) { Text("Disagree? Reinstate") }
                if (card.claimedBy != null && !mine)
                    TextButton({ vm.release(id) }, enabled = !busy) { Text("Release claim") }
            }

            if (hasVoted && card.claimable && !mine && !isReporter) {
                Text(
                    "You voted this is not a plant, so you can't claim it. Undo your vote to claim.",
                    style = MaterialTheme.typography.bodySmall, color = c.onSurfaceVariant
                )
            }
        }
    }
}

@Composable
private fun Pill(text: String, container: Color, content: Color) {
    Surface(shape = RoundedCornerShape(50), color = container) {
        Text(text, Modifier.padding(horizontal = 10.dp, vertical = 4.dp), style = MaterialTheme.typography.labelMedium, color = content)
    }
}

/** "just now", "5 min ago", "2h ago", "3d ago", else a date. Blank when the value cannot be read. */
private fun whenText(value: String?): String {
    if (value.isNullOrBlank()) return ""
    val millis = runCatching { Instant.parse(value).toEpochMilli() }.getOrNull()
        ?: runCatching { Instant.parse(value.replace(' ', 'T') + "Z").toEpochMilli() }.getOrNull()
        ?: value.toLongOrNull()
        ?: return ""
    val s = (System.currentTimeMillis() - millis) / 1000
    return when {
        s < 60 -> "just now"
        s < 3600 -> "${s / 60} min ago"
        s < 86400 -> "${s / 3600}h ago"
        s < 1728000 -> "${s / 86400}d ago"
        else -> DateFormat.getDateInstance().format(Date(millis))
    }
}