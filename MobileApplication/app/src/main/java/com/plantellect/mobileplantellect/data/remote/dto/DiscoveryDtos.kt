package com.plantellect.mobileplantellect.data.remote.dto

/** One row of GET /api/discoveries/mine. Same fields the web profile page reads. */
data class ReportDto(
    val requestId: String,
    val state: String,
    val submittedAt: String? = null,
    val photoUrl: String? = null,
    val note: String? = null,
    val location: String? = null,
    val voterCount: Int = 0,
    val plantUrl: String? = null
)

data class MyReportsDto(
    val reports: List<ReportDto> = emptyList(),
    val page: Int = 1,
    val pageSize: Int = 10,
    val total: Int = 0
)