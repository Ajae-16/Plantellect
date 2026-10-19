package com.plantellect.mobileplantellect.ui.screen

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.util.Log
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.FlipCameraAndroid
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.viewModel
import com.plantellect.mobileplantellect.AppContainer
import com.plantellect.mobileplantellect.PlantellectApp
import com.plantellect.mobileplantellect.data.local.LocalPlantClassifier
import com.plantellect.mobileplantellect.data.local.LocalResult
import com.plantellect.mobileplantellect.data.logic.AppError
import com.plantellect.mobileplantellect.data.logic.userMessage
import com.plantellect.mobileplantellect.data.remote.dto.PredictionDto
import com.plantellect.mobileplantellect.data.repository.ScanOutcome
import com.plantellect.mobileplantellect.data.repository.ScanUiState
import com.plantellect.mobileplantellect.viewmodel.ScanViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.collectAsStateWithLifecycle
import kotlinx.coroutines.withContext
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

@OptIn(ExperimentalGetImage::class)
@Composable
fun ScanPlantScreen() {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val colors = MaterialTheme.colorScheme

    val app = context.applicationContext as PlantellectApp
    val vm: ScanViewModel = viewModel(factory = app.container.viewModelFactory)
    val uiState by vm.state.collectAsStateWithLifecycle()

    val cameraProviderFuture = remember { ProcessCameraProvider.getInstance(context) }

    var hasCamPermission by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
                PackageManager.PERMISSION_GRANTED
        )
    }
    val permLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission(),
        onResult = { granted -> hasCamPermission = granted }
    )

    var lensFacing by remember { mutableStateOf(CameraSelector.LENS_FACING_BACK) }
    val cameraSelector = CameraSelector.Builder().requireLensFacing(lensFacing).build()

    var liveResult by remember { mutableStateOf<LocalResult?>(null) }
    var analyzing by remember { mutableStateOf(false) }
    var capturedUri by remember { mutableStateOf<Uri?>(null) }

    val analyzerExecutor = remember { Executors.newSingleThreadExecutor() }
    val captureExecutor = remember { Executors.newSingleThreadExecutor() }
    val lastAnalysisTime = remember { mutableStateOf(0L) }
    val isAnalyzerActive = remember { AtomicBoolean(false) }

    DisposableEffect(Unit) {
        onDispose {
            analyzerExecutor.shutdown()
            captureExecutor.shutdown()
            try {
                if (!analyzerExecutor.awaitTermination(1, TimeUnit.SECONDS)) {
                    analyzerExecutor.shutdownNow()
                }
                if (!captureExecutor.awaitTermination(1, TimeUnit.SECONDS)) {
                    captureExecutor.shutdownNow()
                }
            } catch (e: InterruptedException) {
                analyzerExecutor.shutdownNow()
                captureExecutor.shutdownNow()
                Thread.currentThread().interrupt()
            }
        }
    }

    val previewView = remember { PreviewView(context).apply { implementationMode = PreviewView.ImplementationMode.PERFORMANCE } }

    var imageCapture by remember { mutableStateOf<ImageCapture?>(null) }

    LaunchedEffect(cameraProviderFuture, cameraSelector) {
        val cameraProvider = cameraProviderFuture.get()
        cameraProvider.unbindAll()

        val preview = Preview.Builder().build().also {
            it.setSurfaceProvider(previewView.surfaceProvider)
        }

        val ic = ImageCapture.Builder()
            .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
            .setTargetRotation(previewView.display.rotation)
            .build()
        imageCapture = ic

        val imageAnalysis = ImageAnalysis.Builder()
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_LATEST)
            .setTargetRotation(previewView.display.rotation)
            .setResolutionStrategy(ResolutionStrategy.Builder().setTargetResolution(640, 480).build())
            .build()

        imageAnalysis.setAnalyzer(analyzerExecutor) { proxy ->
            if (!isAnalyzerActive.getAndSet(true)) {
                try {
                    analyzeFrame(proxy)
                } finally {
                    isAnalyzerActive.set(false)
                }
            } else {
                proxy.close()
            }
        }

        try {
            cameraProvider.bindToLifecycle(
                lifecycleOwner,
                cameraSelector,
                preview,
                ic,
                imageAnalysis
            )
        } catch (e: Exception) {
            Log.e("ScanPlantScreen", "Camera bind failed", e)
        }
    }

    suspend fun analyzeFrame(proxy: ImageProxy) {
        val now = System.currentTimeMillis()
        if (now - lastAnalysisTime.value < 1000) {
            proxy.close()
            return
        }
        lastAnalysisTime.value = now

        withContext(Dispatchers.Main) {
            analyzing = true
        }

        val bitmap: Bitmap = withContext(Dispatchers.Default) {
            proxy.toBitmap()
        }
        proxy.close()

        val classifier: LocalPlantClassifier = app.container.classifier
        val result: LocalResult? = withContext(Dispatchers.Default) {
            try {
                classifier.classify(bitmap)
            } catch (e: Exception) {
                Log.e("ScanPlantScreen", "Classification failed", e)
                null
            }
        }

        withContext(Dispatchers.Main) {
            liveResult = result
            analyzing = false
        }
    }

    fun capturePhoto() {
        val ic = imageCapture ?: return
        val file = File(context.cacheDir, "scan_${System.currentTimeMillis()}.jpg")
        val outputOptions = ImageCapture.OutputFileOptions.Builder(file).build()

        ic.takePicture(
            outputOptions,
            captureExecutor,
            object : ImageCapture.OnImageSavedCallback {
                override fun onImageSaved(output: ImageCapture.OutputFileResults) {
                    val uri = Uri.fromFile(file)
                    capturedUri = uri
                    vm.scan(uri)
                }

                override fun onError(exc: ImageCaptureException) {
                    Log.e("ScanPlantScreen", "Capture failed", exc)
                }
            }
        )
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(
                Brush.verticalGradient(
                    listOf(colors.primaryContainer, colors.secondaryContainer, colors.background)
                )
            )
            .systemBarsPadding()
    ) {
        if (hasCamPermission) {
            Column(
                modifier = Modifier.fillMaxSize(),
                verticalArrangement = Arrangement.spacedBy(0.dp)
            ) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .aspectRatio(3f / 4f)
                ) {
                    AndroidView(
                        modifier = Modifier.fillMaxSize(),
                        factory = { previewView },
                        update = { it.surfaceProvider = previewView.surfaceProvider }
                    )

                    Box(modifier = Modifier.fillMaxSize()) {
                        ScanFrameOverlay(
                            modifier = Modifier
                                .fillMaxSize()
                                .padding(32.dp),
                            frameColor = when {
                                liveResult?.looksLikePlant == true -> Color.Green
                                liveResult?.looksLikePlant == false -> Color.Red
                                analyzing || liveResult == null -> colors.primary
                                else -> colors.primary
                            }
                        )

                        TopBar(
                            onCameraSwitch = {
                                lensFacing = if (lensFacing == CameraSelector.LENS_FACING_BACK) {
                                    CameraSelector.LENS_FACING_FRONT
                                } else {
                                    CameraSelector.LENS_FACING_BACK
                                }
                            }
                        )

                        LiveBadge(
                            modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 16.dp),
                            liveResult = liveResult,
                            analyzing = analyzing,
                            classifierAvailable = app.container.classifier.isAvailable
                        )
                    }
                }

                when (uiState) {
                    is ScanUiState.Scanning -> {
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(120.dp)
                                .padding(16.dp),
                            contentAlignment = Alignment.Center
                        ) {
                            Column(
                                horizontalAlignment = Alignment.CenterHorizontally,
                                verticalArrangement = Arrangement.spacedBy(8.dp)
                            ) {
                                CircularProgressIndicator()
                                Text("Analyzing...", color = colors.onSurface, fontSize = 16.sp)
                            }
                        }
                    }
                    is ScanUiState.Done -> {
                        ResultCard(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(16.dp),
                            outcome = uiState.outcome,
                            capturedUri = capturedUri!!,
                            onScanAnyway = { vm.scanAnyway(capturedUri!!) },
                            onRetake = {
                                capturedUri = null
                                vm.reset()
                            },
                            onRetry = { capturedUri?.let { vm.scan(it) } }
                        )
                    }
                    else -> {
                        CaptureButton(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(16.dp)
                                .padding(bottom = 32.dp),
                            onClick = { capturePhoto() },
                            enabled = true
                        )
                    }
                }
            }
        } else {
            PermissionScreen(onGrant = { permLauncher.launch(Manifest.permission.CAMERA) })
        }
    }
}

@Composable
private fun TopBar(onCameraSwitch: () -> Unit) {
    IconButton(
        onClick = onCameraSwitch,
        modifier = Modifier
            .align(Alignment.TopEnd)
            .padding(16.dp)
    ) {
        Icon(
            Icons.Default.FlipCameraAndroid,
            contentDescription = "Switch camera",
            tint = MaterialTheme.colorScheme.onSurface
        )
    }
}

@Composable
private fun LiveBadge(
    modifier: Modifier = Modifier,
    liveResult: LocalResult?,
    analyzing: Boolean,
    classifierAvailable: Boolean
) {
    val colors = MaterialTheme.colorScheme
    val text = when {
        !classifierAvailable -> "On-device model unavailable"
        analyzing || liveResult == null -> "Analyzing…"
        liveResult.looksLikePlant -> {
            val best = liveResult.best
            "Plant detected: ${best.scientific} (${(best.confidence * 100).roundToInt()}%)"
        }
        else -> {
            val best = liveResult.best
            "No plant detected (${(best.confidence * 100).roundToInt()}%)"
        }
    }

    Surface(
        modifier = modifier,
        color = colors.surfaceContainerHighest.copy(alpha = 0.9f),
        shape = RoundedCornerShape(16.dp),
        elevation = 4.dp
    ) {
        Text(
            text = text,
            color = colors.onSurface,
            fontSize = 14.sp,
            modifier = Modifier.padding(12.dp),
            maxLines = 2,
            overflow = androidx.compose.ui.text.overflow.TextOverflow.Ellipsis
        )
    }
}

@Composable
private fun CaptureButton(
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
    enabled: Boolean
) {
    val colors = MaterialTheme.colorScheme
    Box(
        modifier = modifier
            .fillMaxWidth()
            .wrapContentSize(Alignment.CenterHorizontally)
            .clickable(enabled = enabled, onClick = onClick)
    ) {
        Box(
            modifier = Modifier
                .size(76.dp)
                .border(4.dp, colors.primary, CircleShape)
                .padding(8.dp)
                .clip(CircleShape)
                .background(if (enabled) colors.primary else colors.primary.copy(alpha = 0.5f))
        )
    }
}

@Composable
private fun ScanFrameOverlay(
    modifier: Modifier = Modifier,
    frameColor: Color
) {
    Canvas(modifier = modifier) {
        val len = 40.dp.toPx()
        val strokeWidth = 4.dp.toPx()
        val w = size.width
        val h = size.height

        fun corner(x: Float, y: Float, dx: Float, dy: Float) {
            drawLine(frameColor, Offset(x, y), Offset(x + dx * len, y), strokeWidth, StrokeCap.Round)
            drawLine(frameColor, Offset(x, y), Offset(x, y + dy * len), strokeWidth, StrokeCap.Round)
        }
        corner(0f, 0f, 1f, 1f)
        corner(w, 0f, -1f, 1f)
        corner(0f, h, 1f, -1f)
        corner(w, h, -1f, -1f)
    }
}

@Composable
private fun PermissionScreen(onGrant: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    Column(
        modifier = Modifier.align(Alignment.Center).padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        Text("📷", style = MaterialTheme.typography.displayMedium)
        Text(
            "Camera access is needed to scan your plants.",
            style = MaterialTheme.typography.bodyLarge,
            color = colors.onBackground,
            textAlign = TextAlign.Center
        )
        Button(onClick = onGrant) {
            Text("Grant Camera Permission")
        }
    }
}

@Composable
private fun ResultCard(
    modifier: Modifier = Modifier,
    outcome: ScanOutcome,
    capturedUri: Uri,
    onScanAnyway: () -> Unit,
    onRetake: () -> Unit,
    onRetry: () -> Unit
) {
    val colors = MaterialTheme.colorScheme

    Card(
        modifier = modifier,
        colors = CardDefaults.cardColors(
            containerColor = colors.surfaceContainerLow
        ),
        elevation = CardDefaults.cardElevation(defaultElevation = 8.dp)
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    "Scan Result",
                    style = MaterialTheme.typography.titleLarge,
                    color = colors.onSurface
                )
                androidx.compose.foundation.layout.Spacer(modifier = Modifier.weight(1f))
                SourceBadge(outcome)
            }

            when (outcome) {
                is ScanOutcome.Server -> {
                    PredictionsList(
                        predictions = outcome.response.predictions,
                        local = outcome.local,
                        title = "Server Predictions"
                    )
                }
                is ScanOutcome.OnDevice -> {
                    PredictionsList(
                        predictions = outcome.local.top.map { pred ->
                            PredictionDto(
                                scientificName = pred.scientificName,
                                commonName = pred.kind,
                                confidence = pred.confidence
                            )
                        },
                        local = outcome.local,
                        title = "On-Device (${outcome.reason.name.replace('_', ' ')})"
                    )
                }
                is ScanOutcome.NotAPlant -> {
                    NotAPlantCard(
                        local = outcome.local,
                        onScanAnyway = onScanAnyway,
                        onRetake = onRetake
                    )
                }
                is ScanOutcome.RateLimited -> {
                    ErrorCard(
                        message = outcome.message,
                        retryAfter = outcome.retryAfterSeconds,
                        onRetry = onRetry,
                        onRetake = onRetake
                    )
                }
                is ScanOutcome.Failed -> {
                    ErrorCard(
                        message = outcome.error.userMessage(),
                        retryAfter = null,
                        onRetry = onRetry,
                        onRetake = onRetake
                    )
                }
            }
        }
    }
}

@Composable
private fun SourceBadge(outcome: ScanOutcome) {
    val colors = MaterialTheme.colorScheme
    val (label, color) = when (outcome) {
        is ScanOutcome.Server -> "Server" to colors.primary
        is ScanOutcome.OnDevice -> "On-Device" to colors.tertiary
        is ScanOutcome.NotAPlant -> "Not a Plant" to colors.error
        is ScanOutcome.RateLimited -> "Rate Limited" to colors.error
        is ScanOutcome.Failed -> "Failed" to colors.error
    }

    androidx.compose.material3.Text(
        text = label,
        color = colors.onSurface,
        fontSize = 12.sp,
        fontWeight = FontWeight.Medium,
        modifier = Modifier
            .padding(horizontal = 8.dp, vertical = 4.dp)
            .background(color.copy(alpha = 0.2f), RoundedCornerShape(8.dp))
            .padding(8.dp)
    )
}

@Composable
private fun PredictionsList(
    predictions: List<PredictionDto>,
    local: LocalResult?,
    title: String
) {
    val colors = MaterialTheme.colorScheme
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, style = MaterialTheme.typography.labelLarge, color = colors.onSurfaceVariant)
        predictions.forEachIndexed { index, pred ->
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 4.dp),
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Column(crossAxisAlignment = Alignment.Start) {
                    Text(
                        pred.scientificName,
                        style = MaterialTheme.typography.bodyMedium,
                        color = colors.onSurface,
                        fontWeight = if (index == 0) FontWeight.Bold else FontWeight.Normal
                    )
                    pred.commonName?.let { commonName ->
                        if (commonName.isNotBlank()) {
                            Text(
                                commonName,
                                style = MaterialTheme.typography.bodySmall,
                                color = colors.onSurfaceVariant
                            )
                        }
                    }
                }
                Text(
                    "${(pred.confidence * 100).roundToInt()}%",
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.onSurface,
                    fontWeight = FontWeight.Medium
                )
            }
        }
    }
}

@Composable
private fun NotAPlantCard(
    local: LocalResult,
    onScanAnyway: () -> Unit,
    onRetake: () -> Unit
) {
    val colors = MaterialTheme.colorScheme
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(
            "This doesn't look like a plant",
            style = MaterialTheme.typography.titleMedium,
            color = colors.error
        )
        Text(
            "The on-device model is ${(local.best.confidence * 100).roundToInt()}% confident this is not a plant. " +
            "If you think it's a plant anyway, you can still send it to the server for a second opinion.",
            style = MaterialTheme.typography.bodyMedium,
            color = colors.onSurfaceVariant
        )
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Button(
                onClick = onScanAnyway,
                modifier = Modifier.weight(1f),
                colors = ButtonDefaults.buttonColors(containerColor = colors.tertiaryContainer)
            ) {
                Text("Scan Anyway")
            }
            Button(
                onClick = onRetake,
                modifier = Modifier.weight(1f),
                colors = ButtonDefaults.outlinedButtonColors()
            ) {
                Text("Retake")
            }
        }
    }
}

@Composable
private fun ErrorCard(
    message: String,
    retryAfter: Int?,
    onRetry: () -> Unit,
    onRetake: () -> Unit
) {
    val colors = MaterialTheme.colorScheme
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(
            "Scan Failed",
            style = MaterialTheme.typography.titleMedium,
            color = colors.error
        )
        Text(
            message,
            style = MaterialTheme.typography.bodyMedium,
            color = colors.onSurfaceVariant
        )
        retryAfter?.let {
            Text(
                "Please wait ${it}s before trying again.",
                style = MaterialTheme.typography.bodySmall,
                color = colors.onSurfaceVariant
            )
        }
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Button(
                onClick = onRetry,
                modifier = Modifier.weight(1f)
            ) {
                Text("Retry")
            }
            Button(
                onClick = onRetake,
                modifier = Modifier.weight(1f),
                colors = ButtonDefaults.outlinedButtonColors()
            ) {
                Text("Retake")
            }
        }
    }
}