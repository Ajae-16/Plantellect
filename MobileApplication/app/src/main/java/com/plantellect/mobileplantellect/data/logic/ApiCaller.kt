package com.plantellect.mobileplantellect.data.logic

import com.plantellect.mobileplantellect.data.remote.dto.ErrorBody
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import retrofit2.Response
import java.io.IOException

/** Turns every Retrofit call into an ApiResult, so repositories and ViewModels never see exceptions. */
class ApiCaller(private val json: Json) {

    suspend fun <T> call(block: suspend () -> Response<T>): ApiResult<T> = try {
        val response = block()
        if (response.isSuccessful) {
            val body = response.body()
            if (body != null) ApiResult.Success(body)
            else ApiResult.Failure(AppError.Unexpected("Empty response from server"))
        } else {
            ApiResult.Failure(httpError(response))
        }
    } catch (e: CancellationException) {
        throw e
    } catch (e: IOException) {
        ApiResult.Failure(AppError.Network)
    } catch (e: SerializationException) {
        ApiResult.Failure(AppError.Unexpected("Unexpected response from server"))
    } catch (e: Exception) {
        ApiResult.Failure(AppError.Unexpected(e.message ?: "Something went wrong"))
    }

    private fun httpError(response: Response<*>): AppError.Http {
        val raw = runCatching { response.errorBody()?.string() }.getOrNull()
        // Non-JSON bodies (Express's plain "Something went wrong!") fall through to the default text.
        val body = raw?.let { runCatching { json.decodeFromString<ErrorBody>(it) }.getOrNull() }
        val retry = body?.retryAfter ?: response.headers()["Retry-After"]?.toIntOrNull()
        return AppError.Http(response.code(), body?.error ?: defaultText(response.code()), retry)
    }

    private fun defaultText(code: Int): String = when (code) {
        401 -> "Please sign in again."
        403 -> "You don't have permission to do that."
        404 -> "Not found."
        429 -> "Too many requests. Try again shortly."
        in 500..599 -> "The server had a problem. Try again later."
        else -> "Request failed (" + code + ")"
    }
}
