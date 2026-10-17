package com.plantellect.mobileplantellect.data.remote

import android.content.Context
import android.content.pm.ApplicationInfo
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import java.util.concurrent.TimeUnit

class NetworkModule(context: Context) {
    private val debuggable = context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0

    val baseUrl: String = if (debuggable) ApiConfig.BASE_URL_DEBUG else ApiConfig.BASE_URL_RELEASE

    val json = Json {
        ignoreUnknownKeys = true   // the server may add fields without breaking old app versions
        explicitNulls = false      // omit nulls: login must send email OR username, not both
        coerceInputValues = true
        isLenient = true           // ids that arrive as numbers still land in String fields
    }

    val cookieJar = PersistentCookieJar(context)

    private val _sessionExpired = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    /** Fires when any request other than login//me gets a 401: the server dropped our session. */
    val sessionExpired: SharedFlow<Unit> = _sessionExpired.asSharedFlow()

    /** Also hand this to the image loader (Coil) so /mine/images/* carries the session cookie. */
     *
     */
    val okHttpClient: OkHttpClient = OkHttpClient.Builder()
.cookieJar(cookieJar)
.connectTimeout(15, TimeUnit.SECONDS)
.readTimeout(60, TimeUnit.SECONDS)     // /predict waits on the ML service
.writeTimeout(60, TimeUnit.SECONDS)
.addInterceptor { chain ->
val response = chain.proceed(chain.request())
val path = chain.request().url.encodedPath
if (response.code == 401 && !path.endsWith("/login") && !path.endsWith("/me")) {
_sessionExpired.tryEmit(Unit)
}
response
}
.apply {
if (debuggable) {
// BASIC on purpose: BODY would print passwords into logcat.
addInterceptor(HttpLoggingInterceptor().apply { level = HttpLoggingInterceptor.Level.BASIC })
}
}
.build()

private val retrofit = Retrofit.Builder()
.baseUrl(baseUrl)
.client(okHttpClient)
.addConverterFactory(json.asConverterFactory("application/json; charset=UTF-8".toMediaType()))
.build()

val authApi: AuthApi = retrofit.create(AuthApi::class.java)
val plantApi: PlantApi = retrofit.create(PlantApi::class.java)
val mlApi: MlApi = retrofit.create(MlApi::class.java)
}
