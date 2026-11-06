package com.plantellect.mobileplantellect.ui.screen

import com.plantellect.mobileplantellect.data.remote.dto.ProfileLoad
import com.plantellect.mobileplantellect.viewmodel.LibraryViewModel
import okhttp3.OkHttpClient

// The profile models, the parsing and the network call now live in the data layer:
//   data/remote/dto/PlantProfileModels.kt, data/logic/PlantProfileParser.kt, data/repository/PlantProfileRepository.kt
// reached through LibraryViewModel.profile() / heroUrl() / resolveUrl().
//
// These two wrappers only keep the existing screen call sites compiling ([client] is not used any more).
// New screens should call the view-model directly.

/** Loads one plant's profile (cached). 404 means "not published yet". */
suspend fun fetchPlantProfile(
    @Suppress("UNUSED_PARAMETER") client: OkHttpClient, vm: LibraryViewModel, plantId: String, force: Boolean = false
): ProfileLoad = vm.profile(plantId, force)

/** The first photo of a plant, for a card whose list row carries none. Null when it has no photo. */
suspend fun loadHeroUrl(
    @Suppress("UNUSED_PARAMETER") client: OkHttpClient, vm: LibraryViewModel, plantId: String
): String? = vm.heroUrl(plantId)
