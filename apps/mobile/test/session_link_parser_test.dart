import 'package:ccpocket/services/session_link_parser.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('SessionLinkParser.parse', () {
    group('deep link - session (ccpocket://session)', () {
      test('parses session link with sessionId', () {
        final result = SessionLinkParser.parse(
          'ccpocket://session/abc-123-def',
        );

        expect(result, isNotNull);
        expect(result!.sessionId, 'abc-123-def');
        expect(result.provider, 'claude');
      });

      test('parses session link with UUID sessionId', () {
        final result = SessionLinkParser.parse(
          'ccpocket://session/550e8400-e29b-41d4-a716-446655440000',
        );

        expect(result, isNotNull);
        expect(result!.sessionId, '550e8400-e29b-41d4-a716-446655440000');
      });

      test('parses Codex provider from session link query', () {
        final result = SessionLinkParser.parse(
          'ccpocket://session/codex-session?provider=codex',
        );

        expect(result, isNotNull);
        expect(result!.sessionId, 'codex-session');
        expect(result.provider, 'codex');
      });

      test('defaults unsupported session link provider to Claude', () {
        final result = SessionLinkParser.parse(
          'ccpocket://session/claude-session?provider=unknown',
        );

        expect(result, isNotNull);
        expect(result!.provider, 'claude');
      });

      test('returns null for session link without sessionId', () {
        expect(SessionLinkParser.parse('ccpocket://session/'), isNull);
      });

      test('returns null for session link with empty path', () {
        expect(SessionLinkParser.parse('ccpocket://session'), isNull);
      });

      test('trims surrounding whitespace', () {
        final result = SessionLinkParser.parse(
          '  ccpocket://session/trimmed  ',
        );

        expect(result, isNotNull);
        expect(result!.sessionId, 'trimmed');
      });
    });

    group('remote-machine links (removed)', () {
      test('returns null for ws:// URL', () {
        expect(
          SessionLinkParser.parse('ws://192.168.1.1:8765'),
          isNull,
        );
      });

      test('returns null for wss:// URL', () {
        expect(
          SessionLinkParser.parse('wss://example.com:8765'),
          isNull,
        );
      });

      test('returns null for bare host:port', () {
        expect(SessionLinkParser.parse('192.168.1.1:8765'), isNull);
      });

      test('returns null for ccpocket://connect link', () {
        expect(
          SessionLinkParser.parse(
            'ccpocket://connect?url=ws://localhost:8765&token=x',
          ),
          isNull,
        );
      });
    });

    group('invalid inputs', () {
      test('returns null for empty string', () {
        expect(SessionLinkParser.parse(''), isNull);
      });

      test('returns null for random text', () {
        expect(SessionLinkParser.parse('not a url at all'), isNull);
      });

      test('returns null for unknown ccpocket host', () {
        expect(SessionLinkParser.parse('ccpocket://unknown/path'), isNull);
      });

      test('returns null for http:// URL', () {
        expect(SessionLinkParser.parse('http://example.com:8765'), isNull);
      });
    });
  });
}