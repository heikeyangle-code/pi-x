/// Models for pi prompt templates (`list_prompt_templates` /
/// `read_prompt_template` / `write_prompt_template` / `delete_prompt_template`,
/// docs/ENGINE-UI-SURFACES §6.1).
///
/// Templates are `.md` files the engine exposes as slash commands. The app
/// lists them (grouped by scope), reads/edits their markdown, and writes back
/// through the PiHost surface ops — the engine picks changes up on the next
/// `get_commands`/prompt, so no restart is required.
class PiPromptTemplate {
  const PiPromptTemplate({
    required this.name,
    required this.scope,
    this.description = '',
    this.argumentHint,
    this.path = '',
  });

  factory PiPromptTemplate.fromJson(Map<String, dynamic> json) {
    return PiPromptTemplate(
      name: json['name'] as String? ?? '',
      scope: json['scope'] as String? ?? 'global',
      description: json['description'] as String? ?? '',
      argumentHint: json['argumentHint'] as String?,
      path: json['path'] as String? ?? '',
    );
  }

  final String name;

  /// "global" (~/.pi/agent/prompts) | "project" (.pi/prompts)
  final String scope;

  /// frontmatter `description:` or the first non-empty body line.
  final String description;

  /// frontmatter `argument-hint:` when present.
  final String? argumentHint;

  /// Absolute file path (unused for edits — writes go by name+scope).
  final String path;

  bool get isProject => scope == 'project';

  /// Slash-command invocation used in the chat input.
  String get invocation => '/${name.replaceAll(RegExp(r'\.md$'), '')}';

  @override
  bool operator ==(Object other) =>
      other is PiPromptTemplate &&
      other.name == name &&
      other.scope == scope &&
      other.description == description &&
      other.argumentHint == argumentHint;

  @override
  int get hashCode => Object.hash(name, scope, description, argumentHint);
}
