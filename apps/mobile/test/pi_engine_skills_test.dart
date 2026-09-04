import 'package:flutter_test/flutter_test.dart';

import 'package:ccpocket/features/pi_engine/pi_engine_skills.dart';

void main() {
  group('PiSkill.fromJson', () {
    test('parses a full skill entry', () {
      final skill = PiSkill.fromJson({
        'name': 'code-review',
        'scope': 'global',
        'description': 'Run a thorough code review',
      });
      expect(skill.name, 'code-review');
      expect(skill.scope, 'global');
      expect(skill.description, 'Run a thorough code review');
      expect(skill.isProject, isFalse);
    });

    test('parses a project-scoped skill without description', () {
      final skill = PiSkill.fromJson({'name': 'docs', 'scope': 'project'});
      expect(skill.name, 'docs');
      expect(skill.scope, 'project');
      expect(skill.description, '');
      expect(skill.isProject, isTrue);
    });

    test('falls back to defaults for malformed entries', () {
      final skill = PiSkill.fromJson(const {});
      expect(skill.name, '');
      expect(skill.scope, 'global');
      expect(skill.description, '');
      expect(skill.isProject, isFalse);
    });
  });

  group('equality', () {
    test('equal by fields', () {
      final a = PiSkill(name: 'x', scope: 'global', description: 'd');
      final b = PiSkill(name: 'x', scope: 'global', description: 'd');
      expect(a, b);
    });

    test('different scope is different', () {
      final a = PiSkill(name: 'x', scope: 'global', description: 'd');
      final b = PiSkill(name: 'x', scope: 'project', description: 'd');
      expect(a, isNot(b));
    });
  });
}
