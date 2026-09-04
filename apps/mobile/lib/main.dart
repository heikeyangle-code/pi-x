/// ccpocket - Claude Code Mobile Client
///
/// This is the main entry point for the ccpocket Flutter application.
///
/// Key responsibilities:
/// - Initializes Marionette binding for E2E testing in debug mode
/// - Sets up global error handling
/// - Initializes core services (BridgeService, DatabaseService, NotificationService, etc.)
/// - Configures repository and Bloc providers for state management
/// - Handles deep links for connection URLs and session navigation
///
/// Note: This file has been verified for Plan Mode workflow testing.
library;

import 'dart:async';
import 'dart:convert';

import 'package:app_links/app_links.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:marionette_flutter/marionette_flutter.dart';
import 'package:media_kit/media_kit.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:talker_bloc_logger/talker_bloc_logger.dart';

import 'core/logger.dart';
import 'l10n/app_localizations.dart';
import 'features/session_list/state/session_list_cubit.dart';
import 'features/git/state/git_status_cubit.dart';
import 'features/git/state/git_view_cache_service.dart';
import 'features/settings/state/settings_cubit.dart';
import 'features/settings/state/settings_state.dart';
import 'models/messages.dart';
import 'providers/bridge_cubits.dart';
import 'providers/machine_manager_cubit.dart';
import 'router/app_router.dart';
import 'router/session_route_observer.dart';
import 'router/session_stack_navigation.dart';
import 'services/app_icon_service.dart';
import 'services/bridge_service.dart';
import 'services/database_service.dart';
import 'services/deep_link_dispatcher.dart';
import 'services/draft_service.dart';
import 'services/machine_manager_service.dart';
import 'services/mock_preview_extension.dart';
import 'services/notification_service.dart';
import 'services/performance_probe_extension.dart';
import 'services/prompt_history_service.dart';
import 'services/session_link_parser.dart';
import 'theme/app_theme.dart';
import 'services/store_screenshot_extension.dart';
import 'theme/markdown_style.dart';
import 'widgets/release_error_widget.dart';

void main() async {
  if (kDebugMode && !kIsWeb) {
    MarionetteBinding.ensureInitialized();
    registerStoreScreenshotExtensions();
    registerMockPreviewExtensions();
    registerPerformanceProbeExtensions();
  } else {
    WidgetsFlutterBinding.ensureInitialized();
  }
  MediaKit.ensureInitialized();
  Bloc.observer = TalkerBlocObserver(talker: logger);

  FlutterError.onError = (details) {
    logger.error(
      '[FlutterError] ${details.exceptionAsString()}',
      details.exception,
      details.stack,
    );
  };
  installReleaseErrorWidget();
  // Initialize notifications eagerly so the Android notification channel is
  // created before any FCM message arrives. Without this, FCM falls back to
  // the low-importance fcm_fallback_notification_channel and notifications
  // appear only in the history drawer instead of as heads-up popups.
  try {
    await NotificationService.instance.init();
  } catch (e) {
    logger.error('[main] NotificationService init failed', e);
  }
  try {
    await initializeMarkdownSyntaxHighlight();
  } catch (e) {
    logger.error('[main] syntax_highlight init failed', e);
  }

  // Initialize SharedPreferences and services
  final prefs = await SharedPreferences.getInstance();
  const secureStorage = FlutterSecureStorage();
  final machineManagerService = MachineManagerService(prefs, secureStorage);

  final bridge = BridgeService();
  final draftService = DraftService(prefs);
  StoreScreenshotState.draftService = draftService;
  final dbService = DatabaseService();
  final promptHistoryService = PromptHistoryService(dbService);
  final promptHistorySyncSub = bridge.connectionStatus.listen((state) {
    if (state == BridgeConnectionState.connected) {
      unawaited(
        promptHistoryService.syncAll(
          machineManager: machineManagerService,
          bridgeService: bridge,
        ),
      );
    }
  });
  final appIconService = AppIconService();
  final settingsCubit = SettingsCubit(
    prefs,
    bridgeService: bridge,
    machineManager: machineManagerService,
    appIconService: appIconService,
  );
  final gitStatusCubit = GitStatusCubit(
    bridge: bridge,
    remoteStatusBadgeEnabled: () =>
        settingsCubit.state.showRemoteGitStatusBadge,
  );
  final gitViewCacheService = GitViewCacheService(
    bridge: bridge,
    gitStatusCubit: gitStatusCubit,
  );
  runApp(
    MultiRepositoryProvider(
      providers: [
        RepositoryProvider.value(value: logger),
        RepositoryProvider<BridgeService>(
          create: (_) => bridge,
          lazy: false,
          dispose: (service) {
            unawaited(promptHistorySyncSub.cancel());
            service.dispose();
          },
        ),
        RepositoryProvider<GitViewCacheService>(
          create: (_) => gitViewCacheService,
          lazy: false,
          dispose: (service) => unawaited(service.dispose()),
        ),
        RepositoryProvider<DatabaseService>(
          create: (_) => dbService,
          lazy: false,
          dispose: (service) => unawaited(service.close()),
        ),
        RepositoryProvider<DraftService>.value(value: draftService),
        RepositoryProvider<PromptHistoryService>.value(
          value: promptHistoryService,
        ),
        RepositoryProvider<AppIconService>.value(value: appIconService),
        RepositoryProvider<MachineManagerService>(
          create: (_) => machineManagerService,
          lazy: false,
          dispose: (service) => service.dispose(),
        ),
      ],
      child: MultiBlocProvider(
        providers: [
          BlocProvider(
            create: (_) => ConnectionCubit(
              BridgeConnectionState.disconnected,
              bridge.connectionStatus,
            ),
          ),
          BlocProvider<GitStatusCubit>(
            create: (_) => gitStatusCubit,
            lazy: false,
          ),
          BlocProvider(
            create: (_) => ActiveSessionsCubit(const [], bridge.sessionList),
          ),
          BlocProvider(
            create: (_) =>
                RecentSessionsCubit(const [], bridge.recentSessionsStream),
          ),
          BlocProvider(
            create: (_) => GalleryCubit(const [], bridge.galleryStream),
          ),
          BlocProvider(create: (_) => FileListCubit(const [], bridge.fileList)),
          BlocProvider(
            create: (_) =>
                ProjectHistoryCubit(const [], bridge.projectHistoryStream),
          ),
          BlocProvider(
            create: (_) => WorkspaceProjectsCubit(
              bridge.projectsState,
              bridge.projectsStream,
            ),
          ),
          BlocProvider(
            create: (ctx) =>
                SessionListCubit(bridge: ctx.read<BridgeService>()),
          ),
          BlocProvider(
            create: (_) => MachineManagerCubit(
              machineManagerService,
              refreshLatestBridgeVersionOnInit: true,
            ),
          ),
          BlocProvider<SettingsCubit>(
            create: (_) => settingsCubit,
            lazy: false,
          ),
        ],
        child: CcpocketApp(),
      ),
    ),
  );
}

class CcpocketApp extends StatefulWidget {
  const CcpocketApp({super.key});

  @override
  State<CcpocketApp> createState() => _CcpocketAppState();
}

class _CcpocketAppState extends State<CcpocketApp> {
  AppLinks? _appLinks;
  StreamSubscription<Uri>? _linkSub;

  late final AppRouter _appRouter;
  late final DeepLinkDispatcher _deepLinkDispatcher;
  bool _routerInitialized = false;
  late final AppLifecycleListener _lifecycleListener;

  @override
  void initState() {
    super.initState();
    _deepLinkDispatcher = DeepLinkDispatcher(_handleUri);

    // Clear stale notifications on launch and whenever the app is resumed.
    _lifecycleListener = AppLifecycleListener(
      onStateChange: (state) {
        if (state == AppLifecycleState.resumed) {
          NotificationService.instance.cancelAll();
        }
      },
    );
    NotificationService.instance.cancelAll();

    if (!kIsWeb) {
      _appLinks = AppLinks();
      _initDeepLinks();
    }
  }

  void _initRouter() {
    if (_routerInitialized) return;
    _routerInitialized = true;
    _appRouter = AppRouter();
    StoreScreenshotState.navigatorKey = _appRouter.navigatorKey;
    // Navigate to session screen when user taps a notification
    NotificationService.instance.onNotificationTap = (payload) {
      _openSessionFromPayload(payload);
    };
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        _deepLinkDispatcher.markReady();
      }
    });
  }

  void _openSessionFromPayload(String? payload) {
    if (payload == null || payload.isEmpty) return;
    try {
      final decoded = jsonDecode(payload);
      if (decoded is Map<String, dynamic>) {
        _openSessionFromData(decoded);
        return;
      }
    } catch (_) {
      // Backward compatibility: payload may be plain sessionId text.
    }
    _openSessionFromData({'sessionId': payload, 'provider': 'claude'});
  }

  void _openSessionFromData(Map<String, dynamic> data) {
    final sessionId = data['sessionId']?.toString();
    if (sessionId == null || sessionId.isEmpty) return;
    final provider = _normalizeProvider(data['provider']?.toString());
    if (SessionStackNavigation.revealStackedSession(
      _appRouter,
      sessionId: sessionId,
      provider: provider,
    )) {
      return;
    }
    if (NotificationService.instance.isActiveSession(
      sessionId: sessionId,
      provider: provider,
    )) {
      return;
    }
    final route = SessionLinkRoute(
      key: UniqueKey(),
      sessionId: sessionId,
      provider: provider,
    );
    if (_appRouter.current.name == SessionLinkRoute.name) {
      _appRouter.replace(route);
      return;
    }
    _appRouter.push(route);
  }

  String _normalizeProvider(String? provider) {
    return provider == 'codex' ? 'codex' : 'claude';
  }

  void _initDeepLinks() {
    // app_links includes the cold-start URI as the first stream event.
    try {
      _linkSub = _appLinks!.uriLinkStream.listen(
        _deepLinkDispatcher.add,
        onError: (e) => logger.error('[deep_link] stream error', e),
      );
    } catch (e) {
      logger.error('[deep_link] uriLinkStream failed', e);
    }
  }

  void _handleUri(Uri uri) {
    final params = SessionLinkParser.parse(uri.toString());
    if (params == null) return;
    _openSessionFromData({
      'sessionId': params.sessionId,
      'provider': params.provider,
    });
  }

  @override
  void dispose() {
    _lifecycleListener.dispose();
    _linkSub?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // Initialize router on first build (needs BlocProvider context)
    _initRouter();

    return BlocBuilder<SettingsCubit, SettingsState>(
      builder: (context, settings) {
        final appLocale = settings.appLocaleId.isEmpty
            ? null
            : Locale(settings.appLocaleId);
        final themeLocale =
            appLocale ?? WidgetsBinding.instance.platformDispatcher.locale;
        updateReleaseErrorWidgetLocale(appLocale);
        return MaterialApp.router(
          title: 'CC Pocket',
          theme: AppTheme.lightThemeForLocale(themeLocale),
          darkTheme: AppTheme.darkThemeForLocale(themeLocale),
          themeMode: settings.themeMode,
          locale: appLocale,
          localizationsDelegates: AppLocalizations.localizationsDelegates,
          supportedLocales: AppLocalizations.supportedLocales,
          routerConfig: _appRouter.config(
            navigatorObservers: () => [SessionRouteObserver()],
          ),
          builder: (context, child) {
            final mediaQuery = MediaQuery.maybeOf(context);
            final app = child ?? const SizedBox.shrink();
            if (mediaQuery == null) return app;
            return MediaQuery(
              data: mediaQuery.copyWith(
                textScaler: _AppTextScaler(
                  base: mediaQuery.textScaler,
                  multiplier: settings.textScale,
                ),
              ),
              child: app,
            );
          },
          debugShowCheckedModeBanner: false,
        );
      },
    );
  }
}

class _AppTextScaler extends TextScaler {
  const _AppTextScaler({required this.base, required this.multiplier});

  final TextScaler base;
  final double multiplier;

  @override
  double scale(double fontSize) => base.scale(fontSize) * multiplier;

  @override
  // Required by TextScaler for legacy callers.
  // ignore: deprecated_member_use
  double get textScaleFactor => base.textScaleFactor * multiplier;

  @override
  bool operator ==(Object other) {
    return other is _AppTextScaler &&
        other.base == base &&
        other.multiplier == multiplier;
  }

  @override
  int get hashCode => Object.hash(base, multiplier);
}
