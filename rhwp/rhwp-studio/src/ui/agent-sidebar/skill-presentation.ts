import type { ProductSkillIcon } from '../../agent/types.ts';

export type SkillGlyph = ProductSkillIcon;

export const PRODUCT_SKILL_ICONS: readonly { value: ProductSkillIcon; label: string }[] = [
  { value: 'pencil', label: '작성' },
  { value: 'bot', label: '자동화' },
  { value: 'system', label: '설정' },
  { value: 'sparkles', label: '아이디어' },
  { value: 'book', label: '문서' },
  { value: 'target', label: '목표' },
  { value: 'chart', label: '분석' },
  { value: 'lightbulb', label: '힌트' },
  { value: 'calendar', label: '일정' },
  { value: 'code', label: '코드' },
  { value: 'check', label: '완료' },
  { value: 'heart', label: '즐겨찾기' },
  { value: 'bolt', label: '빠른 작업' },
  { value: 'shield', label: '검토' },
];

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
  return skillGlyphForIcon(defaultSkillIconForName(name));
}

export function defaultSkillIconForName(name: string): ProductSkillIcon {
  if (DOCUMENT_EDITING_SKILLS.has(name)) return 'pencil';
  if (INTERNAL_WORK_SKILLS.has(name)) return 'bot';
  return 'system';
}

export function skillGlyphForIcon(icon: ProductSkillIcon): SkillGlyph {
  return icon;
}

export function skillGlyphForSkill(skill: { name: string; icon?: ProductSkillIcon | null }): SkillGlyph {
  return skillGlyphForIcon(skill.icon ?? defaultSkillIconForName(skill.name));
}

/** Wire 요청만 비어 있지 않게 만들고, 대화 기록용 후속 문장은 그대로 둔다. */
export function requestTextForSkillInvocation(text: string, skillName?: string): string {
  return !text && skillName ? `/${skillName}` : text;
}
