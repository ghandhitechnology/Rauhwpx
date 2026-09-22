// 문서는 canvas 모델에 저장되므로 Chromium의 숨은 입력 undo 스택을 사용하지 않는다.
export function documentEditMenuItem(command, label, accelerator) {
  return {
    label,
    ...(accelerator ? { accelerator } : {}),
    click: (_item, window) => {
      if (!window || window.isDestroyed?.()) return;
      const contents = window.webContents;
      if (!contents || contents.isDestroyed?.()) return;
      contents.send('desktop:edit-command', command);
    },
  };
}
