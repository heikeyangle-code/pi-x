import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../l10n/app_localizations.dart';
import '../../services/pi_host_service.dart';
import 'pi_engine_skills.dart';
import 'pi_engine_widgets.dart';

/// Browse pi skills discovered in `~/.pi/agent/skills/` (global) and
/// `.pi/skills/` (project), and read each skill's SKILL.md
/// (`list_skills` / `read_skill`, docs/ENGINE-UI-SURFACES §6.1).
///
/// Skills are Agent-skills prompts that guide the model — they can make it run
/// commands, so the screen leads with a safety note. Loading/injection stays
/// engine-side; skills are scanned at engine startup, so new/changed skills
/// apply after a restart (reuses the shared restart flow).
class SkillsScreen extends StatefulWidget {
  const SkillsScreen({super.key});

  @override
  State<SkillsScreen> createState() => _SkillsScreenState();
}

class _SkillsScreenState extends State<SkillsScreen> {
  bool _loading = true;
  String? _error;
  List<PiSkill> _skills = const [];

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
    final result = await _service.control('list_skills');
    if (!mounted) return;
    setState(() {
      _loading = false;
      if (result.ok) {
        final raw = result.data;
        _skills = raw is List
            ? raw
                .whereType<Map>()
                .map((s) => PiSkill.fromJson(s.cast<String, dynamic>()))
                .toList()
            : const <PiSkill>[];
        _error = null;
      } else {
        _error = result.error ?? 'load_failed';
      }
    });
  }

  Future<void> _viewSkill(PiSkill skill) async {
    final l = AppLocalizations.of(context);
    final connected = await ensurePiHostConnected(context);
    if (!mounted || !connected) return;
    final result = await _service.control(
      'read_skill',
      payload: {'scope': skill.scope, 'name': skill.name},
    );
    if (!mounted) return;
    final content = result.ok
        ? (result.data as Map<String, dynamic>?)?['content'] as String?
        : null;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (ctx) => DraggableScrollableSheet(
        expand: false,
        initialChildSize: 0.7,
        minChildSize: 0.4,
        maxChildSize: 0.95,
        builder: (ctx, controller) => Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
              child: Text(
                skill.name,
                style: Theme.of(ctx).textTheme.titleMedium?.copyWith(
                  fontFamily: 'monospace',
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
            Divider(height: 1, color: Theme.of(ctx).colorScheme.outlineVariant),
            Expanded(
              child: content == null
                  ? Center(
                      child: Text(
                        result.ok
                            ? l.piEngineSkillMissing
                            : l.piEngineError(result.error ?? 'read failed'),
                        style: TextStyle(
                          color: Theme.of(ctx).colorScheme.onSurfaceVariant,
                        ),
                      ),
                    )
                  : SingleChildScrollView(
                      controller: controller,
                      padding: const EdgeInsets.all(20),
                      child: SelectableText(
                        content,
                        style: const TextStyle(fontSize: 13, height: 1.5),
                      ),
                    ),
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final cs = Theme.of(context).colorScheme;
    final project = _skills.where((s) => s.isProject).toList();
    final global = _skills.where((s) => !s.isProject).toList();

    return Scaffold(
      appBar: AppBar(title: Text(l.piEngineSkills)),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.only(bottom: 32),
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
              child: Material(
                color: cs.errorContainer,
                borderRadius: BorderRadius.circular(12),
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Icon(
                        Icons.warning_amber_rounded,
                        size: 20,
                        color: cs.onErrorContainer,
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Text(
                          l.piEngineSkillsTrustWarning,
                          style: TextStyle(
                            fontSize: 13,
                            color: cs.onErrorContainer,
                          ),
                        ),
                      ),
                    ],
                  ),
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
            else if (_error == null && _skills.isEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 48),
                child: Center(
                  child: Text(
                    l.piEngineSkillsEmpty,
                    style: TextStyle(color: cs.onSurfaceVariant),
                  ),
                ),
              )
            else if (_error == null) ...[
              if (project.isNotEmpty) ...[
                SettingsSectionHeader(title: l.piEngineSkillsGroupProject),
                _SkillList(
                  skills: project,
                  onTap: _viewSkill,
                ),
              ],
              if (global.isNotEmpty) ...[
                SettingsSectionHeader(
                  title: l.piEngineSkillsCount(global.length),
                ),
                _SkillList(
                  skills: global,
                  onTap: _viewSkill,
                ),
              ],
            ],
            const SizedBox(height: 16),
            SettingsSectionHeader(title: l.piEngineSkillsApply),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: Text(
                l.piEngineSkillsRestartHint,
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: cs.onSurfaceVariant,
                ),
              ),
            ),
            const SizedBox(height: 12),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: FilledButton.tonalIcon(
                onPressed: () => confirmRestartEngine(context, _service),
                icon: const Icon(Icons.restart_alt),
                label: Text(l.piEngineRestartEngine),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _SkillList extends StatelessWidget {
  const _SkillList({required this.skills, required this.onTap});

  final List<PiSkill> skills;
  final ValueChanged<PiSkill> onTap;

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 16),
      child: Column(
        children: [
          for (var i = 0; i < skills.length; i++) ...[
            if (i > 0) const Divider(height: 1, indent: 56),
            ListTile(
              key: ValueKey('skill_${skills[i].name}'),
              leading: Icon(
                Icons.auto_awesome_outlined,
                size: 22,
                color: cs.primary,
              ),
              title: Text(
                skills[i].name,
                style: const TextStyle(
                  fontFamily: 'monospace',
                  fontWeight: FontWeight.w600,
                  fontSize: 15,
                ),
              ),
              subtitle: skills[i].description.isEmpty
                  ? null
                  : Text(
                      skills[i].description,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                    ),
              trailing: const Icon(Icons.chevron_right, size: 20),
              dense: true,
              onTap: () => onTap(skills[i]),
            ),
          ],
        ],
      ),
    );
  }
}
