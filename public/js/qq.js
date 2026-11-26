// Backup lyrics from QQ Music, for songs LRCLIB has no timed lyrics for (mostly Chinese
// ones). QQ Music doesn't let web pages read its replies directly, so requests go through
// a small relay (relay/qq-lyrics-worker.js) whose address is set in config.js.
import { cleanTitle, sameArtist, sameTitle } from './match.js';
import { withDeadline } from './net.js';

// QQ Music's version of a song may be a second or two longer or shorter than Spotify's.
const MAX_LENGTH_DIFF_SEC = 3;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
// Backing tracks share the song's title but have no lyrics worth showing.
const BACKING = /伴奏|纯音乐|純音樂|instrumental|karaoke|off ?vocal/i;
const NO_LYRICS = /没有填词的纯音乐|暂无歌词|此歌曲为.*纯音乐/;
// Credit lines QQ Music puts at the top of its lyrics ("词：…", "Composed by：…").
const CREDIT = new RegExp(
  '^(?:' +
    [
      '作?词', '作?曲', '编曲', '制作人?', '监制', '混音', '录音', '和声', '和音', '吉他', '贝斯', '鼓', '键盘', '钢琴', '弦乐',
      '母带', '出品', '发行', '统筹', '企划', '演唱', '原唱', '翻唱', 'OP', 'SP', 'ISRC',
      'lyrics by', 'composed by', 'arranged by', 'produced by', 'written by', 'lyricist', 'composer', 'arranger', 'producer',
      'mixed by', 'mastered by', 'recorded by', 'vocals? by', 'guitar', 'bass', 'drums', 'strings',
    ].join('|') +
    ')[^:：]{0,24}[:：]',
  'i',
);
const NOTICE = /未经.{0,12}(?:许可|授权)|不得翻唱|著作权|版权所有|QQ音乐/;
const STAMPED = /^((?:\[\d+:\d+(?:[.:]\d+)?\])+)(.*)$/;

const unique = (list) => [...new Set(list.filter(Boolean))];

function fromBase64(text) {
  if (!text) return '';
  try {
    const bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return String(text); // already plain text
  }
}

const ENTITIES = { apos: "'", quot: '"', amp: '&', lt: '<', gt: '>', nbsp: ' ' };
function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&(apos|quot|amp|lt|gt|nbsp);/g, (_, name) => ENTITIES[name]);
}

/**
 * QQ Music's LRC with its "Title - Artist" opener, credit lines and notices removed.
 * Returns the timed lines only (no [ti:]/[ar:] tags), or '' when nothing is left.
 */
export function cleanQQLrc(source) {
  const out = [];
  let first = true;
  for (const raw of decodeEntities(String(source || '')).split(/\r?\n/)) {
    const m = raw.trim().match(STAMPED);
    if (!m) continue;
    const text = m[2].trim();
    const opener = first && /\s-\s/.test(text); // "Song - Artist"
    first = false;
    if (opener || CREDIT.test(text) || NOTICE.test(text) || text === '//') continue;
    out.push(`${m[1]}${text}`);
  }
  return out.some((l) => l.replace(STAMPED, '$2').trim()) ? out.join('\n') : '';
}

export function createQQLyrics({ relay, fetchFn = (...a) => globalThis.fetch(...a), timeoutMs = 8000 } = {}) {
  const base = String(relay || '').replace(/\/+$/, '');

  async function getJson(path, params) {
    const url = `${base}${path}?${new URLSearchParams(params)}`;
    return withDeadline(timeoutMs, async (signal) => {
      const res = await fetchFn(url, { signal });
      if (!res.ok) throw new Error(`Lyrics relay error ${res.status}`);
      return res.json();
    });
  }

  async function search(q) {
    const data = await getJson('/search', { q });
    const list = data?.req?.data?.body?.song?.list;
    if (!Array.isArray(list)) return [];
    return list
      .filter((s) => s?.mid)
      .map((s) => ({
        mid: s.mid,
        trackName: s.title || s.name || '',
        artistName: (s.singer || []).map((x) => x?.name).filter(Boolean).join(' / '),
        albumName: s.album?.name || '',
        duration: Number(s.interval) || 0,
      }));
  }

  /** The LRCLIB-style record for one QQ Music song, or null when it has no usable lyrics. */
  async function lyrics(song) {
    const data = await getJson('/lyric', { mid: song.mid });
    const original = fromBase64(data?.lyric);
    if (!original.trim() || NO_LYRICS.test(original)) return null;
    const timed = cleanQQLrc(original);
    if (!timed) {
      // No timestamps at all: plain text.
      const plain = decodeEntities(original).split(/\r?\n/).filter((l) => l.trim() && !/^\[[a-z]+:.*\]$/i.test(l.trim())).join('\n');
      return plain ? { plainLyrics: plain, duration: song.duration, source: 'qq' } : null;
    }
    // A translation shares the original's timestamps; the LRC parser pairs lines by time.
    const translated = cleanQQLrc(fromBase64(data?.trans));
    return { syncedLyrics: translated ? `${timed}\n${translated}` : timed, duration: song.duration, source: 'qq' };
  }

  return {
    /**
     * @param {{name:string, artists:string[], album:string, durationMs:number}} track
     * @param {{en?: {name:string, artists:string[], album:string}|null, fold?: (s:string)=>string}} [opts]
     *   en: the track's English names, when known; fold: Traditional → Simplified
     * @returns LRCLIB-style record ({ syncedLyrics | plainLyrics, duration, source }) or null
     */
    async find(track, { en = null, fold } = {}) {
      if (!base || !track?.name || !track.durationMs) return null;
      const durationSec = Math.round(track.durationMs / 1000);
      // QQ Music is written in Simplified Chinese.
      const s = (text) => (fold ? fold(String(text || '')) : String(text || ''));
      const versions = [track, en].filter((v) => v?.name);
      const titles = unique(versions.map((v) => cleanTitle(v.name) || v.name));
      const artists = unique(versions.flatMap((v) => v.artists || []));
      const albums = unique(versions.map((v) => v.album));
      const queries = unique([
        ...versions.map((v) => s(`${cleanTitle(v.name) || v.name} ${v.artists?.[0] || ''}`.trim())),
        s(titles[0]),
      ]).slice(0, 3);

      const lengthDiff = (r) => Math.abs(r.duration - durationSec);
      // The artist must match. When the two names can't be compared (Spotify shows
      // "JJ Lin", QQ Music 林俊杰), the album has to match instead.
      const artistMatches = (r) => artists.some((a) => sameArtist(r.artistName, a, fold));
      const comparable = (r) => artists.some((a) => CJK.test(a) === CJK.test(r.artistName));
      const albumMatches = (r) => albums.some((a) => sameTitle(r.albumName, a, fold));
      const acceptable = (r) =>
        r.duration &&
        lengthDiff(r) <= MAX_LENGTH_DIFF_SEC &&
        !(BACKING.test(r.trackName) && !BACKING.test(track.name)) &&
        titles.some((t) => sameTitle(r.trackName, t, fold)) &&
        (artistMatches(r) || (!comparable(r) && albumMatches(r)));

      const tried = new Set();
      for (const q of queries) {
        const matches = (await search(q)).filter(acceptable).sort((a, b) => lengthDiff(a) - lengthDiff(b));
        for (const song of matches.slice(0, 2)) {
          if (tried.has(song.mid)) continue;
          tried.add(song.mid);
          const record = await lyrics(song);
          if (record) return record;
        }
      }
      return null;
    },
  };
}
