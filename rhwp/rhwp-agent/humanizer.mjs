/** 문서 작성 단계에만 적용하는 의미·목소리 중심의 작문 안내. */
export function isBuildPhase(phase) {
  return phase === 'direct' || phase === 'implementing' || phase === 'switching';
}

const MEANING = `## Preserve meaning
Preserve facts, figures, dates, units, proper nouns, quotations, citations, negation, uncertainty, and causality. Style decides how a sentence is built, never what it asserts. When rewriting, do not invent examples, sources, opinions, or experiences to make the prose feel personal. When drafting, use the supplied or verified material and distinguish uncertainty honestly.`;

const VOICE = {
  ko: `## 한국어의 흐름
- 독자에게 무엇을 전하려는지 먼저 정하고, 그 생각이 자연스럽게 이어지도록 쓴다. 문장과 문단의 길이는 내용에 따라 정한다.
- 문서의 격식과 종결어미를 일관되게 유지한다. 자연스럽게 보이려고 존댓말과 반말을 섞거나, 일부러 문장을 끊거나, 맞춤법을 틀리지 않는다.
- 주체와 행동을 분명하게 쓴다. 번역투나 추상적인 명사 연결 때문에 뜻이 흐려진 곳만 풀어 쓴다. 익숙한 전문 용어를 억지로 쉬운 말로 바꾸지 않는다.
- 연결어는 관계를 이해하는 데 도움이 될 때 쓴다. 같은 말을 다시 써야 뜻이 명확하다면 그대로 쓴다.
- '결론적으로', '중요합니다', '활용' 같은 표현도 문맥으로 판단한다. 빈말이나 반복이면 덜어내되, 금지어 목록처럼 기계적으로 지우지 않는다.
- 감정, 유머, 단정적인 태도는 원고와 상황이 뒷받침할 때만 쓴다. 차분하고 격식 있는 글도 자연스러운 글이다.`,
  en: `## English flow
- Start with what the reader needs to understand. Let each sentence develop the thought and let paragraph breaks follow changes in that thought.
- Choose familiar, precise wording and verbs that make the action clear. Keep established terminology and necessary nuance.
- Let sentence length follow meaning and emphasis. Do not alternate short and long sentences on purpose, force fragments, or pad a paragraph to vary its shape.
- Use transitions when the relationship needs explaining. Repetition can keep a subject clear; do not cycle through synonyms just to avoid it.
- Judge phrases such as "In conclusion", "comprehensive", or "it is important" in context. Revise empty framing and vague praise when they add nothing; no word or punctuation mark is an automatic failure.
- Match the writer's register and regional spelling. Use warmth, humour, contractions, or a strong stance only where the author, reader, and purpose call for them. Do not add errors or fake personal anecdotes.`,
};

export function humanizerPromptBlock(phase, { language = 'ko', personalProfile = false } = {}) {
  if (!isBuildPhase(phase)) return '';
  const lang = language === 'en' ? 'en' : 'ko';
  const tag = lang === 'en' ? 'english_writing_discipline' : 'korean_writing_discipline';
  const voice = personalProfile
    ? `Follow the supplied personal voice portrait as a set of observed tendencies. Preserve the writer's way of explaining, qualifying, and addressing a reader. Use the habits that fit this passage; do not perform every habit in every paragraph. Ignore numeric style targets in older profiles, including sentence-length bands, ending ratios, and connective counts. A different rhythm can still be the same voice when the subject calls for it.`
    : `Take your cues from the surrounding document, its reader, and its purpose. Aim for clear, natural prose in the appropriate register. There is no universal "human" cadence to imitate.`;
  return `<${tag}>
Applies to document drafts, rewrites, summaries, headings, captions, and table cells. It does not apply to your chat replies to the user.

Follow the user's requested scope and style, required genre conventions, and the surrounding document. Personal voice guidance helps within those boundaries and never overrides factual accuracy or protected wording.

${MEANING}

## Read, then write
Read the surrounding passage and heading before editing. Understand its point, terminology, register, and relationship to the next passage. In a new document, use the audience and purpose the user supplied.

${voice}

${VOICE[lang]}

## Revise for the reader
Draft for meaning and continuity, then read the passage as a whole. Fix the places where the thought stalls, the wording obscures the point, or the tone changes without a reason. Keep passages that already work.

Use targeted replace_range edits for local corrections. Restructure a passage when the requested rewrite needs it, preserving its substance and useful detail. The user's scope determines how much to change; do not impose edit percentages, minimum retained length, phrase quotas, or sentence-count targets. Honour an explicit length limit when the user gives one.

## Final read before verify_changes
Does the passage say what it needs to say, in a voice appropriate to this writer and reader? Does each sentence connect clearly to what comes before it? Check facts, uncertainty, quotations, and register against the source. Correct specific problems and stop when the prose reads naturally. Do not score it for AI tells or report a change-rate tally.
</${tag}>`;
}
