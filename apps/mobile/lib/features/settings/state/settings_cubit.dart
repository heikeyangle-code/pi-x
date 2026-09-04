import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../../core/logger.dart';
import '../../../models/app_icon.dart';
import '../../../models/code_font_family.dart';
import '../../../models/git_diff_interaction_mode.dart';
import '../../../models/image_paste_shortcut.dart';
import '../../../models/messages.dart';
import '../../../models/new_session_tab.dart';
import '../../../models/terminal_app.dart';
import '../../../services/app_icon_service.dart';
import '../../../services/bridge_service.dart';
import '../../../services/machine_manager_service.dart';
import '../../../theme/code_text_style.dart';
import 'settings_state.dart';

/// Manages user settings with SharedPreferences persistence.
class SettingsCubit extends Cubit<SettingsState> {
  final SharedPreferences _prefs;
  final BridgeService? _bridge;
  final MachineManagerService? _machineManager;
  final AppIconService _appIconService;
  StreamSubscription<BridgeConnectionState>? _bridgeSub;

  static const _keyThemeMode = 'settings_theme_mode';
  static const _keyAppLocale = 'settings_app_locale';
  static const _keySpeechLocale = 'settings_speech_locale';
  static const _keyHideVoiceInput = 'settings_hide_voice_input';
  static const _keyOpenGalleryDirectly = 'settings_open_gallery_directly';
  static const _keyImagePasteShortcut = 'settings_image_paste_shortcut';
  static const _keyGitDiffInteractionMode =
      'settings_git_diff_interaction_mode';
  static const _keyGitDiffFocusAutoLandscape =
      'settings_git_diff_focus_auto_landscape';
  static const _keyShowRemoteGitStatusBadge =
      'settings_show_remote_git_status_badge';
  static const _keyShowBridgeNameInSessionList =
      'settings_show_bridge_name_in_session_list';
  static const _keySelectedAppIcon = 'settings_selected_app_icon';
  static const _keyTerminalApp = 'settings_terminal_app';
  static const _keyNewSessionTabs = 'settings_new_session_tabs';
  static const _keyShowHiddenDirectories = 'settings_show_hidden_directories';
  static const _keyUsageDisplayMode = 'settings_usage_display_mode';
  static const _keyAutoRenameCodexSessions = 'autoRenameCodexSessions';
  static const _keyShowExtendedCodexEfforts =
      'settings_show_extended_codex_efforts';
  static const _keyAutoRenameClaudeSessions = 'autoRenameClaudeSessions';
  static const _keyTextScale = 'settings_text_scale';
  static const _keyCodeFontSize = 'settings_code_font_size';
  static const _keyCodeFontFamily = 'settings_code_font_family';
  static const minTextScale = 0.8;
  static const maxTextScale = 1.0;
  // Legacy key for migration
  static const _keyIndentSize = 'settings_indent_size';

  SettingsCubit(
    this._prefs, {
    BridgeService? bridgeService,
    MachineManagerService? machineManager,
    AppIconService? appIconService,
  }) : _bridge = bridgeService,
       _machineManager = machineManager,
       _appIconService = appIconService ?? AppIconService(),
       super(
         _load(_prefs).copyWith(
           appIconSupported:
               (appIconService ?? AppIconService()).isSupportedPlatform,
         ),
       ) {
    final bridge = _bridge;
    if (bridge != null) {
      _bridgeSub = bridge.connectionStatus.listen((status) {
        if (status == BridgeConnectionState.connected) {
          emit(state.copyWith(activeMachineId: null));
          _updateActiveMachine();
        } else {
          emit(state.copyWith(activeMachineId: null));
        }
      });
      // Resolve active machine if already connected at init time
      if (bridge.isConnected) {
        _updateActiveMachine();
      }
    }
    unawaited(_initializeAppIconSupport());
    unawaited(_syncAppIcon(force: true));
  }

  /// Resolve the currently connected Machine ID from the bridge URL.
  void _updateActiveMachine() {
    final bridge = _bridge;
    final manager = _machineManager;
    if (bridge == null || manager == null) return;

    final url = bridge.lastUrl;
    if (url == null) return;

    final uri = Uri.tryParse(
      url.replaceFirst('ws://', 'http://').replaceFirst('wss://', 'https://'),
    );
    if (uri == null) return;

    final machine = manager.findByHostPort(
      uri.host,
      uri.port != 0 ? uri.port : 8765,
    );
    if (machine != null) {
      emit(state.copyWith(activeMachineId: machine.id));
    }
  }

  static SettingsState _load(SharedPreferences prefs) {
    final themeModeIndex = prefs.getInt(_keyThemeMode);
    final appLocale = prefs.getString(_keyAppLocale) ?? '';
    final speechLocale = prefs.getString(_keySpeechLocale);

    final indentSize = prefs.getInt(_keyIndentSize) ?? 2;
    final textScale = prefs.getDouble(_keyTextScale) ?? 1.0;
    final codeFontSize =
        prefs.getDouble(_keyCodeFontSize) ?? defaultCodeFontSize;
    final codeFontFamily = codeFontFamilyFromRaw(
      prefs.getString(_keyCodeFontFamily),
    );
    final hideVoiceInput = prefs.getBool(_keyHideVoiceInput) ?? false;
    final openGalleryDirectly = prefs.getBool(_keyOpenGalleryDirectly) ?? false;
    final imagePasteShortcut = imagePasteShortcutFromRaw(
      prefs.getString(_keyImagePasteShortcut),
    );
    final gitDiffInteractionMode = gitDiffInteractionModeFromRaw(
      prefs.getString(_keyGitDiffInteractionMode),
    );
    final gitDiffFocusAutoLandscape =
        prefs.getBool(_keyGitDiffFocusAutoLandscape) ?? false;
    final showRemoteGitStatusBadge =
        prefs.getBool(_keyShowRemoteGitStatusBadge) ?? false;
    final showBridgeNameInSessionList =
        prefs.getBool(_keyShowBridgeNameInSessionList) ?? true;
    final selectedAppIcon = appIconVariantFromId(
      prefs.getString(_keySelectedAppIcon),
    );
    final usageDisplayMode = _usageDisplayModeFromRaw(
      prefs.getString(_keyUsageDisplayMode),
    );
    final autoRenameCodexSessions =
        prefs.getBool(_keyAutoRenameCodexSessions) ?? true;
    final showExtendedCodexEfforts =
        prefs.getBool(_keyShowExtendedCodexEfforts) ?? false;
    final autoRenameClaudeSessions =
        prefs.getBool(_keyAutoRenameClaudeSessions) ?? false;
    final showHiddenDirectories =
        prefs.getBool(_keyShowHiddenDirectories) ?? false;

    // Load terminal app config
    var terminalApp = TerminalAppConfig.empty;
    final terminalJson = prefs.getString(_keyTerminalApp);
    if (terminalJson != null) {
      try {
        final map = jsonDecode(terminalJson) as Map<String, dynamic>;
        terminalApp = TerminalAppConfig.fromJson(map);
      } catch (_) {
        // Ignore parse errors
      }
    }

    // Load new session tabs
    var newSessionTabs = defaultNewSessionTabs;
    final tabsJson = prefs.getString(_keyNewSessionTabs);
    if (tabsJson != null) {
      newSessionTabs = tabsFromJson(tabsJson) ?? defaultNewSessionTabs;
    }

    return SettingsState(
      themeMode:
          (themeModeIndex != null &&
              themeModeIndex >= 0 &&
              themeModeIndex < ThemeMode.values.length)
          ? ThemeMode.values[themeModeIndex]
          : ThemeMode.system,
      appLocaleId: appLocale,
      speechLocaleId: speechLocale ?? '',
      indentSize: indentSize.clamp(1, 4),
      textScale: textScale.clamp(minTextScale, maxTextScale),
      codeFontSize: codeFontSize.clamp(minCodeFontSize, maxCodeFontSize),
      codeFontFamily: codeFontFamily,
      hideVoiceInput: hideVoiceInput,
      openGalleryDirectly: openGalleryDirectly,
      imagePasteShortcut: imagePasteShortcut,
      gitDiffInteractionMode: gitDiffInteractionMode,
      gitDiffFocusAutoLandscape: gitDiffFocusAutoLandscape,
      showRemoteGitStatusBadge: showRemoteGitStatusBadge,
      showBridgeNameInSessionList: showBridgeNameInSessionList,
      selectedAppIcon: selectedAppIcon,
      terminalApp: terminalApp,
      newSessionTabs: newSessionTabs,
      showHiddenDirectories: showHiddenDirectories,
      usageDisplayMode: usageDisplayMode,
      autoRenameCodexSessions: autoRenameCodexSessions,
      showExtendedCodexEfforts: showExtendedCodexEfforts,
      autoRenameClaudeSessions: autoRenameClaudeSessions,
    );
  }

  static UsageDisplayMode _usageDisplayModeFromRaw(String? raw) {
    return switch (raw) {
      'used' => UsageDisplayMode.used,
      _ => UsageDisplayMode.remaining,
    };
  }

  Future<void> _initializeAppIconSupport() async {
    final supported = await _appIconService.isSupported();
    if (isClosed) return;
    if (supported == state.appIconSupported) return;
    emit(state.copyWith(appIconSupported: supported));
  }

  void setThemeMode(ThemeMode mode) {
    _prefs.setInt(_keyThemeMode, mode.index);
    emit(state.copyWith(themeMode: mode));
  }

  void setAppLocaleId(String localeId) {
    _prefs.setString(_keyAppLocale, localeId);
    emit(state.copyWith(appLocaleId: localeId));
  }

  void setIndentSize(int size) {
    final clamped = size.clamp(1, 4);
    _prefs.setInt(_keyIndentSize, clamped);
    emit(state.copyWith(indentSize: clamped));
  }

  void setTextScale(double scale) {
    final clamped = scale.clamp(minTextScale, maxTextScale);
    _prefs.setDouble(_keyTextScale, clamped);
    emit(state.copyWith(textScale: clamped));
  }

  void setCodeFontSize(double size) {
    final clamped = size.clamp(minCodeFontSize, maxCodeFontSize);
    _prefs.setDouble(_keyCodeFontSize, clamped);
    emit(state.copyWith(codeFontSize: clamped));
  }

  void setCodeFontFamily(CodeFontFamily family) {
    _prefs.setString(_keyCodeFontFamily, family.id);
    emit(state.copyWith(codeFontFamily: family));
  }

  void setHideVoiceInput(bool hide) {
    _prefs.setBool(_keyHideVoiceInput, hide);
    emit(state.copyWith(hideVoiceInput: hide));
  }

  void setOpenGalleryDirectly(bool enabled) {
    _prefs.setBool(_keyOpenGalleryDirectly, enabled);
    emit(state.copyWith(openGalleryDirectly: enabled));
  }

  void setImagePasteShortcut(ImagePasteShortcut shortcut) {
    _prefs.setString(_keyImagePasteShortcut, shortcut.name);
    emit(state.copyWith(imagePasteShortcut: shortcut));
  }

  void setGitDiffInteractionMode(GitDiffInteractionMode mode) {
    _prefs.setString(_keyGitDiffInteractionMode, mode.name);
    emit(state.copyWith(gitDiffInteractionMode: mode));
  }

  void setGitDiffFocusAutoLandscape(bool enabled) {
    _prefs.setBool(_keyGitDiffFocusAutoLandscape, enabled);
    emit(state.copyWith(gitDiffFocusAutoLandscape: enabled));
  }

  void setShowRemoteGitStatusBadge(bool show) {
    _prefs.setBool(_keyShowRemoteGitStatusBadge, show);
    emit(state.copyWith(showRemoteGitStatusBadge: show));
  }

  void setShowBridgeNameInSessionList(bool show) {
    _prefs.setBool(_keyShowBridgeNameInSessionList, show);
    emit(state.copyWith(showBridgeNameInSessionList: show));
  }

  Future<void> setSelectedAppIcon(AppIconVariant icon) async {
    await _prefs.setString(_keySelectedAppIcon, icon.id);
    emit(state.copyWith(selectedAppIcon: icon));
    await _syncAppIcon(force: true, allowResetToDefault: true);
  }

  void setSpeechLocaleId(String localeId) {
    _prefs.setString(_keySpeechLocale, localeId);
    emit(state.copyWith(speechLocaleId: localeId));
  }

  void setTerminalApp(TerminalAppConfig config) {
    _prefs.setString(_keyTerminalApp, jsonEncode(config.toJson()));
    emit(state.copyWith(terminalApp: config));
  }

  void clearTerminalApp() {
    _prefs.remove(_keyTerminalApp);
    emit(state.copyWith(terminalApp: TerminalAppConfig.empty));
  }

  void setNewSessionTabs(List<NewSessionTab> tabs) {
    _prefs.setString(_keyNewSessionTabs, tabsToJson(tabs));
    emit(state.copyWith(newSessionTabs: tabs));
  }

  void setShowHiddenDirectories(bool show) {
    _prefs.setBool(_keyShowHiddenDirectories, show);
    emit(state.copyWith(showHiddenDirectories: show));
  }

  void setEnabledAgentsMode(EnabledAgentsMode mode) {
    setNewSessionTabs(tabsForEnabledAgentsMode(mode, state.newSessionTabs));
  }

  void setUsageDisplayMode(UsageDisplayMode mode) {
    _prefs.setString(_keyUsageDisplayMode, mode.name);
    emit(state.copyWith(usageDisplayMode: mode));
  }

  void setAutoRenameCodexSessions(bool enabled) {
    _prefs.setBool(_keyAutoRenameCodexSessions, enabled);
    emit(state.copyWith(autoRenameCodexSessions: enabled));
  }

  void setShowExtendedCodexEfforts(bool enabled) {
    _prefs.setBool(_keyShowExtendedCodexEfforts, enabled);
    emit(state.copyWith(showExtendedCodexEfforts: enabled));
  }

  void setAutoRenameClaudeSessions(bool enabled) {
    _prefs.setBool(_keyAutoRenameClaudeSessions, enabled);
    emit(state.copyWith(autoRenameClaudeSessions: enabled));
  }

  void toggleUsageDisplayMode() {
    final next = state.usageDisplayMode == UsageDisplayMode.remaining
        ? UsageDisplayMode.used
        : UsageDisplayMode.remaining;
    setUsageDisplayMode(next);
  }

  Future<void> _syncAppIcon({
    bool force = false,
    bool allowResetToDefault = false,
  }) async {
    try {
      await _appIconService.sync(
        selectedIcon: state.selectedAppIcon,
        // All app icons are freely selectable; treat the user as a supporter.
        isSupporter: true,
        force: force,
        allowResetToDefault: allowResetToDefault,
      );
    } catch (error, stackTrace) {
      logger.warning('[settings] failed to sync app icon', error, stackTrace);
    }
  }

  @override
  Future<void> close() async {
    await _bridgeSub?.cancel();
    return super.close();
  }
}