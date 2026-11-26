// Keeps the lyrics in step with Spotify's reports without jumping back and forth.
//
// Spotify's servers only know what a car's Spotify tells them, and Tesla's reports
// arrive a few seconds late and a little noisy. This layer decides which reports to trust:
//   - Small differences are judged on the median of the last few reports, so one noisy
//     report never moves the lyrics. Catching up (we're behind) needs two agreeing
//     reports; moving back (we're ahead) needs three.
//   - When a song plays to its end, the next one started right then — even though Spotify
//     hears about it late and counts its position from that later moment. That gap is kept
//     as an offset, so the lyrics stay on time instead of lagging the whole song.
//   - If Spotify's own timeline jumps (a seek or rewind in the car), it is followed at once.
//   - A tapped line is held until Spotify's timeline moves there.
import { PlaybackClock } from './clock.js';

const BEHIND_MS = 250; // median says we're behind by more than this → catch up
const AHEAD_MS = 400; // median says we're ahead by more than this → move back
const BEHIND_REPORTS = 2; // reports needed before catching up
const AHEAD_REPORTS = 3; // reports needed before moving back
const WINDOW = 5; // recent reports the median is taken over
const JUMP_MS = 1500; // Spotify's own timeline moved by more than this → seek / rewind / catch-up
const MAX_LATE_START_MS = 10_000; // how late Spotify may hear about a song that followed the last one
const SEEK_HOLD_MS = 20_000; // how long a tapped line waits for Spotify to confirm it

export class PlaybackSync {
  constructor({ now = () => performance.now() } = {}) {
    this.now = now;
    this.clock = new PlaybackClock({ now });
    this.trackId = null;
    this.offset = 0; // ms the song really is ahead of what Spotify reports (late start)
    this.last = null; // Spotify's previous report: { progress, at, playing }
    this.diffs = []; // recent (Spotify − us) differences, ms
    this.pendingSeek = null; // { target, at }
  }

  position(at) {
    return this.clock.position(at);
  }

  remaining() {
    return this.clock.remaining();
  }

  get playing() {
    return this.clock.playing;
  }

  /** The user tapped a line: show it now and hold it until Spotify confirms. */
  seek(ms) {
    this.clock.seek(ms);
    this.pendingSeek = { target: Math.max(0, ms), at: this.now() };
  }

  /** The seek command failed: trust Spotify again. */
  cancelSeek() {
    this.pendingSeek = null;
  }

  setPlaying(playing) {
    this.clock.setPlaying(playing);
  }

  /** Spotify has nothing playing. */
  stop() {
    this.clock.setPlaying(false);
  }

  /** Apply one report from Spotify. */
  report({ trackId, progressMs, sampledAt: at, isPlaying, durationMs }) {
    if (trackId !== this.trackId) {
      this.#startTrack(trackId, progressMs, at, isPlaying, durationMs);
      return;
    }
    this.clock.durationMs = durationMs > 0 ? durationMs : Infinity;

    // Did Spotify's own timeline continue smoothly since its last report, or jump?
    const last = this.last;
    // (Capped at the song's length: at the end Spotify keeps reporting the last second.)
    const duration = durationMs > 0 ? durationMs : Infinity;
    const expected = last ? Math.min(duration, last.progress + (last.playing ? at - last.at : 0)) : progressMs;
    const spotifyJump = progressMs - expected;
    this.last = { progress: progressMs, at, playing: isPlaying };

    // A tapped line: keep it until Spotify's timeline reaches it, or give up after a while.
    if (this.pendingSeek) {
      const ps = this.pendingSeek;
      const wanted = ps.target + (isPlaying ? at - ps.at : 0);
      if (Math.abs(progressMs - wanted) < JUMP_MS) {
        this.pendingSeek = null;
        this.offset = 0;
        this.diffs = [];
        return; // confirmed; we're already showing it
      }
      if (this.now() - ps.at < SEEK_HOLD_MS) {
        if (isPlaying !== this.clock.playing) this.clock.setPlaying(isPlaying);
        return;
      }
      this.pendingSeek = null;
      this.offset = 0;
      this.#set(progressMs, at, isPlaying);
      return;
    }

    // Paused or resumed: follow it.
    if (isPlaying !== this.clock.playing) {
      this.#set(progressMs + this.offset, at, isPlaying);
      return;
    }

    if (Math.abs(spotifyJump) > JUMP_MS) {
      if (this.offset > 0 && Math.abs(spotifyJump - this.offset) < JUMP_MS) {
        // Spotify caught up with the late start we were covering: same place, no jump.
        this.offset = 0;
      } else {
        // A seek or rewind in the car: follow it.
        this.offset = 0;
        this.diffs = [];
        this.#set(progressMs, at, isPlaying);
        return;
      }
    }

    // Small differences: act on the median of recent reports, never on a single one.
    const diff = progressMs + this.offset - this.clock.position(at); // > 0: we're behind
    this.diffs.push(diff);
    if (this.diffs.length > WINDOW) this.diffs.shift();
    const typical = median(this.diffs);
    const n = this.diffs.length;
    if ((typical > BEHIND_MS && n >= BEHIND_REPORTS) || (typical < -AHEAD_MS && n >= AHEAD_REPORTS)) {
      this.#set(this.clock.position(at) + typical, at, isPlaying);
      this.diffs = this.diffs.map((d) => d - typical); // same reports, measured from the new position
    }
  }

  #startTrack(trackId, progressMs, at, isPlaying, durationMs) {
    // If the previous song just played to its end, this one started right then; Spotify
    // may report it as having started later (it heard late). Keep that difference.
    let offset = 0;
    const prev = this.clock;
    if (this.trackId !== null && prev.playing && Number.isFinite(prev.durationMs)) {
      const endedAt = prev.baseAt + (prev.durationMs - prev.baseMs);
      const sinceEnd = at - endedAt;
      const late = sinceEnd - progressMs;
      if (sinceEnd >= 0 && sinceEnd < MAX_LATE_START_MS + 5000 && late > 0 && late < MAX_LATE_START_MS) offset = late;
    }
    this.trackId = trackId;
    this.offset = offset;
    this.last = { progress: progressMs, at, playing: isPlaying };
    this.diffs = [];
    this.pendingSeek = null;
    this.clock.trackId = trackId;
    this.clock.durationMs = durationMs > 0 ? durationMs : Infinity;
    this.#set(progressMs + offset, at, isPlaying);
  }

  #set(position, at, playing) {
    this.clock.baseMs = Math.max(0, position);
    this.clock.baseAt = at;
    this.clock.playing = playing;
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
