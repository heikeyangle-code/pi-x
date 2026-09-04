import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../l10n/app_localizations.dart';
import '../../services/pi_host_service.dart';
import 'pi_engine_commands.dart';
import 'pi_engine_widgets.dart';

/// Command palette: browse every slash command / template / skill the engine
/// exposes, grouped by source, tap to copy the invocation for the chat input.
///
/// M1 scaffold (docs/ENGINE-UI-SURFACES §4): commands expand server-side via
/// `get_commands` + `prompt "/name …"`, so the app keeps zero template logic.
class CommandsScreen extends StatefulWidget {
  const CommandsScreen({super.key});

  @override
  State<CommandsScreen> createState() => _CommandsScreenState();
}

class _CommandsScreenState extends State<CommandsScreen> {
  bool _loading = true;
  String? _error;
  List<PiCommand> _commands = const [];

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
    final result = await _service.control('get_commands');
    if (!mounted) return;
    setState(() {
      _loading = false;
      if (result.ok) {
        final raw = (result.data as Map<String, dynamic>?)?['commands'];
        if (raw is List) {
          _commands = raw
              .whereType<Map>()
              .map((c) => PiCommand.fromJson(c.cast<String, dynamic>()))
              .toList();
        }
        _error = null;
      } else {
        _error = result.error ?? 'load_failed';
      }
    });
  }

  Future<void> _copy(PiCommand command) async {
    final l = AppLocalizations.of(context);
    final messenger = ScaffoldMessenger.of(context);
    await Clipboard.setData(ClipboardData(text: command.invocation));
    messenger
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(l.piEngineCommandsCopied(command.name))));
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final cs = Theme.of(context).colorScheme;
    final extCommands = _commands
        .where((c) => c.source == 'extension')
        .toList();
    final prompts = _commands.where((c) => c.source == 'prompt').toList();
    final skills = _commands.where((c) => c.source == 'skill').toList();

    return Scaffold(
      appBar: AppBar(title: Text(l.piEngineCommands)),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.only(bottom: 32),
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
              child: Text(
                l.piEngineCommandsHint,
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: cs.onSurfaceVariant,
                ),
              ),
            ),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 24, 16, 0),
                child: Text(
                  _error == 'not_connected'
                      ? l.piEngineNotConnected
                      : l.piEngineError(_error ?? ''),
                  style: TextStyle(color: cs.error),
                ),
              ),
            if (_loading)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 48),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (_error == null && _commands.isEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 48),
                child: Center(
                  child: Text(
                    l.piEngineCommandsEmpty,
                    style: TextStyle(color: cs.onSurfaceVariant),
                  ),
                ),
              )
            else if (_error == null) ...[
              if (extCommands.isNotEmpty) ...[
                SettingsSectionHeader(title: l.piEngineCommandsGroupExtension),
                _CommandCard(
                  commands: extCommands,
                  accent: cs.primary,
                  onTap: _copy,
                ),
              ],
              if (prompts.isNotEmpty) ...[
                SettingsSectionHeader(title: l.piEngineCommandsGroupPrompt),
                _CommandCard(
                  commands: prompts,
                  accent: cs.secondary,
                  onTap: _copy,
                ),
              ],
              if (skills.isNotEmpty) ...[
                SettingsSectionHeader(title: l.piEngineCommandsGroupSkill),
                _CommandCard(
                  commands: skills,
                  accent: cs.tertiary,
                  onTap: _copy,
                ),
              ],
            ],
          ],
        ),
      ),
    );
  }
}

class _CommandCard extends StatelessWidget {
  const _CommandCard({
    required this.commands,
    required this.accent,
    required this.onTap,
  });

  final List<PiCommand> commands;
  final Color accent;
  final void Function(PiCommand command) onTap;

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 16),
      child: Column(
        children: [
          for (var i = 0; i < commands.length; i++) ...[
            if (i > 0) const Divider(height: 1, indent: 56),
            ListTile(
              key: ValueKey('command_${commands[i].name}'),
              leading: Icon(Icons.terminal, size: 22, color: accent),
              title: Text(
                commands[i].invocation.trimRight(),
                style: const TextStyle(
                  fontFamily: 'monospace',
                  fontWeight: FontWeight.w600,
                  fontSize: 15,
                ),
              ),
              subtitle: commands[i].description.isEmpty
                  ? null
                  : Text(
                      commands[i].description,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 13),
                    ),
              trailing: Icon(
                Icons.content_copy,
                size: 18,
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
              dense: true,
              onTap: () => onTap(commands[i]),
            ),
          ],
        ],
      ),
    );
  }
}
