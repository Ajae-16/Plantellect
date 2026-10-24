package com.plantellect.mobileplantellect.ui.screen

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Matrix
import android.net.Uri
import android.util.Log
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.FlipCameraAndroid
import androidx.compose.material.icons.filled.PhotoLibrary
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.plantellect.mobileplantellect.PlantellectApp
import com.plantellect.mobileplantellect.data.local.LocalResult
import com.plantellect.mobileplantellect.data.logic.ImagePreparer
import com.plantellect.mobileplantellect.data.logic.ServerStatus
import com.plantellect.mobileplantellect.data.logic.userMessage
import com.plantellect.mobileplantellect.data.remote.dto.ScanVerdict
import com.plantellect.mobileplantellect.data.repository.OnDeviceReason
import com.plantellect.mobileplantellect.data.repository.ScanOutcome
import com.plantellect.mobileplantellect.ui.theme.GreenLight
import com.plantellect.mobileplantellect.ui.theme.ScanBad
import com.plantellect.mobileplantellect.ui.theme.ScanOk
import com.plantellect.mobileplantellect.ui.theme.ScanWarn
import com.plantellect.mobileplantellect.viewmodel.ScanUiState
import com.plantellect.mobileplantellect.viewmodel.ScanViewModel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.math.roundToInt

private const val TAG = "ScanPlantScreen"

@OptIn(ExperimentalGetImage::class)
@Composable
fun ScanPlantScreen() {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val colors = MaterialTheme.colorScheme

    val app = context.applicationContext as PlantellectApp
    val vm: ScanViewModel = viewModel(factory = app.container.viewModelFactory)
    val uiState by vm.state.collectAsStateWithLifecycle()

    /** Developer mode (Settings): percentages and technical status. Off = plain-language output. */
    val debug by app.container.settings.debugMode.collectAsStateWithLifecycle()
    /** Kept fresh every 10 s by ServerMonitor; offline scans never wait on the server. */
    val serverStatus by app.container.serverMonitor.status.collectAsStateWithLifecycle()
    val serverReachable = serverStatus == ServerStatus.ONLINE

    val cameraProviderFuture = remember { ProcessCameraProvider.getInstance(context) }
    val mainExecutor = remember { ContextCompat.getMainExecutor(context) }

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

    var liveResult by remember { mutableStateOf<LocalResult?>(null) }
    var analyzing by remember { mutableStateOf(false) }

    var captureError by remember { mutableStateOf<String?>(null) }
    var classifierError by remember { mutableStateOf<String?>(null) }
    /** True from the tap on the shutter until the photo file is saved. */
    var capturing by remember { mutableStateOf(false) }
    /** True once the camera is bound and showing frames (drives the "Starting camera…" feedback). */
    var cameraReady by remember { mutableStateOf(false) }

    /** Live analysis pauses while a scan runs or a result is on screen (saves CPU, avoids lock contention). */
    val scanBusy by rememberUpdatedState(uiState !is ScanUiState.Idle || capturing)

    // The photo that was scanned. It replaces the camera in the viewfinder box.
    val photoUri: Uri? = when (val s = uiState) {
        is ScanUiState.Scanning -> s.uri
        is ScanUiState.Done -> s.uri
        ScanUiState.Idle -> null
    }
    val showingPhoto = photoUri != null
    var photoBitmap by remember { mutableStateOf<ImageBitmap?>(null) }
    LaunchedEffect(photoUri) {
        photoBitmap = null
        if (photoUri != null) {
            photoBitmap = withContext(Dispatchers.IO) {
                runCatching { ImagePreparer.load(context, photoUri, maxSide = 1280).asImageBitmap() }.getOrNull()
            }
        }
    }

    val scrollState = rememberScrollState()
    // New photo / new result / back to the camera: always start at the top.
    LaunchedEffect(uiState) { scrollState.scrollTo(0) }

    // Back from a photo or result returns to the camera instead of leaving the screen.
    BackHandler(enabled = showingPhoto) { vm.reset() }

    val pickLauncher = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { picked ->
        if (picked != null) {
            captureError = null
            vm.scan(picked)
        }
    }

    val analyzerExecutor = remember { Executors.newSingleThreadExecutor() }
    val lastAnalysisTime = remember { mutableStateOf(0L) }
    val isAnalyzerActive = remember { AtomicBoolean(false) }

    /** Classifier availability computed off the main thread. */
    var classifierAvailable by remember { mutableStateOf(false) }

    DisposableEffect(Unit) {
        onDispose {
            analyzerExecutor.shutdown()
            try {
                if (!analyzerExecutor.awaitTermination(1, TimeUnit.SECONDS)) {
                    analyzerExecutor.shutdownNow()
                }
            } catch (e: InterruptedException) {
                analyzerExecutor.shutdownNow()
                Thread.currentThread().interrupt()
            }
        }
    }

    LaunchedEffect(Unit) {
        val classifier = app.container.classifier
        val variant = classifier.preferredVariantForOnline(true)
        val available = withContext(Dispatchers.Default) {
            classifier.ensureLoaded(variant) || classifier.ensureLoaded(classifier.fallbackVariant(variant))
        }
        classifierAvailable = available
        classifierError = if (available) null else classifier.lastError
    }

    // COMPATIBLE (TextureView) so the rounded corners clip the preview and overlays draw on top reliably.
    val previewView = remember {
        PreviewView(context).apply { implementationMode = PreviewView.ImplementationMode.COMPATIBLE }
    }

    var imageCapture by remember { mutableStateOf<ImageCapture?>(null) }

    /** Runs on the analyzer executor thread (already off the main thread). Always closes [proxy]. */
    fun analyzeFrame(proxy: ImageProxy) {
        val now = System.currentTimeMillis()
        if (scanBusy || now - lastAnalysisTime.value < 1000) {
            proxy.close()
            return
        }
        lastAnalysisTime.value = now
        analyzing = true

        val bitmap: Bitmap? = try {
            val raw = proxy.toBitmap()
            val rotation = proxy.imageInfo.rotationDegrees
            if (rotation == 0) raw else {
                val m = Matrix().apply { postRotate(rotation.toFloat()) }
                Bitmap.createBitmap(raw, 0, 0, raw.width, raw.height, m, true)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Frame conversion failed", e)
            null
        } finally {
            proxy.close()
        }

        val result: LocalResult? = if (bitmap == null) null else try {
            app.container.classifier.classify(bitmap)
        } catch (e: Exception) {
            Log.e(TAG, "Classification failed", e)
            null
        }

        liveResult = result
        analyzing = false
    }

    LaunchedEffect(lensFacing, hasCamPermission) {
        if (!hasCamPermission) return@LaunchedEffect
        cameraReady = false

        // Wait for the camera provider without blocking the main thread, so "Starting camera…" can show.
        val cameraProvider = try {
            suspendCancellableCoroutine<ProcessCameraProvider> { cont ->
                cameraProviderFuture.addListener({
                    try {
                        cont.resume(cameraProviderFuture.get())
                    } catch (e: Exception) {
                        cont.resumeWithException(e)
                    }
                }, mainExecutor)
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.e(TAG, "Camera provider failed", e)
            return@LaunchedEffect
        }

        cameraProvider.unbindAll()
        val cameraSelector = CameraSelector.Builder().requireLensFacing(lensFacing).build()
        val rotation = previewView.display?.rotation ?: android.view.Surface.ROTATION_0

        val preview = Preview.Builder().build().also {
            it.setSurfaceProvider(previewView.surfaceProvider)
        }

        val ic = ImageCapture.Builder()
            .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
            .setTargetRotation(rotation)
            .build()
        imageCapture = ic

        val imageAnalysis = ImageAnalysis.Builder()
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .setTargetRotation(rotation)
            .setResolutionSelector(
                ResolutionSelector.Builder()
                    .setResolutionStrategy(
                        ResolutionStrategy(
                            android.util.Size(640, 480),
                            ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER
                        )
                    )
                    .build()
            )
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
            cameraProvider.bindToLifecycle(lifecycleOwner, cameraSelector, preview, ic, imageAnalysis)
            cameraReady = true
        } catch (e: Exception) {
            Log.e(TAG, "Camera bind failed", e)
        }
    }

    fun capturePhoto() {
        val ic = imageCapture
        if (ic == null) { captureError = "The camera isn't ready yet. Try again in a moment."; return }
        if (capturing) return
        captureError = null
        capturing = true
        val file = File(context.cacheDir, "scan_${System.currentTimeMillis()}.jpg")
        val outputOptions = ImageCapture.OutputFileOptions.Builder(file).build()

        // Callbacks arrive on the main thread, so state and the ViewModel are touched safely.
        ic.takePicture(
            outputOptions,
            mainExecutor,
            object : ImageCapture.OnImageSavedCallback {
                override fun onImageSaved(output: ImageCapture.OutputFileResults) {
                    capturing = false
                    vm.scan(Uri.fromFile(file))
                }

                override fun onError(exc: ImageCaptureException) {
                    Log.e(TAG, "Capture failed", exc)
                    capturing = false
                    captureError = "Couldn't take the photo. Please try again."
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
        if (!hasCamPermission) {
            PermissionScreen(onGrant = { permLauncher.launch(Manifest.permission.CAMERA) })
        } else {
            BoxWithConstraints(Modifier.fillMaxSize()) {
                // Camera: fills the screen above the shutter row. Photo: a fixed-height box so the
                // result below it scrolls with the page instead of hovering over the picture.
                val idleHeight = (maxHeight - 140.dp).coerceAtLeast(260.dp)
                val photoHeight = (maxHeight * 0.45f).coerceIn(240.dp, 420.dp)
                val viewfinderHeight by animateDpAsState(
                    targetValue = if (showingPhoto) photoHeight else idleHeight,
                    label = "viewfinderHeight"
                )

                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .verticalScroll(scrollState)
                ) {
                    // ---------------------------------------------------- the box: camera, then the photo
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(viewfinderHeight)
                            .padding(horizontal = 16.dp, vertical = 8.dp)
                            .clip(RoundedCornerShape(28.dp))
                            .background(Color.Black)
                    ) {
                        AndroidView(
                            modifier = Modifier.fillMaxSize(),
                            factory = { previewView }
                        )

                        if (showingPhoto) {
                            val bmp = photoBitmap
                            if (bmp != null) {
                                Image(
                                    bitmap = bmp,
                                    contentDescription = "The photo you scanned",
                                    contentScale = ContentScale.Crop,
                                    modifier = Modifier.fillMaxSize()
                                )
                            } else {
                                Box(Modifier.fillMaxSize().background(Color.Black))
                            }
                            if (uiState is ScanUiState.Scanning) {
                                Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.30f)))
                                ScanningLine(Modifier.fillMaxSize().padding(20.dp))
                            }
                        }

                        ScanFrameOverlay(
                            modifier = Modifier
                                .fillMaxSize()
                                .padding(20.dp),
                            frameColor = when {
                                showingPhoto -> (uiState as? ScanUiState.Done)?.let { frameColorFor(it.outcome) }
                                    ?: colors.primary
                                liveResult?.looksLikePlant == true -> ScanOk
                                liveResult?.looksLikePlant == false -> ScanBad
                                else -> colors.primary
                            }
                        )

                        StatusPill(
                            modifier = Modifier.align(Alignment.TopStart).padding(12.dp),
                            status = serverStatus,
                            debug = debug
                        )

                        if (!showingPhoto) {
                            IconButton(
                                onClick = {
                                    lensFacing = if (lensFacing == CameraSelector.LENS_FACING_BACK) {
                                        CameraSelector.LENS_FACING_FRONT
                                    } else {
                                        CameraSelector.LENS_FACING_BACK
                                    }
                                },
                                modifier = Modifier
                                    .align(Alignment.TopEnd)
                                    .padding(8.dp)
                                    .background(Color.Black.copy(alpha = 0.35f), CircleShape)
                            ) {
                                Icon(
                                    Icons.Default.FlipCameraAndroid,
                                    contentDescription = "Switch camera",
                                    tint = Color.White
                                )
                            }

                            if (cameraReady && !capturing) {
                                LiveBadge(
                                    modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 16.dp),
                                    liveResult = liveResult,
                                    analyzing = analyzing,
                                    classifierAvailable = classifierAvailable,
                                    classifierError = classifierError,
                                    debug = debug
                                )
                            }
                        }

                        // Loading feedback, so the user always knows something is happening.
                        if (!showingPhoto && !cameraReady) {
                            BusyOverlay("Starting camera…")
                        }
                        if (capturing) {
                            BusyOverlay("Capturing…")
                        }
                    }

                    // ---------------------------------------------------- below the box
                    when (val state = uiState) {
                        ScanUiState.Idle -> CaptureControls(
                            captureError = captureError,
                            captureEnabled = cameraReady && imageCapture != null && !capturing,
                            capturing = capturing,
                            onCapture = { capturePhoto() },
                            onGallery = {
                                pickLauncher.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                            }
                        )
                        is ScanUiState.Scanning -> ScanningPanel(
                            serverReachable = serverReachable,
                            debug = debug,
                            onCancel = { vm.reset() }
                        )
                        is ScanUiState.Done -> ResultCard(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 16.dp, vertical = 8.dp),
                            outcome = state.outcome,
                            debug = debug,
                            serverReachable = serverReachable,
                            onScanAnyway = { vm.scanAnyway(state.uri) },
                            onRetake = { vm.reset() },
                            onRetry = { vm.retry(state.uri) }
                        )
                    }
                    Spacer(Modifier.height(24.dp))
                }
            }
        }
    }
}

// ============================================================================ viewfinder pieces

private fun frameColorFor(outcome: ScanOutcome): Color = when (outcome) {
    is ScanOutcome.Server -> when (outcome.response.verdict()) {
        ScanVerdict.IDENTIFIED -> ScanOk
        ScanVerdict.UNCERTAIN, ScanVerdict.UNSUPPORTED_PLANT -> ScanWarn
        ScanVerdict.NOT_A_PLANT -> ScanBad
        ScanVerdict.NOT_RECOGNIZED -> ScanWarn
    }
    is ScanOutcome.OnDevice -> if (outcome.local.looksLikePlant) ScanOk else ScanBad
    is ScanOutcome.NotAPlant -> ScanBad
    is ScanOutcome.RateLimited, is ScanOutcome.Failed -> ScanBad
}

@Composable
private fun BusyOverlay(message: String) {
    Box(
        modifier = Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.45f)),
        contentAlignment = Alignment.Center
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            CircularProgressIndicator(color = Color.White)
            Text(message, color = Color.White, style = MaterialTheme.typography.titleMedium)
        }
    }
}

/** A light line sweeping over the photo while it is being identified. */
@Composable
private fun ScanningLine(modifier: Modifier = Modifier) {
    val transition = rememberInfiniteTransition(label = "scanLine")
    val progress by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(1600, easing = LinearEasing), RepeatMode.Reverse),
        label = "scanLineProgress"
    )
    Canvas(modifier = modifier) {
        val y = size.height * progress
        drawLine(
            brush = Brush.horizontalGradient(listOf(Color.Transparent, GreenLight, Color.Transparent)),
            start = Offset(0f, y),
            end = Offset(size.width, y),
            strokeWidth = 4.dp.toPx(),
            cap = StrokeCap.Round
        )
    }
}

@Composable
private fun StatusPill(modifier: Modifier = Modifier, status: ServerStatus, debug: Boolean) {
    val text: String = when {
        debug -> when (status) {
            ServerStatus.ONLINE -> "Server online"
            ServerStatus.CHECKING -> "Checking server…"
            ServerStatus.NO_NETWORK -> "No network"
            ServerStatus.SERVER_UNREACHABLE -> "Server unreachable"
        }
        status == ServerStatus.NO_NETWORK || status == ServerStatus.SERVER_UNREACHABLE -> "Offline mode"
        else -> return   // online (or still checking): nothing to say to a normal user
    }
    val dot = when (status) {
        ServerStatus.ONLINE -> ScanOk
        ServerStatus.CHECKING -> ScanWarn
        else -> ScanBad
    }
    Surface(
        modifier = modifier,
        color = Color.Black.copy(alpha = 0.45f),
        shape = CircleShape
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Box(Modifier.size(8.dp).background(dot, CircleShape))
            Spacer(Modifier.width(8.dp))
            Text(text, color = Color.White, style = MaterialTheme.typography.labelMedium)
        }
    }
}

@Composable
private fun LiveBadge(
    modifier: Modifier = Modifier,
    liveResult: LocalResult?,
    analyzing: Boolean,
    classifierAvailable: Boolean,
    classifierError: String? = null,
    debug: Boolean
) {
    val colors = MaterialTheme.colorScheme
    val text = if (debug) {
        // Developer view: species + confidence, and why the model is unavailable.
        when {
            !classifierAvailable -> "On-device model unavailable" + (classifierError?.let { "\n$it" } ?: "")
            analyzing || liveResult == null -> "Analyzing…"
            liveResult.looksLikePlant -> {
                val best = liveResult.best
                "Plant detected: ${best.scientificName} (${(best.confidence * 100).roundToInt()}%)"
            }
            else -> "No plant detected (${(liveResult.best.confidence * 100).roundToInt()}%)"
        }
    } else {
        when {
            !classifierAvailable -> "Live check isn't available, but you can still take a photo"
            analyzing || liveResult == null -> "Looking for a plant…"
            liveResult.looksLikePlant -> "Plant spotted. Tap to capture"
            else -> "No plant in view yet"
        }
    }

    Surface(
        modifier = modifier,
        color = colors.surfaceContainerHighest.copy(alpha = 0.9f),
        shape = RoundedCornerShape(16.dp),
        shadowElevation = 4.dp
    ) {
        Text(
            text = text,
            color = colors.onSurface,
            style = MaterialTheme.typography.labelLarge,
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            textAlign = TextAlign.Center
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

// ============================================================================ controls under the box

@Composable
private fun CaptureControls(
    captureError: String?,
    captureEnabled: Boolean,
    capturing: Boolean,
    onCapture: () -> Unit,
    onGallery: () -> Unit
) {
    val colors = MaterialTheme.colorScheme
    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        captureError?.let {
            Text(it, color = colors.error, style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center)
        }
        Row(
            modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(
                modifier = Modifier
                    .width(64.dp)
                    .clip(RoundedCornerShape(16.dp))
                    .clickable(onClick = onGallery)
                    .padding(vertical = 6.dp),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Icon(Icons.Default.PhotoLibrary, contentDescription = null, tint = colors.primary)
                Text("Gallery", style = MaterialTheme.typography.labelMedium, color = colors.onSurface)
            }
            CaptureButton(onClick = onCapture, enabled = captureEnabled, busy = capturing)
            Spacer(Modifier.width(64.dp))   // balances the gallery button so the shutter stays centred
        }
    }
}

@Composable
private fun CaptureButton(
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
    enabled: Boolean,
    busy: Boolean
) {
    val colors = MaterialTheme.colorScheme
    Box(
        modifier = modifier
            .size(76.dp)
            .clip(CircleShape)
            .clickable(enabled = enabled, onClick = onClick)
            .border(4.dp, if (enabled || busy) colors.primary else colors.primary.copy(alpha = 0.4f), CircleShape)
            .padding(8.dp)
            .clip(CircleShape)
            .background(if (enabled || busy) colors.primary else colors.primary.copy(alpha = 0.4f)),
        contentAlignment = Alignment.Center
    ) {
        if (busy) {
            CircularProgressIndicator(
                modifier = Modifier.size(28.dp),
                strokeWidth = 3.dp,
                color = colors.onPrimary
            )
        }
    }
}

@Composable
private fun ScanningPanel(
    serverReachable: Boolean,
    debug: Boolean,
    onCancel: () -> Unit
) {
    val colors = MaterialTheme.colorScheme
    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 12.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        LinearProgressIndicator(modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(50)))
        Text(
            if (serverReachable) "Identifying your plant…" else "Identifying on your phone…",
            style = MaterialTheme.typography.titleMedium,
            color = colors.onSurface
        )
        Text(
            "Hold on, this only takes a moment.",
            style = MaterialTheme.typography.bodyMedium,
            color = colors.onSurfaceVariant
        )
        if (debug) {
            Text(
                if (serverReachable) "Mode: on-device check + server" else "Mode: on-device only (server not used)",
                style = MaterialTheme.typography.labelMedium,
                color = colors.onSurfaceVariant
            )
        }
        OutlinedButton(onClick = onCancel) { Text("Cancel") }
    }
}

// ============================================================================ result

private data class MatchItem(val title: String, val subtitle: String?, val confidence: Double)

private const val KIND_NON_PLANT = "non_plant"
private const val KIND_OTHER_PLANT = "other_plant"

@Composable
private fun ResultCard(
    modifier: Modifier = Modifier,
    outcome: ScanOutcome,
    debug: Boolean,
    serverReachable: Boolean,
    onScanAnyway: () -> Unit,
    onRetake: () -> Unit,
    onRetry: () -> Unit
) {
    val colors = MaterialTheme.colorScheme

    // Part of the page (no hovering elevation): the whole screen scrolls to read it.
    Card(
        modifier = modifier,
        shape = RoundedCornerShape(24.dp),
        colors = CardDefaults.cardColors(containerColor = colors.surfaceContainerLow),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp)
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    "Scan result",
                    style = MaterialTheme.typography.titleLarge,
                    color = colors.onSurface
                )
                Spacer(modifier = Modifier.weight(1f))
                if (debug) SourceBadge(outcome)
            }

            when (outcome) {
                is ScanOutcome.Server -> {
                    val response = outcome.response
                    when (val verdict = response.verdict()) {
                        ScanVerdict.IDENTIFIED, ScanVerdict.UNCERTAIN ->
                            if (response.predictions.isNotEmpty()) {
                                MatchList(
                                    items = response.predictions.map {
                                        MatchItem(
                                            title = it.displayName,
                                            subtitle = it.scientificName.takeIf { sci -> sci.isNotBlank() && sci != it.displayName },
                                            confidence = it.confidence
                                        )
                                    },
                                    uncertain = verdict == ScanVerdict.UNCERTAIN,
                                    showPercent = debug,
                                    debugTitle = "Server Predictions"
                                )
                            } else NoticeCard("No result",
                                "We couldn't find a match for this photo. Try again in better light.")
                        ScanVerdict.NOT_A_PLANT ->
                            NoticeCard("No plant detected",
                                "Point the camera at the leaves and try again.")
                        ScanVerdict.UNSUPPORTED_PLANT ->
                            NoticeCard("Plant detected, species not supported",
                                "This looks like a plant, but it isn't one the app can identify yet.")
                        ScanVerdict.NOT_RECOGNIZED ->
                            NoticeCard("Couldn't recognize it",
                                "The photo may be blurry or too dark. Try again in better light.")
                    }
                    ScanAgainButton(onRetake)
                }
                is ScanOutcome.OnDevice -> {
                    OnDeviceBody(outcome, debug)
                    ScanAgainButton(onRetake)
                }
                is ScanOutcome.NotAPlant -> {
                    NotAPlantCard(
                        local = outcome.local,
                        debug = debug,
                        canScanAnyway = serverReachable,
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
private fun OnDeviceBody(outcome: ScanOutcome.OnDevice, debug: Boolean) {
    val colors = MaterialTheme.colorScheme
    val best = outcome.local.best
    val reasonText = when (outcome.reason) {
        OnDeviceReason.NO_CONNECTION -> "You're offline, so this result comes from your phone."
        OnDeviceReason.SERVER_UNREACHABLE -> "We couldn't reach the server, so this result comes from your phone."
    }

    when (best.kind) {
        KIND_NON_PLANT -> NoticeCard("No plant detected",
            "Point the camera at the leaves and try again.")
        KIND_OTHER_PLANT -> NoticeCard("Plant detected, species not supported",
            "This looks like a plant, but it isn't one the app can identify yet.")
        else -> MatchList(
            items = outcome.local.top
                .filter { it.kind != KIND_NON_PLANT && it.kind != KIND_OTHER_PLANT }
                .map { MatchItem(title = it.scientificName, subtitle = null, confidence = it.confidence.toDouble()) },
            uncertain = false,
            showPercent = debug,
            debugTitle = "On-Device (${outcome.reason.name.replace('_', ' ')})"
        )
    }
    Text(reasonText, style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant)
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

    Text(
        text = label,
        color = colors.onSurface,
        style = MaterialTheme.typography.labelMedium,
        modifier = Modifier
            .background(color.copy(alpha = 0.2f), RoundedCornerShape(8.dp))
            .padding(horizontal = 10.dp, vertical = 6.dp)
    )
}

/** Best match big, the rest listed below. Percentages only in developer mode. */
@Composable
private fun MatchList(
    items: List<MatchItem>,
    uncertain: Boolean,
    showPercent: Boolean,
    debugTitle: String
) {
    val colors = MaterialTheme.colorScheme
    if (items.isEmpty()) {
        NoticeCard("Couldn't recognize it", "The photo may be blurry or too dark. Try again in better light.")
        return
    }
    val top = items.first()
    val others = items.drop(1)

    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (showPercent) {
            Text(debugTitle, style = MaterialTheme.typography.labelMedium, color = colors.onSurfaceVariant)
        }
        Text(
            if (uncertain) "Possible match" else "Best match",
            style = MaterialTheme.typography.labelLarge,
            color = colors.primary
        )
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(top.title, style = MaterialTheme.typography.headlineSmall, color = colors.onSurface)
                top.subtitle?.let {
                    Text(it, style = MaterialTheme.typography.bodyMedium, color = colors.onSurfaceVariant, fontStyle = FontStyle.Italic)
                }
            }
            if (showPercent) {
                Text(
                    "${(top.confidence * 100).roundToInt()}%",
                    style = MaterialTheme.typography.titleMedium,
                    color = colors.onSurface
                )
            }
        }
        if (uncertain) {
            Text(
                "We're not fully sure. A clearer photo of the leaves t will help.",
                style = MaterialTheme.typography.bodyMedium,
                color = colors.onSurfaceVariant
            )
        }
        if (others.isNotEmpty()) {
            HorizontalDivider(color = colors.outlineVariant)
            Text("Other possibilities", style = MaterialTheme.typography.labelLarge, color = colors.onSurfaceVariant)
            others.forEach { item ->
                Row(
                    modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(item.title, style = MaterialTheme.typography.bodyLarge, color = colors.onSurface)
                        item.subtitle?.let {
                            Text(it, style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant, fontStyle = FontStyle.Italic)
                        }
                    }
                    if (showPercent) {
                        Text(
                            "${(item.confidence * 100).roundToInt()}%",
                            style = MaterialTheme.typography.bodyMedium,
                            color = colors.onSurface,
                            fontWeight = FontWeight.Medium
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun NotAPlantCard(
    local: LocalResult,
    debug: Boolean,
    canScanAnyway: Boolean,
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
            buildString {
                if (debug) {
                    append("The on-device model is ${(local.best.confidence * 100).roundToInt()}% confident this is not a plant. ")
                } else {
                    append("Point the camera at the leaves and try again. ")
                }
                if (canScanAnyway) {
                    append("If you think it's a plant anyway, you can ask for a closer check.")
                } else {
                    append("You're offline, so a closer check isn't available right now.")
                }
            },
            style = MaterialTheme.typography.bodyMedium,
            color = colors.onSurfaceVariant
        )
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            if (canScanAnyway) {
                Button(onClick = onScanAnyway, modifier = Modifier.weight(1f)) {
                    Text(if (debug) "Scan Anyway" else "Check anyway")
                }
            }
            if (canScanAnyway) {
                OutlinedButton(onClick = onRetake, modifier = Modifier.weight(1f)) { Text("Retake") }
            } else {
                Button(onClick = onRetake, modifier = Modifier.weight(1f)) { Text("Retake") }
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
            Button(onClick = onRetry, modifier = Modifier.weight(1f)) { Text("Retry") }
            OutlinedButton(onClick = onRetake, modifier = Modifier.weight(1f)) { Text("Retake") }
        }
    }
}

@Composable
private fun NoticeCard(title: String, body: String) {
    val colors = MaterialTheme.colorScheme
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(title, style = MaterialTheme.typography.titleMedium, color = colors.onSurface)
        Text(body, style = MaterialTheme.typography.bodyMedium, color = colors.onSurfaceVariant)
    }
}

@Composable
private fun ScanAgainButton(onClick: () -> Unit) {
    Button(onClick = onClick, modifier = Modifier.fillMaxWidth()) { Text("Scan again") }
}

@Composable
private fun BoxScope.PermissionScreen(onGrant: () -> Unit) {
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
