import { ModalDialog } from './dialog';

class DeleteHyperlinkDialog extends ModalDialog {
  private accepted = false;
  protected override sheet = true;
  constructor(private remove: () => void, private cancel: () => void) { super('지우기', 390); }
  protected createBody(): HTMLElement {
    const body = document.createElement('div');
    body.className = 'dialog-sheet-message';
    body.textContent = '[하이퍼링크]를 지울까요?';
    return body;
  }
  protected onConfirm(): void { this.accepted = true; }
  override show(): void {
    super.show();
    this.dialog.querySelector('.dialog-btn-primary')!.textContent = '지움';
  }
  override hide(): void {
    super.hide();
    if (this.accepted) this.remove();
    else this.cancel();
  }
}

export function confirmHyperlinkDelete(remove: () => void, cancel: () => void): void {
  new DeleteHyperlinkDialog(remove, cancel).show();
}
