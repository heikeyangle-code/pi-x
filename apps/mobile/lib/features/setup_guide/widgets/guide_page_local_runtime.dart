import 'package:flutter/material.dart';

import 'guide_page.dart';

/// Pi X: local-runtime guide page.
///
/// Replaces the remote-only pages (bridge setup on a desktop host, QR pairing,
/// Tailscale, launchd autostart). Pi X runs the pi engine on this device, so
/// the guide only needs to explain the local model.
class GuidePageLocalRuntime extends StatelessWidget {
  const GuidePageLocalRuntime({super.key});

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final bodyStyle = Theme.of(context)
        .textTheme
        .bodyMedium
        ?.copyWith(color: cs.onSurfaceVariant, height: 1.6);
    return GuidePage(
      icon: Icons.phone_android,
      title: 'Pi X runs on this device',
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'The pi agent engine runs right here on your phone — there is no '
            'desktop bridge to set up, no QR pairing, no host machine to reach.',
            style: bodyStyle,
          ),
          const SizedBox(height: 16),
          _row(context, cs, Icons.memory, 'Engine: pi (Node runtime, versioned & auto-updated)'),
          const SizedBox(height: 8),
          _row(context, cs, Icons.workspaces_outlined, 'Workspace & sessions are stored on this device'),
          const SizedBox(height: 8),
          _row(context, cs, Icons.extension_outlined, 'Pi extensions, skills & packages install in-app'),
          const SizedBox(height: 8),
          _row(context, cs, Icons.security_outlined, 'Provider keys are entered on-device, as usual'),
        ],
      ),
    );
  }

  Widget _row(
    BuildContext context,
    ColorScheme cs,
    IconData icon,
    String text,
  ) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, size: 20, color: cs.primary),
        const SizedBox(width: 10),
        Expanded(
          child: Text(
            text,
            style: Theme.of(context)
                .textTheme
                .bodyMedium
                ?.copyWith(color: cs.onSurfaceVariant, height: 1.5),
          ),
        ),
      ],
    );
  }
}
