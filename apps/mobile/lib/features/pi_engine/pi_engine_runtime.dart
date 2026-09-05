/// Data models for the Pi engine runtime route management UI.
///
/// Mirrors the PiHost runtime surface 1:1 (docs/ENGINE-BUNDLE.md "路线切换
/// UI 落地"): three explicit routes, no auto-detection.
///   - bionic (default): pi's built-in node/tools, runs directly
///   - proroot: rootless full-Linux runtime (LD_PRELOAD, no ptrace)
///   - proot-distro: Termux proot-distro + Ubuntu LTS (ptrace fallback)
library;

/// Runtime route for the pi engine process.
///
/// The id is the wire value used by `get_runtime_status` /
/// `set_runtime_route` / `runtime_install` payloads.
enum RuntimeRoute {
  bionic('bionic'),
  proroot('proroot'),
  prootDistro('proot-distro');

  const RuntimeRoute(this.id);

  /// Wire id (`bionic` / `proroot` / `proot-distro`).
  final String id;

  static RuntimeRoute fromId(String? id) {
    switch (id) {
      case 'proroot':
        return RuntimeRoute.proroot;
      case 'proot-distro':
        return RuntimeRoute.prootDistro;
      default:
        return RuntimeRoute.bionic;
    }
  }
}

/// Runtime installation status reported by the host (`get_runtime_status`).
class RuntimeStatus {
  const RuntimeStatus({
    required this.route,
    this.prorootInstalled = false,
    this.prootDistroInstalled = false,
    this.rootfsSize,
    this.installedPackages = const [],
    this.available = const [RuntimeRoute.bionic],
  });

  /// Route the engine is currently configured to run on.
  final RuntimeRoute route;

  final bool prorootInstalled;
  final bool prootDistroInstalled;

  /// Size of the downloaded rootfs in bytes, when present.
  final int? rootfsSize;

  /// Packages installed in the active environment, when enumerable.
  final List<String> installedPackages;

  /// Routes the host can switch to (installable ones included).
  final List<RuntimeRoute> available;

  factory RuntimeStatus.fromJson(Map<String, dynamic>? json) {
    if (json == null) return const RuntimeStatus(route: RuntimeRoute.bionic);
    final rawAvailable = json['available'];
    return RuntimeStatus(
      route: RuntimeRoute.fromId(json['route'] as String?),
      prorootInstalled: json['prorootInstalled'] == true,
      prootDistroInstalled: json['prootDistroInstalled'] == true,
      rootfsSize: (json['rootfsSize'] as num?)?.toInt(),
      installedPackages:
          rawPackages(json['installedPackages']) ??
          const <String>[],
      available: rawAvailable is List
          ? rawAvailable
                .map((e) => RuntimeRoute.fromId(e as String?))
                .toList()
          : const [RuntimeRoute.bionic],
    );
  }

  /// Whether a route is ready to run on this host.
  bool isInstalled(RuntimeRoute target) {
    switch (target) {
      case RuntimeRoute.bionic:
        return true;
      case RuntimeRoute.proroot:
        return prorootInstalled;
      case RuntimeRoute.prootDistro:
        return prootDistroInstalled;
    }
  }

  /// Whether the host can switch to a route (installed or installable).
  bool isAvailable(RuntimeRoute target) => available.contains(target);
}

List<String>? rawPackages(Object? value) {
  if (value is! List) return null;
  final out = <String>[];
  for (final item in value) {
    if (item is String && item.isNotEmpty) out.add(item);
  }
  return out;
}
