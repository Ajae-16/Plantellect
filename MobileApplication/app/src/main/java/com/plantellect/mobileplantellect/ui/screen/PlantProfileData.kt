package com.plantellect.mobileplantellect.ui.screen

import android.util.LruCache
import com.plantellect.mobileplantellect.viewmodel.LibraryViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import java.text.DateFormat
import java.text.SimpleDateFormat
import java.util.Locale

// What GET /api/plants/:plantId returns, as the profile screen needs it.
// Parsed from the raw JSON tree (like plant-profile.js reads it), so a field the
// server adds, or sends in another shape, cannot break the screen.

data class ProfilePerson(val name: String, val role: String?)

data class ProfileDescription(
    val author: String?,
    val specialization: String?,
    val isPrimary: Boolean,
    val looks: String,       // built from the measurements
    val uses: String,
    val benefits: String,
    val harmful: String
)

data class PlantProfileData(
    val id: String,
    val name: String,
    val scientificName: String,
    val typeLabel: String,
    val toxicityLevel: String?,
    val cautionNote: String,
    val added: String?,
    val quantity: String?,
    val images: List<String>,
    val descriptions: List<ProfileDescription>,
    val recordedBy: List<ProfilePerson>,
    val reviewedBy: List<ProfilePerson>,
    val reportedBy: List<ProfilePerson>
)

sealed interface ProfileLoad {
    data object Loading : ProfileLoad
    data class Ready(val data: PlantProfileData) : ProfileLoad
    data object NotFound : ProfileLoad
    data object Failed : ProfileLoad
}

/** Photo addresses from the server are paths like /resource/plant-images/display/...; make them absolute. */
fun LibraryViewModel.resolveUrl(u: String?): String? = when {
    u.isNullOrBlank() -> null
    u.startsWith("http://") || u.startsWith("https://") -> u
    else -> absoluteUrl(u)
}

private val profileCache = LruCache<String, PlantProfileData>(40)

/** Loads one plant's profile (cached). 404 means "not published yet". */
suspend fun fetchPlantProfile(
    client: OkHttpClient, vm: LibraryViewModel, plantId: String, force: Boolean = false
): ProfileLoad {
    if (!force) profileCache.get(plantId)?.let { return ProfileLoad.Ready(it) }
    val url = vm.absoluteUrl("/api/plants/$plantId") ?: return ProfileLoad.Failed
    return withContext(Dispatchers.IO) {
        runCatching {
            client.newCall(Request.Builder().url(url).build()).execute().use { r ->
                when {
                    r.code == 404 -> ProfileLoad.NotFound
                    !r.isSuccessful -> ProfileLoad.Failed
                    else -> {
                        val root = Json.parseToJsonElement(r.body?.string().orEmpty()) as? JsonObject
                        if (root == null) ProfileLoad.Failed
                        else {
                            val data = parseProfile(plantId, root, vm)
                            profileCache.put(plantId, data)
                            ProfileLoad.Ready(data)
                        }
                    }
                }
            }
        }.getOrDefault(ProfileLoad.Failed)
    }
}

/**
 * The first photo of a plant, for a card whose list row carries none
 * (the same fallback home.js uses). Null when the plant has no photo.
 */
suspend fun loadHeroUrl(client: OkHttpClient, vm: LibraryViewModel, plantId: String): String? =
    (fetchPlantProfile(client, vm, plantId) as? ProfileLoad.Ready)?.data?.images?.firstOrNull()

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

private fun JsonElement?.str(): String? = (this as? JsonPrimitive)?.contentOrNull
private fun JsonElement?.num(): Double? = (this as? JsonPrimitive)?.doubleOrNull
private fun JsonElement?.bool(): Boolean = (this as? JsonPrimitive)?.booleanOrNull == true

private fun parseProfile(id: String, root: JsonObject, vm: LibraryViewModel): PlantProfileData {
    val descriptions = (root["descriptions"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }.map { d ->
        val author = d["author"] as? JsonObject
        ProfileDescription(
            author = author?.get("name").str(),
            specialization = author?.get("specialization").str(),
            isPrimary = d["isPrimary"].bool(),
            looks = describeParts(d["parts"] as? JsonObject),
            uses = richToPlain(d["uses"].str()),
            benefits = richToPlain(d["benefits"].str()),
            harmful = richToPlain(d["harmful"].str())
        )
    }

    var images = (root["images"] as? JsonArray).orEmpty().mapNotNull { img ->
        when (img) {
            is JsonObject -> img["imageUrl"].str() ?: img["url"].str()
            ?: (img["imageId"].str() ?: img["id"].str())?.let { "/api/plants/$id/images/$it" }
            is JsonPrimitive -> img.contentOrNull
            else -> null
        }
    }.mapNotNull { vm.resolveUrl(it) }
    if (images.isEmpty()) images = listOfNotNull(vm.resolveUrl(root["imageUrl"].str()))

    return PlantProfileData(
        id = id,
        name = root["name"].str() ?: root["commonName"].str() ?: "Unnamed plant",
        scientificName = root["scientificName"].str().orEmpty(),
        typeLabel = root["typeLabel"].str() ?: root["type"].str().orEmpty(),
        toxicityLevel = root["toxicityLevel"].str(),
        cautionNote = richToPlain(root["cautionNote"].str()),
        added = formatDate(root["dateUploaded"].str() ?: root["createdAt"].str()),
        quantity = root["quantity"].str(),
        images = images,
        descriptions = descriptions,
        recordedBy = people(root["recordedBy"]),
        reviewedBy = people(root["reviewedBy"]),
        reportedBy = people(root["reportedBy"])
    )
}

/** A row may be an array of { name, accountId, role }, one object, or a joined string. */
private fun people(e: JsonElement?): List<ProfilePerson> = when (e) {
    null, is JsonNull -> emptyList()
    is JsonArray -> e.flatMap { people(it) }
    is JsonObject -> {
        val n = e["name"].str()
        if (n.isNullOrBlank()) emptyList() else listOf(ProfilePerson(n, e["role"].str() ?: e["profileType"].str()))
    }
    is JsonPrimitive -> e.content.split(Regex("\\s*[;,]\\s*")).map { it.trim() }.filter { it.isNotEmpty() }.map { ProfilePerson(it, null) }
}

private fun formatDate(raw: String?): String? {
    if (raw.isNullOrBlank() || raw.length < 10) return null
    return runCatching {
        val d = SimpleDateFormat("yyyy-MM-dd", Locale.US).parse(raw.substring(0, 10)) ?: return null
        DateFormat.getDateInstance(DateFormat.MEDIUM).format(d)
    }.getOrNull()
}

private fun number(d: Double) = if (d == d.toLong().toDouble()) d.toLong().toString() else d.toString()

private fun range(min: Double?, max: Double?, note: String?, unit: String): String {
    val n = note?.takeIf { it.isNotBlank() }
    if (min == null && max == null) return n.orEmpty()
    if (min != null && max != null && min != max) {
        return number(min) + "–" + number(max) + unit + (if (n != null) " ($n)" else "")
    }
    val only = min ?: max!!
    return number(only) + unit + (if (n != null) " — $n" else "")
}

/** "What it looks like", built from the botanist's measurements (describeParts in plant-profile.js). */
private fun describeParts(parts: JsonObject?): String {
    if (parts == null) return ""
    val lines = mutableListOf<String>()
    val height = range(parts["heightMinCm"].num(), parts["heightMaxCm"].num(), parts["heightNote"].str(), " cm")
    val width = range(parts["widthMinCm"].num(), parts["widthMaxCm"].num(), parts["widthNote"].str(), " cm")
    if (height.isNotEmpty()) lines += "Height: $height"
    if (width.isNotEmpty()) lines += "Width: $width"
    parts["color"].str()?.takeIf { it.isNotBlank() }?.let { lines += "Color: $it" }
    parts["shape"].str()?.takeIf { it.isNotBlank() }?.let { lines += "Shape: $it" }
    parts["texture"].str()?.takeIf { it.isNotBlank() }?.let { lines += "Texture: $it" }
    return lines.joinToString("\n")
}

/** A botanist's text as plain text: paragraphs and bullets kept, markup removed. */
fun richToPlain(s: String?): String {
    if (s.isNullOrBlank()) return ""
    return s.replace(Regex("(?i)<br\\s*/?>"), "\n")
        .replace(Regex("(?i)</(p|div|h[1-6]|ul|ol)>"), "\n\n")
        .replace(Regex("(?i)<li[^>]*>"), "• ")
        .replace(Regex("(?i)</li>"), "\n")
        .replace(Regex("<[^>]*>"), "")
        .replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<")
        .replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'")
        .replace("**", "")
        .lines().joinToString("\n") { it.trim() }
        .replace(Regex("\n{3,}"), "\n\n")
        .trim()
}