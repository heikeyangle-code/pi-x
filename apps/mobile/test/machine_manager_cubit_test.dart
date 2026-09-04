import 'dart:async';

import 'package:ccpocket/features/session_list/session_list_screen.dart';
import 'package:ccpocket/models/machine.dart';
import 'package:ccpocket/providers/machine_manager_cubit.dart';
import 'package:ccpocket/services/bridge_latest_version_service.dart';
import 'package:ccpocket/services/machine_manager_service.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'helpers/bridge_version_test_values.dart';

/// Minimal mock for MachineManagerService.
class MockMachineManagerService implements MachineManagerService {
  final _controller = StreamController<List<MachineWithStatus>>.broadcast();
  final List<String> calls = [];

  bool initShouldFail = false;
  bool checkAllHealthShouldFail = false;
  bool addMachineShouldFail = false;
  bool updateMachineShouldFail = false;
  bool deleteMachineShouldFail = false;
  List<MachineStatus> checkHealthResults = [];
  MachineStatus defaultCheckHealthResult = MachineStatus.online;
  final List<Duration> checkHealthTimeouts = [];
  List<MachineWithStatus> machineStatuses = [];

  final Map<String, Machine> _machines = {};

  @override
  Stream<List<MachineWithStatus>> get machines => _controller.stream;

  void emitMachines(List<MachineWithStatus> list) {
    _machines
      ..clear()
      ..addEntries(list.map((m) => MapEntry(m.machine.id, m.machine)));
    _controller.add(list);
  }

  @override
  Future<void> init() async {
    calls.add('init');
    if (initShouldFail) throw Exception('init failed');
  }

  @override
  Future<void> checkAllHealth() async {
    calls.add('checkAllHealth');
    if (checkAllHealthShouldFail) throw Exception('checkAllHealth failed');
  }

  @override
  Future<MachineStatus> checkHealth(
    String machineId, {
    Duration timeout = const Duration(seconds: 5),
    String? password,
    Future<String?> Function()? promptForPassword,
  }) async {
    calls.add('checkHealth:$machineId');
    checkHealthTimeouts.add(timeout);
    if (checkHealthResults.isNotEmpty) {
      return checkHealthResults.removeAt(0);
    }
    return defaultCheckHealthResult;
  }

  @override
  Future<Machine> recordConnection({
    required String host,
    required int port,
    String? apiKey,
    String? name,
    bool? useSsl,
    BridgeConnectionMode? connectionMode,
  }) async {
    calls.add('recordConnection:$host:$port');
    return Machine(
      id: 'new-id',
      host: host,
      port: port,
      name: name,
      useSsl: useSsl ?? false,
      connectionMode: connectionMode ?? BridgeConnectionMode.automatic,
    );
  }

  @override
  Future<void> addMachine(
    Machine machine, {
    String? apiKey,
    String? sshPassword,
    String? sshPrivateKey,
    String? sshJumpPassword,
    String? sshJumpPrivateKey,
  }) async {
    calls.add('addMachine:${machine.id}');
    if (addMachineShouldFail) throw Exception('addMachine failed');
    _machines[machine.id] = machine;
  }

  @override
  Future<void> updateMachine(
    Machine machine, {
    String? apiKey,
    String? sshPassword,
    String? sshPrivateKey,
    String? sshJumpPassword,
    String? sshJumpPrivateKey,
    bool clearApiKey = false,
    bool clearCredentials = false,
    bool clearJumpCredentials = false,
  }) async {
    calls.add('updateMachine:${machine.id}');
    if (updateMachineShouldFail) throw Exception('updateMachine failed');
    _machines[machine.id] = machine;
  }

  @override
  Future<void> deleteMachine(String id) async {
    calls.add('deleteMachine:$id');
    if (deleteMachineShouldFail) throw Exception('deleteMachine failed');
    _machines.remove(id);
  }

  @override
  Future<void> toggleFavorite(String machineId) async {
    calls.add('toggleFavorite:$machineId');
  }

  @override
  Machine? getMachine(String id) => _machines[id];

  @override
  Future<String?> getApiKey(String machineId) async => null;

  @override
  Future<String?> getSshPassword(String machineId) async => null;

  @override
  Future<String?> getSshPrivateKey(String machineId) async => null;

  @override
  Future<String?> getSshJumpPassword(String machineId) async => null;

  @override
  Future<String?> getSshJumpPrivateKey(String machineId) async => null;

  @override
  Future<String> buildWsUrl(String machineId) async => 'ws://mock:8765';

  @override
  Future<String> buildWsUrlWithSshCredentials(
    String machineId, {
    String? password,
    Future<String?> Function()? promptForPassword,
  }) async => 'ws://mock:8765';

  @override
  void configureBridgeTunnelResolvers({
    BridgeWsUrlResolver? wsUrlResolver,
    BridgeHttpBaseUrlResolver? httpBaseUrlResolver,
  }) {}

  @override
  Machine createNew({
    String? name,
    required String host,
    int port = 8765,
    bool useSsl = false,
  }) {
    return Machine(
      id: 'gen-id',
      name: name,
      host: host,
      port: port,
      useSsl: useSsl,
    );
  }

  @override
  void startPeriodicHealthCheck({Duration? interval}) {
    calls.add('startPeriodicHealthCheck');
  }

  @override
  void stopPeriodicHealthCheck() {
    calls.add('stopPeriodicHealthCheck');
  }

  @override
  List<Machine> get currentMachines => _machines.values.toList();

  @override
  List<MachineWithStatus> get machinesWithStatus {
    if (machineStatuses.isNotEmpty) return machineStatuses;
    return _machines.values.map((m) => MachineWithStatus(machine: m)).toList();
  }

  @override
  Machine? findByHostPort(String host, int port) {
    for (final machine in _machines.values) {
      if (machine.host == host && machine.port == port) return machine;
    }
    return null;
  }

  @override
  void dispose() {
    _controller.close();
  }
}

void main() {
  late MockMachineManagerService mockService;

  setUp(() {
    mockService = MockMachineManagerService();
  });

  tearDown(() {
    mockService.dispose();
  });

  MachineManagerCubit createCubit({
    String? latestBridgeVersion,
    BridgeLatestVersionService? latestVersionService,
  }) {
    return MachineManagerCubit(
      mockService,
      latestVersionService:
          latestVersionService ??
          BridgeLatestVersionService(
            httpClient: MockClient(
              (_) async => http.Response(
                '{"version":"${latestBridgeVersion ?? recommendedBridgeVersion}"}',
                200,
              ),
            ),
          ),
    );
  }

  group('MachineManagerCubit - initial state', () {
    test('has default empty state', () {
      final cubit = createCubit();
      addTearDown(cubit.close);

      expect(cubit.state.machines, isEmpty);
      // isLoading is true because the constructor calls init() which sets it
      expect(cubit.state.isLoading, true);
      expect(cubit.state.error, isNull);
      expect(cubit.state.startingMachineId, isNull);
      expect(cubit.state.updatingMachineId, isNull);
      expect(cubit.state.successMessage, isNull);
    });

    test('calls init on creation', () async {
      final cubit = createCubit();
      addTearDown(cubit.close);
      await Future.microtask(() {});

      expect(mockService.calls, contains('init'));
    });
  });

  group('MachineManagerCubit - stream updates', () {
    test('updates machines from service stream', () async {
      final cubit = createCubit();
      addTearDown(cubit.close);
      await Future.microtask(() {});

      final machine = Machine(id: 'm1', host: '192.168.1.1', port: 8765);
      mockService.emitMachines([MachineWithStatus(machine: machine)]);
      await Future.microtask(() {});

      expect(cubit.state.machines, hasLength(1));
      expect(cubit.state.machines.first.machine.id, 'm1');
      expect(cubit.state.isLoading, false);
    });
  });

  group('MachineManagerCubit - init', () {
    test('sets error on init failure', () async {
      mockService.initShouldFail = true;
      final cubit = createCubit();
      addTearDown(cubit.close);

      // Wait for the auto-init to complete
      await Future.delayed(const Duration(milliseconds: 50));

      expect(cubit.state.error, contains('init failed'));
      expect(cubit.state.isLoading, false);
    });

    test('waitUntilLoaded waits for machine stream update', () async {
      final cubit = createCubit();
      addTearDown(cubit.close);

      var completed = false;
      final wait = cubit
          .waitUntilLoaded(timeout: const Duration(milliseconds: 200))
          .then((_) => completed = true);
      await Future<void>.delayed(Duration.zero);

      expect(completed, false);

      mockService.emitMachines([
        MachineWithStatus(
          machine: Machine(id: 'm1', host: '10.0.0.1', port: 8765),
        ),
      ]);
      await wait;

      expect(completed, true);
      expect(cubit.state.isLoading, false);
    });

    test('auto-connect machine lookup waits for loaded machines', () async {
      final cubit = createCubit();
      addTearDown(cubit.close);

      final lookup = findAutoConnectMachine(
        cubit,
        Uri.parse('ws://10.0.0.1:8765'),
        loadTimeout: const Duration(milliseconds: 200),
      );
      await Future<void>.delayed(Duration.zero);

      mockService.emitMachines([
        MachineWithStatus(
          machine: Machine(id: 'm1', host: '10.0.0.1', port: 8765),
        ),
      ]);

      final machine = await lookup;

      expect(machine?.id, 'm1');
    });
  });

  group('MachineManagerCubit - refreshAll', () {
    test('calls checkAllHealth', () async {
      final cubit = createCubit();
      addTearDown(cubit.close);
      await Future.microtask(() {});

      mockService.calls.clear();
      await cubit.refreshAll();

      expect(mockService.calls, contains('checkAllHealth'));
    });

    test('sets error on failure', () async {
      final cubit = createCubit();
      addTearDown(cubit.close);
      await Future.microtask(() {});

      mockService.checkAllHealthShouldFail = true;
      await cubit.refreshAll();

      expect(cubit.state.error, contains('checkAllHealth failed'));
    });
  });

  group('MachineManagerCubit - addMachine', () {
    test('adds machine successfully', () async {
      final cubit = createCubit();
      addTearDown(cubit.close);
      await Future.microtask(() {});

      final machine = Machine(id: 'm1', host: '10.0.0.1', port: 8765);
      await cubit.addMachine(machine);

      expect(cubit.state.successMessage, 'Machine added successfully');
      expect(cubit.state.error, isNull);
      expect(mockService.calls, contains('addMachine:m1'));
    });

    test('sets error on failure', () async {
      final cubit = createCubit();
      addTearDown(cubit.close);
      await Future.microtask(() {});

      mockService.addMachineShouldFail = true;
      final machine = Machine(id: 'm1', host: '10.0.0.1', port: 8765);
      await cubit.addMachine(machine);

      expect(cubit.state.error, contains('addMachine failed'));
      expect(cubit.state.successMessage, isNull);
    });
  });

  group('MachineManagerCubit - updateMachine', () {
    test('updates machine successfully', () async {
      final cubit = createCubit();
      addTearDown(cubit.close);
      await Future.microtask(() {});

      final machine = Machine(id: 'm1', host: '10.0.0.1', port: 8765);
      await cubit.updateMachine(machine);

      expect(cubit.state.successMessage, 'Machine updated successfully');
      expect(cubit.state.error, isNull);
    });

    test('sets error on failure', () async {
      final cubit = createCubit();
      addTearDown(cubit.close);
      await Future.microtask(() {});

      mockService.updateMachineShouldFail = true;
      final machine = Machine(id: 'm1', host: '10.0.0.1', port: 8765);
      await cubit.updateMachine(machine);

      expect(cubit.state.error, contains('updateMachine failed'));
    });
  });

  group('MachineManagerCubit - deleteMachine', () {
    test('deletes machine successfully', () async {
      final cubit = createCubit();
      addTearDown(cubit.close);
      await Future.microtask(() {});

      await cubit.deleteMachine('m1');

      expect(cubit.state.successMessage, 'Machine deleted');
      expect(mockService.calls, contains('deleteMachine:m1'));
    });

    test('sets error on failure', () async {
      final cubit = createCubit();
      addTearDown(cubit.close);
      await Future.microtask(() {});

      mockService.deleteMachineShouldFail = true;
      await cubit.deleteMachine('m1');

      expect(cubit.state.error, contains('deleteMachine failed'));
    });
  });

  group('MachineManagerCubit - clearMessages', () {
    test('clears error and success message', () async {
      final cubit = createCubit();
      addTearDown(cubit.close);
      await Future.microtask(() {});

      // Create an error state
      mockService.addMachineShouldFail = true;
      await cubit.addMachine(Machine(id: 'm1', host: '10.0.0.1', port: 8765));
      expect(cubit.state.error, isNotNull);

      cubit.clearMessages();

      expect(cubit.state.error, isNull);
      expect(cubit.state.successMessage, isNull);
    });
  });

  group('MachineManagerCubit - latest Bridge version auto refresh', () {
    test('skips automatic refresh while cache is fresh', () async {
      var calls = 0;
      final latestVersionService = BridgeLatestVersionService(
        httpClient: MockClient((_) async {
          calls++;
          return http.Response('{"version":"$recommendedBridgeVersion"}', 200);
        }),
      );
      final cubit = createCubit(latestVersionService: latestVersionService);
      addTearDown(cubit.close);
      await Future.microtask(() {});

      await cubit.refreshLatestBridgeVersionIfStale();
      await cubit.refreshLatestBridgeVersionIfStale();

      expect(calls, 1);
      expect(cubit.state.latestBridgeVersion, recommendedBridgeVersion);
    });

    test('deduplicates overlapping automatic refresh requests', () async {
      var calls = 0;
      final completer = Completer<http.Response>();
      final latestVersionService = BridgeLatestVersionService(
        httpClient: MockClient((_) {
          calls++;
          return completer.future;
        }),
      );
      final cubit = createCubit(latestVersionService: latestVersionService);
      addTearDown(cubit.close);
      await Future.microtask(() {});

      final first = cubit.refreshLatestBridgeVersionIfStale();
      final second = cubit.refreshLatestBridgeVersionIfStale();
      completer.complete(
        http.Response('{"version":"$recommendedBridgeVersion"}', 200),
      );
      await Future.wait([first, second]);

      expect(calls, 1);
      expect(cubit.state.latestBridgeVersion, recommendedBridgeVersion);
    });
  });

  group('MachineManagerCubit - recordConnection', () {
    test('delegates to service', () async {
      final cubit = createCubit();
      addTearDown(cubit.close);
      await Future.microtask(() {});

      final machine = await cubit.recordConnection(
        host: '10.0.0.1',
        port: 8765,
      );

      expect(machine.host, '10.0.0.1');
      expect(mockService.calls, contains('recordConnection:10.0.0.1:8765'));
    });
  });

  group('MachineManagerCubit - utility methods', () {
    test('getMachine delegates to service', () async {
      final cubit = createCubit();
      addTearDown(cubit.close);

      expect(cubit.getMachine('nonexistent'), isNull);
    });

    test('createNewMachine delegates to service', () async {
      final cubit = createCubit();
      addTearDown(cubit.close);

      final machine = cubit.createNewMachine(host: '10.0.0.1');

      expect(machine.host, '10.0.0.1');
      expect(machine.port, 8765);
    });

    test('startPeriodicHealthCheck delegates to service', () {
      final cubit = createCubit();
      addTearDown(cubit.close);

      cubit.startPeriodicHealthCheck();

      expect(mockService.calls, contains('startPeriodicHealthCheck'));
    });

    test('stopPeriodicHealthCheck delegates to service', () {
      final cubit = createCubit();
      addTearDown(cubit.close);

      cubit.stopPeriodicHealthCheck();

      expect(mockService.calls, contains('stopPeriodicHealthCheck'));
    });
  });
}
