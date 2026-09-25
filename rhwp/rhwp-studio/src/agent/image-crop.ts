/**
 * 참조 이미지 잘라내기·확대 (insert_image cropPx, read_reference_image cropPx/zoom).
 *
 * 허브는 이미지 라이브러리가 없어 원본 바이트만 넘기고, 디코드·자르기·재인코딩은
 * 스튜디오 캔버스가 맡는다. 계획(planImageCrop)은 순수 함수라 노드 테스트로 고정한다.
 */
import { AgentToolError } from './types.ts';

export interface PixelBox { x: number; y: number; width: number; height: number }

export interface ImageCropPlan {
  /** 원본 안으로 맞춘 잘라내기 상자 (원본 px) */
  crop: PixelBox;
  outWidth: number;
  outHeight: number;
  /** 실제 확대 배율 (maxPixels 에 걸리면 요청 zoom 보다 작다) */
  scale: number;
}

export interface CroppedImage {
  bytes: Uint8Array;
  mimeType: 'image/png' | 'image/jpeg';
  widthPx: number;
  heightPx: number;
  crop: PixelBox;
  scale: number;
}

export interface ImageCropRequest {
  bytes: Uint8Array;
  mimeType: string;
  cropPx?: PixelBox;
  zoom?: number;
  maxPixels?: number;
  output: 'image/png' | 'image/jpeg';
}

export type ImageCropper = (request: ImageCropRequest) => Promise<CroppedImage>;

/** read_reference_image 결과 상한 — 비전 입력이 다시 줄이지 않는 크기 */
export const REFERENCE_READ_MAX_PIXELS = 1_150_000;

/** 원본 크기·잘라내기 상자·배율로 출력 크기를 정한다. 상자는 원본 안으로 잘린다. */
export function planImageCrop(
  sourceWidth: number, sourceHeight: number,
  cropPx?: PixelBox, zoom = 1, maxPixels = Number.POSITIVE_INFINITY,
): ImageCropPlan {
  const box = cropPx ?? { x: 0, y: 0, width: sourceWidth, height: sourceHeight };
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(sourceWidth, Math.ceil(box.x + box.width));
  const y1 = Math.min(sourceHeight, Math.ceil(box.y + box.height));
  if (x1 - x0 < 1 || y1 - y0 < 1) {
    throw new AgentToolError(
      'INVALID_ARGS',
      `cropPx lies outside the ${sourceWidth}x${sourceHeight} source image`,
    );
  }
  const crop = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  let scale = zoom;
  const area = crop.width * crop.height;
  if (area * scale * scale > maxPixels) scale = Math.sqrt(maxPixels / area);
  return {
    crop,
    outWidth: Math.max(1, Math.floor(crop.width * scale)),
    outHeight: Math.max(1, Math.floor(crop.height * scale)),
    scale: Math.round(scale * 1000) / 1000,
  };
}

function createCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  throw new AgentToolError('RENDER_UNAVAILABLE', 'Image cropping needs a canvas (browser environment)');
}

async function encodeCanvas(
  canvas: HTMLCanvasElement | OffscreenCanvas, type: CroppedImage['mimeType'],
): Promise<Uint8Array> {
  const quality = type === 'image/jpeg' ? 0.92 : undefined;
  const blob = typeof (canvas as OffscreenCanvas).convertToBlob === 'function'
    ? await (canvas as OffscreenCanvas).convertToBlob({ type, quality })
    : await new Promise<Blob | null>((resolve) => (canvas as HTMLCanvasElement).toBlob(resolve, type, quality));
  if (!blob) throw new AgentToolError('RENDER_UNAVAILABLE', 'Canvas image encoding failed');
  return new Uint8Array(await blob.arrayBuffer());
}

/** 브라우저 캔버스로 디코드 → 잘라내기/확대 → PNG 또는 JPEG 재인코딩 */
export const cropImageOnCanvas: ImageCropper = async (request) => {
  if (typeof createImageBitmap !== 'function') {
    throw new AgentToolError('RENDER_UNAVAILABLE', 'Image cropping needs a browser image decoder');
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([request.bytes as BlobPart], { type: request.mimeType }));
  } catch {
    throw new AgentToolError('INVALID_ARGS', 'the image could not be decoded');
  }
  try {
    const plan = planImageCrop(bitmap.width, bitmap.height, request.cropPx, request.zoom, request.maxPixels);
    const canvas = createCanvas(plan.outWidth, plan.outHeight);
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) throw new AgentToolError('RENDER_UNAVAILABLE', 'Canvas 2D context is unavailable');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (request.output === 'image/jpeg') {
      // JPEG 는 알파가 없다 — 투명 영역이 검게 나오지 않도록 흰 바탕을 깐다.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, plan.outWidth, plan.outHeight);
    }
    ctx.drawImage(
      bitmap,
      plan.crop.x, plan.crop.y, plan.crop.width, plan.crop.height,
      0, 0, plan.outWidth, plan.outHeight,
    );
    return {
      bytes: await encodeCanvas(canvas, request.output),
      mimeType: request.output,
      widthPx: plan.outWidth,
      heightPx: plan.outHeight,
      crop: plan.crop,
      scale: plan.scale,
    };
  } finally {
    bitmap.close();
  }
};
