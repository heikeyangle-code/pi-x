import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../l10n/app_localizations.dart';
import '../../services/pi_host_service.dart';
import 'pi_engine_widgets.dart';

/// Quick edit for AGENTS.md / CLAUDE.md (docs/ENGINE-UI-SURFACES §6.1 #13).
///
/// pi merges these files walking UP from the project root. This screen shows
/// the project-local target for each file plus any higher-up copy that
/// currently feeds the engine, and edits the project-local file (created on
/// demand) through the PiHost surface ops:
///   get_context_files  -> {cwd, files:[{name, path, targetPath}]}
///   read_context_file  -> {name} -> {path, content, created}
///   write_context_file -> {name, content} -> {path}
class ContextFilesScreen extends StatefulWidget {
  const ContextFilesScreen({super.key, this.projectPath});

  /// Workspace path; when set it becomes the project id (and thus the cwd)
  /// for the PiHost surface ops.
  final String? projectPath;

  @override
  State<ContextFilesScreen> createState() => _ContextFilesScreenState();
}

class _ContextFilesScreenState extends State<ContextFilesScreen> {
  bool _loading = true;
  bool _saving = false;
  String? _error;
  List<ContextFileInfo> _files = const [];

  PiHostService get _service => context.read<PiHostService>();

  String get _projectId =>
      (widget.projectPath?.isNotEmpty ?? false)
          ? widget.projectPath!
          : PiHostService.kEngineProjectId;

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
    final result = await _service.control('get_context_files', projectId: _projectId);
    if (!mounted) return;
    setState(() {
      _loading = false;
      if (result.ok && result.data is Map<String, dynamic>) {
        final data = result.data as Map<String, dynamic>;
        final files = data['files'];
        _files = files is List
            ? files
                .whereType<Map>()
                .map((f) => ContextFileInfo.fromJson(f.cast<String, dynamic>()))
                .toList()
            : const <ContextFileInfo>[];
        _error = null;
      } else {
        _error = result.error ?? 'load_failed';
      }
    });
  }

  Future<void> _edit(ContextFileInfo info) async {
    final connected = await ensurePiHostConnected(context);
    if (!mounted || !connected) return;
    final result = await _service.control(
      'read_context_file',
      projectId: _projectId,
      payload: {'name': info.name},
    );
    if (!mounted) return;
    final content = result.ok && result.data is Map<String, dynamic>
        ? (result.data as Map<String, dynamic>)['content'] as String? ?? ''
        : null;
    if (content == null) {
      final messenger = ScaffoldMessenger.of(context);
      messenger.showSnackBar(
        SnackBar(
          content: Text(
            AppLocalizations.of(context).piEngineError(result.error ?? 'read failed'),
          ),
        ),
      );
      return;
    }
    final saved = await Navigator.of(context).push<String>(
      MaterialPageRoute(
        builder: (_) => _ContextFileEditor(
          name: info.name,
          initial: content,
        ),
      ),
    );
    if (!mounted || saved == null) return;
    setState(() => _saving = true);
    final writeResult = await _service.control(
      'write_context_file',
      projectId: _projectId,
      payload: {'name': info.name, 'content': saved},
    );
    if (!mounted) return;
    setState(() => _saving = false);
    final messenger = ScaffoldMessenger.of(context);
    final l = AppLocalizations.of(context);
    if (writeResult.ok) {
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(content: Text(l.piEngineSaved)));
      await _load();
    } else {
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(
          SnackBar(
            content: Text(l.piEngineError(writeResult.error ?? 'write failed')),
          ),
        );
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final cs = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(
        title: Text(l.piEngineContextFiles),
        actions: [
          if (_saving)
            const Padding(
              padding: EdgeInsets.symmetric(horizontal: 16),
              child: Center(
                child: SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
              ),
            ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.only(bottom: 32),
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
              child: Text(
                l.piEngineContextFilesHint,
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
            else if (_error == null) ...[
              for (final info in _files)
                Card(
                  margin: const EdgeInsets.fromLTRB(16, 12, 16, 0),
                  child: ListTile(
                    key: ValueKey('context_${info.name}'),
                    leading: CircleAvatar(
                      radius: 18,
                      backgroundColor: cs.primaryContainer,
                      child: Icon(
                        Icons.description_outlined,
                        size: 20,
                        color: cs.onPrimaryContainer,
                      ),
                    ),
                    title: Text(
                      info.name,
                      style: const TextStyle(
                        fontFamily: 'monospace',
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    subtitle: Text(_subtitle(l, info)),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: _saving ? null : () => _edit(info),
                  ),
                ),
            ],
            const SizedBox(height: 16),
          ],
        ),
      ),
    );
  }

  String _subtitle(AppLocalizations l, ContextFileInfo info) {
    final target = info.targetPath;
    final path = info.path;
    if (path != null && path == target) {
      return l.piEngineContextFilesProject(path);
    }
    if (path != null) {
      return '${l.piEngineContextFilesParent(path)}\n'
          '${l.piEngineContextFilesProject(target)}';
    }
    return l.piEngineContextFilesNew(target);
  }
}

/// Project context file descriptor (mirrors the bridge `get_context_files`).
class ContextFileInfo {
  const ContextFileInfo({
    required this.name,
    required this.path,
    required this.targetPath,
  });

  factory ContextFileInfo.fromJson(Map<String, dynamic> json) => ContextFileInfo(
        name: json['name'] as String? ?? '',
        path: json['path'] as String?,
        targetPath: json['targetPath'] as String? ?? '',
      );

  /// Canonical file name ("AGENTS.md" | "CLAUDE.md").
  final String name;

  /// Nearest existing file walking up from the project root (null = none).
  final String? path;

  /// Project-local write target: `<cwd>/<name>`.
  final String targetPath;
}

/// Full-screen monospace editor; pops with the edited text on save.
class _ContextFileEditor extends StatefulWidget {
  const _ContextFileEditor({required this.name, required this.initial});

  final String name;
  final String initial;

  @override
  State<_ContextFileEditor> createState() => _ContextFileEditorState();
}

class _ContextFileEditorState extends State<_ContextFileEditor> {
  late final TextEditingController _controller =
      TextEditingController(text: widget.initial);
  bool _dirty = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _save() {
    Navigator.of(context).pop(_controller.text);
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    return Scaffold(
      appBar: AppBar(
        title: Text(l.piEngineContextFilesEdit(widget.name)),
        actions: [
          TextButton.icon(
            key: const ValueKey('save_context_file'),
            onPressed: _dirty ? _save : null,
            icon: const Icon(Icons.check),
            label: Text(l.save),
          ),
        ],
      ),
      body: Padding(
        padding: const EdgeInsets.all(12),
        child: TextField(
          key: const ValueKey('context_editor'),
          controller: _controller,
          maxLines: null,
          expands: true,
          textAlignVertical: TextAlignVertical.top,
          style: const TextStyle(fontFamily: 'monospace', fontSize: 13),
          decoration: const InputDecoration(
            border: OutlineInputBorder(),
            isDense: true,
          ),
          onChanged: (_) {
            if (!_dirty) setState(() => _dirty = true);
          },
        ),
      ),
    );
  }
}
