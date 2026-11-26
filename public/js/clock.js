// Spotify only tells us the playback position when we poll. In between, this clock
// interpolates it from the local monotonic clock so lyrics can advance every frame.

export class PlaybackClock {
  /**
   * @param {object} opts
   * @param {() => number} [opts.now] monotonic milliseconds (performance.now)
   * @param {number} [opts.jitterMs] ignore poll corrections smaller than this while playing,
   *   so network latency noise doesn't make the highlighted line flicker back and forth.
   */
  constructor({ now = () => performance.now(), jitterMs = 250 } = {}) {
    this.now = now;
    this.jitterMs = jitterMs;
    this.baseMs = 0;
    this.baseAt = now();
    this.playing = false;
    this.durationMs = Infinity;
    this.trackId = null;
  }

  position(at = this.now()) {
    const p = this.baseMs + (this.playing ? at - this.baseAt : 0);
    return Math.min(Math.max(0, p), this.durationMs);
  }

  /** Apply a fresh sample from the Spotify API. Returns true if the clock was moved. */
  sync({ trackId, progressMs, sampledAt, isPlaying, durationMs }) {
    const sameTrack = trackId === this.trackId;
    const predicted = this.position(sampledAt);
    const drift = Math.abs(predicted - progressMs);
    const keepSmooth = sameTrack && isPlaying && this.playing && drift < this.jitterMs;

    this.trackId = trackId;
    this.durationMs = durationMs > 0 ? durationMs : Infinity;
    if (keepSmooth) return false;

    this.baseMs = progressMs;
    this.baseAt = sampledAt;
    this.playing = isPlaying;
    return true;
  }

  /** Optimistic local updates after the user presses a control. */
  seek(ms) {
    this.baseMs = Math.max(0, ms);
    this.baseAt = this.now();
  }

  setPlaying(playing) {
    this.baseMs = this.position();
    this.baseAt = this.now();
    this.playing = playing;
  }

  /** Milliseconds until the current track ends (Infinity if unknown or paused). */
  remaining() {
    if (!this.playing || !Number.isFinite(this.durationMs)) return Infinity;
    return Math.max(0, this.durationMs - this.position());
  }
}
