package com.plantellect.mobileplantellect

import android.app.Application
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.plantellect.mobileplantellect.data.local.LocalPlantClassifier
import com.plantellect.mobileplantellect.data.local.SessionStore
import com.plantellect.mobileplantellect.data.local.SettingsStore
import com.plantellect.mobileplantellect.data.logic.ApiCaller
import com.plantellect.mobileplantellect.data.logic.NetworkMonitor
import com.plantellect.mobileplantellect.data.logic.ServerMonitor
import com.plantellect.mobileplantellect.data.remote.NetworkModule
import com.plantellect.mobileplantellect.data.remote.ScanExtrasApi
import com.plantellect.mobileplantellect.data.repository.AuthRepository
import com.plantellect.mobileplantellect.data.repository.DescriptionVoteRepository
import com.plantellect.mobileplantellect.data.repository.DiscoveryRepository
import com.plantellect.mobileplantellect.data.repository.PlantProfileRepository
import com.plantellect.mobileplantellect.data.repository.PlantRepository
import com.plantellect.mobileplantellect.data.repository.ProfileRepository
import com.plantellect.mobileplantellect.data.repository.RecordRepository
import com.plantellect.mobileplantellect.data.repository.ScanRepository
import com.plantellect.mobileplantellect.viewmodel.AuthViewModel
import com.plantellect.mobileplantellect.viewmodel.DiscoveryViewModel
import com.plantellect.mobileplantellect.viewmodel.RecordPlantViewModel
import com.plantellect.mobileplantellect.viewmodel.LibraryViewModel
import com.plantellect.mobileplantellect.viewmodel.ProfileViewModel
import com.plantellect.mobileplantellect.viewmodel.ScanViewModel
import retrofit2.Retrofit

/** Hand-wired dependencies (no Hilt) so there is nothing extra for the UI team to set up. */
class AppContainer(app: Application) {
    val network = NetworkModule(app)
    private val caller = ApiCaller(network.json)
    private val session = SessionStore(app, network.json)
    val classifier = LocalPlantClassifier(app)
    val connectivity = NetworkMonitor(app)
    val settings = SettingsStore(app)
    /** Answers "can we reach the server right now?" (refreshed every 10 s while the app is open). */
    val serverMonitor = ServerMonitor(connectivity, network.okHttpClient, network.baseUrl, settings.offlineMode)

    /**
     * "Help improve the ML" and the "Not identified?" report (contribute, summary, file, withdraw).
     * Same OkHttp client as every other API, so it shares the session cookie. No JSON converter is
     * needed: ScanExtrasApi returns raw ResponseBody and ScanRepository reads it with org.json.
     */
    private val scanExtrasApi: ScanExtrasApi = Retrofit.Builder()
        .baseUrl(network.baseUrl)
        .client(network.okHttpClient)
        .build()
        .create(ScanExtrasApi::class.java)

    val auth = AuthRepository(network.authApi, caller, session, network.cookieJar)
    val plants = PlantRepository(network.plantApi, caller, network.baseUrl)
    val scans = ScanRepository(
        context = app,
        api = network.mlApi,
        extras = scanExtrasApi,
        caller = caller,
        classifier = classifier,
        network = connectivity,
        server = serverMonitor,
        settings = settings
    )
    val records = RecordRepository(app, network.recordApi, caller, network.json, network.baseUrl)
    val discoveries = DiscoveryRepository(app, network.discoveryApi, caller, network.json, network.baseUrl)
    val profiles = ProfileRepository(app, network.botanistApi, network.discoveryApi, network.profileApi, auth, caller, network.baseUrl)
    /** One plant's full public profile (cached) and the thumbs up / down on its descriptions. */
    val plantProfiles = PlantProfileRepository(network.plantApi, network.baseUrl)
    val descriptionVotes = DescriptionVoteRepository(network.votesApi, caller)

    val viewModelFactory: ViewModelProvider.Factory = viewModelFactory {
        initializer { AuthViewModel(auth, network.sessionExpired) }
        initializer { ScanViewModel(scans, settings) }
        initializer { LibraryViewModel(plants, plantProfiles, descriptionVotes) }
        initializer { RecordPlantViewModel(records) }
        initializer { DiscoveryViewModel(discoveries) { auth.hasPermission("record_plant") } }
        initializer { ProfileViewModel(profiles) }
    }
}

class PlantellectApp : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
    }
}
