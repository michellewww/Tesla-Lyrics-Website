// Per-character ("karaoke") timing for a lyric line.
//
// When the source has word timings (LRCLIB Lyricsfile, enhanced LRC) those are used
// as-is. Otherwise the line's duration is spread over its characters — CJK characters
// each get their own segment, Latin words are kept whole — so the highlight still
// sweeps through the line instead of lighting it all at once.

const CJK = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}';
const TOKEN_RE = new RegExp(`[${CJK}][\\p{P}\\p{S}\\s]*|[^\\s${CJK}]+\\s*|\\s+`, 'gu');
const CJK_CHAR = new RegExp(`[${CJK}]`, 'u');
const CJK_GLOBAL = new RegExp(`[${CJK}]`, 'gu');

export function hasCjk(text) {
  return CJK_CHAR.test(text || '');
}

/** Split text into highlightable tokens: one per CJK character, one per Latin word (with its trailing space). */
export function tokenize(text) {
  return String(text || '').match(TOKEN_RE) || [];
}

/** Rough "how long does this take to sing" weight. */
function weight(token) {
  const cjk = (token.match(CJK_GLOBAL) || []).length;
  const other = token.replace(CJK_GLOBAL, '').replace(/[\s\p{P}\p{S}]/gu, '').length;
  if (!cjk && !other) return 0;
  return cjk + Math.max(0.6, other * 0.3);
}

/**
 * @param {{time:number, text:string, end?:number, words?:{text:string,time:number}[]}} line
 * @param {number|undefined} nextTime start of the following line
 * @returns {{text:string, start:number, end:number}[]}
 */
export function lineSegments(line, nextTime) {
  const span = Math.max(300, (nextTime ?? line.time + 6000) - line.time);

  if (line.words?.length) {
    const words = line.words;
    const lastEnd = line.end ?? line.time + span;
    return words.flatMap((w, i) => {
      const start = w.time;
      let end = words[i + 1]?.time ?? lastEnd;
      // A final word with no explicit end: don't stretch it over a long pause.
      if (i === words.length - 1 && line.end === undefined) end = Math.min(end, start + 1500);
      // Some sources time a whole phrase as one "word" (common for Chinese); split it
      // into characters so the highlight still moves character by character.
      return spread(tokenize(w.text), start, Math.max(start + 1, end));
    });
  }

  const tokens = tokenize(line.text);
  const total = tokens.reduce((a, t) => a + weight(t), 0);
  // Singers usually finish a line before the next one starts; estimate ~420ms per
  // weighted syllable, but never past the next line.
  const duration = line.end !== undefined ? line.end - line.time : Math.min(span * 0.92, Math.max(900, total * 420));
  return spread(tokens, line.time, line.time + duration);
}

/** Divide [start, end] among tokens in proportion to their weight. */
function spread(tokens, start, end) {
  const weights = tokens.map(weight);
  const total = weights.reduce((a, b) => a + b, 0);
  if (!total) return tokens.map((text) => ({ text, start, end: start + 1 }));
  let acc = start;
  return tokens.map((text, i) => {
    const s = acc;
    acc += ((end - start) * weights[i]) / total;
    return { text, start: s, end: Math.max(s + 1, acc) };
  });
}

/** Fill fraction (0–1) of a segment at time t. */
export function segmentProgress(seg, t) {
  if (t <= seg.start) return 0;
  if (t >= seg.end) return 1;
  return (t - seg.start) / (seg.end - seg.start);
}

/** Guess a BCP-47 tag for lyric text so the browser picks the right CJK glyphs and line breaking. */
export function guessLang(texts) {
  const sample = texts.join('');
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(sample)) return 'ja';
  if (/\p{Script=Hangul}/u.test(sample)) return 'ko';
  if (/\p{Script=Han}/u.test(sample)) return 'zh-CN';
  return '';
}
