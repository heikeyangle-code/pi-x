/// Parsed session deep-link parameters.
class SessionLinkParams {
  final String sessionId;
  final String provider;

  SessionLinkParams({required this.sessionId, this.provider = 'claude'});
}

/// Parses session deep links (`ccpocket://session/<id>?provider=...`).
///
/// Pi X is local-only (single machine), so opening a shared session by ID is
/// the only supported deep link. Remote-machine connect links
/// (`ccpocket://connect?url=...`, `ws://IP:PORT`, `IP:PORT`) were removed as
/// part of single-machine convergence.
class SessionLinkParser {
  static SessionLinkParams? parse(String rawUrl) {
    final trimmed = rawUrl.trim();
    if (!trimmed.startsWith('ccpocket://')) return null;
    final uri = Uri.tryParse(trimmed);
    if (uri == null || uri.host != 'session') return null;
    final segments = uri.pathSegments;
    if (segments.isEmpty) return null;
    final sessionId = segments.first;
    if (sessionId.isEmpty) return null;
    final provider = uri.queryParameters['provider'] == 'codex'
        ? 'codex'
        : 'claude';
    return SessionLinkParams(sessionId: sessionId, provider: provider);
  }
}
