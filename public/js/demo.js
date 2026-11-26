// Demo mode (?demo): a fake Spotify player and lyrics source so the UI can be tried
// and tested without a Spotify account. The songs and lyrics are original placeholders.
import { toResult } from './lyrics.js';

// Build "enhanced LRC" (word timestamps) so the demo shows exact word-by-word sync.
function fmt(ms) {
  const m = Math.floor(ms / 60000);
  const s = ((ms % 60000) / 1000).toFixed(2).padStart(5, '0');
  return `${String(m).padStart(2, '0')}:${s}`;
}

function enhancedLrc(spec) {
  return spec
    .map(([start, text, dur]) => {
      if (!text) return `[${fmt(start)}]`;
      const words = text.split(' ');
      const weights = words.map((w) => w.length + 2);
      const total = weights.reduce((a, b) => a + b, 0);
      let t = start;
      const body = words
        .map((w, i) => {
          const tag = `<${fmt(Math.round(t))}>${w}${i < words.length - 1 ? ' ' : ''}`;
          t += (dur * weights[i]) / total;
          return tag;
        })
        .join('');
      return `[${fmt(start)}]${body}<${fmt(start + dur)}>`;
    })
    .join('\n');
}

const DEMO_TRACKS = [
  {
    id: 'demo-1',
    name: 'Autopilot Afternoon',
    artists: ['The Placeholders'],
    album: 'Demo Drive',
    durationMs: 72_000,
    image: 'assets/demo-1.svg',
    record: {
      syncedLyrics: enhancedLrc([
        [4000, 'Windows down on an empty road', 3200],
        [8000, 'Battery full and the sky turned gold', 3400],
        [12000, 'Humming along to a borrowed tune', 3200],
        [16000, 'Chasing the shade of a late-noon moon', 3600],
        [20500, ''],
        [25000, 'Oh, the miles roll by like a slow parade', 3500],
        [29000, 'Every sign is a song we made', 3200],
        [33000, 'Hands on the wheel and my heart in line', 3500],
        [37000, 'Singing the words one beat behind', 3300],
        [41000, ''],
        [47000, 'Charge it up at the edge of town', 3200],
        [51000, 'Coffee is warm as the sun goes down', 3400],
        [55000, 'Every word on the glowing screen', 3300],
        [59000, 'Lights the way like a mile-marker dream', 4200],
        [64000, 'Lights the way like a mile-marker dream', 4400],
        [69000, ''],
      ]),
    },
  },
  {
    id: 'demo-2',
    name: '城市夜行',
    artists: ['占位乐队'],
    album: '演示专辑',
    durationMs: 40_000,
    image: 'assets/demo-2.svg',
    record: {
      // Chinese, line-synced only (character timing is estimated), with English
      // translation lines sharing each timestamp — the common bilingual LRC layout.
      syncedLyrics: [
        '[00:03.00]夜色铺满了高速公路',
        '[00:03.00]Night spreads across the highway',
        '[00:07.50]车灯像星星一样流动',
        '[00:07.50]Headlights drift like moving stars',
        '[00:12.00]电量还够我们走很远',
        '[00:12.00]There is charge enough to take us far',
        '[00:16.50]把心事都交给晚风',
        '[00:16.50]Hand every worry to the evening wind',
        '[00:21.00]',
        '[00:24.00]唱吧 唱到下一个路口',
        '[00:24.00]Sing, sing until the next crossing',
        '[00:28.50]每一个字都在屏幕上发光',
        '[00:28.50]Every word is glowing on the screen',
        '[00:34.00]',
      ].join('\n'),
    },
  },
  {
    id: 'demo-3',
    name: 'Supercharger Serenade',
    artists: ['The Placeholders'],
    album: 'Demo Drive',
    durationMs: 30_000,
    image: 'assets/demo-3.svg',
    record: {
      // Only unsynced lyrics are known for this one, to show the plain-lyrics view.
      plainLyrics: [
        'Plug me in and let me rest',
        'Twenty minutes, then I am at my best',
        '',
        'Neon hums a lullaby',
        'Stalls lined up beneath the sky',
      ].join('\n'),
    },
  },
  {
    id: 'demo-4',
    name: 'Regen Braking',
    artists: ['The Placeholders'],
    album: 'Demo Drive',
    durationMs: 20_000,
    image: 'assets/demo-4.svg',
    record: { instrumental: true },
  },
  {
    id: 'demo-5',
    name: 'Unreleased Rough Cut',
    artists: ['The Placeholders'],
    album: 'Demo Drive',
    durationMs: 20_000,
    image: 'assets/demo-1.svg',
    record: null, // no lyrics anywhere, to show the empty state
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function meta(t) {
  const { record, ...rest } = t;
  return { ...rest, imageSmall: t.image, imageMedium: t.image };
}

export function createDemo({ now = () => performance.now(), latencyMs = 40 } = {}) {
  let index = 0;
  let baseMs = 0;
  let baseAt = now();
  let playing = true;

  const pos = () => baseMs + (playing ? now() - baseAt : 0);
  const reset = (ms = 0) => {
    baseMs = ms;
    baseAt = now();
  };

  function advanceIfEnded() {
    while (pos() >= DEMO_TRACKS[index].durationMs) {
      const over = pos() - DEMO_TRACKS[index].durationMs;
      index = (index + 1) % DEMO_TRACKS.length;
      reset(over);
    }
  }

  const player = {
    async nowPlaying() {
      await sleep(latencyMs);
      advanceIfEnded();
      return {
        active: true,
        isPlaying: playing,
        type: 'track',
        track: meta(DEMO_TRACKS[index]),
        progressMs: Math.round(pos()),
        sampledAt: now(),
      };
    },
    async play() {
      if (!playing) {
        reset(pos());
        playing = true;
      }
    },
    async pause() {
      reset(pos());
      playing = false;
    },
    async next() {
      index = (index + 1) % DEMO_TRACKS.length;
      reset(0);
    },
    async previous() {
      if (pos() < 3000) index = (index - 1 + DEMO_TRACKS.length) % DEMO_TRACKS.length;
      reset(0);
    },
    async seek(ms) {
      reset(Math.max(0, Math.min(ms, DEMO_TRACKS[index].durationMs - 1)));
    },
  };

  const lyrics = {
    async get(track) {
      await sleep(250);
      const t = DEMO_TRACKS.find((d) => d.id === track.id);
      return toResult(t?.record ?? null);
    },
    forget() {},
  };

  return { player, lyrics };
}
