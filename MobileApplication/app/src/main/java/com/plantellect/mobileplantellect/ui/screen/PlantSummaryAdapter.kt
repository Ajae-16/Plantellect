package com.plantellect.mobileplantellect.ui.screen

import com.plantellect.mobileplantellect.data.remote.dto.PlantSummaryDto

val PlantSummaryDto.cardId: String get() = id
val PlantSummaryDto.cardName: String get() = name
val PlantSummaryDto.cardScientific: String? get() = scientificName

/** TODO: return your DTO's description field if it has one, e.g. `description`. */
val PlantSummaryDto.cardDescription: String? get() = null

/** TODO: return your DTO's toxicity field if it has one, e.g. `toxicityLevel`. Null = looked up from the profile. */
val PlantSummaryDto.cardToxicity: String? get() = null