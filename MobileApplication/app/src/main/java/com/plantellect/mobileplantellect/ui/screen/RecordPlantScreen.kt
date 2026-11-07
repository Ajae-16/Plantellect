package com.plantellect.mobileplantellect.ui.screen

import android.content.ContentResolver
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.runtime.snapshots.SnapshotStateMap
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.viewmodel.compose.viewModel
import com.plantellect.mobileplantellect.data.logic.RichText
import com.plantellect.mobileplantellect.ui.theme.extraColors
import com.plantellect.mobileplantellect.PlantellectApp
import com.plantellect.mobileplantellect.data.remote.dto.*
import com.plantellect.mobileplantellect.viewmodel.RecordDone
import com.plantellect.mobileplantellect.viewmodel.RecordPlantViewModel
import com.plantellect.mobileplantellect.viewmodel.RecordUiState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.Request
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.InputStream

// ============================================================================
// Constants (same lists as record.js on the web)
// ============================================================================

private const val OTHER = "__other__"
private const val UNSPEC = "Unspecified"

private data class TaxField(val key: String, val level: String, val label: String)

private val TAX = listOf(
    TaxField("kingdom", "kingdom", "Kingdom"),
    TaxField("phylum", "phylum", "Phylum"),
    TaxField("plantClass", "class", "Class"),
    TaxField("order", "order", "Order"),
    TaxField("family", "family", "Family"),
    TaxField("genus", "genus", "Genus"),
    TaxField("species", "species", "Species (epithet)")
)

private data class PartField(val key: String, val label: String, val numeric: Boolean)

private val PARTS = listOf(
    PartField("heightMinCm", "Height min (cm)", true),
    PartField("heightMaxCm", "Height max (cm)", true),
    PartField("heightNote", "Height note", false),
    PartField("widthMinCm", "Width min (cm)", true),
    PartField("widthMaxCm", "Width max (cm)", true),
    PartField("widthNote", "Width note", false),
    PartField("color", "Color", false),
    PartField("shape", "Shape", false),
    PartField("texture", "Texture", false)
)

private val TOXICITY = listOf("mild" to "Mild (yellow)", "moderate" to "Moderate (orange)", "severe" to "Severe (red)")

internal val CHANGE_LABELS = mapOf(
    "commonName" to "Common name", "scientificName" to "Scientific name",
    "type.typeName" to "Type", "type.isMedicinal" to "Medicinal", "type.isHarmful" to "Harmful",
    "type.toxicityLevel" to "Toxicity level", "type.cautionNote" to "Caution note",
    "taxonomy.kingdom" to "Kingdom", "taxonomy.phylum" to "Phylum", "taxonomy.class" to "Class",
    "taxonomy.order" to "Order", "taxonomy.family" to "Family", "taxonomy.genus" to "Genus",
    "taxonomy.species" to "Species", "uses" to "Uses", "benefits" to "Benefits",
    "harmful" to "Things to watch out for",
    "parts.heightMinCm" to "Height min", "parts.heightMaxCm" to "Height max",
    "parts.widthMinCm" to "Width min", "parts.widthMaxCm" to "Width max",
    "parts.heightNote" to "Height note", "parts.widthNote" to "Width note",
    "parts.color" to "Color", "parts.shape" to "Shape", "parts.texture" to "Texture"
)

/**
 * "October 1, 2021, 12:00 PM" in the phone's time zone. Reads server ISO times ("2021-10-01T04:00:00.000Z"),
 * MySQL times ("2021-10-01 04:00:00", taken as UTC) and epoch milliseconds; unreadable text is shown as is.
 */
internal fun niceDateTime(value: String?): String {
    if (value.isNullOrBlank()) return ""
    val instant = runCatching { java.time.Instant.parse(value) }.getOrNull()
        ?: runCatching { java.time.OffsetDateTime.parse(value).toInstant() }.getOrNull()
        ?: runCatching {
            java.time.LocalDateTime.parse(value.trim().replace(' ', 'T')).atZone(java.time.ZoneOffset.UTC).toInstant()
        }.getOrNull()
        ?: value.toLongOrNull()?.let { java.time.Instant.ofEpochMilli(it) }
        ?: return value
    return java.time.format.DateTimeFormatter.ofPattern("MMMM d, yyyy, h:mm a", java.util.Locale.ENGLISH)
        .format(instant.atZone(java.time.ZoneId.systemDefault()))
}

private fun norm(s: String?) = (s ?: "").trim().replace(Regex("\\s+"), " ")
/** Short one-line text for snippets and change summaries: the typed marks are removed. */
internal fun plain(s: String) = RichText.plain(s)
private fun plantLabel(name: String?, sci: String?) = if (sci.isNullOrBlank()) name.orEmpty() else "$name ($sci)"

private fun requestTypeLabel(t: String) = when (t) {
    "plant_addition" -> "New plant submission"
    "plant_contribution" -> "Contribution"
    "plant_taxonomy" -> "Taxonomy update"
    "plant_change" -> "Change request"
    "plant_discovery" -> "Discovery report"
    else -> t
}

// ============================================================================
// Form state (what the botanist is typing). Server state lives in the ViewModel.
// ============================================================================

@Stable
class DescState {
    var uses by mutableStateOf("")
    var benefits by mutableStateOf("")
    var harmful by mutableStateOf("")
    var isHarmful by mutableStateOf(false)
    val parts = mutableStateMapOf<String, String>()
    val photos = mutableStateListOf<Uri>()

    fun hasParts() = parts.values.any { it.isNotBlank() }

    /** Measurements as JSON text, the way the server's multipart field expects them. */
    fun partsJson(): String {
        val o = JSONObject()
        PARTS.forEach { p ->
            val v = parts[p.key]?.trim().orEmpty()
            if (v.isNotEmpty()) if (p.numeric) o.put(p.key, v.toDouble()) else o.put(p.key, v)
        }
        return o.toString()
    }

    fun clear() {
        uses = ""; benefits = ""; harmful = ""; isHarmful = false
        parts.clear(); photos.clear()
    }
}

@Stable
class NewState {
    var common by mutableStateOf("")
    var sci by mutableStateOf("")
    var typeName by mutableStateOf("")
    var typeOther by mutableStateOf("")
    var medicinal by mutableStateOf(false)
    var toxicity by mutableStateOf("")
    var caution by mutableStateOf("")
    val tax = mutableStateMapOf<String, String>()
    val desc = DescState()
    val errors = mutableStateMapOf<String, String>()

    /** The optional sections start folded away; they stay as the person left them while they fill the form in. */
    var partsPanel by mutableStateOf(false)
    var taxPanel by mutableStateOf(false)
    var photosPanel by mutableStateOf(false)

    fun clear() {
        common = ""; sci = ""; typeName = ""; typeOther = ""; medicinal = false
        toxicity = ""; caution = ""; tax.clear(); desc.clear(); errors.clear()
        partsPanel = false; taxPanel = false; photosPanel = false
    }

    /** Opens the optional section that holds a field with a problem, so the form can scroll to it. */
    fun reveal(keys: Collection<String>) {
        if (keys.any { it.startsWith("part.") }) partsPanel = true
        if (keys.any { it.startsWith("tax.") }) taxPanel = true
    }
}

@Stable
class ContribState {
    val desc = DescState()
    var taxOpen by mutableStateOf(false)
    val taxEdit = mutableStateMapOf<String, String>()
    var taxReason by mutableStateOf("")
    val errors = mutableStateMapOf<String, String>()

    /** The optional sections (folded away until opened). [taxOpen] is the update editor inside the taxonomy one. */
    var partsPanel by mutableStateOf(false)
    var photosPanel by mutableStateOf(false)
    var taxPanel by mutableStateOf(false)

    fun reveal(keys: Collection<String>) {
        if (keys.any { it.startsWith("part.") }) partsPanel = true
    }
}

@Stable
class ChangeState {
    var baseOn by mutableStateOf(false)
    var descOn by mutableStateOf(false)
    val base = mutableStateMapOf<String, String>()
    val tax = mutableStateMapOf<String, String>()
    var typeName by mutableStateOf("")
    var typeOther by mutableStateOf("")
    var medicinal by mutableStateOf(false)
    var harmful by mutableStateOf(false)
    var toxicity by mutableStateOf("")
    var caution by mutableStateOf("")
    var baseReason by mutableStateOf("")
    var descId by mutableStateOf<String?>(null)
    val desc = mutableStateMapOf<String, String>()
    var descReason by mutableStateOf("")
    val errors = mutableStateMapOf<String, String>()

    /** Optional sections, folded away until opened. */
    var taxPanel by mutableStateOf(false)
    var partsPanel by mutableStateOf(false)

    fun reset() {
        baseOn = false; descOn = false; base.clear(); tax.clear(); desc.clear()
        baseReason = ""; descReason = ""; descId = null; errors.clear()
        taxPanel = false; partsPanel = false
    }

    fun reveal(keys: Collection<String>) {
        if (keys.any { it.startsWith("c.tax.") }) taxPanel = true
        if (keys.any { k -> PARTS.any { k == "cd.${it.key}" } }) partsPanel = true
    }

    /** Pre-fills every box with the plant's current values; unchanged or blank later means "no change". */
    fun load(d: RecEditable) {
        reset()
        base["commonName"] = d.values?.get("commonName").asText()
        base["scientificName"] = d.values?.get("scientificName").asText()
        TAX.forEach { f -> tax[f.key] = d.taxonomy?.get(f.level)?.takeIf { it != UNSPEC } ?: "" }
        val t = d.type
        typeName = t?.typeName ?: ""; typeOther = ""
        medicinal = t?.isMedicinal == true
        harmful = t?.isHarmful == true
        toxicity = if (harmful) (t?.toxicityLevel ?: "") else ""
        caution = t?.cautionNote ?: ""
        descChoices(d).firstOrNull { !it.pending }?.let { loadDesc(d, it) }
    }

    /**
     * Opened from a description's "..." menu: tick "Change a description" and load that description, unless it
     * already has a change waiting (then nothing is chosen and the form explains why).
     */
    internal fun preselect(d: RecEditable, id: String) {
        val choice = descChoices(d).firstOrNull { it.id == id && !it.pending } ?: return
        descOn = true
        loadDesc(d, choice)
    }

    internal fun loadDesc(d: RecEditable, choice: DescChoice) {
        descId = choice.id
        desc.clear()
        descFields(d).forEach { f -> desc[f.key] = choice.values?.get(f.valueKey).asText() }
        descReason = ""
    }
}

/**
 * One description of the plant that a change request can target: yours (an admin decides) or another
 * contributor's (that contributor AND an admin must approve).
 */
internal data class DescChoice(
    val id: String,
    val mine: Boolean,
    val author: String?,
    val primary: Boolean,
    val pending: Boolean,
    val needsAuthorApproval: Boolean,
    val values: Map<String, kotlinx.serialization.json.JsonElement>?,
    val edit: RecEdit? = null
)

/** "Nov 7, 2026 3:45 PM" in the phone's own time zone; blank when the server sent nothing usable. */
private fun editStamp(iso: String?): String = runCatching {
    java.time.Instant.parse(iso!!).atZone(java.time.ZoneId.systemDefault())
        .format(java.time.format.DateTimeFormatter.ofPattern("MMM d, yyyy h:mm a", java.util.Locale.getDefault()))
}.getOrDefault("")

/**
 * The "(edited ...)" tag next to a description's name. Newest editor wins:
 *  - you edited it last  -> "(edited Nov 7, 2026 3:45 PM)"
 *  - someone else did    -> "(edited: Name · Nov 7, 2026 3:45 PM)"
 * Nothing at all while it has never been edited.
 */
internal fun DescChoice.editTag(): String {
    val e = edit ?: return ""
    if (e.editedAt.isNullOrBlank()) return ""
    val whenText = editStamp(e.editedAt)
    val byOther = e.editedByMe != true && !e.editedByName.isNullOrBlank()
    return when {
        byOther -> "(edited: ${e.editedByName}" + (if (whenText.isNotEmpty()) " · $whenText" else "") + ")"
        whenText.isNotEmpty() -> "(edited $whenText)"
        else -> "(edited)"
    }
}

/** Display name of a description: "Your description 2 (edited ...)" or "Name's description (edited: Name2 · ...)". */
internal fun descName(choices: List<DescChoice>, i: Int): String {
    val o = choices[i]
    val sameGroup = choices.count { it.mine == o.mine }
    val nth = choices.take(i + 1).count { it.mine == o.mine }
    return (if (o.mine) "Your description" else "${o.author ?: "Another contributor"}'s description") +
        (if (sameGroup > 1) " $nth" else "") +
        (if (o.primary) " (shown first)" else "") +
        o.editTag().let { if (it.isEmpty()) "" else " $it" }
}

/** Yours first, then everyone else's, each in the order the server lists them. */
internal fun descChoices(d: RecEditable): List<DescChoice> =
    d.descriptions.orEmpty().map {
        DescChoice(it.descriptionId, true, null, it.isPrimary == true, it.hasPendingChange == true, false, it.values, it.edit)
    } + d.otherDescriptions.orEmpty().map {
        DescChoice(
            it.descriptionId, false, it.authorName, it.isPrimary == true, it.hasPendingChange == true,
            it.needsAuthorApproval != false, it.values, it.edit
        )
    }

sealed interface RecordPreview {
    data class Local(val uri: Uri) : RecordPreview
    data class Remote(val url: String) : RecordPreview
}

/**
 * Asks the field whose error key matches to scroll into view (and take focus).
 * Bump [tick] on every request so asking for the same key twice still fires.
 */
@Stable
class ErrorFocus {
    var key by mutableStateOf<String?>(null)
    var tick by mutableStateOf(0)
    fun request(k: String?) { key = k; tick++ }
}

private val LocalErrorFocus = compositionLocalOf { ErrorFocus() }

/** Marks a widget as the scroll target for [key]. Optionally focuses it too. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun Modifier.errorTarget(key: String?, focus: FocusRequester? = null): Modifier {
    val requester = remember { BringIntoViewRequester() }
    val target = LocalErrorFocus.current
    LaunchedEffect(target.tick) {
        if (key != null && target.key == key) {
            requester.bringIntoView()
            runCatching { focus?.requestFocus() }
        }
    }
    return this.bringIntoViewRequester(requester)
}

@Stable
class RecordForms {
    val focus = ErrorFocus()
    var tab by mutableStateOf(0)
    /** A problem found on the phone (validation, photo type) before anything was sent. */
    var problem by mutableStateOf<String?>(null)
    /** The photo shown full screen, if any. */
    var preview by mutableStateOf<RecordPreview?>(null)
    val new = NewState()
    val contrib = ContribState()
    val change = ChangeState()
}

private data class DescField(val key: String, val label: String, val numeric: Boolean, val part: Boolean, val area: Boolean) {
    val valueKey get() = if (part) "parts.$key" else key
}

private fun descFields(d: RecEditable): List<DescField> {
    val list = mutableListOf(
        DescField("uses", "Uses", false, false, true),
        DescField("benefits", "Benefits", false, false, true)
    )
    // A safe plant has no harmful text to record.
    if (d.isSafeType != true) list += DescField("harmful", "Things to watch out for", false, false, true)
    PARTS.forEach { list += DescField(it.key, it.label, it.numeric, true, false) }
    return list
}

// ============================================================================
// Validation and request building (mirrors validatePlantDraft / record.js)
// Errors are added in on-screen order so the first one is the topmost one.
// ============================================================================

private fun chosenTypeName(types: List<RecTypeName>, typeName: String, other: String): String {
    if (typeName != OTHER) return norm(typeName)
    val typed = norm(other)
    // A name that already exists (ignoring case) keeps its existing spelling.
    return types.firstOrNull { it.typeName.equals(typed, ignoreCase = true) }?.typeName ?: typed
}

private fun validateParts(d: DescState): Map<String, String> {
    val e = linkedMapOf<String, String>()
    PARTS.filter { it.numeric }.forEach { p ->
        val v = d.parts[p.key]?.trim().orEmpty()
        if (v.isNotEmpty() && v.toDoubleOrNull() == null) e["part.${p.key}"] = "Must be a number."
    }
    fun pair(min: String, max: String, msg: String) {
        val a = d.parts[min]?.toDoubleOrNull(); val b = d.parts[max]?.toDoubleOrNull()
        if (a != null && b != null && a > b) e["part.$max"] = msg
    }
    pair("heightMinCm", "heightMaxCm", "Height max must be at least the height min.")
    pair("widthMinCm", "widthMaxCm", "Width max must be at least the width min.")
    return e
}

private fun validateNew(s: NewState, types: List<RecTypeName>): Map<String, String> {
    val e = linkedMapOf<String, String>()
    // Same order as the screen: scientific name, then common name, then plant type.
    if (s.sci.isBlank()) e["sci"] = "Enter the scientific name."
    if (s.common.isBlank()) e["common"] = "Enter the common name."
    if (s.typeName == OTHER) {
        val o = norm(s.typeOther)
        if (o.isEmpty()) e["typeOther"] = "Type the plant type, or pick one from the list."
        else if (o.length > 50) e["typeOther"] = "The plant type is at most 50 characters."
    } else if (s.typeName.isBlank()) e["typeName"] = "Choose a plant type, or pick \"Others\"."
    else if (norm(s.typeName).length > 50) e["typeName"] = "The plant type is at most 50 characters."
    if (s.desc.isHarmful && s.toxicity.isBlank()) e["tox"] = "Choose a toxicity level for a harmful plant."
    val caution = if (s.desc.isHarmful) s.desc.harmful.trim() else ""
    if (s.desc.isHarmful && caution.isEmpty()) e["harmful"] = "Describe the things to watch out for, or untick \"Harmful plant\"."
    if (!s.desc.hasParts() && s.desc.uses.isBlank() && s.desc.benefits.isBlank() && caution.isEmpty()) {
        e["uses"] = "Add a description or some measurements — names and photos alone are never published."
    }
    e.putAll(validateParts(s.desc))
    return e
}

private fun newFields(s: NewState, types: List<RecTypeName>): Map<String, String> {
    val harmful = s.desc.isHarmful
    val f = linkedMapOf<String, String>()
    f["commonName"] = s.common.trim()
    f["scientificName"] = s.sci.trim()
    f["typeName"] = chosenTypeName(types, s.typeName, s.typeOther)
    f["isMedicinal"] = if (s.medicinal) "1" else "0"
    f["isHarmful"] = if (harmful) "1" else "0"
    f["toxicityLevel"] = if (harmful) s.toxicity else "none"
    f["cautionNote"] = s.caution.trim()
    TAX.forEach { f[it.key] = s.tax[it.key]?.trim().orEmpty() }
    f["parts"] = s.desc.partsJson()
    f["uses"] = s.desc.uses.trim()
    f["benefits"] = s.desc.benefits.trim()
    if (harmful) f["harmful"] = s.desc.harmful.trim()   // omitted, not empty, when not harmful
    return f
}

private fun validateContribution(plant: RecLookupPlant?, d: DescState): Map<String, String> {
    val e = linkedMapOf<String, String>()
    if (plant == null) e["plant"] = "Choose a plant to add to."
    val caution = if (d.isHarmful) d.harmful.trim() else ""
    if (d.isHarmful && caution.isEmpty()) e["harmful"] = "Describe the things to watch out for, or untick \"This plant is harmful\"."
    if (!d.hasParts() && d.uses.isBlank() && d.benefits.isBlank() && caution.isEmpty() && d.photos.isEmpty()) {
        e["uses"] = "Add a description, some measurements, or at least one photo."
    }
    e.putAll(validateParts(d))
    return e
}

private fun contributionFields(d: DescState): Map<String, String> {
    val f = linkedMapOf("parts" to d.partsJson(), "uses" to d.uses.trim(), "benefits" to d.benefits.trim())
    if (d.isHarmful) f["harmful"] = d.harmful.trim()
    return f
}

/** The plant-info half of a change request. Adds to [errors] and returns null when something is wrong. */
private fun readBase(s: ChangeState, d: RecEditable, types: List<RecTypeName>, errors: MutableMap<String, String>): JsonObject? {
    var changed = 0
    val simple = linkedMapOf<String, String>()
    listOf("commonName", "scientificName").forEach { k ->
        val next = norm(s.base[k]); val cur = norm(d.values?.get(k).asText())
        if (next.isNotEmpty() && next != cur) { simple[k] = next; changed++ }
    }
    val tax = linkedMapOf<String, String>()
    TAX.forEach { f ->
        val next = norm(s.tax[f.key]); val cur = norm(d.taxonomy?.get(f.level)?.takeIf { it != UNSPEC })
        if (next.isNotEmpty() && next != cur) { tax[f.key] = next; changed++ }
    }

    val t = d.type
    val name = chosenTypeName(types, s.typeName, s.typeOther)
    val wantedTox = if (s.harmful) s.toxicity else "none"
    val wasTox = if (t?.isHarmful == true) (t.toxicityLevel ?: "") else "none"
    val typeChanged = name != (t?.typeName ?: "") || s.medicinal != (t?.isMedicinal == true) ||
            s.harmful != (t?.isHarmful == true) || wantedTox != wasTox || s.caution.trim() != (t?.cautionNote ?: "")
    var typeObj: JsonObject? = null
    if (typeChanged) {
        when {
            name.isEmpty() -> errors[if (s.typeName == OTHER) "c.typeOther" else "c.typeName"] = "Choose a plant type."
            name.length > 50 -> errors[if (s.typeName == OTHER) "c.typeOther" else "c.typeName"] = "The plant type is at most 50 characters."
            s.harmful && s.toxicity.isBlank() -> errors["c.tox"] = "Choose a toxicity level for a harmful plant."
            else -> {
                typeObj = buildJsonObject {
                    put("typeName", name); put("isMedicinal", s.medicinal); put("isHarmful", s.harmful)
                    put("toxicityLevel", wantedTox); put("cautionNote", s.caution.trim())
                }
                changed++
            }
        }
    }
    if (changed == 0 && errors.isEmpty()) errors["c.base"] = "Edit at least one field, or untick \"Change the plant info\"."
    val reason = norm(s.baseReason)
    if (reason.isEmpty()) {
        // The reason box is the first thing in this section, so its message goes first (the form scrolls to the first one).
        val rest = LinkedHashMap(errors)
        errors.clear()
        errors["c.baseReason"] = "Say why the plant info needs changing."
        errors.putAll(rest)
    }
    if (errors.isNotEmpty()) return null
    return buildJsonObject {
        simple.forEach { (k, v) -> put(k, v) }
        put("taxonomy", buildJsonObject { tax.forEach { (k, v) -> put(k, v) } })
        typeObj?.let { put("type", it) }
        put("reason", reason)
    }
}

/** The description half: any description of the plant (someone else's also needs its author's approval). */
private fun readDesc(s: ChangeState, d: RecEditable, errors: MutableMap<String, String>): JsonObject? {
    val before = errors.keys.toSet()
    val description = descChoices(d).firstOrNull { it.id == s.descId }
    if (description == null) { errors["c.desc"] = "Choose which description to change."; return null }
    val top = linkedMapOf<String, String>()
    val parts = linkedMapOf<String, String>()
    var changed = 0
    descFields(d).forEach { f ->
        val next = norm(s.desc[f.key]); val cur = norm(description.values?.get(f.valueKey).asText())
        if (next.isEmpty() || next == cur) return@forEach
        if (f.numeric && next.toDoubleOrNull() == null) { errors["cd.${f.key}"] = "Must be a number."; return@forEach }
        if (f.part) parts[f.key] = next else top[f.key] = next
        changed++
    }
    if (changed == 0 && errors.isEmpty()) errors["c.desc"] = "Edit at least one field, or untick \"Change a description\"."
    val reason = norm(s.descReason)
    if (reason.isEmpty()) {
        // Reason box first on screen: its message goes ahead of this half's other messages (but after the plant-info half's).
        val mine = errors.filterKeys { it !in before }
        mine.keys.forEach { errors.remove(it) }
        errors["c.descReason"] = "Say why this description needs changing."
        errors.putAll(mine)
    }
    if (errors.isNotEmpty()) return null
    return buildJsonObject {
        put("descriptionId", description.id)
        top.forEach { (k, v) -> put(k, v) }
        put("parts", buildJsonObject { parts.forEach { (k, v) -> put(k, v) } })
        put("reason", reason)
    }
}

// ============================================================================
// Reusable form widgets
// ============================================================================

/**
 * The limit the server enforces on a plain text box, found from its error key (names 255, taxonomy 100, a
 * measurement note 150, a reason 500). Numbers and anything unknown have no limit here.
 */
private fun limitForKey(key: String, numeric: Boolean): Int = when {
    numeric -> Int.MAX_VALUE
    key.endsWith("commonName") || key == "common" || key.endsWith("scientificName") || key == "sci" -> 255
    key.startsWith("tax.") || key.startsWith("taxEdit.") || key.startsWith("c.tax.") -> 100
    key.startsWith("part.") || key.startsWith("cd.") -> 150
    key.endsWith("Reason") -> 500
    else -> Int.MAX_VALUE
}

@Composable
private fun Field(
    label: String, value: String, key: String, errors: SnapshotStateMap<String, String>,
    numeric: Boolean = false, minLines: Int = 1, placeholder: String? = null, onChange: (String) -> Unit
) {
    val focus = remember { FocusRequester() }
    val max = limitForKey(key, numeric)
    LimitedOutlinedTextField(
        value = value,
        onValueChange = { onChange(it); errors.remove(key) },
        maxChars = max,
        modifier = Modifier.fillMaxWidth().errorTarget(key, focus),
        label = label,
        placeholder = placeholder,
        errorText = errors[key],
        minLines = minLines,
        singleLine = minLines == 1,
        keyboardOptions = KeyboardOptions(keyboardType = if (numeric) KeyboardType.Decimal else KeyboardType.Text),
        showCounter = max != Int.MAX_VALUE && value.charCount() >= max * 8 / 10,
        focusRequester = focus
    )
}

/**
 * A description box with the formatting toolbar (bold, highlight, bullets ...). Same shape as [Field]; the
 * text it hands back is what the server stores and the plant page shows formatted.
 */
@Composable
private fun RichField(
    label: String, value: String, key: String, errors: SnapshotStateMap<String, String>,
    minLines: Int = 3, onChange: (String) -> Unit
) {
    RichTextField(
        label = label,
        value = value,
        onValueChange = { onChange(it); errors.remove(key) },
        modifier = Modifier.fillMaxWidth().errorTarget(key),
        minLines = minLines,
        isError = key in errors,
        supportingText = errors[key]
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Dropdown(
    label: String, selectedLabel: String, options: List<Pair<String, String>>,
    error: String? = null, errorKey: String? = null, onSelect: (String) -> Unit
) {
    var open by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded = open, onExpandedChange = { open = it }) {
        OutlinedTextField(
            value = selectedLabel, onValueChange = {}, readOnly = true,
            label = { Text(label) },
            isError = error != null,
            supportingText = error?.let { { Text(it) } },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = open) },
            modifier = Modifier.menuAnchor(ExposedDropdownMenuAnchorType.PrimaryNotEditable).fillMaxWidth().errorTarget(errorKey),
            shape = MaterialTheme.shapes.small
        )
        ExposedDropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            options.forEach { (value, text) ->
                DropdownMenuItem(text = { Text(text) }, onClick = { onSelect(value); open = false })
            }
        }
    }
}

/**
 * Every approved description of the plant, in two groups: Own (what you contributed) and Others (what other
 * contributors wrote). Each is a card you can read before choosing it, with its "(edited ...)" tag. Picking one
 * loads it into the form below; a description that already has a change waiting cannot be picked.
 */
@Composable
private fun DescriptionCards(choices: List<DescChoice>, selectedId: String?, onSelect: (String) -> Unit) {
    val c = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Which description?", style = MaterialTheme.typography.titleSmall)
        listOf("Own" to true, "Others" to false).forEach { (title, mine) ->
            val indexes = choices.indices.filter { choices[it].mine == mine }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(title, style = MaterialTheme.typography.labelLarge, color = c.primary)
                CountBadge(indexes.size, showZero = true, emphasized = false)
            }
            if (indexes.isEmpty()) {
                Text(
                    if (mine) "You have not contributed a description to this plant." else "Nobody else has described this plant.",
                    style = MaterialTheme.typography.bodySmall, color = c.onSurfaceVariant
                )
            }
            indexes.forEach { i ->
                val o = choices[i]
                val selected = o.id == selectedId
                val snippet = plain(
                    o.values?.get("uses").asText().ifBlank { o.values?.get("benefits").asText() }
                        .ifBlank { o.values?.get("harmful").asText() }
                ).take(160)
                Surface(
                    onClick = { onSelect(o.id) },
                    enabled = !o.pending,
                    shape = MaterialTheme.shapes.small,
                    color = if (selected) c.primaryContainer.copy(alpha = 0.35f) else c.surface,
                    border = androidx.compose.foundation.BorderStroke(
                        if (selected) 2.dp else 1.dp, if (selected) c.primary else c.outlineVariant
                    ),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.Top,
                        horizontalArrangement = Arrangement.spacedBy(4.dp)
                    ) {
                        RadioButton(selected = selected, onClick = null, enabled = !o.pending, modifier = Modifier.padding(top = 2.dp, start = 4.dp, end = 4.dp))
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(descName(choices, i), style = MaterialTheme.typography.titleSmall, color = c.onSurface)
                            if (snippet.isNotEmpty()) {
                                Text(
                                    snippet, style = MaterialTheme.typography.bodySmall, color = c.onSurfaceVariant,
                                    maxLines = 3, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis
                                )
                            }
                            if (o.pending) {
                                Text("A change is already waiting for review.", style = MaterialTheme.typography.labelSmall, color = c.error)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun CheckRow(label: String, checked: Boolean, enabled: Boolean = true, onChange: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(enabled = enabled) { onChange(!checked) },
        verticalAlignment = Alignment.CenterVertically
    ) {
        Checkbox(checked = checked, onCheckedChange = onChange, enabled = enabled)
        Text(label, style = MaterialTheme.typography.bodyLarge)
    }
}

@Composable
private fun RecordSectionTitle(text: String) =
    Text(text, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurface)

@Composable
private fun Hint(text: String) =
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)

@Composable
private fun ErrorText(text: String?, key: String? = null) {
    if (text != null) Text(
        text, Modifier.errorTarget(key),
        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error
    )
}

/** Heading for a block of the form: "Required" (cannot be left blank) or "Optional". */
@Composable
private fun FormGroupLabel(title: String, note: String) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(
            title.uppercase(),
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.primary,
            fontWeight = androidx.compose.ui.text.font.FontWeight.Bold
        )
        Hint(note)
    }
}

/**
 * An optional part of the form that folds away. Closed it shows the [title] and a one-line [summary] of what is
 * inside; tap it to open. The values live in the form state, so closing it loses nothing.
 */
@Composable
private fun CollapsibleSection(
    title: String,
    summary: String?,
    expanded: Boolean,
    onToggle: () -> Unit,
    content: @Composable ColumnScope.() -> Unit
) {
    val c = MaterialTheme.colorScheme
    val rotation by animateFloatAsState(if (expanded) 180f else 0f, label = "sectionArrow")
    Surface(
        shape = MaterialTheme.shapes.small,
        color = Color.Transparent,
        border = BorderStroke(1.dp, c.outlineVariant),
        modifier = Modifier.fillMaxWidth()
    ) {
        Column(Modifier.fillMaxWidth()) {
            Row(
                Modifier.fillMaxWidth()
                    .clickable(onClickLabel = if (expanded) "Fold away $title" else "Open $title", onClick = onToggle)
                    .padding(horizontal = 14.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(Modifier.weight(1f)) {
                    Text(title, style = MaterialTheme.typography.titleSmall, color = c.onSurface)
                    if (!expanded && summary != null) {
                        Text(summary, style = MaterialTheme.typography.bodySmall, color = c.onSurfaceVariant)
                    }
                }
                Icon(
                    Icons.Filled.ArrowDropDown,
                    contentDescription = null,
                    modifier = Modifier.graphicsLayer { rotationZ = rotation }
                )
            }
            AnimatedVisibility(visible = expanded) {
                Column(
                    Modifier.fillMaxWidth().padding(start = 14.dp, end = 14.dp, bottom = 14.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                    content = content
                )
            }
        }
    }
}

private const val PARTS_SUMMARY = "Height, width, color, shape, texture"

/** "3 filled in" for a folded section that already holds something, else [empty]. */
private fun filledSummary(values: Collection<String>, empty: String): String {
    val n = values.count { it.isNotBlank() }
    return if (n > 0) "$n filled in" else empty
}

/** Section header that says the description is required, and turns red when it is what's missing. */
@Composable
private fun DescriptionHeader(hasError: Boolean, text: String) {
    RecordSectionTitle("Description *")
    Text(
        text,
        style = MaterialTheme.typography.bodySmall,
        color = if (hasError) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant
    )
}

/** Plant type: names already in use (most used first) plus "Others" to type a new one. */
@Composable
private fun TypeEditor(
    types: List<RecTypeName>, typeName: String, other: String, errors: SnapshotStateMap<String, String>,
    nameKey: String, otherKey: String, onName: (String) -> Unit, onOther: (String) -> Unit
) {
    val options = types.map { it.typeName to it.typeName } +
            (OTHER to "Others")
    val shown = when {
        typeName == OTHER -> "Others"
        typeName.isBlank() -> ""
        else -> typeName
    }
    Dropdown("Plant type *", shown, options, errors[nameKey], nameKey) { onName(it); errors.remove(nameKey) }
    if (typeName == OTHER) Field("New plant type", other, otherKey, errors, onChange = onOther)
}

@Composable
private fun ToxicityPicker(value: String, error: String?, errorKey: String, onSelect: (String) -> Unit) =
    Dropdown("Toxicity level *", TOXICITY.firstOrNull { it.first == value }?.second ?: "", TOXICITY, error, errorKey, onSelect)

@Composable
private fun PartsEditor(d: DescState, errors: SnapshotStateMap<String, String>) {
    PARTS.forEach { p ->
        Field(p.label, d.parts[p.key].orEmpty(), "part.${p.key}", errors, numeric = p.numeric) { d.parts[p.key] = it }
    }
}

private fun fileName(cr: ContentResolver, uri: Uri): String {
    cr.query(uri, null, null, null, null)?.use { c ->
        val i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        if (c.moveToFirst() && i >= 0) return c.getString(i) ?: "photo"
    }
    return "photo"
}

/** Decodes a downsampled bitmap (longest side <= maxPx) and applies the EXIF rotation. */
private fun decodeBitmap(open: () -> InputStream?, maxPx: Int): ImageBitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    open()?.use { BitmapFactory.decodeStream(it, null, bounds) }
    if (bounds.outWidth <= 0) return null
    var sample = 1
    while (bounds.outWidth / sample > maxPx || bounds.outHeight / sample > maxPx) sample *= 2
    val bmp = open()?.use { BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample }) }
        ?: return null
    val degrees = runCatching {
        open()?.use {
            when (ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
                ExifInterface.ORIENTATION_ROTATE_90 -> 90f
                ExifInterface.ORIENTATION_ROTATE_180 -> 180f
                ExifInterface.ORIENTATION_ROTATE_270 -> 270f
                else -> 0f
            }
        } ?: 0f
    }.getOrDefault(0f)
    if (degrees == 0f) return bmp.asImageBitmap()
    val m = Matrix().apply { postRotate(degrees) }
    return android.graphics.Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, m, true).asImageBitmap()
}

@Composable
private fun BitmapBox(bmp: ImageBitmap?, modifier: Modifier, scale: ContentScale) {
    if (bmp != null) Image(bmp, contentDescription = null, modifier = modifier, contentScale = scale)
    else Box(modifier.background(MaterialTheme.colorScheme.surfaceVariant), contentAlignment = Alignment.Center) {
        Text("…", color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** A photo the botanist picked on this phone. */
@Composable
private fun LocalImage(uri: Uri, maxPx: Int, modifier: Modifier, scale: ContentScale) {
    val cr = LocalContext.current.contentResolver
    val bmp by produceState<ImageBitmap?>(null, uri, maxPx) {
        value = withContext(Dispatchers.IO) { runCatching { decodeBitmap({ cr.openInputStream(uri) }, maxPx) }.getOrNull() }
    }
    BitmapBox(bmp, modifier, scale)
}

/** A photo on the server. Loaded with the app's shared OkHttpClient so the session cookie is sent. */
@Composable
private fun RemoteImage(url: String, maxPx: Int, modifier: Modifier, scale: ContentScale) {
    val client = (LocalContext.current.applicationContext as PlantellectApp).container.network.okHttpClient
    val bmp by produceState<ImageBitmap?>(null, url, maxPx) {
        value = withContext(Dispatchers.IO) {
            runCatching {
                val bytes = client.newCall(Request.Builder().url(url).build()).execute().use { r ->
                    if (r.isSuccessful) r.body?.bytes() else null
                }
                bytes?.let { decodeBitmap({ ByteArrayInputStream(it) }, maxPx) }
            }.getOrNull()
        }
    }
    BitmapBox(bmp, modifier, scale)
}

@Composable
private fun PreviewDialog(src: RecordPreview, onClose: () -> Unit) {
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.extraColors.overlay.copy(alpha = 0.92f)) {
            Box(Modifier.fillMaxSize()) {
                val fill = Modifier.fillMaxSize().padding(16.dp)
                // Pinch or double-tap to zoom; a tap on the un-zoomed photo closes it.
                ZoomableBox(Modifier.fillMaxSize(), resetKey = src, onTap = onClose) {
                    when (src) {
                        is RecordPreview.Local -> LocalImage(src.uri, 2048, fill, ContentScale.Fit)
                        is RecordPreview.Remote -> RemoteImage(src.url, 2048, fill, ContentScale.Fit)
                    }
                }
                PlantTextButton(onClose, Modifier.align(Alignment.TopEnd).statusBarsPadding()) {
                    Text("Close", color = MaterialTheme.extraColors.onOverlay)
                }
            }
        }
    }
}

@Composable
private fun PhotoSection(
    photos: SnapshotStateList<Uri>, max: Int, onPreview: (Uri) -> Unit, onProblem: (String) -> Unit,
    showTitle: Boolean = true
) {
    val cr = LocalContext.current.contentResolver
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        val problems = linkedSetOf<String>()
        uris.forEach { u ->
            when {
                cr.getType(u)?.startsWith("image/") != true -> problems += "\"${fileName(cr, u)}\" is not a photo."
                u in photos -> {}
                photos.size >= max -> problems += "At most $max photos per submission."
                else -> photos.add(u)
            }
        }
        if (problems.isNotEmpty()) onProblem(problems.joinToString(" "))
    }
    if (showTitle) RecordSectionTitle("Photos")
    Hint("Up to $max photos (${photos.size} added). Tap a photo to preview it. They are reviewed before anything is published.")
    PlantOutlinedButton({ launcher.launch("image/*") }, shape = MaterialTheme.shapes.small) { Text("Add photos") }
    if (photos.isNotEmpty()) {
        HScroll {
            photos.toList().forEach { u ->
                Box(Modifier.size(96.dp)) {
                    LocalImage(u, 256, Modifier.fillMaxSize().clip(RoundedCornerShape(8.dp)).clickable { onPreview(u) }, ContentScale.Crop)
                    Surface(
                        shape = CircleShape, color = MaterialTheme.extraColors.overlay.copy(alpha = 0.6f),
                        modifier = Modifier.align(Alignment.TopEnd).padding(4.dp).size(24.dp).clickable { photos.remove(u) }
                    ) { Box(contentAlignment = Alignment.Center) { Text("×", color = MaterialTheme.extraColors.onOverlay) } }
                }
            }
        }
    }
}

/** Search box + type filter + results. Shows the chosen plant once one is picked. */
@Composable
private fun PlantPicker(
    vm: RecordPlantViewModel, ui: RecordUiState, chosenLabel: String?, error: String?, errorKey: String,
    onPick: (RecPlantItem) -> Unit, onClear: () -> Unit
) {
    if (chosenLabel != null) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(chosenLabel, Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
            PlantTextButton(onClear) { Text("Change") }
        }
        return
    }
    var query by remember { mutableStateOf("") }
    var filter by remember { mutableStateOf("") }
    var nameFilter by remember { mutableStateOf("") }   // "", "common" or "scientific"
    var focused by remember { mutableStateOf(false) }
    LaunchedEffect(query, filter, nameFilter) { vm.search(query, filter.ifBlank { null }, nameFilter.ifBlank { null }) }   // the VM debounces

    // Filters first: type, then which name to match. The plant name box comes after them.
    Dropdown(
        "Type", filter.ifBlank { "All types" },
        listOf("" to "All types") + ui.types.map { it.typeName to it.typeName }
    ) { filter = it }
    Dropdown(
        "Search by", when (nameFilter) { "common" -> "Common name"; "scientific" -> "Scientific name"; else -> "Common or scientific name" },
        listOf("" to "Common or scientific name", "common" to "Common name", "scientific" to "Scientific name")
    ) { nameFilter = it }

    // Suggestions are anchored to the name box and only exist while it has focus.
    val focusManager = androidx.compose.ui.platform.LocalFocusManager.current
    // Names only START WITH what was typed, so "j" lists names beginning with J (the server does the matching).
    val shown = if (focused) ui.results.filter { p ->
        val q = query.trim()
        q.isEmpty() || when (nameFilter) {
            "common" -> p.name.startsWith(q, ignoreCase = true)
            "scientific" -> p.scientificName.orEmpty().startsWith(q, ignoreCase = true)
            else -> p.name.startsWith(q, ignoreCase = true) || p.scientificName.orEmpty().startsWith(q, ignoreCase = true)
        }
    } else emptyList()

    Column(Modifier.fillMaxWidth()) {
        OutlinedTextField(
            value = query, onValueChange = { query = it },
            modifier = Modifier.fillMaxWidth().errorTarget(errorKey).onFocusChanged { focused = it.isFocused },
            label = { Text("Plant name") }, singleLine = true, isError = error != null,
            supportingText = error?.let { { Text(it) } }, shape = MaterialTheme.shapes.small
        )
        if (focused) {
            Surface(
                Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.small, tonalElevation = 3.dp,
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant)
            ) {
                val suggestionScroll = rememberScrollState()
                Column(Modifier.fillMaxWidth().heightIn(max = 320.dp).trapScroll(suggestionScroll).verticalScroll(suggestionScroll)) {
                    if (shown.isEmpty()) Text(
                        "Nothing matched.", Modifier.padding(12.dp),
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    shown.take(8).forEach { p ->
                        Column(Modifier.fillMaxWidth().clickable { focusManager.clearFocus(); onPick(p) }.padding(horizontal = 12.dp, vertical = 8.dp)) {
                            Text(p.name, style = MaterialTheme.typography.titleSmall)
                            Text(
                                listOfNotNull(p.scientificName, p.typeLabel).joinToString(" · "),
                                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                        HorizontalDivider()
                    }
                    if (shown.size > 8) Hint("Showing the first 8. Keep typing to narrow it down.")
                }
            }
        }
    }
}

// ============================================================================
// Tab 1: NEW PLANT
// ============================================================================

@Composable
private fun NewPlantTab(vm: RecordPlantViewModel, ui: RecordUiState, f: RecordForms) {
    val s = f.new
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {

        // ------------------------------------------------------------ REQUIRED: cannot be left blank
        FormGroupLabel("Required", "These must be filled in before you can submit.")

        Field("Scientific name *", s.sci, "sci", s.errors) { s.sci = it; if (ui.duplicate != null) vm.clearDuplicate() }

        ui.duplicate?.let { dup ->
            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        "Already in the library — ${dup.name} (${dup.scientificName}). Recording it again would create a " +
                                "second copy, so your text and photos can go to that plant as a contribution.",
                        style = MaterialTheme.typography.bodyMedium
                    )
                    PlantOutlinedButton({
                        // Carry the draft across, then open the contribution for that plant.
                        val n = s.desc; val c = f.contrib.desc
                        if (n.uses.isNotBlank() && c.uses.isBlank()) c.uses = n.uses
                        if (n.benefits.isNotBlank() && c.benefits.isBlank()) c.benefits = n.benefits
                        if (n.harmful.isNotBlank() && c.harmful.isBlank()) c.harmful = n.harmful
                        n.parts.forEach { (k, v) -> if (v.isNotBlank() && c.parts[k].isNullOrBlank()) c.parts[k] = v }
                        c.isHarmful = n.isHarmful
                        n.photos.forEach { if (it !in c.photos && c.photos.size < ui.maxPhotos) c.photos.add(it) }
                        s.clear()
                        vm.clearDuplicate()
                        vm.selectContribPlant(dup.id)
                        f.tab = 1
                    }) { Text("Add to it instead") }
                }
            }
        }

        // Common name and plant type share a line.
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top) {
            Box(Modifier.weight(1f)) { Field("Common name *", s.common, "common", s.errors) { s.common = it } }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                TypeEditor(ui.types, s.typeName, s.typeOther, s.errors, "typeName", "typeOther",
                    onName = { s.typeName = it }, onOther = { s.typeOther = it })
            }
        }

        CheckRow("Medicinal plant", s.medicinal) { s.medicinal = it }
        CheckRow("Harmful plant", s.desc.isHarmful) {
            s.desc.isHarmful = it
            if (!it) { s.toxicity = ""; s.desc.harmful = ""; s.caution = "" }
        }
        if (s.desc.isHarmful) {
            ToxicityPicker(s.toxicity, s.errors["tox"], "tox") { s.toxicity = it; s.errors.remove("tox") }
            RichField("Things to watch out for *", s.desc.harmful, "harmful", s.errors, minLines = 3) { s.desc.harmful = it }
            RichField("Caution note (optional)", s.caution, "caution", s.errors, minLines = 2) { s.caution = it }
        }

        DescriptionHeader(
            "uses" in s.errors,
            "Required: fill in at least one of Uses, Benefits or Measurements (Measurements are in the optional part below). " +
                    "Names and photos alone are never published."
        )
        RichField("Uses", s.desc.uses, "uses", s.errors, minLines = 3) { s.desc.uses = it }
        RichField("Benefits", s.desc.benefits, "benefits", s.errors, minLines = 3) { s.desc.benefits = it }

        // ------------------------------------------------------------ OPTIONAL: folded away until opened
        HorizontalDivider()
        FormGroupLabel("Optional", "Skip these, or tap one to open it and add more.")

        CollapsibleSection(
            "Measurements",
            filledSummary(s.desc.parts.values, "$PARTS_SUMMARY. Counts as a description if Uses and Benefits are empty."),
            s.partsPanel, { s.partsPanel = !s.partsPanel }
        ) { PartsEditor(s.desc, s.errors) }

        CollapsibleSection(
            "Taxonomy",
            filledSummary(s.tax.values, "Kingdom, phylum, class, order, family, genus, species"),
            s.taxPanel, { s.taxPanel = !s.taxPanel }
        ) { TAX.forEach { t -> Field(t.label, s.tax[t.key].orEmpty(), "tax.${t.key}", s.errors) { s.tax[t.key] = it } } }

        CollapsibleSection(
            "Photos",
            if (s.desc.photos.isEmpty()) "Up to ${ui.maxPhotos} photos, reviewed before anything is published"
            else "${s.desc.photos.size} added",
            s.photosPanel, { s.photosPanel = !s.photosPanel }
        ) { PhotoSection(s.desc.photos, ui.maxPhotos, { f.preview = RecordPreview.Local(it) }, { f.problem = it }, showTitle = false) }

        PlantButton(
            onClick = {
                s.errors.clear(); f.problem = null; vm.clearMessages()
                val errs = validateNew(s, ui.types)
                if (errs.isNotEmpty()) {
                    s.errors.putAll(errs); f.problem = "Please fix the highlighted fields."
                    s.reveal(errs.keys)   // a problem inside a folded section opens it
                    f.focus.request(errs.keys.first())
                } else vm.submitNew(newFields(s, ui.types), s.desc.photos.toList())
            },
            enabled = !ui.busy,
            modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp), shape = MaterialTheme.shapes.small
        ) { Text(if (ui.busy) "Submitting…" else "Submit for review") }
    }
}

// ============================================================================
// Tab 2: ADD TO EXISTING (+ taxonomy update request)
// ============================================================================

@Composable
private fun ContributeTab(vm: RecordPlantViewModel, ui: RecordUiState, f: RecordForms, fixedName: String? = null, fixedId: String? = null) {
    val c = f.contrib
    val plant = ui.contribPlant
    val safe = plant?.isSafeType == true

    // A newly chosen plant: start the taxonomy editor from its values, and drop caution text a safe type cannot have.
    LaunchedEffect(plant?.id) {
        c.errors.clear(); c.taxOpen = false; c.taxPanel = false; c.taxReason = ""; c.taxEdit.clear()
        if (plant != null) {
            TAX.forEach { t -> c.taxEdit[t.key] = plant.taxonomy?.get(t.level)?.takeIf { it != UNSPEC } ?: "" }
            if (plant.isSafeType == true) { c.desc.isHarmful = false; c.desc.harmful = "" }
        }
    }

    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {

        // ------------------------------------------------------------ REQUIRED: cannot be left blank
        if (fixedName != null) {
            // Opened from a plant's card: the plant is fixed and cannot be changed here.
            Text(
                "Contributing to: " + (plant?.let { plantLabel(it.name, it.scientificName) } ?: fixedName),
                style = MaterialTheme.typography.titleSmall
            )
            if (plant == null && ui.fixedLoading) Text("Loading…", style = MaterialTheme.typography.bodySmall)
            else if (plant == null && fixedId != null) {
                Text("This plant could not be loaded.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                PlantOutlinedButton({ vm.openFixedPlant(fixedId) }) { Text("Try again") }
            }
        }
        FormGroupLabel("Required", if (fixedName != null) "Add something about this plant." else "Choose the plant, then add something about it.")

        if (fixedName == null) PlantPicker(
            vm, ui, plant?.let { "Adding to: ${plantLabel(it.name, it.scientificName)}" }, c.errors["plant"], "plant",
            onPick = { p -> c.errors.remove("plant"); vm.selectContribPlant(p.id) },
            onClear = { vm.clearContribPlant() }
        )

        DescriptionHeader(
            "uses" in c.errors,
            "Required: add a description, some measurements, or at least one photo (measurements and photos are in the optional part below)."
        )
        if (safe) {
            Hint("This plant's type is marked safe, so a caution on its own does not count.")
        } else {
            CheckRow("This plant is harmful", c.desc.isHarmful, enabled = plant != null) {
                c.desc.isHarmful = it
                if (!it) c.desc.harmful = ""
            }
            if (c.desc.isHarmful) RichField("Things to watch out for *", c.desc.harmful, "harmful", c.errors, minLines = 3) { c.desc.harmful = it }
        }
        RichField("Uses", c.desc.uses, "uses", c.errors, minLines = 3) { c.desc.uses = it }
        RichField("Benefits", c.desc.benefits, "benefits", c.errors, minLines = 3) { c.desc.benefits = it }

        // ------------------------------------------------------------ OPTIONAL: folded away until opened
        HorizontalDivider()
        FormGroupLabel("Optional", "Skip these, or tap one to open it and add more.")

        CollapsibleSection(
            "Measurements",
            filledSummary(c.desc.parts.values, "$PARTS_SUMMARY. Counts as a description if Uses and Benefits are empty."),
            c.partsPanel, { c.partsPanel = !c.partsPanel }
        ) { PartsEditor(c.desc, c.errors) }

        CollapsibleSection(
            "Photos",
            if (c.desc.photos.isEmpty()) "Up to ${ui.maxPhotos} photos. A photo alone counts as a contribution."
            else "${c.desc.photos.size} added",
            c.photosPanel, { c.photosPanel = !c.photosPanel }
        ) { PhotoSection(c.desc.photos, ui.maxPhotos, { f.preview = RecordPreview.Local(it) }, { f.problem = it }, showTitle = false) }

        if (plant != null) {
            CollapsibleSection(
                "Taxonomy",
                "See where it sits, or ask for a correction",
                c.taxPanel, { c.taxPanel = !c.taxPanel }
            ) {
                // Taxonomy belongs to the plant: read-only here, changed only by its own request.
                TAX.forEach { t ->
                    Text("${t.label}: ${plant.taxonomy?.get(t.level).orEmpty().ifBlank { UNSPEC }}", style = MaterialTheme.typography.bodyMedium)
                }
                Hint("A contribution cannot change the taxonomy. Send a separate update request instead.")
                if (plant.hasPendingTaxonomyRequest == true) {
                    Hint("A taxonomy update for this plant is already waiting for review.")
                } else {
                    PlantTextButton({ c.taxOpen = !c.taxOpen }) { Text(if (c.taxOpen) "Cancel taxonomy update" else "Request a taxonomy update") }
                }
                if (c.taxOpen) {
                    TAX.forEach { t ->
                        Field(t.label, c.taxEdit[t.key].orEmpty(), "taxEdit.${t.key}", c.errors,
                            placeholder = if (plant.taxonomy?.get(t.level) == UNSPEC) "Unspecified — add it" else null
                        ) { c.taxEdit[t.key] = it; c.errors.remove("tax") }
                    }
                    Field("Reason (optional)", c.taxReason, "taxReason", c.errors, minLines = 2) { c.taxReason = it }
                    ErrorText(c.errors["tax"], "tax")
                    PlantButton(
                        onClick = {
                            c.errors.clear(); f.problem = null; vm.clearMessages()
                            val changed = linkedMapOf<String, String>()
                            TAX.forEach { t ->
                                val next = norm(c.taxEdit[t.key])
                                val cur = plant.taxonomy?.get(t.level)?.takeIf { it != UNSPEC } ?: ""
                                if (next.isNotEmpty() && next != cur) changed[t.key] = next
                            }
                            if (changed.isEmpty()) {
                                c.errors["tax"] = "Change at least one level before sending an update."
                                f.focus.request("tax")
                            } else vm.submitTaxonomy(plant.id, changed, c.taxReason.trim())
                        },
                        enabled = !ui.busy, shape = MaterialTheme.shapes.small
                    ) { Text("Send taxonomy update") }
                }
            }
        }

        PlantButton(
            onClick = {
                c.errors.clear(); f.problem = null; vm.clearMessages()
                val errs = validateContribution(plant, c.desc)
                if (errs.isNotEmpty() || plant == null) {
                    c.errors.putAll(errs); f.problem = "Please fix the highlighted fields."
                    c.reveal(errs.keys)   // a problem inside a folded section opens it
                    f.focus.request(errs.keys.firstOrNull() ?: "plant")
                } else vm.submitContribution(plant.id, contributionFields(c.desc), c.desc.photos.toList())
            },
            enabled = !ui.busy,
            modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp), shape = MaterialTheme.shapes.small
        ) { Text(if (ui.busy) "Submitting…" else "Submit contribution") }
    }
}

// ============================================================================
// Tab 3: REQUEST CHANGE
// ============================================================================

@Composable
private fun ChangeTab(vm: RecordPlantViewModel, ui: RecordUiState, f: RecordForms, fixedName: String? = null, fixedId: String? = null) {
    val s = f.change
    val d = ui.editable
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (fixedName != null) {
            // Opened from a plant's card: the plant is fixed and cannot be changed here.
            Text(
                "Requesting a change to: " + (d?.let { plantLabel(it.values?.get("commonName").asText(), it.values?.get("scientificName").asText()) } ?: fixedName),
                style = MaterialTheme.typography.titleSmall
            )
            Hint("Edit what is wrong and say why. Nothing changes until it is approved. A blank field means no change.")
            if (d == null) {
                if (ui.fixedLoading) Text("Loading…", style = MaterialTheme.typography.bodySmall)
                else if (fixedId != null) {
                    Text("This plant could not be loaded.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                    PlantOutlinedButton({ vm.openFixedPlant(fixedId) }) { Text("Try again") }
                }
            }
        } else {
            Hint("Pick a plant, edit what is wrong and say why. Nothing changes until it is approved. A blank field means no change.")
            PlantPicker(
                vm, ui,
                d?.let { "Requesting a change to: ${plantLabel(it.values?.get("commonName").asText(), it.values?.get("scientificName").asText())}" },
                s.errors["c.plant"], "c.plant",
                onPick = { p -> s.errors.remove("c.plant"); vm.selectChangePlant(p.id) },
                onClear = { vm.clearEditable() }
            )
        }
        if (d == null) return@Column

        // ---- the plant info half
        CheckRow("Change the plant info", s.baseOn, enabled = d.hasPendingBase != true) { s.baseOn = it; s.errors.remove("c.pick") }
        ErrorText(s.errors["c.pick"], "c.pick")
        // A plant-info change goes to the plant's primary contributor first; only if they approve does an admin decide.
        val baseApproval = d.baseApproval?.takeIf { it.needsOwnerApproval == true }
        Hint(
            when {
                d.hasPendingBase == true -> "A change to this plant's info is already waiting for review (${d.pendingBaseRequestId})."
                baseApproval != null ->
                    "Common name, scientific name, plant type and taxonomy. This is the plant's shared record: " +
                            "${baseApproval.ownerName ?: "its primary contributor"}, the primary contributor, is asked first. " +
                            "If they approve, an admin decides; if they decline, it ends there."
                else -> "Common name, scientific name, plant type and taxonomy. This is the plant's shared record, so an admin decides it."
            }
        )
        if (s.baseOn) {
            // Required first: the reason. Then the fields to edit, then the optional taxonomy.
            Field("Why does the plant info need changing? *", s.baseReason, "c.baseReason", s.errors, minLines = 2) { s.baseReason = it }
            Field("Scientific name", s.base["scientificName"].orEmpty(), "c.scientificName", s.errors) { s.base["scientificName"] = it; s.errors.remove("c.base") }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top) {
                Box(Modifier.weight(1f)) {
                    Field("Common name", s.base["commonName"].orEmpty(), "c.commonName", s.errors) { s.base["commonName"] = it; s.errors.remove("c.base") }
                }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    TypeEditor(ui.types, s.typeName, s.typeOther, s.errors, "c.typeName", "c.typeOther",
                        onName = { s.typeName = it; s.errors.remove("c.base") }, onOther = { s.typeOther = it })
                }
            }
            CheckRow("Medicinal plant", s.medicinal) { s.medicinal = it }
            CheckRow("Harmful plant", s.harmful) { s.harmful = it; if (!it) s.toxicity = "" }
            if (s.harmful) ToxicityPicker(s.toxicity, s.errors["c.tox"], "c.tox") { s.toxicity = it; s.errors.remove("c.tox") }
            RichField("Caution note", s.caution, "c.caution", s.errors, minLines = 2) { s.caution = it }
            ErrorText(s.errors["c.base"], "c.base")
            CollapsibleSection(
                "Taxonomy (optional)",
                "Kingdom, phylum, class, order, family, genus, species",
                s.taxPanel, { s.taxPanel = !s.taxPanel }
            ) {
                TAX.forEach { t ->
                    Field(t.label, s.tax[t.key].orEmpty(), "c.tax.${t.key}", s.errors,
                        placeholder = if (d.taxonomy?.get(t.level) == UNSPEC) UNSPEC else null
                    ) { s.tax[t.key] = it; s.errors.remove("c.base") }
                }
            }
        }

        HorizontalDivider()

        // ---- the description half: yours (admin decides) or another contributor's (they AND an admin decide)
        val choices = descChoices(d)
        val canEdit = choices.any { !it.pending }
        val chosen = choices.firstOrNull { it.id == s.descId }
        CheckRow("Change a description", s.descOn, enabled = canEdit) { s.descOn = it; s.errors.remove("c.pick") }
        Hint(
            when {
                choices.isEmpty() -> "This plant has no approved description yet, so there is nothing to change. Add one under Contribute."
                !canEdit -> "Every description of this plant already has a change waiting for review."
                else -> "Uses, benefits, things to watch out for and measurements. Your own descriptions need an admin's approval. " +
                        "Changing another contributor's also needs theirs: they get a notification and can approve or decline."
            }
        )
        if (s.descOn) {
            DescriptionCards(choices, s.descId) { id ->
                choices.firstOrNull { it.id == id && !it.pending }?.let { s.loadDesc(d, it) }
            }
            // Who has to say yes.
            Hint(
                when {
                    chosen == null -> "Choose the description to change."
                    chosen.mine -> "This is yours, so only an admin has to approve the change."
                    chosen.needsAuthorApproval ->
                        "This is ${chosen.author ?: "another contributor"}'s description. They will be notified and must approve, " +
                                "and then an admin must approve too."
                    else -> "This description's author is no longer active, so only an admin has to approve the change."
                }
            )
            // Required first: the reason. Then the text to edit, then the optional measurements.
            Field("Why does this description need changing? *", s.descReason, "c.descReason", s.errors, minLines = 2) { s.descReason = it }
            val fields = descFields(d)
            fields.filter { !it.part }.forEach { fld ->
                RichField(fld.label, s.desc[fld.key].orEmpty(), "cd.${fld.key}", s.errors, minLines = 3) {
                    s.desc[fld.key] = it; s.errors.remove("c.desc")
                }
                // The old text stays visible: what you delete is struck through, what you add is highlighted.
                LiveEditDiff(chosen?.values?.get(fld.valueKey).asText(), s.desc[fld.key].orEmpty())
            }
            ErrorText(s.errors["c.desc"], "c.desc")
            CollapsibleSection("Measurements (optional)", PARTS_SUMMARY, s.partsPanel, { s.partsPanel = !s.partsPanel }) {
                fields.filter { it.part }.forEach { fld ->
                    Field(fld.label, s.desc[fld.key].orEmpty(), "cd.${fld.key}", s.errors, numeric = fld.numeric) {
                        s.desc[fld.key] = it; s.errors.remove("c.desc")
                    }
                }
            }
        }

        PlantButton(
            onClick = {
                s.errors.clear(); f.problem = null; vm.clearMessages()
                if (!s.baseOn && !s.descOn) {
                    s.errors["c.pick"] = "Tick what you want to change: the plant info, your description, or both."
                    f.problem = "Nothing to send yet."
                    f.focus.request("c.pick")
                    return@PlantButton
                }
                val errs = linkedMapOf<String, String>()
                val body = linkedMapOf<String, JsonObject>()
                if (s.baseOn) readBase(s, d, ui.types, errs)?.let { body["base"] = it }
                if (s.descOn) readDesc(s, d, errs)?.let { body["description"] = it }
                if (errs.isNotEmpty()) {
                    s.errors.putAll(errs); f.problem = "Please fix the highlighted fields."
                    s.reveal(errs.keys)   // a problem inside a folded section opens it
                    f.focus.request(errs.keys.first())
                } else vm.submitChange(d.id, buildJsonObject { body.forEach { (k, v) -> put(k, v) } })
            },
            enabled = !ui.busy,
            modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp), shape = MaterialTheme.shapes.small
        ) { Text(if (ui.busy) "Sending…" else "Send change request") }
    }
}

// ============================================================================
// Tab 4: MY SUBMISSIONS
// ============================================================================

@Composable
private fun MineTab(vm: RecordPlantViewModel, ui: RecordUiState, f: RecordForms) {
    var withdrawId by remember { mutableStateOf<String?>(null) }

    withdrawId?.let { id ->
        AlertDialog(
            onDismissRequest = { withdrawId = null },
            title = { Text("Withdraw submission?") },
            text = { Text("Reviewers will no longer see it, and its photos will not be published.") },
            confirmButton = {
                PlantTextButton({ withdrawId = null; vm.withdraw(id) }) { Text("Withdraw", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { PlantTextButton({ withdrawId = null }) { Text("Cancel") } }
        )
    }

    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (ui.requestsLoading && ui.requests.isEmpty()) Text("Loading your submissions…")
        else if (ui.requests.isEmpty()) Hint("You have not submitted anything yet.")

        ui.requests.forEach { r ->
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    val title = if (r.requestType == "plant_change") when (r.changeScope) {
                        "base" -> "Change request · plant info"
                        "description" -> "Change request · my description"
                        else -> "Change request"
                    } else requestTypeLabel(r.requestType)
                    Text(title, style = MaterialTheme.typography.titleSmall)
                    Text(
                        r.status.replaceFirstChar { it.uppercase() } +
                                if (r.status == "approved" && r.approvalMode == "auto") " · auto, no human review" else "",
                        style = MaterialTheme.typography.labelLarge,
                        color = when (r.status) {
                            "denied" -> MaterialTheme.colorScheme.error
                            "approved" -> MaterialTheme.colorScheme.primary
                            else -> MaterialTheme.colorScheme.onSurfaceVariant
                        }
                    )
                    r.targetPlantName?.let { Text("Plant: $it", style = MaterialTheme.typography.bodyMedium) }

                    r.taxonomyChanges?.forEach { (level, ch) ->
                        Text("$level: ${ch.from.asText()} → ${ch.to.asText()}", style = MaterialTheme.typography.bodySmall)
                    }
                    // A change request: each field it asks to change, before and after.
                    r.changes?.forEach { (key, ch) ->
                        val rich = key in setOf("uses", "benefits", "harmful", "type.cautionNote")
                        var from = ch.fromLabel.asText().ifEmpty { ch.from.asText() }
                        var to = ch.toLabel.asText().ifEmpty { ch.to.asText() }
                        if (rich) { from = plain(from); to = plain(to) }
                        Text(
                            "${CHANGE_LABELS[key] ?: key}: ${from.ifEmpty { "(empty)" }} → ${to.ifEmpty { "(empty)" }}",
                            style = MaterialTheme.typography.bodySmall
                        )
                    }
                    r.changeReason?.let { Hint("Reason: $it") }
                    // A change to somebody else's description also needs that contributor.
                    r.ownerApproval?.let { o ->
                        val answer = when (o.status) { "approved" -> "approved"; "denied" -> "declined"; else -> "has not answered yet" }
                        val who = if (o.role == "primary") "Primary contributor" else "Contributor"
                        Hint("$who ${o.ownerName ?: ""}: $answer. An admin also has to approve.")
                    }

                    Hint(
                        "Submitted ${niceDateTime(r.createdAt)}" +
                                (r.reviewedAt?.let { " · reviewed ${niceDateTime(it)}" } ?: "") +
                                (r.reviewerLabel?.let { " by $it" } ?: "")
                    )
                    r.note?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
                    r.discoveryRequestId?.let { Hint("From discovery report $it") }

                    // Each photo has its own status: the admin decides them one by one.
                    r.images?.takeIf { it.isNotEmpty() }?.let { imgs ->
                        HScroll {
                            imgs.forEach { img ->
                                val url = vm.absoluteUrl(img.url)
                                Column(Modifier.width(96.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                    if (url != null) {
                                        RemoteImage(
                                            url, 256,
                                            Modifier.size(96.dp).clip(RoundedCornerShape(8.dp)).clickable { f.preview = RecordPreview.Remote(url) },
                                            ContentScale.Crop
                                        )
                                    } else Hint(img.originalFilename ?: "photo")
                                    Text(
                                        (img.status ?: "pending").replaceFirstChar { it.uppercase() },
                                        style = MaterialTheme.typography.labelSmall,
                                        color = if (img.status == "rejected") MaterialTheme.colorScheme.error
                                        else MaterialTheme.colorScheme.onSurfaceVariant
                                    )
                                }
                            }
                        }
                    }

                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        // Photos can still be added to an approved species later.
                        if (r.status == "approved" && r.requestType == "plant_addition" && r.targetPlantId != null) {
                            PlantOutlinedButton({ vm.selectContribPlant(r.targetPlantId); f.tab = 1 }) { Text("Add photos") }
                        }
                        // Only while nobody has decided it yet.
                        if (r.status == "pending") {
                            PlantOutlinedButton({ withdrawId = r.id }, enabled = !ui.busy) { Text("Withdraw submission") }
                        }
                    }
                }
            }
        }

        if (!ui.requestsEnd && ui.requests.isNotEmpty()) {
            PlantOutlinedButton({ vm.loadRequests(reset = false) }, enabled = !ui.requestsLoading) {
                Text(if (ui.requestsLoading) "Loading…" else "Load more")
            }
        }
    }
}

// ============================================================================
// Screen
// ============================================================================

/**
 * The Record Plant page.
 *
 * [fixedPlantId] / [fixedPlantName]: set when the person came from a plant's profile. The page then works on
 * THAT plant only, with the plant fixed (no picker, no "Change" button), and shows ONE form, no tabs:
 *   - [changeMode] false: "Contribute", the form for adding a contribution to the plant;
 *   - [changeMode] true: "Request change", opened from the "..." menu of a description, with that description
 *     ([changeDescriptionId]) already chosen.
 * The app shell puts a Back button above it. Left null, this is the normal four-tab page opened from the sidebar.
 */
@Composable
fun RecordPlantScreen(
    fixedPlantId: String? = null,
    fixedPlantName: String = "",
    changeMode: Boolean = false,
    changeDescriptionId: String? = null,
    onBack: (() -> Unit)? = null
) {
    val app = LocalContext.current.applicationContext as PlantellectApp
    val vm: RecordPlantViewModel = viewModel(factory = app.container.viewModelFactory)
    val ui by vm.ui.collectAsState()
    val f = remember { RecordForms() }
    val c = MaterialTheme.colorScheme
    val fixed = fixedPlantId != null

    // A submission went through: clear the form it came from. The normal page then shows My submissions;
    // the fixed-plant page has no such tab, so it stays put and shows the confirmation banner.
    LaunchedEffect(ui.completed) {
        when (ui.completed) {
            RecordDone.NEW_PLANT -> { f.new.clear(); f.tab = 3 }
            RecordDone.CONTRIBUTION -> {
                f.contrib.desc.clear(); f.contrib.taxOpen = false
                if (fixed) f.tab = 1 else { vm.clearContribPlant(); f.tab = 3 }
            }
            RecordDone.CHANGE -> {
                f.change.reset()
                if (fixedPlantId != null) vm.selectChangePlant(fixedPlantId)   // read the plant again: pending flags changed
                else { vm.clearEditable(); f.tab = 3 }
            }
            RecordDone.TAXONOMY -> f.contrib.taxOpen = false
            RecordDone.WITHDRAWN, null -> {}
        }
        if (ui.completed != null) vm.consumeCompleted()
    }
    // Opened from a plant's card: fix the plant on both tabs. The view model is shared with the normal page, so
    // whatever plant it held before is dropped first, and dropped again on the way out.
    LaunchedEffect(fixedPlantId, changeMode) {
        if (fixedPlantId != null) {
            f.tab = if (changeMode) 2 else 1
            vm.openFixedPlant(fixedPlantId)   // reads the plant for both forms in one go
        }
    }
    DisposableEffect(fixedPlantId) {
        onDispose { if (fixedPlantId != null) vm.closeFixedPlant() }
    }
    // The plant was loaded on the change tab (or cleared): build / drop the form.
    // Opened from a description's menu: choose that description once, the first time the plant is read.
    var descPreselected by remember(changeDescriptionId) { mutableStateOf(false) }
    LaunchedEffect(ui.editable) {
        val e = ui.editable
        if (e == null) f.change.reset()
        else {
            f.change.load(e)
            if (changeMode && changeDescriptionId != null && !descPreselected) {
                descPreselected = true
                f.change.preselect(e, changeDescriptionId)
            }
        }
    }
    LaunchedEffect(f.tab) { if (f.tab == 3 && ui.requests.isEmpty()) vm.loadRequests(reset = true) }

    f.preview?.let { PreviewDialog(it) { f.preview = null } }

    // PlantellectPage already scrolls, so there is NO inner verticalScroll here.
    CompositionLocalProvider(LocalErrorFocus provides f.focus) {
        PlantellectPage(compact = fixed) {
            if (fixed) {
                // Opened from a plant's card: Back and the title share one row, so the form starts higher up the screen.
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    // Back is in the top bar, in line with "Plantellect".
                    Text(
                        if (changeMode) "Request change" else "Contribute",
                        style = MaterialTheme.typography.headlineSmall, color = c.onBackground
                    )
                    Text(
                        if (changeMode) "Ask for a correction to ${fixedPlantName.ifBlank { "this plant" }}. Nothing changes until it is approved."
                        else "Add to ${fixedPlantName.ifBlank { "this plant" }}. Every submission is reviewed.",
                        style = MaterialTheme.typography.bodyMedium, color = c.onBackground.copy(alpha = .72f)
                    )
                }
            } else PageHeading(
                null, "Record Plant",
                "Add new species, contribute to existing ones, or request a correction. Every submission is reviewed."
            )

            PlantSurface(Modifier.fillMaxWidth()) {
                Column(
                    Modifier.fillMaxWidth().padding(top = if (fixed) 0.dp else 12.dp, bottom = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(if (fixed) 8.dp else 12.dp)
                ) {
                    // A plant's own page has no tabs: Contribute and Request change are two separate entrances.
                    if (!fixed) {
                        ScrollableTabStrip(listOf("New plant", "Add to existing", "Request change", "My submissions"), f.tab, { f.tab = it })
                    }
                    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        val errorText = f.problem ?: ui.error
                        val banner = errorText ?: ui.notice
                        if (banner != null) {
                            Card(colors = CardDefaults.cardColors(containerColor = if (errorText != null) c.errorContainer else c.secondaryContainer)) {
                                Row(Modifier.padding(start = 12.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                                    Text(banner, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                                    PlantTextButton({ f.problem = null; vm.clearMessages() }) { Text("Dismiss") }
                                }
                            }
                        }
                        when {
                            fixed && changeMode -> ChangeTab(vm, ui, f, fixedName = fixedPlantName.ifBlank { "this plant" }, fixedId = fixedPlantId)
                            fixed -> ContributeTab(vm, ui, f, fixedName = fixedPlantName.ifBlank { "this plant" }, fixedId = fixedPlantId)
                            f.tab == 0 -> NewPlantTab(vm, ui, f)
                            f.tab == 1 -> ContributeTab(vm, ui, f)
                            f.tab == 2 -> ChangeTab(vm, ui, f)
                            else -> MineTab(vm, ui, f)
                        }
                    }
                }
            }
        }
    }
}
