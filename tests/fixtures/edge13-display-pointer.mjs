// Pointer-button validation used by edge13 before click-count negotiation.
export function acceptEdge13Pointer(value) {
  const fields = Object.keys(value).sort();
  const expected = ['kind', 'action', 'x', 'y', 'button'].sort();
  if (fields.length !== expected.length || fields.some((field, index) => field !== expected[index])
    || value.kind !== 'pointer' || !['down', 'up'].includes(value.action)
    || !['left', 'middle', 'right', 'back', 'forward'].includes(value.button)
    || !Number.isSafeInteger(value.x) || !Number.isSafeInteger(value.y)
    || value.x < 0 || value.x >= 1280 || value.y < 0 || value.y >= 800) {
    throw Object.assign(new Error('Pointer button fields are invalid'), { code: 'DISPLAY_INPUT_INVALID' });
  }
  return value;
}
