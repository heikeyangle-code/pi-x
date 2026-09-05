/// Models for pi package management (`list_packages` / `install_package` /
/// `remove_package` / `update_packages`, docs/ENGINE-UI-SURFACES §6.1).
///
/// 1:1 with the engine's package-manager (core/package-manager.ts): packages
/// are npm/git/local sources configured in `settings.json` `packages[]` under
/// the user (`~/.pi/agent`) and project (`.pi/`) scopes. The app only manages
/// the source list + installed artifacts; the engine owns resource discovery
/// (extensions/skills/prompts/themes) and picks changes up on its next
/// resolve, so a restart may be needed for npm/git artifact changes.
class PiPackageInfo {
  const PiPackageInfo({
    required this.source,
    required this.scope,
    required this.filtered,
    required this.type,
    this.installedPath,
    this.displayName,
    this.version,
    this.resourceTypes = const [],
  });

  factory PiPackageInfo.fromJson(Map<String, dynamic> json) {
    return PiPackageInfo(
      source: json['source'] as String? ?? '',
      scope: json['scope'] as String? ?? 'user',
      filtered: json['filtered'] == true,
      type: json['type'] as String? ?? 'local',
      installedPath: json['installedPath'] as String?,
      displayName: json['displayName'] as String?,
      version: json['version'] as String?,
      resourceTypes: (json['resourceTypes'] as List?)
              ?.whereType<String>()
              .map((e) => e)
              .toList() ??
          const [],
    );
  }

  /// Configured source string, e.g. `npm:lodash`, `https://github.com/u/r`.
  final String source;

  /// "user" (~/.pi/agent/settings.json) | "project" (.pi/settings.json)
  final String scope;

  /// True when the settings entry is an object (pattern-filtered package).
  final bool filtered;

  /// "npm" | "git" | "local"
  final String type;

  /// Absolute install dir when the artifacts are present on disk.
  final String? installedPath;

  /// package.json name at the install dir (npm/git).
  final String? displayName;

  /// package.json version at the install dir (npm/git).
  final String? version;

  /// Resource types declared in the `pi` manifest (extensions/skills/…).
  final List<String> resourceTypes;

  bool get isProject => scope == 'project';

  bool get isInstalled => installedPath != null;

  /// Short label for the list title: display name or the bare source.
  String get label => displayName?.isNotEmpty == true ? displayName! : source;

  /// npm package name without the `npm:` prefix, when applicable.
  String get npmName => type == 'npm' ? source.replaceFirst(RegExp(r'^npm:'), '') : source;

  /// Semver pinned (exact version) npm sources are fixed and skipped by update.
  bool get isPinnedNpm =>
      type == 'npm' &&
      RegExp(r'^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$')
          .hasMatch(npmName.contains('@') ? npmName.substring(npmName.indexOf('@') + 1) : '');

  @override
  bool operator ==(Object other) =>
      other is PiPackageInfo &&
      other.source == source &&
      other.scope == scope &&
      other.type == type &&
      other.installedPath == installedPath;

  @override
  int get hashCode => Object.hash(source, scope, type, installedPath);
}
