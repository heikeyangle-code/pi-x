import 'package:flutter_test/flutter_test.dart';

import 'package:ccpocket/features/pi_engine/pi_engine_commands.dart';

void main() {
  group('PiCommand.fromJson', () {
    test('parses a full official entry (rpc.md get_commands shape)', () {
      final command = PiCommand.fromJson({
        'name': 'session-name',
        'description': 'Set or clear session name',
        'source': 'extension',
        'path': '/home/u/.pi/agent/extensions/session.ts',
      });
      expect(command.name, 'session-name');
      expect(command.description, 'Set or clear session name');
      expect(command.source, 'extension');
      expect(command.location, isNull);
      expect(command.path, '/home/u/.pi/agent/extensions/session.ts');
      expect(command.invocation, '/session-name ');
    });

    test('parses location/path for prompt and skill commands', () {
      final prompt = PiCommand.fromJson({
        'name': 'fix-tests',
        'description': 'Fix failing tests',
        'source': 'prompt',
        'location': 'project',
        'path': '/home/u/myproject/.pi/prompts/fix-tests.md',
      });
      expect(prompt.location, 'project');
      expect(prompt.path, '/home/u/myproject/.pi/prompts/fix-tests.md');

      final skill = PiCommand.fromJson({
        'name': 'skill:brave-search',
        'description': 'Web search via Brave API',
        'source': 'skill',
        'location': 'user',
        'path': '/home/u/.pi/agent/skills/brave-search/SKILL.md',
      });
      expect(skill.location, 'user');
      expect(skill.invocation, '/skill:brave-search ');
    });

    test('tolerates missing optional fields', () {
      final command = PiCommand.fromJson({'name': 'compact'});
      expect(command.name, 'compact');
      expect(command.description, '');
      expect(command.source, 'extension');
      expect(command.location, isNull);
      expect(command.path, isNull);
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

    test('different location/path is different', () {
      final a = PiCommand(
        name: 'x',
        description: 'd',
        source: 'prompt',
        location: 'user',
        path: '/u/.pi/agent/prompts/x.md',
      );
      final b = PiCommand(
        name: 'x',
        description: 'd',
        source: 'prompt',
        location: 'project',
        path: '/p/.pi/prompts/x.md',
      );
      expect(a, isNot(b));
    });
  });
}
