// Synced-lyrics parsing and lookup.
//
// A parsed line is { time, text, end?, words?, translation? } (times in ms):
//   - text ''        → an instrumental break ("♪ • • •")
//   - words          → word-level timing [{ text, time }] (karaoke), when the source has it
//   - translation    → a second line with the same timestamp (common in bilingual LRC files)
//
// Sources:
//   - LRC: "[mm:ss.xx]line", several stamps per line, "[offset:+ms]", and "enhanced"
//     word stamps "[00:12.00]<00:12.00>Hello <00:12.40>world"
//   - LRCLIB Lyricsfile (YAML) with lines[].words[] word timings

import { parseYaml } from './yaml.js';

const LEADING_TIME = /^\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/;
const WORD_TIME_SPLIT = /(<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>)/;
const WORD_TIME = /^<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>$/;
const OFFSET_TAG = /^\[offset:\s*([+-]?\d+)\s*\]$/i;

function toMs(min, sec, frac) {
  // ".5" = 500ms, ".05" = 50ms, ".500" = 500ms
  const f = frac ? parseInt(frac.padEnd(3, '0').slice(0, 3), 10) : 0;
  return parseInt(min, 10) * 60_000 + parseInt(sec, 10) * 1000 + f;
}

/** Parse "<mm:ss.xx>word <mm:ss.xx>word" into words. Returns null if there are no word stamps. */
function parseWords(rest, lineTime) {
  if (!WORD_TIME_SPLIT.test(rest)) return null;
  const words = [];
  let current = lineTime;
  let end;
  for (const part of rest.split(WORD_TIME_SPLIT)) {
    const m = part.match(WORD_TIME);
    if (m) {
      current = toMs(m[1], m[2], m[3]);
      end = current;
    } else if (part.trim() === '') {
      // Whitespace between two stamps separates the words around it.
      if (part && words.length) words[words.length - 1].text += ' ';
    } else {
      words.push({ text: part, time: current });
      end = undefined;
    }
  }
  // Collapse whitespace but keep a single trailing space on a word as the separator.
  for (const w of words) w.text = w.text.replace(/\s+/g, ' ');
  if (words.length) {
    words[0].text = words[0].text.trimStart();
    words[words.length - 1].text = words[words.length - 1].text.trimEnd();
  }
  return { words, end };
}

/** Sort, merge same-time translations, collapse repeated breaks. Mutates nothing it doesn't own. */
function finalize(lines) {
  lines.sort((a, b) => a.time - b.time); // stable: original order kept for equal times

  const merged = [];
  for (const l of lines) {
    const prev = merged[merged.length - 1];
    if (prev && prev.time === l.time && prev.text && l.text) {
      prev.translation = prev.translation ? `${prev.translation} / ${l.text}` : l.text;
      continue;
    }
    merged.push(l);
  }
  return merged.filter((l, i) => l.text !== '' || i === 0 || merged[i - 1].text !== '');
}

/** @returns {{time:number, text:string, end?:number, words?:{text:string,time:number}[], translation?:string}[]} */
export function parseLrc(source) {
  if (!source) return [];
  let offset = 0;
  const lines = [];

  for (const raw of String(source).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    const off = line.match(OFFSET_TAG);
    if (off) {
      offset = parseInt(off[1], 10);
      continue;
    }

    const times = [];
    let rest = line;
    let m;
    while ((m = rest.match(LEADING_TIME))) {
      times.push(toMs(m[1], m[2], m[3]));
      rest = rest.slice(m[0].length);
    }
    if (!times.length) continue; // metadata like [ar:...] or junk

    const enhanced = times.length === 1 ? parseWords(rest, times[0]) : null;
    const text = (enhanced ? enhanced.words.map((w) => w.text).join('') : rest.replace(/<[^>]*>/g, ''))
      .replace(/\s+/g, ' ')
      .trim();
    for (const time of times) {
      const entry = { time, text };
      if (enhanced?.words.length) entry.words = enhanced.words;
      if (enhanced?.end !== undefined) entry.end = enhanced.end;
      lines.push(entry);
    }
  }

  // Positive [offset] means lyrics should appear sooner.
  if (offset) {
    for (const l of lines) {
      l.time = Math.max(0, l.time - offset);
      if (l.end !== undefined) l.end = Math.max(0, l.end - offset);
      if (l.words) l.words = l.words.map((w) => ({ ...w, time: Math.max(0, w.time - offset) }));
    }
  }
  return finalize(lines);
}

/** LRCLIB Lyricsfile (YAML) → lines with word timings. Throws on malformed input. */
export function parseLyricsfile(source, { minGapMs = 4000 } = {}) {
  const doc = parseYaml(source);
  if (!doc || !Array.isArray(doc.lines)) throw new SyntaxError('Lyricsfile has no lines');
  const int = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.round(Number(v)) : null);

  const lines = [];
  for (const l of doc.lines) {
    const time = int(l?.start_ms);
    if (time === null) continue;
    const words = Array.isArray(l.words)
      ? l.words
          .map((w) => ({ text: String(w?.text ?? ''), time: int(w?.start_ms) }))
          .filter((w) => w.time !== null && w.text !== '')
      : [];
    const text = (l.text != null ? String(l.text) : words.map((w) => w.text).join('')).replace(/\s+/g, ' ').trim();
    const line = { time, text };
    const end = int(l.end_ms);
    if (end !== null && end > time) line.end = end;
    if (words.length && text) line.words = words;
    lines.push(line);
  }

  const sorted = finalize(lines);
  // Lyricsfile has explicit line ends, so long silences can show the "• • •" break.
  const out = [];
  sorted.forEach((l, i) => {
    out.push(l);
    const next = sorted[i + 1];
    if (l.text && l.end !== undefined && next && next.text && next.time - l.end >= minGapMs) {
      out.push({ time: l.end, text: '' });
    }
  });
  return out;
}

/** Plain (unsynced) lyrics → lines without times. */
export function parsePlain(source) {
  if (!source) return [];
  return String(source)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .map((text) => ({ time: null, text }));
}

/** Index of the line being sung at time t (ms), or -1 before the first line. Binary search. */
export function findActiveIndex(lines, t) {
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * Lines ready for display: if singing starts late, prepend an intro break so the
 * screen shows a "♪ • • •" indicator instead of nothing.
 */
export function withIntro(lines, minIntroMs = 3000) {
  if (lines.length && lines[0].time >= minIntroMs && lines[0].text !== '') {
    return [{ time: 0, text: '' }, ...lines];
  }
  return lines;
}
