import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { get, qs } from './api';
import type { Quote, Streamer } from './types';

export function useStreamer(slug: string | undefined) {
  return useQuery({
    queryKey: ['streamer', slug],
    enabled: !!slug,
    queryFn: () => get<{ streamer: Streamer; stats: { queue: number; sounds: number; played: number }; viewer: { isOwner: boolean; restriction: { kind: string; expiresAt: string | null } | null } | null }>(`/api/streamers/${encodeURIComponent(slug!)}`),
  });
}

/** Server-computed price for what the viewer is about to send. */
export function useQuote(slug: string | undefined, params: { type: string; priority?: boolean; priorityTier?: string | null; bonus?: number; soundId?: string }, enabled = true) {
  return useQuery({
    queryKey: ['quote', slug, params],
    enabled: !!slug && enabled,
    queryFn: () => get<Quote>(`/api/streamers/${encodeURIComponent(slug!)}/quote${qs({ type: params.type, priority: params.priority, priorityTier: params.priorityTier, bonus: params.bonus || undefined, soundId: params.soundId })}`),
    staleTime: 5_000,
  });
}

/** Seconds countdown that ticks down locally (e.g. cooldowns). */
export function useCountdown(seconds: number | undefined | null) {
  const [left, setLeft] = useState(seconds ?? 0);
  useEffect(() => setLeft(seconds ?? 0), [seconds]);
  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);
  return left;
}
