// Playback clock — the pure, testable core of the preview transport. Holds the
// current time + play state; `tick(dtMs)` advances while playing and auto-pauses
// (clamped) at the end. The rAF loop lives in the usePlayback hook.
export class Transport {
  private _time = 0;
  private _playing = false;
  duration: number;

  constructor(duration = 0) {
    this.duration = Math.max(0, duration);
  }

  get time(): number {
    return this._time;
  }
  get playing(): boolean {
    return this._playing;
  }

  setDuration(d: number): void {
    this.duration = Math.max(0, d);
    if (this._time > this.duration) this._time = this.duration;
  }

  seek(t: number): void {
    this._time = Math.max(0, Math.min(this.duration, t));
  }

  play(): void {
    if (this.duration <= 0) return;
    if (this._time >= this.duration) this._time = 0; // restart from the top
    this._playing = true;
  }

  pause(): void {
    this._playing = false;
  }

  toggle(): void {
    if (this._playing) this.pause();
    else this.play();
  }

  /** Advance by `dtMs` while playing; clamp + auto-pause at the end. */
  tick(dtMs: number): number {
    if (!this._playing) return this._time;
    this._time += dtMs / 1000;
    if (this._time >= this.duration) {
      this._time = this.duration;
      this._playing = false;
    }
    return this._time;
  }
}
