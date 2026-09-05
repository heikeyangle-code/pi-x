/// Models for pi prompt templates (`list_prompt_templates`).
///
/// 1:1 with the official template semantics (packages/coding-agent/src/core/
/// prompt-templates.ts): a `.md` file in the global `~/.pi/agent/prompts/` or
/// project `.pi/prompts/` dir, name = file name without `.md`, description from
/// frontmatter or first body line, optional `argument-hint` frontmatter.
class PiPromptTemplate {
  const PiPromptTemplate({
    required this.name,
    required this.scope,
    this.description,
    this.argumentHint,
    this.path,
  });

  factory PiPromptTemplate.fromJson(Map<String, dynamic> json) {
    return PiPromptTemplate(
      name: json['name'] as String? ?? '',
      scope: json['scope'] as String? ?? 'global',
      description: json['description'] as String?,
      argumentHint: json['argumentHint'] as String?,
      path: json['path'] as String?,
    );
  }

  final String name;

  /// "global" | "project"
  final String scope;

  final String? description;

  /// frontmatter `argument-hint:` when present.
  final String? argumentHint;

  final String? path;

  bool get isProject => scope == 'project';

  /// Full invocation line for the chat input (trailing space for args).
  String get invocation => '/$name ';

  @override
  bool operator ==(Object other) =>
      other is PiPromptTemplate &&
      other.name == name &&
      other.scope == scope &&
      other.description == description &&
      other.argumentHint == argumentHint &&
      other.path == path;

  @override
  int get hashCode => Object.hash(name, scope, description, argumentHint, path);
}
