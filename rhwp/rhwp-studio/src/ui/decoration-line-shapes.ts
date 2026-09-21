export const DECORATION_LINE_SHAPES = [
  ['0', '━━━━ 실선'], ['1', '- - - 긴점선'], ['2', '········ 점선'],
  ['3', '━·━· 일점쇄선'], ['4', '━··━ 이점쇄선'],
  ['5', '━━━ 긴파선'], ['6', '●●●● 원형점'],
  ['7', '══ 이중선'], ['8', '━═ 가는+굵은'],
  ['9', '═━ 굵은+가는'], ['10', '≡≡ 삼중선'],
  ['11', '〰 물결선'], ['12', '〰〰 이중 물결선'],
] as const;

export function changedFiniteSelectValue(value: string, initial: number): number | undefined {
  if (value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed !== initial ? parsed : undefined;
}
