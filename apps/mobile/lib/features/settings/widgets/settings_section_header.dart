import 'package:flutter/material.dart';

/// Plain-text section label used across the settings surface (and the pi
/// engine management pages, which share the same visual language).
///
/// Matches the historical inline header style (fontSize 12 / w600 /
/// letterSpacing 0.8 / onSurfaceVariant), extracted so settings screens and
/// the pi engine pages stay visually identical without duplicating it.
class SettingsSectionHeader extends StatelessWidget {
  final String title;
  const SettingsSectionHeader({super.key, required this.title});

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 24, 16, 8),
      child: Text(
        title,
        style: TextStyle(
          fontSize: 12,
          fontWeight: FontWeight.w600,
          letterSpacing: 0.8,
          color: cs.onSurfaceVariant,
        ),
      ),
    );
  }
}
