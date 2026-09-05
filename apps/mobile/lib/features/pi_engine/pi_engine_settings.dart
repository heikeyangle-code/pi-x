/// Models for pi engine settings (`get_settings` / `update_settings`,
/// docs/ENGINE-UI-SURFACES §6).
///
/// The engine keeps settings in ~/.pi/agent/settings.json as an opaque map.
/// This class exposes the documented core keys (1:1 with the pi
/// `Settings` interface in coding-agent/src/core/settings-manager.ts) as
/// typed accessors, and can build a minimal merge patch from the form state
/// so untouched keys are never clobbered.
class PiEngineSettings {
  PiEngineSettings(this._data);

  /// Factory for JSON maps coming from the bridge (`get_settings` data).
  factory PiEngineSettings.fromJson(Map<String, dynamic> json) =>
      PiEngineSettings(json);

  final Map<String, dynamic> _data;

  /// The full opaque map (raw JSON fallback editor).
  Map<String, dynamic> get raw => _data;

  // ---- scalar core keys (Settings interface) ----

  String? get defaultProvider => _string('defaultProvider');
  String? get defaultModel => _string('defaultModel');
  String? get defaultThinkingLevel => _string('defaultThinkingLevel');
  String? get theme => _string('theme');
  String? get transport => _string('transport');
  String? get steeringMode => _string('steeringMode');
  String? get followUpMode => _string('followUpMode');
  String? get defaultProjectTrust => _string('defaultProjectTrust');
  String? get shellPath => _string('shellPath');
  String? get externalEditor => _string('externalEditor');
  String? get httpProxy => _string('httpProxy');

  // ---- boolean core keys ----

  bool get hideThinkingBlock => _bool('hideThinkingBlock');
  bool get showCacheMissNotices => _bool('showCacheMissNotices');
  bool get quietStartup => _bool('quietStartup');
  bool get enableSkillCommands => _bool('enableSkillCommands', fallback: true);
  bool get enableInstallTelemetry => _bool('enableInstallTelemetry', fallback: true);
  bool get enableAnalytics => _bool('enableAnalytics');
  bool get collapseChangelog => _bool('collapseChangelog');

  // ---- nested groups ----

  Map<String, dynamic>? get compaction => _map('compaction');
  Map<String, dynamic>? get retry => _map('retry');
  Map<String, dynamic>? get images => _map('images');
  Map<String, dynamic>? get terminal => _map('terminal');

  String? _string(String key) {
    final v = _data[key];
    return v is String ? v : null;
  }

  bool _bool(String key, {bool fallback = false}) {
    final v = _data[key];
    return v is bool ? v : fallback;
  }

  Map<String, dynamic>? _map(String key) {
    final v = _data[key];
    return v is Map ? Map<String, dynamic>.from(v) : null;
  }

  /// Whether a key is present in the file at all (for the JSON fallback
  /// editor, which must always round-trip the full document).
  bool contains(String key) => _data.containsKey(key);
}

/// Enum choices for pi settings fields (option values match the pi literals).
class PiEnumChoice {
  const PiEnumChoice(this.label, this.value);
  final String label;
  final String value;
}
