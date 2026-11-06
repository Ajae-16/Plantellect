package com.plantellect.mobileplantellect.ui.screen

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ThumbDown
import androidx.compose.material.icons.filled.ThumbUp
import androidx.compose.material.icons.outlined.ThumbDown
import androidx.compose.material.icons.outlined.ThumbUp
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.plantellect.mobileplantellect.data.remote.dto.DescriptionVoteState
import com.plantellect.mobileplantellect.data.remote.dto.VoteReason
import com.plantellect.mobileplantellect.data.remote.dto.VoteResult
import com.plantellect.mobileplantellect.data.remote.dto.VoteSummary
import com.plantellect.mobileplantellect.viewmodel.LibraryViewModel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient

// ---------------------------------------------------------------------------
// Community votes on descriptions (server: routes/description-votes.js)
//
// The calls, the wire shapes and the error text live in the data layer:
//   data/remote/VotesApi.kt, data/repository/DescriptionVoteRepository.kt, models in dto/PublicDtos.kt,
// reached through LibraryViewModel.voteSummary / voteUp / voteDown / voteRetract. Only the state the
// screen draws is kept here. The server enforces every rule (own description, hidden description,
// reasons, note length); the app shows the server's error text.
// ---------------------------------------------------------------------------

/** Holds the vote state for ONE plant's profile and sends votes. Create with [rememberVotes]. */
@Stable
class VotesController(
    @Suppress("unused") private val client: OkHttpClient,   // no longer used: the view-model does the calls
    private val vm: LibraryViewModel,
    private val plantId: String,
    private val scope: CoroutineScope
) {
    var summary by mutableStateOf<VoteSummary?>(null)
        private set

    /** The description whose request is in flight, so its buttons can be disabled. */
    var busyId by mutableStateOf<String?>(null)
        private set

    fun refresh() {
        scope.launch { vm.voteSummary(plantId)?.let { summary = it } }
    }

    private fun submit(descriptionId: String, onDone: (VoteResult) -> Unit, send: suspend () -> VoteResult) {
        if (busyId != null) return
        busyId = descriptionId
        scope.launch {
            val result = send()
            busyId = null
            // Down counts, reasons and notes change for everyone, so re-read instead of patching.
            if (result is VoteResult.Ok && !result.hidden) refresh()
            onDone(result)
        }
    }

    fun up(descriptionId: String, onDone: (VoteResult) -> Unit) =
        submit(descriptionId, onDone) { vm.voteUp(plantId, descriptionId) }

    fun down(descriptionId: String, reasonCode: String, note: String?, onDone: (VoteResult) -> Unit) =
        submit(descriptionId, onDone) { vm.voteDown(plantId, descriptionId, reasonCode, note) }

    fun retract(descriptionId: String, onDone: (VoteResult) -> Unit) =
        submit(descriptionId, onDone) { vm.voteRetract(plantId, descriptionId) }
}

@Composable
fun rememberVotes(client: OkHttpClient, vm: LibraryViewModel, plantId: String, reloadKey: Int = 0): VotesController {
    val scope = rememberCoroutineScope()
    val controller = remember(plantId) { VotesController(client, vm, plantId, scope) }
    LaunchedEffect(plantId, reloadKey) { controller.refresh() }
    return controller
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

/**
 * Thumbs up / down for one description: two pill buttons with their counts, a "votes" toggle
 * that opens the table (totals, reasons counted, voters' notes, no names), and a down-vote
 * panel with the premade reasons as chips plus a note box for "Other".
 *
 * [onHidden] runs when enough down votes just hid this description: reload the profile.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun DescriptionVoteBar(
    votes: VotesController,
    descriptionId: String?,
    onHidden: () -> Unit,
    modifier: Modifier = Modifier
) {
    val id: String = descriptionId ?: return
    val summary = votes.summary ?: return
    val st = summary.byId[id] ?: return
    val c = MaterialTheme.colorScheme

    var panelOpen by remember(id) { mutableStateOf(false) }
    var tableOpen by remember(id) { mutableStateOf(false) }
    var reason by remember(id) { mutableStateOf<String?>(null) }
    var note by remember(id) { mutableStateOf("") }
    var message by remember(id) { mutableStateOf<String?>(null) }

    val busy = votes.busyId == id
    val locked = st.own || busy

    fun done(r: VoteResult) {
        when (r) {
            is VoteResult.Ok -> {
                message = null
                panelOpen = false
                reason = null
                note = ""
                if (r.hidden) onHidden()
            }
            is VoteResult.Err -> message = r.message
        }
    }

    fun needSignIn(): Boolean {
        if (summary.signedIn) return false
        message = "Sign in to vote."
        return true
    }

    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            VoteButton(
                active = st.myVote == "up", count = st.up, enabled = !locked,
                filled = Icons.Filled.ThumbUp, outlined = Icons.Outlined.ThumbUp,
                description = if (st.myVote == "up") "Remove your upvote" else "Upvote: this is helpful",
                activeContainer = c.primary, activeContent = c.onPrimary
            ) {
                message = null
                if (needSignIn()) return@VoteButton
                if (st.myVote == "up") votes.retract(id, ::done) else votes.up(id, ::done)
            }
            VoteButton(
                active = st.myVote == "down", count = st.down, enabled = !locked,
                filled = Icons.Filled.ThumbDown, outlined = Icons.Outlined.ThumbDown,
                description = if (st.myVote == "down") "Remove your downvote" else "Downvote: something is wrong",
                activeContainer = c.error, activeContent = c.onError
            ) {
                message = null
                if (needSignIn()) return@VoteButton
                if (st.myVote == "down") votes.retract(id, ::done) else panelOpen = !panelOpen
            }
            PlantTextButton(onClick = { tableOpen = !tableOpen }) {
                Text(if (tableOpen) "Hide votes" else "View votes", fontSize = 13.sp)
            }
            if (busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
        }

        val hint = message ?: if (st.own) "You wrote this description, so you can't vote on it." else null
        if (hint != null) {
            Text(
                hint, style = MaterialTheme.typography.bodySmall,
                color = if (message != null) c.error else c.onSurfaceVariant
            )
        }

        AnimatedVisibility(
            visible = panelOpen && !st.own,
            enter = expandVertically() + fadeIn(),
            exit = shrinkVertically() + fadeOut()
        ) {
            Surface(
                shape = MaterialTheme.shapes.medium,
                color = c.surface, contentColor = c.onSurface,
                border = BorderStroke(1.dp, c.outlineVariant)
            ) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("What is wrong with it?", style = MaterialTheme.typography.titleSmall)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        summary.reasons.forEach { r ->
                            FilterChip(
                                selected = reason == r.code,
                                onClick = { reason = r.code; message = null },
                                label = { Text(r.label) }
                            )
                        }
                    }
                    AnimatedVisibility(visible = reason == "other") {
                        OutlinedTextField(
                            value = note,
                            onValueChange = { if (it.length <= summary.noteMaxLength) note = it },
                            modifier = Modifier.fillMaxWidth(),
                            minLines = 3,
                            shape = RoundedCornerShape(12.dp),
                            label = { Text("Note for the administrator") },
                            placeholder = { Text("Say what is wrong, e.g. which fact is incorrect") },
                            supportingText = {
                                Text("${note.length}/${summary.noteMaxLength}", Modifier.fillMaxWidth(), textAlign = androidx.compose.ui.text.style.TextAlign.End)
                            }
                        )
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        PlantButton(
                            enabled = !busy,
                            onClick = {
                                val code = reason
                                when {
                                    code == null -> message = "Please choose a reason."
                                    code == "other" && note.trim().length < 3 ->
                                        message = "Please write a short note so the administrator knows what is wrong."
                                    else -> votes.down(id, code, note.trim().ifBlank { null }, ::done)
                                }
                            }
                        ) { Text("Send downvote") }
                        PlantTextButton(onClick = { panelOpen = false; message = null }) { Text("Cancel") }
                    }
                }
            }
        }

        AnimatedVisibility(
            visible = tableOpen,
            enter = expandVertically() + fadeIn(),
            exit = shrinkVertically() + fadeOut()
        ) { VotesTable(st) }
    }
}

@Composable
private fun VoteButton(
    active: Boolean,
    count: Int,
    enabled: Boolean,
    filled: ImageVector,
    outlined: ImageVector,
    description: String,
    activeContainer: androidx.compose.ui.graphics.Color,
    activeContent: androidx.compose.ui.graphics.Color,
    onClick: () -> Unit
) {
    val c = MaterialTheme.colorScheme
    Surface(
        onClick = onClick,
        enabled = enabled,
        shape = RoundedCornerShape(50),
        color = if (active) activeContainer else androidx.compose.ui.graphics.Color.Transparent,
        contentColor = if (active) activeContent else c.onSurfaceVariant,
        border = if (active) null else BorderStroke(1.dp, c.outlineVariant),
        modifier = Modifier.heightIn(min = 40.dp)
    ) {
        Row(
            Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            Icon(if (active) filled else outlined, contentDescription = description, modifier = Modifier.size(20.dp))
            Text("$count", fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
        }
    }
}

/** Totals first, then why people downvoted. No names: the server keeps voters admin-only. */
@Composable
private fun VotesTable(st: DescriptionVoteState) {
    val c = MaterialTheme.colorScheme
    Surface(shape = RoundedCornerShape(12.dp), color = c.surfaceVariant.copy(alpha = 0.5f), border = BorderStroke(1.dp, c.outlineVariant)) {
        Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("Votes on this description", style = MaterialTheme.typography.labelLarge, color = c.onSurface)
            TableRow("Upvote", st.up.toString(), "Helpful", c.primary, bold = true)
            TableRow("Downvote", st.down.toString(), "Not good", c.error, bold = true)
            st.reasons.forEach { TableRow("   ↳ Downvote", it.count.toString(), it.label, c.onSurfaceVariant) }
            st.notes.forEach { TableRow("   ↳ Note", "1", "“$it”", c.onSurfaceVariant) }
        }
    }
}

@Composable
private fun TableRow(kind: String, n: String, detail: String, kindColor: androidx.compose.ui.graphics.Color, bold: Boolean = false) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
        Text(
            kind, Modifier.weight(0.34f), color = kindColor, fontSize = 13.sp,
            fontWeight = if (bold) FontWeight.Bold else FontWeight.Normal
        )
        Text(n, Modifier.weight(0.12f), fontSize = 13.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onSurface)
        Text(detail, Modifier.weight(0.54f), fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurface)
    }
}