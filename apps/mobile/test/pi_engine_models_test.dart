import 'package:flutter_test/flutter_test.dart';

import 'package:ccpocket/features/pi_engine/pi_engine_models.dart';

void main() {
  group('parseEngineArgs', () {
    test('empty input produces empty state', () {
      final parsed = parseEngineArgs(const []);
      expect(parsed.toggles, isEmpty);
      expect(parsed.values, isEmpty);
      expect(parsed.other, isEmpty);
    });

    test('recognizes documented --no-* toggles', () {
      final parsed = parseEngineArgs(const [
        '--no-context-files',
        '--no-skills',
        '--no-tools',
      ]);
      expect(parsed.toggles, {
        '--no-context-files': true,
        '--no-skills': true,
        '--no-tools': true,
      });
      expect(parsed.values, isEmpty);
      expect(parsed.other, isEmpty);
    });

    test('recognizes short aliases', () {
      final parsed = parseEngineArgs(const ['-nc', '-ne']);
      expect(parsed.toggles, {
        '--no-context-files': true,
        '--no-extensions': true,
      });
    });

    test('value flags consume the next token', () {
      final parsed = parseEngineArgs(const [
        '--tools',
        'bash,grep',
        '--use-theme',
        'dark',
      ]);
      expect(parsed.values, {
        '--tools': 'bash,grep',
        '--use-theme': 'dark',
      });
      expect(parsed.toggles, isEmpty);
      expect(parsed.other, isEmpty);
    });

    test('keeps unknown arguments verbatim', () {
      final parsed = parseEngineArgs(const [
        '--no-themes',
        '--future-flag',
        'positional',
      ]);
      expect(parsed.toggles, {'--no-themes': true});
      expect(parsed.other, ['--future-flag', 'positional']);
    });

    test('value flag without a following token is kept as other', () {
      final parsed = parseEngineArgs(const ['--tools']);
      expect(parsed.values, isEmpty);
      expect(parsed.other, ['--tools']);
    });
  });

  group('buildEngineArgs', () {
    test('round-trips parsed toggles and values', () {
      final parsed = parseEngineArgs(const [
        '--no-skills',
        '--tools',
        'bash,grep',
        '--exclude-tools',
        'rm',
        '--keep-this',
      ]);
      final rebuilt = buildEngineArgs(
        parsed.toggles,
        parsed.values,
        other: parsed.other,
      );
      expect(rebuilt, [
        '--no-skills',
        '--tools',
        'bash,grep',
        '--exclude-tools',
        'rm',
        '--keep-this',
      ]);
    });

    test('drops empty and whitespace-only values', () {
      final rebuilt = buildEngineArgs(
        const {'--no-tools': true},
        const {'--tools': '  '},
      );
      expect(rebuilt, ['--no-tools']);
    });

    test('emits flags in the documented spec order', () {
      final rebuilt = buildEngineArgs(
        const {
          '--no-extensions': true,
          '--no-context-files': true,
        },
        const {},
      );
      // Spec order: context-files, skills, prompt-templates, themes,
      // extensions, tools, builtin-tools.
      expect(rebuilt, ['--no-context-files', '--no-extensions']);
    });
  });

  group('CustomProvider / CustomModel', () {
    test('fromJson maps provider fields and models', () {
      final provider = CustomProvider.fromJson(
        'ollama',
        {
          'baseUrl': 'http://127.0.0.1:11434/v1',
          'api': 'openai-completions',
          'apiKey': 'secret',
          'models': [
            {'id': 'm1', 'name': 'M One', 'reasoning': true},
            {'id': 'm2'},
          ],
        },
      );
      expect(provider.id, 'ollama');
      expect(provider.baseUrl, 'http://127.0.0.1:11434/v1');
      expect(provider.api, 'openai-completions');
      expect(provider.apiKey, 'secret');
      expect(provider.models, hasLength(2));
      expect(provider.models.first.id, 'm1');
      expect(provider.models.first.name, 'M One');
      expect(provider.models.first.reasoning, isTrue);
      expect(provider.models.last.reasoning, isNull);
    });

    test('toJson omits empty optional fields', () {
      final json = const CustomModel(id: 'm1').toJson();
      expect(json, {'id': 'm1'});
      expect(json.containsKey('name'), isFalse);
      expect(json.containsKey('reasoning'), isFalse);
    });

    test('round-trips through toJson/fromJson', () {
      const model = CustomModel(
        id: 'm1',
        name: 'M One',
        reasoning: true,
      );
      expect(CustomModel.fromJson(model.toJson()).id, 'm1');
      expect(CustomModel.fromJson(model.toJson()).name, 'M One');
      expect(CustomModel.fromJson(model.toJson()).reasoning, isTrue);
    });

    test('malformed provider json falls back to defaults', () {
      final provider = CustomProvider.fromJson('x', const {});
      expect(provider.baseUrl, isNull);
      expect(provider.models, isEmpty);
    });

    test('provider preserves unknown official fields in extra', () {
      final provider = CustomProvider.fromJson(
        'proxy',
        {
          'baseUrl': 'https://proxy.example.com/v1',
          'api': 'anthropic-messages',
          'headers': {'x-secret': 's3'},
          'compat': {'supportsEagerToolInputStreaming': false},
          'modelOverrides': {
            'claude-sonnet-4': {'name': 'Renamed'},
          },
          'models': const [],
        },
      );
      expect(provider.extra['headers'], {'x-secret': 's3'});
      expect(provider.extra['compat'], {
        'supportsEagerToolInputStreaming': false,
      });
      expect(provider.extra['modelOverrides'], {
        'claude-sonnet-4': {'name': 'Renamed'},
      });
      // Round-trip keeps them.
      final rebuilt = CustomProvider.fromJson('proxy', provider.toJson());
      expect(rebuilt.extra['headers'], {'x-secret': 's3'});
      expect(rebuilt.extra['compat'], {
        'supportsEagerToolInputStreaming': false,
      });
      expect(rebuilt.extra['modelOverrides'], {
        'claude-sonnet-4': {'name': 'Renamed'},
      });
    });

    test('model preserves unknown official fields in extra', () {
      final model = CustomModel.fromJson({
        'id': 'deepseek-v4-flash',
        'reasoning': true,
        'input': ['text', 'image'],
        'contextWindow': 262144,
        'maxTokens': 16384,
        'cost': {'input': 0.6, 'output': 3},
        'samplingParams': {'temperature': 1.0, 'top_p': 0.95},
        'thinkingLevelMap': {'minimal': null, 'high': 'high'},
      });
      expect(model.extra['contextWindow'], 262144);
      expect(model.extra['cost'], {'input': 0.6, 'output': 3});
      expect(model.extra['thinkingLevelMap'], {
        'minimal': null,
        'high': 'high',
      });
      final rebuilt = CustomModel.fromJson(model.toJson());
      expect(rebuilt.extra['input'], ['text', 'image']);
      expect(rebuilt.extra['samplingParams'], {'temperature': 1.0, 'top_p': 0.95});
      expect(rebuilt.extra['thinkingLevelMap'], {
        'minimal': null,
        'high': 'high',
      });
      expect(rebuilt.reasoning, isTrue);
    });

    test('editing a provider does not drop model-level advanced fields', () {
      const original = CustomProvider(
        id: 'ollama',
        baseUrl: 'http://127.0.0.1:11434/v1',
        models: [
          CustomModel(
            id: 'qwen2.5-coder:7b',
            reasoning: true,
            extra: {'contextWindow': 32768, 'cost': {'input': 0, 'output': 0}},
          ),
        ],
        extra: {'compat': {'supportsDeveloperRole': false}},
      );
      // Simulate the editor flow: keep models + extra, change baseUrl.
      final edited = CustomProvider(
        id: original.id,
        baseUrl: 'http://127.0.0.1:11434/v2',
        api: original.api,
        apiKey: original.apiKey,
        models: original.models,
        extra: original.extra,
      );
      final json = edited.toJson();
      expect(json['baseUrl'], 'http://127.0.0.1:11434/v2');
      expect(json['compat'], {'supportsDeveloperRole': false});
      final modelJson = (json['models'] as List).first as Map<String, dynamic>;
      expect(modelJson['contextWindow'], 32768);
      expect(modelJson['cost'], {'input': 0, 'output': 0});
      expect(modelJson['reasoning'], isTrue);
    });
  });

  group('kEngineFlags / kEngineFlagValues', () {
    test('every spec has a unique long flag and a description key', () {
      final longs = [...kEngineFlags, ...kEngineFlagValues]
          .map((f) => f.long)
          .toSet();
      expect(longs.length, [...kEngineFlags, ...kEngineFlagValues].length);
      for (final spec in [...kEngineFlags, ...kEngineFlagValues]) {
        expect(spec.descriptionKey, isNotEmpty);
        expect(spec.long, startsWith('--'));
      }
    });

    test('value flags are the only takesValue specs', () {
      for (final spec in kEngineFlags) {
        expect(spec.takesValue, isFalse);
      }
      for (final spec in kEngineFlagValues) {
        expect(spec.takesValue, isTrue);
      }
    });

    test('kProviderApis covers the documented API kinds', () {
      expect(kProviderApis, containsAll([
        'openai-completions',
        'openai-responses',
        'anthropic-messages',
        'google-generative-ai',
      ]));
    });
  });
}
