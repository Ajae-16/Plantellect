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
import com.plantellect.mobileplantellect.viewmodel.LibraryViewModel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

// ---------------------------------------------------------------------------
// Community votes on descriptions (server: routes/description-votes.js)
//
//   GET    /api/plants/:plantId/description-votes
//   POST   /api/plants/:plantId/descriptions/:descriptionId/vote   { value, reasonCode?, reasonNote? }
//   DELETE /api/plants/:plantId/descriptions/:descriptionId/vote
//
// The server enforces every rule (own description, hidden description, reasons, note length).
// The app only draws the state and shows the server's error text. Voting needs the signed-in
// session cookie, so the OkHttpClient passed in must be the one that carries it.
// ---------------------------------------------------------------------------

data class VoteReason(val code: String, val label: String, val count: Int = 0)

data class DescriptionVoteState(
    val up: Int,
    val down: Int,
    val myVote: String?,       // "up", "down" or null
    val own: Boolean,
    val reasons: List<VoteReason>,
    val notes: List<String>
)

data class VoteSummary(
    val signedIn: Boolean,
    val reasons: List<VoteReason>,      // premade down-vote reasons
    val noteMaxLength: Int,
    val byId: Map<String, DescriptionVoteState>
)

sealed interface VoteResult {
    data class Ok(val up: Int, val myVote: String?, val hidden: Boolean) : VoteResult
    data class Err(val message: String) : VoteResult
}

private fun JsonElement?.s(): String? = (this as? JsonPrimitive)?.contentOrNull
private fun JsonElement?.i(): Int = (this as? JsonPrimitive)?.intOrNull ?: 0

private fun parseReasons(e: JsonElement?): List<VoteReason> =
    (e as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }.mapNotNull { o ->
        val code = o["code"].s() ?: return@mapNotNull null
        VoteReason(code, o["label"].s() ?: code, o["count"].i())
    }

suspend fun fetchVoteSummary(client: OkHttpClient, vm: LibraryViewModel, plantId: String): VoteSummary? {
    val url = vm.absoluteUrl("/api/plants/$plantId/description-votes") ?: return null
    return withContext(Dispatchers.IO) {
        runCatching {
            client.newCall(Request.Builder().url(url).build()).execute().use { r ->
                if (!r.isSuccessful) return@use null
                val root = Json.parseToJsonElement(r.body?.string().orEmpty()) as? JsonObject ?: return@use null
                val map = (root["descriptions"] as? JsonObject).orEmpty().mapNotNull { (id, v) ->
                    val o = v as? JsonObject ?: return@mapNotNull null
                    id to DescriptionVoteState(
                        up = o["up"].i(),
                        down = o["down"].i(),
                        myVote = o["myVote"].s(),
                        own = (o["own"] as? JsonPrimitive)?.booleanOrNull == true,
                        reasons = parseReasons(o["reasons"]),
                        notes = (o["notes"] as? JsonArray).orEmpty().mapNotNull { it.s() }
                    )
                }.toMap()
                VoteSummary(
                    signedIn = (root["signedIn"] as? JsonPrimitive)?.booleanOrNull == true,
                    reasons = parseReasons(root["reasons"]),
                    noteMaxLength = root["noteMaxLength"].i().takeIf { it > 0 } ?: 200,
                    byId = map
                )
            }
        }.getOrNull()
    }
}

private suspend fun sendVote(
    client: OkHttpClient, vm: LibraryViewModel, plantId: String, descriptionId: String,
    body: JsonObject?   // null = retract
): VoteResult {
    val url = vm.absoluteUrl("/api/plants/$plantId/descriptions/$descriptionId/vote")
        ?: return VoteResult.Err("Could not reach the server.")
    return withContext(Dispatchers.IO) {
        runCatching {
            val builder = Request.Builder().url(url)
            if (body == null) builder.delete()
            else builder.post(body.toString().toRequestBody("application/json".toMediaType()))
            client.newCall(builder.build()).execute().use { r ->
                val root = runCatching { Json.parseToJsonElement(r.body?.string().orEmpty()) as? JsonObject }.getOrNull()
                if (r.isSuccessful && root != null) {
                    VoteResult.Ok(
                        up = root["up"].i(),
                        myVote = root["myVote"].s(),
                        hidden = (root["hidden"] as? JsonPrimitive)?.booleanOrNull == true
                    )
                } else {
                    val fallback = when (r.code) {
                        401 -> "Sign in to vote."
                        else -> "Could not save your vote."
                    }
                    VoteResult.Err(root?.get("error").s() ?: fallback)
                }
            }
        }.getOrElse { VoteResult.Err("Check your connection and try again.") }
    }
}

/** Holds the vote state for ONE plant's profile and sends votes. Create with [rememberVotes]. */
@Stable
class VotesController(
    private val client: OkHttpClient,
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
        scope.launch { fetchVoteSummary(client, vm, plantId)?.let { summary = it } }
    }

    private fun submit(descriptionId: String, body: JsonObject?, onDone: (VoteResult) -> Unit) {
        if (busyId != null) return
        busyId = descriptionId
        scope.launch {
            val result = sendVote(client, vm, plantId, descriptionId, body)
            busyId = null
            // Down counts, reasons and notes change for everyone, so re-read instead of patching.
            if (result is VoteResult.Ok && !result.hidden) refresh()
            onDone(result)
        }
    }

    fun up(descriptionId: String, onDone: (VoteResult) -> Unit) =
        submit(descriptionId, buildJsonObject { put("value", "up") }, onDone)

    fun down(descriptionId: String, reasonCode: String, note: String?, onDone: (VoteResult) -> Unit) =
        submit(descriptionId, buildJsonObject {
            put("value", "down")
            put("reasonCode", reasonCode)
            if (reasonCode == "other" && note != null) put("reasonNote", note)
        }, onDone)

    fun retract(descriptionId: String, onDone: (VoteResult) -> Unit) = submit(descriptionId, null, onDone)
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
            TextButton(onClick = { tableOpen = !tableOpen }) {
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
                shape = RoundedCornerShape(14.dp),
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
                        Button(
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
                        TextButton(onClick = { panelOpen = false; message = null }) { Text("Cancel") }
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