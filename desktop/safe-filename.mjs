const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\.|$)/i;

/** Produce a portable dialog suggestion. The path picked by the user remains
 * authoritative; this only prevents an unsafe renderer suggestion from
 * becoming a reserved or malformed default filename. */
export function safeSuggestedFilename(value, fallback = 'document') {
  const clean = (input) => String(input ?? '').split(/[\\/]/).at(-1)
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
    .replace(/[ .]+$/g, '')
    .trim();
  const normalizedFallback = clean(fallback) || 'document';
  let name = String(value ?? '').split(/[\\/]/).at(-1) ?? '';
  name = clean(name);
  if (!name || name === '.' || name === '..') name = normalizedFallback;
  if (WINDOWS_DEVICE_NAME.test(name)) name = `_${name}`;

  const characters = [...name];
  if (characters.length <= 180) return name;
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
  const stemLimit = Math.max(1, 180 - [...extension].length);
  return `${characters.slice(0, stemLimit).join('').replace(/[ .]+$/g, '') || 'document'}${extension}`;
}
