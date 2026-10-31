package com.plantellect.mobileplantellect.ui.screen

import android.content.ContentResolver
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.*
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.*
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.plantellect.mobileplantellect.data.logic.AccountRole
import com.plantellect.mobileplantellect.data.logic.AuthValidator
import com.plantellect.mobileplantellect.data.logic.RegisterForm

private const val SLIDE_MS = 420
private val CERT_TYPES = arrayOf("application/pdf", "image/jpeg", "image/png")

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
    var readTerms by mutableStateOf(false)
    var agreeTerms by mutableStateOf(false)
    var agreeInfo by mutableStateOf(false)
}

@Composable
fun LoginScreen(
    busy: Boolean = false,
    errorMessage: String? = null,
    fieldErrors: Map<String, String> = emptyMap(),
    onInputChanged: () -> Unit = {},
    onLogin: (String, String) -> Unit = { _, _ -> },
    onRegister: (RegisterForm, String, Uri?) -> Unit = { _, _, _ -> }
) {
    val c = MaterialTheme.colorScheme
    var registering by rememberSaveable { mutableStateOf(false) }
    var identifier by remember { mutableStateOf("") }
    var loginPassword by remember { mutableStateOf("") }
    val signUp = remember { SignUpFields() }
    val scroll = rememberScrollState()
    LaunchedEffect(registering) { scroll.animateScrollTo(0) }
    fun switchPanel() { registering = !registering; onInputChanged() }

    Box(
        Modifier.fillMaxSize().systemBarsPadding().imePadding().padding(horizontal = 22.dp, vertical = 16.dp),
        contentAlignment = Alignment.Center
    ) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(scroll),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            LogoMark(96.dp)
            Text("PLANTELLECT", style = MaterialTheme.typography.labelLarge, color = c.primary)
            Text("Grow your plant knowledge.", style = MaterialTheme.typography.headlineSmall, color = c.onBackground, textAlign = TextAlign.Center)
            Text("Identify • Discover • Learn", style = MaterialTheme.typography.bodySmall, color = c.onBackground.copy(alpha = .65f))

            PlantSurface(Modifier.fillMaxWidth()) {
                AnimatedContent(
                    targetState = registering,
                    transitionSpec = {
                        val dir = if (targetState) 1 else -1
                        (slideInHorizontally(tween(SLIDE_MS, easing = FastOutSlowInEasing)) { it * dir } +
                                fadeIn(tween(SLIDE_MS / 2, delayMillis = SLIDE_MS / 5))) togetherWith
                                (slideOutHorizontally(tween(SLIDE_MS, easing = FastOutSlowInEasing)) { -it * dir } +
                                        fadeOut(tween(SLIDE_MS / 3))) using
                                SizeTransform(clip = true) { _, _ -> tween(SLIDE_MS, easing = FastOutSlowInEasing) }
                    },
                    label = "auth-panel"
                ) { isRegister ->
                    if (isRegister) SignUpPanel(signUp, busy, errorMessage, fieldErrors, onInputChanged, onRegister, ::switchPanel)
                    else SignInPanel(
                        identifier, { identifier = it; onInputChanged() },
                        loginPassword, { loginPassword = it; onInputChanged() },
                        busy, errorMessage, fieldErrors, onLogin, ::switchPanel
                    )
                }
            }
            Text("Discover more. Learn every day. Grow naturally.", style = MaterialTheme.typography.bodySmall,
                color = c.onBackground.copy(alpha = .6f), textAlign = TextAlign.Center)
        }
    }
}

@Composable
private fun PanelIntro(title: String, subtitle: String) {
    Text(title, style = MaterialTheme.typography.titleLarge)
    Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
private fun ErrorText(text: String?) {
    if (text != null) Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
}

@Composable
private fun SignInPanel(
    identifier: String, onIdentifier: (String) -> Unit,
    password: String, onPassword: (String) -> Unit,
    busy: Boolean, errorMessage: String?, fieldErrors: Map<String, String>,
    onLogin: (String, String) -> Unit, onSwitch: () -> Unit
) {
    val focus = LocalFocusManager.current
    val canSubmit = identifier.isNotBlank() && password.isNotBlank() && !busy
    fun submit() { if (canSubmit) { focus.clearFocus(); onLogin(identifier.trim(), password) } }

    Column(Modifier.fillMaxWidth().padding(22.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        PanelIntro("Welcome back", "Sign in to continue to your green space.")
        AuthField(identifier, onIdentifier, "Email or username", enabled = !busy, error = fieldErrors["identifier"], keyboardType = KeyboardType.Email)
        AuthField(password, onPassword, "Password", enabled = !busy, error = fieldErrors["password"],
            isPassword = true, imeAction = ImeAction.Done, onDone = ::submit)
        ErrorText(errorMessage)
        SubmitButton("Sign in", "Signing in…", busy, canSubmit, ::submit)
        SwitchPrompt("Don't have an account?", "Sign up", !busy, onSwitch)
    }
}

@Composable
private fun SignUpPanel(
    f: SignUpFields, busy: Boolean, errorMessage: String?, fieldErrors: Map<String, String>,
    onInputChanged: () -> Unit, onRegister: (RegisterForm, String, Uri?) -> Unit, onSwitch: () -> Unit
) {
    val c = MaterialTheme.colorScheme
    val focus = LocalFocusManager.current
    val resolver = LocalContext.current.contentResolver
    var showTerms by remember { mutableStateOf(false) }
    val isBotanist = f.role == AccountRole.BOTANIST
    val checks = AuthValidator.passwordChecks(f.password)

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) {
            val (name, size) = describeFile(resolver, uri)
            f.certificate = uri; f.certificateName = name; f.certificateSize = size
            onInputChanged()
        }
    }
    fun clearCertificate() { f.certificate = null; f.certificateName = ""; f.certificateSize = null }
    fun edit(set: (String) -> Unit): (String) -> Unit = { set(it); onInputChanged() }

    fun submit() {
        if (busy) return
        focus.clearFocus()
        if (!f.agreeTerms && !f.agreeInfo && !f.readTerms) showTerms = true
        onRegister(
            RegisterForm(
                email = f.email.trim(), username = f.username.trim(), password = f.password,
                firstName = f.firstName.trim(), lastName = f.lastName.trim(), role = f.role,
                agreeTerms = f.agreeTerms, agreeInfo = f.agreeInfo
            ),
            f.confirm, f.certificate.takeIf { isBotanist }
        )
    }

    if (showTerms) TermsDialog(f.readTerms, { f.readTerms = true }, { showTerms = false })

    Column(Modifier.fillMaxWidth().padding(22.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        PanelIntro("Hello", "Create an account to start your plant identification journey.")

        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            AuthField(f.firstName, edit { f.firstName = it }, "First name", Modifier.weight(1f), !busy, fieldErrors["firstName"], capitalization = KeyboardCapitalization.Words)
            AuthField(f.lastName, edit { f.lastName = it }, "Last name", Modifier.weight(1f), !busy, fieldErrors["lastName"], capitalization = KeyboardCapitalization.Words)
        }
        AuthField(f.email, edit { f.email = it }, "Email", enabled = !busy, error = fieldErrors["email"], keyboardType = KeyboardType.Email)
        AuthField(f.username, edit { f.username = it }, "Username", enabled = !busy, error = fieldErrors["username"])
        Requirements(f.username.isNotEmpty()) { Requirement("At least 6 characters", f.username.trim().length >= 6) }
        AuthField(f.password, edit { f.password = it }, "Password", enabled = !busy, error = fieldErrors["password"], isPassword = true)
        Requirements(f.password.isNotEmpty()) {
            Requirement("At least 6 characters", checks.length)
            Requirement("One lowercase letter", checks.lowercase)
            Requirement("One uppercase letter", checks.uppercase)
            Requirement("One number", checks.number)
        }
        AuthField(f.confirm, edit { f.confirm = it }, "Confirm password", enabled = !busy, error = fieldErrors["confirm"], isPassword = true)
        Requirements(f.confirm.isNotEmpty()) { Requirement("Passwords match", f.confirm == f.password) }

        Text("Select your role", style = MaterialTheme.typography.labelLarge, color = c.onSurfaceVariant)
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            RoleButton("USER", !isBotanist, !busy, Modifier.weight(1f)) { f.role = AccountRole.USER; clearCertificate(); onInputChanged() }
            RoleButton("BOTANIST", isBotanist, !busy, Modifier.weight(1f)) { f.role = AccountRole.BOTANIST; onInputChanged() }
        }

        AnimatedVisibility(
            visible = isBotanist,
            enter = expandVertically(tween(300)) + fadeIn(tween(300)),
            exit = shrinkVertically(tween(250)) + fadeOut(tween(150))
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Botanists need a certificate (PDF, JPG or PNG, up to 20 MB). An admin reviews it before the role is granted.",
                    style = MaterialTheme.typography.bodySmall, color = c.onSurfaceVariant)
                if (f.certificate == null) {
                    OutlinedButton({ picker.launch(CERT_TYPES) }, Modifier.fillMaxWidth().height(50.dp), enabled = !busy) { Text("Upload certificate") }
                } else {
                    CertificateChip(f.certificateName, f.certificateSize, !busy, { picker.launch(CERT_TYPES) }, ::clearCertificate)
                }
                ErrorText(fieldErrors["certificate"])
            }
        }

        TextButton({ showTerms = true }, Modifier.fillMaxWidth(), enabled = !busy) {
            Text("View Terms and Conditions & Information Usage", textAlign = TextAlign.Center)
        }
        if (!f.readTerms) Text("Read the terms to the end to unlock the checkboxes.", style = MaterialTheme.typography.bodySmall,
            color = c.onSurfaceVariant, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
        ConsentRow(f.agreeTerms, f.readTerms && !busy, "I agree to all terms and conditions") { f.agreeTerms = it; onInputChanged() }
        ConsentRow(f.agreeInfo, f.readTerms && !busy, "I agree to the usage of my information") { f.agreeInfo = it; onInputChanged() }
        ErrorText(fieldErrors["terms"])
        ErrorText(errorMessage)
        SubmitButton("Sign up", "Creating account…", busy, !busy, ::submit)
        SwitchPrompt("Already have an account?", "Sign in", !busy, onSwitch)
    }
}

@Composable
private fun AuthField(
    value: String, onValueChange: (String) -> Unit, label: String,
    modifier: Modifier = Modifier.fillMaxWidth(),
    enabled: Boolean = true, error: String? = null,
    keyboardType: KeyboardType = KeyboardType.Text, imeAction: ImeAction = ImeAction.Next,
    capitalization: KeyboardCapitalization = KeyboardCapitalization.None,
    isPassword: Boolean = false, onDone: () -> Unit = {}
) {
    val focus = LocalFocusManager.current
    var visible by remember { mutableStateOf(false) }
    OutlinedTextField(
        value = value, onValueChange = onValueChange, modifier = modifier,
        label = { Text(label, maxLines = 1) },
        trailingIcon = if (isPassword) ({ TextButton({ visible = !visible }) { Text(if (visible) "Hide" else "Show") } }) else null,
        singleLine = true, shape = MaterialTheme.shapes.small, enabled = enabled,
        isError = error != null, supportingText = error?.let { msg -> { Text(msg) } },
        visualTransformation = if (isPassword && !visible) PasswordVisualTransformation() else VisualTransformation.None,
        keyboardOptions = KeyboardOptions(
            capitalization = capitalization,
            keyboardType = if (isPassword) KeyboardType.Password else keyboardType,
            imeAction = imeAction
        ),
        keyboardActions = KeyboardActions(onNext = { focus.moveFocus(FocusDirection.Next) }, onDone = { onDone() })
    )
}

@Composable
private fun SubmitButton(text: String, busyText: String, busy: Boolean, enabled: Boolean, onClick: () -> Unit) {
    Button(onClick, Modifier.fillMaxWidth().height(54.dp), enabled = enabled, shape = MaterialTheme.shapes.small) {
        if (busy) {
            CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.5.dp, color = MaterialTheme.colorScheme.onPrimary)
            Spacer(Modifier.width(12.dp))
        }
        Text(if (busy) busyText else text, style = MaterialTheme.typography.labelLarge)
    }
}

@Composable
private fun SwitchPrompt(question: String, action: String, enabled: Boolean, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth(), Arrangement.Center, Alignment.CenterVertically) {
        Text(question, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        TextButton(onClick, enabled = enabled) { Text(action) }
    }
}

@Composable
private fun RoleButton(label: String, selected: Boolean, enabled: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val m = modifier.height(48.dp)
    val shape = MaterialTheme.shapes.small
    if (selected) Button(onClick, m, enabled, shape) { Text(label) }
    else OutlinedButton(onClick, m, enabled, shape) { Text(label) }
}

@Composable
private fun Requirements(visible: Boolean, content: @Composable ColumnScope.() -> Unit) {
    AnimatedVisibility(
        visible,
        enter = expandVertically(tween(200)) + fadeIn(tween(200)),
        exit = shrinkVertically(tween(150)) + fadeOut(tween(100))
    ) { Column(Modifier.padding(start = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp), content = content) }
}

@Composable
private fun Requirement(text: String, met: Boolean) {
    val c = MaterialTheme.colorScheme
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        LeafDot(met)
        Text(if (met) "$text (done)" else text, style = MaterialTheme.typography.bodySmall,
            color = if (met) c.primary else c.onSurfaceVariant)
    }
}

@Composable
private fun ConsentRow(checked: Boolean, enabled: Boolean, text: String, onChange: (Boolean) -> Unit) {
    val c = MaterialTheme.colorScheme
    Row(
        Modifier.fillMaxWidth().toggleable(value = checked, enabled = enabled, role = Role.Checkbox, onValueChange = onChange),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Checkbox(checked, onCheckedChange = null, enabled = enabled)
        Spacer(Modifier.width(8.dp))
        Text(text, style = MaterialTheme.typography.bodyMedium, color = if (enabled) c.onSurface else c.onSurface.copy(alpha = .45f))
    }
}

@Composable
private fun CertificateChip(name: String, size: Long?, enabled: Boolean, onChange: () -> Unit, onRemove: () -> Unit) {
    val c = MaterialTheme.colorScheme
    val kind = if (name.endsWith(".pdf", ignoreCase = true)) "PDF" else "IMG"
    PlantSurface(Modifier.fillMaxWidth(), container = c.secondaryContainer) {
        Row(Modifier.padding(start = 14.dp, top = 6.dp, bottom = 6.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(kind, style = MaterialTheme.typography.labelLarge, color = c.primary)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(name, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                size?.let { Text(formatSize(it), style = MaterialTheme.typography.bodySmall, color = c.onSecondaryContainer.copy(alpha = .7f)) }
            }
            TextButton(onChange, enabled = enabled) { Text("Change") }
            TextButton(onRemove, enabled = enabled) { Text("Remove", color = c.error) }
        }
    }
}

@Composable
private fun TermsDialog(alreadyRead: Boolean, onReadToEnd: () -> Unit, onClose: () -> Unit) {
    val c = MaterialTheme.colorScheme
    val scroll = rememberScrollState()
    val measured = scroll.maxValue != Int.MAX_VALUE
    val atEnd by remember { derivedStateOf { scroll.maxValue != Int.MAX_VALUE && scroll.value >= scroll.maxValue - 8 } }
    val percent = when {
        !measured -> 0
        scroll.maxValue <= 0 -> 100
        else -> (scroll.value * 100 / scroll.maxValue).coerceIn(0, 100)
    }
    LaunchedEffect(atEnd) { if (atEnd) onReadToEnd() }
    val canClose = alreadyRead || atEnd

    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(shape = MaterialTheme.shapes.large, color = c.surface, modifier = Modifier.fillMaxWidth(0.92f).fillMaxHeight(0.82f)) {
            Column(Modifier.padding(20.dp)) {
                Text("Terms & Conditions of Plantellect", style = MaterialTheme.typography.titleLarge)
                Spacer(Modifier.height(12.dp))
                Column(Modifier.weight(1f).verticalScroll(scroll), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    termsSections.forEach { s ->
                        Column {
                            Text(s.heading, style = MaterialTheme.typography.titleSmall)
                            Text(s.body, style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                    Text("You have reached the end of the terms. You may now close this window and check the agreement boxes.",
                        style = MaterialTheme.typography.bodySmall, color = c.primary, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
                }
                Spacer(Modifier.height(12.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(if (canClose) "You've read the terms." else "Scroll to the end to continue ($percent%)",
                        style = MaterialTheme.typography.bodySmall, color = c.onSurfaceVariant, modifier = Modifier.weight(1f))
                    Button(onClose, enabled = canClose) { Text("Close") }
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
            if (c.moveToFirst()) { name = c.getString(0); if (!c.isNull(1)) size = c.getLong(1) }
        }
    }
    return (name ?: "certificate") to size
}

private fun formatSize(bytes: Long): String = when {
    bytes < 1024 -> "$bytes B"
    bytes < 1024 * 1024 -> "${bytes / 1024} KB"
    else -> "%.1f MB".format(bytes / (1024.0 * 1024.0))
}