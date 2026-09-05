import 'dart:async';

import 'package:flutter/material.dart';

import '../../l10n/app_localizations.dart';
import '../../services/pi_host_service.dart';
import '../settings/widgets/settings_section_header.dart';
import 'pi_engine_models.dart';

/// Group available models by provider. Providers and models are sorted by
/// display name; models without a provider fall into an empty-string bucket
/// (the sheet labels it with the localized fallback).
Map<String, List<PiModel>> groupPiModelsByProvider(List<PiModel> models) {
  final grouped = <String, List<PiModel>>{};
  for (final model in models) {
    final provider = model.provider ?? '';
    grouped.putIfAbsent(provider, () => []).add(model);
  }
  final sorted = grouped.keys.toList()..sort();
  return {
    for (final provider in sorted)
      provider: (grouped[provider]!)
        ..sort((a, b) => a.displayName.compareTo(b.displayName)),
  };
}

/// Compact chip for the session mode bar showing the engine's current model.
///
/// Mirrors the legacy CodexModelChip visuals (transparent Material + InkWell,
/// 11px w600 label, dropdown arrow) but reads the live engine state through
/// `get_state` and switches through `set_model`; the picker sheet is powered
/// by `get_available_models`.
class PiModelChip extends StatefulWidget {
  const PiModelChip({super.key, required this.service, this.onModelSwitched});

  final PiHostService service;
  final VoidCallback? onModelSwitched;

  @override
  State<PiModelChip> createState() => _PiModelChipState();
}

class _PiModelChipState extends State<PiModelChip> {
  PiModel? _current;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    unawaited(_loadCurrent());
  }

  Future<void> _loadCurrent() async {
    final result = await widget.service.control('get_state');
    if (!mounted) return;
    setState(() {
      _loading = false;
      final data = result.data;
      final rawModel = data is Map<String, dynamic> ? data['model'] : null;
      _current = rawModel is Map<String, dynamic>
          ? PiModel.fromJson(rawModel)
          : null;
    });
  }

  Future<void> _openPicker() async {
    final picked = await showPiModelSwitchSheet(
      context,
      service: widget.service,
      current: _current,
    );
    if (picked == null || !mounted) return;
    setState(() => _current = picked);
    widget.onModelSwitched?.call();
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final fg = cs.onSurfaceVariant;
    final l = AppLocalizations.of(context);
    final label = _loading || _current == null || _current!.isNull
        ? l.piEngineModel
        : _current!.displayName;

    return Material(
      key: const ValueKey('session_model_chip'),
      color: Colors.transparent,
      borderRadius: BorderRadius.circular(10),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: _openPicker,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.smart_toy_outlined, size: 13, color: fg),
              const SizedBox(width: 3),
              ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 130),
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w600,
                    color: fg,
                  ),
                ),
              ),
              Icon(
                Icons.arrow_drop_down,
                size: 14,
                color: fg.withValues(alpha: 0.5),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Present the model picker bottom sheet. Resolves with the picked model when
/// a switch succeeded, or null when dismissed or failed.
Future<PiModel?> showPiModelSwitchSheet(
  BuildContext context, {
  required PiHostService service,
  PiModel? current,
}) {
  return showModalBottomSheet<PiModel>(
    context: context,
    isScrollControlled: true,
    builder: (_) => _PiModelSwitchSheet(service: service, current: current),
  );
}

class _PiModelSwitchSheet extends StatefulWidget {
  const _PiModelSwitchSheet({required this.service, this.current});

  final PiHostService service;
  final PiModel? current;

  @override
  State<_PiModelSwitchSheet> createState() => _PiModelSwitchSheetState();
}

class _PiModelSwitchSheetState extends State<_PiModelSwitchSheet> {
  bool _loading = true;
  String? _error;
  Map<String, List<PiModel>> _grouped = const {};

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
    final result = await widget.service.control('get_available_models');
    if (!mounted) return;
    setState(() {
      _loading = false;
      if (result.ok && result.data is Map<String, dynamic>) {
        _grouped = groupPiModelsByProvider(
          parseAvailableModels(result.data as Map<String, dynamic>?),
        );
      } else {
        _error = result.error ?? 'load_failed';
      }
    });
  }

  Future<void> _switchModel(PiModel model) async {
    final l = AppLocalizations.of(context);
    final messenger = ScaffoldMessenger.of(context);
    final result = await widget.service.control(
      'set_model',
      payload: {'provider': model.provider ?? '', 'modelId': model.id},
    );
    if (!mounted) return;
    if (result.success) {
      messenger.showSnackBar(
        SnackBar(content: Text(l.piEngineModelSwitched(model.displayName))),
      );
      Navigator.pop(context, model);
    } else {
      messenger.showSnackBar(
        SnackBar(
          content: Text(l.piEngineError(result.error ?? 'switch failed')),
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final cs = Theme.of(context).colorScheme;
    final current = widget.current;

    return SafeArea(
      child: Padding(
        padding: EdgeInsets.only(
          bottom: MediaQuery.of(context).viewInsets.bottom,
        ),
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxHeight: MediaQuery.of(context).size.height * 0.8,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(24, 20, 24, 4),
                child: Text(
                  l.piEngineModelSwitchTitle,
                  style: Theme.of(context).textTheme.titleLarge,
                ),
              ),
              if (current != null && !current.isNull)
                Padding(
                  padding: const EdgeInsets.fromLTRB(24, 0, 24, 8),
                  child: Text(
                    current.displayName,
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: cs.onSurfaceVariant,
                    ),
                  ),
                ),
              const Divider(height: 1),
              if (_loading)
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 48),
                  child: Center(child: CircularProgressIndicator()),
                )
              else if (_error != null)
                Padding(
                  padding: const EdgeInsets.fromLTRB(24, 16, 24, 24),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        l.piEngineError(_error!),
                        style: TextStyle(color: cs.error, fontSize: 12),
                      ),
                      const SizedBox(height: 8),
                      TextButton.icon(
                        key: const ValueKey('model_switch_retry'),
                        onPressed: _load,
                        icon: const Icon(Icons.refresh, size: 18),
                        label: Text(l.retry),
                      ),
                    ],
                  ),
                )
              else if (_grouped.isEmpty)
                Padding(
                  padding: const EdgeInsets.fromLTRB(24, 32, 24, 32),
                  child: Text(
                    l.piEngineModelSwitchEmpty,
                    style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                      color: cs.onSurfaceVariant,
                    ),
                  ),
                )
              else
                Flexible(
                  child: ListView(
                    shrinkWrap: true,
                    children: [
                      for (final entry in _grouped.entries) ...[
                        SettingsSectionHeader(
                          title: entry.key.isEmpty
                              ? l.piEngineModel
                              : entry.key,
                        ),
                        for (final model in entry.value)
                          _ModelTile(
                            model: model,
                            selected: current != null &&
                                model.qualifiedId == current.qualifiedId,
                            onTap: () => _switchModel(model),
                          ),
                      ],
                    ],
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ModelTile extends StatelessWidget {
  const _ModelTile({
    required this.model,
    required this.selected,
    required this.onTap,
  });

  final PiModel model;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return ListTile(
      key: ValueKey('model_${model.qualifiedId}'),
      dense: true,
      leading: Icon(
        selected ? Icons.check_circle : Icons.circle_outlined,
        size: 20,
        color: selected ? cs.primary : cs.onSurfaceVariant,
      ),
      title: Text(
        model.displayName,
        style: const TextStyle(fontFamily: 'monospace'),
      ),
      subtitle: model.id == model.displayName
          ? null
          : Text(model.id, style: const TextStyle(fontSize: 12)),
      trailing: model.reasoning == true
          ? Icon(
              Icons.psychology_outlined,
              size: 16,
              color: cs.onSurfaceVariant,
            )
          : null,
      onTap: onTap,
    );
  }
}
