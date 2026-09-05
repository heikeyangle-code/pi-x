import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../l10n/app_localizations.dart';
import '../../services/pi_host_service.dart';
import 'pi_engine_themes.dart';
import 'pi_engine_widgets.dart';

/// Manage pi themes (`~/.pi/agent/themes`, pi theme.ts
/// getAvailableThemesWithPaths).
///
/// Surface ops (1:1 with the pi theme model):
///   list_themes   -> [{name, path?, builtin, selected}]
///   select_theme  -> {name}           ('' clears settings.theme)
///   import_theme  -> {name, theme}    (theme JSON must declare name/colors)
///   remove_theme  -> {name}
///
/// The engine scans themes at startup; selecting a theme writes
/// `settings.theme` (runtime setting), importing/removing edits the themes
/// directory, so a restart is offered after structural edits.
class ThemesScreen extends StatefulWidget {
  const ThemesScreen({super.key});

  @override
  State<ThemesScreen> createState() => _ThemesScreenState();
}

class _ThemesScreenState extends State<ThemesScreen> {
  bool _loading = true;
  bool _busy = false;
  String? _error;
  List<PiThemeInfo> _themes = [];

  PiHostService get _service => context.read<PiHostService>();

  bool get _hasSelection => _themes.any((t) => t.selected);

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
    final result = await _service.control('list_themes');
    if (!mounted) return;
    setState(() {
      _loading = false;
      if (result.ok && result.data is List) {
        _themes = (result.data as List)
            .whereType<Map>()
            .map((e) => PiThemeInfo.fromJson(e.cast<String, dynamic>()))
            .toList();
        _error = null;
      } else {
        _error = result.error ?? 'load_failed';
      }
    });
  }

  Future<void> _select(String name, {bool clear = false}) async {
    final messenger = ScaffoldMessenger.of(context);
    final l = AppLocalizations.of(context);
    final connected = await ensurePiHostConnected(context);
    if (!mounted || !connected) return;
    setState(() => _busy = true);
    final result = await _service.control(
      'select_theme',
      payload: {'name': clear ? '' : name},
    );
    if (!mounted) return;
    setState(() => _busy = false);
    if (result.ok) {
      messenger.showSnackBar(SnackBar(content: Text(l.piEngineSaved)));
      await _load();
    } else {
      messenger.showSnackBar(
        SnackBar(content: Text(l.piEngineError(result.error ?? 'apply failed'))),
      );
    }
  }

  Future<void> _remove(PiThemeInfo theme) async {
    final l = AppLocalizations.of(context);
    final messenger = ScaffoldMessenger.of(context);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(l.piEngineThemesRemove),
        content: Text(l.piEngineThemesRemoveConfirm(theme.name)),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text(l.cancel),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(l.delete),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    if (!mounted) return;
    final connected = await ensurePiHostConnected(context);
    if (!mounted || !connected) return;
    setState(() => _busy = true);
    final result = await _service.control(
      'remove_theme',
      payload: {'name': theme.name},
    );
    if (!mounted) return;
    setState(() => _busy = false);
    if (result.ok) {
      messenger.showSnackBar(SnackBar(content: Text(l.piEngineSaved)));
      await _load();
    } else {
      messenger.showSnackBar(
        SnackBar(content: Text(l.piEngineError(result.error ?? 'remove failed'))),
      );
    }
  }

  Future<void> _showImport() async {
    final l = AppLocalizations.of(context);
    final jsonController = TextEditingController();
    String? parseError;

    final saved = await showDialog<Map<String, dynamic>>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) => AlertDialog(
          title: Text(l.piEngineThemesImport),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  l.piEngineThemesImportDesc,
                  style: Theme.of(ctx).textTheme.bodySmall?.copyWith(
                    color: Theme.of(ctx).colorScheme.onSurfaceVariant,
                  ),
                ),
                const SizedBox(height: 12),
                TextField(
                  key: const ValueKey('theme_import_json'),
                  controller: jsonController,
                  maxLines: 12,
                  minLines: 8,
                  style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
                  decoration: InputDecoration(
                    labelText: l.piEngineThemesImportJson,
                    border: const OutlineInputBorder(),
                    isDense: true,
                  ),
                  onChanged: (_) {
                    if (parseError != null) {
                      setDialogState(() => parseError = null);
                    }
                  },
                ),
                if (parseError != null) ...[
                  const SizedBox(height: 8),
                  Text(
                    parseError!,
                    style: TextStyle(
                      color: Theme.of(ctx).colorScheme.error,
                      fontSize: 12,
                    ),
                  ),
                ],
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx),
              child: Text(l.cancel),
            ),
            FilledButton(
              key: const ValueKey('theme_import_save'),
              onPressed: () {
                Object? parsed;
                try {
                  parsed = jsonDecode(jsonController.text.trim());
                } catch (_) {
                  setDialogState(
                    () => parseError = l.piEngineThemesImportInvalidJson,
                  );
                  return;
                }
                final record = parsed is Map
                    ? parsed.cast<String, dynamic>()
                    : <String, dynamic>{};
                final declared = record['name'];
                final colors = record['colors'];
                if (declared is! String || declared.isEmpty || colors is! Map) {
                  setDialogState(
                    () => parseError = l.piEngineThemesImportInvalid,
                  );
                  return;
                }
                Navigator.pop(ctx, record);
              },
              child: Text(l.piEngineThemesImport),
            ),
          ],
        ),
      ),
    );
    final record = saved;
    jsonController.dispose();
    if (record == null) return;
    if (!mounted) return;
    final connected = await ensurePiHostConnected(context);
    if (!mounted || !connected) return;
    final messenger = ScaffoldMessenger.of(context);
    setState(() => _busy = true);
    final result = await _service.control(
      'import_theme',
      payload: {
        // File name = the JSON's declared name (same value writeCustomTheme
        // validates against), so listing and file name always agree.
        'name': record['name'] as String,
        'theme': record,
      },
    );
    if (!mounted) return;
    setState(() => _busy = false);
    if (result.ok) {
      messenger.showSnackBar(SnackBar(content: Text(l.piEngineSaved)));
      await _load();
    } else {
      messenger.showSnackBar(
        SnackBar(content: Text(l.piEngineError(result.error ?? 'import failed'))),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    return Scaffold(
      appBar: AppBar(
        title: Text(l.piEngineThemes),
        actions: [
          IconButton(
            key: const ValueKey('import_theme'),
            tooltip: l.piEngineThemesImport,
            icon: const Icon(Icons.add),
            onPressed: _loading || _busy ? null : _showImport,
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.only(bottom: 32),
          children: [
            if (_error != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 24, 16, 0),
                child: Text(
                  _error == 'not_connected'
                      ? l.piEngineNotConnected
                      : l.piEngineError(_error ?? ''),
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ),
            if (_loading)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 48),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (_error == null) ...[
              if (_hasSelection)
                ListTile(
                  key: const ValueKey('theme_use_default'),
                  leading: Icon(
                    Icons.auto_fix_high,
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
                  title: Text(l.piEngineThemesUseDefault),
                  subtitle: Text(l.piEngineThemesUseDefaultDesc),
                  onTap: _busy ? null : () => _select('', clear: true),
                ),
              if (_themes.isEmpty)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 48),
                  child: Center(
                    child: Text(
                      l.piEngineThemesEmpty,
                      style: TextStyle(
                        color: Theme.of(context).colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ),
                )
              else
                for (final theme in _themes)
                  _ThemeTile(
                    key: ValueKey('theme_${theme.name}'),
                    theme: theme,
                    busy: _busy,
                    onSelect: () => _select(theme.name),
                    onRemove: theme.builtin ? null : () => _remove(theme),
                  ),
            ],
            const SizedBox(height: 16),
          ],
        ),
      ),
    );
  }
}

class _ThemeTile extends StatelessWidget {
  const _ThemeTile({
    super.key,
    required this.theme,
    required this.busy,
    required this.onSelect,
    this.onRemove,
  });

  final PiThemeInfo theme;
  final bool busy;
  final VoidCallback onSelect;
  final VoidCallback? onRemove;

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final l = AppLocalizations.of(context);
    return Card(
      margin: const EdgeInsets.fromLTRB(16, 12, 16, 0),
      child: ListTile(
        leading: CircleAvatar(
          radius: 18,
          backgroundColor: cs.primaryContainer,
          child: Icon(
            Icons.palette_outlined,
            size: 20,
            color: cs.onPrimaryContainer,
          ),
        ),
        title: Text(
          theme.name,
          style: const TextStyle(fontFamily: 'monospace'),
        ),
        subtitle: Text(
          [
            theme.builtin ? l.piEngineThemesBuiltin : l.piEngineThemesCustom,
            if (theme.path != null) theme.path!,
          ].join(' · '),
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
        ),
        trailing: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (theme.selected)
              Tooltip(
                message: l.piEngineThemesActive,
                child: Icon(Icons.check_circle, size: 20, color: cs.primary),
              ),
            if (onRemove != null)
              PopupMenuButton<String>(
                onSelected: (action) {
                  if (action == 'remove') onRemove!();
                },
                itemBuilder: (ctx) => [
                  PopupMenuItem(value: 'remove', child: Text(l.piEngineThemesRemove)),
                ],
              ),
          ],
        ),
        onTap: busy ? null : onSelect,
      ),
    );
  }
}
