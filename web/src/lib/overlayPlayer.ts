/**
 * Playback engine for the OBS Browser Source. Dependency-free (no DOM types)
 * so it can be unit-tested with fake audio elements.
 *
 * For each queue item:
 *   1. load + play the announcement      → report announcement_started (on real 'playing')
 *   2. wait for the announcement 'ended'  → report announcement_ended
 *   3. load + play the viewer's audio     → report message_started (on real 'playing')
 *   4. wait for the audio 'ended'         → report ended  (server marks COMPLETED and sends the next item)
 *
 * Completion is ONLY driven by media events — never timers — except for
 * text-only items, which have no audio and are shown for a fixed alert time.
 * Reports are sent strictly in order, and every callback is tagged with a
 * token so events from a stopped/replaced item can never leak into the next.
 */

export interface AudioLike {
  src: string;
  volume: number;
  play(): Promise<void>;
  pause(): void;
  onplaying: (() => void) | null;
  onended: (() => void) | null;
  onerror: (() => void) | null;
  error?: { code?: number } | null;
}

export type PlaybackEventName = 'announcement_started' | 'announcement_ended' | 'announcement_error' | 'message_started' | 'ended' | 'error';
export type Stage = 'idle' | 'announcing' | 'message' | 'text';

export interface PlayItem {
  itemId: string;
  phase?: string;
  durationMs: number;
  volume?: number;
  announcementVolume?: number;
  announcement: { audioId: string; text: string | null; played?: boolean } | null;
  message: { audio: { id: string } | null };
}

export interface PlayerDeps {
  createAudio: () => AudioLike;
  audioUrl: (audioId: string) => string;
  report: (itemId: string, event: PlaybackEventName, detail?: string) => Promise<unknown>;
  onStage: (stage: Stage, item: PlayItem | null) => void;
  onNeedsGesture?: () => void;
  schedule?: (fn: () => void, ms: number) => () => void;
}

const MEDIA_ERRORS: Record<number, string> = { 1: 'MEDIA_ERR_ABORTED', 2: 'MEDIA_ERR_NETWORK', 3: 'MEDIA_ERR_DECODE', 4: 'MEDIA_ERR_SRC_NOT_SUPPORTED' };

export class OverlayPlayer {
  private token = 0;
  private item: PlayItem | null = null;
  private el: AudioLike | null = null;
  private cancelTimer: (() => void) | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private volume = 0.8;
  private announcementVolume = 0.9;
  private paused = false;

  constructor(private readonly deps: PlayerDeps) {}

  get current() {
    return this.item;
  }

  setVolumes(v: { volume?: number; announcementVolume?: number }) {
    if (typeof v.volume === 'number') this.volume = clamp(v.volume / 100);
    if (typeof v.announcementVolume === 'number') this.announcementVolume = clamp(v.announcementVolume / 100);
    if (this.el) this.el.volume = this.stage === 'announcing' ? this.announcementVolume : this.volume;
  }

  private stage: Stage = 'idle';
  private setStage(s: Stage) {
    this.stage = s;
    this.deps.onStage(s, this.item);
  }

  /** Reports are serialised so the server always sees them in playback order. */
  private send(itemId: string, event: PlaybackEventName, detail?: string) {
    this.chain = this.chain.then(() => this.deps.report(itemId, event, detail)).catch(() => undefined);
    return this.chain;
  }

  play(p: PlayItem) {
    this.halt();
    const t = ++this.token;
    this.item = p;
    if (typeof p.volume === 'number') this.volume = clamp(p.volume / 100);
    if (typeof p.announcementVolume === 'number') this.announcementVolume = clamp(p.announcementVolume / 100);
    const resumeAtMessage = p.phase === 'PLAYING_MESSAGE' || !p.announcement || p.announcement.played;
    if (resumeAtMessage) this.startMessage(t);
    else this.startAnnouncement(t);
  }

  private startAnnouncement(t: number) {
    const p = this.item!;
    const el = this.deps.createAudio();
    this.el = el;
    let started = false;
    el.src = this.deps.audioUrl(p.announcement!.audioId);
    el.volume = this.announcementVolume;
    el.onplaying = () => {
      if (t !== this.token || started) return;
      started = true;
      void this.send(p.itemId, 'announcement_started');
    };
    el.onended = () => {
      if (t !== this.token) return;
      void this.send(p.itemId, 'announcement_ended');
      this.startMessage(t);
    };
    el.onerror = () => {
      if (t !== this.token) return;
      void this.send(p.itemId, 'announcement_error', MEDIA_ERRORS[el.error?.code ?? 0] ?? 'load failed');
      this.startMessage(t); // a broken announcement never blocks the viewer's message
    };
    this.setStage('announcing');
    if (!this.paused) el.play().catch(() => t === this.token && this.deps.onNeedsGesture?.());
  }

  private startMessage(t: number) {
    const p = this.item!;
    this.releaseEl();
    if (!p.message.audio) {
      // Text-only item (e.g. a text donation): nothing to wait on but the display time.
      void this.send(p.itemId, 'message_started');
      this.setStage('text');
      const schedule = this.deps.schedule ?? ((fn, ms) => {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
      });
      this.cancelTimer = schedule(() => {
        if (t !== this.token) return;
        void this.send(p.itemId, 'ended');
        this.finish(t);
      }, p.durationMs);
      return;
    }
    const el = this.deps.createAudio();
    this.el = el;
    let started = false;
    el.src = this.deps.audioUrl(p.message.audio.id);
    el.volume = this.volume;
    el.onplaying = () => {
      if (t !== this.token || started) return;
      started = true;
      void this.send(p.itemId, 'message_started');
    };
    el.onended = () => {
      if (t !== this.token) return;
      void this.send(p.itemId, 'ended');
      this.finish(t);
    };
    el.onerror = () => {
      if (t !== this.token) return;
      void this.send(p.itemId, 'error', MEDIA_ERRORS[el.error?.code ?? 0] ?? 'load failed');
      this.finish(t);
    };
    this.setStage('message');
    if (!this.paused) el.play().catch(() => t === this.token && this.deps.onNeedsGesture?.());
  }

  private finish(t: number) {
    if (t !== this.token) return;
    this.releaseEl();
    this.item = null;
    this.setStage('idle');
  }

  private releaseEl() {
    if (!this.el) return;
    this.el.onplaying = this.el.onended = this.el.onerror = null;
    this.el.pause();
    this.el.src = '';
    this.el = null;
  }

  private halt() {
    this.token++;
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.releaseEl();
  }

  /** Streamer skipped/stopped: silence both parts immediately. Ignores stops for other items. */
  stop(itemId?: string) {
    if (itemId && this.item && this.item.itemId !== itemId) return;
    this.halt();
    this.item = null;
    this.setStage('idle');
  }

  pause() {
    this.paused = true;
    this.el?.pause();
  }

  resume() {
    this.paused = false;
    if (this.el) void this.el.play().catch(() => this.deps.onNeedsGesture?.());
  }

  /** Called after a user gesture in a normal browser (OBS never needs this). */
  unlock() {
    if (this.el && !this.paused) void this.el.play().catch(() => undefined);
  }
}

const clamp = (v: number) => Math.max(0, Math.min(1, v));
