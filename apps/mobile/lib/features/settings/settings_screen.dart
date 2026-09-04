import 'dart:async';

import 'package:auto_route/auto_route.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show ScrollCacheExtent;
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:share_plus/share_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../constants/app_constants.dart';
import '../../constants/feature_flags.dart';
import '../../l10n/app_localizations.dart';
import '../../models/app_icon.dart';
import '../../models/git_diff_interaction_mode.dart';
import '../../models/image_paste_shortcut.dart';
import '../../models/machine.dart';
import '../../models/new_session_tab.dart';
import '../../providers/machine_manager_cubit.dart';
import '../../router/app_router.dart';
import '../../services/bridge_service.dart';
import '../../services/machine_manager_service.dart';
import '../../services/platform_environment_service.dart';
import '../../services/prompt_history_service.dart';
import '../../utils/platform_helper.dart';
import '../../widgets/workspace_pane_chrome.dart';
import '../session_list/workspace_shell_screen.dart';
import 'code_font_settings_screen.dart';
import 'state/settings_cubit.dart';
import 'state/settings_state.dart';
import 'widgets/app_icon_bottom_sheet.dart';
import 'widgets/app_locale_bottom_sheet.dart';

import 'widgets/new_session_tabs_bottom_sheet.dart';
import 'widgets/speech_locale_bottom_sheet.dart';
import 'widgets/terminal_app_bottom_sheet.dart';
import 'widgets/theme_bottom_sheet.dart';
import 'widgets/prompt_history_section.dart';
import 'widgets/usage_section.dart';

@RoutePage()
class SettingsScreen extends StatefulWidget {
  const SettingsScreen({
    super.key,
    this.focusConnection = false,
    this.focusUsage = false,
    this.embedded = false,
    this.onBack,
  });

  final bool focusConnection;
  final bool focusUsage;
  final bool embedded;
  final VoidCallback? onBack;

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  final _scrollController = ScrollController();
  final _connectionSectionKey = GlobalKey();
  final _usageSectionKey = GlobalKey();
  Timer? _connectionHighlightTimer;
  Timer? _usageHighlightTimer;
  bool _didHandleConnectionFocus = false;
  bool _didHandleUsageFocus = false;
  bool _highlightConnectionSection = false;
  bool _highlightUsageSection = false;
  bool _isIOSAppOnMac = false;
  String _appIconDeviceName = isAndroidPlatform ? 'Android' : 'iPhone';

  void _maybeFocusConnectionSection() {
    if (!widget.focusConnection || _didHandleConnectionFocus) return;
    _didHandleConnectionFocus = true;
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!mounted) return;
      final targetContext = _connectionSectionKey.currentContext;
      if (targetContext == null || !targetContext.mounted) {
        _didHandleConnectionFocus = false;
        return;
      }
      await Scrollable.ensureVisible(
        targetContext,
        duration: const Duration(milliseconds: 350),
        curve: Curves.easeOutCubic,
        alignment: 0.0,
      );
      if (!mounted) return;

      setState(() {
        _highlightConnectionSection = true;
      });
      _connectionHighlightTimer?.cancel();
      _connectionHighlightTimer = Timer(const Duration(milliseconds: 1800), () {
        if (!mounted) return;
        setState(() {
          _highlightConnectionSection = false;
        });
      });
    });
  }

  void _maybeFocusUsageSection() {
    if (!widget.focusUsage || _didHandleUsageFocus) return;
    _didHandleUsageFocus = true;
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!mounted) return;
      final targetContext = _usageSectionKey.currentContext;
      if (targetContext == null || !targetContext.mounted) {
        _didHandleUsageFocus = false;
        return;
      }
      await Scrollable.ensureVisible(
        targetContext,
        duration: const Duration(milliseconds: 350),
        curve: Curves.easeOutCubic,
        alignment: 0.08,
      );
      if (!mounted) return;

      setState(() => _highlightUsageSection = true);
      _usageHighlightTimer?.cancel();
      _usageHighlightTimer = Timer(const Duration(milliseconds: 1800), () {
        if (!mounted) return;
        setState(() => _highlightUsageSection = false);
      });
    });
  }

  @override
  void initState() {
    super.initState();
    unawaited(_loadPlatformEnvironment());
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      unawaited(
        context.read<MachineManagerCubit>().refreshLatestBridgeVersionIfStale(),
      );
    });
  }

  Future<void> _loadPlatformEnvironment() async {
    final environment = PlatformEnvironmentService.instance;
    final isIOSAppOnMac = await environment.isIOSAppOnMac();
    final appIconDeviceName = await _resolveAppIconDeviceName(environment);
    if (!mounted) return;
    if (isIOSAppOnMac == _isIOSAppOnMac &&
        appIconDeviceName == _appIconDeviceName) {
      return;
    }
    setState(() {
      _isIOSAppOnMac = isIOSAppOnMac;
      _appIconDeviceName = appIconDeviceName;
    });
  }

  Future<String> _resolveAppIconDeviceName(
    PlatformEnvironmentService environment,
  ) async {
    if (isAndroidPlatform) return 'Android';
    if (!isIOSPlatform) return 'iPhone';

    final idiom = await environment.iosUserInterfaceIdiom();
    return idiom == 'pad' ? 'iPad' : 'iPhone';
  }

  @override
  void dispose() {
    _connectionHighlightTimer?.cancel();
    _usageHighlightTimer?.cancel();
    _scrollController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final shell = WorkspaceShellScreen.maybeOf(context);
    final chrome = resolveWorkspacePaneChrome(
      platform: Theme.of(context).platform,
      isAdaptiveWorkspace: shell != null && !shell.isSinglePane,
      isLeftPaneVisible: shell?.isLeftPaneVisible ?? false,
      slot: WorkspacePaneSlot.center,
    );
    final l = AppLocalizations.of(context);
    final bridge = context.read<BridgeService>();
    final leading = widget.onBack == null
        ? null
        : IconButton(
            key: const ValueKey('embedded_settings_back_button'),
            onPressed: widget.onBack,
            style: chrome.useMacOSAdaptiveChrome
                ? chrome.compactButtonStyle()
                : null,
            icon: const Icon(Icons.arrow_back),
            tooltip: MaterialLocalizations.of(context).backButtonTooltip,
          );

    return Scaffold(
      appBar: chrome.wrapAppBar(
        AppBar(
          toolbarHeight: chrome.toolbarHeight,
          title: chrome.wrapTitle(Text(l.settingsTitle)),
          automaticallyImplyLeading: !widget.embedded,
          leading: chrome.wrapLeading(leading),
          leadingWidth: chrome.resolveLeadingWidth(
            hasLeading: leading != null,
            baseWidth: chrome.useMacOSAdaptiveChrome
                ? kWorkspaceMacOSToolbarLeadingSlotWidth
                : kToolbarHeight,
          ),
          titleSpacing: chrome.resolveTitleSpacing(hasLeading: leading != null),
        ),
      ),
      body: BlocBuilder<SettingsCubit, SettingsState>(
        builder: (context, state) {
          final machineManagerCubit = context.watch<MachineManagerCubit>();
          final machineWithStatus = _activeMachineWithStatus(
            machineManagerCubit.state,
            state.activeMachineId,
          );
          final enabledAgentsMode = enabledAgentsModeFromTabs(
            state.newSessionTabs,
          );
          final codexEnabled = isNewSessionTabEnabled(
            state.newSessionTabs,
            NewSessionTab.codex,
          );
          final claudeEnabled = isNewSessionTabEnabled(
            state.newSessionTabs,
            NewSessionTab.claude,
          );
          final machine = machineWithStatus?.machine;
          final isConnected = state.activeMachineId != null;
          final isUpdating =
              machine != null &&
              machineManagerCubit.state.updatingMachineId == machine.id;
          return ListView(
            key: const PageStorageKey('settings_list'),
            controller: _scrollController,
            scrollCacheExtent:
                widget.focusConnection || widget.focusUsage
                ? const ScrollCacheExtent.pixels(4096)
                : null,
            children: [
              if (isConnected) ...[
                Builder(
                  builder: (context) {
                    _maybeFocusConnectionSection();
                    return const SizedBox.shrink();
                  },
                ),
                _SectionHeader(title: l.sectionConnectionAccounts),
                KeyedSubtree(
                  key: _connectionSectionKey,
                  child: AnimatedContainer(
                    duration: const Duration(milliseconds: 250),
                    curve: Curves.easeOutCubic,
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(12),
                      boxShadow: _highlightConnectionSection
                          ? [
                              BoxShadow(
                                color: cs.tertiary.withValues(alpha: 0.22),
                                blurRadius: 18,
                                offset: const Offset(0, 6),
                              ),
                            ]
                          : null,
                    ),
                    child: Card(
                      key: const ValueKey('settings_connection_section_card'),
                      margin: const EdgeInsets.symmetric(horizontal: 16),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12),
                        side: BorderSide(
                          color: _highlightConnectionSection
                              ? cs.tertiary.withValues(alpha: 0.75)
                              : Colors.transparent,
                          width: _highlightConnectionSection ? 1.5 : 0,
                        ),
                      ),
                      child: Column(
                        children: [
                          ListTile(
                            leading: Icon(
                              Icons.computer_outlined,
                              color: cs.primary,
                            ),
                            title: const Text('Bridge machine'),
                            subtitle: Text(
                              machine?.displayName ??
                                  (bridge.lastUrl ?? 'Not connected'),
                            ),
                          ),
                          Divider(
                            height: 1,
                            indent: 16,
                            endIndent: 16,
                            color: cs.outlineVariant,
                          ),
                          _BridgeUpdateStatusTile(
                            machineWithStatus: machineWithStatus,
                            isUpdating: isUpdating,
                            latestBridgeVersion:
                                machineManagerCubit.state.latestBridgeVersion,
                            isCheckingLatestBridgeVersion: machineManagerCubit
                                .state
                                .isCheckingLatestBridgeVersion,
                            latestBridgeVersionError: machineManagerCubit
                                .state
                                .latestBridgeVersionError,
                            onRefreshLatestVersion: () => machineManagerCubit
                                .refreshLatestBridgeVersion(forceRefresh: true),
                            onUpdate: null,
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
                const SizedBox(height: 8),
              ],

              // ── General ──
              _SectionHeader(title: l.sectionGeneral),
              Card(
                margin: const EdgeInsets.symmetric(horizontal: 16),
                child: Column(
                  children: [
                    if (state.appIconSupported) ...[
                      ListTile(
                        key: const ValueKey('app_icon_tile'),
                        leading: Icon(
                          Icons.apps_outlined,
                          color: cs.primary,
                        ),
                        title: Text(l.appIconTitle),
                        subtitle: Text(
                          _getAppIconSubtitle(
                            context,
                            selectedIcon: state.selectedAppIcon,
                            isSupporter: true,
                            deviceName: _appIconDeviceName,
                          ),
                        ),
                        trailing: const Icon(Icons.chevron_right, size: 20),
                        onTap: () async {
                          if (!context.mounted) return;
                          await showAppIconBottomSheet(
                            context: context,
                            current: state.selectedAppIcon,
                            isSupporter: true,
                            onChanged: (icon) => context
                                .read<SettingsCubit>()
                                .setSelectedAppIcon(icon),
                            onSupporterRequired: () {},
                          );
                        },
                      ),
                      Divider(
                        height: 1,
                        indent: 16,
                        endIndent: 16,
                        color: cs.outlineVariant,
                      ),
                    ],
                    // Theme
                    ListTile(
                      leading: Icon(Icons.palette, color: cs.primary),
                      title: Text(l.theme),
                      subtitle: Text(_getThemeLabel(context, state.themeMode)),
                      trailing: const Icon(Icons.chevron_right, size: 20),
                      onTap: () => showThemeBottomSheet(
                        context: context,
                        current: state.themeMode,
                        onChanged: (mode) =>
                            context.read<SettingsCubit>().setThemeMode(mode),
                      ),
                    ),
                    // Language
                    ListTile(
                      leading: Icon(Icons.language, color: cs.primary),
                      title: Text(l.language),
                      subtitle: Text(
                        getAppLocaleLabel(context, state.appLocaleId),
                      ),
                      trailing: const Icon(Icons.chevron_right, size: 20),
                      onTap: () => showAppLocaleBottomSheet(
                        context: context,
                        current: state.appLocaleId,
                        onChanged: (id) =>
                            context.read<SettingsCubit>().setAppLocaleId(id),
                      ),
                    ),
                    Divider(
                      height: 1,
                      indent: 16,
                      endIndent: 16,
                      color: cs.outlineVariant,
                    ),
                    // Voice Input
                    if (!state.hideVoiceInput) ...[
                      ListTile(
                        leading: Icon(
                          Icons.record_voice_over,
                          color: cs.primary,
                        ),
                        title: Text(l.voiceInput),
                        subtitle: Text(
                          getSpeechLocaleLabel(context, state.speechLocaleId),
                        ),
                        trailing: const Icon(Icons.chevron_right, size: 20),
                        onTap: () => showSpeechLocaleBottomSheet(
                          context: context,
                          current: state.speechLocaleId,
                          onChanged: (id) => context
                              .read<SettingsCubit>()
                              .setSpeechLocaleId(id),
                        ),
                      ),
                      Divider(
                        height: 1,
                        indent: 16,
                        endIndent: 16,
                        color: cs.outlineVariant,
                      ),
                    ],
                    // Hide Voice Input
                    SwitchListTile(
                      secondary: Icon(Icons.mic_off, color: cs.primary),
                      title: Text(l.hideVoiceInput),
                      subtitle: Text(l.hideVoiceInputSubtitle),
                      value: state.hideVoiceInput,
                      onChanged: (value) => context
                          .read<SettingsCubit>()
                          .setHideVoiceInput(value),
                    ),
                    Divider(
                      height: 1,
                      indent: 16,
                      endIndent: 16,
                      color: cs.outlineVariant,
                    ),
                    SwitchListTile(
                      key: const ValueKey('open_gallery_directly_toggle'),
                      secondary: Icon(
                        Icons.photo_library_outlined,
                        color: cs.primary,
                      ),
                      title: Text(l.openGalleryDirectly),
                      subtitle: Text(l.openGalleryDirectlySubtitle),
                      value: state.openGalleryDirectly,
                      onChanged: (value) => context
                          .read<SettingsCubit>()
                          .setOpenGalleryDirectly(value),
                    ),
                    Divider(
                      height: 1,
                      indent: 16,
                      endIndent: 16,
                      color: cs.outlineVariant,
                    ),
                    _TextScaleTile(
                      value: state.textScale,
                      onChanged: (value) =>
                          context.read<SettingsCubit>().setTextScale(value),
                    ),
                    Divider(
                      height: 1,
                      indent: 16,
                      endIndent: 16,
                      color: cs.outlineVariant,
                    ),
                    SwitchListTile(
                      secondary: Icon(Icons.dns_outlined, color: cs.primary),
                      title: Text(l.showBridgeNameInSessionList),
                      subtitle: Text(l.showBridgeNameInSessionListSubtitle),
                      value: state.showBridgeNameInSessionList,
                      onChanged: (value) => context
                          .read<SettingsCubit>()
                          .setShowBridgeNameInSessionList(value),
                    ),
                    if (FeatureFlags.current.isEnabled(
                      AppFeature.terminalAppIntegration,
                    )) ...[
                      Divider(
                        height: 1,
                        indent: 16,
                        endIndent: 16,
                        color: cs.outlineVariant,
                      ),
                      ListTile(
                        leading: Icon(Icons.terminal, color: cs.primary),
                        title: Row(
                          children: [
                            Text(l.terminalApp),
                            const SizedBox(width: 8),
                            Container(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 6,
                                vertical: 1,
                              ),
                              decoration: BoxDecoration(
                                color: cs.tertiaryContainer,
                                borderRadius: BorderRadius.circular(4),
                              ),
                              child: Text(
                                l.terminalAppExperimental,
                                style: TextStyle(
                                  fontSize: 10,
                                  color: cs.onTertiaryContainer,
                                ),
                              ),
                            ),
                          ],
                        ),
                        subtitle: Text(
                          state.terminalApp.isConfigured
                              ? state.terminalApp.displayName
                              : l.terminalAppNone,
                        ),
                        trailing: const Icon(Icons.chevron_right, size: 20),
                        onTap: () => showTerminalAppBottomSheet(
                          context: context,
                          current: state.terminalApp,
                          onChanged: (config) => context
                              .read<SettingsCubit>()
                              .setTerminalApp(config),
                          onClear: () =>
                              context.read<SettingsCubit>().clearTerminalApp(),
                        ),
                      ),
                    ],
                  ],
                ),
              ),
              const SizedBox(height: 8),

              _SectionHeader(title: 'AGENTS'),
              Card(
                margin: const EdgeInsets.symmetric(horizontal: 16),
                child: Column(
                  children: [
                    Padding(
                      padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
                      child: Row(
                        children: [
                          Icon(Icons.smart_toy_outlined, color: cs.primary),
                          const SizedBox(width: 16),
                          Expanded(
                            child: SegmentedButton<EnabledAgentsMode>(
                              key: const ValueKey('enabled_agents_selector'),
                              segments: const [
                                ButtonSegment(
                                  value: EnabledAgentsMode.both,
                                  label: Text('Both'),
                                ),
                                ButtonSegment(
                                  value: EnabledAgentsMode.codex,
                                  label: Text('Codex'),
                                ),
                                ButtonSegment(
                                  value: EnabledAgentsMode.claude,
                                  label: Text('Claude'),
                                ),
                              ],
                              selected: {enabledAgentsMode},
                              showSelectedIcon: false,
                              onSelectionChanged: (selection) => context
                                  .read<SettingsCubit>()
                                  .setEnabledAgentsMode(selection.single),
                            ),
                          ),
                        ],
                      ),
                    ),
                    if (enabledAgentsMode == EnabledAgentsMode.both) ...[
                      Divider(
                        height: 1,
                        indent: 16,
                        endIndent: 16,
                        color: cs.outlineVariant,
                      ),
                      ListTile(
                        leading: Icon(Icons.tab, color: cs.primary),
                        title: Text(l.settingsNewSessionTabs),
                        subtitle: Text(
                          state.newSessionTabs
                              .map((t) => t.localizedLabel(l))
                              .join(', '),
                        ),
                        trailing: const Icon(Icons.chevron_right),
                        onTap: () => showNewSessionTabsBottomSheet(
                          context: context,
                          current: state.newSessionTabs,
                          onChanged: (tabs) => context
                              .read<SettingsCubit>()
                              .setNewSessionTabs(tabs),
                        ),
                      ),
                    ],
                    Divider(
                      height: 1,
                      indent: 16,
                      endIndent: 16,
                      color: cs.outlineVariant,
                    ),
                    SwitchListTile(
                      key: const ValueKey('show_hidden_directories_toggle'),
                      secondary: Icon(
                        Icons.folder_open_outlined,
                        color: cs.primary,
                      ),
                      title: Text(l.showHiddenDirectories),
                      subtitle: Text(l.showHiddenDirectoriesSubtitle),
                      value: state.showHiddenDirectories,
                      onChanged: (value) => context
                          .read<SettingsCubit>()
                          .setShowHiddenDirectories(value),
                    ),
                    if (codexEnabled) ...[
                      Divider(
                        height: 1,
                        indent: 16,
                        endIndent: 16,
                        color: cs.outlineVariant,
                      ),
                      SwitchListTile(
                        secondary: Icon(
                          Icons.drive_file_rename_outline,
                          color: cs.primary,
                        ),
                        title: Text(l.autoRenameCodexSessions),
                        subtitle: Text(l.autoRenameCodexSessionsSubtitle),
                        value: state.autoRenameCodexSessions,
                        onChanged: (value) => context
                            .read<SettingsCubit>()
                            .setAutoRenameCodexSessions(value),
                      ),
                      Divider(
                        height: 1,
                        indent: 16,
                        endIndent: 16,
                        color: cs.outlineVariant,
                      ),
                      SwitchListTile(
                        key: const ValueKey(
                          'show_extended_codex_efforts_toggle',
                        ),
                        secondary: Icon(
                          Icons.linear_scale_rounded,
                          color: cs.primary,
                        ),
                        title: Text(l.showExtendedCodexEfforts),
                        subtitle: Text(l.showExtendedCodexEffortsSubtitle),
                        value: state.showExtendedCodexEfforts,
                        onChanged: (value) => context
                            .read<SettingsCubit>()
                            .setShowExtendedCodexEfforts(value),
                      ),
                    ],
                    if (claudeEnabled) ...[
                      Divider(
                        height: 1,
                        indent: 16,
                        endIndent: 16,
                        color: cs.outlineVariant,
                      ),
                      SwitchListTile(
                        secondary: Icon(
                          Icons.drive_file_rename_outline,
                          color: cs.primary,
                        ),
                        title: Text(l.autoRenameClaudeSessions),
                        subtitle: Text(l.autoRenameClaudeSessionsSubtitle),
                        value: state.autoRenameClaudeSessions,
                        onChanged: (value) => context
                            .read<SettingsCubit>()
                            .setAutoRenameClaudeSessions(value),
                      ),
                    ],
                  ],
                ),
              ),
              const SizedBox(height: 8),

              // ── Editor ──
              _SectionHeader(title: l.sectionEditor),
              Card(
                margin: const EdgeInsets.symmetric(horizontal: 16),
                child: Column(
                  children: [
                    Padding(
                      padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
                      child: Row(
                        children: [
                          Expanded(
                            child: Text(
                              l.indentSize,
                              style: Theme.of(context).textTheme.bodyLarge,
                            ),
                          ),
                          SegmentedButton<int>(
                            segments: const [
                              ButtonSegment(value: 1, label: Text('1')),
                              ButtonSegment(value: 2, label: Text('2')),
                              ButtonSegment(value: 3, label: Text('3')),
                              ButtonSegment(value: 4, label: Text('4')),
                            ],
                            selected: {state.indentSize},
                            onSelectionChanged: (selected) {
                              context.read<SettingsCubit>().setIndentSize(
                                selected.first,
                              );
                            },
                            showSelectedIcon: false,
                            style: ButtonStyle(
                              visualDensity: VisualDensity.compact,
                              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                            ),
                          ),
                        ],
                      ),
                    ),
                    Divider(
                      height: 1,
                      indent: 16,
                      endIndent: 16,
                      color: cs.outlineVariant,
                    ),
                    ListTile(
                      key: const ValueKey('code_font_settings_tile'),
                      leading: const Icon(Icons.font_download_outlined),
                      title: Text(l.codeFontFamily),
                      subtitle: Text(
                        '${state.codeFontFamily.label} · ${state.codeFontSize.round()}pt',
                      ),
                      trailing: const Icon(Icons.chevron_right),
                      onTap: () => Navigator.of(context).push(
                        MaterialPageRoute<void>(
                          builder: (_) => const CodeFontSettingsScreen(),
                        ),
                      ),
                    ),
                    if (isMacOSPlatform) ...[
                      Divider(
                        height: 1,
                        indent: 16,
                        endIndent: 16,
                        color: cs.outlineVariant,
                      ),
                      Padding(
                        padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            Text(
                              l.imagePasteShortcut,
                              style: Theme.of(context).textTheme.bodyLarge,
                            ),
                            const SizedBox(height: 8),
                            SegmentedButton<ImagePasteShortcut>(
                              key: const ValueKey(
                                'image_paste_shortcut_segment',
                              ),
                              segments: [
                                ButtonSegment(
                                  value: ImagePasteShortcut.ctrlV,
                                  label: Text(l.imagePasteShortcutCtrlV),
                                ),
                                ButtonSegment(
                                  value: ImagePasteShortcut.commandV,
                                  label: Text(l.imagePasteShortcutCommandV),
                                ),
                              ],
                              selected: {state.imagePasteShortcut},
                              onSelectionChanged: (selected) {
                                context
                                    .read<SettingsCubit>()
                                    .setImagePasteShortcut(selected.first);
                              },
                              showSelectedIcon: false,
                              style: ButtonStyle(
                                visualDensity: VisualDensity.compact,
                                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                              ),
                            ),
                            const SizedBox(height: 6),
                            Text(
                              _imagePasteShortcutDescription(
                                l,
                                state.imagePasteShortcut,
                              ),
                              style: Theme.of(context).textTheme.bodySmall
                                  ?.copyWith(color: cs.onSurfaceVariant),
                            ),
                          ],
                        ),
                      ),
                    ],
                    Divider(
                      height: 1,
                      indent: 16,
                      endIndent: 16,
                      color: cs.outlineVariant,
                    ),
                    Padding(
                      padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          Text(
                            l.gitDiffInteractionMode,
                            style: Theme.of(context).textTheme.bodyLarge,
                          ),
                          const SizedBox(height: 8),
                          SegmentedButton<GitDiffInteractionMode>(
                            key: const ValueKey(
                              'git_diff_interaction_mode_segment',
                            ),
                            segments: [
                              ButtonSegment(
                                value: GitDiffInteractionMode.quickActions,
                                label: Text(l.gitDiffQuickActions),
                              ),
                              ButtonSegment(
                                value: GitDiffInteractionMode.scrollFirst,
                                label: Text(l.gitDiffScrollFirst),
                              ),
                            ],
                            selected: {state.gitDiffInteractionMode},
                            onSelectionChanged: (selected) {
                              context
                                  .read<SettingsCubit>()
                                  .setGitDiffInteractionMode(selected.first);
                            },
                            showSelectedIcon: false,
                            style: ButtonStyle(
                              visualDensity: VisualDensity.compact,
                              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                            ),
                          ),
                          const SizedBox(height: 6),
                          Text(
                            _gitDiffInteractionModeDescription(
                              l,
                              state.gitDiffInteractionMode,
                            ),
                            style: Theme.of(context).textTheme.bodySmall
                                ?.copyWith(color: cs.onSurfaceVariant),
                          ),
                        ],
                      ),
                    ),
                    Divider(
                      height: 1,
                      indent: 16,
                      endIndent: 16,
                      color: cs.outlineVariant,
                    ),
                    SwitchListTile(
                      key: const ValueKey(
                        'git_diff_focus_auto_landscape_toggle',
                      ),
                      title: Text(l.gitDiffFocusAutoLandscape),
                      subtitle: Text(l.gitDiffFocusAutoLandscapeDescription),
                      value: state.gitDiffFocusAutoLandscape,
                      onChanged: context
                          .read<SettingsCubit>()
                          .setGitDiffFocusAutoLandscape,
                    ),
                    Divider(
                      height: 1,
                      indent: 16,
                      endIndent: 16,
                      color: cs.outlineVariant,
                    ),
                    SwitchListTile(
                      key: const ValueKey('remote_git_status_badge_toggle'),
                      title: Text(l.remoteGitStatusBadge),
                      subtitle: Text(l.remoteGitStatusBadgeDescription),
                      value: state.showRemoteGitStatusBadge,
                      onChanged: context
                          .read<SettingsCubit>()
                          .setShowRemoteGitStatusBadge,
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 8),

              if (bridge.isConnected) ...[
                // ── Usage ──
                Builder(
                  builder: (context) {
                    _maybeFocusUsageSection();
                    return KeyedSubtree(
                      key: _usageSectionKey,
                      child: AnimatedContainer(
                        duration: const Duration(milliseconds: 250),
                        curve: Curves.easeOutCubic,
                        decoration: BoxDecoration(
                          color: _highlightUsageSection
                              ? cs.tertiary.withValues(alpha: 0.06)
                              : Colors.transparent,
                          borderRadius: BorderRadius.circular(16),
                          border: Border.all(
                            color: _highlightUsageSection
                                ? cs.tertiary.withValues(alpha: 0.7)
                                : Colors.transparent,
                            width: 1.5,
                          ),
                        ),
                        child: UsageSection(bridgeService: bridge),
                      ),
                    );
                  },
                ),
                const SizedBox(height: 8),
              ],

              if (isConnected) ...[
                // ── Prompt History 2.0 ──
                _PromptHistorySectionSlot(bridgeService: bridge),
                const SizedBox(height: 8),
              ],

              if (isConnected) ...[
                // ── Spread ──
                _SectionHeader(title: l.sectionSpread),
                Card(
                  margin: const EdgeInsets.symmetric(horizontal: 16),
                  child: Column(
                    children: [
                      // Rate on Store (mobile only)
                      if (isMobilePlatform) ...[
                        ListTile(
                          leading: Icon(
                            Icons.rate_review_outlined,
                            color: cs.primary,
                          ),
                          title: Text(
                            isIOSPlatform
                                ? l.rateOnStore
                                : l.rateOnStoreAndroid,
                          ),
                          trailing: const Icon(Icons.open_in_new, size: 18),
                          onTap: () => launchUrl(
                            Uri.parse(
                              isIOSPlatform
                                  ? AppConstants.appStoreUrl
                                  : AppConstants.playStoreUrl,
                            ),
                            mode: LaunchMode.externalApplication,
                          ),
                        ),
                        Divider(
                          height: 1,
                          indent: 16,
                          endIndent: 16,
                          color: cs.outlineVariant,
                        ),
                      ],
                      // Share on SNS
                      ListTile(
                        leading: Icon(Icons.share, color: cs.primary),
                        title: Text(l.shareApp),
                        subtitle: Text(l.shareAppSubtitle),
                        onTap: () => SharePlus.instance.share(
                          ShareParams(text: l.shareText(AppConstants.shareUrl)),
                        ),
                      ),
                      Divider(
                        height: 1,
                        indent: 16,
                        endIndent: 16,
                        color: cs.outlineVariant,
                      ),
                      // Star on GitHub
                      ListTile(
                        leading: Icon(Icons.star_border, color: cs.primary),
                        title: Text(l.starOnGithub),
                        trailing: const Icon(Icons.open_in_new, size: 18),
                        onTap: () => launchUrl(
                          Uri.parse(AppConstants.githubUrl),
                          mode: LaunchMode.externalApplication,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 8),
              ],

              // ── About ──
              _SectionHeader(title: l.sectionAbout),
              Card(
                margin: const EdgeInsets.symmetric(horizontal: 16),
                child: Column(
                  children: [
                    // Version
                    const _VersionTile(),
                    Divider(
                      height: 1,
                      indent: 16,
                      endIndent: 16,
                      color: cs.outlineVariant,
                    ),
                    // GitHub Repository
                    ListTile(
                      leading: Icon(Icons.code, color: cs.onSurfaceVariant),
                      title: Text(l.githubRepository),
                      trailing: const Icon(Icons.open_in_new, size: 18),
                      onTap: () => launchUrl(
                        Uri.parse(AppConstants.githubUrl),
                        mode: LaunchMode.externalApplication,
                      ),
                    ),
                    Divider(
                      height: 1,
                      indent: 16,
                      endIndent: 16,
                      color: cs.outlineVariant,
                    ),
                    // Changelog
                    ListTile(
                      leading: Icon(Icons.history, color: cs.onSurfaceVariant),
                      title: Text(l.changelog),
                      trailing: const Icon(Icons.chevron_right, size: 20),
                      onTap: () => context.router.push(const ChangelogRoute()),
                    ),
                    Divider(
                      height: 1,
                      indent: 16,
                      endIndent: 16,
                      color: cs.outlineVariant,
                    ),
                    // Setup Guide
                    ListTile(
                      leading: Icon(
                        Icons.lightbulb_outline,
                        color: cs.onSurfaceVariant,
                      ),
                      title: Text(l.setupGuide),
                      subtitle: Text(l.setupGuideSubtitle),
                      trailing: const Icon(Icons.chevron_right, size: 20),
                      onTap: () => context.router.push(SetupGuideRoute()),
                    ),
                    Divider(
                      height: 1,
                      indent: 16,
                      endIndent: 16,
                      color: cs.outlineVariant,
                    ),
                    // Licenses
                    ListTile(
                      leading: Icon(
                        Icons.article_outlined,
                        color: cs.onSurfaceVariant,
                      ),
                      title: Text(l.openSourceLicenses),
                      trailing: const Icon(Icons.chevron_right, size: 20),
                      onTap: () => context.router.push(const LicensesRoute()),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 32),

              // ── Footer ──
              Center(
                child: Column(
                  children: [
                    Text(
                      'ccpocket',
                      style: Theme.of(context).textTheme.titleSmall
                          ?.copyWith(color: cs.onSurfaceVariant),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      '\u00a9 2026 K9i',
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: cs.onSurfaceVariant.withValues(alpha: 0.6),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 32),
            ],
          );
        },
      ),
    );
  }

  static String _getThemeLabel(BuildContext context, ThemeMode mode) {
    final l = AppLocalizations.of(context);
    switch (mode) {
      case ThemeMode.system:
        return l.themeSystem;
      case ThemeMode.light:
        return l.themeLight;
      case ThemeMode.dark:
        return l.themeDark;
    }
  }

  static String _getAppIconSubtitle(
    BuildContext context, {
    required AppIconVariant selectedIcon,
    required bool isSupporter,
    required String deviceName,
  }) {
    final l = AppLocalizations.of(context);
    if (!isSupporter) {
      return l.appIconSettingsSubtitle(deviceName);
    }
    return switch (selectedIcon) {
      AppIconVariant.defaultIcon => l.appIconOptionDefaultTitle,
      AppIconVariant.lightOutline => l.appIconOptionLightOutlineTitle,
      AppIconVariant.proCopperEmerald => l.appIconOptionCopperEmeraldTitle,
    };
  }

  MachineWithStatus? _activeMachineWithStatus(
    MachineManagerState machineState,
    String? activeMachineId,
  ) {
    if (activeMachineId == null) return null;
    for (final item in machineState.machines) {
      if (item.machine.id == activeMachineId) {
        return item;
      }
    }
    return null;
  }
}

String _gitDiffInteractionModeDescription(
  AppLocalizations l,
  GitDiffInteractionMode mode,
) {
  return switch (mode) {
    GitDiffInteractionMode.quickActions => l.gitDiffQuickActionsDescription,
    GitDiffInteractionMode.scrollFirst => l.gitDiffScrollFirstDescription,
  };
}

String _imagePasteShortcutDescription(
  AppLocalizations l,
  ImagePasteShortcut shortcut,
) {
  return switch (shortcut) {
    ImagePasteShortcut.ctrlV => l.imagePasteShortcutCtrlVDescription,
    ImagePasteShortcut.commandV => l.imagePasteShortcutCommandVDescription,
  };
}

class _SectionHeader extends StatelessWidget {
  final String title;
  const _SectionHeader({required this.title});

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 24, 16, 8),
      child: Text(
        title,
        style: TextStyle(
          fontSize: 12,
          fontWeight: FontWeight.w600,
          letterSpacing: 0.8,
          color: cs.onSurfaceVariant,
        ),
      ),
    );
  }
}

class _BridgeUpdateStatusTile extends StatelessWidget {
  final MachineWithStatus? machineWithStatus;
  final bool isUpdating;
  final String? latestBridgeVersion;
  final bool isCheckingLatestBridgeVersion;
  final String? latestBridgeVersionError;
  final VoidCallback? onRefreshLatestVersion;
  final VoidCallback? onUpdate;

  const _BridgeUpdateStatusTile({
    required this.machineWithStatus,
    required this.isUpdating,
    this.latestBridgeVersion,
    this.isCheckingLatestBridgeVersion = false,
    this.latestBridgeVersionError,
    this.onRefreshLatestVersion,
    this.onUpdate,
  });

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final cs = Theme.of(context).colorScheme;
    final expectedVersion = AppConstants.expectedBridgeVersion;
    final updateTargetVersion =
        latestBridgeVersion != null &&
            compareSemanticVersions(latestBridgeVersion!, expectedVersion) > 0
        ? latestBridgeVersion!
        : expectedVersion;
    final versionInfo = machineWithStatus?.versionInfo;
    final isOnline = machineWithStatus?.status == MachineStatus.online;
    final latestCheckFailed =
        latestBridgeVersion == null && latestBridgeVersionError != null;
    final bridgeNeedsUpdate =
        isOnline &&
        versionInfo != null &&
        versionInfo.needsUpdate(updateTargetVersion);
    final isKnownUpToDate =
        versionInfo != null &&
        !bridgeNeedsUpdate &&
        !isCheckingLatestBridgeVersion &&
        !latestCheckFailed;

    final title = bridgeNeedsUpdate
        ? l.bridgeUpdateAvailable
        : latestCheckFailed
        ? l.bridgeLatestVersionUnavailable
        : isKnownUpToDate
        ? l.bridgeIsUpToDate
        : l.updateBridge;
    final subtitle = isCheckingLatestBridgeVersion
        ? l.bridgeLatestVersionChecking
        : versionInfo == null
        ? l.bridgeVersionUnknown
        : latestBridgeVersion != null
        ? l.bridgeVersionCurrentLatest(versionInfo.version, updateTargetVersion)
        : l.bridgeVersionCurrentExpected(versionInfo.version, expectedVersion);
    final icon = bridgeNeedsUpdate
        ? Icons.system_update
        : latestCheckFailed
        ? Icons.warning_amber_outlined
        : isKnownUpToDate
        ? Icons.check_circle_outline
        : Icons.info_outline;
    final iconColor = bridgeNeedsUpdate
        ? cs.tertiary
        : latestCheckFailed
        ? cs.error
        : isKnownUpToDate
        ? cs.primary
        : cs.onSurfaceVariant;

    return ListTile(
      leading: Icon(icon, color: iconColor),
      title: Text(title),
      subtitle: Text(subtitle),
      onTap: onRefreshLatestVersion,
      trailing: isUpdating
          ? const SizedBox(
              width: 20,
              height: 20,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          : isCheckingLatestBridgeVersion
          ? const SizedBox(
              width: 20,
              height: 20,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          : bridgeNeedsUpdate && onUpdate != null
          ? FilledButton.tonalIcon(
              key: const ValueKey('settings_update_bridge_button'),
              onPressed: onUpdate,
              icon: const Icon(Icons.system_update, size: 18),
              label: Text(l.update),
            )
          : latestCheckFailed
          ? IconButton(
              key: const ValueKey('settings_bridge_latest_retry_button'),
              onPressed: onRefreshLatestVersion,
              icon: const Icon(Icons.refresh),
              tooltip: l.bridgeLatestVersionRetry,
            )
          : null,
    );
  }
}

class _TextScaleTile extends StatelessWidget {
  const _TextScaleTile({required this.value, required this.onChanged});

  final double value;
  final ValueChanged<double> onChanged;

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final l = AppLocalizations.of(context);
    final percent = _formatPercent(value);

    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Icon(Icons.format_size, color: cs.primary),
              ),
              const SizedBox(width: 16),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(child: Text(l.textDensity)),
                        Text(
                          percent,
                          key: const ValueKey('text_scale_value_label'),
                          style: Theme.of(context).textTheme.bodyMedium
                              ?.copyWith(
                                color: cs.primary,
                                fontWeight: FontWeight.w600,
                              ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 4),
                    Text(
                      l.textDensityDescription,
                      style: Theme.of(context).textTheme.bodySmall
                          ?.copyWith(color: cs.onSurfaceVariant),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Slider(
            key: const ValueKey('text_scale_slider'),
            value: value,
            min: SettingsCubit.minTextScale,
            max: SettingsCubit.maxTextScale,
            divisions:
                ((SettingsCubit.maxTextScale - SettingsCubit.minTextScale) *
                        100)
                    .round(),
            label: percent,
            onChanged: onChanged,
          ),
        ],
      ),
    );
  }

  String _formatPercent(double scale) => '${(scale * 100).round()}%';
}

class _VersionTile extends StatefulWidget {
  const _VersionTile();

  @override
  State<_VersionTile> createState() => _VersionTileState();
}

class _VersionTileState extends State<_VersionTile> {
  String? _versionText;

  @override
  void initState() {
    super.initState();
    _loadVersion();
  }

  Future<void> _loadVersion() async {
    final info = await PackageInfo.fromPlatform();
    final version = '${info.version}+${info.buildNumber}';

    if (mounted) {
      setState(() => _versionText = version);
    }
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final l = AppLocalizations.of(context);

    return ListTile(
      leading: Icon(Icons.info_outline, color: cs.onSurfaceVariant),
      title: Text(l.version),
      subtitle: Text(_versionText != null ? _versionText! : l.loading),
    );
  }
}

class _PromptHistorySectionSlot extends StatelessWidget {
  const _PromptHistorySectionSlot({required this.bridgeService});

  final BridgeService bridgeService;

  @override
  Widget build(BuildContext context) {
    final promptHistoryService = _readOptional<PromptHistoryService>(context);
    final machineManagerService = _readOptional<MachineManagerService>(context);

    if (promptHistoryService == null || machineManagerService == null) {
      return const SizedBox.shrink();
    }

    return Column(
      children: [
        PromptHistorySection(
          bridgeService: bridgeService,
          promptHistoryService: promptHistoryService,
          machineManagerService: machineManagerService,
        ),
        const SizedBox(height: 8),
      ],
    );
  }

  T? _readOptional<T>(BuildContext context) {
    try {
      return context.read<T>();
    } on ProviderNotFoundException {
      return null;
    }
  }
}
