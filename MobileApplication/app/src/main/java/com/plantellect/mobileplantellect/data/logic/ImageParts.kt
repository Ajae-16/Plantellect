package com.plantellect.mobileplantellect.data.logic

import android.content.Context
import android.net.Uri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.toRequestBody

object ImageParts {
    /** Downscales every photo to upright JPEG parts under one form field (the server reads 'images'). */
    suspend fun jpegParts(context: Context, uris: List<Uri>, field: String = "images"): List<MultipartBody.Part> =
        withContext(Dispatchers.Default) {
            uris.mapIndexed { i, uri ->
                val bytes = ImagePreparer.toJpeg(ImagePreparer.load(context, uri))
                MultipartBody.Part.createFormData(field, "photo_$i.jpg", bytes.toRequestBody("image/jpeg".toMediaType()))
            }
        }
}
