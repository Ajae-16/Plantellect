package com.plantellect.mobileplantellect.ui.screen

import androidx.compose.runtime.Composable
import com.plantellect.mobileplantellect.viewmodel.LibraryViewModel

/** The library tab. The real screen is [LibraryScreen]; this just supplies the shared view model. */
@Composable
fun PlantInventoryScreen(vm: LibraryViewModel = libraryViewModel()) {
    LibraryScreen(vm)
}