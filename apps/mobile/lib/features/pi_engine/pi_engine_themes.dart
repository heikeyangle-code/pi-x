/// Models for pi theme management (`list_themes` / `select_theme` /
/// `import_theme` / `remove_theme`, docs/ENGINE-UI-SURFACES §6.1).
///
/// 1:1 with pi `theme.ts` getAvailableThemesWithPaths: built-in themes are the
/// engine's packaged dark/light palettes; custom themes are `*.json` files
/// under `~/.pi/agent/themes/` whose JSON declares a `name` string and a
/// `colors` object. The entry marked selected mirrors `settings.theme`.
class PiThemeInfo {
  const PiThemeInfo({
    required this.name,
    required this.builtin,
    required this.selected,
    this.path,
  });

  factory PiThemeInfo.fromJson(Map<String, dynamic> json) {
    return PiThemeInfo(
      name: json['name'] as String? ?? '',
      builtin: json['builtin'] == true,
      selected: json['selected'] == true,
      path: json['path'] as String?,
    );
  }

  /// Theme name (built-in palette name or the custom JSON's declared name).
  final String name;

  /// True for the engine's packaged dark/light palettes.
  final bool builtin;

  /// True when this theme matches `settings.theme`.
  final bool selected;

  /// Absolute file path for custom themes; null for built-ins.
  final String? path;
}
