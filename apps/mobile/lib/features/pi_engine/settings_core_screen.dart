import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../l10n/app_localizations.dart';
import '../../services/pi_host_service.dart';
import 'pi_engine_settings.dart';
import 'pi_engine_widgets.dart';

/// Core settings form for ~/.pi/agent/settings.json (`get_settings` /
/// `update_settings`).
///
/// The form covers the documented scalar keys of the pi `Settings` interface
/// (provider/model/thinking level, transport, modes, trust, toggles and the
/// compaction/retry/images/terminal groups). Everything else stays untouched;
/// the "Raw JSON" section at the bottom is the opaque fallback editor that
/// can round-trip the whole document for keys the form does not know about.
class EngineSettingsCoreScreen extends StatefulWidget {
  const EngineSettingsCoreScreen({super.key});

  @override
  State<EngineSettingsCoreScreen> createState() =>
      _EngineSettingsCoreScreenState();
}

class _EngineSettingsCoreScreenState extends State<EngineSettingsCoreScreen> {
  bool _loading = true;
  String? _error;
  bool _dirty = false;

  PiEngineSettings? _loaded;

  // Text/enum/bool form state (only keys in these maps are written back).
  final Map<String, String> _texts = {};
  final Map<String, String?> _enums = {};
  final Map<String, bool> _bools = {};

  // Nested groups: group key -> changed sub-keys (merged over the loaded map).
  final Map<String, Map<String, dynamic>> _groups = {};

  // Raw JSON fallback editor.
  bool _showRaw = false;
  String? _rawText;

  PiHostService get _service => context.read<PiHostService>();

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    final connected = await ensurePiHostConnected(context);
    if (!mounted) return;
    if (!connected) {
      setState(() {
        _loading = false;
        _error = 'not_connected';
      });
      return;
    }
    final result = await _service.control('get_settings');
    if (!mounted) return;
    setState(() {
      _loading = false;
      if (result.ok && result.data is Map<String, dynamic>) {
        final data = result.data as Map<String, dynamic>;
        final settings = PiEngineSettings.fromJson(data);
        _loaded = settings;
        _seedForm(settings);
        _rawText = const JsonEncoder.withIndent('  ').convert(settings.raw);
        _dirty = false;
        _error = null;
      } else {
        _error = result.error ?? 'load_failed';
      }
    });
  }

  void _seedForm(PiEngineSettings s) {
    _texts
      ..clear()
      ..addAll({
        if (s.defaultProvider != null) 'defaultProvider': s.defaultProvider!,
        if (s.defaultModel != null) 'defaultModel': s.defaultModel!,
        if (s.shellPath != null) 'shellPath': s.shellPath!,
        if (s.externalEditor != null) 'externalEditor': s.externalEditor!,
        if (s.httpProxy != null) 'httpProxy': s.httpProxy!,
      });
    _enums
      ..clear()
      ..addAll({
        if (s.defaultThinkingLevel != null)
          'defaultThinkingLevel': s.defaultThinkingLevel,
        if (s.transport != null) 'transport': s.transport,
        if (s.steeringMode != null) 'steeringMode': s.steeringMode,
        if (s.followUpMode != null) 'followUpMode': s.followUpMode,
        if (s.defaultProjectTrust != null)
          'defaultProjectTrust': s.defaultProjectTrust,
      });
    _bools
      ..clear()
      ..addAll({
        'hideThinkingBlock': s.hideThinkingBlock,
        'showCacheMissNotices': s.showCacheMissNotices,
        'quietStartup': s.quietStartup,
        'enableSkillCommands': s.enableSkillCommands,
        'enableInstallTelemetry': s.enableInstallTelemetry,
        'enableAnalytics': s.enableAnalytics,
        'collapseChangelog': s.collapseChangelog,
      });
    _groups.clear();
  }

  void _markDirty(VoidCallback mutate) {
    setState(() {
      mutate();
      _dirty = true;
    });
  }

  // ---- patch building ----

  ({Map<String, dynamic> patch, List<String> remove}) _buildChange() {
    final patch = <String, dynamic>{};
    final remove = <String>[];

    _texts.forEach((key, value) {
      final v = value.trim();
      if (v.isEmpty) {
        remove.add(key);
      } else {
        patch[key] = v;
      }
    });
    _enums.forEach((key, value) {
      if (value == null || value.isEmpty) {
        remove.add(key);
      } else {
        patch[key] = value;
      }
    });
    _bools.forEach((key, value) {
      final loaded = _loaded?.contains(key) == true
          ? _loaded!.raw[key] == true
          : false;
      if (value != loaded) patch[key] = value;
    });
    _groups.forEach((group, changed) {
      if (changed.isEmpty) return;
      final loaded = _loaded?.raw[group];
      final base = loaded is Map
          ? Map<String, dynamic>.from(loaded)
          : <String, dynamic>{};
      patch[group] = {...base, ...changed};
    });
    return (patch: patch, remove: remove);
  }

  Future<void> _save() async {
    final connected = await ensurePiHostConnected(context);
    if (!mounted || !connected) return;
    final messenger = ScaffoldMessenger.of(context);
    final l = AppLocalizations.of(context);
    setState(() => _dirty = false);
    final change = _buildChange();
    final result = await _service.control(
      'update_settings',
      payload: {
        'patch': change.patch,
        if (change.remove.isNotEmpty) 'remove': change.remove,
      },
    );
    if (!mounted) return;
    if (result.ok) {
      messenger.showSnackBar(SnackBar(content: Text(l.piEngineSaved)));
      // Refresh the loaded copy so a later save compares against the file.
      if (result.data is Map<String, dynamic>) {
        setState(() {
          _loaded = PiEngineSettings.fromJson(result.data as Map<String, dynamic>);
          _rawText = const JsonEncoder.withIndent('  ')
              .convert(_loaded!.raw);
        });
      }
    } else {
      setState(() => _dirty = true);
      messenger.showSnackBar(
        SnackBar(
          content: Text(l.piEngineError(result.error ?? 'write failed')),
        ),
      );
    }
  }

  Future<void> _saveRaw() async {
    final l = AppLocalizations.of(context);
    final messenger = ScaffoldMessenger.of(context);
    final text = _rawText?.trim() ?? '';
    Object? parsed;
    try {
      parsed = jsonDecode(text);
    } catch (_) {
      messenger.showSnackBar(
        SnackBar(content: Text(l.piEngineSettingsJsonInvalid)),
      );
      return;
    }
    if (parsed is! Map) {
      messenger.showSnackBar(
        SnackBar(content: Text(l.piEngineSettingsJsonObject)),
      );
      return;
    }
    final connected = await ensurePiHostConnected(context);
    if (!mounted || !connected) return;
    final result = await _service.control(
      'update_settings',
      payload: {'patch': parsed},
    );
    if (!mounted) return;
    if (result.ok) {
      setState(() {
        _loaded = PiEngineSettings.fromJson(
          result.data is Map<String, dynamic>
              ? result.data as Map<String, dynamic>
              : <String, dynamic>{},
        );
        _rawText = const JsonEncoder.withIndent('  ').convert(_loaded!.raw);
        _dirty = false;
      });
      messenger.showSnackBar(SnackBar(content: Text(l.piEngineSaved)));
    } else {
      setState(() => _dirty = true);
      messenger.showSnackBar(
        SnackBar(
          content: Text(l.piEngineError(result.error ?? 'write failed')),
        ),
      );
    }
  }

  // ---- widgets ----

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    return Scaffold(
      appBar: AppBar(
        title: Text(l.piEngineSettingsCore),
        actions: [
          if (_dirty)
            TextButton.icon(
              key: const ValueKey('save_engine_settings'),
              onPressed: _save,
              icon: const Icon(Icons.check),
              label: Text(l.save),
            ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.only(bottom: 32),
          children: [
            if (_error != null) _buildError(l),
            if (_loading)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 48),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (_error == null) ...[
              _buildGeneral(l),
              _buildBehavior(l),
              _buildGroup(l, 'compaction', l.piEngineSettingsCompaction, [
                _GroupFieldSpec.bool('enabled', l.piEngineSettingsCompactionEnabled),
                _GroupFieldSpec.int('reserveTokens', l.piEngineSettingsCompactionReserve, intDefault: 16384),
                _GroupFieldSpec.int('keepRecentTokens', l.piEngineSettingsCompactionKeep, intDefault: 20000),
              ]),
              _buildGroup(l, 'retry', l.piEngineSettingsRetry, [
                _GroupFieldSpec.bool('enabled', l.piEngineSettingsRetryEnabled),
                _GroupFieldSpec.int('maxRetries', l.piEngineSettingsRetryMax, intDefault: 3),
                _GroupFieldSpec.int('baseDelayMs', l.piEngineSettingsRetryBase, intDefault: 2000),
              ]),
              _buildGroup(l, 'images', l.piEngineSettingsImages, [
                _GroupFieldSpec.bool('autoResize', l.piEngineSettingsImagesAutoResize),
                _GroupFieldSpec.bool('blockImages', l.piEngineSettingsImagesBlock),
              ]),
              _buildGroup(l, 'terminal', l.piEngineSettingsTerminal, [
                _GroupFieldSpec.bool('showImages', l.piEngineSettingsTerminalShowImages),
              ]),
              _buildRawEditor(l),
              const Divider(height: 32),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: Text(
                  l.piEngineSettingsHint,
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 16, 16, 0),
                child: FilledButton.tonalIcon(
                  key: const ValueKey('restart_engine_settings'),
                  onPressed: () => confirmRestartEngine(context, _service),
                  icon: const Icon(Icons.restart_alt),
                  label: Text(l.piEngineRestartEngine),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildGeneral(AppLocalizations l) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SettingsSectionHeader(title: l.piEngineSettingsSectionGeneral),
        Card(
          margin: const EdgeInsets.symmetric(horizontal: 16),
          child: Column(
            children: [
              _TextSettingTile(
                key: const ValueKey('settings_defaultProvider'),
                title: l.piEngineSettingsDefaultProvider,
                subtitle: l.piEngineSettingsDefaultProviderDesc,
                hint: 'anthropic',
                value: _texts['defaultProvider'],
                onChanged: (v) => _markDirty(() => _texts['defaultProvider'] = v),
              ),
              const Divider(height: 1, indent: 56),
              _TextSettingTile(
                key: const ValueKey('settings_defaultModel'),
                title: l.piEngineSettingsDefaultModel,
                subtitle: l.piEngineSettingsDefaultModelDesc,
                hint: 'claude-sonnet-4-5',
                value: _texts['defaultModel'],
                onChanged: (v) => _markDirty(() => _texts['defaultModel'] = v),
              ),
              const Divider(height: 1, indent: 56),
              _EnumSettingTile(
                key: const ValueKey('settings_thinkingLevel'),
                title: l.piEngineSettingsThinkingLevel,
                subtitle: l.piEngineSettingsThinkingLevelDesc,
                choices: const [
                  PiEnumChoice('Minimal', 'minimal'),
                  PiEnumChoice('Low', 'low'),
                  PiEnumChoice('Medium', 'medium'),
                  PiEnumChoice('High', 'high'),
                ],
                value: _enums['defaultThinkingLevel'],
                onChanged: (v) => _markDirty(() => _enums['defaultThinkingLevel'] = v),
              ),
              const Divider(height: 1, indent: 56),
              _EnumSettingTile(
                key: const ValueKey('settings_transport'),
                title: l.piEngineSettingsTransport,
                subtitle: l.piEngineSettingsTransportDesc,
                choices: const [
                  PiEnumChoice('auto', 'auto'),
                  PiEnumChoice('stdio', 'stdio'),
                  PiEnumChoice('http', 'http'),
                ],
                value: _enums['transport'],
                onChanged: (v) => _markDirty(() => _enums['transport'] = v),
              ),
              const Divider(height: 1, indent: 56),
              _EnumSettingTile(
                key: const ValueKey('settings_steering'),
                title: l.piEngineSettingsSteering,
                subtitle: l.piEngineSettingsSteeringDesc,
                choices: const [
                  PiEnumChoice('All', 'all'),
                  PiEnumChoice('One at a time', 'one-at-a-time'),
                ],
                value: _enums['steeringMode'],
                onChanged: (v) => _markDirty(() => _enums['steeringMode'] = v),
              ),
              const Divider(height: 1, indent: 56),
              _EnumSettingTile(
                key: const ValueKey('settings_followUp'),
                title: l.piEngineSettingsFollowUp,
                subtitle: l.piEngineSettingsFollowUpDesc,
                choices: const [
                  PiEnumChoice('All', 'all'),
                  PiEnumChoice('One at a time', 'one-at-a-time'),
                ],
                value: _enums['followUpMode'],
                onChanged: (v) => _markDirty(() => _enums['followUpMode'] = v),
              ),
              const Divider(height: 1, indent: 56),
              _EnumSettingTile(
                key: const ValueKey('settings_trust'),
                title: l.piEngineSettingsTrust,
                subtitle: l.piEngineSettingsTrustDesc,
                choices: const [
                  PiEnumChoice('Ask', 'ask'),
                  PiEnumChoice('Always', 'always'),
                  PiEnumChoice('Never', 'never'),
                ],
                value: _enums['defaultProjectTrust'],
                onChanged: (v) => _markDirty(() => _enums['defaultProjectTrust'] = v),
              ),
              const Divider(height: 1, indent: 56),
              _TextSettingTile(
                key: const ValueKey('settings_shellPath'),
                title: l.piEngineSettingsShellPath,
                subtitle: l.piEngineSettingsShellPathDesc,
                hint: '/bin/zsh',
                value: _texts['shellPath'],
                onChanged: (v) => _markDirty(() => _texts['shellPath'] = v),
              ),
              const Divider(height: 1, indent: 56),
              _TextSettingTile(
                key: const ValueKey('settings_editor'),
                title: l.piEngineSettingsExternalEditor,
                subtitle: l.piEngineSettingsExternalEditorDesc,
                hint: 'code -w',
                value: _texts['externalEditor'],
                onChanged: (v) => _markDirty(() => _texts['externalEditor'] = v),
              ),
              const Divider(height: 1, indent: 56),
              _TextSettingTile(
                key: const ValueKey('settings_proxy'),
                title: l.piEngineSettingsHttpProxy,
                subtitle: l.piEngineSettingsHttpProxyDesc,
                hint: 'http://127.0.0.1:7890',
                value: _texts['httpProxy'],
                onChanged: (v) => _markDirty(() => _texts['httpProxy'] = v),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildBehavior(AppLocalizations l) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SettingsSectionHeader(title: l.piEngineSettingsSectionBehavior),
        Card(
          margin: const EdgeInsets.symmetric(horizontal: 16),
          child: Column(
            children: [
              _BoolSettingTile(
                key: const ValueKey('settings_hideThinking'),
                title: l.piEngineSettingsHideThinking,
                subtitle: l.piEngineSettingsHideThinkingDesc,
                value: _bools['hideThinkingBlock'] ?? false,
                onChanged: (v) =>
                    _markDirty(() => _bools['hideThinkingBlock'] = v),
              ),
              const Divider(height: 1, indent: 56),
              _BoolSettingTile(
                key: const ValueKey('settings_cacheNotices'),
                title: l.piEngineSettingsCacheNotices,
                subtitle: l.piEngineSettingsCacheNoticesDesc,
                value: _bools['showCacheMissNotices'] ?? false,
                onChanged: (v) =>
                    _markDirty(() => _bools['showCacheMissNotices'] = v),
              ),
              const Divider(height: 1, indent: 56),
              _BoolSettingTile(
                key: const ValueKey('settings_quietStartup'),
                title: l.piEngineSettingsQuietStartup,
                subtitle: l.piEngineSettingsQuietStartupDesc,
                value: _bools['quietStartup'] ?? false,
                onChanged: (v) => _markDirty(() => _bools['quietStartup'] = v),
              ),
              const Divider(height: 1, indent: 56),
              _BoolSettingTile(
                key: const ValueKey('settings_skillCommands'),
                title: l.piEngineSettingsSkillCommands,
                subtitle: l.piEngineSettingsSkillCommandsDesc,
                value: _bools['enableSkillCommands'] ?? true,
                onChanged: (v) =>
                    _markDirty(() => _bools['enableSkillCommands'] = v),
              ),
              const Divider(height: 1, indent: 56),
              _BoolSettingTile(
                key: const ValueKey('settings_installTelemetry'),
                title: l.piEngineSettingsInstallTelemetry,
                subtitle: l.piEngineSettingsInstallTelemetryDesc,
                value: _bools['enableInstallTelemetry'] ?? true,
                onChanged: (v) =>
                    _markDirty(() => _bools['enableInstallTelemetry'] = v),
              ),
              const Divider(height: 1, indent: 56),
              _BoolSettingTile(
                key: const ValueKey('settings_analytics'),
                title: l.piEngineSettingsAnalytics,
                subtitle: l.piEngineSettingsAnalyticsDesc,
                value: _bools['enableAnalytics'] ?? false,
                onChanged: (v) => _markDirty(() => _bools['enableAnalytics'] = v),
              ),
              const Divider(height: 1, indent: 56),
              _BoolSettingTile(
                key: const ValueKey('settings_collapseChangelog'),
                title: l.piEngineSettingsCollapseChangelog,
                subtitle: l.piEngineSettingsCollapseChangelogDesc,
                value: _bools['collapseChangelog'] ?? false,
                onChanged: (v) =>
                    _markDirty(() => _bools['collapseChangelog'] = v),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildGroup(
    AppLocalizations l,
    String group,
    String title,
    List<_GroupFieldSpec> fields,
  ) {
    final cs = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SettingsSectionHeader(title: title),
        Card(
          margin: const EdgeInsets.symmetric(horizontal: 16),
          child: Column(
            children: [
              for (var i = 0; i < fields.length; i++) ...[
                if (i > 0) const Divider(height: 1, indent: 56),
                _buildGroupField(group, fields[i], cs),
              ],
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildGroupField(
    String group,
    _GroupFieldSpec field,
    ColorScheme cs,
  ) {
    final changed = _groups[group] ?? <String, dynamic>{};
    final loaded = _loaded?.raw[group];
    final loadedMap = loaded is Map
        ? Map<String, dynamic>.from(loaded)
        : <String, dynamic>{};
    if (field.isBool) {
      final value = changed[field.key] as bool? ??
          (loadedMap[field.key] as bool? ?? field.boolDefault);
      return SwitchListTile(
        key: ValueKey('settings_${group}_${field.key}'),
        secondary: Icon(Icons.toggle_off_outlined, color: cs.onSurfaceVariant),
        title: Text(field.label),
        value: value,
        onChanged: (v) => _markDirty(() {
          _groups[group] = {...changed, field.key: v};
        }),
      );
    }
    // Numeric group fields: text input with default hint.
    final current =
        changed[field.key] as int? ?? loadedMap[field.key] as int?;
    return _IntSettingTile(
      key: ValueKey('settings_${group}_${field.key}'),
      title: field.label,
      hint: field.intDefault?.toString(),
      value: current,
      onChanged: (v) => _markDirty(() {
        final next = {...changed};
        next[field.key] = v;
        _groups[group] = next;
      }),
    );
  }

  Widget _buildRawEditor(AppLocalizations l) {
    final cs = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SettingsSectionHeader(title: l.piEngineSettingsRawJson),
        Card(
          margin: const EdgeInsets.symmetric(horizontal: 16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              ListTile(
                key: const ValueKey('settings_raw_toggle'),
                leading: Icon(
                  Icons.data_object,
                  color: cs.onSurfaceVariant,
                ),
                title: Text(l.piEngineSettingsRawJson),
                subtitle: Text(l.piEngineSettingsRawJsonDesc),
                trailing: Icon(
                  _showRaw ? Icons.expand_less : Icons.expand_more,
                ),
                onTap: () => setState(() => _showRaw = !_showRaw),
              ),
              if (_showRaw) ...[
                const Divider(height: 1, indent: 56),
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
                  child: TextField(
                    key: const ValueKey('settings_raw_editor'),
                    controller: TextEditingController(text: _rawText ?? ''),
                    maxLines: 18,
                    minLines: 8,
                    style: const TextStyle(
                      fontFamily: 'monospace',
                      fontSize: 12,
                    ),
                    decoration: const InputDecoration(
                      border: OutlineInputBorder(),
                      isDense: true,
                    ),
                    onChanged: (text) => _markDirty(() => _rawText = text),
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                  child: FilledButton.tonalIcon(
                    key: const ValueKey('settings_raw_save'),
                    onPressed: _saveRaw,
                    icon: const Icon(Icons.save_outlined),
                    label: Text(l.piEngineSettingsRawSave),
                  ),
                ),
              ],
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildError(AppLocalizations l) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 24, 16, 0),
      child: Text(
        _error == 'not_connected'
            ? l.piEngineNotConnected
            : l.piEngineError(_error ?? ''),
        style: TextStyle(color: Theme.of(context).colorScheme.error),
      ),
    );
  }
}

class _GroupFieldSpec {
  const _GroupFieldSpec._(this.key, this.label, this.isBool, this.intDefault);

  const _GroupFieldSpec.bool(String key, String label)
      : this._(key, label, true, null);

  const _GroupFieldSpec.int(String key, String label, {int? intDefault})
      : this._(key, label, false, intDefault);

  final String key;
  final String label;
  final bool isBool;
  final int? intDefault;
  final bool boolDefault = false;
}

class _TextSettingTile extends StatelessWidget {
  const _TextSettingTile({
    super.key,
    required this.title,
    required this.subtitle,
    required this.hint,
    required this.value,
    required this.onChanged,
  });

  final String title;
  final String subtitle;
  final String hint;
  final String? value;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final controller = TextEditingController(text: value ?? '');
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: Theme.of(context).textTheme.bodyLarge),
                const SizedBox(height: 2),
                Text(
                  subtitle,
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: cs.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 12),
          SizedBox(
            width: 160,
            child: TextField(
              controller: controller,
              style: const TextStyle(fontFamily: 'monospace', fontSize: 13),
              decoration: InputDecoration(
                isDense: true,
                border: const OutlineInputBorder(),
                hintText: hint,
              ),
              onChanged: onChanged,
              onSubmitted: onChanged,
            ),
          ),
          IconButton(
            tooltip: AppLocalizations.of(context).piEngineFlagsClear,
            icon: const Icon(Icons.close, size: 18),
            onPressed: () {
              controller.clear();
              onChanged('');
            },
          ),
        ],
      ),
    );
  }
}

class _EnumSettingTile extends StatelessWidget {
  const _EnumSettingTile({
    super.key,
    required this.title,
    required this.subtitle,
    required this.choices,
    required this.value,
    required this.onChanged,
  });

  final String title;
  final String subtitle;
  final List<PiEnumChoice> choices;
  final String? value;
  final ValueChanged<String?> onChanged;

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 4),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: Theme.of(context).textTheme.bodyLarge),
                const SizedBox(height: 2),
                Text(
                  subtitle,
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: cs.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 12),
          DropdownButtonHideUnderline(
            child: DropdownButton<String?>(
              key: const ValueKey('enum_dropdown'),
              value: value,
              hint: const Text('—'),
              items: [
                for (final choice in choices)
                  DropdownMenuItem<String?>(
                    value: choice.value,
                    child: Text(choice.label),
                  ),
              ],
              onChanged: onChanged,
            ),
          ),
        ],
      ),
    );
  }
}

class _BoolSettingTile extends StatelessWidget {
  const _BoolSettingTile({
    super.key,
    required this.title,
    required this.subtitle,
    required this.value,
    required this.onChanged,
  });

  final String title;
  final String subtitle;
  final bool value;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return SwitchListTile(
      secondary: Icon(Icons.toggle_off_outlined, color: cs.onSurfaceVariant),
      title: Text(title),
      subtitle: Text(subtitle),
      value: value,
      onChanged: onChanged,
    );
  }
}

class _IntSettingTile extends StatelessWidget {
  const _IntSettingTile({
    super.key,
    required this.title,
    required this.hint,
    required this.value,
    required this.onChanged,
  });

  final String title;
  final String? hint;
  final int? value;
  final ValueChanged<int?> onChanged;

  @override
  Widget build(BuildContext context) {
    final controller = TextEditingController(text: value?.toString() ?? '');
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
      child: Row(
        children: [
          Expanded(
            child: Text(title, style: Theme.of(context).textTheme.bodyLarge),
          ),
          const SizedBox(width: 12),
          SizedBox(
            width: 120,
            child: TextField(
              controller: controller,
              keyboardType: TextInputType.number,
              style: const TextStyle(fontFamily: 'monospace', fontSize: 13),
              decoration: InputDecoration(
                isDense: true,
                border: const OutlineInputBorder(),
                hintText: hint,
              ),
              onChanged: (text) => onChanged(int.tryParse(text.trim())),
              onSubmitted: (text) => onChanged(int.tryParse(text.trim())),
            ),
          ),
        ],
      ),
    );
  }
}
