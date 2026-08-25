import type { WasmBridge } from '../core/wasm-bridge.ts';
import type { DocumentPosition } from '../core/types.ts';
import type { EditCommand } from './command.ts';

export interface CapturedSnapshotCallbacks {
  /** Runs synchronously after the before snapshot has been restored. */
  afterUndo?: () => void;
  /** Runs synchronously after the after snapshot has been restored. */
  afterRedo?: () => void;
}

/**
 * Records a mutation that has already been applied between two exact document snapshots.
 * Undo and redo restore the captured states without replaying a lossy generic operation.
 */
export class CapturedSnapshotCommand implements EditCommand {
  readonly type: string;
  readonly timestamp = Date.now();

  private beforeId: number | null;
  private afterId: number | null;
  private cursorBefore: DocumentPosition;
  private cursorAfter: DocumentPosition;
  private callbacks: CapturedSnapshotCallbacks;

  constructor(
    operationType: string,
    cursorBefore: DocumentPosition,
    cursorAfter: DocumentPosition,
    beforeId: number,
    afterId: number,
    callbacks: CapturedSnapshotCallbacks = {},
  ) {
    this.type = `snapshot:${operationType}`;
    this.cursorBefore = cursorBefore;
    this.cursorAfter = cursorAfter;
    this.beforeId = beforeId;
    this.afterId = afterId;
    this.callbacks = callbacks;
  }

  execute(wasm: WasmBridge): DocumentPosition {
    if (this.afterId !== null) wasm.restoreSnapshot(this.afterId);
    this.callbacks.afterRedo?.();
    return { ...this.cursorAfter };
  }

  undo(wasm: WasmBridge): DocumentPosition {
    if (this.beforeId !== null) wasm.restoreSnapshot(this.beforeId);
    this.callbacks.afterUndo?.();
    return { ...this.cursorBefore };
  }

  mergeWith(): null { return null; }

  snapshotResourceCount(): number {
    return (this.beforeId !== null ? 1 : 0) + (this.afterId !== null ? 1 : 0);
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
