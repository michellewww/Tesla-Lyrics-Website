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
//   - A big difference (a seek or rewind in the car) is followed once two replies in a row
//     agree on it; a single reply with a bad timestamp is ignored.
//   - Replies that took seconds to arrive say what is playing but not precisely where, so
//     they don't move the lyrics (unless every reply is like that).
//   - A tapped line is held until Spotify's timeline moves there.
import { PlaybackClock } from './clock.js';

const BEHIND_MS = 250; // median says we're behind by more than this → catch up
const AHEAD_MS = 400; // median says we're ahead by more than this → move back
const BEHIND_REPORTS = 2; // reports needed before catching up
const AHEAD_REPORTS = 3; // reports needed before moving back
const WINDOW = 5; // recent reports the median is taken over
const JUMP_MS = 1500; // we differ from Spotify by more than this → seek / rewind / catch-up
const JUMP_AGREE_MS = 700; // ...if two replies in a row agree on it this closely
const CATCH_UP_MS = 400; // a small "behind" this close to the late-start offset is Spotify catching up
const IMPRECISE_MS = 600; // a reply whose timing is less certain than this can't place the position
const IMPRECISE_RUN = 5; // ...unless this many in a row are like that
const MAX_LATE_START_MS = 10_000; // how late Spotify may hear about a song that followed the last one
const SEEK_HOLD_MS = 20_000; // how long a tapped line waits for Spotify to confirm it

export class PlaybackSync {
  constructor({ now = () => performance.now() } = {}) {
    this.now = now;
    this.clock = new PlaybackClock({ now });
    this.trackId = null;
    this.offset = 0; // ms the song really is ahead of what Spotify reports (late start)
    this.diffs = []; // recent (Spotify − us) differences, ms
    this.jump = null; // a big difference seen once, waiting for a second reply to agree
    this.start = null; // { endedAt, precise }: how the current song's start was timed
    this.impreciseRun = 0;
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
    const at = this.now();
    // Where Spotify's (not yet updated) timeline will keep pointing until the seek lands.
    const from = this.#predicted(at) - this.offset;
    const wasPlaying = this.clock.playing;
    this.clock.seek(ms);
    this.pendingSeek = { target: Math.max(0, ms), at, from, wasPlaying, other: null };
    return this.pendingSeek;
  }

  /** The seek command failed: trust Spotify again (unless a newer seek replaced it). */
  cancelSeek(seek) {
    if (!seek || this.pendingSeek === seek) this.pendingSeek = null;
  }

  setPlaying(playing) {
    this.clock.setPlaying(playing);
  }

  /** Spotify has nothing playing. */
  stop() {
    this.clock.setPlaying(false);
  }

  /**
   * Apply one report from Spotify. `uncertaintyMs` is how far off `sampledAt` may be
   * (half the request's round trip): a reply that took seconds can't place the position.
   */
  report({ trackId, progressMs, sampledAt: at, isPlaying, durationMs, uncertaintyMs = 0 }) {
    let precise = uncertaintyMs <= IMPRECISE_MS;
    if (trackId !== this.trackId) {
      this.#startTrack(trackId, progressMs, at, isPlaying, durationMs, precise);
      return;
    }
    this.clock.durationMs = durationMs > 0 ? durationMs : Infinity;

    // On a connection where every reply is slow, slow replies are all there is: use them.
    this.impreciseRun = precise ? 0 : this.impreciseRun + 1;
    if (this.impreciseRun >= IMPRECISE_RUN) precise = true;

    // A tapped line. The car applies the seek some time after the tap, so accept any
    // position the target could have reached since then. Until that shows up, keep the
    // tapped line while Spotify still reports the old timeline.
    if (this.pendingSeek) {
      const ps = this.pendingSeek;
      const elapsed = at - ps.at;
      const slack = JUMP_MS + uncertaintyMs;
      const wanted = ps.target + (isPlaying ? elapsed : 0);
      const done = () => {
        this.pendingSeek = null;
        this.offset = 0;
        this.#forget();
      };
      const followPlayState = () => {
        if (isPlaying !== this.clock.playing) this.clock.setPlaying(isPlaying);
      };
      if (progressMs >= ps.target - slack && progressMs <= wanted + slack) {
        done(); // the seek landed (maybe late): go with where Spotify says it is now
        if (!isPlaying || (precise && Math.abs(progressMs - wanted) > BEHIND_MS)) this.#set(progressMs, at, isPlaying);
        else followPlayState();
        return;
      }
      if (this.now() - ps.at < SEEK_HOLD_MS) {
        const stale = Math.abs(progressMs - (ps.from + (ps.wasPlaying ? elapsed : 0))) < slack;
        if (stale || !precise) {
          followPlayState();
          return;
        }
        // Neither the old timeline nor our seek: something else happened (a seek on the
        // car's own controls). Follow it once two replies agree.
        const origin = progressMs - (isPlaying ? at : 0);
        const seen = ps.other;
        ps.other = origin;
        if (seen === null || Math.abs(seen - origin) > JUMP_AGREE_MS) {
          followPlayState();
          return;
        }
      }
      done();
      if (precise) this.#set(progressMs, at, isPlaying);
      else followPlayState();
      return;
    }

    // Paused or resumed. Spotify's position at such a change is fresh from the player, so
    // a late-start offset no longer applies. A paused position is exact however slow the
    // reply was.
    if (isPlaying !== this.clock.playing) {
      this.offset = 0;
      if (!isPlaying || precise) this.#set(progressMs, at, isPlaying);
      else this.clock.setPlaying(true);
      this.#forget();
      return;
    }

    // A slow reply says what is playing, but not precisely where: don't move for it.
    if (!precise) return;

    // The song was first seen through a slow reply: time it properly now.
    if (this.start && !this.start.precise) {
      this.start.precise = true;
      this.offset = this.#lateStart(progressMs, at);
      this.#forget();
      this.#set(progressMs + this.offset, at, isPlaying);
      return;
    }

    // Compare against where the clock would be without stopping at the song's end, so a
    // repeat or a rewind from the end reads as the same jump in consecutive replies.
    const predicted = this.#predicted(at);
    const duration = this.clock.durationMs;
    if (predicted >= duration && progressMs >= duration - JUMP_MS) return; // ended; waiting for what's next
    const diff = progressMs + this.offset - predicted; // > 0: we're behind

    // A big difference is a seek, a rewind, or Spotify catching up — or one reply with a
    // bad timestamp. Only believe it when the next reply says the same.
    if (Math.abs(diff) > JUMP_MS) {
      const seen = this.jump;
      this.jump = { diff };
      if (!seen || Math.abs(seen.diff - diff) > JUMP_AGREE_MS) return;
      if (this.offset > 0 && Math.abs(diff - this.offset) < JUMP_MS) {
        // Spotify caught up with the late start we were covering: same place, no move.
        this.offset = 0;
      } else {
        this.offset = 0;
        this.#set(progressMs, at, isPlaying);
      }
      this.#forget();
      return;
    }
    this.jump = null;

    // Small differences: act on the median of recent reports, never on a single one.
    this.diffs.push(diff);
    if (this.diffs.length > WINDOW) this.diffs.shift();
    const typical = median(this.diffs);
    const n = this.diffs.length;
    if ((typical > BEHIND_MS && n >= BEHIND_REPORTS) || (typical < -AHEAD_MS && n >= AHEAD_REPORTS)) {
      if (this.offset > 0 && Math.abs(typical - this.offset) < CATCH_UP_MS) {
        this.offset = 0; // Spotify caught up with a short late start: no move
      } else {
        this.#set(predicted + typical, at, isPlaying);
      }
      this.diffs = this.diffs.map((d) => d - typical); // same reports, measured from the new state
    }
  }

  #startTrack(trackId, progressMs, at, isPlaying, durationMs, precise) {
    // If the previous song just played to its end, this one started right then; Spotify
    // may report it as having started later (it heard late). Keep that difference.
    const prev = this.clock;
    const followsOn = this.trackId !== null && prev.playing && Number.isFinite(prev.durationMs);
    this.start = { endedAt: followsOn ? prev.baseAt + (prev.durationMs - prev.baseMs) : null, precise };
    this.trackId = trackId;
    this.offset = this.#lateStart(progressMs, at);
    this.pendingSeek = null;
    this.impreciseRun = 0;
    this.#forget();
    this.clock.trackId = trackId;
    this.clock.durationMs = durationMs > 0 ? durationMs : Infinity;
    this.#set(progressMs + this.offset, at, isPlaying);
  }

  /** How much later than the previous song's end Spotify says this one started (0 if n/a). */
  #lateStart(progressMs, at) {
    const endedAt = this.start?.endedAt;
    if (endedAt == null) return 0;
    const sinceEnd = at - endedAt;
    const late = sinceEnd - progressMs;
    return sinceEnd >= 0 && sinceEnd < MAX_LATE_START_MS + 5000 && late > 0 && late < MAX_LATE_START_MS ? late : 0;
  }

  /** The clock's position at `at`, not capped at the song's length. */
  #predicted(at) {
    const c = this.clock;
    return c.baseMs + (c.playing ? at - c.baseAt : 0);
  }

  #forget() {
    this.diffs = [];
    this.jump = null;
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
