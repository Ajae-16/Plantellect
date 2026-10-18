package com.plantellect.mobileplantellect.data.logic

import com.plantellect.mobileplantellect.data.remote.dto.PlantDraftRequest
import com.plantellect.mobileplantellect.data.remote.dto.PlantPartsInput

/** Mirrors validatePlantDraft / validateContribution in config/mysql.js so the form can complain before a round trip. */
object RecordValidator {

    fun plant(d: PlantDraftRequest): List<String> = buildList {
        if (d.commonName.isBlank()) add("Common name is required")
        if (d.scientificName.isBlank()) add("Scientific name is required")
        if (d.typeId.isBlank()) add("Plant type is required")
        addAll(partsErrors(d.parts))
        // A new plant cannot carry photos (they are submitted later as a contribution),
        // so it needs a description or measurements.
        if (d.parts?.hasAnyValue() != true && d.uses.isNullOrBlank() && d.benefits.isNullOrBlank() && d.harmful.isNullOrBlank()) {
            add("A plant needs at least a description or some measurements")
        }
    }

    fun contribution(parts: PlantPartsInput?, uses: String?, benefits: String?, harmful: String?, photoCount: Int): List<String> =
        buildList {
            addAll(partsErrors(parts))
            if (parts?.hasAnyValue() != true && uses.isNullOrBlank() && benefits.isNullOrBlank() && harmful.isNullOrBlank() && photoCount == 0) {
                add("A contribution needs at least a description, some measurements, or one photo")
            }
        }

    private fun partsErrors(p: PlantPartsInput?): List<String> = buildList {
        if (p == null) return@buildList
        if (p.heightMinCm != null && p.heightMaxCm != null && p.heightMinCm > p.heightMaxCm) add("Minimum height cannot exceed maximum height")
        if (p.widthMinCm != null && p.widthMaxCm != null && p.widthMinCm > p.widthMaxCm) add("Minimum width cannot exceed maximum width")
    }
}
