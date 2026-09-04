/// Models for the pi engine command palette (`get_commands`, pi docs/rpc.md).
///
/// Commands expand engine-side: the app only lists them and pastes `/name`
/// into the chat input. Grouped by source (extension / prompt / skill).
class PiCommand {
  const PiCommand({
    required this.name,
    this.description = '',
    required this.source,
  });

  factory PiCommand.fromJson(Map<String, dynamic> json) {
    return PiCommand(
      name: json['name'] as String? ?? '',
      description: json['description'] as String? ?? '',
      source: json['source'] as String? ?? 'extension',
    );
  }

  final String name;
  final String description;

  /// "extension" | "prompt" | "skill"
  final String source;

  /// Full invocation line for the chat input (trailing space for args).
  String get invocation => '/$name ';

  @override
  bool operator ==(Object other) =>
      other is PiCommand &&
      other.name == name &&
      other.description == description &&
      other.source == source;

  @override
  int get hashCode => Object.hash(name, description, source);
}
