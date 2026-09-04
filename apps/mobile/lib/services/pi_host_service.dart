import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../core/logger.dart';

/// Connection lifecycle for the local Pi Host (`ws://127.0.0.1:{port}`).
enum PiHostConnectionState { disconnected, connecting, connected, reconnecting }

/// One envelope frame broadcast by the Pi Host server (docs/ENGINE-INTEGRATION).
class PiHostFrame {
  const PiHostFrame({
    required this.kind,
    required this.engineVersion,
    required this.protocolVersion,
    required this.frame,
  });

  factory PiHostFrame.fromJson(Map<String, dynamic> json) {
    return PiHostFrame(
      kind: json['kind'] as String? ?? 'pi',
      engineVersion: json['engineVersion'] as String? ?? '',
      protocolVersion: json['protocolVersion'] as int? ?? 0,
      frame: (json['frame'] as Map<String, dynamic>?) ?? const {},
    );
  }

  final String kind;
  final String engineVersion;
  final int protocolVersion;

  /// Engine frame; for control responses carries `correlationId` + `response`.
  final Map<String, dynamic> frame;

  bool get isControlResponse => frame.containsKey('correlationId');
  String? get correlationId => frame['correlationId'] as String?;
  String? get projectId => frame['projectId'] as String?;

  Map<String, dynamic>? get response =>
      frame['response'] as Map<String, dynamic>?;

  String? get error => frame['error'] as String?;
}

/// Result of a correlated control op.
class PiControlResult {
  const PiControlResult({required this.ok, this.response, this.error});

  const PiControlResult.failure(String message)
    : ok = false,
      response = null,
      error = message;

  final bool ok;
  final Map<String, dynamic>? response;
  final String? error;

  bool get success => ok && response?['success'] == true;
  dynamic get data => response?['data'];

  @override
  String toString() =>
      'PiControlResult(ok=$ok, success=$success, error=$error)';
}

/// Thin WebSocket client for the Pi Host server (pi-host/server.ts).
///
/// Wire:
///   out: {"type":"control","op":...,"projectId":...,"payload":...,"id":...}
///   in:  {"kind":"pi","engineVersion":...,"protocolVersion":N,"frame":{...}}
/// Control replies carry `frame.correlationId` matching our request id;
/// everything else (message_update, extension_ui_request, ...) is an engine
/// event broadcast on [events].
class PiHostService {
  PiHostService({
    WebSocketChannel Function(Uri uri, {Iterable<String>? protocols})? connect,
  }) : _connect =
           connect ??
           ((Uri uri, {Iterable<String>? protocols}) {
             return WebSocketChannel.connect(
                uri,
                protocols: protocols?.toList(),
              );
           });

  /// How the local Pi Host server authenticates (Sec-WebSocket-Protocol).
  String? apiKey;

  /// Synthetic project id for engine-global management ops (settings/models/
  /// prompt files). Project-scoped ops pass the workspace path explicitly.
  static const kEngineProjectId = 'pi-x-engine';

  final WebSocketChannel Function(Uri uri, {Iterable<String>? protocols})
  _connect;

  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _subscription;
  final _eventsController = StreamController<PiHostFrame>.broadcast();
  final Map<String, Completer<PiControlResult>> _pending = {};
  final ValueNotifier<PiHostConnectionState> _state =
      ValueNotifier(PiHostConnectionState.disconnected);
  final ValueNotifier<String> _engineVersion =
      ValueNotifier<String>('');

  Timer? _reconnectTimer;
  int _reconnectAttempt = 0;
  bool _intentionalDisconnect = false;
  bool _disposed = false;
  int _idCounter = 0;
  Uri? _lastUri;

  static const _maxReconnectDelay = 30;

  /// Connection lifecycle changes.
  ValueNotifier<PiHostConnectionState> get state => _state;

  /// Last engine version seen on the wire ('' until first frame).
  ValueNotifier<String> get engineVersion => _engineVersion;

  /// Engine event frames (not control replies).
  Stream<PiHostFrame> get events => _eventsController.stream;

  bool get isConnected => _state.value == PiHostConnectionState.connected;

  String get lastUrl => _lastUri?.toString() ?? '';

  void connect(String host, int port, {String? apiKey}) {
    if (_disposed) return;
    this.apiKey = apiKey;
    _connectTo(Uri(scheme: 'ws', host: host, port: port));
  }

  void _connectTo(Uri uri) {
    if (_disposed) return;
    _intentionalDisconnect = false;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _lastUri = uri;
    _state.value = PiHostConnectionState.connecting;
    _channel?.sink.close();
    _subscription?.cancel();
    _channel = null;
    try {
      final channel = _connect(
        uri,
        protocols: (apiKey == null || apiKey!.isEmpty) ? null : [apiKey!],
      );
      _channel = channel;
      _subscription = channel.stream.listen(
        _handleData,
        onError: (Object error, StackTrace stack) {
          logger.warning('PiHost ws error', error, stack);
          _handleDisconnect();
        },
        onDone: _handleDisconnect,
        cancelOnError: true,
      );
      _state.value = PiHostConnectionState.connected;
    } catch (error, stack) {
      logger.warning('PiHost connect failed', error, stack);
      _state.value = PiHostConnectionState.disconnected;
      _scheduleReconnect();
    }
  }

  void _handleData(dynamic data) {
    Map<String, dynamic>? json;
    try {
      final decoded = jsonDecode(data as String);
      if (decoded is Map<String, dynamic>) json = decoded;
    } catch (_) {
      return;
    }
    if (json == null) return;
    final frame = PiHostFrame.fromJson(json);
    if (frame.engineVersion.isNotEmpty &&
        frame.engineVersion != _engineVersion.value) {
      _engineVersion.value = frame.engineVersion;
    }
    final correlationId = frame.correlationId;
    if (correlationId != null) {
      final completer = _pending.remove(correlationId);
      if (completer != null) {
        if (frame.error != null) {
          completer.complete(PiControlResult.failure(frame.error!));
        } else {
          completer.complete(
            PiControlResult(ok: true, response: frame.response),
          );
        }
        return;
      }
    }
    if (!_eventsController.isClosed) {
      _eventsController.add(frame);
    }
  }

  void _handleDisconnect() {
    if (_disposed) return;
    _channel = null;
    final pending = _pending.values.toList();
    _pending.clear();
    for (final completer in pending) {
      if (!completer.isCompleted) {
        completer.complete(const PiControlResult.failure('connection lost'));
      }
    }
    _state.value = PiHostConnectionState.disconnected;
    _scheduleReconnect();
  }

  void _scheduleReconnect() {
    if (_intentionalDisconnect || _lastUri == null || _disposed) return;
    if (_reconnectTimer?.isActive ?? false) return;
    _reconnectAttempt += 1;
    final delay = min(
      pow(2, _reconnectAttempt).toInt(),
      _maxReconnectDelay,
    );
    _state.value = PiHostConnectionState.reconnecting;
    _reconnectTimer = Timer(Duration(seconds: delay), () {
      if (_lastUri != null && !_intentionalDisconnect && !_disposed) {
        _connectTo(_lastUri!);
      }
    });
  }

  /// Send a control message and await the correlated reply.
  Future<PiControlResult> control(
    String op, {
    String projectId = kEngineProjectId,
    Map<String, dynamic>? payload,
    Duration timeout = const Duration(seconds: 15),
  }) async {
    if (_disposed) return const PiControlResult.failure('service disposed');
    final channel = _channel;
    if (channel == null || !isConnected) {
      return const PiControlResult.failure('not connected');
    }
    final id = _nextId();
    final completer = Completer<PiControlResult>();
    _pending[id] = completer;
    final timer = Timer(timeout, () {
      _pending.remove(id);
      if (!completer.isCompleted) {
        completer.complete(PiControlResult.failure('timeout: $op'));
      }
    });
    try {
      channel.sink.add(
        jsonEncode({
          'type': 'control',
          'op': op,
          'projectId': projectId,
          'payload': ?payload,
          'id': id,
        }),
      );
    } catch (error, stack) {
      timer.cancel();
      _pending.remove(id);
      logger.warning('PiHost control send failed', error, stack);
      return const PiControlResult.failure('send failed');
    }
    final result = await completer.future;
    timer.cancel();
    return result;
  }

  /// Answer a previously broadcast `extension_ui_request` by its id.
  /// select/input/editor -> value; confirm -> confirmed; all -> cancelled.
  void respondUi(String requestId, {Object? value, bool? confirmed, bool? cancelled}) {
    final channel = _channel;
    if (channel == null || !isConnected) return;
    try {
      channel.sink.add(
        jsonEncode({
          'type': 'ui_response',
          'id': requestId,
          'value': ?value,
          'confirmed': ?confirmed,
          if (cancelled == true) 'cancelled': true,
        }),
      );
    } catch (error, stack) {
      logger.warning('PiHost ui_response send failed', error, stack);
    }
  }

  void disconnect() {
    _intentionalDisconnect = true;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _channel?.sink.close();
    _channel = null;
    _subscription?.cancel();
    _subscription = null;
    final pending = _pending.values.toList();
    _pending.clear();
    for (final completer in pending) {
      if (!completer.isCompleted) {
        completer.complete(const PiControlResult.failure('disconnected'));
      }
    }
    _state.value = PiHostConnectionState.disconnected;
  }

  String _nextId() {
    _idCounter += 1;
    final rand = Random().nextInt(0xFFFFFF).toRadixString(16).padLeft(6, '0');
    return 'pix${DateTime.now().microsecondsSinceEpoch.toRadixString(16)}'
        '$_idCounter$rand';
  }

  void dispose() {
    if (_disposed) return;
    _disposed = true;
    disconnect();
    _eventsController.close();
    _state.dispose();
    _engineVersion.dispose();
  }
}
