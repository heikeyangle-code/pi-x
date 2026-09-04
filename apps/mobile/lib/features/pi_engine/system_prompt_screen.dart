import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../l10n/app_localizations.dart';
import '../../services/pi_host_service.dart';
import 'pi_engine_widgets.dart';

/// Edit pi system prompt overrides (docs/ENGINE-UI-SURFACES §6.1):
///   global : `~/.pi/agent/SYSTEM.md` + `APPEND_SYSTEM.md`
///   project: `{workspace}/.pi/SYSTEM.md` + `APPEND_SYSTEM.md`
/// Files are written on the Pi Host and picked up on the next engine start
/// (global), or when the project engine restarts (project scope requires the
/// project to be trusted by pi, matching official trust semantics).
class SystemPromptScreen extends StatefulWidget {
  const SystemPromptScreen({super.key, this.projectPath});

  /// Workspace path for the project scope; null = global-only until a path
  /// is entered.
  final String? projectPath;

  @override
  State<SystemPromptScreen> createState() => _SystemPromptScreenState();
}

enum _Scope { global, project }

class _SystemPromptScreenState extends State<SystemPromptScreen> {
  _Scope _scope = _Scope.global;
  late String _projectPath = widget.projectPath ?? '';
  bool _loading = true;
  String? _error;

  String? _globalSystem;
  String? _globalAppend;
  String? _projectSystem;
  String? _projectAppend;

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
    final projectId = _scope == _Scope.project && _projectPath.isNotEmpty
        ? _projectPath
        : PiHostService.kEngineProjectId;
    final result = await _service.control(
      'read_prompt_files',
      projectId: projectId,
    );
    if (!mounted) return;
    setState(() {
      _loading = false;
      if (result.ok && result.data is Map<String, dynamic>) {
        _error = null;
        final data = result.data as Map<String, dynamic>;
        final global = data['global'] as Map<String, dynamic>? ?? const {};
        final project = data['project'] as Map<String, dynamic>? ?? const {};
        _globalSystem = global['systemPrompt'] as String?;
        _globalAppend = global['appendSystemPrompt'] as String?;
        _projectSystem = project['systemPrompt'] as String?;
        _projectAppend = project['appendSystemPrompt'] as String?;
      } else {
        _error = result.error ?? 'load_failed';
      }
    });
  }

  Future<void> _save(String kind, String content) async {
    final connected = await ensurePiHostConnected(context);
    if (!mounted || !connected) return;
    final projectId = _scope == _Scope.project && _projectPath.isNotEmpty
        ? _projectPath
        : PiHostService.kEngineProjectId;
    final result = await _service.control(
      'write_prompt_file',
      projectId: projectId,
      payload: {
        'scope': _scope == _Scope.project ? 'project' : 'global',
        'kind': kind,
        'content': content,
      },
    );
    if (!mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    if (result.ok) {
      messenger.showSnackBar(
        SnackBar(content: Text(AppLocalizations.of(context).piEngineSaved)),
      );
      await _load();
    } else {
      messenger.showSnackBar(
        SnackBar(
          content: Text(
            AppLocalizations.of(context).piEngineError(
              result.error ?? 'write failed',
            ),
          ),
        ),
      );
    }
  }

  Future<void> _editFile({
    required String title,
    required String? current,
    required String kind,
    required String hint,
  }) async {
    final l = AppLocalizations.of(context);
    final controller = TextEditingController(text: current ?? '');
    final saved = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(title),
        content: SizedBox(
          width: 480,
          child: TextField(
            controller: controller,
            autofocus: true,
            maxLines: 18,
            minLines: 10,
            style: const TextStyle(fontFamily: 'monospace'),
            decoration: InputDecoration(
              border: const OutlineInputBorder(),
              hintText: hint,
              alignLabelWithHint: true,
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: Text(l.cancel),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, controller.text),
            child: Text(l.save),
          ),
        ],
      ),
    );
    controller.dispose();
    if (saved != null) {
      await _save(kind, saved);
    }
  }

  String _preview(String? content) {
    if (content == null || content.isEmpty) {
      return AppLocalizations.of(context).piEnginePromptEmpty;
    }
    final single = content.replaceAll('\n', ' ').trim();
    return single.length > 80 ? '${single.substring(0, 80)}…' : single;
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(l.piEngineSystemPrompts)),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.only(bottom: 32),
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 16, 16, 0),
              child: SegmentedButton<_Scope>(
                segments: [
                  ButtonSegment(
                    value: _Scope.global,
                    label: Text(l.piEngineScopeGlobal),
                  ),
                  ButtonSegment(
                    value: _Scope.project,
                    label: Text(l.piEngineScopeProject),
                  ),
                ],
                selected: {_scope},
                onSelectionChanged: (selection) {
                  setState(() => _scope = selection.first);
                  unawaited(_load());
                },
              ),
            ),
            if (_scope == _Scope.project) _buildProjectPath(l),
            if (_error != null) _buildError(l),
            if (_loading)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 48),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (_error == null) ...[
              SettingsSectionHeader(title: l.piEngineSystemPrompt),
              _PromptFileCard(
                children: [
                  _fileTile(
                    title: l.piEngineSystemPromptTitle,
                    subtitle: _preview(
                      _scope == _Scope.project ? _projectSystem : _globalSystem,
                    ),
                    kind: 'system',
                  ),
                  const Divider(height: 1, indent: 56),
                  _fileTile(
                    title: l.piEngineAppendSystemPromptTitle,
                    subtitle: _preview(
                      _scope == _Scope.project ? _projectAppend : _globalAppend,
                    ),
                    kind: 'append',
                  ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildProjectPath(AppLocalizations l) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 0),
      child: Row(
        children: [
          Expanded(
            child: TextField(
              key: const ValueKey('project_path_field'),
              controller: TextEditingController(text: _projectPath),
              decoration: InputDecoration(
                labelText: l.piEngineProjectPath,
                hintText: '/sdcard/Projects/my-app',
                border: const OutlineInputBorder(),
                isDense: true,
              ),
              onChanged: (v) => _projectPath = v.trim(),
            ),
          ),
          const SizedBox(width: 8),
          FilledButton.tonal(
            onPressed: () {
              setState(() {});
              unawaited(_load());
            },
            child: Text(AppLocalizations.of(context).piEngineLoad),
          ),
        ],
      ),
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

  Widget _fileTile({
    required String title,
    required String subtitle,
    required String kind,
  }) {
    final l = AppLocalizations.of(context);
    return ListTile(
      leading: Icon(
        kind == 'system' ? Icons.article_outlined : Icons.add_comment_outlined,
        color: Theme.of(context).colorScheme.onSurfaceVariant,
      ),
      title: Text(title),
      subtitle: Text(subtitle, maxLines: 2, overflow: TextOverflow.ellipsis),
      trailing: const Icon(Icons.edit_outlined),
      onTap: () => _editFile(
        title: title,
        current: _scope == _Scope.project
            ? (kind == 'system' ? _projectSystem : _projectAppend)
            : (kind == 'system' ? _globalSystem : _globalAppend),
        kind: kind,
        hint: l.piEnginePromptHint,
      ),
    );
  }
}

class _PromptFileCard extends StatelessWidget {
  const _PromptFileCard({required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    // Theme-default card surface (same as the settings screen sections).
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 16),
      child: Column(children: children),
    );
  }
}
