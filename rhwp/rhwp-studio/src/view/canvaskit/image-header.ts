export interface EncodedImageDimensions {
  width: number;
  height: number;
}

export const MAX_IMAGE_DECODE_DIMENSION = 16_384;
export const MAX_IMAGE_DECODE_PIXELS = 32 * 1024 * 1024;
export const MAX_ENCODED_IMAGE_BYTES = 64 * 1024 * 1024;

// JPEG allows metadata segments before its size marker. Inspect a generous, bounded
// prefix when the only available representation is base64 so this guard does not
// duplicate an entire embedded image just to read its dimensions.
const MAX_ENCODED_IMAGE_HEADER_BYTES = 4 * 1024 * 1024;
const MAX_SVG_ROOT_BYTES = 64 * 1024;
const SVG_DEFAULT_WIDTH = 300;
const SVG_DEFAULT_HEIGHT = 150;

function svgLength(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^([+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(px|in|cm|mm|pt|pc)?$/i.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const factors: Record<string, number> = {
    px: 1,
    in: 96,
    cm: 96 / 2.54,
    mm: 96 / 25.4,
    pt: 96 / 72,
    pc: 16,
  };
  const pixels = amount * (factors[match[2]?.toLowerCase() ?? 'px'] ?? 1);
  return Number.isFinite(pixels) && pixels > 0 ? Math.ceil(pixels) : null;
}

function svgEncodedDimensions(bytes: Uint8Array): EncodedImageDimensions | null {
  // Only the bounded root tag is needed. This also keeps arbitrary unsupported
  // formats from being decoded into a second multi-megabyte string.
  const prefix = bytes.subarray(0, Math.min(bytes.byteLength, MAX_SVG_ROOT_BYTES));
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(prefix);
  } catch {
    return null;
  }
  const root = /<svg\b[^>]{0,65535}>/i.exec(text)?.[0];
  if (!root) return null;
  const attribute = (name: string) => new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i')
    .exec(root)?.[1];
  const width = svgLength(attribute('width'));
  const height = svgLength(attribute('height'));
  const viewBox = attribute('viewBox')
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  const hasViewBox = viewBox?.length === 4
    && viewBox.every(Number.isFinite)
    && viewBox[2] > 0
    && viewBox[3] > 0;

  if (width !== null && height !== null) return { width, height };
  if (hasViewBox && width !== null) {
    return { width, height: Math.ceil(width * (viewBox[3] / viewBox[2])) };
  }
  if (hasViewBox && height !== null) {
    return { width: Math.ceil(height * (viewBox[2] / viewBox[3])), height };
  }
  if (hasViewBox || (width === null && height === null)) {
    // SVG without two absolute intrinsic dimensions uses the browser's default
    // replaced-element viewport; a large coordinate-space viewBox does not
    // imply a correspondingly large pixel allocation.
    return { width: SVG_DEFAULT_WIDTH, height: SVG_DEFAULT_HEIGHT };
  }
  return null;
}

/** Encoded raster decode 전에 bounded dimensions를 확인한다. */
export function encodedImageDimensions(bytes: Uint8Array): EncodedImageDimensions | null {
  if (bytes.byteLength < 10) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;

  if (
    bytes.byteLength >= 24
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a
    && bytes[12] === 0x49
    && bytes[13] === 0x48
    && bytes[14] === 0x44
    && bytes[15] === 0x52
  ) {
    width = view.getUint32(16, false);
    height = view.getUint32(20, false);
  } else if (
    bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46
    && bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61
  ) {
    width = view.getUint16(6, true);
    height = view.getUint16(8, true);
  } else if (bytes.byteLength >= 26 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    width = view.getInt32(18, true);
    height = Math.abs(view.getInt32(22, true));
  } else if (
    bytes.byteLength >= 30
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    if (bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x58) {
      width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
      height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
    } else if (
      bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x20
      && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a
    ) {
      width = view.getUint16(26, true) & 0x3fff;
      height = view.getUint16(28, true) & 0x3fff;
    } else if (
      bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x4c
      && bytes[20] === 0x2f
    ) {
      width = 1 + bytes[21] + ((bytes[22] & 0x3f) << 8);
      height = 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10);
    } else {
      return null;
    }
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 3 < bytes.byteLength) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
      if (offset >= bytes.byteLength) return null;
      const marker = bytes[offset];
      offset += 1;
      if (marker === 0xd9 || marker === 0xda) return null;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.byteLength) return null;
      const segmentLength = view.getUint16(offset, false);
      if (segmentLength < 2 || offset + segmentLength > bytes.byteLength) return null;
      const isStartOfFrame = (
        marker >= 0xc0 && marker <= 0xcf
        && ![0xc4, 0xc8, 0xcc].includes(marker)
      );
      if (isStartOfFrame) {
        if (segmentLength < 7) return null;
        width = view.getUint16(offset + 5, false);
        height = view.getUint16(offset + 3, false);
        break;
      }
      offset += segmentLength;
    }
  } else {
    return svgEncodedDimensions(bytes);
  }
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0
    ? { width, height }
    : null;
}

/** Browser/CanvasKit decode에 허용할 공통 raster dimensions를 검증한다. */
export function assertImageDecodeDimensions(
  width: number,
  height: number,
  label = '이미지',
): EncodedImageDimensions {
  const pixels = width * height;
  if (
    !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || width <= 0
    || height <= 0
  ) {
    throw new Error(`${label}의 크기 정보를 확인할 수 없습니다.`);
  }
  if (
    width > MAX_IMAGE_DECODE_DIMENSION
    || height > MAX_IMAGE_DECODE_DIMENSION
    || !Number.isSafeInteger(pixels)
    || pixels > MAX_IMAGE_DECODE_PIXELS
  ) {
    throw new Error(
      `${label} 해상도가 안전 한도(${MAX_IMAGE_DECODE_DIMENSION}px, `
      + `${MAX_IMAGE_DECODE_PIXELS}픽셀)를 초과합니다.`,
    );
  }
  return { width, height };
}

/** Encoded bytes의 raster header를 읽고 browser decode 전에 공통 한도를 적용한다. */
export function assertEncodedImageDecodeDimensions(
  bytes: Uint8Array,
  label = '이미지',
): EncodedImageDimensions {
  if (bytes.byteLength > MAX_ENCODED_IMAGE_BYTES) {
    throw new Error(`${label} 데이터가 안전 한도를 초과합니다.`);
  }
  const dimensions = encodedImageDimensions(bytes);
  if (!dimensions) {
    throw new Error(`${label}의 인코딩된 크기 정보를 확인할 수 없습니다.`);
  }
  return assertImageDecodeDimensions(dimensions.width, dimensions.height, label);
}

/**
 * Embedded base64 raster의 bounded prefix만 복사하여 decode 전 dimensions를 검증한다.
 * 전체 decoded byte 길이도 먼저 제한해 큰 문자열이 header 검사에서 복제되지 않게 한다.
 */
export function assertBase64EncodedImageDecodeDimensions(
  base64: string,
  label = '이미지',
): EncodedImageDimensions {
  if (!base64) {
    throw new Error(`${label} 데이터가 비어 있습니다.`);
  }
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const decodedLength = Math.floor((base64.length * 3) / 4) - padding;
  if (
    !Number.isSafeInteger(decodedLength)
    || decodedLength <= 0
    || decodedLength > MAX_ENCODED_IMAGE_BYTES
  ) {
    throw new Error(`${label} 데이터가 안전 한도를 초과합니다.`);
  }

  const maxHeaderChars = Math.ceil(MAX_ENCODED_IMAGE_HEADER_BYTES / 3) * 4;
  const prefixLength = base64.length <= maxHeaderChars
    ? base64.length
    : maxHeaderChars - (maxHeaderChars % 4);
  let binary: string;
  try {
    binary = atob(base64.slice(0, prefixLength));
  } catch {
    throw new Error(`${label} 데이터가 올바른 base64 형식이 아닙니다.`);
  }
  const header = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) header[i] = binary.charCodeAt(i);
  return assertEncodedImageDecodeDimensions(header, label);
}
