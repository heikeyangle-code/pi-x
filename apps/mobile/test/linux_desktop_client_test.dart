import 'package:ccpocket/services/fcm_service.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  tearDown(() {
    debugDefaultTargetPlatformOverride = null;
  });

  test('FcmService stays unavailable on Linux desktop', () async {
    debugDefaultTargetPlatformOverride = TargetPlatform.linux;

    final service = FcmService();

    expect(service.isSupportedPlatform, isFalse);
    expect(service.platform, 'linux');
    expect(await service.init(), isFalse);
    expect(service.isAvailable, isFalse);
    debugDefaultTargetPlatformOverride = null;
  });
}
