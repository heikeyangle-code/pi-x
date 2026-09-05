import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../l10n/app_localizations.dart';
import '../../services/pi_host_service.dart';
import 'pi_engine_runtime.dart';
import 'pi_engine_widgets.dart';

/// Runtime route management (docs/ENGINE-BUNDLE.md "路线切换 UI 落地").
///
/// Three explicit routes — A (bionic, built-in) / B1 (Proroot, recommended) /
/// B2 (proot-distro) — are offered as radio cards. Switching writes the route
/// through `set_runtime_route` (the PiHost persists it and restarts the
/// engine); an uninstalled B route is downloaded first via `runtime_install`.
class RuntimeScreen extends StatefulWidget {
  const RuntimeScreen({super.key});

  @override
  State<RuntimeScreen> createState() => _RuntimeScreenState();
}

class _RuntimeScreenState extends State<RuntimeScreen> {
  bool _loading = true;
  bool _busy = false;
  String? _error;
  RuntimeStatus? _status;
  bool _showComparison = false;

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
    final result = await _service.control('get_runtime_status');
    if (!mounted) return;
    setState(() {
      _loading = false;
      if (result.ok) {
        _status = RuntimeStatus.fromJson(
          result.data is Map<String, dynamic>
              ? result.data as Map<String, dynamic>
              : null,
        );
        _error = null;
      } else {
        _error = result.error ?? 'load_failed';
      }
    });
  }

  Future<void> _select(RuntimeRoute target) async {
    final status = _status;
    if (status == null || _busy) return;
    if (target == status.route) return;

    final l = AppLocalizations.of(context);
    final messenger = ScaffoldMessenger.of(context);

    if (target == RuntimeRoute.bionic) {
      // Back to the built-in environment: proot stays installed and can be
      // re-selected anytime (docs "切换确认").
      final confirmed = await _confirm(
        title: l.piEngineRuntimeRouteBionic,
        body: l.piEngineRuntimeSwitchConfirmA,
      );
      if (confirmed != true) return;
      await _switchTo(target, messenger);
      return;
    }

    // Route B: install first when missing, then switch.
    if (!status.isInstalled(target)) {
      final confirmed = await _confirm(
        title: l.piEngineRuntimeInstall,
        body: l.piEngineRuntimeInstallConfirm(target.id),
      );
      if (confirmed != true) return;
      await _installThenSwitch(target, messenger);
      return;
    }

    final confirmed = await _confirm(
      title: l.piEngineRuntimeSwitch(target.id),
      body: l.piEngineRuntimeSwitchConfirmB(target.id),
    );
    if (confirmed != true) return;
    await _switchTo(target, messenger);
  }

  Future<bool?> _confirm({required String title, required String body}) {
    final l = AppLocalizations.of(context);
    return showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(title),
        content: Text(body),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text(l.cancel),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(l.piEngineRuntimeSwitchAction),
          ),
        ],
      ),
    );
  }

  Future<void> _switchTo(
    RuntimeRoute target,
    ScaffoldMessengerState messenger,
  ) async {
    final l = AppLocalizations.of(context);
    setState(() => _busy = true);
    final result = await _service.control(
      'set_runtime_route',
      payload: {'route': target.id},
    );
    await _reloadAfterAction(messenger);
    setState(() => _busy = false);
    if (!mounted) return;
    messenger.showSnackBar(
      SnackBar(
        content: Text(
          result.ok
              ? l.piEngineRuntimeSwitched(target.id)
              : l.piEngineError(result.error ?? 'switch failed'),
        ),
      ),
    );
  }

  Future<void> _installThenSwitch(
    RuntimeRoute target,
    ScaffoldMessengerState messenger,
  ) async {
    final l = AppLocalizations.of(context);
    setState(() => _busy = true);
    messenger.showSnackBar(
      SnackBar(
        content: Text(l.piEngineRuntimeInstalling(target.id)),
        duration: const Duration(seconds: 10),
      ),
    );
    final install = await _service.control(
      'runtime_install',
      payload: {'route': target.id},
    );
    if (!mounted) return;
    if (!install.ok || install.success != true) {
      setState(() => _busy = false);
      messenger.hideCurrentSnackBar();
      messenger.showSnackBar(
        SnackBar(
          content: Text(
            l.piEngineError(install.error ?? 'install failed'),
          ),
        ),
      );
      return;
    }
    final switchResult = await _service.control(
      'set_runtime_route',
      payload: {'route': target.id},
    );
    await _reloadAfterAction(messenger);
    setState(() => _busy = false);
    if (!mounted) return;
    messenger.hideCurrentSnackBar();
    messenger.showSnackBar(
      SnackBar(
        content: Text(
          switchResult.ok
              ? l.piEngineRuntimeSwitched(target.id)
              : l.piEngineError(switchResult.error ?? 'switch failed'),
        ),
      ),
    );
  }

  Future<void> _reloadAfterAction(ScaffoldMessengerState messenger) async {
    final result = await _service.control('get_runtime_status');
    if (!mounted) return;
    if (result.ok && result.data is Map<String, dynamic>) {
      setState(() {
        _status = RuntimeStatus.fromJson(result.data as Map<String, dynamic>);
        _error = null;
      });
    } else {
      // Keep the stale status; the next manual refresh retries.
      messenger.showSnackBar(
        SnackBar(
          content: Text(AppLocalizations.of(context).piEngineError('reload failed')),
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    return Scaffold(
      appBar: AppBar(
        title: Text(l.piEngineRuntime),
        actions: [
          IconButton(
            tooltip: l.refresh,
            onPressed: _busy ? null : _load,
            icon: const Icon(Icons.refresh),
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
            else if (_error == null && _status != null) ...[
              _buildStatusBadge(l),
              _buildRouteCards(l),
              _buildComparison(l),
              _buildPackages(l),
              const Divider(height: 32),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: Text(
                  l.piEngineRuntimeRestartHint,
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
                ),
              ),
            ],
          ],
        ),
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

  Widget _buildStatusBadge(AppLocalizations l) {
    final status = _status!;
    final cs = Theme.of(context).colorScheme;
    final isB = status.route != RuntimeRoute.bionic;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 0),
      child: Material(
        color: cs.primaryContainer,
        borderRadius: BorderRadius.circular(16),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          child: Row(
            children: [
              Icon(
                isB ? Icons.layers_outlined : Icons.bolt_outlined,
                size: 20,
                color: cs.onPrimaryContainer,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  isB
                      ? '${l.piEngineRuntimeBadgeB} · ${_routeLabel(l, status.route)}'
                      : l.piEngineRuntimeBadgeA,
                  style: Theme.of(context).textTheme.titleSmall?.copyWith(
                    color: cs.onPrimaryContainer,
                  ),
                ),
              ),
              Text(
                l.piEngineRuntimeActive,
                style: Theme.of(context).textTheme.labelMedium?.copyWith(
                  color: cs.onPrimaryContainer,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildRouteCards(AppLocalizations l) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SettingsSectionHeader(title: l.piEngineRuntimeChoose),
        Card(
          margin: const EdgeInsets.symmetric(horizontal: 16),
          child: Column(
            children: [
              _RouteCard(
                key: const ValueKey('runtime_bionic'),
                title: l.piEngineRuntimeRouteBionic,
                subtitle: l.piEngineRuntimeRouteBionicDesc,
                icon: Icons.bolt_outlined,
                installed: true,
                selected: _status!.route == RuntimeRoute.bionic,
                busy: _busy,
                trailing: _status!.route == RuntimeRoute.bionic
                    ? _Badge(
                        text: l.piEngineRuntimeActive,
                        color: Theme.of(context).colorScheme.primary,
                      )
                    : null,
                onTap: () => _select(RuntimeRoute.bionic),
              ),
              const Divider(height: 1, indent: 56),
              _RouteCard(
                key: const ValueKey('runtime_proroot'),
                title: '${l.piEngineRuntimeRouteProroot} · ${l.piEngineRuntimeRecommended}',
                subtitle: l.piEngineRuntimeRouteProrootDesc,
                icon: Icons.terminal_outlined,
                installed: _status!.isInstalled(RuntimeRoute.proroot),
                selected: _status!.route == RuntimeRoute.proroot,
                busy: _busy,
                trailing: _installBadge(l, RuntimeRoute.proroot),
                onTap: () => _select(RuntimeRoute.proroot),
              ),
              const Divider(height: 1, indent: 56),
              _RouteCard(
                key: const ValueKey('runtime_proot_distro'),
                title: l.piEngineRuntimeRouteProotDistro,
                subtitle: l.piEngineRuntimeRouteProotDistroDesc,
                icon: Icons.storage_outlined,
                installed: _status!.isInstalled(RuntimeRoute.prootDistro),
                selected: _status!.route == RuntimeRoute.prootDistro,
                busy: _busy,
                trailing: _installBadge(l, RuntimeRoute.prootDistro),
                onTap: () => _select(RuntimeRoute.prootDistro),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget? _installBadge(AppLocalizations l, RuntimeRoute route) {
    final status = _status!;
    if (!status.isAvailable(route)) return null;
    if (status.route == route) {
      return _Badge(
        text: l.piEngineRuntimeActive,
        color: Theme.of(context).colorScheme.primary,
      );
    }
    if (status.isInstalled(route)) {
      return _Badge(
        text: l.piEngineRuntimeInstalled,
        color: Theme.of(context).colorScheme.tertiary,
      );
    }
    return _Badge(
      text: l.piEngineRuntimeNotInstalled,
      color: Theme.of(context).colorScheme.onSurfaceVariant,
    );
  }

  Widget _buildComparison(AppLocalizations l) {
    final cs = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SettingsSectionHeader(title: l.piEngineRuntimeComparisonTitle),
        Card(
          margin: const EdgeInsets.symmetric(horizontal: 16),
          child: Column(
            children: [
              ListTile(
                dense: true,
                leading: Icon(Icons.info_outline, color: cs.onSurfaceVariant),
                title: Text(
                  _showComparison
                      ? l.piEngineRuntimeComparisonCollapse
                      : l.piEngineRuntimeComparisonExpand,
                ),
                trailing: AnimatedRotation(
                  turns: _showComparison ? 0.5 : 0,
                  duration: const Duration(milliseconds: 150),
                  child: const Icon(Icons.expand_more),
                ),
                onTap: () => setState(() => _showComparison = !_showComparison),
              ),
              if (_showComparison) ...[
                const Divider(height: 1, indent: 16),
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
                  child: Text(
                    l.piEngineRuntimeComparisonA,
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 4, 16, 4),
                  child: Text(
                    l.piEngineRuntimeComparisonB,
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 4, 16, 4),
                  child: Text(
                    l.piEngineRuntimeSharedModel,
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: cs.onSurfaceVariant,
                    ),
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 4, 16, 12),
                  child: Text(
                    l.piEngineRuntimeDownloadSources,
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: cs.onSurfaceVariant,
                    ),
                  ),
                ),
              ],
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildPackages(AppLocalizations l) {
    final status = _status!;
    final packages = status.installedPackages;
    if (packages.isEmpty) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SettingsSectionHeader(title: l.piEngineRuntimePackagesTitle),
        Card(
          margin: const EdgeInsets.symmetric(horizontal: 16),
          child: ExpansionTile(
            leading: Icon(
              Icons.inventory_2_outlined,
              color: Theme.of(context).colorScheme.onSurfaceVariant,
            ),
            title: Text(l.piEngineRuntimePackages(packages.length)),
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                child: Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    for (final p in packages)
                      Chip(
                        label: Text(
                          p,
                          style: const TextStyle(fontFamily: 'monospace'),
                        ),
                        visualDensity: VisualDensity.compact,
                      ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  String _routeLabel(AppLocalizations l, RuntimeRoute route) {
    switch (route) {
      case RuntimeRoute.bionic:
        return l.piEngineRuntimeRouteBionic;
      case RuntimeRoute.proroot:
        return l.piEngineRuntimeRouteProroot;
      case RuntimeRoute.prootDistro:
        return l.piEngineRuntimeRouteProotDistro;
    }
  }
}

class _RouteCard extends StatelessWidget {
  const _RouteCard({
    super.key,
    required this.title,
    required this.subtitle,
    required this.icon,
    required this.installed,
    required this.selected,
    required this.busy,
    required this.onTap,
    this.trailing,
  });

  final String title;
  final String subtitle;
  final IconData icon;
  final bool installed;
  final bool selected;
  final bool busy;
  final VoidCallback onTap;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return ListTile(
      leading: Icon(
        selected ? Icons.radio_button_checked : Icons.radio_button_off,
        color: selected ? cs.primary : cs.onSurfaceVariant,
      ),
      title: Row(
        children: [
          Flexible(child: Text(title)),
          if (!installed && !selected) ...[
            const SizedBox(width: 8),
            Icon(Icons.download_outlined, size: 16, color: cs.tertiary),
          ],
        ],
      ),
      subtitle: Text(subtitle),
      isThreeLine: true,
      trailing: trailing,
      enabled: !busy,
      onTap: onTap,
    );
  }
}

class _Badge extends StatelessWidget {
  const _Badge({required this.text, required this.color});

  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: color.withValues(alpha: 0.4)),
      ),
      child: Text(
        text,
        style: Theme.of(context).textTheme.labelSmall?.copyWith(
          color: color,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}
