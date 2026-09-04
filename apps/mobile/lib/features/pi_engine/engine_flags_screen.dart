import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../l10n/app_localizations.dart';
import '../../services/pi_host_service.dart';
import 'pi_engine_models.dart';
import 'pi_engine_widgets.dart';

/// Configure pi engine launch switches (~/.pi/agent/pix-config.json engineArgs).
///
/// The screen reads the current engine args, lets the user toggle documented
/// `--no-*` flags and fill value-carrying switches (--tools / --exclude-tools /
/// --use-theme), then writes them back through `update_pix_config`. Launch-time
/// args only take effect on the next engine spawn, so the screen offers a
/// "restart engine" action (restart_engine control op) to apply them — the
/// same op the PiHost uses to apply SYSTEM.md changes.
class EngineFlagsScreen extends StatefulWidget {
  const EngineFlagsScreen({super.key});

  @override
  State<EngineFlagsScreen> createState() => _EngineFlagsScreenState();
}

class _EngineFlagsScreenState extends State<EngineFlagsScreen> {
  bool _loading = true;
  String? _error;
  bool _dirty = false;

  Map<String, bool> _toggles = {};
  Map<String, String> _values = {};
  List<String> _other = const [];

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
    final result = await _service.control('get_pix_config');
    if (!mounted) return;
    setState(() {
      _loading = false;
      if (result.ok && result.data is Map<String, dynamic>) {
        final data = result.data as Map<String, dynamic>;
        final args = (data['engineArgs'] as List?)
                ?.whereType<String>()
                .toList() ??
            const <String>[];
        final parsed = parseEngineArgs(args);
        _toggles = parsed.toggles;
        _values = parsed.values;
        _other = parsed.other;
        _dirty = false;
        _error = null;
      } else {
        _error = result.error ?? 'load_failed';
      }
    });
  }

  Future<void> _save() async {
    final connected = await ensurePiHostConnected(context);
    if (!mounted || !connected) return;
    final messenger = ScaffoldMessenger.of(context);
    final l = AppLocalizations.of(context);
    setState(() => _dirty = false);
    final result = await _service.control(
      'update_pix_config',
      payload: {
        'patch': {
          'engineArgs': buildEngineArgs(_toggles, _values, other: _other),
        },
      },
    );
    if (!mounted) return;
    if (result.ok) {
      messenger.showSnackBar(
        SnackBar(content: Text(l.piEngineSaved)),
      );
    } else {
      setState(() => _dirty = true);
      messenger.showSnackBar(
        SnackBar(
          content: Text(l.piEngineError(result.error ?? 'write failed')),
        ),
      );
    }
  }

  void _markDirty(VoidCallback mutate) {
    setState(() {
      mutate();
      _dirty = true;
    });
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    return Scaffold(
      appBar: AppBar(
        title: Text(l.piEngineLaunchFlags),
        actions: [
          if (_dirty)
            TextButton.icon(
              key: const ValueKey('save_engine_flags'),
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
              _buildToggles(l),
              _buildValues(l),
              _buildOther(l),
              const Divider(height: 32),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: Text(
                  l.piEngineFlagsRestartHint,
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 16, 16, 0),
                child: FilledButton.tonalIcon(
                  key: const ValueKey('restart_engine'),
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

  Widget _buildToggles(AppLocalizations l) {
    final cs = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SettingsSectionHeader(title: l.piEngineFlagSectionToggles),
        Card(
          margin: const EdgeInsets.symmetric(horizontal: 16),
          child: Column(
            children: [
              for (var i = 0; i < kEngineFlags.length; i++) ...[
                if (i > 0) const Divider(height: 1, indent: 56),
                SwitchListTile(
                  key: ValueKey('flag_${kEngineFlags[i].long}'),
                  secondary: Icon(
                    Icons.toggle_off_outlined,
                    color: cs.onSurfaceVariant,
                  ),
                  title: Text(
                    kEngineFlags[i].flagText,
                    style: const TextStyle(fontFamily: 'monospace'),
                  ),
                  subtitle: Text(_flagDescription(l, kEngineFlags[i])),
                  value: _toggles[kEngineFlags[i].long] == true,
                  onChanged: (enabled) => _markDirty(() {
                    if (enabled) {
                      _toggles[kEngineFlags[i].long] = true;
                    } else {
                      _toggles.remove(kEngineFlags[i].long);
                    }
                  }),
                ),
              ],
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildValues(AppLocalizations l) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SettingsSectionHeader(title: l.piEngineFlagSectionValues),
        Card(
          margin: const EdgeInsets.symmetric(horizontal: 16),
          child: Column(
            children: [
              for (var i = 0; i < kEngineFlagValues.length; i++) ...[
                if (i > 0) const Divider(height: 1, indent: 56),
                _ValueFlagTile(
                  key: ValueKey('value_${kEngineFlagValues[i].long}'),
                  spec: kEngineFlagValues[i],
                  value: _values[kEngineFlagValues[i].long],
                  onChanged: (value) => _markDirty(() {
                    if (value == null || value.trim().isEmpty) {
                      _values.remove(kEngineFlagValues[i].long);
                    } else {
                      _values[kEngineFlagValues[i].long] = value.trim();
                    }
                  }),
                ),
              ],
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildOther(AppLocalizations l) {
    if (_other.isEmpty) return const SizedBox.shrink();
    final cs = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SettingsSectionHeader(title: l.piEngineFlagSectionOther),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: Text(
            _other.map((a) => "'$a'").join(' '),
            style: TextStyle(
              fontFamily: 'monospace',
              fontSize: 12,
              color: cs.onSurfaceVariant,
            ),
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

  String _flagDescription(AppLocalizations l, EngineFlagSpec spec) {
    // Localized description by key; falls back to the flag text itself when a
    // language pack does not cover a newer flag yet.
    switch (spec.descriptionKey) {
      case 'piEngineFlagNoContextFiles':
        return l.piEngineFlagNoContextFiles;
      case 'piEngineFlagNoSkills':
        return l.piEngineFlagNoSkills;
      case 'piEngineFlagNoPromptTemplates':
        return l.piEngineFlagNoPromptTemplates;
      case 'piEngineFlagNoThemes':
        return l.piEngineFlagNoThemes;
      case 'piEngineFlagNoExtensions':
        return l.piEngineFlagNoExtensions;
      case 'piEngineFlagNoTools':
        return l.piEngineFlagNoTools;
      case 'piEngineFlagNoBuiltinTools':
        return l.piEngineFlagNoBuiltinTools;
      case 'piEngineFlagTools':
        return l.piEngineFlagTools;
      case 'piEngineFlagExcludeTools':
        return l.piEngineFlagExcludeTools;
      case 'piEngineFlagUseTheme':
        return l.piEngineFlagUseTheme;
      default:
        return spec.flagText;
    }
  }
}

class _ValueFlagTile extends StatelessWidget {
  const _ValueFlagTile({
    super.key,
    required this.spec,
    required this.value,
    required this.onChanged,
  });

  final EngineFlagSpec spec;
  final String? value;
  final ValueChanged<String?> onChanged;

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
                Text(
                  spec.flagText,
                  style: const TextStyle(fontFamily: 'monospace'),
                ),
                const SizedBox(height: 2),
                Text(
                  _description(context, spec),
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
                hintText: 'value',
              ),
              onChanged: (text) => onChanged(text),
              onSubmitted: (text) => onChanged(text),
            ),
          ),
          IconButton(
            tooltip: AppLocalizations.of(context).piEngineFlagsClear,
            icon: const Icon(Icons.close, size: 18),
            onPressed: () {
              controller.clear();
              onChanged(null);
            },
          ),
        ],
      ),
    );
  }

  String _description(BuildContext context, EngineFlagSpec spec) {
    final l = AppLocalizations.of(context);
    switch (spec.descriptionKey) {
      case 'piEngineFlagTools':
        return l.piEngineFlagTools;
      case 'piEngineFlagExcludeTools':
        return l.piEngineFlagExcludeTools;
      case 'piEngineFlagUseTheme':
        return l.piEngineFlagUseTheme;
      default:
        return spec.flagText;
    }
  }
}
