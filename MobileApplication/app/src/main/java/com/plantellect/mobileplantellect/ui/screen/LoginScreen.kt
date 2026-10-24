package com.plantellect.mobileplantellect.ui.screen

import android.content.ContentResolver
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.SizeTransform
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.PictureAsPdf
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.RadioButtonUnchecked
import androidx.compose.material.icons.filled.UploadFile
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.plantellect.mobileplantellect.data.logic.AccountRole
import com.plantellect.mobileplantellect.data.logic.AuthValidator
import com.plantellect.mobileplantellect.data.logic.RegisterForm

private const val SLIDE_MS = 420

/** Everything typed into the sign-up form. Lives above the animation so it survives switching panels. */
@Stable
private class SignUpFields {
    var firstName by mutableStateOf("")
    var lastName by mutableStateOf("")
    var email by mutableStateOf("")
    var username by mutableStateOf("")
    var password by mutableStateOf("")
    var confirm by mutableStateOf("")
    var role by mutableStateOf(AccountRole.USER)
    var certificate by mutableStateOf<Uri?>(null)
    var certificateName by mutableStateOf("")
    var certificateSize by mutableStateOf<Long?>(null)
    /** True once the terms were scrolled to the end; unlocks the two checkboxes (same rule as the website). */
    var readTerms by mutableStateOf(false)
    var agreeTerms by mutableStateOf(false)
    var agreeInfo by mutableStateOf(false)
}

/**
 * One card that slides between Sign in and Sign up, like the website's auth page.
 *
 * @param busy true while a sign-in or sign-up request is running: the button shows a spinner and the fields lock.
 * @param errorMessage server / network problem, shown above the button.
 * @param fieldErrors per-field problems from the validator. Sign in: identifier, password.
 *   Sign up: firstName, lastName, email, username, password, confirm, terms, certificate.
 * @param onInputChanged called when the user edits a field or switches panel, so the screen can clear old errors.
 * @param onRegister form, confirm-password text and the picked certificate (botanist only, otherwise null).
 */
@Composable
fun LoginScreen(
    busy: Boolean = false,
    errorMessage: String? = null,
    fieldErrors: Map<String, String> = emptyMap(),
    onInputChanged: () -> Unit = {},
    onLogin: (String, String) -> Unit = { _, _ -> },
    onRegister: (RegisterForm, String, Uri?) -> Unit = { _, _, _ -> }
) {
    val colors = MaterialTheme.colorScheme
    var registering by rememberSaveable { mutableStateOf(false) }
    var identifier by remember { mutableStateOf("") }
    var loginPassword by remember { mutableStateOf("") }
    val signUp = remember { SignUpFields() }
    val scroll = rememberScrollState()

    // Back to the top so the new panel starts at its heading.
    LaunchedEffect(registering) { scroll.animateScrollTo(0) }

    fun switchPanel() {
        registering = !registering
        onInputChanged()
    }

    Box(
        Modifier.fillMaxSize().systemBarsPadding().imePadding().padding(horizontal = 22.dp, vertical = 16.dp),
        contentAlignment = Alignment.Center
    ) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(scroll),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(18.dp)
        ) {
            Surface(shape = RoundedCornerShape(26.dp), color = colors.primaryContainer) {
                Box(Modifier.size(88.dp), contentAlignment = Alignment.Center) {
                    Text("🌱", style = MaterialTheme.typography.displaySmall)
                }
            }
            Text("Plantellect", style = MaterialTheme.typography.headlineLarge, color = colors.primary, fontWeight = FontWeight.Bold)
            Text(
                "A healthier home for your plant collection.", style = MaterialTheme.typography.bodyLarge,
                color = colors.onBackground.copy(alpha = .7f), textAlign = TextAlign.Center
            )
            Card(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(28.dp),
                colors = CardDefaults.cardColors(containerColor = colors.surface),
                elevation = CardDefaults.cardElevation(defaultElevation = 2.dp)
            ) {
                AnimatedContent(
                    targetState = registering,
                    transitionSpec = {
                        // Sign up enters from the right, Sign in from the left; the card grows/shrinks to fit.
                        val dir = if (targetState) 1 else -1
                        (slideInHorizontally(tween(SLIDE_MS, easing = FastOutSlowInEasing)) { it * dir } +
                                fadeIn(tween(SLIDE_MS / 2, delayMillis = SLIDE_MS / 5))) togetherWith
                                (slideOutHorizontally(tween(SLIDE_MS, easing = FastOutSlowInEasing)) { -it * dir } +
                                        fadeOut(tween(SLIDE_MS / 3))) using
                                SizeTransform(clip = true) { _, _ -> tween(SLIDE_MS, easing = FastOutSlowInEasing) }
                    },
                    label = "auth-panel"
                ) { isRegister ->
                    if (isRegister) {
                        SignUpPanel(
                            fields = signUp,
                            busy = busy,
                            errorMessage = errorMessage,
                            fieldErrors = fieldErrors,
                            onInputChanged = onInputChanged,
                            onRegister = onRegister,
                            onSwitch = ::switchPanel
                        )
                    } else {
                        SignInPanel(
                            identifier = identifier,
                            onIdentifier = { identifier = it; onInputChanged() },
                            password = loginPassword,
                            onPassword = { loginPassword = it; onInputChanged() },
                            busy = busy,
                            errorMessage = errorMessage,
                            fieldErrors = fieldErrors,
                            onLogin = onLogin,
                            onSwitch = ::switchPanel
                        )
                    }
                }
            }
            Text(
                "Discover more. Learn every day. Grow naturally.", style = MaterialTheme.typography.bodySmall,
                color = colors.onBackground.copy(alpha = .6f), textAlign = TextAlign.Center
            )
        }
    }
}

// ---------------------------------------------------------------------------------------------- sign in

@Composable
private fun SignInPanel(
    identifier: String, onIdentifier: (String) -> Unit,
    password: String, onPassword: (String) -> Unit,
    busy: Boolean, errorMessage: String?, fieldErrors: Map<String, String>,
    onLogin: (String, String) -> Unit, onSwitch: () -> Unit
) {
    val colors = MaterialTheme.colorScheme
    val focus = LocalFocusManager.current
    val canSubmit = identifier.isNotBlank() && password.isNotBlank() && !busy

    fun submit() {
        if (!canSubmit) return
        focus.clearFocus()
        onLogin(identifier.trim(), password)
    }

    Column(Modifier.fillMaxWidth().padding(22.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text("Welcome back", style = MaterialTheme.typography.titleLarge)
        Text(
            "Sign in to continue to your green space.", style = MaterialTheme.typography.bodyMedium,
            color = colors.onSurface.copy(alpha = .7f)
        )
        AuthField(
            value = identifier, onValueChange = onIdentifier, label = "Email or username",
            icon = Icons.Default.Person, enabled = !busy, error = fieldErrors["identifier"],
            keyboardType = KeyboardType.Email
        )
        AuthField(
            value = password, onValueChange = onPassword, label = "Password",
            icon = Icons.Default.Lock, enabled = !busy, error = fieldErrors["password"],
            isPassword = true, imeAction = ImeAction.Done, onDone = ::submit
        )
        if (errorMessage != null) {
            Text(errorMessage, style = MaterialTheme.typography.bodyMedium, color = colors.error)
        }
        SubmitButton(text = "Sign in", busyText = "Signing in…", busy = busy, enabled = canSubmit, onClick = ::submit)
        SwitchPrompt("Don't have an account?", "Sign up", enabled = !busy, onClick = onSwitch)
    }
}

// ---------------------------------------------------------------------------------------------- sign up

@Composable
private fun SignUpPanel(
    fields: SignUpFields,
    busy: Boolean, errorMessage: String?, fieldErrors: Map<String, String>,
    onInputChanged: () -> Unit,
    onRegister: (RegisterForm, String, Uri?) -> Unit,
    onSwitch: () -> Unit
) {
    val colors = MaterialTheme.colorScheme
    val focus = LocalFocusManager.current
    val resolver = LocalContext.current.contentResolver
    var showTerms by remember { mutableStateOf(false) }
    val isBotanist = fields.role == AccountRole.BOTANIST

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) {
            val (name, size) = describeFile(resolver, uri)
            fields.certificate = uri
            fields.certificateName = name
            fields.certificateSize = size
            onInputChanged()
        }
    }

    fun clearCertificate() {
        fields.certificate = null
        fields.certificateName = ""
        fields.certificateSize = null
    }

    fun submit() {
        if (busy) return
        focus.clearFocus()
        // Same as the website: nothing agreed and the terms never opened -> show them first.
        if (!fields.agreeTerms && !fields.agreeInfo && !fields.readTerms) showTerms = true
        onRegister(
            RegisterForm(
                email = fields.email.trim(),
                username = fields.username.trim(),
                password = fields.password,
                firstName = fields.firstName.trim(),
                lastName = fields.lastName.trim(),
                role = fields.role,
                agreeTerms = fields.agreeTerms,
                agreeInfo = fields.agreeInfo
            ),
            fields.confirm,
            fields.certificate.takeIf { isBotanist }
        )
    }

    if (showTerms) {
        TermsDialog(
            alreadyRead = fields.readTerms,
            onReadToEnd = { fields.readTerms = true },
            onClose = { showTerms = false }
        )
    }

    val checks = AuthValidator.passwordChecks(fields.password)

    Column(Modifier.fillMaxWidth().padding(22.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Text("Hello", style = MaterialTheme.typography.titleLarge)
        Text(
            "Create an account to start your plant identification journey.", style = MaterialTheme.typography.bodyMedium,
            color = colors.onSurface.copy(alpha = .7f)
        )

        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            AuthField(
                value = fields.firstName, onValueChange = { fields.firstName = it; onInputChanged() },
                label = "First name", icon = null, modifier = Modifier.weight(1f),
                enabled = !busy, error = fieldErrors["firstName"], capitalization = KeyboardCapitalization.Words
            )
            AuthField(
                value = fields.lastName, onValueChange = { fields.lastName = it; onInputChanged() },
                label = "Last name", icon = null, modifier = Modifier.weight(1f),
                enabled = !busy, error = fieldErrors["lastName"], capitalization = KeyboardCapitalization.Words
            )
        }
        AuthField(
            value = fields.email, onValueChange = { fields.email = it; onInputChanged() },
            label = "Email", icon = Icons.Default.Email, enabled = !busy,
            error = fieldErrors["email"], keyboardType = KeyboardType.Email
        )
        AuthField(
            value = fields.username, onValueChange = { fields.username = it; onInputChanged() },
            label = "Username", icon = Icons.Default.Person, enabled = !busy, error = fieldErrors["username"]
        )
        Requirements(visible = fields.username.isNotEmpty()) {
            Requirement("At least 6 characters", fields.username.trim().length >= 6)
        }
        AuthField(
            value = fields.password, onValueChange = { fields.password = it; onInputChanged() },
            label = "Password", icon = Icons.Default.Lock, enabled = !busy,
            error = fieldErrors["password"], isPassword = true
        )
        Requirements(visible = fields.password.isNotEmpty()) {
            Requirement("At least 6 characters", checks.length)
            Requirement("One lowercase letter", checks.lowercase)
            Requirement("One uppercase letter", checks.uppercase)
            Requirement("One number", checks.number)
        }
        AuthField(
            value = fields.confirm, onValueChange = { fields.confirm = it; onInputChanged() },
            label = "Confirm password", icon = Icons.Default.Lock, enabled = !busy,
            error = fieldErrors["confirm"], isPassword = true
        )
        Requirements(visible = fields.confirm.isNotEmpty()) {
            Requirement("Passwords match", fields.confirm == fields.password)
        }

        // ---- role
        Text("Select your role", style = MaterialTheme.typography.labelLarge, color = colors.onSurface.copy(alpha = .8f))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            RoleButton("USER", selected = !isBotanist, enabled = !busy, modifier = Modifier.weight(1f)) {
                fields.role = AccountRole.USER
                clearCertificate()   // a plain user has no certificate, drop it (the website does too)
                onInputChanged()
            }
            RoleButton("BOTANIST", selected = isBotanist, enabled = !busy, modifier = Modifier.weight(1f)) {
                fields.role = AccountRole.BOTANIST
                onInputChanged()
            }
        }

        // ---- certificate (botanist only)
        AnimatedVisibility(
            visible = isBotanist,
            enter = expandVertically(tween(300)) + fadeIn(tween(300)),
            exit = shrinkVertically(tween(250)) + fadeOut(tween(150))
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    "Botanists need a certificate (PDF, JPG or PNG, up to 20 MB). An admin reviews it before the role is granted.",
                    style = MaterialTheme.typography.bodySmall, color = colors.onSurface.copy(alpha = .7f)
                )
                val cert = fields.certificate
                if (cert == null) {
                    OutlinedButton(
                        onClick = { picker.launch(arrayOf("application/pdf", "image/jpeg", "image/png")) },
                        enabled = !busy,
                        modifier = Modifier.fillMaxWidth().height(50.dp),
                        shape = RoundedCornerShape(16.dp)
                    ) {
                        Icon(Icons.Default.UploadFile, contentDescription = null)
                        Spacer(Modifier.width(10.dp))
                        Text("Upload certificate")
                    }
                } else {
                    CertificateChip(
                        name = fields.certificateName,
                        size = fields.certificateSize,
                        isPdf = fields.certificateName.endsWith(".pdf", ignoreCase = true),
                        enabled = !busy,
                        onChange = { picker.launch(arrayOf("application/pdf", "image/jpeg", "image/png")) },
                        onRemove = ::clearCertificate
                    )
                }
                fieldErrors["certificate"]?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = colors.error) }
            }
        }

        // ---- terms
        TextButton(onClick = { showTerms = true }, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
            Text("View Terms and Conditions & Information Usage", textAlign = TextAlign.Center)
        }
        if (!fields.readTerms) {
            Text(
                "Read the terms to the end to unlock the checkboxes.", style = MaterialTheme.typography.bodySmall,
                color = colors.onSurface.copy(alpha = .6f), textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth()
            )
        }
        ConsentRow(
            checked = fields.agreeTerms, enabled = fields.readTerms && !busy,
            text = "I agree to all terms and conditions"
        ) { fields.agreeTerms = it; onInputChanged() }
        ConsentRow(
            checked = fields.agreeInfo, enabled = fields.readTerms && !busy,
            text = "I agree to the usage of my information"
        ) { fields.agreeInfo = it; onInputChanged() }
        fieldErrors["terms"]?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = colors.error) }

        if (errorMessage != null) {
            Text(errorMessage, style = MaterialTheme.typography.bodyMedium, color = colors.error)
        }
        SubmitButton(text = "Sign up", busyText = "Creating account…", busy = busy, enabled = !busy, onClick = ::submit)
        SwitchPrompt("Already have an account?", "Sign in", enabled = !busy, onClick = onSwitch)
    }
}

// ---------------------------------------------------------------------------------------------- pieces

@Composable
private fun AuthField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    icon: ImageVector?,
    modifier: Modifier = Modifier.fillMaxWidth(),
    enabled: Boolean = true,
    error: String? = null,
    keyboardType: KeyboardType = KeyboardType.Text,
    imeAction: ImeAction = ImeAction.Next,
    capitalization: KeyboardCapitalization = KeyboardCapitalization.None,
    isPassword: Boolean = false,
    onDone: () -> Unit = {}
) {
    val focus = LocalFocusManager.current
    var visible by remember { mutableStateOf(false) }
    val trailing: (@Composable () -> Unit)? = if (isPassword) {
        {
            IconButton(onClick = { visible = !visible }) {
                Icon(
                    if (visible) Icons.Default.VisibilityOff else Icons.Default.Visibility,
                    contentDescription = if (visible) "Hide password" else "Show password"
                )
            }
        }
    } else null

    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = modifier,
        label = { Text(label, maxLines = 1) },
        leadingIcon = icon?.let { vector -> { Icon(vector, contentDescription = null) } },
        trailingIcon = trailing,
        singleLine = true,
        shape = RoundedCornerShape(16.dp),
        enabled = enabled,
        isError = error != null,
        supportingText = error?.let { msg -> { Text(msg) } },
        visualTransformation = if (isPassword && !visible) PasswordVisualTransformation() else VisualTransformation.None,
        keyboardOptions = KeyboardOptions(
            capitalization = capitalization,
            keyboardType = if (isPassword) KeyboardType.Password else keyboardType,
            imeAction = imeAction
        ),
        keyboardActions = KeyboardActions(
            onNext = { focus.moveFocus(FocusDirection.Next) },
            onDone = { onDone() }
        )
    )
}

@Composable
private fun SubmitButton(text: String, busyText: String, busy: Boolean, enabled: Boolean, onClick: () -> Unit) {
    Button(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth().height(54.dp),
        shape = RoundedCornerShape(16.dp),
        enabled = enabled
    ) {
        if (busy) {
            CircularProgressIndicator(
                modifier = Modifier.size(22.dp),
                strokeWidth = 2.5.dp,
                color = MaterialTheme.colorScheme.onPrimary
            )
            Spacer(Modifier.width(12.dp))
            Text(busyText, style = MaterialTheme.typography.labelLarge)
        } else {
            Text(text, style = MaterialTheme.typography.labelLarge)
        }
    }
}

@Composable
private fun SwitchPrompt(question: String, action: String, enabled: Boolean, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(question, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurface.copy(alpha = .7f))
        TextButton(onClick = onClick, enabled = enabled) { Text(action, fontWeight = FontWeight.SemiBold) }
    }
}

@Composable
private fun RoleButton(label: String, selected: Boolean, enabled: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val shape = RoundedCornerShape(16.dp)
    if (selected) {
        Button(onClick = onClick, enabled = enabled, modifier = modifier.height(48.dp), shape = shape) {
            Text(label, style = MaterialTheme.typography.labelLarge)
        }
    } else {
        OutlinedButton(onClick = onClick, enabled = enabled, modifier = modifier.height(48.dp), shape = shape) {
            Text(label, style = MaterialTheme.typography.labelLarge)
        }
    }
}

@Composable
private fun Requirements(visible: Boolean, content: @Composable ColumnScope.() -> Unit) {
    AnimatedVisibility(
        visible = visible,
        enter = expandVertically(tween(200)) + fadeIn(tween(200)),
        exit = shrinkVertically(tween(150)) + fadeOut(tween(100))
    ) {
        Column(Modifier.padding(start = 4.dp), verticalArrangement = Arrangement.spacedBy(2.dp), content = content)
    }
}

@Composable
private fun Requirement(text: String, met: Boolean) {
    val colors = MaterialTheme.colorScheme
    val tint by animateColorAsState(if (met) colors.primary else colors.onSurface.copy(alpha = .5f), label = "req")
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(
            if (met) Icons.Default.CheckCircle else Icons.Default.RadioButtonUnchecked,
            contentDescription = if (met) "Met" else "Not met",
            tint = tint, modifier = Modifier.size(16.dp)
        )
        Spacer(Modifier.width(8.dp))
        Text(text, style = MaterialTheme.typography.bodySmall, color = tint)
    }
}

@Composable
private fun ConsentRow(checked: Boolean, enabled: Boolean, text: String, onChange: (Boolean) -> Unit) {
    val colors = MaterialTheme.colorScheme
    Row(
        Modifier.fillMaxWidth().toggleable(value = checked, enabled = enabled, role = Role.Checkbox, onValueChange = onChange),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Checkbox(checked = checked, onCheckedChange = null, enabled = enabled)
        Spacer(Modifier.width(8.dp))
        Text(
            text, style = MaterialTheme.typography.bodyMedium,
            color = if (enabled) colors.onSurface else colors.onSurface.copy(alpha = .45f)
        )
    }
}

@Composable
private fun CertificateChip(
    name: String, size: Long?, isPdf: Boolean, enabled: Boolean,
    onChange: () -> Unit, onRemove: () -> Unit
) {
    val colors = MaterialTheme.colorScheme
    Surface(shape = RoundedCornerShape(16.dp), color = colors.secondaryContainer, modifier = Modifier.fillMaxWidth()) {
        Row(Modifier.padding(start = 14.dp, top = 6.dp, bottom = 6.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(if (isPdf) Icons.Default.PictureAsPdf else Icons.Default.Image, contentDescription = null)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(name, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
                size?.let { Text(formatSize(it), style = MaterialTheme.typography.bodySmall, color = colors.onSecondaryContainer.copy(alpha = .7f)) }
            }
            TextButton(onClick = onChange, enabled = enabled) { Text("Change") }
            IconButton(onClick = onRemove, enabled = enabled) { Icon(Icons.Default.Close, contentDescription = "Remove certificate") }
        }
    }
}

/** Terms & Conditions. Close unlocks once the text was scrolled to the end, like the website's modal. */
@Composable
private fun TermsDialog(alreadyRead: Boolean, onReadToEnd: () -> Unit, onClose: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val scroll = rememberScrollState()
    // maxValue is Int.MAX_VALUE until the content has been measured.
    val measured = scroll.maxValue != Int.MAX_VALUE
    // Read the scroll state INSIDE the lambda: remember{} keeps the first lambda forever, so anything captured
    // from outside (like `measured` above) would stay at its first value and the end would never be detected.
    val atEnd by remember {
        derivedStateOf { scroll.maxValue != Int.MAX_VALUE && scroll.value >= scroll.maxValue - 8 }
    }
    val percent = when {
        !measured -> 0
        scroll.maxValue <= 0 -> 100
        else -> (scroll.value * 100 / scroll.maxValue).coerceIn(0, 100)
    }
    LaunchedEffect(atEnd) { if (atEnd) onReadToEnd() }
    val canClose = alreadyRead || atEnd

    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(
            shape = RoundedCornerShape(28.dp), color = colors.surface,
            modifier = Modifier.fillMaxWidth(0.92f).fillMaxHeight(0.82f)
        ) {
            Column(Modifier.padding(20.dp)) {
                Text("Terms & Conditions of Plantellect", style = MaterialTheme.typography.titleLarge)
                Spacer(Modifier.height(12.dp))
                Column(Modifier.weight(1f).verticalScroll(scroll), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    termsSections.forEach { section ->
                        Column {
                            Text(section.heading, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
                            Text(section.body, style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                    Text(
                        "You have reached the end of the terms. You may now close this window and check the agreement boxes.",
                        style = MaterialTheme.typography.bodySmall, color = colors.primary, textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth()
                    )
                }
                Spacer(Modifier.height(12.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        if (canClose) "You've read the terms." else "Scroll to the end to continue ($percent%)",
                        style = MaterialTheme.typography.bodySmall, color = colors.onSurface.copy(alpha = .7f),
                        modifier = Modifier.weight(1f)
                    )
                    Button(onClick = onClose, enabled = canClose) { Text("Close") }
                }
            }
        }
    }
}

private fun describeFile(resolver: ContentResolver, uri: Uri): Pair<String, Long?> {
    var name: String? = null
    var size: Long? = null
    runCatching {
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                name = c.getString(0)
                if (!c.isNull(1)) size = c.getLong(1)
            }
        }
    }
    return (name ?: "certificate") to size
}

private fun formatSize(bytes: Long): String = when {
    bytes < 1024 -> "$bytes B"
    bytes < 1024 * 1024 -> "${bytes / 1024} KB"
    else -> "%.1f MB".format(bytes / (1024.0 * 1024.0))
}
