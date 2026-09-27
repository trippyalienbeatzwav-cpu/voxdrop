import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { get, post, setCsrfToken } from './api';
import type { Me, PublicConfig } from './types';

export function useMe() {
  const q = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const me = await get<Me>('/api/me');
      setCsrfToken(me.csrfToken);
      return me;
    },
    staleTime: 30_000,
  });
  // Apply the in-app reduced-motion preference globally.
  useEffect(() => {
    document.documentElement.dataset.reducedMotion = String(!!q.data?.user?.reducedMotion);
  }, [q.data?.user?.reducedMotion]);
  return q;
}

export function useConfig() {
  return useQuery({ queryKey: ['config'], queryFn: () => get<PublicConfig>('/api/config'), staleTime: Infinity });
}

export function useLogout() {
  const qc = useQueryClient();
  return async () => {
    await post('/auth/logout').catch(() => undefined);
    setCsrfToken(null);
    qc.clear();
    window.location.assign('/');
  };
}

/** Full-page navigation into the server-side OAuth flow. */
export function kickLoginHref(next?: string) {
  return `/auth/kick${next ? `?next=${encodeURIComponent(next)}` : ''}`;
}
