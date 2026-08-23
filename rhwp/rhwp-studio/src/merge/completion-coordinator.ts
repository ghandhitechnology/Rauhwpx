import type {
  MergeApplicationRequest,
  MergeAppliedReceipt,
  MergeCompletionRequest,
} from './domain.ts';

/** Keeps the applied half of a two-phase merge retryable until finalization succeeds. */
export class MergeCompletionCoordinator {
  private _receipt: MergeAppliedReceipt | null = null;
  private _application: MergeApplicationRequest | null = null;

  get hasPending(): boolean { return this._receipt !== null; }
  get application(): MergeApplicationRequest | null { return this._application; }

  async ensureApplied(
    application: MergeApplicationRequest,
    apply: (request: MergeApplicationRequest) => Promise<MergeAppliedReceipt>,
  ): Promise<void> {
    if (this._receipt) return;
    const receipt = await apply(application);
    this._receipt = receipt;
    this._application = application;
  }

  async finalize(
    disposition: MergeCompletionRequest['sourceDisposition'],
    finalize: (
      receipt: MergeAppliedReceipt,
      disposition: MergeCompletionRequest['sourceDisposition'],
    ) => Promise<void>,
  ): Promise<MergeCompletionRequest> {
    if (!this._receipt || !this._application) throw new Error('No applied merge is pending finalization.');
    const receipt = this._receipt;
    const application = this._application;
    await finalize(receipt, disposition);
    this.reset();
    return { ...application, sourceDisposition: disposition };
  }

  reset(): void {
    this._receipt = null;
    this._application = null;
  }
}

