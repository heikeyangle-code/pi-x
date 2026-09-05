import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../l10n/app_localizations.dart';
import '../../services/pi_host_service.dart';
import 'commands_screen.dart';
import 'engine_flags_screen.dart';
import 'extensions_screen.dart';
import 'models_screen.dart';
import 'pi_engine_widgets.dart';
import 'runtime_screen.dart';
import 'skills_screen.dart';
import 'system_prompt_screen.dart';

/// Pi engine management hub: status + entry points for system prompts,
/// launch flags and provider/model management (docs/ENGINE-UI-SURFACES §6).
class PiEngineSettingsScreen extends StatefulWidget {
  const PiEngineSettingsScreen({super.key, this.projectPath});

  /// Optional workspace path; when set, the system prompt screen pre-loads
  /// the project `.pi/` scope for that workspace.
  final String? projectPath;

  @override
  State<PiEngineSettingsScreen> createState() => _PiEngineSettingsScreenState();
}

class _PiEngineSettingsScreenState extends State<PiEngineSettingsScreen> {
  bool _connecting = false;

  @override
  void initState() {
    super.initState();
    unawaited(_connect());
  }

  Future<void> _connect() async {
    if (_connecting) return;
    setState(() => _connecting = true);
    await ensurePiHostConnected(context);
    if (mounted) setState(() => _connecting = false);
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final service = context.read<PiHostService>();
    return Scaffold(
      appBar: AppBar(title: Text(l.piEngineTitle)),
      body: ListView(
        padding: const EdgeInsets.only(bottom: 32),
        children: [
          const Padding(
            padding: EdgeInsets.fromLTRB(16, 16, 16, 0),
            child: PiHostStatusBanner(),
          ),
          if (_connecting)
            const Padding(
              padding: EdgeInsets.fromLTRB(16, 12, 16, 0),
              child: LinearProgressIndicator(minHeight: 2),
            ),
          SettingsSectionHeader(title: l.piEngineManage),
          _EntryCard(
            children: [
              ListTile(
                leading: Icon(
                  Icons.description_outlined,
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
                title: Text(l.piEngineSystemPrompts),
                subtitle: Text(l.piEngineSystemPromptsSubtitle),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) => SystemPromptScreen(
                      projectPath: widget.projectPath,
                    ),
                  ),
                ),
              ),
              const Divider(height: 1, indent: 56),
              ListTile(
                leading: Icon(
                  Icons.tune,
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
                title: Text(l.piEngineLaunchFlags),
                subtitle: Text(l.piEngineLaunchFlagsSubtitle),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) => const EngineFlagsScreen(),
                  ),
                ),
              ),
              const Divider(height: 1, indent: 56),
              ListTile(
                leading: Icon(
                  Icons.layers_outlined,
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
                title: Text(l.piEngineRuntime),
                subtitle: Text(l.piEngineRuntimeSubtitle),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) => const RuntimeScreen(),
                  ),
                ),
              ),
              const Divider(height: 1, indent: 56),
              ListTile(
                leading: Icon(
                  Icons.terminal,
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
                title: Text(l.piEngineCommands),
                subtitle: Text(l.piEngineCommandsSubtitle),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) => const CommandsScreen(),
                  ),
                ),
              ),
              const Divider(height: 1, indent: 56),
              ListTile(
                leading: Icon(
                  Icons.extension_outlined,
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
                title: Text(l.piEngineExtensions),
                subtitle: Text(l.piEngineExtensionsSubtitle),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) => const ExtensionsScreen(),
                  ),
                ),
              ),
              const Divider(height: 1, indent: 56),
              ListTile(
                leading: Icon(
                  Icons.auto_awesome_outlined,
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
                title: Text(l.piEngineSkills),
                subtitle: Text(l.piEngineSkillsSubtitle),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) => const SkillsScreen(),
                  ),
                ),
              ),
              const Divider(height: 1, indent: 56),
              ListTile(
                leading: Icon(
                  Icons.model_training,
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
                title: Text(l.piEngineModels),
                subtitle: Text(l.piEngineModelsSubtitle),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) => const ModelsScreen(),
                  ),
                ),
              ),
            ],
          ),
          SettingsSectionHeader(title: l.piEngineNote),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Text(
              l.piEngineNoteBody(service.lastUrl),
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _EntryCard extends StatelessWidget {
  const _EntryCard({required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    // Uses the theme's default card (elevation 0 + outline border), the same
    // surface the settings screen renders its section cards on.
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 16),
      child: Column(children: children),
    );
  }
}
