package com.plantellect.mobileplantellect.data.local

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

enum class ThemeMode { SYSTEM, LIGHT, DARK }

/**
 * App preferences. Kept in their own file (not the session store) so signing out never resets them.
 */
class SettingsStore(context: Context) {
    private val prefs = context.getSharedPreferences("plantellect_settings", Context.MODE_PRIVATE)

    private val _themeMode = MutableStateFlow(
        runCatching { ThemeMode.valueOf(prefs.getString(KEY_THEME, null) ?: "") }.getOrDefault(ThemeMode.SYSTEM)
    )
    val themeMode: StateFlow<ThemeMode> = _themeMode.asStateFlow()

    private val _colorTheme = MutableStateFlow(prefs.getString(KEY_COLOR_THEME, null) ?: "PLANTELLECT")
    /** The color theme, by its name in ui/theme/ColorThemes.kt (ColorTheme.fromName turns an unknown name into the default). */
    val colorTheme: StateFlow<String> = _colorTheme.asStateFlow()

    fun setColorTheme(name: String) {
        prefs.edit().putString(KEY_COLOR_THEME, name).apply()
        _colorTheme.value = name
    }

    private val _dynamicColor = MutableStateFlow(prefs.getBoolean(KEY_DYNAMIC, false))
    /** Material You colors taken from the wallpaper (Android 12+, which is our minimum). */
    val dynamicColor: StateFlow<Boolean> = _dynamicColor.asStateFlow()

    private val _debugMode = MutableStateFlow(prefs.getBoolean(KEY_DEBUG, false))
    /** Developer view: confidence percentages and technical status. Off = plain-language results. */
    val debugMode: StateFlow<Boolean> = _debugMode.asStateFlow()

    private val _typeCombo = MutableStateFlow(prefs.getString(KEY_TYPE_COMBO, null) ?: "DEFAULT")
    /**
     * The font combo, by its name in ui/theme/TypeCombos.kt (kept as text so this layer does not depend on
     * the UI; TypeCombo.fromName turns an unknown or removed name into the default).
     */
    val typeCombo: StateFlow<String> = _typeCombo.asStateFlow()

    private val _autoContribute = MutableStateFlow(prefs.getBoolean(KEY_AUTO_CONTRIBUTE, false))
    /**
     * "Help improve": every scan the server offers for training is sent without asking. Off by default;
     * the Settings screen only turns it on after the person confirms.
     */
    val autoContribute: StateFlow<Boolean> = _autoContribute.asStateFlow()

    private val _contributeHintHidden = MutableStateFlow(prefs.getBoolean(KEY_CONTRIBUTE_HINT_HIDDEN, false))
    /** True once the person chose "Don't show this again" on the scan card's "turn this on in Settings" hint. */
    val contributeHintHidden: StateFlow<Boolean> = _contributeHintHidden.asStateFlow()

    private val _offlineMode = MutableStateFlow(prefs.getBoolean(KEY_OFFLINE, false))
    /**
     * Settings > Scanning > "Offline mode". On: every scan runs on the phone's own model and the server is not
     * contacted for scanning. Off (default): the server is preferred, and a scan that finds it unreachable waits
     * and retries before falling back to the phone's model.
     */
    val offlineMode: StateFlow<Boolean> = _offlineMode.asStateFlow()

    fun setOfflineMode(enabled: Boolean) {
        prefs.edit().putBoolean(KEY_OFFLINE, enabled).apply()
        _offlineMode.value = enabled
    }

    fun setThemeMode(mode: ThemeMode) {
        prefs.edit().putString(KEY_THEME, mode.name).apply()
        _themeMode.value = mode
    }

    fun setDynamicColor(enabled: Boolean) {
        prefs.edit().putBoolean(KEY_DYNAMIC, enabled).apply()
        _dynamicColor.value = enabled
    }

    fun setDebugMode(enabled: Boolean) {
        prefs.edit().putBoolean(KEY_DEBUG, enabled).apply()
        _debugMode.value = enabled
    }

    fun setTypeCombo(name: String) {
        prefs.edit().putString(KEY_TYPE_COMBO, name).apply()
        _typeCombo.value = name
    }

    fun setAutoContribute(enabled: Boolean) {
        prefs.edit().putBoolean(KEY_AUTO_CONTRIBUTE, enabled).apply()
        _autoContribute.value = enabled
    }

    fun setContributeHintHidden(hidden: Boolean) {
        prefs.edit().putBoolean(KEY_CONTRIBUTE_HINT_HIDDEN, hidden).apply()
        _contributeHintHidden.value = hidden
    }

    private companion object {
        const val KEY_TYPE_COMBO = "type_combo"
        const val KEY_AUTO_CONTRIBUTE = "auto_contribute"
        const val KEY_CONTRIBUTE_HINT_HIDDEN = "contribute_hint_hidden"
        const val KEY_THEME = "theme_mode"
        const val KEY_COLOR_THEME = "color_theme"
        const val KEY_DYNAMIC = "dynamic_color"
        const val KEY_DEBUG = "debug_mode"
        const val KEY_OFFLINE = "offline_mode"
    }
}
