// Timed lyrics from NetEase Cloud Music (网易云音乐), which covers Chinese songs far better
// than LRCLIB. NetEase doesn't let web pages read its replies, so this goes through a
// public relay run by a third party (GD Studio's music API, set in config.js). It may be
// slow, limited or gone one day; every failure here just means "nothing found".
import { cleanTitle, sameArtist, sameTitle } from './match.js';
import { withDeadline } from './net.js';
import { BACKING, NO_LYRICS, cleanServiceLrc, lastStampSec } from './qq.js';

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
// The search results carry no song length, so the lyrics' last timestamp stands in for it:
// it can't be past the end of Spotify's track, nor end far short of it.
const END_SLACK_SEC = 5;
const MIN_COVERAGE = 0.5;
// When the artist can't be compared and the album doesn't confirm the song, the lyrics
// have to end this close to the track's end.
const TIGHT_TAIL_SEC = 45;

// Covers and re-recordings keep the song's title and words but not its timing.
const COVER = /原唱|翻唱|cover|女声|男声|童声|钢琴|吉他|口琴|DJ|remix|live|现场|版[)）\]]/i;

const unique = (list) => [...new Set(list.filter(Boolean))];

export function createNeteaseLyrics({ api, fetchFn = (...a) => globalThis.fetch(...a), timeoutMs = 6000 } = {}) {
  async function getJson(params) {
    const url = `${api}?${new URLSearchParams(params)}`;
    return withDeadline(timeoutMs, async (signal) => {
      const res = await fetchFn(url, { signal });
      if (!res.ok) throw new Error(`NetEase relay error ${res.status}`);
      return res.json();
    });
  }

  async function search(q) {
    const list = await getJson({ types: 'search', source: 'netease', name: q, count: 8 });
    if (!Array.isArray(list)) return [];
    return list
      .filter((s) => s?.lyric_id || s?.id)
      .map((s) => ({
        id: String(s.lyric_id || s.id),
        trackName: s.name || '',
        artistName: [].concat(s.artist || []).join(' / '),
        albumName: s.album || '',
      }));
  }

  return {
    /**
     * @param {{name:string, artists:string[], album:string, durationMs:number}} track
     * @param {{en?: {name:string, artists:string[], album:string}|null, fold?: (s:string)=>string}} [opts]
     * @returns LRCLIB-style record ({ syncedLyrics, source }) or null. Timed lyrics only.
     */
    async find(track, { en = null, fold } = {}) {
      if (!api || !track?.name || !track.durationMs) return null;
      const durationSec = track.durationMs / 1000;
      const versions = [track, en].filter((v) => v?.name);
      const titles = unique(versions.map((v) => cleanTitle(v.name) || v.name));
      const artists = unique(versions.flatMap((v) => v.artists || []));
      const albums = unique(versions.map((v) => v.album));
      const queries = unique(versions.map((v) => `${cleanTitle(v.name) || v.name} ${v.artists?.[0] || ''}`.trim())).slice(0, 2);

      const artistMatches = (r) => artists.some((a) => sameArtist(r.artistName, a, fold));
      // "Can't be compared" only means Spotify shows a Latin name ("JJ Lin") for an artist
      // NetEase writes in Chinese (林俊杰). A Latin-named artist there for a Chinese-named
      // one on Spotify is simply someone else — usually a cover.
      const comparable = (r) => artists.some((a) => CJK.test(a)) || !CJK.test(r.artistName);
      const albumMatches = (r) => albums.some((a) => sameTitle(r.albumName, a, fold));
      const titleMatches = (r) =>
        titles.some((t) => sameTitle(r.trackName, t, fold)) &&
        !(BACKING.test(r.trackName) && !BACKING.test(track.name)) &&
        !(COVER.test(r.trackName) && !COVER.test(track.name));

      const tried = new Set();
      for (const q of queries) {
        const results = await search(q);
        // How sure the names make us: 2 = artist (or album, when the artist is written in
        // another language) matches; 1 = only the title does, and it is the search's top hit.
        const rated = results
          .map((r, i) => {
            if (!titleMatches(r)) return null;
            if (artistMatches(r)) return { r, sure: 2, album: albumMatches(r) };
            if (comparable(r)) return null; // a different artist
            if (albumMatches(r)) return { r, sure: 2, album: true };
            return i === 0 ? { r, sure: 1, album: false } : null;
          })
          .filter(Boolean)
          .sort((a, b) => b.sure - a.sure || Number(b.album) - Number(a.album));

        for (const { r, sure } of rated.slice(0, 3)) {
          if (tried.has(r.id)) continue;
          tried.add(r.id);
          const data = await getJson({ types: 'lyric', source: 'netease', id: r.id });
          const original = String(data?.lyric || '');
          if (!original.trim() || NO_LYRICS.test(original)) continue;
          const timed = cleanServiceLrc(original);
          const end = lastStampSec(timed);
          if (!timed || end > durationSec + END_SLACK_SEC || end < durationSec * MIN_COVERAGE) continue;
          if (sure < 2 && end < durationSec - TIGHT_TAIL_SEC) continue;
          // A translation shares the original's timestamps; the LRC parser pairs lines by time.
          const translated = cleanServiceLrc(data?.tlyric);
          // unsure: matched on the title alone, so it could be someone else's recording.
          return { syncedLyrics: translated ? `${timed}\n${translated}` : timed, source: 'netease', ...(sure < 2 ? { unsure: true } : {}) };
        }
      }
      return null;
    },
  };
}
