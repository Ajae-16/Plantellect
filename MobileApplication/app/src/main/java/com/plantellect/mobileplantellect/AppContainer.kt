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
import com.plantellect.mobileplantellect.data.repository.AuthRepository
import com.plantellect.mobileplantellect.data.repository.DiscoveryRepository
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

/** Hand-wired dependencies (no Hilt) so there is nothing extra for the UI team to set up. */
class AppContainer(app: Application) {
    val network = NetworkModule(app)
    private val caller = ApiCaller(network.json)
    private val session = SessionStore(app, network.json)
    val classifier = LocalPlantClassifier(app)
    val connectivity = NetworkMonitor(app)
    val settings = SettingsStore(app)
    /** Answers "can we reach the server right now?" (refreshed every 10 s while the app is open). */
    val serverMonitor = ServerMonitor(connectivity, network.okHttpClient, network.baseUrl)

    val auth = AuthRepository(network.authApi, caller, session, network.cookieJar, app.contentResolver)
    val plants = PlantRepository(network.plantApi, caller, network.baseUrl)
    val scans = ScanRepository(app, network.mlApi, caller, classifier, connectivity, serverMonitor)
    val records = RecordRepository(app, network.recordApi, caller, network.json, network.baseUrl)
    val discoveries = DiscoveryRepository(app, network.discoveryApi, caller, network.json, network.baseUrl)
    val profiles = ProfileRepository(network.botanistApi, network.discoveryApi, caller)

    val viewModelFactory: ViewModelProvider.Factory = viewModelFactory {
        initializer { AuthViewModel(auth, network.sessionExpired) }
        initializer { ScanViewModel(scans) }
        initializer { LibraryViewModel(plants) }
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