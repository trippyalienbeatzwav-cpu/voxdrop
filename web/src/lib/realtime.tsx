import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useToast } from '../components/ui/Toast';
import type { Me } from './types';

type Status = 'connecting' | 'open' | 'closed';
const RealtimeCtx = createContext<{ status: Status; subscribe: (fn: (type: string, data: unknown) => void) => () => void }>({
  status: 'closed',
  subscribe: () => () => undefined,
});

/** Which cached queries each event makes stale. */
function invalidateFor(qc: QueryClient, type: string) {
  const inv = (key: string) => qc.invalidateQueries({ queryKey: [key] });
  if (type.startsWith('message.') || type.startsWith('announcement.') || type.startsWith('queue.') || type === 'sound.played') {
    inv('queue');
    inv('channel-messages');
    inv('my-messages');
    inv('channel-dashboard');
    inv('priority-options');
  }
  if (type === 'points.updated') {
    inv('points');
    inv('points-tx');
  }
  if (type.startsWith('donation.')) {
    inv('channel-donations');
    inv('my-donations');
    inv('channel-dashboard');
  }
  if (type === 'subscription.received' || type === 'gift_sub.received') {
    inv('channel-subs');
    inv('channel-dashboard');
  }
  if (type === 'notification.created') inv('notifications');
  if (type === 'user.banned' || type === 'user.warned') inv('channel-users');
  if (type === 'streamer.updated') inv('streamer');
  if (type === 'message.audio.completed' || type === 'announcement.failed') inv('playback-log');
  if (type === 'alert.show') inv('alert-events');
}

/**
 * One EventSource per tab for the signed-in user (user topic + staffed
 * channels). EventSource reconnects on its own; we only track status.
 */
export function RealtimeProvider({ me, children }: { me: Me | undefined; children: ReactNode }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState<Status>('closed');
  const listeners = useRef(new Set<(type: string, data: unknown) => void>());
  const userId = me?.user?.id;
  const channelKey = (me?.channels ?? []).map((c) => c.id).join(',');

  useEffect(() => {
    if (!userId) return;
    setStatus('connecting');
    const es = new EventSource('/api/realtime');
    es.onopen = () => setStatus('open');
    es.onerror = () => setStatus(es.readyState === EventSource.CLOSED ? 'closed' : 'connecting');
    const handler = (ev: MessageEvent) => {
      let evt: { type: string; data: Record<string, unknown> };
      try {
        evt = JSON.parse(ev.data);
      } catch {
        return;
      }
      invalidateFor(qc, evt.type);
      if (evt.type === 'queue.position_changed') {
        // Push the new position straight into the viewer's live position card.
        const d = evt.data as { messageId: string; position: number; ahead: number; estimatedWaitMs: number; tier: string; queueLength: number };
        qc.setQueryData(['msg-position', d.messageId], (old: { state: string } | undefined) => ({ state: old?.state === 'MODERATION' || !old ? 'QUEUED' : old.state, position: d }));
      }
      if (evt.type === 'points.updated') {
        qc.setQueryData<Me>(['me'], (old) => (old ? { ...old, points: evt.data.balance as number } : old));
      }
      if (evt.type === 'notification.created') {
        qc.setQueryData<Me>(['me'], (old) => (old ? { ...old, unreadNotifications: (old.unreadNotifications ?? 0) + 1 } : old));
        const tone = String(evt.data.type).includes('rejected') || String(evt.data.type).includes('banned') ? 'danger' : 'success';
        toast({ title: String(evt.data.title), body: String(evt.data.body ?? ''), tone });
      }
      listeners.current.forEach((fn) => fn(evt.type, evt.data));
    };
    const types = [
      'message.created', 'message.approved', 'message.rejected', 'message.queued', 'message.playing', 'message.played', 'message.updated',
      'queue.updated', 'points.updated', 'donation.created', 'donation.completed', 'donation.refunded', 'subscription.received',
      'gift_sub.received', 'sound.played', 'user.banned', 'user.warned', 'notification.created', 'streamer.updated',
      'announcement.started', 'announcement.completed', 'announcement.failed', 'message.audio.started', 'message.audio.completed',
      'queue.added', 'queue.position_changed', 'message.completed', 'message.skipped', 'alert.show',
    ];
    types.forEach((t) => es.addEventListener(t, handler));
    return () => {
      es.close();
      setStatus('closed');
    };
    // Reconnect when the set of staffed channels changes (new topics).
  }, [userId, channelKey, qc, toast]);

  return (
    <RealtimeCtx.Provider
      value={{
        status,
        subscribe: (fn) => {
          listeners.current.add(fn);
          return () => listeners.current.delete(fn);
        },
      }}
    >
      {children}
    </RealtimeCtx.Provider>
  );
}

export const useRealtime = () => useContext(RealtimeCtx);
