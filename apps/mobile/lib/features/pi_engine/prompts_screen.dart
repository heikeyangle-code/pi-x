import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../l10n/app_localizations.dart';
import '../../services/pi_host_service.dart';
import 'pi_engine_prompts.dart';
import 'pi_engine_widgets.dart';

/// Manage pi prompt templates (`~/.pi/agent/prompts/` global +
/// `<workspace>/.pi/prompts/` project, docs/ENGINE-UI-SURFACES §6.1).
///
/// Lists templates grouped by scope, reads their markdown on edit, and writes
/// them back through the PiHost surface ops. The engine resolves templates on
/// each `get_commands`/prompt, so edits apply immediately — no restart needed
/// (unlike skills).
class PromptsScreen extends StatefulWidget {
  const PromptsScreen({super.key, this.projectPath});

  /// Workspace path for the project scope; null = global-only until a path
  /// is picked in the editor.
  final String? projectPath;

  @override
  State<PromptsScreen> createState() => _PromptsScreenState();
}

class _PromptsScreenState extends State<PromptsScreen> {
  bool _loading = true;
  String? _error;
  List<PiPromptTemplate> _templates = const [];
  late final String _projectPath = widget.projectPath ?? '';

  PiHostService get _service => context.read<PiHostService>();

  /// Project id passed to the PiHost surface: the real workspace path when a
  /// project scope is in play, otherwise the synthetic engine project.
  String get _projectId =>
      _projectPath.isNotEmpty ? _projectPath : PiHostService.kEngineProjectId;

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
    final result = await _service.control(
      'list_prompt_templates',
      projectId: _projectId,
    );
    if (!mounted) return;
    setState(() {
      _loading = false;
      if (result.ok) {
        final raw = result.data;
        _templates = raw is List
            ? raw
                .whereType<Map>()
                .map((t) => PiPromptTemplate.fromJson(t.cast<String, dynamic>()))
                .toList()
            : const <PiPromptTemplate>[];
        _error = null;
      } else {
        _error = result.error ?? 'load_failed';
      }
    });
  }

  Future<String?> _readContent(PiPromptTemplate template) async {
    final result = await _service.control(
      'read_prompt_template',
      projectId: _projectId,
      payload: {'scope': template.scope, 'name': template.name},
    );
    if (result.ok && result.data is Map<String, dynamic>) {
      return (result.data as Map<String, dynamic>)['content'] as String?;
    }
    return null;
  }

  Future<void> _save({
    required String name,
    required String scope,
    required String content,
  }) async {
    final l = AppLocalizations.of(context);
    final messenger = ScaffoldMessenger.of(context);
    final result = await _service.control(
      'write_prompt_template',
      projectId: _projectId,
      payload: {'scope': scope, 'name': name, 'content': content},
    );
    if (!mounted) return;
    if (result.ok) {
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(content: Text(l.piEngineSaved)));
      await _load();
    } else {
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(
          SnackBar(content: Text(l.piEngineError(result.error ?? 'write failed'))),
        );
    }
  }

  Future<void> _delete(PiPromptTemplate template) async {
    final l = AppLocalizations.of(context);
    final messenger = ScaffoldMessenger.of(context);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(l.piEnginePromptsDelete),
        content: Text(l.piEnginePromptsDeleteConfirm(template.name)),
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
    if (confirmed != true || !mounted) return;
    final connected = await ensurePiHostConnected(context);
    if (!mounted || !connected) return;
    final result = await _service.control(
      'delete_prompt_template',
      projectId: _projectId,
      payload: {'scope': template.scope, 'name': template.name},
    );
    if (!mounted) return;
    if (result.ok) {
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(content: Text(l.piEngineSaved)));
      await _load();
    } else {
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(
          SnackBar(content: Text(l.piEngineError(result.error ?? 'delete failed'))),
        );
    }
  }

  Future<void> _showEditor({PiPromptTemplate? template}) async {
    final l = AppLocalizations.of(context);
    final isNew = template == null;
    final nameController = TextEditingController(
      text: isNew ? '' : template.name.replaceAll(RegExp(r'\.md$'), ''),
    );
    final contentController = TextEditingController();
    String scope = isNew ? 'global' : template.scope;
    bool contentLoaded = isNew;
    if (!isNew) {
      final content = await _readContent(template);
      if (!mounted) return;
      contentController.text = content ?? '';
      contentLoaded = content != null;
    }

    final saved = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) => AlertDialog(
          title: Text(
            isNew ? l.piEnginePromptsNew : l.piEnginePromptsEdit,
          ),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextField(
                  controller: nameController,
                  enabled: isNew,
                  decoration: InputDecoration(
                    labelText: l.piEnginePromptsNewName,
                    hintText: 'code-review',
                    border: const OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 12),
                if (isNew) ...[
                  DropdownButtonFormField<String>(
                    initialValue: scope,
                    decoration: InputDecoration(
                      labelText: l.piEnginePromptsScope,
                      border: const OutlineInputBorder(),
                    ),
                    items: [
                      DropdownMenuItem(
                        value: 'global',
                        child: Text(l.piEnginePromptsScopeGlobal),
                      ),
                      if (_projectPath.isNotEmpty)
                        DropdownMenuItem(
                          value: 'project',
                          child: Text(l.piEnginePromptsScopeProject),
                        ),
                    ],
                    onChanged: (value) {
                      if (value != null) {
                        setDialogState(() => scope = value);
                      }
                    },
                  ),
                  const SizedBox(height: 12),
                ],
                TextField(
                  controller: contentController,
                  minLines: 5,
                  maxLines: 14,
                  enabled: contentLoaded,
                  decoration: InputDecoration(
                    labelText: l.piEnginePromptsContent,
                    alignLabelWithHint: true,
                    border: const OutlineInputBorder(),
                    hintText:
                        '---\ndescription: Review the diff and flag bugs\n---\n\nYou are reviewing the current changes.\n',
                  ),
                ),
                if (!contentLoaded)
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Text(
                      l.piEngineError('read failed'),
                      style: TextStyle(color: Theme.of(ctx).colorScheme.error),
                    ),
                  ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: Text(l.cancel),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: Text(l.save),
            ),
          ],
        ),
      ),
    );
    final name = nameController.text.trim();
    final content = contentController.text;
    nameController.dispose();
    contentController.dispose();
    if (saved != true || name.isEmpty || !contentLoaded) return;
    await _save(name: name, scope: scope, content: content);
  }

  Future<void> _copy(PiPromptTemplate template) async {
    final l = AppLocalizations.of(context);
    final messenger = ScaffoldMessenger.of(context);
    await Clipboard.setData(ClipboardData(text: template.invocation));
    messenger
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(l.piEnginePromptsCopied(template.invocation))));
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final cs = Theme.of(context).colorScheme;
    final project = _templates.where((t) => t.isProject).toList();
    final global = _templates.where((t) => !t.isProject).toList();

    return Scaffold(
      appBar: AppBar(
        title: Text(l.piEnginePrompts),
        actions: [
          IconButton(
            key: const ValueKey('add_prompt'),
            tooltip: l.piEnginePromptsNew,
            icon: const Icon(Icons.add),
            onPressed: _loading ? null : () => _showEditor(),
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
                l.piEnginePromptsHint,
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
            else if (_error == null && _templates.isEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 48),
                child: Center(
                  child: Text(
                    l.piEnginePromptsEmpty,
                    style: TextStyle(color: cs.onSurfaceVariant),
                  ),
                ),
              )
            else if (_error == null) ...[
              if (project.isNotEmpty) ...[
                SettingsSectionHeader(title: l.piEnginePromptsGroupProject),
                _TemplateList(
                  templates: project,
                  accent: cs.tertiary,
                  onTap: (t) => _showEditor(template: t),
                  onDelete: _delete,
                  onCopy: _copy,
                ),
              ],
              if (global.isNotEmpty) ...[
                SettingsSectionHeader(title: l.piEnginePromptsGroupGlobal),
                _TemplateList(
                  templates: global,
                  accent: cs.secondary,
                  onTap: (t) => _showEditor(template: t),
                  onDelete: _delete,
                  onCopy: _copy,
                ),
              ],
            ],
          ],
        ),
      ),
    );
  }
}

class _TemplateList extends StatelessWidget {
  const _TemplateList({
    required this.templates,
    required this.accent,
    required this.onTap,
    required this.onDelete,
    required this.onCopy,
  });

  final List<PiPromptTemplate> templates;
  final Color accent;
  final ValueChanged<PiPromptTemplate> onTap;
  final ValueChanged<PiPromptTemplate> onDelete;
  final ValueChanged<PiPromptTemplate> onCopy;

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 16),
      child: Column(
        children: [
          for (var i = 0; i < templates.length; i++) ...[
            if (i > 0) const Divider(height: 1, indent: 56),
            ListTile(
              key: ValueKey('prompt_${templates[i].name}'),
              leading: Icon(Icons.notes, size: 22, color: accent),
              title: Text(
                templates[i].invocation,
                style: const TextStyle(
                  fontFamily: 'monospace',
                  fontWeight: FontWeight.w600,
                  fontSize: 15,
                ),
              ),
              subtitle: templates[i].description.isEmpty
                  ? null
                  : Text(
                      templates[i].description,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                    ),
              trailing: PopupMenuButton<String>(
                onSelected: (action) {
                  switch (action) {
                    case 'copy':
                      onCopy(templates[i]);
                    case 'edit':
                      onTap(templates[i]);
                    case 'delete':
                      onDelete(templates[i]);
                  }
                },
                itemBuilder: (ctx) => [
                  PopupMenuItem(value: 'copy', child: Text(l.piEnginePromptsCopy)),
                  PopupMenuItem(value: 'edit', child: Text(l.piEnginePromptsEdit)),
                  PopupMenuItem(value: 'delete', child: Text(l.piEnginePromptsDelete)),
                ],
              ),
              dense: true,
              onTap: () => onTap(templates[i]),
            ),
          ],
        ],
      ),
    );
  }
}
