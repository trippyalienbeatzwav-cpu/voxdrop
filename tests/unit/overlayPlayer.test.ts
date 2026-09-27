import { describe, expect, it } from 'vitest';
import { OverlayPlayer, type AudioLike, type PlayItem } from '../../web/src/lib/overlayPlayer.js';

/** Fake <audio>: records play() order; tests fire media events manually. */
class FakeAudio implements AudioLike {
  static log: string[] = [];
  static all: FakeAudio[] = [];
  src = '';
  volume = 1;
  paused = true;
  onplaying: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  error: { code?: number } | null = null;
  constructor() {
    FakeAudio.all.push(this);
  }
  async play() {
    this.paused = false;
    FakeAudio.log.push(`play ${this.src}`);
  }
  pause() {
    this.paused = true;
  }
  fire(ev: 'playing' | 'ended' | 'error') {
    const h = ev === 'playing' ? this.onplaying : ev === 'ended' ? this.onended : this.onerror;
    h?.();
  }
}

function setup() {
  FakeAudio.log = [];
  FakeAudio.all = [];
  const reports: string[] = [];
  const stages: string[] = [];
  const timers: Array<() => void> = [];
  const player = new OverlayPlayer({
    createAudio: () => new FakeAudio(),
    audioUrl: (id) => id,
    report: async (itemId, event) => {
      reports.push(`${itemId}:${event}`);
    },
    onStage: (s) => stages.push(s),
    schedule: (fn) => {
      timers.push(fn);
      return () => undefined;
    },
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { player, reports, stages, timers, flush, audio: (i: number) => FakeAudio.all[i]! };
}

const item = (id: string, withAnnouncement = true, audio = true): PlayItem => ({
  itemId: id,
  phase: 'PENDING',
  durationMs: 5000,
  announcement: withAnnouncement ? { audioId: `ann-${id}`, text: `Voice message from ${id}` } : null,
  message: { audio: audio ? { id: `msg-${id}` } : null },
});

describe('OverlayPlayer', () => {
  it('plays the announcement, waits for its ended event, then plays the viewer audio', async () => {
    const t = setup();
    t.player.play(item('A'));
    expect(FakeAudio.log).toEqual(['play ann-A']); // viewer audio NOT started yet
    t.audio(0).fire('playing');
    t.audio(0).fire('ended');
    expect(FakeAudio.log).toEqual(['play ann-A', 'play msg-A']);
    t.audio(1).fire('playing');
    t.audio(1).fire('ended');
    await t.flush();
    expect(t.reports).toEqual(['A:announcement_started', 'A:announcement_ended', 'A:message_started', 'A:ended']);
    expect(t.stages).toEqual(['announcing', 'message', 'idle']);
  });

  it('sequences A then B without interleaving', async () => {
    const t = setup();
    t.player.play(item('A'));
    t.audio(0).fire('ended');
    t.audio(1).fire('ended');
    t.player.play(item('B'));
    t.audio(2).fire('ended');
    t.audio(3).fire('ended');
    expect(FakeAudio.log).toEqual(['play ann-A', 'play msg-A', 'play ann-B', 'play msg-B']);
  });

  it('a failed announcement falls through to the viewer audio', async () => {
    const t = setup();
    t.player.play(item('A'));
    t.audio(0).error = { code: 2 };
    t.audio(0).fire('error');
    await t.flush();
    expect(FakeAudio.log).toEqual(['play ann-A', 'play msg-A']);
    expect(t.reports).toEqual(['A:announcement_error']);
  });

  it('plays the viewer audio immediately when there is no announcement', () => {
    const t = setup();
    t.player.play(item('A', false));
    expect(FakeAudio.log).toEqual(['play msg-A']);
  });

  it('stop() silences both parts and late events from the stopped item are ignored', async () => {
    const t = setup();
    t.player.play(item('A'));
    const ann = t.audio(0);
    t.player.stop('A');
    expect(ann.paused).toBe(true);
    ann.onended?.(); // handler was detached
    await t.flush();
    expect(FakeAudio.log).toEqual(['play ann-A']);
    expect(t.reports).toEqual([]);
  });

  it('ignores a stop for a different item', () => {
    const t = setup();
    t.player.play(item('A'));
    t.player.stop('B');
    expect(t.player.current?.itemId).toBe('A');
  });

  it('a replacing play() detaches the previous item handlers', async () => {
    const t = setup();
    t.player.play(item('A'));
    const oldAnn = t.audio(0);
    const staleEnded = oldAnn.onended!;
    t.player.play(item('B'));
    staleEnded(); // stale event from A arrives late
    await t.flush();
    expect(FakeAudio.log).toEqual(['play ann-A', 'play ann-B']);
    expect(t.reports.some((r) => r.startsWith('A:'))).toBe(false);
  });

  it('resumes at the viewer audio when reconnecting mid-message', () => {
    const t = setup();
    t.player.play({ ...item('A'), phase: 'PLAYING_MESSAGE' });
    expect(FakeAudio.log).toEqual(['play msg-A']);
  });

  it('text-only items announce first, then show for the alert time', async () => {
    const t = setup();
    t.player.play(item('A', true, false));
    t.audio(0).fire('ended');
    expect(t.stages.at(-1)).toBe('text');
    t.timers[0]!();
    await t.flush();
    expect(t.reports).toEqual(['A:announcement_ended', 'A:message_started', 'A:ended']);
  });
});
