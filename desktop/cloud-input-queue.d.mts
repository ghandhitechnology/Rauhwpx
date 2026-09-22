import type { CloudDisplayInputEvent } from '../rhwp/rhwp-studio/src/cloud/types.ts';

export class CloudInputQueue {
  constructor(send: (streamId: string, events: CloudDisplayInputEvent[]) => Promise<void>,
    batchSize: () => number, now?: () => number);
  enqueue(streamId: string, event: CloudDisplayInputEvent): Promise<void>;
  reset(error?: unknown): void;
  close(): Promise<void>;
}
