/// Models for pi skills discovery (`list_skills` / `read_skill`,
/// docs/ENGINE-UI-SURFACES §6.1).
///
/// Skills are Agent-skills markdown directories discovered by the engine in
/// `~/.pi/agent/skills/` (global) and `.pi/skills/` (project). The app only
/// lists them and views SKILL.md — loading/injection stays engine-side.
class PiSkill {
  const PiSkill({
    required this.name,
    required this.scope,
    this.description = '',
  });

  factory PiSkill.fromJson(Map<String, dynamic> json) {
    return PiSkill(
      name: json['name'] as String? ?? '',
      scope: json['scope'] as String? ?? 'global',
      description: json['description'] as String? ?? '',
    );
  }

  final String name;

  /// "global" (~/.pi/agent/skills) | "project" (.pi/skills)
  final String scope;

  /// First `description:` line of SKILL.md frontmatter, when present.
  final String description;

  bool get isProject => scope == 'project';

  @override
  bool operator ==(Object other) =>
      other is PiSkill &&
      other.name == name &&
      other.scope == scope &&
      other.description == description;

  @override
  int get hashCode => Object.hash(name, scope, description);
}
