/// Models for the pi engine command palette (`get_commands`, pi docs/rpc.md).
///
/// Commands expand engine-side: the app only lists them and pastes `/name`
/// into the chat input. Grouped by source (extension / prompt / skill).
///
/// Field-for-field compatible with the official `get_commands` response
/// (packages/coding-agent/docs/rpc.md): `name`, `description`, `source`,
/// optional `location` ("user" | "project" | "path", present for prompt/skill
/// commands) and optional `path` (absolute file path of the command source).
class PiCommand {
  const PiCommand({
    required this.name,
    this.description = '',
    required this.source,
    this.location,
    this.path,
  });

  factory PiCommand.fromJson(Map<String, dynamic> json) {
    return PiCommand(
      name: json['name'] as String? ?? '',
      description: json['description'] as String? ?? '',
      source: json['source'] as String? ?? 'extension',
      location: json['location'] as String?,
      path: json['path'] as String?,
    );
  }

  final String name;
  final String description;

  /// "extension" | "prompt" | "skill"
  final String source;

  /// Where the command was loaded from (official rpc.md): "user"
  /// (~/.pi/agent/), "project" (.pi/), or "path" (explicit CLI/settings path).
  /// Not present for extension-registered commands.
  final String? location;

  /// Absolute file path to the command source (optional, e.g. the extension
  /// file, the prompt template .md, or the skill's SKILL.md).
  final String? path;

  /// Full invocation line for the chat input (trailing space for args).
  String get invocation => '/$name ';

  @override
  bool operator ==(Object other) =>
      other is PiCommand &&
      other.name == name &&
      other.description == description &&
      other.source == source &&
      other.location == location &&
      other.path == path;

  @override
  int get hashCode => Object.hash(name, description, source, location, path);
}
