/// Data models for the Pi engine management UI.
///
/// These mirror the pi 0.85.x file/settings contract 1:1 (docs/ENGINE-UI-
/// SURFACES.md §6) so the app never keeps a second source of truth:
///   - engineArgs live in ~/.pi/agent/pix-config.json (PiHost pix-config)
///   - providers/models live in ~/.pi/agent/models.json
///   - system prompt overrides live in SYSTEM.md / APPEND_SYSTEM.md
library;

/// Pi X app-controlled engine launch options (~/.pi/agent/pix-config.json).
class PixEngineConfig {
  const PixEngineConfig({this.engineArgs = const []});

  final List<String> engineArgs;

  factory PixEngineConfig.fromJson(Map<String, dynamic>? json) {
    final raw = json?['engineArgs'];
    return PixEngineConfig(
      engineArgs: raw is List
          ? raw.whereType<String>().toList()
          : const <String>[],
    );
  }

  Map<String, dynamic> toJson() => {'engineArgs': engineArgs};

  PixEngineConfig copyWith({List<String>? engineArgs}) {
    return PixEngineConfig(engineArgs: engineArgs ?? this.engineArgs);
  }
}

/// One documented pi CLI launch switch the app exposes as a toggle/input.
class EngineFlagSpec {
  const EngineFlagSpec({
    required this.long,
    this.short,
    required this.descriptionKey,
    this.takesValue = false,
    this.defaultOff = true,
  });

  /// `--no-context-files` style long flag.
  final String long;

  /// Short alias (`-nc`), when pi documents one.
  final String? short;

  /// L10n key describing what this flag disables/enables.
  final String descriptionKey;

  /// Whether the flag consumes a value (e.g. `--tools <list>`).
  final bool takesValue;

  /// true = enabled means "turn off a capability" (a `--no-*` flag).
  final bool defaultOff;

  String get flagText => takesValue ? '$long <value>' : long;
}

/// Engine launch toggles surfaced in the UI. Derived from pi 0.85.x CLI
/// surface (docs/ENGINE-UI-SURFACES.md §6.3) and verified against the bundled
/// `pi --help`/RPC surface in CI smoke.
const List<EngineFlagSpec> kEngineFlags = [
  EngineFlagSpec(
    long: '--no-context-files',
    short: '-nc',
    descriptionKey: 'piEngineFlagNoContextFiles',
  ),
  EngineFlagSpec(
    long: '--no-skills',
    short: '-ns',
    descriptionKey: 'piEngineFlagNoSkills',
  ),
  EngineFlagSpec(
    long: '--no-prompt-templates',
    short: '-np',
    descriptionKey: 'piEngineFlagNoPromptTemplates',
  ),
  EngineFlagSpec(
    long: '--no-themes',
    descriptionKey: 'piEngineFlagNoThemes',
  ),
  EngineFlagSpec(
    long: '--no-extensions',
    short: '-ne',
    descriptionKey: 'piEngineFlagNoExtensions',
  ),
  EngineFlagSpec(
    long: '--no-tools',
    short: '-nt',
    descriptionKey: 'piEngineFlagNoTools',
  ),
  EngineFlagSpec(
    long: '--no-builtin-tools',
    short: '-nbt',
    descriptionKey: 'piEngineFlagNoBuiltinTools',
  ),
];

/// Value-carrying launch switches (text input in the UI).
const List<EngineFlagSpec> kEngineFlagValues = [
  EngineFlagSpec(
    long: '--tools',
    descriptionKey: 'piEngineFlagTools',
    takesValue: true,
    defaultOff: false,
  ),
  EngineFlagSpec(
    long: '--exclude-tools',
    descriptionKey: 'piEngineFlagExcludeTools',
    takesValue: true,
    defaultOff: false,
  ),
  EngineFlagSpec(
    long: '--use-theme',
    descriptionKey: 'piEngineFlagUseTheme',
    takesValue: true,
    defaultOff: false,
  ),
];

/// Split existing engineArgs into toggle flags / value flags / leftovers.
class EngineArgsParse {
  const EngineArgsParse({
    required this.toggles,
    required this.values,
    required this.other,
  });

  /// long flag -> enabled.
  final Map<String, bool> toggles;

  /// long flag -> value.
  final Map<String, String> values;

  /// Args we do not manage (kept verbatim on update).
  final List<String> other;
}

/// Parse engineArgs against the known flag specs. Value flags consume their
/// next token; unknown `--x` flags are kept as `other`.
EngineArgsParse parseEngineArgs(List<String> args, {
  List<EngineFlagSpec> flags = kEngineFlags,
  List<EngineFlagSpec> valueFlags = kEngineFlagValues,
}) {
  final toggles = <String, bool>{};
  final values = <String, String>{};
  final other = <String>[];
  final valueLongs = {for (final f in valueFlags) f.long};
  final toggleLongs = {for (final f in flags) f.long};
  final aliasToLong = <String, String>{
    for (final f in [...flags, ...valueFlags])
      if (f.short != null) f.short!: f.long,
  };

  for (var i = 0; i < args.length; i += 1) {
    final arg = args[i];
    final long = arg.startsWith('--') ? arg : aliasToLong[arg];
    if (long != null && toggleLongs.contains(long)) {
      toggles[long] = true;
      continue;
    }
    if (long != null && valueLongs.contains(long)) {
      if (i + 1 < args.length) {
        values[long] = args[i + 1];
        i += 1;
      } else {
        other.add(arg);
      }
      continue;
    }
    other.add(arg);
  }
  return EngineArgsParse(toggles: toggles, values: values, other: other);
}

/// Rebuild engineArgs from the parsed state (toggles first, then values,
/// then verbatim leftovers).
List<String> buildEngineArgs(
  Map<String, bool> toggles,
  Map<String, String> values, {
  List<String> other = const [],
  List<EngineFlagSpec> flags = kEngineFlags,
  List<EngineFlagSpec> valueFlags = kEngineFlagValues,
}) {
  final out = <String>[];
  for (final spec in flags) {
    if (toggles[spec.long] == true) out.add(spec.long);
  }
  for (final spec in valueFlags) {
    final value = values[spec.long];
    if (value != null && value.trim().isNotEmpty) {
      out.add(spec.long);
      out.add(value.trim());
    }
  }
  out.addAll(other);
  return out;
}

/// Custom provider entry in ~/.pi/agent/models.json (docs/models.md).
///
/// The UI edits the common fields (baseUrl/api/apiKey) and preserves every
/// other provider-level field pi supports (headers/compat/modelOverrides/
/// oauth/authHeader, …) verbatim in [extra], so editing through the app
/// never drops engine-side configuration.
class CustomProvider {
  const CustomProvider({
    required this.id,
    this.baseUrl,
    this.api,
    this.apiKey,
    this.models = const [],
    this.extra = const {},
  });

  final String id;
  final String? baseUrl;
  final String? api;
  final String? apiKey;
  final List<CustomModel> models;

  /// Provider-level fields the UI does not edit yet (kept verbatim).
  final Map<String, dynamic> extra;

  factory CustomProvider.fromJson(String id, Map<String, dynamic> json) {
    const known = {'baseUrl', 'api', 'apiKey', 'models'};
    final rawModels = json['models'];
    return CustomProvider(
      id: id,
      baseUrl: json['baseUrl'] as String?,
      api: json['api'] as String?,
      apiKey: json['apiKey'] as String?,
      models: rawModels is List
          ? rawModels
                .whereType<Map>()
                .map((m) => CustomModel.fromJson(m.cast<String, dynamic>()))
                .toList()
          : const [],
      extra: {
        for (final entry in json.entries)
          if (!known.contains(entry.key)) entry.key: entry.value,
      },
    );
  }

  Map<String, dynamic> toJson() {
    return {
      ...extra,
      if (baseUrl != null) 'baseUrl': baseUrl,
      if (api != null) 'api': api,
      if (apiKey != null) 'apiKey': apiKey,
      'models': models.map((m) => m.toJson()).toList(),
    };
  }
}

/// One custom model entry under a provider (docs/models.md).
///
/// The UI edits id/name/reasoning; all other model fields (api/input/
/// contextWindow/maxTokens/cost/compat/thinkingLevelMap/samplingParams, …)
/// are preserved verbatim in [extra].
class CustomModel {
  const CustomModel({
    required this.id,
    this.name,
    this.reasoning,
    this.extra = const {},
  });

  final String id;
  final String? name;
  final bool? reasoning;

  /// Model-level fields the UI does not edit yet (kept verbatim).
  final Map<String, dynamic> extra;

  factory CustomModel.fromJson(Map<String, dynamic> json) {
    const known = {'id', 'name', 'reasoning'};
    return CustomModel(
      id: json['id'] as String? ?? '',
      name: json['name'] as String?,
      reasoning: json['reasoning'] as bool?,
      extra: {
        for (final entry in json.entries)
          if (!known.contains(entry.key)) entry.key: entry.value,
      },
    );
  }

  Map<String, dynamic> toJson() => {
    ...extra,
    'id': id,
    if (name != null) 'name': name,
    if (reasoning != null) 'reasoning': reasoning,
  };
}

/// Provider API kinds pi supports for custom providers (docs/models.md).
const List<String> kProviderApis = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
];
