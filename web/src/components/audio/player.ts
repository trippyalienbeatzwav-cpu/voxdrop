import { useSyncExternalStore } from 'react';

/**
 * One shared <audio> element for every preview in the app, so previews never
 * overlap (starting one stops the previous). Components subscribe to its state.
 */
interface PlayerState {
  id: string | null;
  playing: boolean;
  progress: number;
  error: string | null;
}

let state: PlayerState = { id: null, playing: false, progress: 0, error: null };
const listeners = new Set<() => void>();
let el: HTMLAudioElement | null = null;

/** App-wide preview volume (header volume control). Per-viewer preference, kept in localStorage. */
export interface MasterVolume {
  volume: number; // 0..1
  muted: boolean;
}
const VOL_KEY = 'vx.previewVolume';
let master: MasterVolume = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(VOL_KEY) ?? 'null') as MasterVolume | null;
    if (v && typeof v.volume === 'number') return { volume: Math.max(0, Math.min(1, v.volume)), muted: !!v.muted };
  } catch {
    /* storage unavailable */
  }
  return { volume: 0.8, muted: false };
})();
const volListeners = new Set<() => void>();
let lastRequested = 1;
export function setMasterVolume(p: Partial<MasterVolume>) {
  master = { ...master, ...p };
  try {
    localStorage.setItem(VOL_KEY, JSON.stringify(master));
  } catch {
    /* storage unavailable */
  }
  if (el) el.volume = master.muted ? 0 : lastRequested * master.volume;
  volListeners.forEach((l) => l());
}
export function useMasterVolume() {
  return useSyncExternalStore(
    (l) => {
      volListeners.add(l);
      return () => volListeners.delete(l);
    },
    () => master,
  );
}

function set(p: Partial<PlayerState>) {
  state = { ...state, ...p };
  listeners.forEach((l) => l());
}

function audio() {
  if (el) return el;
  el = new Audio();
  el.preload = 'none';
  el.addEventListener('timeupdate', () => el!.duration && set({ progress: el!.currentTime / el!.duration }));
  el.addEventListener('ended', () => set({ playing: false, progress: 1 }));
  el.addEventListener('pause', () => set({ playing: false }));
  el.addEventListener('play', () => set({ playing: true, error: null }));
  el.addEventListener('error', () => set({ playing: false, error: 'Could not play this audio' }));
  return el;
}

export const player = {
  toggle(id: string, src: string, volume = 1) {
    const a = audio();
    if (state.id === id && state.playing) {
      a.pause();
      return;
    }
    if (state.id !== id) {
      a.src = src;
      set({ id, progress: 0 });
    }
    lastRequested = volume;
    a.volume = master.muted ? 0 : volume * master.volume;
    a.play().catch(() => set({ playing: false, error: 'Playback was blocked by the browser' }));
  },
  stop() {
    el?.pause();
    set({ id: null, playing: false, progress: 0 });
  },
};

export function usePlayer(id: string) {
  const s = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
  const mine = s.id === id;
  return { playing: mine && s.playing, progress: mine ? s.progress : 0, error: mine ? s.error : null };
}

export const audioUrl = (id: string, overlayKey?: string) => `/api/audio/${id}/stream${overlayKey ? `?k=${encodeURIComponent(overlayKey)}` : ''}`;
