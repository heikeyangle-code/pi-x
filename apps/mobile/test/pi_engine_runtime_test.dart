import 'package:flutter_test/flutter_test.dart';

import 'package:ccpocket/features/pi_engine/pi_engine_runtime.dart';

void main() {
  group('RuntimeRoute', () {
    test('fromId maps wire ids', () {
      expect(RuntimeRoute.fromId('bionic'), RuntimeRoute.bionic);
      expect(RuntimeRoute.fromId('proroot'), RuntimeRoute.proroot);
      expect(RuntimeRoute.fromId('proot-distro'), RuntimeRoute.prootDistro);
    });

    test('fromId falls back to bionic for unknown values', () {
      expect(RuntimeRoute.fromId(null), RuntimeRoute.bionic);
      expect(RuntimeRoute.fromId(''), RuntimeRoute.bionic);
      expect(RuntimeRoute.fromId('hack-route'), RuntimeRoute.bionic);
    });

    test('wire id round-trips', () {
      expect(RuntimeRoute.bionic.id, 'bionic');
      expect(RuntimeRoute.proroot.id, 'proroot');
      expect(RuntimeRoute.prootDistro.id, 'proot-distro');
    });
  });

  group('RuntimeStatus', () {
    test('fromJson parses a full status payload', () {
      final status = RuntimeStatus.fromJson({
        'route': 'proroot',
        'prorootInstalled': true,
        'prootDistroInstalled': false,
        'rootfsSize': 42 * 1024 * 1024,
        'installedPackages': ['nodejs', 'git', 'rg'],
        'available': ['bionic', 'proroot', 'proot-distro'],
      });
      expect(status.route, RuntimeRoute.proroot);
      expect(status.prorootInstalled, isTrue);
      expect(status.prootDistroInstalled, isFalse);
      expect(status.rootfsSize, 42 * 1024 * 1024);
      expect(status.installedPackages, ['nodejs', 'git', 'rg']);
      expect(status.available, [
        RuntimeRoute.bionic,
        RuntimeRoute.proroot,
        RuntimeRoute.prootDistro,
      ]);
    });

    test('fromJson tolerates a missing/minimal payload', () {
      final status = RuntimeStatus.fromJson(null);
      expect(status.route, RuntimeRoute.bionic);
      expect(status.prorootInstalled, isFalse);
      expect(status.prootDistroInstalled, isFalse);
      expect(status.rootfsSize, isNull);
      expect(status.installedPackages, isEmpty);
      expect(status.available, [RuntimeRoute.bionic]);

      final empty = RuntimeStatus.fromJson({});
      expect(empty.route, RuntimeRoute.bionic);
      expect(empty.available, [RuntimeRoute.bionic]);
    });

    test('isInstalled: bionic always ready, B routes follow flags', () {
      const status = RuntimeStatus(
        route: RuntimeRoute.bionic,
        prorootInstalled: true,
        prootDistroInstalled: false,
      );
      expect(status.isInstalled(RuntimeRoute.bionic), isTrue);
      expect(status.isInstalled(RuntimeRoute.proroot), isTrue);
      expect(status.isInstalled(RuntimeRoute.prootDistro), isFalse);
    });

    test('isAvailable reflects the host available list', () {
      const status = RuntimeStatus(
        route: RuntimeRoute.bionic,
        available: [RuntimeRoute.bionic],
      );
      expect(status.isAvailable(RuntimeRoute.bionic), isTrue);
      expect(status.isAvailable(RuntimeRoute.proroot), isFalse);
      expect(status.isAvailable(RuntimeRoute.prootDistro), isFalse);
    });

    test('rawPackages drops non-string entries', () {
      expect(rawPackages(['a', 1, 'b', null]), ['a', 'b']);
      expect(rawPackages('nope'), isNull);
      expect(rawPackages(null), isNull);
    });
  });
}
