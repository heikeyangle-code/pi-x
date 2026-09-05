import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ccpocket/features/pi_engine/pi_engine_models.dart';
import 'package:ccpocket/features/pi_engine/pi_model_switch.dart';
import 'package:ccpocket/l10n/app_localizations.dart';
import 'package:ccpocket/services/pi_host_service.dart';

void main() {
  group('groupPiModelsByProvider', () {
    test('groups by provider, sorting providers and models by name', () {
      final models = [
        PiModel(id: 'z9', provider: 'anthropic', name: 'Claude Z'),
        PiModel(id: 'a1', provider: 'openai', name: 'GPT'),
        PiModel(id: 'm2', provider: 'anthropic'),
        PiModel(id: 'local'),
      ];
      final grouped = groupPiModelsByProvider(models);

      // Empty-string bucket sorts first; providers follow alphabetically.
      expect(grouped.keys.toList(), ['', 'anthropic', 'openai']);
      // Within anthropic: displayName "Claude Z" < id "m2".
      expect(grouped['anthropic']!.map((m) => m.id).toList(), ['z9', 'm2']);
      expect(grouped['openai']!.single.id, 'a1');
      // Models without a provider fall into the empty-string bucket.
      expect(grouped['']!.single.id, 'local');
    });

    test('empty input produces empty grouping', () {
      expect(groupPiModelsByProvider(const []), isEmpty);
    });

    test('qualifies current selection by provider/id', () {
      final a = PiModel(id: 'gpt-5', provider: 'openai');
      final b = PiModel(id: 'gpt-5', provider: 'anthropic');
      expect(a.qualifiedId, 'openai/gpt-5');
      expect(b.qualifiedId, 'anthropic/gpt-5');
      expect(a == b, isFalse);
      expect(a == PiModel(id: 'gpt-5', provider: 'openai'), isTrue);
    });
  });

  group('PiModelChip', () {
    Widget app({required PiHostService service}) {
      return MaterialApp(
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: Scaffold(
          body: Center(child: PiModelChip(service: service)),
        ),
      );
    }

    testWidgets('shows fallback label when engine is unreachable',
        (tester) async {
      await tester.pumpWidget(app(service: PiHostService()));
      // Let the get_state call resolve to "not connected".
      await tester.pump();
      await tester.pump();

      expect(find.byKey(const ValueKey('session_model_chip')), findsOneWidget);
      expect(find.text('Model'), findsOneWidget);
    });

    testWidgets('tapping chip opens the picker with a retry action',
        (tester) async {
      await tester.pumpWidget(app(service: PiHostService()));
      await tester.pump();
      await tester.pump();

      await tester.tap(find.byKey(const ValueKey('session_model_chip')));
      await tester.pumpAndSettle();

      expect(find.text('Switch model'), findsOneWidget);
      expect(find.byKey(const ValueKey('model_switch_retry')), findsOneWidget);
    });
  });
}
