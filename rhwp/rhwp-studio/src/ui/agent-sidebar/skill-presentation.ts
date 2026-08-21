export type SkillGlyph = 'skillEdit' | 'skillBot';

/**
 * Product skill의 주된 결과를 아이콘으로 구분한다. 요약처럼 요청에 따라
 * 문서에 삽입할 수도 있는 skill은 기본 동작(채팅 결과)을 기준으로 bot이다.
 * 사용자 skill은 명시적 capability metadata가 아직 없으므로 안전하게 bot으로
 * 표시하고, 새 bundled editing skill을 추가할 때 이 목록도 함께 갱신한다.
 */
const DOCUMENT_EDITING_SKILLS = new Set([
  'draft-document',
  'proofread-korean',
  'rewrite-tone',
]);

export function skillGlyphForName(name: string): SkillGlyph {
  return DOCUMENT_EDITING_SKILLS.has(name) ? 'skillEdit' : 'skillBot';
}
