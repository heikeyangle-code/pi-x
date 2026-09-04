import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../l10n/app_localizations.dart';
import '../../services/machine_manager_service.dart';
import '../../services/pi_host_service.dart';

export '../settings/widgets/settings_section_header.dart';

/// Connect the Pi Host service to the single local machine when needed.
/// Returns true when the service is (or became) connected.
Future<bool> ensurePiHostConnected(BuildContext context) async {
  final service = context.read<PiHostService>();
  if (service.isConnected) return true;
  final machines = context.read<MachineManagerService>();
  final machine = machines.localMachine;
  if (machine == null) return false;
  String? apiKey;
  try {
    apiKey = await machines.getApiKey(machine.id);
  } catch (_) {
    apiKey = null;
  }
  service.connect(machine.host, machine.port, apiKey: apiKey);
  // ValueNotifier has no stream: listen until connected or give up after a
  // short window, then let the caller re-check isConnected.
  final completer = Completer<void>();
  void listener() {
    if (service.isConnected && !completer.isCompleted) {
      completer.complete();
    }
  }

  service.state.addListener(listener);
  try {
    await completer.future.timeout(const Duration(seconds: 8));
  } on TimeoutException {
    // The host may still be starting; the caller decides via isConnected.
  } finally {
    service.state.removeListener(listener);
  }
  return service.isConnected;
}

/// Status banner for the local Pi engine connection.
class PiHostStatusBanner extends StatelessWidget {
  const PiHostStatusBanner({super.key, this.compact = false});

  final bool compact;

  @override
  Widget build(BuildContext context) {
    final service = context.watch<PiHostService>();
    final l = AppLocalizations.of(context);
    final state = service.state.value;
    final cs = Theme.of(context).colorScheme;

    final (label, icon, color) = switch (state) {
      PiHostConnectionState.connected => (
        l.piEngineConnected(service.engineVersion.value),
        Icons.check_circle_outline,
        cs.primary,
      ),
      PiHostConnectionState.connecting => (
        l.piEngineConnecting,
        Icons.sync,
        cs.tertiary,
      ),
      PiHostConnectionState.reconnecting => (
        l.piEngineReconnecting,
        Icons.sync_problem,
        cs.tertiary,
      ),
      PiHostConnectionState.disconnected => (
        l.piEngineDisconnected,
        Icons.circle_outlined,
        cs.onSurfaceVariant,
      ),
    };

    return Material(
      color: cs.surfaceContainerHigh,
      borderRadius: BorderRadius.circular(16),
      child: Padding(
        padding: EdgeInsets.symmetric(
          horizontal: 16,
          vertical: compact ? 8 : 12,
        ),
        child: Row(
          children: [
            Icon(icon, size: 20, color: color),
            const SizedBox(width: 12),
            Expanded(
              child: Text(label, style: Theme.of(context).textTheme.bodyMedium),
            ),
            if (state == PiHostConnectionState.disconnected)
              TextButton(
                onPressed: () => ensurePiHostConnected(context),
                child: Text(l.connect),
              ),
          ],
        ),
      ),
    );
  }
}

/// Ask the user, then restart the pi engine process so launch-time
/// configuration (engineArgs, SYSTEM.md / APPEND_SYSTEM.md) is re-applied.
/// Resolves when the restart op was acknowledged (the engine lazily respawns
/// on the next request — the PiHost gateway keeps the pool warm).
Future<void> confirmRestartEngine(
  BuildContext context,
  PiHostService service,
) async {
  final l = AppLocalizations.of(context);
  final messenger = ScaffoldMessenger.of(context);
  final confirmed = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text(l.piEngineRestartEngine),
      content: Text(l.piEngineRestartConfirmBody),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(ctx, false),
          child: Text(l.cancel),
        ),
        FilledButton(
          onPressed: () => Navigator.pop(ctx, true),
          child: Text(l.piEngineRestartEngine),
        ),
      ],
    ),
  );
  if (confirmed != true) return;
  messenger.showSnackBar(
    SnackBar(content: Text(l.piEngineRestarting)),
  );
  final result = await service.control('restart_engine');
  messenger.hideCurrentSnackBar();
  messenger.showSnackBar(
    SnackBar(
      content: Text(
        result.ok
            ? l.piEngineRestarted
            : l.piEngineError(result.error ?? 'restart failed'),
      ),
    ),
  );
}
