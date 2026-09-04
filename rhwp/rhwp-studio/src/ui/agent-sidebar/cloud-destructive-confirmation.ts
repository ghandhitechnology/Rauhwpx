export type CloudServerDestructiveAction = 'delete' | 'recreate';

export type CloudServerDestructiveActionResult =
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'ignored'
  | 'stale';

export interface CloudServerDestructiveActionRequest {
  action: CloudServerDestructiveAction;
  trigger: HTMLElement;
  fallbackFocus?: HTMLElement;
  isCurrent(): boolean;
  run(): void | Promise<void>;
  onStale?(): void;
}

interface CloudServerDestructiveConfirmationHandle {
  result: Promise<boolean>;
  dismiss(): void;
}

export interface CloudServerDestructiveConfirmationCopy {
  title: string;
  confirmLabel: string;
  serverImpact: string;
}

export interface CloudServerDestructiveActionGate {
  request(request: CloudServerDestructiveActionRequest): Promise<CloudServerDestructiveActionResult>;
  invalidate(): void;
  dispose(): void;
}

interface CloudServerDestructiveActionGateDeps {
  present?: (
    action: CloudServerDestructiveAction,
    trigger: HTMLElement,
    fallbackFocus?: HTMLElement,
  ) => CloudServerDestructiveConfirmationHandle;
  onError?(error: unknown): void;
}

let confirmationSequence = 0;

export function cloudServerDestructiveConfirmationCopy(
  action: CloudServerDestructiveAction,
): CloudServerDestructiveConfirmationCopy {
  return action === 'recreate'
    ? {
      title: 'Raucloud 서버를 다시 만들까요?',
      confirmLabel: '모든 Cloud 작업을 끝내고 서버 다시 만들기',
      serverImpact: '현재 Raucloud 서버와 저장된 작업 데이터가 삭제된 뒤 새 서버가 만들어집니다.',
    }
    : {
      title: 'Raucloud 서버를 삭제할까요?',
      confirmLabel: '모든 Cloud 작업을 끝내고 서버 삭제',
      serverImpact: 'Raucloud 서버와 저장된 작업 데이터가 삭제됩니다.',
    };
}

function presentCloudServerDestructiveConfirmation(
  action: CloudServerDestructiveAction,
  trigger: HTMLElement,
  fallbackFocus?: HTMLElement,
): CloudServerDestructiveConfirmationHandle {
  const copy = cloudServerDestructiveConfirmationCopy(action);
  const id = `ag-cloud-destructive-${++confirmationSequence}`;
  const overlay = document.createElement('div');
  overlay.className = 'ag-cloud-destructive-overlay';

  const dialog = document.createElement('section');
  dialog.className = 'ag-cloud-destructive-dialog';
  dialog.setAttribute('role', 'alertdialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', `${id}-title`);
  dialog.setAttribute('aria-describedby', `${id}-impact`);

  const eyebrow = document.createElement('span');
  eyebrow.className = 'ag-cloud-destructive-eyebrow';
  eyebrow.textContent = '계정 전체 작업';
  const title = document.createElement('h2');
  title.id = `${id}-title`;
  title.textContent = copy.title;
  const impact = document.createElement('div');
  impact.id = `${id}-impact`;
  impact.className = 'ag-cloud-destructive-impact';
  const lead = document.createElement('p');
  lead.textContent = '이 작업은 되돌릴 수 없습니다.';
  const consequences = document.createElement('ul');
  for (const consequence of [
    '실행 중인 모든 Cloud 작업과 진행 중인 이어받기 및 전송이 즉시 끝납니다.',
    '아직 이 기기에 저장되지 않은 원격 문서 변경 내용은 복구할 수 없습니다.',
    copy.serverImpact,
  ]) {
    const item = document.createElement('li');
    item.textContent = consequence;
    consequences.appendChild(item);
  }
  impact.append(lead, consequences);

  const footer = document.createElement('footer');
  footer.className = 'ag-cloud-destructive-actions';
  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'ag-cloud-destructive-button ag-cancel';
  cancelButton.textContent = '취소';
  const confirmButton = document.createElement('button');
  confirmButton.type = 'button';
  confirmButton.className = 'ag-cloud-destructive-button ag-confirm';
  confirmButton.textContent = copy.confirmLabel;
  footer.append(cancelButton, confirmButton);
  dialog.append(eyebrow, title, impact, footer);
  overlay.appendChild(dialog);

  let settled = false;
  let resolveResult!: (confirmed: boolean) => void;
  const result = new Promise<boolean>((resolve) => {
    resolveResult = resolve;
  });
  const inertedElements: Array<[HTMLElement, boolean]> = [];

  const restoreFocus = (): void => {
    const target = trigger.isConnected ? trigger : fallbackFocus?.isConnected ? fallbackFocus : null;
    target?.focus();
  };

  const finish = (confirmed: boolean): void => {
    if (settled) return;
    settled = true;
    cancelButton.disabled = true;
    confirmButton.disabled = true;
    document.removeEventListener('keydown', onKeydown, true);
    document.removeEventListener('focusin', containFocus, true);
    overlay.remove();
    for (const [node, wasInert] of inertedElements) node.inert = wasInert;
    resolveResult(confirmed);
    queueMicrotask(restoreFocus);
  };

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      finish(false);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      finish(document.activeElement === confirmButton);
      return;
    }
    if (event.key !== 'Tab') return;
    if (event.shiftKey && document.activeElement === cancelButton) {
      event.preventDefault();
      confirmButton.focus();
    } else if (!event.shiftKey && document.activeElement === confirmButton) {
      event.preventDefault();
      cancelButton.focus();
    }
  };

  const containFocus = (event: FocusEvent): void => {
    if (settled || dialog.contains(event.target as Node)) return;
    cancelButton.focus();
  };

  cancelButton.addEventListener('click', () => finish(false));
  confirmButton.addEventListener('click', () => finish(true));
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) finish(false);
  });

  document.body.appendChild(overlay);
  for (const node of [...document.body.children]) {
    if (!(node instanceof HTMLElement) || node === overlay) continue;
    inertedElements.push([node, node.inert]);
    node.inert = true;
  }
  document.addEventListener('keydown', onKeydown, true);
  document.addEventListener('focusin', containFocus, true);
  queueMicrotask(() => {
    if (!settled) cancelButton.focus();
  });

  return {
    result,
    dismiss: () => finish(false),
  };
}

/**
 * Serializes destructive account-wide server actions. Presentation settles before
 * the current-state guard and mutation run, so stale or repeated approvals fail closed.
 */
export function createCloudServerDestructiveActionGate(
  deps: CloudServerDestructiveActionGateDeps = {},
): CloudServerDestructiveActionGate {
  const present = deps.present ?? presentCloudServerDestructiveConfirmation;
  let generation = 0;
  let active: { generation: number; dismiss(): void } | null = null;
  let mutationActive = false;
  let disposed = false;

  const invalidate = (): void => {
    generation += 1;
    const current = active;
    active = null;
    try {
      current?.dismiss();
    } catch (error) {
      deps.onError?.(error);
    }
  };

  return {
    request(request) {
      if (disposed || active || mutationActive) return Promise.resolve('ignored');
      const requestGeneration = ++generation;
      let handle: CloudServerDestructiveConfirmationHandle;
      try {
        handle = present(request.action, request.trigger, request.fallbackFocus);
      } catch (error) {
        deps.onError?.(error);
        return Promise.resolve('failed');
      }
      active = { generation: requestGeneration, dismiss: handle.dismiss };

      return (async (): Promise<CloudServerDestructiveActionResult> => {
        let confirmed: boolean;
        try {
          confirmed = await handle.result;
        } catch (error) {
          if (active?.generation === requestGeneration) active = null;
          deps.onError?.(error);
          return 'failed';
        }
        if (active?.generation === requestGeneration) active = null;
        if (!confirmed) return generation === requestGeneration ? 'cancelled' : 'stale';
        if (disposed || generation !== requestGeneration) return 'stale';
        let current = false;
        try {
          current = request.isCurrent();
        } catch (error) {
          deps.onError?.(error);
          return 'failed';
        }
        if (!current) {
          request.onStale?.();
          return 'stale';
        }

        mutationActive = true;
        try {
          await request.run();
          return 'completed';
        } catch (error) {
          deps.onError?.(error);
          return 'failed';
        } finally {
          mutationActive = false;
        }
      })();
    },
    invalidate,
    dispose() {
      disposed = true;
      invalidate();
    },
  };
}
