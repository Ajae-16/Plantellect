package com.plantellect.mobileplantellect.data.logic

sealed interface AppError {
    /** No connection, DNS failure or timeout. */
    data object Network : AppError
    data class Http(val code: Int, val message: String, val retryAfterSeconds: Int? = null) : AppError
    data class Unexpected(val message: String) : AppError
}

sealed interface ApiResult<out T> {
    data class Success<T>(val value: T) : ApiResult<T>
    data class Failure(val error: AppError) : ApiResult<Nothing>
}

inline fun <T, R> ApiResult<T>.map(transform: (T) -> R): ApiResult<R> = when (this) {
    is ApiResult.Success -> ApiResult.Success(transform(value))
    is ApiResult.Failure -> this
}

fun <T> ApiResult<T>.getOrNull(): T? = (this as? ApiResult.Success)?.value

/** Text the UI can show as-is. */
fun AppError.userMessage(): String = when (this) {
    AppError.Network -> "Can't reach the server. Check your connection."
    is AppError.Http -> message
    is AppError.Unexpected -> message
}
