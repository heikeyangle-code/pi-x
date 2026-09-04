import 'package:flutter/material.dart';

import '../../l10n/app_localizations.dart';
import '../../services/pi_host_service.dart';
import '../../core/logger.dart';

/// Renders one `extension_ui_request` frame from a pi extension as a native
/// dialog and answers it via [PiHostService.respondUi].
///
/// Contract (pi 0.85.x rpc-types, verified in bridge server.ts):
///   select  {id, method:'select', title, options[]}       -> {value} | cancelled
///   confirm {id, method:'confirm', title, message}        -> {confirmed} | cancelled
///   input   {id, method:'input', title, placeholder?}     -> {value} | cancelled
///   editor  {id, method:'editor', title, prefill?}        -> {value} | cancelled
///   notify  {id, method:'notify', message, notifyType?}   -> fire-and-forget
/// Fire-and-forget extras (setStatus/setWidget/setTitle/set_editor_text) are
/// TUI footer affordances; in RPC mode the App logs them and shows nothing.
Future<void> handleExtensionUiRequest({
  required BuildContext context,
  required PiHostFrame frame,
  required PiHostService service,
}) async {
  final request = frame.frame;
  final id = request['id'] as String? ?? '';
  final method = request['method'] as String? ?? 'confirm';
  if (id.isEmpty) return;

  switch (method) {
    case 'confirm':
      await _showConfirm(context, request, service, id);
    case 'select':
      await _showSelect(context, request, service, id);
    case 'input':
      await _showInput(context, request, service, id);
    case 'editor':
      await _showEditor(context, request, service, id);
    case 'notify':
      _showNotify(context, request);
    default:
      // setStatus / setWidget / setTitle / set_editor_text — TUI-only extras.
      logger.debug('pi extension UI (ignored in RPC mode): $method $id');
  }
}

String _string(Map<String, dynamic> request, String key) =>
    request[key] as String? ?? '';

Future<void> _showConfirm(
  BuildContext context,
  Map<String, dynamic> request,
  PiHostService service,
  String id,
) async {
  final message = _string(request, 'message');
  final action = await showDialog<String>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text(_string(request, 'title')),
      content: message.isEmpty ? null : Text(message),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(ctx, 'cancel'),
          child: Text(AppLocalizations.of(ctx).cancel),
        ),
        FilledButton(
          onPressed: () => Navigator.pop(ctx, 'ok'),
          child: Text(AppLocalizations.of(ctx).confirm),
        ),
      ],
    ),
  );
  if (action == 'ok') {
    service.respondUi(id, confirmed: true);
  } else {
    service.respondUi(id, cancelled: true);
  }
}

Future<void> _showSelect(
  BuildContext context,
  Map<String, dynamic> request,
  PiHostService service,
  String id,
) async {
  final options = (request['options'] as List?)?.whereType<String>().toList() ??
      const <String>[];
  if (options.isEmpty) {
    service.respondUi(id, cancelled: true);
    return;
  }
  final selection = await showModalBottomSheet<String>(
    context: context,
    useSafeArea: true,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (ctx) => _SelectSheet(
      title: _string(request, 'title'),
      options: options,
    ),
  );
  if (selection != null) {
    service.respondUi(id, value: selection);
  } else {
    service.respondUi(id, cancelled: true);
  }
}

Future<void> _showInput(
  BuildContext context,
  Map<String, dynamic> request,
  PiHostService service,
  String id,
) async {
  final controller = TextEditingController(
    text: _string(request, 'defaultValue'),
  );
  final value = await showDialog<String>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text(_string(request, 'title')),
      content: TextField(
        controller: controller,
        autofocus: true,
        decoration: InputDecoration(
          hintText: _string(request, 'placeholder'),
        ),
        onSubmitted: (v) => Navigator.pop(ctx, v),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(ctx),
          child: Text(AppLocalizations.of(ctx).cancel),
        ),
        FilledButton(
          onPressed: () => Navigator.pop(ctx, controller.text),
          child: Text(AppLocalizations.of(ctx).save),
        ),
      ],
    ),
  );
  controller.dispose();
  if (value != null) {
    service.respondUi(id, value: value);
  } else {
    service.respondUi(id, cancelled: true);
  }
}

Future<void> _showEditor(
  BuildContext context,
  Map<String, dynamic> request,
  PiHostService service,
  String id,
) async {
  final controller = TextEditingController(text: _string(request, 'prefill'));
  final value = await showDialog<String>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text(_string(request, 'title')),
      content: SizedBox(
        width: 480,
        child: TextField(
          controller: controller,
          autofocus: true,
          maxLines: 18,
          minLines: 10,
          style: const TextStyle(fontFamily: 'monospace'),
          decoration: const InputDecoration(
            border: OutlineInputBorder(),
            alignLabelWithHint: true,
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(ctx),
          child: Text(AppLocalizations.of(ctx).cancel),
        ),
        FilledButton(
          onPressed: () => Navigator.pop(ctx, controller.text),
          child: Text(AppLocalizations.of(ctx).save),
        ),
      ],
    ),
  );
  controller.dispose();
  if (value != null) {
    service.respondUi(id, value: value);
  } else {
    service.respondUi(id, cancelled: true);
  }
}

void _showNotify(BuildContext context, Map<String, dynamic> request) {
  final messenger = ScaffoldMessenger.maybeOf(context);
  if (messenger == null) return;
  final type = _string(request, 'notifyType');
  final color = switch (type) {
    'error' => Theme.of(context).colorScheme.error,
    'warning' => Theme.of(context).colorScheme.tertiary,
    _ => null,
  };
  messenger
    ..hideCurrentSnackBar()
    ..showSnackBar(
      SnackBar(
        content: Text(_string(request, 'message')),
        backgroundColor: color,
        duration: const Duration(seconds: 3),
      ),
    );
}

class _SelectSheet extends StatelessWidget {
  const _SelectSheet({required this.title, required this.options});

  final String title;
  final List<String> options;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (title.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 4, 20, 8),
              child: Text(
                title,
                style: Theme.of(context).textTheme.titleMedium,
              ),
            ),
          Flexible(
            child: ListView.builder(
              shrinkWrap: true,
              itemCount: options.length,
              itemBuilder: (context, index) {
                final option = options[index];
                return ListTile(
                  title: Text(option),
                  onTap: () => Navigator.pop(context, option),
                );
              },
            ),
          ),
          const Divider(height: 1),
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: Text(AppLocalizations.of(context).cancel),
          ),
        ],
      ),
    );
  }
}
