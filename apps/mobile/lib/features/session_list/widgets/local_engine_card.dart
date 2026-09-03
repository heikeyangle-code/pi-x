import 'package:flutter/material.dart';

/// Pi X — local engine status card, shown in the pre-connect state.
///
/// The pi agent engine runs on this device; the Pi Host bridge is reachable at
/// 127.0.0.1 (no remote bridge, no QR pairing). Live status / start / stop
/// wiring arrives with the Pi Host milestone — this card is the local-first
/// visual anchor replacing the old "scan to connect" entry point.
class LocalEngineCard extends StatelessWidget {
  const LocalEngineCard({super.key});

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Card(
      elevation: 0,
      color: cs.surfaceContainerHighest.withValues(alpha: 0.5),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: BorderSide(color: cs.outlineVariant),
      ),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.bolt, size: 20, color: cs.primary),
                const SizedBox(width: 8),
                Text(
                  'Pi X Local Engine',
                  style: TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w700,
                    color: cs.onSurface,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                Container(
                  width: 8,
                  height: 8,
                  decoration: BoxDecoration(
                    color: cs.tertiary,
                    shape: BoxShape.circle,
                  ),
                ),
                const SizedBox(width: 6),
                Text(
                  'Local · 127.0.0.1',
                  style: TextStyle(fontSize: 13, color: cs.onSurfaceVariant),
                ),
              ],
            ),
            const SizedBox(height: 6),
            Text(
              'The pi agent engine runs on this device — no remote bridge needed.',
              style: TextStyle(fontSize: 13, color: cs.onSurfaceVariant),
            ),
          ],
        ),
      ),
    );
  }
}
