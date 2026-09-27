import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, patch } from '../../lib/api';
import { useChannel } from '../../lib/channel';
import { useErrorToast, useToast } from '../../components/ui/Toast';

export type Settings = Record<string, number | boolean | string | string[]>;

/** Loads channel settings, tracks local edits, and PATCHes only what changed. */
export function useChannelSettings() {
  const { channel } = useChannel();
  const sid = channel?.id;
  const qc = useQueryClient();
  const toast = useToast();
  const onError = useErrorToast();
  const q = useQuery({ queryKey: ['channel-settings', sid], enabled: !!sid, queryFn: () => get<{ settings: Settings }>(`/api/channels/${sid}/settings`) });
  const [draft, setDraft] = useState<Settings>({});
  useEffect(() => {
    if (q.data) setDraft(q.data.settings);
  }, [q.data]);
  const dirty = useMemo(() => {
    const out: Settings = {};
    if (!q.data) return out;
    for (const [k, v] of Object.entries(draft)) if (JSON.stringify(v) !== JSON.stringify(q.data.settings[k])) out[k] = v;
    return out;
  }, [draft, q.data]);
  const save = useMutation({
    mutationFn: () => patch<{ settings: Settings }>(`/api/channels/${sid}/settings`, dirty),
    onSuccess: (r) => {
      qc.setQueryData(['channel-settings', sid], r);
      toast({ title: 'Settings saved', tone: 'success' });
    },
    onError,
  });
  const set = (k: string, v: number | boolean | string | string[]) => setDraft((d) => ({ ...d, [k]: v }));
  const num = (k: string) => Number(draft[k] ?? 0);
  const bool = (k: string) => !!draft[k];
  return { sid, q, draft, set, num, bool, dirty, isDirty: Object.keys(dirty).length > 0, save, reset: () => q.data && setDraft(q.data.settings) };
}
