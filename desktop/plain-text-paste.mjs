export function deliverPlainTextPaste(window, readText) {
  if (!window || window.isDestroyed?.() === true) return false;
  const webContents = window.webContents;
  if (!webContents || webContents.isDestroyed?.() === true) return false;
  const text = readText();
  if (typeof text !== 'string' || text.length === 0) return false;
  webContents.send('desktop:paste-plain-text', text);
  return true;
}
