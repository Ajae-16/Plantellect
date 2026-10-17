package com.plantellect.mobileplantellect


import android.app.Application
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.plantellect.mobileplantellect.data.local.LocalPlantClassifier
import com.plantellect.mobileplantellect.data.local.SessionStore
import com.plantellect.mobileplantellect.data.logic.ApiCaller
import com.plantellect.mobileplantellect.data.logic.NetworkMonitor
import com.plantellect.mobileplantellect.data.remote.NetworkModule
import com.plantellect.mobileplantellect.data.repository.AuthRepository
import com.plantellect.mobileplantellect.data.repository.PlantRepository
import com.plantellect.mobileplantellect.data.repository.ScanRepository
import com.plantellect.mobileplantellect.viewmodel.AuthViewModel
import com.plantellect.mobileplantellect.viewmodel.LibraryViewModel
import com.plantellect.mobileplantellect.viewmodel.ScanViewModel

/** Hand-wired dependencies (no Hilt) so there is nothing extra for the UI team to set up. */
class AppContainer(app: Application) {
    val network = NetworkModule(app)
    private val caller = ApiCaller(network.json)
    private val session = SessionStore(app, network.json)
    val classifier = LocalPlantClassifier(app)
    val connectivity = NetworkMonitor(app)

    val auth = AuthRepository(network.authApi, caller, session, network.cookieJar, app.contentResolver)
    val plants = PlantRepository(network.plantApi, caller, network.baseUrl)
    val scans = ScanRepository(app, network.mlApi, caller, classifier, connectivity)

    val viewModelFactory: ViewModelProvider.Factory = viewModelFactory {
        initializer { AuthViewModel(auth, network.sessionExpired) }
        initializer { ScanViewModel(scans) }
        initializer { LibraryViewModel(plants) }
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
