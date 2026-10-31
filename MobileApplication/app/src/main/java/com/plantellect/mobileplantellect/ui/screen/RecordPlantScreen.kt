package com.plantellect.mobileplantellect.ui.screen

import android.content.ContentResolver
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.runtime.snapshots.SnapshotStateMap
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.viewmodel.compose.viewModel
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

private val CHANGE_LABELS = mapOf(
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

private fun norm(s: String?) = (s ?: "").trim().replace(Regex("\\s+"), " ")
private fun plain(s: String) = s.replace(Regex("<[^>]*>"), " ").replace(Regex("\\s+"), " ").trim()
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

    fun clear() {
        common = ""; sci = ""; typeName = ""; typeOther = ""; medicinal = false
        toxicity = ""; caution = ""; tax.clear(); desc.clear(); errors.clear()
    }
}

@Stable
class ContribState {
    val desc = DescState()
    var taxOpen by mutableStateOf(false)
    val taxEdit = mutableStateMapOf<String, String>()
    var taxReason by mutableStateOf("")
    val errors = mutableStateMapOf<String, String>()
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

    fun reset() {
        baseOn = false; descOn = false; base.clear(); tax.clear(); desc.clear()
        baseReason = ""; descReason = ""; descId = null; errors.clear()
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
        d.descriptions.orEmpty().firstOrNull { it.hasPendingChange != true }?.let { loadDesc(d, it) }
    }

    fun loadDesc(d: RecEditable, description: RecDescription) {
        descId = description.descriptionId
        desc.clear()
        descFields(d).forEach { f -> desc[f.key] = description.values?.get(f.valueKey).asText() }
        descReason = ""
    }
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
    if (s.common.isBlank()) e["common"] = "Enter the common name."
    if (s.sci.isBlank()) e["sci"] = "Enter the scientific name."
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
    if (reason.isEmpty()) errors["c.baseReason"] = "Say why the plant info needs changing."
    if (errors.isNotEmpty()) return null
    return buildJsonObject {
        simple.forEach { (k, v) -> put(k, v) }
        put("taxonomy", buildJsonObject { tax.forEach { (k, v) -> put(k, v) } })
        typeObj?.let { put("type", it) }
        put("reason", reason)
    }
}

/** The description half: only a description this botanist wrote. */
private fun readDesc(s: ChangeState, d: RecEditable, errors: MutableMap<String, String>): JsonObject? {
    val description = d.descriptions.orEmpty().firstOrNull { it.descriptionId == s.descId }
    if (description == null) { errors["c.desc"] = "Choose which of your descriptions to change."; return null }
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
    if (changed == 0 && errors.isEmpty()) errors["c.desc"] = "Edit at least one field, or untick \"Change my description\"."
    val reason = norm(s.descReason)
    if (reason.isEmpty()) errors["c.descReason"] = "Say why your description needs changing."
    if (errors.isNotEmpty()) return null
    return buildJsonObject {
        put("descriptionId", description.descriptionId)
        top.forEach { (k, v) -> put(k, v) }
        put("parts", buildJsonObject { parts.forEach { (k, v) -> put(k, v) } })
        put("reason", reason)
    }
}

// ============================================================================
// Reusable form widgets
// ============================================================================

@Composable
private fun Field(
    label: String, value: String, key: String, errors: SnapshotStateMap<String, String>,
    numeric: Boolean = false, minLines: Int = 1, placeholder: String? = null, onChange: (String) -> Unit
) {
    val focus = remember { FocusRequester() }
    OutlinedTextField(
        value = value,
        onValueChange = { onChange(it); errors.remove(key) },
        modifier = Modifier.fillMaxWidth().errorTarget(key, focus).focusRequester(focus),
        label = { Text(label) },
        placeholder = placeholder?.let { { Text(it) } },
        isError = key in errors,
        supportingText = errors[key]?.let { { Text(it) } },
        minLines = minLines,
        singleLine = minLines == 1,
        keyboardOptions = KeyboardOptions(keyboardType = if (numeric) KeyboardType.Decimal else KeyboardType.Text),
        shape = MaterialTheme.shapes.small
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
            modifier = Modifier.menuAnchor().fillMaxWidth().errorTarget(errorKey),
            shape = MaterialTheme.shapes.small
        )
        ExposedDropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            options.forEach { (value, text) ->
                DropdownMenuItem(text = { Text(text) }, onClick = { onSelect(value); open = false })
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
    val options = types.map { it.typeName to "${it.typeName} (${it.plantCount ?: 0} plant${if (it.plantCount == 1) "" else "s"})" } +
            (OTHER to "Others")
    val shown = when {
        typeName == OTHER -> "Others"
        typeName.isBlank() -> ""
        else -> options.firstOrNull { it.first == typeName }?.second ?: typeName
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
        Surface(Modifier.fillMaxSize(), color = Color.Black.copy(alpha = 0.92f)) {
            Box(Modifier.fillMaxSize().clickable(onClick = onClose)) {
                val fill = Modifier.fillMaxSize().padding(16.dp)
                when (src) {
                    is RecordPreview.Local -> LocalImage(src.uri, 2048, fill, ContentScale.Fit)
                    is RecordPreview.Remote -> RemoteImage(src.url, 2048, fill, ContentScale.Fit)
                }
                TextButton(onClose, Modifier.align(Alignment.TopEnd).statusBarsPadding()) {
                    Text("Close", color = Color.White)
                }
            }
        }
    }
}

@Composable
private fun PhotoSection(photos: SnapshotStateList<Uri>, max: Int, onPreview: (Uri) -> Unit, onProblem: (String) -> Unit) {
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
    RecordSectionTitle("Photos")
    Hint("Up to $max photos (${photos.size} added). Tap a photo to preview it. They are reviewed before anything is published.")
    OutlinedButton({ launcher.launch("image/*") }, shape = MaterialTheme.shapes.small) { Text("Add photos") }
    if (photos.isNotEmpty()) {
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            photos.toList().forEach { u ->
                Box(Modifier.size(96.dp)) {
                    LocalImage(u, 256, Modifier.fillMaxSize().clip(RoundedCornerShape(8.dp)).clickable { onPreview(u) }, ContentScale.Crop)
                    Surface(
                        shape = CircleShape, color = Color.Black.copy(alpha = 0.6f),
                        modifier = Modifier.align(Alignment.TopEnd).padding(4.dp).size(24.dp).clickable { photos.remove(u) }
                    ) { Box(contentAlignment = Alignment.Center) { Text("×", color = Color.White) } }
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
            TextButton(onClear) { Text("Change") }
        }
        return
    }
    var query by remember { mutableStateOf("") }
    var filter by remember { mutableStateOf("") }
    LaunchedEffect(query, filter) { vm.search(query, filter.ifBlank { null }) }   // the VM debounces

    OutlinedTextField(
        value = query, onValueChange = { query = it }, modifier = Modifier.fillMaxWidth().errorTarget(errorKey),
        label = { Text("Find a plant") }, singleLine = true, isError = error != null,
        supportingText = error?.let { { Text(it) } }, shape = MaterialTheme.shapes.small
    )
    Dropdown(
        "Type", filter.ifBlank { "All types" },
        listOf("" to "All types") + ui.types.map { it.typeName to it.typeName }
    ) { filter = it }
    if (ui.results.isEmpty()) Hint("Nothing matched.")
    ui.results.take(8).forEach { p ->
        Column(Modifier.fillMaxWidth().clickable { onPick(p) }.padding(vertical = 8.dp)) {
            Text(p.name, style = MaterialTheme.typography.titleSmall)
            Text(
                listOfNotNull(p.scientificName, p.typeLabel).joinToString(" · "),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        HorizontalDivider()
    }
    if (ui.results.size > 8) Hint("Showing the first 8. Type to narrow it down.")
}

// ============================================================================
// Tab 1: NEW PLANT
// ============================================================================

@Composable
private fun NewPlantTab(vm: RecordPlantViewModel, ui: RecordUiState, f: RecordForms) {
    val s = f.new
    var taxOpen by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Field("Common name *", s.common, "common", s.errors) { s.common = it }
        Field("Scientific name *", s.sci, "sci", s.errors) { s.sci = it; if (ui.duplicate != null) vm.clearDuplicate() }

        ui.duplicate?.let { dup ->
            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        "Already in the library — ${dup.name} (${dup.scientificName}). Recording it again would create a " +
                                "second copy, so your text and photos can go to that plant as a contribution.",
                        style = MaterialTheme.typography.bodyMedium
                    )
                    OutlinedButton({
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

        RecordSectionTitle("Plant type")
        TypeEditor(ui.types, s.typeName, s.typeOther, s.errors, "typeName", "typeOther",
            onName = { s.typeName = it }, onOther = { s.typeOther = it })
        CheckRow("Medicinal plant", s.medicinal) { s.medicinal = it }
        CheckRow("Harmful plant", s.desc.isHarmful) {
            s.desc.isHarmful = it
            if (!it) { s.toxicity = ""; s.desc.harmful = ""; s.caution = "" }
        }
        if (s.desc.isHarmful) {
            ToxicityPicker(s.toxicity, s.errors["tox"], "tox") { s.toxicity = it; s.errors.remove("tox") }
            Field("Caution note", s.caution, "caution", s.errors, minLines = 2) { s.caution = it }
            Field("Things to watch out for *", s.desc.harmful, "harmful", s.errors, minLines = 3) { s.desc.harmful = it }
        }

        TextButton({ taxOpen = !taxOpen }) { Text(if (taxOpen) "Hide taxonomy" else "Taxonomy (optional)") }
        if (taxOpen) TAX.forEach { t -> Field(t.label, s.tax[t.key].orEmpty(), "tax.${t.key}", s.errors) { s.tax[t.key] = it } }

        DescriptionHeader(
            "uses" in s.errors,
            "Required: fill in at least one of Uses, Benefits or Measurements. Names and photos alone are never published."
        )
        Field("Uses", s.desc.uses, "uses", s.errors, minLines = 3) { s.desc.uses = it }
        Field("Benefits", s.desc.benefits, "benefits", s.errors, minLines = 3) { s.desc.benefits = it }
        RecordSectionTitle("Measurements")
        PartsEditor(s.desc, s.errors)
        PhotoSection(s.desc.photos, ui.maxPhotos, { f.preview = RecordPreview.Local(it) }) { f.problem = it }

        Button(
            onClick = {
                s.errors.clear(); f.problem = null; vm.clearMessages()
                val errs = validateNew(s, ui.types)
                if (errs.isNotEmpty()) {
                    s.errors.putAll(errs); f.problem = "Please fix the highlighted fields."
                    f.focus.request(errs.keys.first())
                } else vm.submitNew(newFields(s, ui.types), s.desc.photos.toList())
            },
            enabled = !ui.busy,
            modifier = Modifier.fillMaxWidth().height(52.dp), shape = MaterialTheme.shapes.small
        ) { Text(if (ui.busy) "Submitting…" else "Submit for review") }
    }
}

// ============================================================================
// Tab 2: ADD TO EXISTING (+ taxonomy update request)
// ============================================================================

@Composable
private fun ContributeTab(vm: RecordPlantViewModel, ui: RecordUiState, f: RecordForms) {
    val c = f.contrib
    val plant = ui.contribPlant
    val safe = plant?.isSafeType == true

    // A newly chosen plant: start the taxonomy editor from its values, and drop caution text a safe type cannot have.
    LaunchedEffect(plant?.id) {
        c.errors.clear(); c.taxOpen = false; c.taxReason = ""; c.taxEdit.clear()
        if (plant != null) {
            TAX.forEach { t -> c.taxEdit[t.key] = plant.taxonomy?.get(t.level)?.takeIf { it != UNSPEC } ?: "" }
            if (plant.isSafeType == true) { c.desc.isHarmful = false; c.desc.harmful = "" }
        }
    }

    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        PlantPicker(
            vm, ui, plant?.let { "Adding to: ${plantLabel(it.name, it.scientificName)}" }, c.errors["plant"], "plant",
            onPick = { p -> c.errors.remove("plant"); vm.selectContribPlant(p.id) },
            onClear = { vm.clearContribPlant() }
        )

        if (plant != null) {
            // Taxonomy belongs to the plant: read-only here, changed only by its own request.
            RecordSectionTitle("Taxonomy")
            TAX.forEach { t ->
                Text("${t.label}: ${plant.taxonomy?.get(t.level).orEmpty().ifBlank { UNSPEC }}", style = MaterialTheme.typography.bodyMedium)
            }
            Hint("A contribution cannot change the taxonomy. Send a separate update request instead.")
            if (plant.hasPendingTaxonomyRequest == true) {
                Hint("A taxonomy update for this plant is already waiting for review.")
            } else {
                TextButton({ c.taxOpen = !c.taxOpen }) { Text(if (c.taxOpen) "Cancel taxonomy update" else "Request a taxonomy update") }
            }
            if (c.taxOpen) {
                TAX.forEach { t ->
                    Field(t.label, c.taxEdit[t.key].orEmpty(), "taxEdit.${t.key}", c.errors,
                        placeholder = if (plant.taxonomy?.get(t.level) == UNSPEC) "Unspecified — add it" else null
                    ) { c.taxEdit[t.key] = it; c.errors.remove("tax") }
                }
                Field("Reason (optional)", c.taxReason, "taxReason", c.errors, minLines = 2) { c.taxReason = it }
                ErrorText(c.errors["tax"], "tax")
                Button(
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
            HorizontalDivider()
        }

        DescriptionHeader(
            "uses" in c.errors,
            "Required: add a description, some measurements, or at least one photo."
        )
        if (safe) {
            Hint("This plant's type is marked safe, so a caution on its own does not count.")
        } else {
            CheckRow("This plant is harmful", c.desc.isHarmful, enabled = plant != null) {
                c.desc.isHarmful = it
                if (!it) c.desc.harmful = ""
            }
            if (c.desc.isHarmful) Field("Things to watch out for *", c.desc.harmful, "harmful", c.errors, minLines = 3) { c.desc.harmful = it }
        }
        Field("Uses", c.desc.uses, "uses", c.errors, minLines = 3) { c.desc.uses = it }
        Field("Benefits", c.desc.benefits, "benefits", c.errors, minLines = 3) { c.desc.benefits = it }
        RecordSectionTitle("Measurements")
        PartsEditor(c.desc, c.errors)
        PhotoSection(c.desc.photos, ui.maxPhotos, { f.preview = RecordPreview.Local(it) }) { f.problem = it }

        Button(
            onClick = {
                c.errors.clear(); f.problem = null; vm.clearMessages()
                val errs = validateContribution(plant, c.desc)
                if (errs.isNotEmpty() || plant == null) {
                    c.errors.putAll(errs); f.problem = "Please fix the highlighted fields."
                    f.focus.request(errs.keys.firstOrNull() ?: "plant")
                } else vm.submitContribution(plant.id, contributionFields(c.desc), c.desc.photos.toList())
            },
            enabled = !ui.busy,
            modifier = Modifier.fillMaxWidth().height(52.dp), shape = MaterialTheme.shapes.small
        ) { Text(if (ui.busy) "Submitting…" else "Submit contribution") }
    }
}

// ============================================================================
// Tab 3: REQUEST CHANGE
// ============================================================================

@Composable
private fun ChangeTab(vm: RecordPlantViewModel, ui: RecordUiState, f: RecordForms) {
    val s = f.change
    val d = ui.editable
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Hint("Pick a plant, edit what is wrong and say why. Nothing changes until an admin approves it. A blank field means no change.")
        PlantPicker(
            vm, ui,
            d?.let { "Requesting a change to: ${plantLabel(it.values?.get("commonName").asText(), it.values?.get("scientificName").asText())}" },
            s.errors["c.plant"], "c.plant",
            onPick = { p -> s.errors.remove("c.plant"); vm.selectChangePlant(p.id) },
            onClear = { vm.clearEditable() }
        )
        if (d == null) return@Column

        // ---- the plant info half
        CheckRow("Change the plant info", s.baseOn, enabled = d.hasPendingBase != true) { s.baseOn = it; s.errors.remove("c.pick") }
        ErrorText(s.errors["c.pick"], "c.pick")
        Hint(
            if (d.hasPendingBase == true) "A change to this plant's info is already waiting for review (${d.pendingBaseRequestId})."
            else "Common name, scientific name, plant type and taxonomy. This is the plant's shared record."
        )
        if (s.baseOn) {
            Field("Common name", s.base["commonName"].orEmpty(), "c.commonName", s.errors) { s.base["commonName"] = it; s.errors.remove("c.base") }
            Field("Scientific name", s.base["scientificName"].orEmpty(), "c.scientificName", s.errors) { s.base["scientificName"] = it; s.errors.remove("c.base") }
            RecordSectionTitle("This plant's type")
            TypeEditor(ui.types, s.typeName, s.typeOther, s.errors, "c.typeName", "c.typeOther",
                onName = { s.typeName = it; s.errors.remove("c.base") }, onOther = { s.typeOther = it })
            CheckRow("Medicinal plant", s.medicinal) { s.medicinal = it }
            CheckRow("Harmful plant", s.harmful) { s.harmful = it; if (!it) s.toxicity = "" }
            if (s.harmful) ToxicityPicker(s.toxicity, s.errors["c.tox"], "c.tox") { s.toxicity = it; s.errors.remove("c.tox") }
            Field("Caution note", s.caution, "c.caution", s.errors, minLines = 2) { s.caution = it }
            RecordSectionTitle("Taxonomy")
            TAX.forEach { t ->
                Field(t.label, s.tax[t.key].orEmpty(), "c.tax.${t.key}", s.errors,
                    placeholder = if (d.taxonomy?.get(t.level) == UNSPEC) UNSPEC else null
                ) { s.tax[t.key] = it; s.errors.remove("c.base") }
            }
            ErrorText(s.errors["c.base"], "c.base")
            Field("Why does the plant info need changing? *", s.baseReason, "c.baseReason", s.errors, minLines = 2) { s.baseReason = it }
        }

        HorizontalDivider()

        // ---- the description half: only descriptions this botanist wrote
        val own = d.descriptions.orEmpty()
        val canEdit = own.any { it.hasPendingChange != true }
        CheckRow("Change my description", s.descOn, enabled = canEdit) { s.descOn = it; s.errors.remove("c.pick") }
        Hint(
            when {
                own.isEmpty() -> "You have no approved description on this plant yet, so there is nothing of yours to change. Add one under Add to existing."
                !canEdit -> "Every description of yours on this plant already has a change waiting for review."
                else -> "Uses, benefits, things to watch out for and measurements. This only changes a description you wrote."
            }
        )
        if (s.descOn) {
            if (own.size >= 2) {
                val opts = own.mapIndexed { i, o ->
                    val snip = plain(o.values?.get("uses").asText().ifBlank { o.values?.get("benefits").asText() }).take(40)
                    o.descriptionId to ("Description ${i + 1}" + (if (o.isPrimary == true) " (shown first)" else "") +
                            (if (snip.isNotEmpty()) " · $snip" else "") + (if (o.hasPendingChange == true) " · change pending" else ""))
                }
                Dropdown("Which description", opts.firstOrNull { it.first == s.descId }?.second ?: "", opts) { id ->
                    own.firstOrNull { it.descriptionId == id && it.hasPendingChange != true }?.let { s.loadDesc(d, it) }
                }
            }
            descFields(d).forEach { fld ->
                Field(fld.label, s.desc[fld.key].orEmpty(), "cd.${fld.key}", s.errors,
                    numeric = fld.numeric, minLines = if (fld.area) 3 else 1
                ) { s.desc[fld.key] = it; s.errors.remove("c.desc") }
            }
            ErrorText(s.errors["c.desc"], "c.desc")
            Field("Why does your description need changing? *", s.descReason, "c.descReason", s.errors, minLines = 2) { s.descReason = it }
        }

        Button(
            onClick = {
                s.errors.clear(); f.problem = null; vm.clearMessages()
                if (!s.baseOn && !s.descOn) {
                    s.errors["c.pick"] = "Tick what you want to change: the plant info, your description, or both."
                    f.problem = "Nothing to send yet."
                    f.focus.request("c.pick")
                    return@Button
                }
                val errs = linkedMapOf<String, String>()
                val body = linkedMapOf<String, JsonObject>()
                if (s.baseOn) readBase(s, d, ui.types, errs)?.let { body["base"] = it }
                if (s.descOn) readDesc(s, d, errs)?.let { body["description"] = it }
                if (errs.isNotEmpty()) {
                    s.errors.putAll(errs); f.problem = "Please fix the highlighted fields."
                    f.focus.request(errs.keys.first())
                } else vm.submitChange(d.id, buildJsonObject { body.forEach { (k, v) -> put(k, v) } })
            },
            enabled = !ui.busy,
            modifier = Modifier.fillMaxWidth().height(52.dp), shape = MaterialTheme.shapes.small
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
                TextButton({ withdrawId = null; vm.withdraw(id) }) { Text("Withdraw", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton({ withdrawId = null }) { Text("Cancel") } }
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

                    Hint(
                        "Submitted ${r.createdAt.orEmpty()}" +
                                (r.reviewedAt?.let { " · reviewed $it" } ?: "") +
                                (r.reviewerLabel?.let { " by $it" } ?: "")
                    )
                    r.note?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
                    r.discoveryRequestId?.let { Hint("From discovery report $it") }

                    // Each photo has its own status: the admin decides them one by one.
                    r.images?.takeIf { it.isNotEmpty() }?.let { imgs ->
                        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
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
                            OutlinedButton({ vm.selectContribPlant(r.targetPlantId); f.tab = 1 }) { Text("Add photos") }
                        }
                        // Only while nobody has decided it yet.
                        if (r.status == "pending") {
                            OutlinedButton({ withdrawId = r.id }, enabled = !ui.busy) { Text("Withdraw submission") }
                        }
                    }
                }
            }
        }

        if (!ui.requestsEnd && ui.requests.isNotEmpty()) {
            OutlinedButton({ vm.loadRequests(reset = false) }, enabled = !ui.requestsLoading) {
                Text(if (ui.requestsLoading) "Loading…" else "Load more")
            }
        }
    }
}

// ============================================================================
// Screen
// ============================================================================

@Composable
fun RecordPlantScreen() {
    val app = LocalContext.current.applicationContext as PlantellectApp
    val vm: RecordPlantViewModel = viewModel(factory = app.container.viewModelFactory)
    val ui by vm.ui.collectAsState()
    val f = remember { RecordForms() }
    val c = MaterialTheme.colorScheme

    // A submission went through: clear the form it came from and show My submissions.
    LaunchedEffect(ui.completed) {
        when (ui.completed) {
            RecordDone.NEW_PLANT -> { f.new.clear(); f.tab = 3 }
            RecordDone.CONTRIBUTION -> { f.contrib.desc.clear(); f.contrib.taxOpen = false; vm.clearContribPlant(); f.tab = 3 }
            RecordDone.CHANGE -> { f.change.reset(); vm.clearEditable(); f.tab = 3 }
            RecordDone.TAXONOMY -> f.contrib.taxOpen = false
            RecordDone.WITHDRAWN, null -> {}
        }
        if (ui.completed != null) vm.consumeCompleted()
    }
    // A plant was chosen on the change tab (or cleared): build / drop the form.
    LaunchedEffect(ui.editable?.id) { ui.editable?.let { f.change.load(it) } ?: f.change.reset() }
    LaunchedEffect(f.tab) { if (f.tab == 3 && ui.requests.isEmpty()) vm.loadRequests(reset = true) }

    f.preview?.let { PreviewDialog(it) { f.preview = null } }

    // PlantellectPage already scrolls, so there is NO inner verticalScroll here.
    CompositionLocalProvider(LocalErrorFocus provides f.focus) {
        PlantellectPage {
            PageHeading(
                "Botanist", "Record a plant",
                "Add new species, contribute to existing ones, or request a correction. Every submission is reviewed."
            )

            PlantSurface(Modifier.fillMaxWidth()) {
                Column(Modifier.fillMaxWidth().padding(vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    ScrollableTabRow(selectedTabIndex = f.tab, edgePadding = 8.dp, containerColor = Color.Transparent) {
                        listOf("New plant", "Add to existing", "Request change", "My submissions").forEachIndexed { i, label ->
                            Tab(selected = f.tab == i, onClick = { f.tab = i }, text = { Text(label) })
                        }
                    }
                    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        val errorText = f.problem ?: ui.error
                        val banner = errorText ?: ui.notice
                        if (banner != null) {
                            Card(colors = CardDefaults.cardColors(containerColor = if (errorText != null) c.errorContainer else c.secondaryContainer)) {
                                Row(Modifier.padding(start = 12.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                                    Text(banner, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                                    TextButton({ f.problem = null; vm.clearMessages() }) { Text("Dismiss") }
                                }
                            }
                        }
                        when (f.tab) {
                            0 -> NewPlantTab(vm, ui, f)
                            1 -> ContributeTab(vm, ui, f)
                            2 -> ChangeTab(vm, ui, f)
                            else -> MineTab(vm, ui, f)
                        }
                    }
                }
            }
        }
    }
}