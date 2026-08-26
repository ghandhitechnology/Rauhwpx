/**
 * 개인 목소리 프로필의 정량 계층.
 *
 * 문체 캘리브레이션에서 "숫자로 셀 수 있는 것"은 전부 여기서 결정한다. LLM 은
 * 초상(어떤 사람인지, 어디서 고르지 않은지)만 맡고, 문장 길이 분포·종결어미 비율·
 * 쉼표 밀도 같은 값은 코드가 계산한다. 같은 원고를 두 번 넣으면 같은 지문이
 * 나와야 하고, 모델이 지어낸 수치가 프로필에 들어가면 안 되기 때문이다.
 *
 * 이 숫자는 작성 레시피가 아니다. 밴드는 "이 범위를 목표로 쓴다"가 아니라
 * "초고를 쓴 뒤, 목소리를 잃었는지 보는 지문"이다. 맞추려고 문장을 늘리거나
 * 자르면 기계가 된다.
 */

const KO_PAGE_CHARS = 1_800;
const EN_PAGE_WORDS = 500;

/** 기준선을 strict 로 승격하는 최소 표본. 이보다 얇으면 advisory 로 남는다. */
const STRICT_MIN_SENTENCES = 120;
const MEDIUM_MIN_SENTENCES = 40;

const KO_CONNECTIVE_OPENERS = [
  '또한', '하지만', '그러나', '그리고', '따라서', '그러므로', '이를 통해', '이에 따라',
  '즉', '결국', '그런데', '아울러', '더불어', '한편', '무엇보다', '특히',
];
const EN_CONNECTIVE_OPENERS = [
  'however', 'moreover', 'therefore', 'additionally', 'furthermore', 'thus',
  'consequently', 'in addition', 'that said', 'on the other hand', 'importantly',
];

const KO_HEDGES = [
  '할 수 있습니다', '할 수 있다', '라고 볼 수 있', '인 것으로 보', '하는 것이 중요',
  '할 필요가 있', '것으로 판단', '수도 있습니다', '것으로 기대',
];
const EN_HEDGES = [
  'can be', 'may be', 'might', 'it is important to', 'tends to', 'arguably',
  'generally speaking', 'it should be noted', 'in some cases',
];

const KO_IMPORTED_SYNTAX = [
  '에 대한', '에 대해', '을 통해', '를 통해', '에 있어', '되어지', '로부터',
  '을 가지고 있', '를 가지고 있', '것 중 하나', '에 의해',
];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const low = Math.floor(pos);
  const high = Math.ceil(pos);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (pos - low);
}

function describe(values) {
  if (values.length === 0) return { mean: 0, median: 0, p10: 0, p90: 0, sd: 0, cv: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const sd = Math.sqrt(variance);
  return {
    mean: round(mean, 1),
    median: round(quantile(sorted, 0.5), 1),
    p10: round(quantile(sorted, 0.1), 1),
    p90: round(quantile(sorted, 0.9), 1),
    sd: round(sd, 1),
    cv: mean > 0 ? round(sd / mean, 3) : 0,
  };
}

function countOccurrences(haystack, needles) {
  let total = 0;
  for (const needle of needles) {
    let index = haystack.indexOf(needle);
    while (index >= 0) {
      total += 1;
      index = haystack.indexOf(needle, index + needle.length);
    }
  }
  return total;
}

/** 문단 단위로 자른다. 빈 줄이 없는 원고도 있으므로 줄바꿈 하나도 경계로 본다. */
export function splitParagraphs(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split(/\n{1,}/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** 목록·표·코드 줄은 문장 통계에서 빼고 서식 통계로만 센다. */
function isStructuralLine(line) {
  return /^(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|[│|]|```|>\s)/.test(line);
}

export function splitSentences(paragraph, language) {
  const parts = String(paragraph || '')
    .split(/(?<=[.!?。？！…])\s+/)
    .flatMap((chunk) => (language === 'ko' ? chunk.split(/(?<=다\.)\s*/) : [chunk]))
    .map((chunk) => chunk.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : [];
}

function classifyKoreanEnding(sentence) {
  const core = sentence.replace(/[\s"'”’)\]』」.!?…~]+$/u, '');
  if (!core) return 'other';
  if (/(습니다|습니까|ㅂ니다|입니다|십시오|ㅂ시다)$/u.test(core)) return 'formal';
  if (/(어요|아요|에요|예요|네요|죠|지요|세요|요)$/u.test(core)) return 'polite';
  if (/(음|함|됨|임|짐|봄|옴|김)$/u.test(core)) return 'nominal';
  if (/(다|라|자|까|나|군|네)$/u.test(core)) return 'plain';
  if (/[가-힣]$/u.test(core)) return 'nominal';
  return 'other';
}

function ratio(part, whole) {
  return whole > 0 ? round(part / whole, 3) : 0;
}

/**
 * 원고 하나(또는 여러 편을 이어붙인 것)의 정량 프로필.
 * language 는 'ko' | 'en'.
 */
export function analyzeText(text, language = 'ko') {
  const lang = language === 'en' ? 'en' : 'ko';
  const raw = String(text || '').replace(/\r\n?/g, '\n');
  const lines = raw.split('\n');
  const paragraphs = splitParagraphs(raw).filter((line) => !isStructuralLine(line));
  const sentences = paragraphs.flatMap((paragraph) => splitSentences(paragraph, lang));
  const prose = sentences.join(' ');
  const chars = prose.replace(/\s/g, '').length;
  const words = prose.split(/\s+/).filter(Boolean).length;
  const per1k = chars > 0 ? 1000 / chars : 0;

  const sentenceLengths = sentences.map((sentence) =>
    lang === 'ko' ? sentence.replace(/\s/g, '').length : sentence.split(/\s+/).filter(Boolean).length);
  const paragraphSentences = paragraphs.map((paragraph) => splitSentences(paragraph, lang).length);

  const lower = prose.toLowerCase();
  const openers = lang === 'ko' ? KO_CONNECTIVE_OPENERS : EN_CONNECTIVE_OPENERS;
  const connectiveOpens = sentences.filter((sentence) => {
    const head = (lang === 'ko' ? sentence : sentence.toLowerCase()).trimStart();
    return openers.some((opener) => head.startsWith(opener));
  }).length;

  const hedges = countOccurrences(lang === 'ko' ? prose : lower, lang === 'ko' ? KO_HEDGES : EN_HEDGES);
  const imported = lang === 'ko'
    ? countOccurrences(prose, KO_IMPORTED_SYNTAX)
    : (lower.match(/\b(?:is|are|was|were|been|be|being)\s+\w+(?:ed|en)\b/g) || []).length;

  const endings = { formal: 0, polite: 0, plain: 0, nominal: 0, other: 0 };
  if (lang === 'ko') {
    for (const sentence of sentences) endings[classifyKoreanEnding(sentence)] += 1;
  }

  const tokens = (lang === 'ko' ? prose.match(/[가-힣]{2,}/g) : lower.match(/[a-z']{3,}/g)) || [];
  const typeTokenRatio = tokens.length > 0 ? round(new Set(tokens).size / tokens.length, 3) : 0;

  const digits = (prose.match(/\d/g) || []).length;

  const metrics = {
    language: lang,
    chars,
    words,
    sentences: sentences.length,
    paragraphs: paragraphs.length,
    pageEquivalent: lang === 'ko'
      ? round(chars / KO_PAGE_CHARS, 1)
      : round(words / EN_PAGE_WORDS, 1),
    sentenceLength: describe(sentenceLengths),
    paragraphSentences: describe(paragraphSentences),
    endingMix: lang === 'ko'
      ? {
        formal: ratio(endings.formal, sentences.length),
        polite: ratio(endings.polite, sentences.length),
        plain: ratio(endings.plain, sentences.length),
        nominal: ratio(endings.nominal, sentences.length),
        other: ratio(endings.other, sentences.length),
      }
      : null,
    connectiveOpenRate: ratio(connectiveOpens, sentences.length),
    hedgesPer1kChars: round(hedges * per1k, 2),
    importedSyntaxPer1kChars: round(imported * per1k, 2),
    commasPerSentence: sentences.length > 0
      ? round((prose.match(/,/g) || []).length / sentences.length, 2)
      : 0,
    digitsPer1kChars: round(digits * per1k, 2),
    typeTokenRatio,
    punctuation: {
      emDashPer1kChars: round((prose.match(/—/g) || []).length * per1k, 2),
      ellipsisPer1kChars: round((prose.match(/…|\.\.\./g) || []).length * per1k, 2),
      parenthesesPer1kChars: round((prose.match(/\(/g) || []).length * per1k, 2),
      questionRate: ratio(sentences.filter((s) => /[?？]$/.test(s.trim())).length, sentences.length),
      exclamationRate: ratio(sentences.filter((s) => /[!！]$/.test(s.trim())).length, sentences.length),
    },
    formatting: {
      headingRate: ratio(lines.filter((line) => /^#{1,6}\s/.test(line.trim())).length, lines.length),
      listRate: ratio(lines.filter((line) => /^(?:[-*+]\s|\d+[.)]\s)/.test(line.trim())).length, lines.length),
      boldPer1kChars: round((raw.match(/\*\*[^*]+\*\*/g) || []).length * per1k, 2),
    },
  };
  return metrics;
}

/** 원고를 문단 단위로 번갈아 두 벌로 나눈다. 주제 이동이 반쪽에만 몰리지 않게 한다. */
export function splitHalves(text) {
  const paragraphs = splitParagraphs(text);
  const a = paragraphs.filter((_, index) => index % 2 === 0).join('\n\n');
  const b = paragraphs.filter((_, index) => index % 2 === 1).join('\n\n');
  return [a, b];
}

const STABILITY_KEYS = [
  (m) => m.sentenceLength.median,
  (m) => m.sentenceLength.cv * 100,
  (m) => m.paragraphSentences.mean,
  (m) => m.connectiveOpenRate * 100,
  (m) => m.commasPerSentence * 10,
  (m) => (m.endingMix ? m.endingMix.formal * 100 : m.typeTokenRatio * 100),
];

/**
 * 반쪽 두 벌에서 같은 값이 나오는지 본다.
 * 표본이 얇을수록 한쪽 반쪽의 습관을 전체 습관으로 착각하기 쉬우므로,
 * 여기서 흔들리는 원고는 밴드를 넓히고 규칙을 advisory 로 내린다.
 */
export function splitHalfStability(text, language = 'ko') {
  const [a, b] = splitHalves(text);
  const left = analyzeText(a, language);
  const right = analyzeText(b, language);
  if (left.sentences < 8 || right.sentences < 8) return 0.4;
  let total = 0;
  let counted = 0;
  for (const key of STABILITY_KEYS) {
    const x = key(left);
    const y = key(right);
    const scale = Math.max(Math.abs(x), Math.abs(y), 1);
    total += Math.abs(x - y) / scale;
    counted += 1;
  }
  return round(clamp(1 - total / Math.max(counted, 1), 0, 1), 3);
}

/** 표본 크기 + 반쪽 일치도 → 신뢰도. strict 는 둘 다 통과해야 한다. */
export function confidenceFor(metrics, stability) {
  if (metrics.sentences >= STRICT_MIN_SENTENCES && stability >= 0.8) return 'high';
  if (metrics.sentences >= MEDIUM_MIN_SENTENCES && stability >= 0.6) return 'medium';
  return 'low';
}

const WIDEN = { high: 1, medium: 1.15, low: 1.35 };

/**
 * 기준선(밴드). 신뢰도가 낮으면 중앙값 기준으로 넓혀서, 얇은 표본의 우연한
 * 분포를 규칙처럼 강요하지 않는다.
 */
export function deriveBands(metrics, confidence = 'medium') {
  const factor = WIDEN[confidence] ?? WIDEN.medium;
  const widen = (low, high, median) => [
    Math.max(1, Math.round(median - (median - low) * factor)),
    Math.round(median + (high - median) * factor),
  ];
  const [sentenceLow, sentenceHigh] = widen(
    metrics.sentenceLength.p10, metrics.sentenceLength.p90, metrics.sentenceLength.median,
  );
  const [paraLow, paraHigh] = widen(
    Math.max(1, metrics.paragraphSentences.p10), metrics.paragraphSentences.p90,
    Math.max(1, metrics.paragraphSentences.median),
  );
  const dominantEnding = metrics.endingMix
    ? Object.entries(metrics.endingMix).sort((a, b) => b[1] - a[1])[0]
    : null;
  return {
    unit: metrics.language === 'ko' ? '자' : 'words',
    sentenceLength: { low: sentenceLow, median: Math.round(metrics.sentenceLength.median), high: sentenceHigh },
    // 저자가 실제로 가진 편차를 지문으로 남긴다. 더 흔들라고 요구하면
    // 초상이 아니라 일반론이 된다 — 남은 기계 티는 규율 블록이 잡는다.
    sentenceVariation: { targetCv: round(Math.max(0.15, metrics.sentenceLength.cv), 2), observedCv: metrics.sentenceLength.cv },
    paragraphSentences: { low: paraLow, median: Math.round(metrics.paragraphSentences.median), high: paraHigh },
    dominantEnding: dominantEnding ? { kind: dominantEnding[0], share: dominantEnding[1] } : null,
    endingMix: metrics.endingMix,
    connectiveOpenRate: { max: round(Math.max(0.05, metrics.connectiveOpenRate * 1.25), 3), observed: metrics.connectiveOpenRate },
    commasPerSentence: { target: metrics.commasPerSentence },
    hedgesPer1kChars: { max: round(Math.max(0.4, metrics.hedgesPer1kChars * 1.25), 2), observed: metrics.hedgesPer1kChars },
    digitsPer1kChars: { observed: metrics.digitsPer1kChars },
    formatting: metrics.formatting,
  };
}

const ENDING_LABEL_KO = {
  formal: '합니다체', polite: '해요체', plain: '한다체', nominal: '명사형·음슴체', other: '기타',
};

/**
 * 작성 시점에 그대로 읽히는 짧은 지문 문장들.
 * "이 값을 목표로 써라"가 아니라 "쓴 뒤에 이 폭을 통째로 비웠으면 목소리를 잃었다"로 읽히게 쓴다.
 */
export function baselineLines(bands, language = 'ko') {
  if (!bands) return [];
  const lines = [];
  const unit = bands.unit;
  lines.push(language === 'ko'
    ? `문장 길이 지문: 중앙값 ${bands.sentenceLength.median}${unit}, 대부분 ${bands.sentenceLength.low}–${bands.sentenceLength.high}${unit}. 초고를 쓴 뒤 문장이 이 폭을 통째로 비우면 목소리를 잃은 것이다. 맞추려고 글자를 보태거나 빼지 않는다.`
    : `Sentence-length fingerprint: median ${bands.sentenceLength.median} ${unit}, most fall in ${bands.sentenceLength.low}–${bands.sentenceLength.high}. After drafting, if your sentences abandoned that spread, you left the voice. Do not pad or trim to hit it.`);
  lines.push(language === 'ko'
    ? `길이 편차 지문: 원고의 변동계수는 ${bands.sentenceVariation.targetCv} 다. 같은 폭으로 길고 짧은 문장이 섞여 있는지만 본다.`
    : `Length-variance fingerprint: the samples run at a coefficient of variation of ${bands.sentenceVariation.targetCv}. Check that long and short still mix at that spread; do not manufacture variation.`);
  lines.push(language === 'ko'
    ? `문단 지문: 문장 ${bands.paragraphSentences.low}–${bands.paragraphSentences.high}개, 중앙값 ${bands.paragraphSentences.median}개.`
    : `Paragraph fingerprint: ${bands.paragraphSentences.low}–${bands.paragraphSentences.high} sentences, median ${bands.paragraphSentences.median}.`);
  if (bands.dominantEnding) {
    const label = ENDING_LABEL_KO[bands.dominantEnding.kind] ?? bands.dominantEnding.kind;
    lines.push(`종결어미 지문: ${label} ${Math.round(bands.dominantEnding.share * 100)}% 가 기본이다. 나머지 비율만큼만 다른 어미가 섞인다.`);
  }
  lines.push(language === 'ko'
    ? `접속어로 문장을 여는 비율: 원고는 ${Math.round(bands.connectiveOpenRate.max * 100)}% 이하. 이 사람보다 접속어를 자주 쓰기 시작하면 기계다.`
    : `Sentences opening with a connective: the samples stay at most ${Math.round(bands.connectiveOpenRate.max * 100)}%. Opening more often than that is the machine, not them.`);
  lines.push(language === 'ko'
    ? `쉼표 지문: 문장당 ${bands.commasPerSentence.target}개 안팎.`
    : `Comma fingerprint: about ${bands.commasPerSentence.target} per sentence.`);
  lines.push(language === 'ko'
    ? `완충 표현(~할 수 있습니다 류): 1,000자당 ${bands.hedgesPer1kChars.max}회 이하. 이 사람이 실제로 머뭇거린 곳에만 남긴다.`
    : `Hedges: at most ${bands.hedgesPer1kChars.max} per 1,000 characters, and only where this person would actually hesitate.`);
  if (bands.digitsPer1kChars.observed > 0) {
    lines.push(language === 'ko'
      ? `수치 밀도 지문: 1,000자당 숫자 ${bands.digitsPer1kChars.observed}자. 이 사람이 숫자로 말하는 자리에서 추상어로 바꾸지 않는다.`
      : `Concreteness fingerprint: ${bands.digitsPer1kChars.observed} digit characters per 1,000. Where they reach for a number, do not swap in an abstraction.`);
  }
  return lines;
}
