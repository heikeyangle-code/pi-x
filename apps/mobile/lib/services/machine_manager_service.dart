import 'dart:async';
import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../core/logger.dart';

import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:uuid/uuid.dart';

import '../models/machine.dart';
import '../utils/network_endpoint.dart';

/// Manages the single local Pi X engine machine.
///
/// Pi X is local-only: the machine manager seeds and tracks exactly one
/// on-device engine at `127.0.0.1:8765`. Multi-machine CRUD, remote SSH
/// tunnels, and endpoint probing were removed as part of single-machine
/// convergence.
class MachineManagerService {
  // New storage key for the unified Machine model
  static const _prefsKey = 'machines_v2';
  static const _secureKeyPrefix = 'machine_';
  static const _uuid = Uuid();

  final SharedPreferences _prefs;
  final FlutterSecureStorage _secureStorage;

  final _machinesController =
      StreamController<List<MachineWithStatus>>.broadcast();
  List<Machine> _machines = [];
  final Map<String, MachineStatus> _statusCache = {};
  final Map<String, DateTime> _lastChecked = {};
  final Map<String, String> _lastErrors = {};
  final Map<String, BridgeVersionInfo> _versionCache = {};
  Timer? _healthCheckTimer;

  MachineManagerService(
    this._prefs,
    this._secureStorage,
  );

  /// Stream of machines with their current status.
  Stream<List<MachineWithStatus>> get machines => _machinesController.stream;

  /// Current list of machines (always a single local machine in Pi X).
  List<Machine> get currentMachines => List.unmodifiable(_machines);

  /// Get machines with current status and version info.
  List<MachineWithStatus> get machinesWithStatus {
    return _machines.map((m) {
      return MachineWithStatus(
        machine: m,
        status: _statusCache[m.id] ?? MachineStatus.unknown,
        lastChecked: _lastChecked[m.id],
        lastError: _lastErrors[m.id],
        versionInfo: _versionCache[m.id],
      );
    }).toList();
  }

  /// The single local machine, if present.
  Machine? get localMachine => _machines.firstOrNull;

  /// Initialize the service and seed the local machine when needed.
  Future<void> init() async {
    _machines = await _loadFromPrefs();
    await _keepOnlyLocalMachine();
    _sortMachines();
    _notifyListeners();
    // Start health check after loading
    await checkAllHealth();
  }

  /// Converge to the single local machine: keep exactly one `127.0.0.1` entry.
  Future<void> _keepOnlyLocalMachine() async {
    final local = _machines.where(
      (m) =>
          normalizeHostInput(m.host) == '127.0.0.1' ||
          normalizeHostInput(m.host) == 'localhost' ||
          normalizeHostInput(m.host) == '::1',
    );
    if (local.isNotEmpty) {
      _machines = [local.first];
    } else {
      _machines = [
        Machine(
          id: _uuid.v4(),
          name: 'Pi X Local Engine',
          host: '127.0.0.1',
          port: 8765,
          useSsl: false,
          connectionMode: BridgeConnectionMode.automatic,
          hasResolvedTransport: true,
          isFavorite: true,
        ),
      ];
      await _saveToPrefs();
    }
  }

  /// Load machines from SharedPreferences.
  Future<List<Machine>> _loadFromPrefs() async {
    final raw = _prefs.getString(_prefsKey);
    if (raw == null || raw.isEmpty) return [];
    try {
      final list = jsonDecode(raw) as List;
      final result = <Machine>[];
      for (final entry in list) {
        final parsed = Machine.fromJson(entry as Map<String, dynamic>);
        result.add(
          parsed.copyWith(host: normalizeHostInput(parsed.host)),
        );
      }
      return result;
    } catch (e) {
      logger.error('[MachineManager] Failed to load machines', e);
      return [];
    }
  }

  /// Save machines to SharedPreferences.
  Future<void> _saveToPrefs() async {
    final json = jsonEncode(_machines.map((m) => m.toJson()).toList());
    await _prefs.setString(_prefsKey, json);
  }

  void _sortMachines() {
    _machines.sort((a, b) {
      if (a.isFavorite != b.isFavorite) return a.isFavorite ? -1 : 1;
      final aTime = a.lastConnected?.millisecondsSinceEpoch ?? 0;
      final bTime = b.lastConnected?.millisecondsSinceEpoch ?? 0;
      return bTime - aTime;
    });
  }

  /// Notify listeners of the updated machine list.
  void _notifyListeners() {
    _machinesController.add(machinesWithStatus);
  }

  // ---- Machine Lookup ----

  /// Find a machine by host:port.
  Machine? findByHostPort(String host, int port) {
    final normalizedHost = normalizeHostInput(host);
    final identity = endpointIdentityKey(normalizedHost, port);
    try {
      return _machines.firstWhere(
        (m) => endpointIdentityKey(m.host, m.port) == identity,
      );
    } catch (_) {
      return null;
    }
  }

  /// Get a machine by ID.
  Machine? getMachine(String id) {
    try {
      return _machines.firstWhere((m) => m.id == id);
    } catch (_) {
      return null;
    }
  }

  // ---- Auto-save on Connection ----

  /// Record a successful connection (auto-save) on the local machine.
  Future<Machine> recordConnection({
    required String host,
    required int port,
    String? apiKey,
    String? name,
    bool? useSsl,
    BridgeConnectionMode? connectionMode,
  }) async {
    final normalizedHost = normalizeHostInput(host);
    var machine = findByHostPort(normalizedHost, port);

    if (machine != null) {
      machine = machine.copyWith(
        host: normalizedHost,
        lastConnected: DateTime.now(),
        name: name ?? machine.name,
        useSsl: useSsl ?? machine.useSsl,
        connectionMode: connectionMode ?? machine.connectionMode,
      );
    } else {
      machine = Machine(
        id: _uuid.v4(),
        host: normalizedHost,
        port: port,
        name: name,
        useSsl: useSsl ?? false,
        connectionMode:
            connectionMode ??
            (useSsl == true
                ? BridgeConnectionMode.secureOnly
                : BridgeConnectionMode.automatic),
        hasResolvedTransport: useSsl == null,
        lastConnected: DateTime.now(),
      );
      _machines.add(machine);
    }

    final index = _machines.indexWhere((m) => m.id == machine!.id);
    if (index != -1) {
      _machines[index] = machine;
    }

    // Save API key if provided.
    if (apiKey != null && apiKey.isNotEmpty) {
      await _secureStorage.write(
        key: '$_secureKeyPrefix${machine.id}_api',
        value: apiKey,
      );
      machine = machine.copyWith(hasApiKey: true);
      final updatedIndex = _machines.indexWhere((m) => m.id == machine!.id);
      if (updatedIndex != -1) {
        _machines[updatedIndex] = machine;
      }
    }

    _sortMachines();
    await _saveToPrefs();
    _notifyListeners();

    return machine;
  }

  // ---- Health Check ----

  /// Check health of the local engine and fetch version info.
  Future<MachineStatus> checkHealth(
    String machineId, {
    Duration timeout = const Duration(seconds: 5),
  }) async {
    final storedMachine = getMachine(machineId);
    if (storedMachine == null) return MachineStatus.unknown;

    try {
      final response = await http
          .get(Uri.parse('${storedMachine.httpUrl}/health'))
          .timeout(timeout);

      if (response.statusCode == 200) {
        _statusCache[machineId] = MachineStatus.online;
        _lastErrors.remove(machineId);
        await _fetchVersionInfo(storedMachine);
      } else {
        _statusCache[machineId] = MachineStatus.offline;
        _lastErrors[machineId] = 'HTTP ${response.statusCode}';
        _versionCache.remove(machineId);
      }
    } on http.ClientException catch (e) {
      _statusCache[machineId] = MachineStatus.offline;
      _lastErrors[machineId] = e.message;
      _versionCache.remove(machineId);
    } on TimeoutException {
      _statusCache[machineId] = MachineStatus.unreachable;
      _lastErrors[machineId] = 'Connection timeout';
      _versionCache.remove(machineId);
    } catch (e) {
      _statusCache[machineId] = MachineStatus.offline;
      _lastErrors[machineId] = e.toString();
      _versionCache.remove(machineId);
    }

    return _finishHealthCheck(machineId);
  }

  MachineStatus _finishHealthCheck(String machineId) {
    _lastChecked[machineId] = DateTime.now();
    _notifyListeners();
    return _statusCache[machineId]!;
  }

  /// Fetch version info from the /version endpoint (optional).
  Future<void> _fetchVersionInfo(Machine machine) async {
    try {
      final response = await http
          .get(Uri.parse('${machine.httpUrl}/version'))
          .timeout(const Duration(seconds: 3));
      if (response.statusCode == 200) {
        final json = jsonDecode(response.body) as Map<String, dynamic>;
        _versionCache[machine.id] = BridgeVersionInfo.fromJson(json);
      }
    } catch (e) {
      // Version endpoint is optional, don't treat as error.
      logger.warning(
        '[MachineManager] Failed to fetch version for ${machine.id}',
        e,
      );
    }
  }

  /// Check health of all machines.
  Future<void> checkAllHealth() async {
    await Future.wait(_machines.map((m) => checkHealth(m.id)));
  }

  /// Start periodic health check.
  void startPeriodicHealthCheck({
    Duration interval = const Duration(seconds: 30),
  }) {
    stopPeriodicHealthCheck();
    _healthCheckTimer = Timer.periodic(interval, (_) => checkAllHealth());
  }

  /// Stop periodic health check.
  void stopPeriodicHealthCheck() {
    _healthCheckTimer?.cancel();
    _healthCheckTimer = null;
  }

  // ---- Secure Credential Management ----

  /// Get API key for a machine.
  Future<String?> getApiKey(String machineId) async {
    return await _secureStorage.read(key: '$_secureKeyPrefix${machineId}_api');
  }

  /// Build the WebSocket URL for a machine, appending the API key if saved.
  Future<String> buildWsUrl(String machineId) async {
    final machine = getMachine(machineId);
    if (machine == null) {
      throw ArgumentError('Machine not found: $machineId');
    }
    var url = machine.wsUrl;
    final apiKey = await getApiKey(machineId);
    if (apiKey != null && apiKey.isNotEmpty) {
      url = '$url?token=$apiKey';
    }
    return url;
  }

  /// Dispose resources.
  void dispose() {
    stopPeriodicHealthCheck();
    _machinesController.close();
  }
}