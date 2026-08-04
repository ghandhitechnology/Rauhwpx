/**
 * RHWP - HWP 파일 뷰어 TypeScript 타입 정의
 *
 * WASM 모듈에서 노출되는 API의 TypeScript 타입.
 * wasm-pack이 자동 생성하는 pkg/rhwp.d.ts를 보완하는 설계 문서.
 */

/** HWP 문서 객체 */
export class HwpDocument {
  /** HWP 파일 바이트로부터 문서를 로드한다. */
  constructor(data: Uint8Array);

  /** 빈 문서를 생성한다 (테스트/미리보기용). */
  static createEmpty(): HwpDocument;

  /** 총 페이지 수를 반환한다. */
  pageCount(): number;

  /** 특정 페이지를 SVG 문자열로 렌더링한다. */
  renderPageSvg(pageNum: number): string;

  /** 특정 페이지를 HTML 문자열로 렌더링한다. */
  renderPageHtml(pageNum: number): string;

  /** 특정 페이지를 Canvas 명령 수로 반환한다. */
  renderPageCanvas(pageNum: number): number;

  /** 페이지 정보를 JSON 문자열로 반환한다. */
  getPageInfo(pageNum: number): string;

  /** 문서 정보를 JSON 문자열로 반환한다. */
  getDocumentInfo(): string;

  /** DPI를 설정한다. */
  setDpi(dpi: number): void;

  /** 현재 DPI를 반환한다. */
  getDpi(): number;

  /** 메모리를 해제한다 (WASM). */
  free(): void;
}

/** HWP 뷰어 컨트롤러 (뷰포트 관리 + 렌더링 스케줄링) */
export class HwpViewer {
  /** 뷰어를 생성한다. document 소유권이 이전된다. */
  constructor(document: HwpDocument);

  /** 뷰포트를 업데이트한다 (스크롤/리사이즈 시 호출). */
  updateViewport(scrollX: number, scrollY: number, width: number, height: number): void;

  /** 줌을 설정한다 (1.0 = 100%). */
  setZoom(zoom: number): void;

  /** 현재 보이는 페이지 목록을 반환한다. */
  visiblePages(): Uint32Array;

  /** 대기 중인 렌더링 작업 수를 반환한다. */
  pendingTaskCount(): number;

  /** 총 페이지 수를 반환한다. */
  pageCount(): number;

  /** 특정 페이지를 SVG 문자열로 렌더링한다. */
  renderPageSvg(pageNum: number): string;

  /** 특정 페이지를 HTML 문자열로 렌더링한다. */
  renderPageHtml(pageNum: number): string;

  /** 메모리를 해제한다 (WASM). */
  free(): void;
}

/** 페이지 정보 (getPageInfo 반환값) */
export interface PageInfo {
  pageIndex: number;
  width: number;
  height: number;
  sectionIndex: number;
}

/** 문서 정보 (getDocumentInfo 반환값) */
export interface DocumentInfo {
  version: string;
  sectionCount: number;
  pageCount: number;
  encrypted: boolean;
}

/** WASM 모듈 초기화 */
export default function init(): Promise<void>;

/** 버전 문자열 반환 */
export function version(): string;
