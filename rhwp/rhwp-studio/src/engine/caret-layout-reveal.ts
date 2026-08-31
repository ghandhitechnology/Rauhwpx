const LAYOUT_BOUNDARY_OPERATION_TYPES = new Set([
  'pageBreak',
  'columnBreak',
]);

/** undo/redo history type의 `snapshot:` prefix를 제거한 실제 operation type을 반환한다. */
function baseOperationType(operationType: string): string {
  return operationType.startsWith('snapshot:')
    ? operationType.slice('snapshot:'.length)
    : operationType;
}

/**
 * 쪽/단 경계 삽입은 mutation 직후의 WASM 좌표보다 CanvasView의 가상 쪽 배치가 늦게 갱신된다.
 * 해당 명령만 다음 mutation layout 완료 뒤 캐럿을 한 번 더 드러내도록 예약한다.
 */
export class CaretLayoutReveal {
  private pending = false;

  /**
   * 허용된 쪽/단 나누기(및 해당 snapshot undo/redo)일 때만 다음 layout 완료에서
   * 한 번 reveal하도록 예약한다. 일반 편집 type은 pending을 바꾸지 않는다.
   */
  requestFor(operationType: string): void {
    if (LAYOUT_BOUNDARY_OPERATION_TYPES.has(baseOperationType(operationType))) {
      this.pending = true;
    }
  }

  /** layout 완료 이벤트를 기다리지 않고 pending 예약을 폐기한다. */
  clear(): void {
    this.pending = false;
  }

  /**
   * pending이면 true를 반환하고 즉시 지운다. 호출마다 최대 한 번만 true다.
   */
  consume(): boolean {
    const pending = this.pending;
    this.pending = false;
    return pending;
  }
}
