import 'package:flutter/material.dart';

import '../../../l10n/app_localizations.dart';
import '../../../models/protocol_version.dart';
import 'local_engine_card.dart';
import 'protocol_incompatibility_card.dart';

class ConnectForm extends StatelessWidget {
  final VoidCallback? onViewSetupGuide;
  final ProtocolCompatibility? protocolCompatibility;
  final VoidCallback? onConnectLocalEngine;

  const ConnectForm({
    super.key,
    this.onViewSetupGuide,
    this.protocolCompatibility,
    this.onConnectLocalEngine,
  });


  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Container(
            padding: const EdgeInsets.all(24),
            decoration: BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
                colors: [
                  Theme.of(context).colorScheme.primary.withValues(alpha: 0.15),
                  Theme.of(context).colorScheme.primary.withValues(alpha: 0.05),
                ],
              ),
              shape: BoxShape.circle,
              boxShadow: [
                BoxShadow(
                  color: Theme.of(context).colorScheme.primary
                      .withValues(alpha: 0.1),
                  blurRadius: 20,
                  spreadRadius: 2,
                ),
              ],
            ),
            child: Icon(
              Icons.terminal,
              size: 48,
              color: Theme.of(context).colorScheme.primary,
            ),
          ),
          const SizedBox(height: 24),
          Text(
            l.connectToBridgeServer,
            style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 24),

          const LocalEngineCard(),
          const SizedBox(height: 12),
          if (onConnectLocalEngine != null) ...[
            SizedBox(
              width: double.infinity,
              child: FilledButton.icon(
                key: const ValueKey('local_connect_button'),
                onPressed: onConnectLocalEngine,
                icon: const Icon(Icons.play_arrow),
                label: const Text('Start & connect local engine'),
              ),
            ),
          ],
          const SizedBox(height: 24),

          if (protocolCompatibility case final compatibility?
              when !compatibility.isCompatible) ...[
            ProtocolIncompatibilityCard(compatibility: compatibility),
            const SizedBox(height: 16),
          ],

          const SizedBox(height: 24),

          if (onViewSetupGuide != null) ...[
            TextButton.icon(
              key: const ValueKey('setup_guide_button'),
              style: TextButton.styleFrom(
                padding: const EdgeInsets.symmetric(
                  horizontal: 24,
                  vertical: 12,
                ),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(12),
                ),
              ),
              onPressed: onViewSetupGuide,
              icon: Icon(
                Icons.lightbulb_outline,
                size: 20,
                color: Theme.of(context).colorScheme.primary,
              ),
              label: Text(
                l.setupGuide,
                style: const TextStyle(fontWeight: FontWeight.w600),
              ),
            ),
          ],
        ],
      ),
    );
  }
}
