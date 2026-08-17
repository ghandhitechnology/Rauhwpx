/** Prefix and substring matches win; otherwise match ordered characters with a gap penalty. */
export function fuzzyTemplateScore(name: string, rawQuery: string): number | null {
  const value = name.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
  const query = rawQuery.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
  if (!query) return 10_000 - value.length;
  if (value.startsWith(query)) return 30_000 - value.length;
  const substring = value.indexOf(query);
  if (substring >= 0) return 20_000 - substring * 10 - value.length;
  let cursor = 0;
  let gap = 0;
  for (const char of query) {
    const found = value.indexOf(char, cursor);
    if (found < 0) return null;
    gap += found - cursor;
    cursor = found + 1;
  }
  return 10_000 - gap * 10 - value.length;
}
