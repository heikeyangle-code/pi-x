import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../l10n/app_localizations.dart';
import '../../services/pi_host_service.dart';
import 'pi_engine_extensions.dart';
import 'pi_engine_widgets.dart';

/// Manage pi extensions discovered in `~/.pi/agent/extensions/` and project
/// `.pi/extensions/` (`list_extensions`, docs/ENGINE-UI-SURFACES §6.1).
///
/// Extensions are arbitrary TypeScript code running inside the engine, so the
/// screen leads with a trust warning. New/changed extensions apply after an
/// engine restart (or `/reload`); the screen reuses the shared restart flow.
class ExtensionsScreen extends StatefulWidget {
  const ExtensionsScreen({super.key});

  @override
  State<ExtensionsScreen> createState() => _ExtensionsScreenState();
}

class _ExtensionsScreenState extends State<ExtensionsScreen> {
  bool _loading = true;
  String? _error;
  List<PiExtension> _extensions = const [];

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
    final result = await _service.control('list_extensions');
    if (!mounted) return;
    setState(() {
      _loading = false;
      if (result.ok) {
        final raw = result.data;
        _extensions = raw is List
            ? raw
                .whereType<Map>()
                .map((e) => PiExtension.fromJson(e.cast<String, dynamic>()))
                .toList()
            : const <PiExtension>[];
        _error = null;
      } else {
        _error = result.error ?? 'load_failed';
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final cs = Theme.of(context).colorScheme;
    final projectExtensions =
        _extensions.where((e) => e.isProject).toList();
    final globalExtensions =
        _extensions.where((e) => !e.isProject).toList();
    return Scaffold(
      appBar: AppBar(title: Text(l.piEngineExtensions)),
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
                          l.piEngineExtensionsTrustWarning,
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
            else if (_error == null && _extensions.isEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 48),
                child: Center(
                  child: Text(
                    l.piEngineExtensionsEmpty,
                    style: TextStyle(color: cs.onSurfaceVariant),
                  ),
                ),
              )
            else if (_error == null) ...[
              SettingsSectionHeader(
                title: l.piEngineExtensionsCount(_extensions.length),
              ),
              if (projectExtensions.isNotEmpty) ...[
                SettingsSectionHeader(title: l.piEngineExtensionsGroupProject),
                _ExtensionCard(extensions: projectExtensions),
              ],
              if (globalExtensions.isNotEmpty) ...[
                SettingsSectionHeader(title: l.piEngineExtensionsGroupGlobal),
                _ExtensionCard(extensions: globalExtensions),
              ],
            ],
            const SizedBox(height: 16),
            SettingsSectionHeader(title: l.piEngineExtensionsApply),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: Text(
                l.piEngineExtensionsReloadHint,
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

/// One grouped extension list (project or global scope).
class _ExtensionCard extends StatelessWidget {
  const _ExtensionCard({required this.extensions});

  final List<PiExtension> extensions;

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 16),
      child: Column(
        children: [
          for (var i = 0; i < extensions.length; i++) ...[
            if (i > 0) const Divider(height: 1, indent: 56),
            ListTile(
              key: ValueKey('extension_${extensions[i].name}'),
              leading: Icon(
                Icons.extension_outlined,
                size: 22,
                color: cs.primary,
              ),
              title: Text(
                extensions[i].name,
                style: const TextStyle(
                  fontFamily: 'monospace',
                  fontWeight: FontWeight.w600,
                  fontSize: 15,
                ),
              ),
              dense: true,
            ),
          ],
        ],
      ),
    );
  }
}
