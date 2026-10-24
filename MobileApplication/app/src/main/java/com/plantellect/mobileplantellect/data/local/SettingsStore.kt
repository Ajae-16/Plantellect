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

    private val _dynamicColor = MutableStateFlow(prefs.getBoolean(KEY_DYNAMIC, false))
    /** Material You colors taken from the wallpaper (Android 12+, which is our minimum). */
    val dynamicColor: StateFlow<Boolean> = _dynamicColor.asStateFlow()

    private val _debugMode = MutableStateFlow(prefs.getBoolean(KEY_DEBUG, false))
    /** Developer view: confidence percentages and technical status. Off = plain-language results. */
    val debugMode: StateFlow<Boolean> = _debugMode.asStateFlow()

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

    private companion object {
        const val KEY_THEME = "theme_mode"
        const val KEY_DYNAMIC = "dynamic_color"
        const val KEY_DEBUG = "debug_mode"
    }
}
