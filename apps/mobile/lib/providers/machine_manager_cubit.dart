import 'dart:async';

import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:freezed_annotation/freezed_annotation.dart';

import '../constants/app_constants.dart';
import '../models/machine.dart';
import '../services/bridge_latest_version_service.dart';
import '../services/machine_manager_service.dart';

part 'machine_manager_cubit.freezed.dart';

/// State for the machine manager
@freezed
abstract class MachineManagerState with _$MachineManagerState {
  const factory MachineManagerState({
    /// List of machines with their current status
    @Default([]) List<MachineWithStatus> machines,

    /// Whether we're loading/refreshing
    @Default(false) bool isLoading,

    /// ID of machine currently being started
    String? startingMachineId,

    /// ID of machine currently being updated
    String? updatingMachineId,

    /// Latest Bridge version published to npm.
    String? latestBridgeVersion,

    /// Whether the latest Bridge version is being checked.
    @Default(false) bool isCheckingLatestBridgeVersion,

    /// Error message from the latest version check, if any.
    String? latestBridgeVersionError,

    /// Error message if any
    String? error,

    /// Success message if any
    String? successMessage,
  }) = _MachineManagerState;
}

/// Cubit for managing remote machines
class MachineManagerCubit extends Cubit<MachineManagerState> {
  final MachineManagerService _service;
  final BridgeLatestVersionService _latestVersionService;
  final bool _ownsLatestVersionService;

  StreamSubscription? _machinesSub;

  static const _latestBridgeVersionAutoRefreshMinInterval =
      BridgeLatestVersionService.cacheDuration;

  DateTime? _lastLatestBridgeVersionRefreshAttemptAt;

  MachineManagerCubit(
    this._service, {
    BridgeLatestVersionService? latestVersionService,
    bool refreshLatestBridgeVersionOnInit = false,
  }) : _latestVersionService =
           latestVersionService ?? BridgeLatestVersionService(),
       _ownsLatestVersionService = latestVersionService == null,
       super(const MachineManagerState()) {
    _machinesSub = _service.machines.listen((machines) {
      emit(state.copyWith(machines: machines, isLoading: false));
    });
    // Auto-init on creation
    init();
    if (refreshLatestBridgeVersionOnInit) {
      unawaited(refreshLatestBridgeVersion());
    }
  }

  /// Initialize and load machines
  Future<void> init() async {
    emit(state.copyWith(isLoading: true, error: null));
    try {
      await _service.init();
    } catch (e) {
      emit(state.copyWith(isLoading: false, error: e.toString()));
    }
  }

  /// Wait until the initial machine load has finished.
  ///
  /// Callers that need credentials from the loaded machine list during app
  /// startup should wait here before using [findByHostPort].
  Future<void> waitUntilLoaded({
    Duration timeout = const Duration(seconds: 3),
  }) async {
    if (!state.isLoading) return;
    try {
      await stream.firstWhere((s) => !s.isLoading).timeout(timeout);
    } on TimeoutException {
      // Fall back to the current state; auto-connect can still try legacy data.
    }
  }

  /// Refresh all machine statuses
  Future<void> refreshAll() async {
    emit(state.copyWith(isLoading: true, error: null));
    try {
      await _service.checkAllHealth();
    } catch (e) {
      emit(state.copyWith(isLoading: false, error: e.toString()));
    }
  }

  /// Refresh the latest Bridge version published on npm.
  Future<void> refreshLatestBridgeVersion({bool forceRefresh = false}) async {
    _lastLatestBridgeVersionRefreshAttemptAt = DateTime.now();
    emit(
      state.copyWith(
        isCheckingLatestBridgeVersion: true,
        latestBridgeVersionError: null,
      ),
    );
    try {
      final version = await _latestVersionService.fetchLatestVersion(
        forceRefresh: forceRefresh,
      );
      emit(
        state.copyWith(
          latestBridgeVersion: version,
          isCheckingLatestBridgeVersion: false,
          latestBridgeVersionError: null,
        ),
      );
    } catch (e) {
      emit(
        state.copyWith(
          isCheckingLatestBridgeVersion: false,
          latestBridgeVersionError: e.toString(),
        ),
      );
    }
  }

  /// Refresh npm latest version when the cached value is stale.
  ///
  /// This is intended for automatic UI-triggered checks, such as opening
  /// settings or pressing connect. Manual retry should use
  /// [refreshLatestBridgeVersion] with forceRefresh.
  Future<void> refreshLatestBridgeVersionIfStale() async {
    if (state.isCheckingLatestBridgeVersion) return;
    if (_latestVersionService.hasFreshCache &&
        state.latestBridgeVersion != null) {
      return;
    }

    final lastAttempt = _lastLatestBridgeVersionRefreshAttemptAt;
    if (lastAttempt != null &&
        DateTime.now().difference(lastAttempt) <
            _latestBridgeVersionAutoRefreshMinInterval) {
      return;
    }

    await refreshLatestBridgeVersion();
  }

  /// Version used to decide whether an update should be offered.
  String get bridgeUpdateTargetVersion {
    final latest = state.latestBridgeVersion;
    if (latest == null) return AppConstants.expectedBridgeVersion;
    return compareSemanticVersions(latest, AppConstants.expectedBridgeVersion) >
            0
        ? latest
        : AppConstants.expectedBridgeVersion;
  }

  bool bridgeNeedsUpdate(BridgeVersionInfo? versionInfo) {
    if (versionInfo == null) return false;
    return versionInfo.needsUpdate(bridgeUpdateTargetVersion);
  }

  /// Check health of a specific machine
  Future<void> checkHealth(String machineId) async {
    await _service.checkHealth(machineId);
  }

  /// Record a connection (auto-save on connect)
  Future<Machine> recordConnection({
    required String host,
    required int port,
    String? apiKey,
    String? name,
    bool? useSsl,
    BridgeConnectionMode? connectionMode,
  }) async {
    return await _service.recordConnection(
      host: host,
      port: port,
      apiKey: apiKey,
      name: name,
      useSsl: useSsl,
      connectionMode: connectionMode,
    );
  }

  /// Get a machine by ID
  Machine? getMachine(String id) => _service.getMachine(id);

  /// Find a machine by host and port.
  Machine? findByHostPort(String host, int port) =>
      _service.findByHostPort(host, port);

  /// Get API key for a machine
  Future<String?> getApiKey(String machineId) => _service.getApiKey(machineId);

  /// Build WebSocket URL with API key
  Future<String> buildWsUrl(String machineId) => _service.buildWsUrl(machineId);

  /// Start periodic health check
  void startPeriodicHealthCheck() {
    _service.startPeriodicHealthCheck();
  }

  /// Stop periodic health check
  void stopPeriodicHealthCheck() {
    _service.stopPeriodicHealthCheck();
  }

  /// Clear any error or success message
  void clearMessages() {
    emit(state.copyWith(error: null, successMessage: null));
  }

  @override
  Future<void> close() {
    _machinesSub?.cancel();
    if (_ownsLatestVersionService) {
      _latestVersionService.dispose();
    }
    return super.close();
  }
}
