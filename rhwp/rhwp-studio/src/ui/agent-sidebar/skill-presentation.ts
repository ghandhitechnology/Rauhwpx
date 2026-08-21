export type SkillGlyph = 'skillEdit' | 'skillBot' | 'skillSystem';

/**
 * Product skill의 주된 결과를 아이콘으로 구분한다. 요약처럼 요청에 따라
 * 문서에 삽입할 수도 있는 skill은 기본 동작(채팅 결과)을 기준으로 bot이다.
 * 나머지는 설정·오케스트레이션 성격의 system gear로 표시한다. 사용자 skill도
 * 명시적 capability metadata가 아직 없으므로 이 중립적인 system 분류를 쓴다.
 */
const DOCUMENT_EDITING_SKILLS = new Set([
  'draft-document',
  'proofread-korean',
  'rewrite-tone',
]);

const INTERNAL_WORK_SKILLS = new Set([
  'skill-creator',
  'summarize-document',
]);

export function skillGlyphForName(name: string): SkillGlyph {
  if (DOCUMENT_EDITING_SKILLS.has(name)) return 'skillEdit';
  if (INTERNAL_WORK_SKILLS.has(name)) return 'skillBot';
  return 'skillSystem';
}
