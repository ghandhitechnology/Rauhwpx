/**
 * 빌드(실행) 단계에서만 주입하는 작문 규율 블록.
 *
 * 계획 단계에서는 문서에 글이 들어가지 않으므로 주입하지 않는다 — 계획 대화까지
 * 문체 규칙으로 덮으면 토큰만 먹고 계획 품질이 떨어진다.
 *
 * 이 블록은 "모두에게 공통인 규율"이다. 개인 목소리 프로필(style.md)이 있으면
 * 그쪽이 사람 자체이므로, 여기서는 같은 리듬을 반복하지 않고 초상을 따르라고만
 * 말한다. 두 블록이 서로 다른 숫자를 주면 안 되고, 규율 목록이 초상 위에
 * 두 번째 기계 목소리를 얹으면 더더욱 안 된다.
 *
 * 패턴 목록은 dotoricode/korean-humanizer 와 DaleSeo/korean-skills 의 humanizer
 * 스킬을 참고해 정리했다. 심각도(S1/S2/S3)와 변경률 가드도 같은 출처를 따른다.
 */

/** 문서 쓰기가 가능한 단계에서만 참이다. */
export function isBuildPhase(phase) {
  return phase === 'direct' || phase === 'implementing' || phase === 'switching';
}

const KO_RHYTHM_GENERIC = `- Vary sentence length because a person would, not because a rubric said to. A short line next to a long one. A paragraph that runs, then one that stops.`;
const KO_RHYTHM_PROFILED = `- Rhythm, 종결어미 mix, and connective density belong to the portrait above. Inhabit that person. Do not write to the measured numbers, and do not substitute a generic "humanizer" cadence.`;

const EN_RHYTHM_GENERIC = `- Vary sentence length because a person would, not because a rubric said to. A five-word sentence next to a thirty-word one. A paragraph that runs, then one that stops.`;
const EN_RHYTHM_PROFILED = `- Rhythm and connective density belong to the portrait above. Inhabit that person. Do not write to the measured numbers, and do not substitute a generic "humanizer" cadence.`;

const MEANING_COVENANT = `## Meaning is invariant
Numbers, dates, units, proper nouns, direct quotations, citations, negation, and the direction of a causal claim never change for stylistic reasons — not by a single token. Style decides how a sentence is built, never what it asserts. Do not add a claim, an example, or a source that was not already there.`;

const KO_WRITE_GENERIC = `## Write like a person, not like a cleaned-up model
${KO_RHYTHM_GENERIC}
- Have a temperature. Neutral listing of facts with no stance is a tell. React to what you are saying.
- Let some mess in. Perfect parallel structure, identical paragraph shapes, and synonym cycling read as machine-made.
- Prefer a number, a date, a name, or a concrete noun over an abstraction. "예산 3,200만 원이 남았다" beats "예산 측면에서 여유가 있다".
- State the claim directly. Drop the hedge unless the uncertainty is real and load-bearing.
- Cut the connective when the logic is already obvious from order.
- Stop editing while the prose still sounds like a person typed it. Over-polish is the tell you are trying to avoid.`;

const KO_WRITE_PROFILED = `## Inhabit the portrait above
${KO_RHYTHM_PROFILED}
- The portrait is the person. Axis notes are habits that carry them. Measured numbers are a fingerprint you check after writing, never a recipe.
- If a habit in the portrait contradicts an S1/S2 item, keep the habit. Sterile avoidance of machine tics is itself a machine tic when it sands off this voice.
- Do not replace this person with generic "human" writing: punchy fragments, numbers-first, zero connectives, or a flattened anti-AI register.
- Have the opinions they would have about the sentences, without inventing facts. Leave the seams they would leave.
- After a paragraph, listen: would a stranger believe this particular human wrote it? If it merely lacks AI tells, rewrite it as them.`;

const EN_WRITE_GENERIC = `## Write like a person, not like a cleaned-up model
${EN_RHYTHM_GENERIC}
- Have a temperature. Neutral listing of facts with no stance is a tell. React to what you are saying.
- Let some mess in. Perfect parallel structure, identical paragraph shapes, and synonym cycling read as machine-made.
- Prefer a number, a date, a name, or a concrete noun over an abstraction. "3.2 million left in the budget" beats "budget headroom remains".
- State the claim directly. Drop the hedge unless the uncertainty is real and load-bearing.
- Cut the connective when order already carries the logic.
- Stop editing while the prose still sounds like a person typed it. Over-polish is the tell you are trying to avoid.`;

const EN_WRITE_PROFILED = `## Inhabit the portrait above
${EN_RHYTHM_PROFILED}
- The portrait is the person. Axis notes are habits that carry them. Measured numbers are a fingerprint you check after writing, never a recipe.
- If a habit in the portrait contradicts an S1/S2 item, keep the habit. Sterile avoidance of machine tics is itself a machine tic when it sands off this voice.
- Do not replace this person with generic "human" writing: punchy fragments, numbers-first, zero connectives, or a flattened anti-AI register.
- Have the opinions they would have about the sentences, without inventing facts. Leave the seams they would leave.
- After a paragraph, listen: would a stranger believe this particular human wrote it? If it merely lacks AI tells, rewrite it as them.`;

function koreanBlock(personalProfile) {
  const yieldLine = personalProfile
    ? `The tell lists below catch leftover machine tics. They yield to the portrait above: if this person actually writes a pattern on the list, keep it. Sanding those tics off this voice is itself a machine tic.\n\n`
    : '';
  const writeSection = personalProfile ? KO_WRITE_PROFILED : KO_WRITE_GENERIC;
  const selfCheck = personalProfile
    ? `Read your own output back and count: S1 must be 0 unless the portrait owns that tic, S2 at most 2 per ~500자 unless the portrait owns them. If a leftover machine tic remains, revise those spans and only those. Then listen: would a stranger believe this particular human wrote it, or only that it lacks AI tells? Confirm 수치·고유명사·인용·부정·인과 are intact and the 격식 matches the surrounding document. Report any 30%+ change rate to the user.`
    : `Read your own output back and count: S1 must be 0, S2 at most 2 per ~500자. If S1 > 0, revise those spans and only those. Confirm 수치·고유명사·인용·부정·인과 are intact and the 격식 matches the surrounding document. Report any 30%+ change rate to the user.`;
  return `<korean_writing_discipline>
Applies to every character you write into the document — new drafts, rewrites, expansions, summaries, table cells, headings, captions. It does not apply to your chat replies to the user.

The document is the first style authority, the user's personal voice portrait is second, these rules are third. Never let any of the three override facts, quoted text, legal wording, or genre requirements.
${yieldLine ? `\n${yieldLine}` : ''}
${MEANING_COVENANT}

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

${writeSection}

## Rewriting existing text — change budget
- Never alter numbers, dates, proper nouns, direct quotations, citations, negation, or the direction of a causal claim.
- Touch at most ~20% of sentences, at most 3 edits per paragraph, and use replace_range on the exact spans. Do not rebuild untouched paragraphs.
- Do not shrink the text below ~90% of its original length unless the user asked for compression.
- Change rate under 30%: proceed. 30-50%: proceed and say so in your summary. Over 50%: stop and ask the user before applying.

## Self-check before verify_changes
${selfCheck}
</korean_writing_discipline>`;
}

function englishBlock(personalProfile) {
  const yieldLine = personalProfile
    ? `The tell lists below catch leftover machine tics. They yield to the portrait above: if this person actually writes a pattern on the list, keep it. Sanding those tics off this voice is itself a machine tic.\n\n`
    : '';
  const writeSection = personalProfile ? EN_WRITE_PROFILED : EN_WRITE_GENERIC;
  const selfCheck = personalProfile
    ? `Read your own output back and count: S1 must be 0 unless the portrait owns that tic, S2 at most 2 per ~300 words unless the portrait owns them. If a leftover machine tic remains, revise those spans and only those. Then listen: would a stranger believe this particular human wrote it, or only that it lacks AI tells? Confirm figures, proper nouns, quotations, negation, and causality are intact, and that the register matches the surrounding document. Report any 30%+ change rate to the user.`
    : `Read your own output back and count: S1 must be 0, S2 at most 2 per ~300 words. If S1 > 0, revise those spans and only those. Confirm figures, proper nouns, quotations, negation, and causality are intact, and that the register matches the surrounding document. Report any 30%+ change rate to the user.`;
  return `<english_writing_discipline>
Applies to every character you write into the document — new drafts, rewrites, expansions, summaries, table cells, headings, captions. It does not apply to your chat replies to the user.

The document is the first style authority, the user's personal voice portrait is second, these rules are third. Never let any of the three override facts, quoted text, legal wording, or genre requirements.
${yieldLine ? `\n${yieldLine}` : ''}
${MEANING_COVENANT}

## Calibrate before you write
1. Read 2-3 paragraphs around the insertion point (and the section heading) before drafting. Match the tense, person, formality, terminology, sentence-length spread, paragraph length, and numbering scheme already in use.
2. If the document is empty or the surrounding text is boilerplate, infer the genre (report, memo, proposal, paper, essay, notice) and follow that genre's real conventions. Required formality is not an AI tell — do not flatten it to sound casual.
3. When the document already uses a phrase from the S2 list as its standing terminology, keep it.

## S1 — one occurrence is a tell. Never write these.
- Punctuation and typography: em dash as an aside, ellipsis, arrows inside prose, emoji, bold sprinkled on phrases for emphasis, scare quotes used to make a word feel significant.
- Openers: "In today's fast-paced world", "In the ever-evolving landscape of", "Let's dive in", "Have you ever wondered".
- Closers: "In conclusion", "To sum up", "The future is bright", "Only time will tell", "One thing is clear".
- Formula sentences: "It's not just X, it's Y", "From X to Y", "X is more than just Y", "This isn't merely X — it's Y".
- Structural tics: every list forced to exactly three items, every section opening with a thesis line followed by three parallel sentences, headings that all share one grammatical shape.

## S2 — one or two are fine, three or more in a page is a tell.
- LLM vocabulary: leverage, robust, seamless, comprehensive, delve, underscore, pivotal, holistic, tapestry, testament, navigate (figurative), foster, myriad.
- Hedging: "it is important to note", "can be seen as", "may potentially", "tends to suggest", "plays a crucial role in".
- Bloat: "in order to", "due to the fact that", "a wide range of", "one of the most", nominalizations where a verb would do, passive voice with no reason.
- Rhythm: every sentence within a few words of the same length, every paragraph exactly three sentences.

## S3 — weak alone, damning in combination.
Flawless punctuation with zero variation, no sentence shorter than a full clause, a connective at the head of every sentence (However, Moreover, Therefore, Additionally), and uniform paragraph length throughout.

${writeSection}

## Rewriting existing text — change budget
- Never alter numbers, dates, proper nouns, direct quotations, citations, negation, or the direction of a causal claim.
- Touch at most ~20% of sentences, at most 3 edits per paragraph, and use replace_range on the exact spans. Do not rebuild untouched paragraphs.
- Do not shrink the text below ~90% of its original length unless the user asked for compression.
- Change rate under 30%: proceed. 30-50%: proceed and say so in your summary. Over 50%: stop and ask the user before applying.

## Self-check before verify_changes
${selfCheck}
</english_writing_discipline>`;
}

/**
 * 빌드 단계에서만 블록을 돌려준다.
 * personalProfile 이 true 면 규율이 초상 위에 두 번째 목소리를 얹지 않는다.
 */
export function humanizerPromptBlock(phase, { language = 'ko', personalProfile = false } = {}) {
  if (!isBuildPhase(phase)) return '';
  return language === 'en'
    ? englishBlock(personalProfile)
    : koreanBlock(personalProfile);
}
