import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:http/http.dart' as http;

import '../../l10n/app_localizations.dart';
import '../../services/pi_host_service.dart';
import 'pi_engine_models.dart';
import 'pi_engine_widgets.dart';

/// Fetch the OpenAI-compatible `/models` endpoint, falling back from
/// `/v1/models` to `/models`. Throws on every candidate failing.
Future<Object?> _fetchOpenAiModels(String baseUrl, String apiKey) async {
  final clean = baseUrl.replaceAll(RegExp(r'/+$'), '');
  Object? lastError;
  for (final path in const ['/v1/models', '/models']) {
    try {
      final request = http.Request('GET', Uri.parse('$clean$path'));
      if (apiKey.isNotEmpty) {
        request.headers['Authorization'] = 'Bearer $apiKey';
      }
      final streamed = await http.Client().send(request);
      final response = await http.Response.fromStream(streamed);
      if (response.statusCode == 200) {
        return jsonDecode(utf8.decode(response.bodyBytes));
      }
      lastError = 'HTTP ${response.statusCode}';
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError is Exception) throw lastError;
  throw Exception('$lastError');
}

/// Manage pi custom providers/models (~/.pi/agent/models.json, docs/models.md).
///
/// Reads/writes the same JSON file pi uses (models.json under the pi home
/// agent dir) through the PiHost surface ops:
///   get_models      -> providers map
///   upsert_model    -> {providerId, spec}  (create/update a provider)
///   add_model       -> {providerId, model} (append one model entry)
///   remove_model    -> {providerId}        (delete the provider)
/// Changes are picked up by the running engine on the next request; the
/// screen offers a restart for good measure after structural edits.
class ModelsScreen extends StatefulWidget {
  const ModelsScreen({super.key});

  @override
  State<ModelsScreen> createState() => _ModelsScreenState();
}

class _ModelsScreenState extends State<ModelsScreen> {
  bool _loading = true;
  String? _error;
  Map<String, CustomProvider> _providers = {};

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
    final result = await _service.control('get_models');
    if (!mounted) return;
    setState(() {
      _loading = false;
      if (result.ok && result.data is Map<String, dynamic>) {
        final raw = result.data as Map<String, dynamic>;
        _providers = raw.map(
          (id, value) => MapEntry(
            id,
            CustomProvider.fromJson(
              id,
              value is Map ? value.cast<String, dynamic>() : const {},
            ),
          ),
        );
        _error = null;
      } else {
        _error = result.error ?? 'load_failed';
      }
    });
  }

  Future<void> _upsertProvider(String id, CustomProvider provider) async {
    final connected = await ensurePiHostConnected(context);
    if (!mounted || !connected) return;
    final messenger = ScaffoldMessenger.of(context);
    final l = AppLocalizations.of(context);
    final result = await _service.control(
      'upsert_model',
      payload: {
        'providerId': id,
        // Full provider object: UI-edited fields plus every field preserved
        // from the original file (headers/compat/modelOverrides/…).
        'spec': provider.toJson(),
      },
    );
    if (!mounted) return;
    if (result.ok) {
      messenger.showSnackBar(SnackBar(content: Text(l.piEngineSaved)));
      await _load();
    } else {
      messenger.showSnackBar(
        SnackBar(content: Text(l.piEngineError(result.error ?? 'write failed'))),
      );
    }
  }

  Future<void> _addModel(String providerId, CustomModel model) async {
    final connected = await ensurePiHostConnected(context);
    if (!mounted || !connected) return;
    final messenger = ScaffoldMessenger.of(context);
    final l = AppLocalizations.of(context);
    final result = await _service.control(
      'add_model',
      payload: {'providerId': providerId, 'model': model.toJson()},
    );
    if (!mounted) return;
    if (result.ok) {
      messenger.showSnackBar(SnackBar(content: Text(l.piEngineSaved)));
      await _load();
    } else {
      messenger.showSnackBar(
        SnackBar(content: Text(l.piEngineError(result.error ?? 'write failed'))),
      );
    }
  }

  Future<void> _removeProvider(String id) async {
    final l = AppLocalizations.of(context);
    final messenger = ScaffoldMessenger.of(context);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(l.piEngineProviderDelete),
        content: Text(l.piEngineProviderDeleteConfirm(id)),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text(l.cancel),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(l.delete),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    if (!mounted) return;
    final connected = await ensurePiHostConnected(context);
    if (!mounted || !connected) return;
    final result = await _service.control(
      'remove_model',
      payload: {'providerId': id},
    );
    if (!mounted) return;
    if (result.ok) {
      messenger.showSnackBar(SnackBar(content: Text(l.piEngineSaved)));
      await _load();
    } else {
      messenger.showSnackBar(
        SnackBar(content: Text(l.piEngineError(result.error ?? 'remove failed'))),
      );
    }
  }

  Future<void> _showProviderEditor({String? id, CustomProvider? provider}) async {
    final l = AppLocalizations.of(context);
    final isNew = provider == null;
    final idController = TextEditingController(text: id ?? '');
    final baseUrlController = TextEditingController(text: provider?.baseUrl ?? '');
    final apiKeyController = TextEditingController(text: provider?.apiKey ?? '');
    String api = provider?.api ?? kProviderApis.first;

    final saved = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) => AlertDialog(
          title: Text(isNew ? l.piEngineProviderAdd : l.piEngineProviderEdit),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextField(
                  controller: idController,
                  enabled: isNew,
                  decoration: InputDecoration(
                    labelText: l.piEngineProviderId,
                    border: const OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: baseUrlController,
                  decoration: InputDecoration(
                    labelText: l.piEngineProviderBaseUrl,
                    hintText: 'http://127.0.0.1:11434/v1',
                    border: const OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 12),
                DropdownButtonFormField<String>(
                  initialValue: api,
                  decoration: InputDecoration(
                    labelText: l.piEngineProviderApi,
                    border: const OutlineInputBorder(),
                  ),
                  items: [
                    for (final kind in kProviderApis)
                      DropdownMenuItem(value: kind, child: Text(kind)),
                  ],
                  onChanged: (value) {
                    if (value != null) setDialogState(() => api = value);
                  },
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: apiKeyController,
                  obscureText: true,
                  decoration: InputDecoration(
                    labelText: l.piEngineProviderApiKey,
                    border: const OutlineInputBorder(),
                  ),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: Text(l.cancel),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: Text(l.save),
            ),
          ],
        ),
      ),
    );
    final finalId = idController.text.trim();
    idController.dispose();
    baseUrlController.dispose();
    apiKeyController.dispose();
    if (saved != true || finalId.isEmpty) return;
    await _upsertProvider(
      finalId,
      CustomProvider(
        id: finalId,
        baseUrl: baseUrlController.text.trim().isEmpty
            ? null
            : baseUrlController.text.trim(),
        api: api,
        apiKey: apiKeyController.text.trim().isEmpty
            ? null
            : apiKeyController.text.trim(),
        models: provider?.models ?? const [],
        extra: provider?.extra ?? const {},
      ),
    );
  }

  Future<void> _showModelEditor(String providerId) async {
    final l = AppLocalizations.of(context);
    final idController = TextEditingController();
    final nameController = TextEditingController();
    bool reasoning = false;

    final saved = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) => AlertDialog(
          title: Text(l.piEngineModelAdd),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: idController,
                decoration: InputDecoration(
                  labelText: l.piEngineModelId,
                  hintText: 'qwen2.5-coder:7b',
                  border: const OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: nameController,
                decoration: InputDecoration(
                  labelText: l.piEngineModelName,
                  border: const OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 8),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: Text(l.piEngineModelReasoning),
                value: reasoning,
                onChanged: (v) => setDialogState(() => reasoning = v),
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: Text(l.cancel),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: Text(l.save),
            ),
          ],
        ),
      ),
    );
    final id = idController.text.trim();
    idController.dispose();
    nameController.dispose();
    if (saved != true || id.isEmpty) return;
    await _addModel(
      providerId,
      CustomModel(
        id: id,
        name: nameController.text.trim().isEmpty
            ? null
            : nameController.text.trim(),
        reasoning: reasoning,
      ),
    );
  }

  Future<void> _importModels(
    String providerId,
    List<DiscoveredModel> models,
  ) async {
    final connected = await ensurePiHostConnected(context);
    if (!mounted || !connected) return;
    final messenger = ScaffoldMessenger.of(context);
    final l = AppLocalizations.of(context);
    final result = await _service.control(
      'import_models',
      payload: {
        'providerId': providerId,
        'models': [
          for (final m in models)
            {
              'id': m.id,
              if (m.name != null && m.name!.isNotEmpty) 'name': m.name,
            },
        ],
      },
    );
    if (!mounted) return;
    if (result.ok) {
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(
          SnackBar(content: Text(l.piEngineModelImportDone(models.length, providerId))),
        );
      await _load();
    } else {
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(
          SnackBar(content: Text(l.piEngineError(result.error ?? 'import failed'))),
        );
    }
  }

  Future<void> _importRemoteModels(CustomProvider provider) async {
    final l = AppLocalizations.of(context);
    final baseUrlController = TextEditingController(text: provider.baseUrl ?? '');
    final apiKeyController = TextEditingController(text: provider.apiKey ?? '');
    List<DiscoveredModel> discovered = const [];
    Object? fetchError;
    var fetching = false;
    final selected = <String>{};

    final imported = await showModalBottomSheet<int>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setSheetState) {
          Future<void> fetch() async {
            setSheetState(() {
              fetching = true;
              fetchError = null;
            });
            try {
              final body = await _fetchOpenAiModels(
                baseUrlController.text.trim(),
                apiKeyController.text.trim(),
              );
              final models = parseDiscoveredModels(body);
              if (!ctx.mounted) return;
              setSheetState(() {
                discovered = models;
                selected
                  ..clear()
                  ..addAll(models.map((m) => m.id));
              });
            } catch (error) {
              if (!ctx.mounted) return;
              setSheetState(() {
                fetchError = error;
                discovered = const [];
              });
            } finally {
              if (ctx.mounted) setSheetState(() => fetching = false);
            }
          }

          return SafeArea(
            child: Padding(
              padding: EdgeInsets.only(
                bottom: MediaQuery.of(ctx).viewInsets.bottom,
              ),
              child: ConstrainedBox(
                constraints: BoxConstraints(
                  maxHeight: MediaQuery.of(ctx).size.height * 0.8,
                ),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Padding(
                      padding: const EdgeInsets.fromLTRB(24, 20, 24, 8),
                      child: Text(
                        l.piEngineModelImport,
                        style: Theme.of(ctx).textTheme.titleLarge,
                      ),
                    ),
                    Padding(
                      padding: const EdgeInsets.fromLTRB(24, 0, 24, 12),
                      child: Text(
                        l.piEngineModelImportDesc,
                        style: Theme.of(ctx).textTheme.bodySmall?.copyWith(
                          color: Theme.of(ctx).colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ),
                    Padding(
                      padding: const EdgeInsets.fromLTRB(24, 0, 24, 8),
                      child: TextField(
                        key: const ValueKey('import_base_url'),
                        controller: baseUrlController,
                        keyboardType: TextInputType.url,
                        style: const TextStyle(fontFamily: 'monospace'),
                        decoration: InputDecoration(
                          labelText: l.piEngineProviderBaseUrl,
                          hintText: 'http://127.0.0.1:11434/v1',
                          border: const OutlineInputBorder(),
                          isDense: true,
                        ),
                      ),
                    ),
                    Padding(
                      padding: const EdgeInsets.fromLTRB(24, 0, 24, 8),
                      child: TextField(
                        key: const ValueKey('import_api_key'),
                        controller: apiKeyController,
                        obscureText: true,
                        style: const TextStyle(fontFamily: 'monospace'),
                        decoration: InputDecoration(
                          labelText: l.piEngineProviderApiKey,
                          border: const OutlineInputBorder(),
                          isDense: true,
                        ),
                      ),
                    ),
                    Padding(
                      padding: const EdgeInsets.fromLTRB(24, 0, 24, 12),
                      child: FilledButton.tonalIcon(
                        key: const ValueKey('fetch_remote_models'),
                        onPressed: fetching ? null : fetch,
                        icon: fetching
                            ? const SizedBox(
                                width: 16,
                                height: 16,
                                child: CircularProgressIndicator(strokeWidth: 2),
                              )
                            : const Icon(Icons.cloud_download_outlined),
                        label: Text(
                          fetching ? l.piEngineModelImportFetching : l.piEngineModelImportFetch,
                        ),
                      ),
                    ),
                    if (fetchError != null)
                      Padding(
                        padding: const EdgeInsets.fromLTRB(24, 0, 24, 8),
                        child: Text(
                          l.piEngineError(fetchError.toString()),
                          style: TextStyle(
                            color: Theme.of(ctx).colorScheme.error,
                            fontSize: 12,
                          ),
                        ),
                      )
                    else if (discovered.isEmpty && !fetching)
                      Padding(
                        padding: const EdgeInsets.fromLTRB(24, 0, 24, 8),
                        child: Text(
                          l.piEngineModelImportSelect,
                          style: Theme.of(ctx).textTheme.bodySmall?.copyWith(
                            color: Theme.of(ctx).colorScheme.onSurfaceVariant,
                          ),
                        ),
                      ),
                    if (discovered.isNotEmpty) ...[
                      const Divider(height: 1),
                      Padding(
                        padding: const EdgeInsets.fromLTRB(24, 12, 24, 4),
                        child: Row(
                          children: [
                            Expanded(
                              child: Text(
                                '${discovered.length} · ${l.piEngineModelImportSelect}',
                                style: Theme.of(ctx).textTheme.bodySmall?.copyWith(
                                  color: Theme.of(ctx).colorScheme.onSurfaceVariant,
                                ),
                              ),
                            ),
                            TextButton(
                              onPressed: () => setSheetState(() {
                                final allSelected = selected.length == discovered.length;
                                selected
                                  ..clear()
                                  ..addAll(allSelected ? const <String>[] : discovered.map((m) => m.id));
                              }),
                              child: Text(
                                selected.length == discovered.length ? l.clear : l.selectAll,
                              ),
                            ),
                          ],
                        ),
                      ),
                      Flexible(
                        child: ListView.builder(
                          shrinkWrap: true,
                          itemCount: discovered.length,
                          itemBuilder: (ctx, index) {
                            final model = discovered[index];
                            return CheckboxListTile(
                              key: ValueKey('remote_${model.id}'),
                              dense: true,
                              controlAffinity: ListTileControlAffinity.leading,
                              title: Text(
                                model.displayName,
                                style: const TextStyle(fontFamily: 'monospace'),
                              ),
                              subtitle: model.name == null
                                  ? null
                                  : Text(model.name!),
                              value: selected.contains(model.id),
                              onChanged: (checked) => setSheetState(() {
                                if (checked == true) {
                                  selected.add(model.id);
                                } else {
                                  selected.remove(model.id);
                                }
                              }),
                            );
                          },
                        ),
                      ),
                    ],
                    const Divider(height: 1),
                    Padding(
                      padding: const EdgeInsets.fromLTRB(24, 12, 24, 16),
                      child: FilledButton(
                        key: const ValueKey('import_selected_models'),
                        onPressed: selected.isEmpty || fetching
                            ? null
                            : () => Navigator.pop(ctx, selected.length),
                        child: Text(l.piEngineModelImportDone(selected.length, provider.id)),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          );
        },
      ),
    );
    baseUrlController.dispose();
    apiKeyController.dispose();
    if (!mounted || imported == null || imported == 0) return;
    final toImport = discovered.where((m) => selected.contains(m.id)).toList();
    if (toImport.isEmpty) return;
    await _importModels(provider.id, toImport);
  }

  Future<void> _importModelsJson() async {
    final l = AppLocalizations.of(context);
    final controller = TextEditingController();
    final messenger = ScaffoldMessenger.of(context);

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(l.piEngineModelsImportJson),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Align(
              alignment: Alignment.centerLeft,
              child: Text(
                l.piEngineModelsImportJsonDesc,
                style: Theme.of(ctx).textTheme.bodySmall?.copyWith(
                  color: Theme.of(ctx).colorScheme.onSurfaceVariant,
                ),
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              key: const ValueKey('import_json_editor'),
              controller: controller,
              maxLines: 12,
              minLines: 6,
              style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
              decoration: InputDecoration(
                border: const OutlineInputBorder(),
                isDense: true,
                hintText: l.piEngineModelsImportJsonHint,
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text(l.cancel),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(l.piEngineModelsImportJson),
          ),
        ],
      ),
    );
    final text = controller.text.trim();
    controller.dispose();
    if (confirmed != true || text.isEmpty) return;

    Object? parsed;
    try {
      parsed = jsonDecode(text);
    } catch (_) {
      messenger.showSnackBar(
        SnackBar(content: Text(l.piEngineModelsImportJsonInvalid)),
      );
      return;
    }
    if (parsed is! Map || parsed.isEmpty) {
      messenger.showSnackBar(
        SnackBar(content: Text(l.piEngineModelsImportJsonInvalid)),
      );
      return;
    }
    final connected = await ensurePiHostConnected(context);
    if (!mounted || !connected) return;
    final result = await _service.control(
      'import_models_json',
      payload: {'json': text},
    );
    if (!mounted) return;
    if (result.ok) {
      final data = result.data;
      final touched = data is Map ? data['touched'] : null;
      final count = touched is List ? touched.length : 0;
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(
          SnackBar(content: Text(l.piEngineModelsImportJsonDone(count))),
        );
      await _load();
    } else {
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(
          SnackBar(content: Text(l.piEngineError(result.error ?? 'import failed'))),
        );
    }
  }

  Future<void> _refreshModelCatalog() async {
    final l = AppLocalizations.of(context);
    final messenger = ScaffoldMessenger.of(context);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(l.piEngineRefreshCatalog),
        content: Text(l.piEngineRefreshCatalogConfirm),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text(l.cancel),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(l.piEngineRefreshCatalog),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    final connected = await ensurePiHostConnected(context);
    if (!mounted || !connected) return;
    messenger
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          content: Text(l.piEngineRefreshCatalogRunning),
          duration: const Duration(seconds: 2),
        ),
      );
    final result = await _service.control(
      'update_models',
      timeout: const Duration(seconds: 130),
    );
    if (!mounted) return;
    if (result.ok) {
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(content: Text(l.piEngineRefreshCatalogDone)));
    } else {
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(
          SnackBar(content: Text(l.piEngineError(result.error ?? 'update failed'))),
        );
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    return Scaffold(
      appBar: AppBar(
        title: Text(l.piEngineModels),
        actions: [
          IconButton(
            key: const ValueKey('import_models_json'),
            tooltip: l.piEngineModelsImportJson,
            icon: const Icon(Icons.upload_file_outlined),
            onPressed: _loading ? null : _importModelsJson,
          ),
          IconButton(
            key: const ValueKey('refresh_model_catalog'),
            tooltip: l.piEngineRefreshCatalog,
            icon: const Icon(Icons.refresh),
            onPressed: _loading ? null : _refreshModelCatalog,
          ),
          IconButton(
            key: const ValueKey('add_provider'),
            tooltip: l.piEngineProviderAdd,
            icon: const Icon(Icons.add),
            onPressed: _loading ? null : () => _showProviderEditor(),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.only(bottom: 32),
          children: [
            if (_error != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 24, 16, 0),
                child: Text(
                  _error == 'not_connected'
                      ? l.piEngineNotConnected
                      : l.piEngineError(_error ?? ''),
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ),
            if (_loading)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 48),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (_error == null && _providers.isEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 48),
                child: Center(
                  child: Text(
                    l.piEngineModelsEmpty,
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.onSurfaceVariant,
                    ),
                  ),
                ),
              )
            else if (_error == null)
              for (final entry in _providers.entries)
                _ProviderCard(
                  key: ValueKey('provider_${entry.key}'),
                  provider: entry.value,
                  onEdit: () => _showProviderEditor(
                    id: entry.key,
                    provider: entry.value,
                  ),
                  onAddModel: () => _showModelEditor(entry.key),
                  onImport: () => _importRemoteModels(entry.value),
                  onDelete: () => _removeProvider(entry.key),
                ),
            const SizedBox(height: 16),
          ],
        ),
      ),
    );
  }
}

class _ProviderCard extends StatelessWidget {
  const _ProviderCard({
    super.key,
    required this.provider,
    required this.onEdit,
    required this.onAddModel,
    required this.onImport,
    required this.onDelete,
  });

  final CustomProvider provider;
  final VoidCallback onEdit;
  final VoidCallback onAddModel;
  final VoidCallback onImport;
  final VoidCallback onDelete;

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final l = AppLocalizations.of(context);
    final apiKey = provider.apiKey;
    return Card(
      margin: const EdgeInsets.fromLTRB(16, 16, 16, 0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          ListTile(
            leading: CircleAvatar(
              radius: 18,
              backgroundColor: cs.primaryContainer,
              child: Icon(Icons.dns_outlined, size: 20, color: cs.onPrimaryContainer),
            ),
            title: Text(provider.id, style: const TextStyle(fontFamily: 'monospace')),
            subtitle: Text(
              [
                if (provider.baseUrl != null && provider.baseUrl!.isNotEmpty)
                  provider.baseUrl!,
                if (provider.api != null) provider.api!,
                if (apiKey != null && apiKey.isNotEmpty)
                  '•••${apiKey.length > 4 ? apiKey.substring(apiKey.length - 4) : ''}',
              ].join(' · '),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
            trailing: PopupMenuButton<String>(
              onSelected: (action) {
                switch (action) {
                  case 'edit':
                    onEdit();
                  case 'delete':
                    onDelete();
                }
              },
              itemBuilder: (ctx) => [
                PopupMenuItem(value: 'edit', child: Text(l.piEngineProviderEdit)),
                PopupMenuItem(value: 'delete', child: Text(l.piEngineProviderDelete)),
              ],
            ),
          ),
          if (provider.models.isNotEmpty) ...[
            const Divider(height: 1, indent: 56),
            for (final model in provider.models)
              ListTile(
                dense: true,
                leading: Icon(Icons.model_training, size: 18, color: cs.onSurfaceVariant),
                title: Text(model.id, style: const TextStyle(fontFamily: 'monospace')),
                subtitle: model.name == null
                    ? null
                    : Text(
                        [
                          model.name!,
                          if (model.reasoning == true) l.piEngineModelReasoningTag,
                        ].join(' · '),
                      ),
                trailing: model.reasoning == true
                    ? Icon(Icons.psychology_outlined, size: 16, color: cs.onSurfaceVariant)
                    : null,
              ),
          ],
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                TextButton.icon(
                  key: ValueKey('import_${provider.id}'),
                  onPressed: onImport,
                  icon: const Icon(Icons.cloud_download_outlined, size: 18),
                  label: Text(l.piEngineModelImport),
                ),
                const SizedBox(width: 8),
                TextButton.icon(
                  onPressed: onAddModel,
                  icon: const Icon(Icons.add, size: 18),
                  label: Text(l.piEngineModelAdd),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
