package com.plantellect.mobileplantellect.data.repository

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import com.plantellect.mobileplantellect.data.logic.*
import com.plantellect.mobileplantellect.data.remote.ApiConfig
import com.plantellect.mobileplantellect.data.remote.BotanistApi
import com.plantellect.mobileplantellect.data.remote.DiscoveryApi
import com.plantellect.mobileplantellect.data.remote.ProfileApi
import com.plantellect.mobileplantellect.data.remote.dto.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * The account itself (email, username, roles) comes from AuthRepository via /me.
 * Besides that, the profile shows the signed-in user's own discovery reports,
 * the same data the web profile page loads from /api/discoveries/mine, and lets the person
 * change their bio, password and profile photo (routes/profile.js).
 */
class ProfileRepository(
    private val context: Context,
    private val api: BotanistApi,
    private val discoveries: DiscoveryApi,
    private val profileApi: ProfileApi,
    private val auth: AuthRepository,
    private val caller: ApiCaller,
    private val baseUrl: String
) {
    suspend fun botanistProfile(accountId: String) = caller.call { api.profile(accountId) }

    suspend fun myReports(page: Int, pageSize: Int = REPORTS_PAGE_SIZE) =
        caller.call { discoveries.mine(page, pageSize) }

    suspend fun withdraw(requestId: String) = caller.call { discoveries.cancel(requestId) }

    // ====================================================================== own profile

    /** A loadable URL for [AccountDto.photoUrl]. Cached by URL: it carries ?v=<timestamp>, new with every photo. */
    fun photoUrl(relative: String?): String? = ApiConfig.absolute(baseUrl, relative)

    /** Re-reads bio / photo / names from the server and updates the signed-in account. */
    suspend fun loadOwn(): ApiResult<ProfileDto> =
        caller.call { profileApi.profile() }.also { r ->
            if (r is ApiResult.Success) auth.updateAccount { it.withProfile(r.value) }
        }

    /** A blank [bio] clears it. The server's cleaned-up text (trimmed, line breaks normalised) is what gets stored. */
    suspend fun updateBio(bio: String): ApiResult<BioResponse> {
        ProfileValidator.bioProblem(bio)?.let { return ApiResult.Failure(AppError.Unexpected(it)) }
        return caller.call { profileApi.updateBio(BioRequest(ProfileValidator.bioToSend(bio))) }.also { r ->
            if (r is ApiResult.Success) auth.updateAccount { it.copy(bio = r.value.bio) }
        }
    }

    /**
     * 403 = wrong current password. 429 (retryAfterSeconds set) = 5 wrong guesses, locked for 15 minutes.
     * The session stays valid on success, so there is nothing else to refresh.
     */
    suspend fun changePassword(current: String, new: String): ApiResult<MessageDto> {
        ProfileValidator.passwordProblem(current, new)?.let { return ApiResult.Failure(AppError.Unexpected(it)) }
        return caller.call { profileApi.changePassword(PasswordChangeRequest(current, new)) }
    }

    /**
     * Uploads [uri] as the profile photo. The server takes JPEG, PNG, WebP or HEIC up to 10 MB, re-encodes it to a
     * metadata-free WebP and keeps one photo per account. A photo that is over the limit is shrunk here instead of
     * being refused, since phone cameras routinely produce files that size.
     */
    suspend fun uploadPhoto(uri: Uri): ApiResult<PhotoResponse> {
        val part = try {
            withContext(Dispatchers.IO) { photoPart(uri) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return ApiResult.Failure(AppError.Unexpected("Could not read that photo."))
        } ?: return ApiResult.Failure(
            AppError.Unexpected("That photo is too large. The maximum is 10 MB.")
        )
        return caller.call { profileApi.uploadPhoto(part) }.also { r ->
            if (r is ApiResult.Success) auth.updateAccount { it.copy(photoUrl = r.value.photoUrl) }
        }
    }

    suspend fun removePhoto(): ApiResult<PhotoResponse> =
        caller.call { profileApi.removePhoto() }.also { r ->
            if (r is ApiResult.Success) auth.updateAccount { it.copy(photoUrl = null) }
            // 404 "No profile photo": the server has none either, so the app should not show one.
            if (r is ApiResult.Failure && (r.error as? AppError.Http)?.code == 404) {
                auth.updateAccount { it.copy(photoUrl = null) }
            }
        }

    /**
     * The original bytes when the file is an accepted type within 10 MB (nothing is lost), otherwise a JPEG that
     * fits. Null if it cannot be made to fit.
     */
    private fun photoPart(uri: Uri): MultipartBody.Part? {
        val resolver = context.contentResolver
        val mime = resolver.getType(uri)?.lowercase()
        val size = resolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use {
            if (it.moveToFirst() && !it.isNull(0)) it.getLong(0) else null
        }
        val acceptable = mime in ACCEPTED_TYPES
        if (acceptable && size != null && size <= UploadLimits.MAX_PROFILE_PHOTO_BYTES) {
            val bytes = resolver.openInputStream(uri)?.use { readUpTo(it, UploadLimits.MAX_PROFILE_PHOTO_BYTES) }
            if (bytes != null && bytes.isNotEmpty()) {
                return MultipartBody.Part.createFormData(
                    "image", "profile." + extensionFor(mime!!), bytes.toRequestBody(mime.toMediaType())
                )
            }
        }
        val jpeg = ImagePreparer.toJpegUnder(context, uri, UploadLimits.MAX_PROFILE_PHOTO_BYTES) ?: return null
        return MultipartBody.Part.createFormData("image", "profile.jpg", jpeg.toRequestBody("image/jpeg".toMediaType()))
    }

    /** Reads the stream, giving up (null) as soon as it passes [limit], so a wrong size column can't fill memory. */
    private fun readUpTo(input: java.io.InputStream, limit: Int): ByteArray? {
        val out = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(16 * 1024)
        while (true) {
            val n = input.read(buffer)
            if (n < 0) break
            if (out.size() + n > limit) return null
            out.write(buffer, 0, n)
        }
        return out.toByteArray()
    }

    private fun extensionFor(mime: String) = when (mime) {
        "image/png" -> "png"
        "image/webp" -> "webp"
        "image/heic" -> "heic"
        "image/heif" -> "heif"
        else -> "jpg"
    }

    private fun AccountDto.withProfile(p: ProfileDto) =
        copy(firstName = p.firstName, lastName = p.lastName, bio = p.bio, photoUrl = p.photoUrl)

    companion object {
        const val REPORTS_PAGE_SIZE = 10
        private val ACCEPTED_TYPES = setOf("image/jpeg", "image/png", "image/webp", "image/heic", "image/heif")
    }
}
