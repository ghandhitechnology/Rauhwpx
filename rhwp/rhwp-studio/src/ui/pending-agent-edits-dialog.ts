/**
 * 검토 대기 중인 에이전트 편집 확인 대화상자.
 *
 * 대기 편집은 라이브 미리보기로 문서에 이미 반영돼 있어, 그대로 저장하면
 * 승인하지 않은 변경이 파일에 담긴다. 저장 전에 수락/거절을 결정하게 한다.
 */
import { ModalDialog } from './dialog';

export type PendingAgentEditsChoice = 'approve' | 'discard' | 'cancel';

class PendingAgentEditsDialog extends ModalDialog {
  private resolve!: (value: PendingAgentEditsChoice) => void;

  constructor(private readonly opCount: number) {
    super('검토 대기 변경', 420);
  }

  protected createBody(): HTMLElement {
    const body = document.createElement('div');
    body.style.padding = '16px 20px';
    body.style.lineHeight = '1.6';
    body.style.whiteSpace = 'pre-line';
    body.textContent = `에이전트 편집 ${this.opCount}건이 검토 대기 중입니다.\n저장하면 지금 보이는 미리보기가 파일에 그대로 담깁니다.`;
    return body;
  }

  protected onConfirm(): void {
    this.resolve('approve');
  }

  override hide(): void {
    this.resolve('cancel');
    super.hide();
  }

  showAsync(): Promise<PendingAgentEditsChoice> {
    return new Promise((resolve) => {
      let resolved = false;
      this.resolve = (value: PendingAgentEditsChoice) => {
        if (!resolved) {
          resolved = true;
          resolve(value);
        }
      };

      super.show();

      const footer = this.dialog.querySelector('.dialog-footer');
      const approveBtn = this.dialog.querySelector('.dialog-btn-primary') as HTMLButtonElement | null;
      const cancelBtn = footer?.querySelector('.dialog-btn:not(.dialog-btn-primary)') as HTMLButtonElement | null;

      if (approveBtn) approveBtn.textContent = '모두 수락 후 저장';
      if (cancelBtn) cancelBtn.textContent = '취소';

      const discardBtn = document.createElement('button');
      discardBtn.type = 'button';
      discardBtn.className = 'dialog-btn';
      discardBtn.textContent = '모두 거절 후 저장';
      discardBtn.addEventListener('click', () => {
        this.resolve('discard');
        super.hide();
      });
      footer?.insertBefore(discardBtn, cancelBtn ?? null);
    });
  }
}

export function showPendingAgentEditsDialog(opCount: number): Promise<PendingAgentEditsChoice> {
  return new PendingAgentEditsDialog(opCount).showAsync();
}
