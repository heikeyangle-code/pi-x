import 'dart:async';

import 'package:flutter/material.dart';

import '../../services/pi_host_service.dart';
import '../../services/store_screenshot_extension.dart';
import 'extension_ui_dialogs.dart';

/// Bridges pi extension `extension_ui_request` frames to native dialogs.
///
/// Mount it in `MaterialApp.builder` above the Navigator:
///
///   builder: (context, child) =>
///       PiExtensionUiHost(service: piHostService, child: child ?? SizedBox.shrink()),
///
/// Dialogs render on the app's root navigator (auto_route navigatorKey, the
/// same key StoreScreenshotState already uses), so they survive page changes
/// and work from any screen. Fire-and-forget methods (notify) surface as
/// SnackBars; setStatus/setWidget/setTitle/set_editor_text are TUI extras and
/// are intentionally not rendered in RPC mode.
class PiExtensionUiHost extends StatefulWidget {
  const PiExtensionUiHost({
    super.key,
    required this.service,
    required this.child,
  });

  final PiHostService service;
  final Widget child;

  @override
  State<PiExtensionUiHost> createState() => _PiExtensionUiHostState();
}

class _PiExtensionUiHostState extends State<PiExtensionUiHost> {
  StreamSubscription<PiHostFrame>? _sub;
  bool _active = false;

  @override
  void initState() {
    super.initState();
    _sub = widget.service.events.listen(_onFrame);
  }

  Future<void> _onFrame(PiHostFrame frame) async {
    if (frame.frame['type'] != 'extension_ui_request') return;
    final navigatorContext = StoreScreenshotState.navigatorKey?.currentContext;
    if (navigatorContext == null || !mounted) return;
    // Serialize dialogs so overlapping extension prompts don't stack.
    if (_active) return;
    _active = true;
    try {
      await handleExtensionUiRequest(
        context: navigatorContext,
        frame: frame,
        service: widget.service,
      );
    } finally {
      _active = false;
    }
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
