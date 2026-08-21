export interface FontMenuEntry {
  value: string;
  label: string;
}

/** 글꼴 메뉴 검색어로 현재 범주 항목을 좁힌다. */
export function filterFontMenuEntries(
  entries: readonly FontMenuEntry[],
  query: string,
): FontMenuEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...entries];
  return entries.filter((entry) =>
    entry.label.toLowerCase().includes(needle) || entry.value.toLowerCase().includes(needle),
  );
}

export function fontMenuEmptyMessage(query: string): string {
  return query.trim() ? '검색 결과가 없습니다.' : '표시할 글꼴이 없습니다.';
}
