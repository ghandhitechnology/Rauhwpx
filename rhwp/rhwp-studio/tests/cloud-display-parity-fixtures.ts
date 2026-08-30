export const displaySessionId = 'session_display_01';
export const displayStreamId = 'stream-display-01';

export function validDisplayCapability() {
  return {
    kind: 'available' as const,
    protocol: 'rauhwpx-frame-v1' as const,
    sessionId: displaySessionId,
    streamId: displayStreamId,
    width: 1280,
    height: 800,
    maxFrameBytes: 524288 as const,
    maxFps: 2 as const,
  };
}

export function validDisplayMetadata() {
  return {
    sessionId: displaySessionId,
    streamId: displayStreamId,
    sequence: 7,
    capturedAt: '2026-08-30T00:00:07.000Z',
    width: 1280,
    height: 800,
    mimeType: 'image/jpeg' as const,
    byteLength: 5,
    sha256: 'a'.repeat(64),
    framePath: `/v1/sessions/${displaySessionId}/display/frames/${displayStreamId}/7`,
  };
}

const unavailableCapability = {
  kind: 'unavailable' as const,
  sessionId: displaySessionId,
  reason: 'client-unsupported' as const,
  message: 'Unsupported',
  retryable: false,
};

export const invalidDisplayCapabilities = [
  ...[
    ['reason', 'stream-unavailable'],
    ['message', 'Unavailable'],
    ['retryable', false],
  ].map(([field, extra]) => ({
    name: `available ${field}`,
    value: { ...validDisplayCapability(), [field]: extra },
  })),
  ...[
    ['protocol', 'rauhwpx-frame-v1'],
    ['streamId', displayStreamId],
    ['width', 1280],
    ['height', 800],
    ['maxFrameBytes', 524288],
    ['maxFps', 2],
  ].map(([field, extra]) => ({
    name: `unavailable ${field}`,
    value: {
      ...unavailableCapability,
      [field]: extra,
    },
  })),
];

export const invalidDisplayMetadata = [
  { name: 'explicit session mismatch', value: {
    ...validDisplayMetadata(),
    sessionId: 'session_display_other',
  } },
  ...[
    ['protocol', 'rauhwpx-frame-v1'],
    ['maxFrameBytes', 524288],
    ['maxFps', 2],
    ['reason', 'stream-unavailable'],
    ['retryable', false],
  ].map(([field, extra]) => ({
    name: `metadata ${field}`,
    value: { ...validDisplayMetadata(), [field]: extra },
  })),
];
