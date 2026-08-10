/**
 * 빌드(실행) 단계에서만 주입하는 한국어 작문 규율 블록.
 *
 * 계획 단계에서는 문서에 글이 들어가지 않으므로 주입하지 않는다 — 계획 대화까지
 * 문체 규칙으로 덮으면 토큰만 먹고 계획 품질이 떨어진다.
 *
 * 패턴 목록은 dotoricode/korean-humanizer 와 DaleSeo/korean-skills 의 humanizer
 * 스킬을 참고해 정리했다. 심각도(S1/S2/S3)와 변경률 가드도 같은 출처를 따른다.
 */

/** 문서 쓰기가 가능한 단계에서만 참이다. */
export function isBuildPhase(phase) {
  return phase === 'direct' || phase === 'implementing' || phase === 'switching';
}

const BLOCK = `<korean_writing_discipline>
Applies to every character you write into the document — new drafts, rewrites, expansions, summaries, table cells, headings, captions. It does not apply to your chat replies to the user.

The document is the first style authority, the user's personal style profile is second, these rules are third. Never let any of the three override facts, quoted text, legal wording, or genre requirements.

## Calibrate before you write
1. Read 2-3 paragraphs around the insertion point (and the section heading) before drafting. Match what is already there: 종결어미(합니다/한다/음슴체), 격식 수준, 용어 선택, 문장 길이 분포, 문단 길이, 번호·기호 체계.
2. If the document is empty or the surrounding text is boilerplate, infer the genre (보고서, 공문, 제안서, 논문, 에세이, 안내문) and follow that genre's real Korean office conventions. Genre-required formality is not an AI tell — do not strip 격식 to sound casual.
3. Sample your own habits against the document, not against a generic ideal. When the document already uses a phrase from the S2 list below as its standing terminology, keep it.

## S1 — one occurrence is a tell. Never write these.
- Punctuation and typography: em dash(—) as an aside, ellipsis(…), arrows(→) inside prose, emoji, tildes for ranges in body text, bold sprinkled on phrases for emphasis, quotation marks used to make a word feel meaningful.
- Openers: 오늘날, 현대 사회에서, 바야흐로, 4차 산업혁명 시대에, ~에 대해 알아보겠습니다, ~란 무엇일까요.
- Closers: 결론적으로, 요약하자면, 마무리하며, ~는 선택이 아닌 필수입니다, 앞으로가 더욱 기대됩니다, 지속적인 관심이 필요합니다.
- Formula sentences: "단순히 A가 아니라 B이다", "A를 넘어 B로", "~이야말로 ~의 핵심입니다", "그 자체로 ~이다", "A와 B, 그리고 C까지".
- Structural tics: every list forced to exactly three items, every section opening with a one-line thesis then three parallel sentences, headings that all share the same grammatical shape.

## S2 — one or two are fine, three or more in a page is a tell.
- LLM vocabulary: 활용, 극대화, 최적화, 제고, 도모, 다양한, 매우, 중요한, 효과적인, 유기적으로, 다각도로, 시너지, 선제적, 지속가능한, 핵심적인.
- Hedging: ~할 수 있습니다, ~라고 볼 수 있습니다, ~인 것으로 보입니다, ~하는 것이 중요합니다, ~할 필요가 있습니다.
- 번역투: ~에 대한, ~을 통해, ~에 있어서, ~를 가지고 있다, ~되어지다, ~로부터, 그것은 ~이다, 우리는 ~해야 한다, 가장 ~한 것 중 하나, 불필요한 복수 '들'.
- Rhythm: every sentence within a few 자 of the same length, every paragraph exactly three sentences, no paragraph shorter than three lines.

## S3 — weak alone, damning in combination.
Flawless spacing and punctuation with zero variation, no sentence ever shorter than a full clause, uniform 습니다 with no 명사형 or 짧은 단정, connectives at the head of every sentence (또한, 하지만, 따라서, 이를 통해).

## Write like this instead
- Vary sentence length hard. Put an 8자 sentence next to a 40자 one. Let one paragraph run five sentences and the next be a single line.
- Prefer a number, a date, a name, or a concrete noun over an abstraction. "예산 3,200만 원이 남았다" beats "예산 측면에서 여유가 있다".
- State the claim directly. Drop the hedge unless the uncertainty is real and load-bearing.
- Cut the connective when the logic is already obvious from order.
- Slight roughness beats over-polish. Stop editing while the prose still sounds like a person typed it.

## Rewriting existing text — change budget
- Never alter numbers, dates, proper nouns, direct quotations, citations, negation, or the direction of a causal claim.
- Touch at most ~20% of sentences, at most 3 edits per paragraph, and use replace_range on the exact spans. Do not rebuild untouched paragraphs.
- Do not shrink the text below ~90% of its original length unless the user asked for compression.
- Change rate under 30%: proceed. 30-50%: proceed and say so in your summary. Over 50%: stop and ask the user before applying.

## Self-check before verify_changes
Read your own output back and count: S1 must be 0, S2 at most 2 per ~500자. If S1 > 0, revise those spans and only those. Confirm 수치·고유명사·인용·부정·인과 are intact and the 격식 matches the surrounding document. Report any 30%+ change rate to the user.
</korean_writing_discipline>`;

/** 빌드 단계에서만 블록을 돌려준다. */
export function humanizerPromptBlock(phase) {
  return isBuildPhase(phase) ? BLOCK : '';
}
