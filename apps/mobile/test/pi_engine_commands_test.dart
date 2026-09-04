import 'package:flutter_test/flutter_test.dart';

import 'package:ccpocket/features/pi_engine/pi_engine_commands.dart';

void main() {
  group('PiCommand.fromJson', () {
    test('parses a full command entry', () {
      final command = PiCommand.fromJson({
        'name': 'review',
        'description': 'Run a code review',
        'source': 'extension',
        'sourceInfo': {'location': '/home/u/.pi/agent/extensions/review'},
      });
      expect(command.name, 'review');
      expect(command.description, 'Run a code review');
      expect(command.source, 'extension');
      expect(command.invocation, '/review ');
    });

    test('tolerates missing optional fields', () {
      final command = PiCommand.fromJson({'name': 'compact'});
      expect(command.name, 'compact');
      expect(command.description, '');
      expect(command.source, 'extension');
    });

    test('falls back to a blank name for malformed entries', () {
      final command = PiCommand.fromJson(const {});
      expect(command.name, '');
      expect(command.source, 'extension');
    });
  });

  group('PiCommand.invocation', () {
    test('appends a trailing space for arguments', () {
      expect(
        PiCommand(name: 'skill:docx', description: '', source: 'skill')
            .invocation,
        '/skill:docx ',
      );
    });
  });

  group('equality', () {
    test('equal by fields', () {
      final a = PiCommand(name: 'x', description: 'd', source: 'prompt');
      final b = PiCommand(name: 'x', description: 'd', source: 'prompt');
      expect(a, b);
    });

    test('different source is different', () {
      final a = PiCommand(name: 'x', description: 'd', source: 'prompt');
      final b = PiCommand(name: 'x', description: 'd', source: 'extension');
      expect(a, isNot(b));
    });
  });
}
