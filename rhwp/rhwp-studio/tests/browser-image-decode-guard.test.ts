import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function source(path: string): string {
  return readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
}

function between(contents: string, start: string, end: string): string {
  const startIndex = contents.indexOf(start);
  const endIndex = contents.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing end marker: ${end}`);
  return contents.slice(startIndex, endIndex);
}

function assertBefore(contents: string, first: string, second: string): void {
  const firstIndex = contents.indexOf(first);
  const secondIndex = contents.indexOf(second);
  assert.notEqual(firstIndex, -1, `missing guard: ${first}`);
  assert.notEqual(secondIndex, -1, `missing decode path: ${second}`);
  assert.ok(firstIndex < secondIndex, `${first} must run before ${second}`);
}

test('all file insertion and assignment paths guard encoded dimensions before Image decode', () => {
  const mainDrop = between(source('main.ts'), '    if (isImage) {', '    // HWP/HWPX/HML/RHWPX');
  assertBefore(mainDrop, 'assertEncodedImageDecodeDimensions(data', 'new Image()');

  const assignment = between(
    source('engine/input-handler-picture.ts'),
    'export function promptAssignPictureImage',
    'export function findPictureAtClick',
  );
  assertBefore(assignment, 'assertEncodedImageDecodeDimensions(data', 'new Image()');

  const picker = between(
    source('command/commands/insert.ts'),
    "    id: 'insert:image'",
    "    id: 'insert:textbox'",
  );
  assertBefore(picker, 'assertEncodedImageDecodeDimensions(data', 'new Image()');
});

test('clipboard conversion and paste guard encoded dimensions before Image decode', () => {
  const keyboard = source('engine/input-handler-keyboard.ts');
  const conversion = between(
    keyboard,
    'async function convertToPngBlob',
    '/** [Task #1161]',
  );
  assertBefore(conversion, "if (mime === 'image/png')", 'assertEncodedImageDecodeDimensions(data');
  assertBefore(conversion, 'assertEncodedImageDecodeDimensions(data', 'new Image()');

  const paste = between(
    keyboard,
    'async function pasteImageFile',
    '/** 기존 컨트롤 선택 상태를 모두 해제한다 */',
  );
  assertBefore(paste, 'assertEncodedImageDecodeDimensions(data', 'new Image()');
});

test('PageRenderer guards embedded raster data before DOM image decode and prefetch', () => {
  const renderer = source('view/page-renderer.ts');
  const flowImages = between(
    renderer,
    '  private createOrReuseFlowImageLayer',
    '  private createOrReuseFilteredCanvasLayer',
  );
  assertBefore(flowImages, 'assertBase64EncodedImageDecodeDimensions(image.base64', 'new Image()');

  const prefetch = between(
    renderer,
    '  private async prefetchLayerImages',
    '  /** 특정 페이지의 지연 재렌더링을 취소한다 */',
  );
  const rasterEnqueue = between(prefetch, '    const enqueueRaster', '    // image 항목들의');
  assertBefore(
    rasterEnqueue,
    'assertBase64EncodedImageDecodeDimensions(base64',
    'enqueueValidated(',
  );
  assert.match(prefetch, /while \(\(m = re\.exec\(json\)\) !== null\) \{\s+enqueueRaster\(m\[2\], m\[3\]\)/);
  assert.match(prefetch, /while \(\(d = dataUrlRe\.exec\(json\)\) !== null\) \{\s+enqueueRaster\(d\[1\], d\[2\]\)/);
});
