/// Models for pi extension discovery (`list_extensions`).
///
/// 1:1 with the engine's extension discovery
/// (packages/coding-agent/src/core/extensions/loader.ts): project-local
/// `cwd/.pi/extensions/` and global `~/.pi/agent/extensions/`.
class PiExtension {
  const PiExtension({required this.name, required this.scope});

  factory PiExtension.fromJson(Map<String, dynamic> json) {
    return PiExtension(
      name: json['name'] as String? ?? '',
      scope: json['scope'] as String? ?? 'global',
    );
  }

  final String name;

  /// "global" | "project"
  final String scope;

  bool get isProject => scope == 'project';

  @override
  bool operator ==(Object other) =>
      other is PiExtension && other.name == name && other.scope == scope;

  @override
  int get hashCode => Object.hash(name, scope);
}
