export async function runCloudMessageSubmission<TTarget, TPrepared, TCommitted>({
  acquire,
  target: initialTarget,
  changeTarget,
  prepare,
  isCurrent,
  queue,
  commit,
  restore,
}: {
  acquire(): { release(): void };
  target: TTarget;
  changeTarget?(target: TTarget): Promise<TTarget>;
  prepare(): Promise<TPrepared>;
  isCurrent(target: TTarget): boolean;
  queue(target: TTarget, prepared: TPrepared): Promise<void>;
  commit(target: TTarget, prepared: TPrepared): TCommitted;
  restore(prepared: TPrepared): void | Promise<void>;
}): Promise<
  | { kind: 'accepted'; committed: TCommitted }
  | { kind: 'stale' }
> {
  const lock = acquire();
  let prepared: TPrepared | undefined;
  let preparationCompleted = false;
  let accepted = false;
  try {
    const target = changeTarget ? await changeTarget(initialTarget) : initialTarget;
    prepared = await prepare();
    preparationCompleted = true;
    if (!isCurrent(target)) {
      preparationCompleted = false;
      await restore(prepared);
      return { kind: 'stale' };
    }
    await queue(target, prepared);
    accepted = true;
    return { kind: 'accepted', committed: commit(target, prepared) };
  } catch (error) {
    if (preparationCompleted && !accepted) await restore(prepared as TPrepared);
    throw error;
  } finally {
    lock.release();
  }
}
