import type { WasmBridge } from '../core/wasm-bridge.ts';
import type { DocumentPosition } from '../core/types.ts';
import type { EditCommand } from './command.ts';

/**
 * 이미 화면에 적용된 복합 편집을 단일 undo 항목으로 채택하는 스냅샷 명령.
 *
 * 호출부가 문서의 "편집 전" 상태를 잠시 복원해 beforeId 를 캡처한 뒤 원래
 * 미리보기 상태로 돌아와 최초 execute()를 호출한다. 최초 실행은 미리보기 위에
 * 승인 시점에만 필요한 작업을 적용하고 after 스냅샷을 저장한다. 이후 execute는
 * redo이므로 저장된 after를 그대로 복원한다.
 */
export class PreparedSnapshotCommand implements EditCommand {
  readonly type: string;
  readonly timestamp = Date.now();

  private cursorBefore: DocumentPosition;
  private cursorAfter: DocumentPosition;
  private beforeId: number | null;
  private afterId: number | null = null;
  private operation: ((wasm: WasmBridge) => DocumentPosition) | null;

  constructor(
    operationType: string,
    cursorBefore: DocumentPosition,
    cursorAfter: DocumentPosition,
    beforeId: number,
    operation: (wasm: WasmBridge) => DocumentPosition,
  ) {
    this.type = `snapshot:${operationType}`;
    this.cursorBefore = cursorBefore;
    this.cursorAfter = cursorAfter;
    this.beforeId = beforeId;
    this.operation = operation;
  }

  execute(wasm: WasmBridge): DocumentPosition {
    if (this.afterId !== null) {
      wasm.restoreSnapshot(this.afterId);
      return { ...this.cursorAfter };
    }

    try {
      if (this.operation) this.cursorAfter = this.operation(wasm);
      this.afterId = wasm.saveSnapshot();
    } catch (e) {
      this.discard(wasm);
      throw e;
    }
    this.operation = null;
    return { ...this.cursorAfter };
  }

  undo(wasm: WasmBridge): DocumentPosition {
    if (this.beforeId !== null) wasm.restoreSnapshot(this.beforeId);
    return { ...this.cursorBefore };
  }

  mergeWith(): null { return null; }

  snapshotResourceCount(): number {
    return (this.beforeId !== null ? 1 : 0) + (this.afterId !== null ? 1 : 0);
  }

  currentSnapshotId(): number | null {
    return this.afterId;
  }

  undoSnapshotId(): number | null {
    return this.beforeId;
  }

  discard(wasm: WasmBridge): void {
    if (this.beforeId !== null) {
      wasm.discardSnapshot(this.beforeId);
      this.beforeId = null;
    }
    if (this.afterId !== null) {
      wasm.discardSnapshot(this.afterId);
      this.afterId = null;
    }
  }
}
