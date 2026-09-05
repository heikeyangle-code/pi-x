import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../l10n/app_localizations.dart';
import '../../services/pi_host_service.dart';
import 'pi_engine_packages.dart';
import 'pi_engine_widgets.dart';

/// Manage pi packages (`pi install/list/remove/update`, docs/ENGINE-UI-SURFACES
/// §6.1): npm / git / local sources configured in `settings.json` `packages[]`.
///
/// Mirrors the engine's package-manager 1:1: user scope (`~/.pi/agent`) and
/// project scope (`.pi/`), identity-deduped entries, and install/remove/update
/// operations that hit npm/git on the host. The engine re-reads configured
/// sources when it resolves resources, so npm/git artifact changes typically
/// apply after a restart or `/reload`; the screen surfaces that hint.
class PackagesScreen extends StatefulWidget {
  const PackagesScreen({super.key, this.projectPath});

  /// Workspace path used to resolve the project scope; null = global only.
  final String? projectPath;

  @override
  State<PackagesScreen> createState() => _PackagesScreenState();
}

class _PackagesScreenState extends State<PackagesScreen> {
  bool _loading = true;
  bool _busy = false;
  String? _error;
  List<PiPackageInfo> _packages = const [];
  late final String _projectPath = widget.projectPath ?? '';

  PiHostService get _service => context.read<PiHostService>();

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
      'list_packages',
      projectId: _projectId,
    );
    if (!mounted) return;
    setState(() {
      _loading = false;
      if (result.ok) {
        final raw = result.data;
        _packages = raw is List
            ? raw
                .whereType<Map>()
                .map((p) => PiPackageInfo.fromJson(p.cast<String, dynamic>()))
                .toList()
            : const <PiPackageInfo>[];
        _error = null;
      } else {
        _error = result.error ?? 'load_failed';
      }
    });
  }

  Future<void> _runOp({
    required String op,
    Map<String, dynamic>? payload,
    required String busyLabel,
    required String Function(AppLocalizations) doneLabel,
  }) async {
    final l = AppLocalizations.of(context);
    final messenger = ScaffoldMessenger.of(context);
    if (_busy) return;
    setState(() => _busy = true);
    messenger
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(busyLabel)));
    final result = await _service.control(op, projectId: _projectId, payload: payload);
    if (!mounted) return;
    setState(() => _busy = false);
    messenger
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          content: Text(
            result.ok ? doneLabel(l) : l.piEngineError(result.error ?? 'op failed'),
          ),
        ),
      );
    if (result.ok) await _load();
  }

  Future<void> _install() async {
    final l = AppLocalizations.of(context);
    final sourceController = TextEditingController();
    bool local = false;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) => AlertDialog(
          title: Text(l.piEnginePackagesInstall),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                TextField(
                  key: const ValueKey('package_source'),
                  controller: sourceController,
                  autofocus: true,
                  decoration: InputDecoration(
                    labelText: l.piEnginePackagesSourceLabel,
                    hintText: 'npm:lodash',
                    helperText: l.piEnginePackagesSourceHint,
                    border: const OutlineInputBorder(),
                  ),
                  onSubmitted: (_) => Navigator.pop(ctx, true),
                ),
                const SizedBox(height: 12),
                SwitchListTile(
                  key: const ValueKey('package_local'),
                  contentPadding: EdgeInsets.zero,
                  title: Text(l.piEnginePackagesInstallLocal),
                  subtitle: Text(
                    l.piEnginePackagesInstallLocalDesc,
                    style: Theme.of(ctx).textTheme.bodySmall,
                  ),
                  value: local,
                  onChanged: (value) => setDialogState(() => local = value),
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
              child: Text(l.piEnginePackagesInstall),
            ),
          ],
        ),
      ),
    );
    final source = sourceController.text.trim();
    sourceController.dispose();
    if (confirmed != true || source.isEmpty || !mounted) return;
    await _runOp(
      op: 'install_package',
      payload: {'source': source, 'local': local},
      busyLabel: l.piEnginePackagesInstalling(source),
      doneLabel: (l) => l.piEngineSaved,
    );
  }

  Future<void> _updateAll() async {
    final l = AppLocalizations.of(context);
    await _runOp(
      op: 'update_packages',
      busyLabel: l.piEnginePackagesUpdating,
      doneLabel: (l) => l.piEnginePackagesUpdated(_packages.length),
    );
  }

  Future<void> _updateOne(PiPackageInfo pkg) async {
    final l = AppLocalizations.of(context);
    await _runOp(
      op: 'update_packages',
      payload: {'source': pkg.source},
      busyLabel: l.piEnginePackagesUpdating,
      doneLabel: (l) => l.piEnginePackagesUpdated(1),
    );
  }

  Future<void> _remove(PiPackageInfo pkg) async {
    final l = AppLocalizations.of(context);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(l.piEnginePackagesRemove),
        content: Text('${l.piEnginePackagesRemoveConfirm(pkg.source)}\n\n${l.piEnginePackagesRemoveConfirmBody}'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text(l.cancel),
          ),
          FilledButton(
            key: const ValueKey('confirm_remove_package'),
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(l.piEnginePackagesRemove),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    await _runOp(
      op: 'remove_package',
      payload: {'source': pkg.source, 'local': pkg.isProject},
      busyLabel: l.piEnginePackagesRemoving(pkg.source),
      doneLabel: (l) => l.piEnginePackagesRemoved(pkg.source),
    );
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final cs = Theme.of(context).colorScheme;
    final project = _packages.where((p) => p.isProject).toList();
    final global = _packages.where((p) => !p.isProject).toList();

    return Scaffold(
      appBar: AppBar(
        title: Text(l.piEnginePackages),
        actions: [
          IconButton(
            key: const ValueKey('update_all_packages'),
            tooltip: l.piEnginePackagesUpdateAll,
            icon: const Icon(Icons.refresh),
            onPressed: (_loading || _busy || _packages.isEmpty) ? null : _updateAll,
          ),
          IconButton(
            key: const ValueKey('install_package'),
            tooltip: l.piEnginePackagesInstall,
            icon: const Icon(Icons.add),
            onPressed: (_loading || _busy) ? null : _install,
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
                l.piEnginePackagesHint,
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
            else if (_error == null && _packages.isEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 48),
                child: Center(
                  child: Text(
                    l.piEnginePackagesEmpty,
                    style: TextStyle(color: cs.onSurfaceVariant),
                  ),
                ),
              )
            else if (_error == null) ...[
              SettingsSectionHeader(
                title: l.piEnginePackagesCount(_packages.length),
              ),
              if (project.isNotEmpty) ...[
                SettingsSectionHeader(title: l.piEnginePackagesGroupProject),
                _PackageCard(
                  packages: project,
                  busy: _busy,
                  onRemove: _remove,
                  onUpdate: _updateOne,
                ),
              ],
              if (global.isNotEmpty) ...[
                SettingsSectionHeader(title: l.piEnginePackagesGroupGlobal),
                _PackageCard(
                  packages: global,
                  busy: _busy,
                  onRemove: _remove,
                  onUpdate: _updateOne,
                ),
              ],
              const SizedBox(height: 16),
              SettingsSectionHeader(title: l.piEngineExtensionsApply),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: Text(
                  l.piEnginePackagesRestartHint,
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: cs.onSurfaceVariant,
                  ),
                ),
              ),
              const SizedBox(height: 12),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: FilledButton.tonalIcon(
                  onPressed: _busy ? null : () => confirmRestartEngine(context, _service),
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
}

/// One grouped package list (project or global scope) — same card layout as
/// the extensions/prompts screens.
class _PackageCard extends StatelessWidget {
  const _PackageCard({
    required this.packages,
    required this.busy,
    required this.onRemove,
    required this.onUpdate,
  });

  final List<PiPackageInfo> packages;
  final bool busy;
  final ValueChanged<PiPackageInfo> onRemove;
  final ValueChanged<PiPackageInfo> onUpdate;

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final cs = Theme.of(context).colorScheme;
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 16),
      child: Column(
        children: [
          for (var i = 0; i < packages.length; i++) ...[
            if (i > 0) const Divider(height: 1, indent: 56),
            _PackageTile(
              pkg: packages[i],
              busy: busy,
              accent: cs.primary,
              onRemove: () => onRemove(packages[i]),
              onUpdate: () => onUpdate(packages[i]),
              notInstalledLabel: l.piEnginePackagesNotInstalled,
              installedLabel: l.piEnginePackagesInstalled,
              updateLabel: l.piEnginePackagesUpdate,
              removeLabel: l.piEnginePackagesRemove,
            ),
          ],
        ],
      ),
    );
  }
}

class _PackageTile extends StatelessWidget {
  const _PackageTile({
    required this.pkg,
    required this.busy,
    required this.accent,
    required this.onRemove,
    required this.onUpdate,
    required this.notInstalledLabel,
    required this.installedLabel,
    required this.updateLabel,
    required this.removeLabel,
  });

  final PiPackageInfo pkg;
  final bool busy;
  final Color accent;
  final VoidCallback onRemove;
  final VoidCallback onUpdate;
  final String notInstalledLabel;
  final String installedLabel;
  final String updateLabel;
  final String removeLabel;

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final subtitleParts = <String>[
      pkg.source,
      if (pkg.version != null) 'v${pkg.version}',
      if (pkg.resourceTypes.isNotEmpty) pkg.resourceTypes.join(' · '),
    ];
    return ListTile(
      key: ValueKey('package_${pkg.scope}_${pkg.source}'),
      leading: Icon(
        pkg.type == 'npm'
            ? Icons.inventory_2_outlined
            : pkg.type == 'git'
                ? Icons.account_tree_outlined
                : Icons.folder_outlined,
        size: 22,
        color: pkg.isInstalled ? accent : cs.onSurfaceVariant,
      ),
      title: Row(
        children: [
          Flexible(
            child: Text(
              pkg.label,
              style: const TextStyle(
                fontFamily: 'monospace',
                fontWeight: FontWeight.w600,
                fontSize: 15,
              ),
              overflow: TextOverflow.ellipsis,
            ),
          ),
          if (!pkg.isInstalled) ...[
            const SizedBox(width: 8),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
              decoration: BoxDecoration(
                color: cs.errorContainer,
                borderRadius: BorderRadius.circular(6),
              ),
              child: Text(
                notInstalledLabel,
                style: TextStyle(fontSize: 11, color: cs.onErrorContainer),
              ),
            ),
          ],
        ],
      ),
      subtitle: Text(
        subtitleParts.join('  ·  '),
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
        style: Theme.of(context).textTheme.bodySmall?.copyWith(
          color: cs.onSurfaceVariant,
        ),
      ),
      trailing: PopupMenuButton<String>(
        enabled: !busy,
        onSelected: (action) {
          switch (action) {
            case 'update':
              onUpdate();
            case 'remove':
              onRemove();
          }
        },
        itemBuilder: (ctx) => [
          if (pkg.isInstalled && !pkg.isPinnedNpm)
            PopupMenuItem(value: 'update', child: Text(updateLabel)),
          PopupMenuItem(value: 'remove', child: Text(removeLabel)),
        ],
      ),
      dense: true,
    );
  }
}
