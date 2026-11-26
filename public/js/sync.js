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
//   - A skip on the car's own controls is heard about just as late, but there is no way to
//     see when it really happened. So the delay measured at song ends (and when Spotify
//     later catches up) is remembered, and the usual delay is applied to such skips.
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
const LATE_STARTS_KEPT = 5; // measured late starts the usual delay is taken from
const MIN_USUAL_LATE_MS = 300; // a usual delay smaller than this is treated as none
const OWN_CHANGE_MS = 15_000; // a song change this soon after our own command is ours
const CATCH_UP_LEARN_MS = 20_000; // Spotify catching up this early in a song shows its delay

export class PlaybackSync {
  /**
   * `lateStarts`: delays measured on earlier visits (see `onLateStart`), so the first skip
   * of a drive is already timed right. `onLateStart(list)` is called when one is measured.
   */
  constructor({ now = () => performance.now(), lateStarts = [], onLateStart = null } = {}) {
    this.now = now;
    this.lateStarts = lateStarts.filter((v) => Number.isFinite(v) && v >= 0 && v < MAX_LATE_START_MS).slice(-LATE_STARTS_KEPT);
    this.onLateStart = onLateStart;
    this.ownChangeAt = null; // when this page last asked Spotify to change song
    this.clock = new PlaybackClock({ now });
    this.trackId = null;
    this.offset = 0; // ms the song really is ahead of what Spotify reports (late start)
    this.diffs = []; // recent (Spotify − us) differences, ms
    this.jump = null; // a big difference seen once, waiting for a second reply to agree
    this.start = null; // { endedAt, precise, byPlayer, at }: how the current song's start was timed
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

  /** How late Spotify usually hears about a new song from this player (0 if not late). */
  get usualLateStart() {
    if (!this.lateStarts.length) return 0;
    const usual = median(this.lateStarts);
    return usual >= MIN_USUAL_LATE_MS ? usual : 0;
  }

  /** This page is about to change the song itself: Spotify hears of that at once. */
  expectChange() {
    this.ownChangeAt = this.now();
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
      this.offset = this.#lateStart(progressMs, at, isPlaying, true);
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
      // Spotify's timeline leaping forward early in a song is it catching up with a start
      // it heard about late: the size of the leap is that delay.
      const s = this.start;
      if (s && !s.own && diff > 0 && diff < MAX_LATE_START_MS && at - s.at < CATCH_UP_LEARN_MS) this.#learn(diff);
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
    const own = this.ownChangeAt !== null && this.now() - this.ownChangeAt < OWN_CHANGE_MS;
    this.ownChangeAt = null;
    this.start = {
      endedAt: followsOn ? prev.baseAt + (prev.durationMs - prev.baseMs) : null,
      precise,
      at,
      own,
      // Changed on the player itself (not from this page, and not the first song we see).
      byPlayer: this.trackId !== null && !own,
    };
    this.trackId = trackId;
    this.offset = this.#lateStart(progressMs, at, isPlaying, precise);
    this.pendingSeek = null;
    this.impreciseRun = 0;
    this.#forget();
    this.clock.trackId = trackId;
    this.clock.durationMs = durationMs > 0 ? durationMs : Infinity;
    this.#set(progressMs + this.offset, at, isPlaying);
  }

  /**
   * How much later than it really started Spotify counts this song from (0 if n/a).
   * Measured when the song followed the previous one's end; otherwise, for a skip on the
   * player's own controls, the usual delay measured before.
   */
  #lateStart(progressMs, at, isPlaying, precise) {
    const { endedAt, byPlayer } = this.start ?? {};
    if (endedAt != null) {
      const sinceEnd = at - endedAt;
      const late = sinceEnd - progressMs;
      if (sinceEnd >= 0 && sinceEnd < MAX_LATE_START_MS + 5000 && late > -JUMP_MS && late < MAX_LATE_START_MS) {
        const measured = Math.max(0, late);
        if (precise) this.#learn(measured);
        return measured;
      }
    }
    // Only a song that is just starting: one picked up part-way was not a plain skip.
    if (byPlayer && isPlaying && progressMs < MAX_LATE_START_MS) return this.usualLateStart;
    return 0;
  }

  #learn(lateMs) {
    this.lateStarts.push(Math.round(lateMs));
    if (this.lateStarts.length > LATE_STARTS_KEPT) this.lateStarts.shift();
    this.onLateStart?.([...this.lateStarts]);
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
