import 'dart:convert';

import 'package:ccpocket/models/machine.dart';
import 'package:ccpocket/services/machine_manager_service.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _FakeSecureStorage implements FlutterSecureStorage {
  final values = <String, String>{};

  @override
  Future<void> write({
    required String key,
    required String? value,
    AppleOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    AppleOptions? mOptions,
    WindowsOptions? wOptions,
  }) async {
    if (value == null) {
      values.remove(key);
    } else {
      values[key] = value;
    }
  }

  @override
  Future<String?> read({
    required String key,
    AppleOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    AppleOptions? mOptions,
    WindowsOptions? wOptions,
  }) async => values[key];

  @override
  Future<void> delete({
    required String key,
    AppleOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    AppleOptions? mOptions,
    WindowsOptions? wOptions,
  }) async {
    values.remove(key);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  Future<MachineManagerService> createManager([
    _FakeSecureStorage? secureStorage,
  ]) async {
    final prefs = await SharedPreferences.getInstance();
    return MachineManagerService(prefs, secureStorage ?? _FakeSecureStorage());
  }

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  test(
    'recordConnection deduplicates bracket and zone escape variants',
    () async {
      final manager = await createManager();

      await manager.recordConnection(host: '[fe80::1%25en0]', port: 8765);
      await manager.recordConnection(host: 'fe80::1%en0', port: 8765);

      expect(manager.currentMachines, hasLength(1));
      expect(manager.currentMachines.single.host, 'fe80::1%en0');
      manager.dispose();
    },
  );

  test(
    'init normalizes bracketed saved host without changing machine id',
    () async {
      const saved = Machine(id: 'saved-ipv6', host: '::1');
      SharedPreferences.setMockInitialValues({
        'machines_v2': jsonEncode([saved.toJson()]),
      });
      final manager = await createManager();

      await manager.init();

      expect(manager.currentMachines.single.id, 'saved-ipv6');
      expect(manager.currentMachines.single.host, '::1');
      expect(manager.findByHostPort('[::1]', 8765)?.id, 'saved-ipv6');
      manager.dispose();
    },
  );

  test(
    'init converges multiple saved machines to the single local machine',
    () async {
      const local = Machine(id: 'local', host: '127.0.0.1', isFavorite: true);
      const remote = Machine(id: 'remote', host: '192.168.1.5');
      const otherRemote = Machine(id: 'other', host: '10.0.0.9');
      SharedPreferences.setMockInitialValues({
        'machines_v2': jsonEncode([
          remote.toJson(),
          local.toJson(),
          otherRemote.toJson(),
        ]),
      });
      final manager = await createManager();

      await manager.init();

      expect(manager.currentMachines, hasLength(1));
      expect(manager.currentMachines.single.id, 'local');
      expect(manager.currentMachines.single.host, '127.0.0.1');
      manager.dispose();
    },
  );

  test('init seeds a fresh local machine when none exists', () async {
    SharedPreferences.setMockInitialValues({});
    final manager = await createManager();

    await manager.init();

    expect(manager.currentMachines, hasLength(1));
    final machine = manager.localMachine;
    expect(machine, isNotNull);
    expect(machine!.host, '127.0.0.1');
    expect(machine.port, 8765);
    manager.dispose();
  });
}
