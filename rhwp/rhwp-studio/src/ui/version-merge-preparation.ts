import './version-merge-preparation.css';

export type MergePreparation =
  | { kind: 'cancel' | 'stash' | 'commit' }
  | { kind: 'branch'; name: string };

/** Native modal keeps keyboard focus and document input inside this decision. */
export function prepareUncommittedMerge(currentBranch: string): Promise<MergePreparation> {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'version-merge-preparation';
    dialog.setAttribute('aria-labelledby', 'version-merge-preparation-title');
    const form = document.createElement('form');
    form.innerHTML = `
      <h2 id="version-merge-preparation-title">병합 전 내 변경 보관</h2>
      <p>아직 커밋하지 않은 변경이 있습니다. 보관 방법을 선택하세요.</p>
      <label><input type="radio" name="choice" value="stash" checked>
        <span>잠시 보관 (stash)<small>현재 브랜치를 병합한 뒤 보관한 변경을 다시 적용할 수 있습니다.</small></span></label>
      <label><input type="radio" name="choice" value="commit">
        <span>현재 브랜치에 커밋<small class="version-merge-current-branch"></small></span></label>
      <label><input type="radio" name="choice" value="branch">
        <span>새 브랜치에 커밋<small>내 변경을 별도 브랜치에 남기고 현재 브랜치에 병합합니다.</small></span></label>
      <input class="version-merge-branch-name" aria-label="새 브랜치 이름" placeholder="브랜치 이름" maxlength="64" hidden>
      <footer><button type="button" data-choice="cancel">취소</button><button type="submit">계속</button></footer>`;
    form.querySelector('.version-merge-current-branch')!.textContent = `${currentBranch}에 커밋하고 충돌을 검토합니다.`;
    const branchInput = form.querySelector<HTMLInputElement>('.version-merge-branch-name')!;
    const choice = () => form.querySelector<HTMLInputElement>('input[name="choice"]:checked')!.value;
    form.addEventListener('change', () => {
      branchInput.hidden = choice() !== 'branch';
      branchInput.required = !branchInput.hidden;
      if (!branchInput.hidden) branchInput.focus();
    });
    let settled = false;
    const finish = (result: MergePreparation) => {
      if (settled) return;
      settled = true;
      dialog.close();
      dialog.remove();
      resolve(result);
    };
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const kind = choice();
      if (kind === 'branch') {
        if (!branchInput.value.trim()) return branchInput.focus();
        finish({ kind, name: branchInput.value.trim() });
      } else if (kind === 'stash' || kind === 'commit') finish({ kind });
    });
    form.querySelector('[data-choice="cancel"]')!.addEventListener('click', () => finish({ kind: 'cancel' }));
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish({ kind: 'cancel' }); });
    dialog.addEventListener('close', () => finish({ kind: 'cancel' }));
    dialog.append(form);
    document.body.append(dialog);
    dialog.showModal();
  });
}
